import type { GoogleMapsRoutePlanner } from '@wheleers/config';
import { findPlaceOptions, kmBetween, SAME_CITY_KM, SAME_PLACE_KM } from '../LLM/geocoding';
import type { RedisClient } from '../redis/client';
import type { GatewayPublisher } from '../websocket/publisher';
import { getActiveRide, getPendingRoute, setBookingStage, storePendingRoute } from './bid-state';
import type { PendingRouteData, RouteStop } from './bid-state';
import { confirm, doneScreen, SEARCHING_NOTE, type EditTripFlowDeps } from './edit-trip-flow';
import { tripSummaryLine } from './trip-text';

/**
 * Book a ride, as screens inside the Quick Actions form:
 *
 *   BOOK_WHERE        pickup and destination boxes                    [Find places]
 *   BOOK_PLACES       what was found for each, ALWAYS shown — the rider sees
 *                     what Google understood before anything is planned  [Continue]
 *   BOOK_TRIP         the planned trip, its fare, up to three stop boxes [Confirm trip]
 *   BOOK_STOP_PLACES  only when a typed stop has several matches
 *   BOOK_REVIEW       the trip with its stops, one more look            [Confirm trip]
 *                     → the Edit-trip form's SET_PRICE, then DONE
 *
 * Every lookup runs in parallel inside the form's ten-second limit. Another
 * city and the same place twice are refused on the places screen, before
 * anything is planned. The draft between screens lives in Redis for 15 minutes.
 */

export interface BookRideDeps {
  redisClient: RedisClient;
  publisher: GatewayPublisher;
  googleMapsApiKey: string;
  routePlanner: GoogleMapsRoutePlanner;
  onBidPlaced?: EditTripFlowDeps['onBidPlaced'];
}

type FlowScreen = { screen: string; data: Record<string, unknown> };

/** The one Continue button on each screen. */
export const BOOK_RIDE_ACTIONS = { BOOK_WHERE: 'where_to', BOOK_PLACES: 'book_places', BOOK_TRIP: 'book_trip', BOOK_STOP_PLACES: 'book_stop_places' } as const;
const BOOK_ACTION_SET = new Set<string>(Object.values(BOOK_RIDE_ACTIONS));
export const isBookRideAction = (action: string): boolean => BOOK_ACTION_SET.has(action);

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const editDeps = (deps: BookRideDeps): EditTripFlowDeps => ({ redisClient: deps.redisClient, googleMapsApiKey: deps.googleMapsApiKey, routePlanner: deps.routePlanner, publisher: deps.publisher, onBidPlaced: deps.onBidPlaced });

/** Book a ride was chosen: a clean draft and the boxes. */
export async function startBooking(deps: BookRideDeps, userId: string): Promise<FlowScreen> {
  await deps.redisClient.del(bookDraftKey(userId)).catch(() => undefined);
  return whereToScreen({});
}

/** One of the booking screens' Continue buttons. */
export async function handleBookRideAction(action: string, data: Record<string, unknown>, userId: string, deps: BookRideDeps): Promise<FlowScreen> {
  if (await getActiveRide(deps.redisClient, userId)) return doneScreen('Already searching', SEARCHING_NOTE);
  if (action === BOOK_RIDE_ACTIONS.BOOK_WHERE) return bookWhereTo(data, userId, deps);
  if (action === BOOK_RIDE_ACTIONS.BOOK_PLACES) return bookPlaces(data, userId, deps);
  if (action === BOOK_RIDE_ACTIONS.BOOK_TRIP) return bookTrip(data, userId, deps);
  return bookStopPlaces(data, userId, deps);
}

/** What the rider typed and what it became, kept between the booking screens. */
interface BookDraft {
  typed: { pickup: string; destination: string };
  options: { pickup: RouteStop[]; destination: RouteStop[] };
  pickup?: RouteStop;
  destination?: RouteStop;
  stopsTyped?: string[];
  stopOptions?: Record<number, RouteStop[]>;
  stopsResolved?: Record<number, RouteStop>;
}
const BOOK_DRAFT_TTL_SECONDS = 900;
const bookDraftKey = (userId: string) => `whatsapp:user:${userId}:book_draft`;
const NONE = 'none';
const MAX_MATCHES = 5;

async function loadDraft(deps: BookRideDeps, userId: string): Promise<BookDraft | null> {
  const raw = await deps.redisClient.get(bookDraftKey(userId)).catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw) as BookDraft; } catch { return null; }
}
const saveDraft = (deps: BookRideDeps, userId: string, draft: BookDraft) =>
  deps.redisClient.set(bookDraftKey(userId), JSON.stringify(draft), BOOK_DRAFT_TTL_SECONDS);

export function whereToScreen(values: { pickup?: string; destination?: string }, error = ''): FlowScreen {
  return { screen: 'BOOK_WHERE', data: { pickup: values.pickup ?? '', destination: values.destination ?? '', error, has_error: error.length > 0 } };
}

function placeRows(places: RouteStop[], field: string) {
  return [
    ...places.map((place, index) => {
      const [name, ...rest] = place.address.split(',');
      return { id: String(index), title: clip((name ?? place.address).trim(), 30), description: clip(rest.join(',').trim() || place.address, 300) };
    }),
    // WhatsApp refuses an empty data-source even on a hidden group: always hand it the way out.
    { id: NONE, title: 'None of these', description: `Go back and type the ${field} again with the area` },
  ];
}

function placesScreen(draft: BookDraft, error = ''): FlowScreen {
  return {
    screen: 'BOOK_PLACES',
    data: {
      pickup_options: placeRows(draft.options.pickup, 'pickup'),
      show_pickup: true,
      destination_options: placeRows(draft.options.destination, 'destination'),
      show_destination: true,
      error,
      has_error: error.length > 0,
    },
  };
}

function tripScreenFor(trip: PendingRouteData, stopsTyped: string[] = [], error = ''): FlowScreen {
  return {
    screen: 'BOOK_TRIP',
    data: {
      pickup_line: `Pickup: ${trip.pickupAddress}`,
      destination_line: `Destination: ${trip.destAddress}`,
      summary_line: tripSummaryLine(trip),
      stop_1: stopsTyped[0] ?? '',
      stop_2: stopsTyped[1] ?? '',
      stop_3: stopsTyped[2] ?? '',
      error,
      has_error: error.length > 0,
    },
  };
}

function stopPlacesScreen(draft: BookDraft, error = ''): FlowScreen {
  const data: Record<string, unknown> = { error, has_error: error.length > 0 };
  for (const index of [1, 2, 3]) {
    const options = draft.stopOptions?.[index] ?? [];
    data[`show_stop_${index}`] = options.length > 0;
    data[`stop_${index}_options`] = placeRows(options, `stop ${index}`);
  }
  return { screen: 'BOOK_STOP_PLACES', data };
}

function bookReviewScreen(trip: PendingRouteData, error = ''): FlowScreen {
  const stops = trip.stops ?? [];
  return {
    screen: 'BOOK_REVIEW',
    data: {
      pickup_line: `Pickup: ${trip.pickupAddress}`,
      stop_1_line: stops[0] ? `Stop 1: ${stops[0].address}` : '', has_stop_1: Boolean(stops[0]),
      stop_2_line: stops[1] ? `Stop 2: ${stops[1].address}` : '', has_stop_2: Boolean(stops[1]),
      stop_3_line: stops[2] ? `Stop 3: ${stops[2].address}` : '', has_stop_3: Boolean(stops[2]),
      destination_line: `Destination: ${trip.destAddress}`,
      summary_line: tripSummaryLine(trip),
      error,
      has_error: error.length > 0,
    },
  };
}

const toStop = (match: { lat: number; lng: number; formattedAddress: string }): RouteStop => ({ lat: match.lat, lng: match.lng, address: match.formattedAddress });

/** Both boxes typed: look both up at once (the form has ~10 s), then show what was found — always. */
async function bookWhereTo(data: Record<string, unknown>, userId: string, deps: BookRideDeps): Promise<FlowScreen> {
  const typed = { pickup: text(data['pickup']).slice(0, 200), destination: text(data['destination']).slice(0, 200) };
  if (typed.pickup.length < 2 || typed.destination.length < 2) return whereToScreen(typed, 'A trip needs a pickup and a destination.');
  const [pickup, destination] = await Promise.all([
    findPlaceOptions(deps.googleMapsApiKey, typed.pickup, { limit: MAX_MATCHES }).catch(() => []),
    findPlaceOptions(deps.googleMapsApiKey, typed.destination, { limit: MAX_MATCHES }).catch(() => []),
  ]);
  if (pickup.length === 0) return whereToScreen(typed, `I could not find "${clip(typed.pickup, 40)}". Add the area or a landmark — e.g. "Shoprite, Ikeja".`);
  if (destination.length === 0) return whereToScreen(typed, `I could not find "${clip(typed.destination, 40)}". Add the area or a landmark — e.g. "Unilag gate, Yaba".`);
  const draft: BookDraft = { typed, options: { pickup: pickup.map(toStop), destination: destination.map(toStop) } };
  await saveDraft(deps, userId, draft);
  return placesScreen(draft);
}

/** The places chosen: sanity (same city, not the same place), then the road and the fare. */
async function bookPlaces(data: Record<string, unknown>, userId: string, deps: BookRideDeps): Promise<FlowScreen> {
  const draft = await loadDraft(deps, userId);
  if (!draft) return whereToScreen({}, 'That took too long — type the trip again.');
  const pickPickup = text(data['pick_pickup']);
  const pickDestination = text(data['pick_destination']);
  if (pickPickup === NONE) return placesScreen(draft, 'No problem — tap ← at the top and type the pickup again with the area or a landmark.');
  if (pickDestination === NONE) return placesScreen(draft, 'No problem — tap ← at the top and type the destination again with the area or a landmark.');
  const pickup = draft.options.pickup[Number(pickPickup)];
  const destination = draft.options.destination[Number(pickDestination)];
  if (!pickup || !destination) return placesScreen(draft, 'Pick a pickup and a destination to continue.');
  if (kmBetween(pickup, destination) > SAME_CITY_KM) {
    return placesScreen(draft, `Those are about ${Math.round(kmBetween(pickup, destination)).toLocaleString()} km apart — one of them is in another city. Tap ← and add the area, or type it in the chat if you really are going that far.`);
  }
  if (kmBetween(pickup, destination) < SAME_PLACE_KM) return placesScreen(draft, 'Your pickup and your destination are the same place. Pick a different one.');

  const planned = await deps.routePlanner.planRoute({ origin: pickup, destination }).catch(() => null);
  if (!planned) return placesScreen(draft, 'I could not find a driving route between those two. Check them and try again.');
  const trip: PendingRouteData = {
    pickupLat: pickup.lat, pickupLng: pickup.lng, pickupAddress: pickup.address,
    destLat: destination.lat, destLng: destination.lng, destAddress: destination.address,
    stops: [],
    distanceKm: planned.distanceKm, durationSeconds: planned.durationSeconds,
    suggestedFareNgn: planned.suggestedFareNgn, minOfferNgn: planned.minOfferNgn, ratePerKmNgn: planned.ratePerKmNgn,
    route: planned.geometry,
  };
  await storePendingRoute(deps.redisClient, userId, trip);
  await setBookingStage(deps.redisClient, userId, 'awaiting_trip_confirm');
  await saveDraft(deps, userId, { ...draft, pickup, destination });
  return tripScreenFor(trip);
}

/** Confirm trip on Your trip: no stops → the price; stops → looked up, picked if ambiguous, planned, reviewed. */
async function bookTrip(data: Record<string, unknown>, userId: string, deps: BookRideDeps): Promise<FlowScreen> {
  const trip = await getPendingRoute(deps.redisClient, userId);
  const draft = await loadDraft(deps, userId);
  if (!trip || !draft?.pickup || !draft.destination) return whereToScreen({}, 'That trip has expired — type it again.');
  const stopsTyped = [text(data['stop_1']), text(data['stop_2']), text(data['stop_3'])].map((s) => s.slice(0, 200));
  if (stopsTyped.every((s) => !s)) return confirm(userId, { ...trip, stops: [] }, editDeps(deps));

  const found = await Promise.all(stopsTyped.map((typed) => (typed
    ? findPlaceOptions(deps.googleMapsApiKey, typed, { near: draft.pickup, limit: MAX_MATCHES }).catch(() => [])
    : Promise.resolve([]))));
  const missing = stopsTyped.findIndex((typed, index) => typed && found[index]!.length === 0);
  if (missing >= 0) return tripScreenFor(trip, stopsTyped, `I could not find "${clip(stopsTyped[missing]!, 40)}" (stop ${missing + 1}). Add the area or a landmark.`);

  const stopOptions: Record<number, RouteStop[]> = {};
  const stopsResolved: Record<number, RouteStop> = {};
  stopsTyped.forEach((typed, index) => {
    if (!typed) return;
    const places = found[index]!.map(toStop);
    if (places.length === 1) stopsResolved[index + 1] = places[0]!;
    else stopOptions[index + 1] = places;
  });
  await saveDraft(deps, userId, { ...draft, stopsTyped, stopOptions, stopsResolved });
  if (Object.keys(stopOptions).length > 0) return stopPlacesScreen({ ...draft, stopOptions });
  return planWithStops(userId, deps, draft, [1, 2, 3].map((i) => stopsResolved[i]).filter((s): s is RouteStop => Boolean(s)), (error) => tripScreenFor(trip, stopsTyped, error));
}

async function bookStopPlaces(data: Record<string, unknown>, userId: string, deps: BookRideDeps): Promise<FlowScreen> {
  const draft = await loadDraft(deps, userId);
  const trip = await getPendingRoute(deps.redisClient, userId);
  if (!draft?.pickup || !draft.destination || !trip) return whereToScreen({}, 'That trip has expired — type it again.');
  const resolved: Record<number, RouteStop> = { ...(draft.stopsResolved ?? {}) };
  for (const index of [1, 2, 3]) {
    const options = draft.stopOptions?.[index];
    if (!options) continue;
    const picked = text(data[`pick_stop_${index}`]);
    if (!picked) return stopPlacesScreen(draft, `Pick the right stop ${index} to continue.`);
    if (picked === NONE) return stopPlacesScreen(draft, `No problem — tap ← at the top and type stop ${index} again with the area or a landmark.`);
    const place = options[Number(picked)];
    if (!place) return stopPlacesScreen(draft, `Pick the right stop ${index} to continue.`);
    resolved[index] = place;
  }
  return planWithStops(userId, deps, draft, [1, 2, 3].map((i) => resolved[i]).filter((s): s is RouteStop => Boolean(s)), (error) => stopPlacesScreen(draft, error));
}

async function planWithStops(userId: string, deps: BookRideDeps, draft: BookDraft, stops: RouteStop[], refuse: (error: string) => FlowScreen): Promise<FlowScreen> {
  const pickup = draft.pickup!;
  const destination = draft.destination!;
  const far = stops.find((stop) => kmBetween(pickup, stop) > SAME_CITY_KM);
  if (far) return refuse(`${clip(far.address, 60)} is about ${Math.round(kmBetween(pickup, far)).toLocaleString()} km from your pickup — another city. Add the area, or leave that stop out.`);
  const points = [{ label: 'pickup', place: pickup }, ...stops.map((place, i) => ({ label: `stop ${i + 1}`, place })), { label: 'destination', place: destination }];
  for (let a = 0; a < points.length; a++) for (let b = a + 1; b < points.length; b++) {
    if (kmBetween(points[a]!.place, points[b]!.place) < SAME_PLACE_KM) return refuse(`Your ${points[a]!.label} and your ${points[b]!.label} are the same place. Change one of them.`);
  }
  const planned = await deps.routePlanner.planRoute({ origin: pickup, destination, stops }).catch(() => null);
  if (!planned) return refuse('I could not find a driving route through those places. Check them and try again.');
  const trip: PendingRouteData = {
    pickupLat: pickup.lat, pickupLng: pickup.lng, pickupAddress: pickup.address,
    destLat: destination.lat, destLng: destination.lng, destAddress: destination.address,
    stops,
    distanceKm: planned.distanceKm, durationSeconds: planned.durationSeconds,
    suggestedFareNgn: planned.suggestedFareNgn, minOfferNgn: planned.minOfferNgn, ratePerKmNgn: planned.ratePerKmNgn,
    route: planned.geometry,
  };
  await storePendingRoute(deps.redisClient, userId, trip);
  await setBookingStage(deps.redisClient, userId, 'awaiting_trip_confirm');
  return bookReviewScreen(trip);
}
