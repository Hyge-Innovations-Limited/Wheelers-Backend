import { RouteChangeRefused } from './route-refused';
import { PRICE_CHANGEABLE_STATUSES, rideClient, walletClient } from '@wheleers/db';
import { haversineKm } from '../utils/geo';
import { routeBaseOf, sameBase } from './trip-route-pending';
import type { RouteBase } from './trip-route-pending';
import type { GoogleMapsRoutePlanner, PlannedRouteMetrics } from '@wheleers/config';
import type { RedisClient } from '../redis/client';

/**
 * A booked trip's route changed by the rider (stops added, moved or removed,
 * a new destination): what it will cost before anything moves. The trip is
 * planned from where it is now (the car during the trip, the pickup before
 * it) and priced as the ride service prices a route change, and the wallet's
 * hold follows that price (wallet-service adjustRideHold on RIDE_ROUTE_UPDATED).
 *
 * The plan behind a quote is kept for a few minutes, so the change the rider
 * then agrees to is priced exactly as quoted (not planned again a minute later
 * from a car that has moved). Nothing else is touched: a quote has no side
 * effects on the trip or the money.
 *
 *   ride:{rideId}:route-quote   { key, planned }   the last quote's plan, 10 minutes
 */

let stopFixedPrice = false;
/** Set once at start-up from STOP_FIXED_PRICE_ENABLED. Off, a quote is the rest of the trip alone, as before. */
export function setStopFixedPriceEnabled(value: boolean): void { stopFixedPrice = value; }
export function stopFixedPriceEnabled(): boolean { return stopFixedPrice; }

/** The trip cannot change its route now (over, cancelled, or not booked yet), or the change is refused on purpose. */
export { RouteChangeRefused };

type Planner = Pick<GoogleMapsRoutePlanner, 'planRoute'>;
type Place = { lat: number; lng: number; address?: string };

export interface TripRouteQuote {
  /** The trip's price on the new route: what the wallet will hold for it. */
  fareNgn: number;
  /** What more is held than now (negative: that much goes back to the wallet). */
  extraNgn: number;
  /** The ride as this price saw it, and when and where the car was (flag on). At accept the cached quote is used only while the ride still looks like this and the price is fresh. */
  base?: RouteBase;
  /** The km this fare is set for (driven so far + the rest). Saved as Ride.plannedDistanceKm with the fare. Absent: not priced by the formula. */
  plannedTotalKm?: number;
  /** The fare came from the negotiated-rate formula (flag on), not the rest-of-trip price. */
  formula?: boolean;
  /** The plan the price came from (handed to ride:route:update so the hold is the quote). */
  planned: PlannedRouteMetrics;
}

/** The ride's negotiated rate, fixed when the driver was matched (Ride.bargainRate). Null, zero or not a number: 1. Never worked out from the current agreed fare. */
export function bargainRate(stored: number | null | undefined): number {
  const r = Number(stored);
  return stored != null && r > 0 && Number.isFinite(r) ? r : 1;
}

/**
 * A route change priced at the ride's own negotiated rate. Before the pickup it is our price for the
 * whole new route x the rate. During the trip it is the share of the agreed fare already driven, plus
 * our price for the rest from where the car is x the rate: round(agreed x drivenKm / plannedKm) + round(rest x rate).
 * Exact: no floor, no cap.
 */
export function routeChangeFare(input: {
  inProgress: boolean;
  agreedFareNgn: number;
  plannedKm: number;
  drivenKm: number;
  restFareNgn: number;
  restKm: number;
  rate: number;
}): { fareNgn: number; plannedTotalKm: number } {
  const rest = Math.round(input.restFareNgn * input.rate);
  if (!input.inProgress) return { fareNgn: rest, plannedTotalKm: input.restKm };
  const driven = Math.min(Math.max(0, input.drivenKm), input.plannedKm);
  return {
    fareNgn: Math.round(input.agreedFareNgn * driven / input.plannedKm) + rest,
    plannedTotalKm: driven + input.restKm,
  };
}

/** A price older than this is set again before it is used (during the trip). */
export const QUOTE_FRESH_MS = 2 * 60 * 1000;
/** A car that has moved further than this since the price was set makes the price old. */
export const CAR_MOVED_METERS = 300;

type LatLng = { lat: number; lng: number };

/** A re-price this close to the price the rider accepted is not a new price: the accepted one stands. */
export function priceWithinTolerance(newFareNgn: number, acceptedFareNgn: number): boolean {
  return Math.abs(newFareNgn - acceptedFareNgn) <= Math.max(50, 0.02 * acceptedFareNgn);
}

/**
 * The price (a quote, or a waiting change) is old: set more than 2 minutes ago, or for a car that has since moved
 * more than 300 m. Only during the trip: before the pickup the price comes from the pickup, not the car, so neither moves it.
 */
export function quoteIsStale(stamp: { pricedAt?: string; car?: LatLng } | undefined, carNow: LatLng | undefined, inProgress: boolean, now = Date.now()): boolean {
  if (!inProgress) return false;
  const at = stamp?.pricedAt ? Date.parse(stamp.pricedAt) : NaN;
  if (!Number.isFinite(at) || now - at > QUOTE_FRESH_MS) return true;
  if (!carNow) return false;
  if (!stamp?.car) return true;
  return haversineKm(stamp.car.lat, stamp.car.lng, carNow.lat, carNow.lng) * 1000 > CAR_MOVED_METERS;
}

const carOf = (ride: { status: unknown; driver?: { lat: number | null; lng: number | null } | null }): LatLng | undefined =>
  ride.status === 'IN_PROGRESS' && ride.driver?.lat != null && ride.driver.lng != null ? { lat: ride.driver.lat, lng: ride.driver.lng } : undefined;

/** The same test against the ride as it is now (its status and the car's position are read here). */
export async function stampIsStale(rideId: string, stamp: { pricedAt?: string; car?: LatLng }): Promise<boolean> {
  const ride = await rideClient.findWithDriver(rideId).catch(() => null);
  if (!ride) return true;
  return quoteIsStale(stamp, carOf(ride), ride.status === 'IN_PROGRESS');
}

type Stop = { lat: number; lng: number; status?: string; type?: string };
const at = (p: { lat: number; lng: number }) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;

/** Under the flag a change that leaves the stops and destination as they are is not a change (no free reprice). */
export function assertRouteDiffers(routeStops: Stop[] | undefined, destination: Place, stops: Place[]): void {
  const ahead = (routeStops ?? []).filter((s) => s.status === 'PENDING').sort((a, b) => Number((a as { stopOrder?: number }).stopOrder ?? 0) - Number((b as { stopOrder?: number }).stopOrder ?? 0));
  if (ahead.length === 0) return;
  const current = ahead.map(at).join('|');
  const asked = [...stops, destination].map(at).join('|');
  if (current === asked) throw new RouteChangeRefused('That is the route you already have.');
}

const QUOTE_TTL_SECONDS = 10 * 60;
const quoteKey = (rideId: string) => `ride:${rideId}:route-quote`;

/** The route asked about, as one string: the same places in the same order are the same route. */
function routeKey(destination: Place, stops: Place[]): string {
  return [...stops, destination].map((p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join('|');
}

/** Where the trip is planned from: the car during the trip (its last known position), else the pickup. */
async function originOf(rideId: string): Promise<{ lat: number; lng: number }> {
  const ride = await rideClient.findWithDriver(rideId);
  const driver = ride.driver;
  if (ride.status === 'IN_PROGRESS' && driver?.lat != null && driver.lng != null) return { lat: driver.lat, lng: driver.lng };
  return { lat: ride.pickupLat, lng: ride.pickupLng };
}

/** What is held for the ride now: its active hold, or (none: cash, or not held yet) the agreed fare. */
async function heldNow(rideId: string): Promise<number> {
  const hold = await walletClient.rideHoldOf(rideId).catch(() => null);
  if (hold && hold.status === 'ACTIVE') return Math.round(Number(hold.amountNgn));
  const ride = await rideClient.findById(rideId).catch(() => null);
  return Math.round(Number(ride?.agreedFareNgn ?? ride?.riderOfferNgn ?? ride?.fareEstimateNgn ?? 0));
}

/** The car's position must be recent (60 s) and agree with its last recorded GPS point, or a price built on it is not trusted. */
export const CAR_SEEN_MAX_MS = 60 * 1000;
export async function assertCarUsable(rideId: string, ride: { driver?: { lat: number | null; lng: number | null; lastSeenAt?: Date | string | null } | null }, now = Date.now()): Promise<void> {
  const d = ride.driver;
  if (!d || d.lat == null || d.lng == null) return;
  const seen = d.lastSeenAt ? new Date(d.lastSeenAt).getTime() : NaN;
  if (!Number.isFinite(seen) || now - seen > CAR_SEEN_MAX_MS) throw new RouteChangeRefused('We cannot see the car right now. Try again in a moment.');
  const last = await rideClient.lastGpsPoint(rideId).catch(() => null);
  // A recent GPS point more than 1 km from the car's position: one of the two is wrong.
  if (last && now - new Date(last.timestamp).getTime() < 2 * 60 * 1000 && haversineKm(last.lat, last.lng, d.lat, d.lng) > 1) {
    throw new RouteChangeRefused('We cannot place the car right now. Try again in a moment.');
  }
}

/**
 * An UNPRICED route change (an older app): where the trip is planned to end changes, so the planned km changes with it,
 * by exactly how much longer or shorter the rest of the road gets, both measured from the car (the pickup before it)
 * with the planner. The driven distance is therefore kept. longerByKm lets the caller refuse a change that lengthens the trip.
 */
export async function unpricedRouteChange(planner: Planner, rideId: string, destination: Place, stops: Place[]): Promise<{ plannedTotalKm: number; longerByKm: number; pricedBaselineKm: number | null; base: RouteBase }> {
  const ride = await rideClient.findWithDriver(rideId);
  const inProgress = ride.status === 'IN_PROGRESS';
  const car = carOf(ride);
  // During the trip the road left cannot be measured without the car.
  if (inProgress && !car) throw new RouteChangeRefused('We cannot see the car right now. Try again in a moment.');
  if (inProgress && car) await assertCarUsable(rideId, ride);
  const from = car ?? { lat: ride.pickupLat, lng: ride.pickupLng };
  const ahead = (ride.routeStops ?? [])
    .filter((st) => st.status === 'PENDING')
    .sort((x, y) => Number(x.stopOrder ?? 0) - Number(y.stopOrder ?? 0));
  // An older app cannot add a stop (it would not be paid for): the stops ahead may not go up.
  if (stops.length + 1 > Math.max(ahead.length, 1)) throw new RouteChangeRefused('Update the app to add stops.');
  const oldLast = ahead.length > 0 ? ahead[ahead.length - 1]! : { lat: ride.destLat, lng: ride.destLng };
  const known = ride.plannedDistanceKm != null && Number.isFinite(ride.plannedDistanceKm) && ride.plannedDistanceKm > 0 ? ride.plannedDistanceKm : null;
  const [remOld, remNew, legToCar] = await Promise.all([
    planner.planRoute({ origin: from, stops: ahead.slice(0, -1), destination: oldLast }).then((r) => r.distanceKm),
    planner.planRoute({ origin: from, stops, destination }).then((r) => r.distanceKm),
    known !== null || !(inProgress && car)
      ? Promise.resolve(0)
      : planner.planRoute({ origin: { lat: ride.pickupLat, lng: ride.pickupLng }, stops: [], destination: car })
          .then((r) => r.distanceKm).catch(() => haversineKm(ride.pickupLat, ride.pickupLng, car.lat, car.lng)),
  ]);
  const plannedTotalKm = known !== null ? Math.max(0.001, known + remNew - remOld) : Math.max(0.001, legToCar + remNew);
  const baseline = ride.pricedPlannedKm ?? known;
  return { plannedTotalKm, longerByKm: remNew - remOld, pricedBaselineKm: baseline, base: routeBaseOf(ride) };
}

/**
 * Km driven with the rider and the plan it is measured against, from the planner (the same one that set plannedKm):
 * driven = plannedKm - the road km from the car, through the old stops still ahead, to the old destination.
 * GPS pings are not used (jitter inflates them, gaps shrink them). A ride with no plannedKm: the plan is derived,
 * driven = the road from the pickup to the car, planned = driven + the old remaining route.
 */
async function drivenAndPlanned(
  ride: { pickupLat: number; pickupLng: number; destLat: number; destLng: number; plannedDistanceKm: number | null; routeStops?: Stop[] },
  car: LatLng,
  planner: Planner,
): Promise<{ drivenKm: number; plannedKm: number }> {
  const ahead = (ride.routeStops ?? [])
    .filter((st) => st.status === 'PENDING')
    .sort((x, y) => Number((x as { stopOrder?: number }).stopOrder ?? 0) - Number((y as { stopOrder?: number }).stopOrder ?? 0));
  const last = ahead.length > 0 ? ahead[ahead.length - 1]! : { lat: ride.destLat, lng: ride.destLng };
  const middle = ahead.slice(0, -1);
  const known = ride.plannedDistanceKm != null && Number.isFinite(ride.plannedDistanceKm) && ride.plannedDistanceKm > 0 ? ride.plannedDistanceKm : null;
  const [remaining, legToCar] = await Promise.all([
    planner.planRoute({ origin: car, stops: middle, destination: last }).then((r) => r.distanceKm),
    known !== null
      ? Promise.resolve(0)
      : planner.planRoute({ origin: { lat: ride.pickupLat, lng: ride.pickupLng }, stops: [], destination: car })
          .then((r) => r.distanceKm)
          .catch(() => haversineKm(ride.pickupLat, ride.pickupLng, car.lat, car.lng)),
  ]);
  if (known !== null) return { drivenKm: Math.max(0, known - remaining), plannedKm: known };
  const drivenKm = Math.max(0, legToCar);
  return { drivenKm, plannedKm: Math.max(drivenKm + remaining, 0.001) };
}

/**
 * The price of the trip on this route. A plan quoted for this very route is used as it was (the change the rider
 * agreed to) while the ride still looks as it did and, during the trip, the price is under 2 minutes old and the car
 * has not moved more than 300 m. `fresh`: never reuse one (a waiting change found stale).
 */
export async function quoteTripRoute(
  deps: { redis: RedisClient; routePlanner: Planner },
  rideId: string,
  destination: Place,
  stops: Place[],
  opts: { fresh?: boolean; acceptedFareNgn?: number; shownStaleFareNgn?: number } = {},
): Promise<TripRouteQuote> {
  const key = routeKey(destination, stops);
  const formula = stopFixedPrice;
  type Kept = { key?: string; planned?: PlannedRouteMetrics; fareNgn?: number; plannedTotalKm?: number; formula?: boolean; base?: RouteBase };
  let kept: Kept | null = null;
  const raw = opts.fresh ? null : await deps.redis.get(quoteKey(rideId)).catch(() => null);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Kept;
      const usable = parsed.key === key && parsed.planned && Number.isFinite(parsed.planned.suggestedFareNgn)
        && (!formula || Number.isFinite(parsed.fareNgn));
      if (usable) kept = parsed;
    } catch {
      kept = null;
    }
  }

  let ride: Awaited<ReturnType<typeof rideClient.findWithDriver>> | null = null;
  if (formula) {
    ride = await rideClient.findWithDriver(rideId);
    if (!PRICE_CHANGEABLE_STATUSES.includes(ride.status)) throw new RouteChangeRefused('This trip can no longer change its route.');
    assertRouteDiffers(ride.routeStops, destination, stops);
  }
  const inProgress = ride?.status === 'IN_PROGRESS';
  if (ride && inProgress && carOf(ride)) await assertCarUsable(rideId, ride);

  // A quote priced against a ride that has since changed (a stop reached, another change), or an old one, is priced again.
  // A quote that is only OLD (the ride is as it was) and was the price the rider saw: if the new price is within
  // tolerance of what they accepted, their accepted price stands.
  let shownStale: number | undefined = opts.shownStaleFareNgn;
  if (kept && ride) {
    const sameRide = !!kept.base && sameBase(kept.base, routeBaseOf(ride));
    if (!sameRide || quoteIsStale(kept.base, carOf(ride), inProgress)) {
      if (sameRide && Number.isFinite(kept.fareNgn)) shownStale = shownStale ?? Math.round(kept.fareNgn as number);
      kept = null;
    }
  }

  if (kept && kept.planned) {
    const fareNgn = formula ? Math.round(kept.fareNgn as number) : Math.round(kept.planned.suggestedFareNgn);
    return { fareNgn, extraNgn: fareNgn - (await heldNow(rideId)), planned: kept.planned, ...(formula ? { plannedTotalKm: kept.plannedTotalKm, formula: kept.formula ?? false, base: kept.base } : {}) };
  }

  const car = ride ? carOf(ride) : undefined;
  const origin = ride
    ? (car ?? { lat: ride.pickupLat, lng: ride.pickupLng })
    : await originOf(rideId);
  // The new route's plan and the driven distance do not depend on each other: one round trip, not two.
  const [fresh, motion] = await Promise.all([
    deps.routePlanner.planRoute({ origin, stops, destination }),
    ride && inProgress && car ? drivenAndPlanned(ride, car, deps.routePlanner) : Promise.resolve(null),
  ]);
  // Whole naira: the hold is exactly the price the rider is shown.
  const planned: PlannedRouteMetrics = { ...fresh, suggestedFareNgn: Math.round(fresh.suggestedFareNgn) };

  let fareNgn = planned.suggestedFareNgn;
  let plannedTotalKm: number | undefined;
  let base: RouteBase | undefined;
  if (ride) {
    const agreedFareNgn = Number(ride.agreedFareNgn ?? ride.riderOfferNgn ?? ride.fareEstimateNgn ?? 0);
    // The bargain is the ride's own: our price for the new route x the rate fixed at the match (1 if none was stored).
    const rate = bargainRate(ride.bargainRate);
    let drivenKm = 0;
    let plannedKm = 1;
    if (motion) ({ drivenKm, plannedKm } = motion);
    // No known car position during the trip: priced like the whole route from the pickup.
    const priced = routeChangeFare({
      inProgress: inProgress && !!car,
      agreedFareNgn,
      plannedKm,
      drivenKm,
      restFareNgn: planned.suggestedFareNgn,
      restKm: planned.distanceKm,
      rate,
    });
    fareNgn = priced.fareNgn;
    if (opts.acceptedFareNgn !== undefined && shownStale !== undefined && Math.round(opts.acceptedFareNgn) === shownStale && priceWithinTolerance(fareNgn, shownStale)) fareNgn = shownStale;
    plannedTotalKm = priced.plannedTotalKm;
    base = { ...routeBaseOf(ride), pricedAt: new Date().toISOString(), ...(car ? { car } : {}), kmDriven: drivenKm };
  }
  await deps.redis.set(quoteKey(rideId), JSON.stringify({ key, planned, fareNgn, plannedTotalKm, formula: !!ride, base }), QUOTE_TTL_SECONDS).catch(() => undefined);
  return { fareNgn, extraNgn: fareNgn - (await heldNow(rideId)), planned, ...(formula ? { plannedTotalKm, formula: !!ride, base } : {}) };
}

/** The route change went out: its quote is spent. */
export async function forgetTripRouteQuote(redis: RedisClient, rideId: string): Promise<void> {
  await redis.del(quoteKey(rideId)).catch(() => undefined);
}
