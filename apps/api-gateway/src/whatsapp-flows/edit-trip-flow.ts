import type { GoogleMapsRoutePlanner } from '@wheleers/config';
import { findPlaceOptions, kmBetween, SAME_CITY_KM, SAME_PLACE_KM } from '../LLM/geocoding';
import type { RedisClient } from '../redis/client';
import { getActiveRide, getPendingRoute, storePendingRoute, MAX_CHAT_STOPS } from './bid-state';
import type { PendingRouteData, RouteStop } from './bid-state';
import type { FlowRequestBody } from './encryption';

/**
 * The "Edit trip" form — the ONE WhatsApp Flow that is switched on.
 *
 * In the chat, adding a stop is five messages: tap, "where?", the typed place,
 * the picker, the new trip. Here the rider changes the pickup, up to three
 * stops and the destination on one screen and taps Continue once; the chat gets
 * one message back — the updated trip card.
 *
 *   EDIT_TRIP     the five boxes, filled with the trip as it is
 *   PICK_PLACES   only when something typed has more than one match
 *   TRIP_UPDATED  the saved trip (terminal). Also says "nothing changed" and
 *                 "this trip has expired".
 *
 * A Flow cannot suggest while the rider types — its boxes are only sent when a
 * button is tapped — so ambiguity is a second screen, not a dropdown. It is the
 * same lookup the chat uses (findPlaceOptions), so both doors agree on places.
 *
 * Nothing here confirms a trip or names a price: the saved route is stored
 * WITHOUT `confirmed`, exactly as a typed change is, and the card it sends has
 * the Confirm trip button.
 */

export interface EditTripFlowDeps {
  redisClient: RedisClient;
  googleMapsApiKey: string;
  routePlanner: GoogleMapsRoutePlanner;
  /** Sends the updated trip card to the rider's chat. Absent in tests that only drive the form. */
  onTripSaved?: (userId: string, trip: PendingRouteData, headline: string) => Promise<void>;
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

function editScreen(values: Partial<Record<Field, string>>, error = ''): FlowScreen {
  return {
    screen: 'EDIT_TRIP',
    data: {
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

function doneScreen(headline: string, note: string, trip?: PendingRouteData): FlowScreen {
  const stops = trip?.stops ?? [];
  return {
    screen: 'TRIP_UPDATED',
    data: {
      headline,
      pickup_line: trip ? `Pickup: ${trip.pickupAddress}` : '',
      has_pickup_line: Boolean(trip),
      stop_1_line: stops[0] ? `Stop 1: ${stops[0].address}` : '',
      has_stop_1: Boolean(stops[0]),
      stop_2_line: stops[1] ? `Stop 2: ${stops[1].address}` : '',
      has_stop_2: Boolean(stops[1]),
      stop_3_line: stops[2] ? `Stop 3: ${stops[2].address}` : '',
      has_stop_3: Boolean(stops[2]),
      destination_line: trip ? `Destination: ${trip.destAddress}` : '',
      has_destination_line: Boolean(trip),
      summary_line: trip ? `${trip.distanceKm.toFixed(1)} km · ~${Math.ceil(trip.durationSeconds / 60)} min · suggested fare ₦${trip.suggestedFareNgn.toLocaleString()}` : '',
      has_summary_line: Boolean(trip),
      note,
    },
  };
}

const EXPIRED = () => doneScreen('This trip has expired ⏳', 'Go back to the chat and send your pickup and destination again.');

/** Every request the Edit-trip flow makes: opening it, going back, and its two Continue buttons. */
export async function handleEditTripFlow(body: FlowRequestBody, userId: string, deps: EditTripFlowDeps): Promise<FlowScreen> {
  const trip = await getPendingRoute(deps.redisClient, userId);
  if (!trip) return EXPIRED();
  if (await getActiveRide(deps.redisClient, userId)) {
    return doneScreen('Drivers are already looking at this trip', 'To change it, reply "cancel" in the chat and send the new trip.', trip);
  }

  const data = body.data ?? {};
  // Phones cache flow JSON and old copies drop our `action` tag — read the intent from the payload's shape.
  const action = typeof data['action'] === 'string' ? data['action']
    : typeof data['pickup'] === 'string' ? 'edit_trip'
      : FIELDS.some((field) => typeof data[`pick_${field}`] === 'string') ? 'pick_places' : null;

  if (body.action !== 'data_exchange' || !action) {
    // INIT, BACK, or something we do not know: the form, as the trip stands.
    const places = currentPlaces(trip);
    return editScreen(Object.fromEntries(FIELDS.map((field) => [field, places[field]?.address ?? ''])));
  }

  if (action === 'pick_places') return pickPlaces(data, userId, trip, deps);
  return editTrip(data, userId, trip, deps);
}

async function editTrip(data: Record<string, unknown>, userId: string, trip: PendingRouteData, deps: EditTripFlowDeps): Promise<FlowScreen> {
  const typed = Object.fromEntries(FIELDS.map((field) => [field, text(data[field])])) as Record<Field, string>;
  if (!typed.pickup || !typed.destination) return editScreen(typed, 'A trip needs a pickup and a destination.');

  const current = currentPlaces(trip);
  const draft: Draft = { typed, resolved: {}, options: {} };
  const ends = { pickup: current.pickup!, destination: current.destination! };

  // Look up only what changed — all at once: five lookups one after another would flirt with WhatsApp's 10-second limit.
  const misses: Field[] = [];
  await Promise.all(FIELDS.map(async (field) => {
    if (!typed[field]) return;                                       // an emptied stop box = that stop removed
    const existing = current[field];
    if (existing && same(existing.address, typed[field])) { draft.resolved[field] = existing; return; }
    const near = field === 'pickup' ? ends.destination : ends.pickup;
    const matches = await findPlaceOptions(deps.googleMapsApiKey, typed[field], { near }).catch(() => []);
    const places = matches.slice(0, 8).map((match) => ({ lat: match.lat, lng: match.lng, address: match.formattedAddress }));
    if (places.length === 0) misses.push(field);
    else if (places.length === 1) draft.resolved[field] = places[0]!;
    else draft.options[field] = places;
  }));

  if (misses.length > 0) {
    const first = FIELDS.find((field) => misses.includes(field))!;
    return editScreen(typed, `I could not find "${clip(typed[first], 40)}" (${FIELD_LABEL[first]}). Add the area or a landmark — e.g. "Shoprite, Ikeja".`);
  }

  await deps.redisClient.set(draftKey(userId), JSON.stringify(draft), DRAFT_TTL_SECONDS);
  if (Object.keys(draft.options).length > 0) return pickScreen(draft);
  return finish(draft, userId, trip, deps, (error) => editScreen(typed, error));
}

async function pickPlaces(data: Record<string, unknown>, userId: string, trip: PendingRouteData, deps: EditTripFlowDeps): Promise<FlowScreen> {
  const raw = await deps.redisClient.get(draftKey(userId)).catch(() => null);
  let draft: Draft | null = null;
  try { draft = raw ? (JSON.parse(raw) as Draft) : null; } catch { draft = null; }
  if (!draft) return EXPIRED();

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
  trip: PendingRouteData,
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

  const before = currentPlaces(trip);
  const beforeStops = trip.stops ?? [];
  const unchanged = before.pickup!.address === pickup.address && before.destination!.address === destination.address
    && beforeStops.length === stops.length && stops.every((stop, index) => stop.address === beforeStops[index]!.address);
  if (unchanged) {
    await deps.redisClient.del(draftKey(userId)).catch(() => undefined);
    return doneScreen('Nothing changed', 'Your trip is as it was. Tap Confirm trip in the chat when it is right.', trip);
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
  await storePendingRoute(deps.redisClient, userId, next);
  await deps.redisClient.del(draftKey(userId)).catch(() => undefined);

  // The card goes to the chat NOW, not when they tap "Back to chat": a rider who
  // swipes the form away instead must still find their updated trip waiting.
  await deps.onTripSaved?.(userId, next, '✅ *Trip updated*').catch((error) => {
    console.error('[edit-trip-flow] saved the trip but could not send the card', { userId, error: error instanceof Error ? error.message : String(error) });
  });
  return doneScreen('Trip updated ✅', 'It is in your chat now — tap Confirm trip there when it is right.', next);
}
