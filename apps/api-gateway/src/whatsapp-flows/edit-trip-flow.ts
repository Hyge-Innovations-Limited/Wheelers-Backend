import type { GoogleMapsRoutePlanner } from '@wheleers/config';
import { userClient } from '@wheleers/db';
import { findPlaceOptions, kmBetween, SAME_CITY_KM, SAME_PLACE_KM } from '../LLM/geocoding';
import type { RedisClient } from '../redis/client';
import { publishWhatsappRide } from '../rides/whatsapp-ride.service';
import type { GatewayPublisher } from '../websocket/publisher';
import { getActiveRide, getPendingRoute, setBookingStage, storePendingRoute, MAX_CHAT_STOPS } from './bid-state';
import type { PendingRouteData, RouteStop } from './bid-state';
import type { FlowRequestBody } from './encryption';
import { actionFor } from './flow-dispatch';

/**
 * The "Confirm or edit trip" form — the ONE WhatsApp Flow that is switched on.
 *
 * WhatsApp allows a message reply buttons OR one form button, never both. So the
 * trip card is ONE message with ONE button, and everything the rider can do to
 * a trip before pricing it happens in here: confirm it as it is, change the
 * pickup or destination, add or remove stops. Then the chat gets one message —
 * the price step. (In the chat alone, adding a stop was five messages.)
 *
 *   EDIT_TRIP     the five boxes, filled with the trip as it is  [Confirm trip]
 *                   nothing changed → confirmed → DONE
 *   PICK_PLACES   only when something typed has more than one match
 *   REVIEW_TRIP   only after a change: the new trip and fare     [Confirm trip]
 *                   (a single match can still be the wrong place — they look
 *                   before it is priced; ← goes back to the boxes)
 *   SET_PRICE     the price, right here — no page, no chat message [Find drivers]
 *                   → the ride goes out to drivers
 *   DONE          terminal: "You have successfully bid ₦X", and the dead ends
 *                 (expired, drivers already looking)
 *
 * A flow may only OPEN on its entry screen, so INIT always answers EDIT_TRIP —
 * a dead booking says so there, in the error line.
 *
 * A Flow cannot suggest while the rider types — its boxes are only sent when a
 * button is tapped — so ambiguity is a second screen, not a dropdown. It is the
 * same lookup the chat uses (findPlaceOptions), so both doors agree on places.
 *
 * A changed trip is saved (without `confirmed`) the moment it is planned, so
 * the chat and the form never disagree about what the trip is. Confirming sets
 * `confirmed` and moves to the price; a price typed in the chat meanwhile still
 * works (stage awaiting_price). The chat hears nothing until a driver answers.
 *
 * The screens and their handlers are exported: the Quick Actions form carries
 * the same five screens, so Book a ride and Repeat a ride there run THIS code.
 * There the trip may not exist yet (`trip` is null): every typed box is looked
 * up and the planned trip is simply new.
 */

export interface EditTripFlowDeps {
  redisClient: RedisClient;
  googleMapsApiKey: string;
  routePlanner: GoogleMapsRoutePlanner;
  publisher: GatewayPublisher;
  /** The bid is in: the chat gets its ONE message, the See driver offers button. */
  onBidPlaced?: (userId: string, rideId: string, offerNgn: number) => Promise<void>;
}

type FlowScreen = { screen: string; data: Record<string, unknown> };

const FIELDS = ['pickup', 'stop_1', 'stop_2', 'stop_3', 'destination'] as const;
type Field = (typeof FIELDS)[number];
const FIELD_LABEL: Record<Field, string> = { pickup: 'pickup', stop_1: 'stop 1', stop_2: 'stop 2', stop_3: 'stop 3', destination: 'destination' };

/** What the rider typed, and what it turned into — kept between the two screens. */
interface Draft {
  typed: Record<Field, string>;
  /** Settled places: unchanged boxes, and typed ones with exactly one match. */
  resolved: Partial<Record<Field, RouteStop>>;
  /** Typed boxes with several matches, waiting on PICK_PLACES. */
  options: Partial<Record<Field, RouteStop[]>>;
}

const DRAFT_TTL_SECONDS = 600;
const draftKey = (userId: string) => `whatsapp:user:${userId}:trip_edit_draft`;
const NONE = 'none';

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const text = (value: unknown) => (typeof value === 'string' ? value.trim().slice(0, 200) : '');

function currentPlaces(trip: PendingRouteData): Partial<Record<Field, RouteStop>> {
  const stops = trip.stops ?? [];
  return {
    pickup: { lat: trip.pickupLat, lng: trip.pickupLng, address: trip.pickupAddress },
    ...(stops[0] ? { stop_1: stops[0] } : {}),
    ...(stops[1] ? { stop_2: stops[1] } : {}),
    ...(stops[2] ? { stop_3: stops[2] } : {}),
    destination: { lat: trip.destLat, lng: trip.destLng, address: trip.destAddress },
  };
}

function summaryOf(trip: PendingRouteData): string {
  return `${trip.distanceKm.toFixed(1)} km · ~${Math.ceil(trip.durationSeconds / 60)} min · suggested fare ₦${trip.suggestedFareNgn.toLocaleString()}`;
}

export function editScreen(values: Partial<Record<Field, string>>, error = '', trip?: PendingRouteData | null): FlowScreen {
  return {
    screen: 'EDIT_TRIP',
    data: {
      summary_line: trip ? summaryOf(trip) : '',
      has_summary_line: Boolean(trip),
      pickup: values.pickup ?? '',
      stop_1: values.stop_1 ?? '',
      stop_2: values.stop_2 ?? '',
      stop_3: values.stop_3 ?? '',
      destination: values.destination ?? '',
      error,
      has_error: error.length > 0,
    },
  };
}

function pickScreen(draft: Draft, error = ''): FlowScreen {
  const data: Record<string, unknown> = { error, has_error: error.length > 0 };
  for (const field of FIELDS) {
    const options = draft.options[field] ?? [];
    data[`show_${field}`] = options.length > 0;
    // WhatsApp refuses an empty data-source even on a hidden group: always hand it the way out.
    data[`${field}_options`] = [
      ...options.map((place, index) => {
        const [name, ...rest] = place.address.split(',');
        return { id: String(index), title: clip((name ?? place.address).trim(), 30), description: clip(rest.join(',').trim() || place.address, 300) };
      }),
      { id: NONE, title: 'None of these', description: `Go back and type the ${FIELD_LABEL[field]} again with the area` },
    ];
  }
  return { screen: 'PICK_PLACES', data };
}

export function reviewScreen(trip: PendingRouteData, error = ''): FlowScreen {
  const stops = trip.stops ?? [];
  return {
    screen: 'REVIEW_TRIP',
    data: {
      pickup_line: `Pickup: ${trip.pickupAddress}`,
      stop_1_line: stops[0] ? `Stop 1: ${stops[0].address}` : '',
      has_stop_1: Boolean(stops[0]),
      stop_2_line: stops[1] ? `Stop 2: ${stops[1].address}` : '',
      has_stop_2: Boolean(stops[1]),
      stop_3_line: stops[2] ? `Stop 3: ${stops[2].address}` : '',
      has_stop_3: Boolean(stops[2]),
      destination_line: `Destination: ${trip.destAddress}`,
      summary_line: summaryOf(trip),
      error,
      has_error: error.length > 0,
    },
  };
}

export function priceScreen(trip: PendingRouteData, error = '', prefillNgn?: number): FlowScreen {
  return {
    screen: 'SET_PRICE',
    data: {
      // After a too-low price the box holds the floor, so Find drivers works on the next tap.
      suggested_price: String(prefillNgn ?? trip.suggestedFareNgn),
      trip_line: `${trip.distanceKm.toFixed(1)} km · ~${Math.ceil(trip.durationSeconds / 60)} min`,
      limits_line: `Lowest for this trip: ₦${trip.minOfferNgn.toLocaleString()} · suggested ₦${trip.suggestedFareNgn.toLocaleString()}`,
      error,
      has_error: error.length > 0,
    },
  };
}

/** `rearm`: when the form closes, does the chat need a fresh button? Not when the form just sent one. */
export function doneScreen(headline: string, note: string, rearm = true): FlowScreen {
  return { screen: 'DONE', data: { headline, note, rearm: rearm ? 'true' : 'false' } };
}

export const EXPIRED_NOTE = 'This trip has expired. Open Quick Actions in the chat and tap Book a ride to start again.';
export const SEARCHING_NOTE = 'Drivers are already looking at a trip of yours. Open Quick Actions in the chat and tap Your current trip to see offers, change your price or cancel it.';

/** The one Continue button on each screen. */
export const EDIT_TRIP_ACTIONS = { EDIT_TRIP: 'edit_trip', PICK_PLACES: 'pick_places', REVIEW_TRIP: 'confirm_trip', SET_PRICE: 'set_price' } as const;

/** Every request the Edit-trip flow makes: opening it, going back, and its two Continue buttons. */
export async function handleEditTripFlow(body: FlowRequestBody, userId: string, deps: EditTripFlowDeps): Promise<FlowScreen> {
  const screen = await answerEditTrip(body, userId, deps);
  // Nothing completes the form: a completion disables the Book now button on its message and
  // posts "Response sent" in the chat. Every ending is a NOTE the rider swipes down from.
  if (screen.screen === 'DONE') return { screen: 'NOTE', data: { headline: screen.data['headline'], note: screen.data['note'] } };
  return screen;
}

async function answerEditTrip(body: FlowRequestBody, userId: string, deps: EditTripFlowDeps): Promise<FlowScreen> {
  const [trip, activeRideId] = await Promise.all([getPendingRoute(deps.redisClient, userId), getActiveRide(deps.redisClient, userId)]);
  const deadEnd = activeRideId ? SEARCHING_NOTE : !trip ? EXPIRED_NOTE : null;

  const data = body.data ?? {};
  const action = actionFor(body, EDIT_TRIP_ACTIONS);

  if (body.action !== 'data_exchange' || !action) {
    // INIT, BACK, or something we do not know: the boxes, as the trip stands. (A flow can only open on this screen.)
    if (deadEnd || !trip) return editScreen({}, deadEnd ?? EXPIRED_NOTE);
    const places = currentPlaces(trip);
    return editScreen(Object.fromEntries(FIELDS.map((field) => [field, places[field]?.address ?? ''])), '', trip);
  }

  if (deadEnd || !trip) return doneScreen(activeRideId ? 'Already searching' : 'This trip has expired', deadEnd ?? EXPIRED_NOTE);
  if (action === 'confirm_trip') return confirm(userId, trip, deps);
  if (action === 'set_price') return setPrice(data, userId, trip, deps);
  if (action === 'pick_places') return pickPlaces(data, userId, trip, deps);
  return editTrip(data, userId, trip, deps);
}

/** "This trip is right": now the price — on the next screen, not in the chat. */
export async function confirm(userId: string, trip: PendingRouteData, deps: EditTripFlowDeps): Promise<FlowScreen> {
  const confirmed: PendingRouteData = { ...trip, confirmed: true };
  await storePendingRoute(deps.redisClient, userId, confirmed);
  await setBookingStage(deps.redisClient, userId, 'awaiting_price');     // a price typed in the chat still works
  await deps.redisClient.del(draftKey(userId)).catch(() => undefined);
  return priceScreen(confirmed);
}

/** Find drivers: the same publish as a typed price and as the page. No chat message — the next one is a driver's offer. */
export async function setPrice(data: Record<string, unknown>, userId: string, trip: PendingRouteData, deps: EditTripFlowDeps): Promise<FlowScreen> {
  const amount = Math.round(Number(String(data['price'] ?? '').replace(/[,\s₦]/g, '')));
  if (!Number.isFinite(amount) || amount <= 0) return priceScreen(trip, 'Enter your price in figures, e.g. 2500.');
  const phone = (await userClient.findById(userId).catch(() => null))?.phone ?? '';
  const result = await publishWhatsappRide({ redisClient: deps.redisClient, publisher: deps.publisher }, { id: userId, phone }, { ...trip, confirmed: true }, amount);
  if (!result.ok) {
    if (result.code === 'BELOW_MINIMUM') return priceScreen(trip, `₦${amount.toLocaleString()} is under the lowest price for this trip, ₦${result.minOfferNgn.toLocaleString()}. It is in the box now — tap Find drivers to offer it, or type more.`, result.minOfferNgn);
    if (result.code === 'PUBLISH_FAILED') return priceScreen(trip, 'Could not start the search just now. Tap Find drivers again.');
    // ALREADY_PUBLISHING: a double tap — the first one is out.
  } else {
    // Not awaited: WhatsApp cuts a form's request off at ~10 s, and the chat message is not the form's to wait for.
    void deps.onBidPlaced?.(userId, result.rideId, amount).catch((error) => console.error('[edit-trip] bid placed but the chat was not told', { userId, error: error instanceof Error ? error.message : String(error) }));
  }
  return doneScreen(`You have successfully bid ₦${amount.toLocaleString()}`, 'Drivers see your price now. Back in the chat, tap See driver offers to watch their offers come in. You only pay when you accept one.', false);
}

export async function editTrip(data: Record<string, unknown>, userId: string, trip: PendingRouteData | null, deps: EditTripFlowDeps): Promise<FlowScreen> {
  const typed = Object.fromEntries(FIELDS.map((field) => [field, text(data[field])])) as Record<Field, string>;
  if (!typed.pickup || !typed.destination) return editScreen(typed, 'A trip needs a pickup and a destination.', trip);

  // A new trip (Book a ride in the Quick Actions form) has nothing to compare against: every box is looked up.
  const current: Partial<Record<Field, RouteStop>> = trip ? currentPlaces(trip) : {};
  const draft: Draft = { typed, resolved: {}, options: {} };
  const ends = { pickup: current.pickup, destination: current.destination };

  // Look up only what changed — all at once: five lookups one after another would flirt with WhatsApp's 10-second limit.
  const misses: Field[] = [];
  await Promise.all(FIELDS.map(async (field) => {
    if (!typed[field]) return;                                       // an emptied stop box = that stop removed
    const existing = current[field];
    if (existing && same(existing.address, typed[field])) { draft.resolved[field] = existing; return; }
    const near = field === 'pickup' ? ends.destination : ends.pickup;
    const matches = await findPlaceOptions(deps.googleMapsApiKey, typed[field], near ? { near } : {}).catch(() => []);
    const places = matches.slice(0, 8).map((match) => ({ lat: match.lat, lng: match.lng, address: match.formattedAddress }));
    if (places.length === 0) misses.push(field);
    else if (places.length === 1) draft.resolved[field] = places[0]!;
    else draft.options[field] = places;
  }));

  if (misses.length > 0) {
    const first = FIELDS.find((field) => misses.includes(field))!;
    return editScreen(typed, `I could not find "${clip(typed[first], 40)}" (${FIELD_LABEL[first]}). Add the area or a landmark — e.g. "Shoprite, Ikeja".`, trip);
  }

  await deps.redisClient.set(draftKey(userId), JSON.stringify(draft), DRAFT_TTL_SECONDS);
  if (Object.keys(draft.options).length > 0) return pickScreen(draft);
  return finish(draft, userId, trip, deps, (error) => editScreen(typed, error, trip));
}

export async function pickPlaces(data: Record<string, unknown>, userId: string, trip: PendingRouteData | null, deps: EditTripFlowDeps): Promise<FlowScreen> {
  const raw = await deps.redisClient.get(draftKey(userId)).catch(() => null);
  let draft: Draft | null = null;
  try { draft = raw ? (JSON.parse(raw) as Draft) : null; } catch { draft = null; }
  if (!draft) return doneScreen('That took too long', 'Open the form again from the chat and make your change once more.');

  for (const field of FIELDS) {
    const options = draft.options[field];
    if (!options) continue;
    const picked = text(data[`pick_${field}`]);
    if (!picked) return pickScreen(draft, `Pick the right ${FIELD_LABEL[field]} to continue.`);
    if (picked === NONE) return pickScreen(draft, `No problem — tap ← at the top and type the ${FIELD_LABEL[field]} again with the area or a landmark.`);
    const place = options[Number(picked)];
    if (!place) return pickScreen(draft, `Pick the right ${FIELD_LABEL[field]} to continue.`);
    draft.resolved[field] = place;
  }
  return finish(draft, userId, trip, deps, (error) => pickScreen(draft!, error));
}

/** Every place is settled: check the trip makes sense, plan it, save it, tell the chat. */
async function finish(
  draft: Draft,
  userId: string,
  trip: PendingRouteData | null,
  deps: EditTripFlowDeps,
  refuse: (error: string) => FlowScreen,
): Promise<FlowScreen> {
  const pickup = draft.resolved.pickup;
  const destination = draft.resolved.destination;
  if (!pickup || !destination) return refuse('A trip needs a pickup and a destination.');
  const stops = (['stop_1', 'stop_2', 'stop_3'] as const)
    .map((field) => draft.resolved[field])
    .filter((stop): stop is RouteStop => Boolean(stop))
    .slice(0, MAX_CHAT_STOPS);

  // A place in another city is nearly always the wrong match. The chat can ask "are you sure?"; a form cannot, so it sends them there.
  const farAway = [{ label: 'destination', place: destination }, ...stops.map((place, index) => ({ label: `stop ${index + 1}`, place }))]
    .find(({ place }) => kmBetween(pickup, place) > SAME_CITY_KM);
  if (farAway) {
    return refuse(`The ${farAway.label} I found (${clip(farAway.place.address, 60)}) is about ${Math.round(kmBetween(pickup, farAway.place)).toLocaleString()} km from your pickup. Add the area — or, if you really are going that far, type it in the chat instead.`);
  }

  const named = [{ label: 'pickup', place: pickup }, ...stops.map((place, index) => ({ label: `stop ${index + 1}`, place })), { label: 'destination', place: destination }];
  for (let a = 0; a < named.length; a++) {
    for (let b = a + 1; b < named.length; b++) {
      if (kmBetween(named[a]!.place, named[b]!.place) < SAME_PLACE_KM) {
        return refuse(`Your ${named[a]!.label} and your ${named[b]!.label} are the same place. Change one of them.`);
      }
    }
  }

  if (trip) {
    const before = currentPlaces(trip);
    const beforeStops = trip.stops ?? [];
    const unchanged = before.pickup!.address === pickup.address && before.destination!.address === destination.address
      && beforeStops.length === stops.length && stops.every((stop, index) => stop.address === beforeStops[index]!.address);
    // Nothing changed and they tapped Confirm trip: that IS the confirmation.
    if (unchanged) return confirm(userId, trip, deps);
  }

  const planned = await deps.routePlanner.planRoute({ origin: pickup, destination, ...(stops.length ? { stops } : {}) }).catch(() => null);
  if (!planned) return refuse('I could not find a driving route through those places. Check them and try again.');

  const next: PendingRouteData = {
    pickupLat: pickup.lat, pickupLng: pickup.lng, pickupAddress: pickup.address,
    destLat: destination.lat, destLng: destination.lng, destAddress: destination.address,
    stops,
    distanceKm: planned.distanceKm,
    durationSeconds: planned.durationSeconds,
    suggestedFareNgn: planned.suggestedFareNgn,
    minOfferNgn: planned.minOfferNgn,
    ratePerKmNgn: planned.ratePerKmNgn,
    route: planned.geometry,
    // A changed trip is looked at again before any price: never `confirmed`, never a carried-over offer.
  };
  // Saved now, unconfirmed: if they leave here, the chat and the form still agree on what the trip is.
  await storePendingRoute(deps.redisClient, userId, next);
  await setBookingStage(deps.redisClient, userId, 'awaiting_trip_confirm');
  await deps.redisClient.del(draftKey(userId)).catch(() => undefined);
  return reviewScreen(next);
}
