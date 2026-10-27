import { rideClient, walletClient } from '@wheleers/db';
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

type Planner = Pick<GoogleMapsRoutePlanner, 'planRoute'>;
type Place = { lat: number; lng: number; address?: string };

export interface TripRouteQuote {
  /** The trip's price on the new route: what the wallet will hold for it. */
  fareNgn: number;
  /** What more is held than now (negative: that much goes back to the wallet). */
  extraNgn: number;
  /** The plan the price came from (handed to ride:route:update so the hold is the quote). */
  planned: PlannedRouteMetrics;
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

/**
 * The price of the trip on this route. `reuse`: a plan quoted for this very
 * route in the last 10 minutes is used as it was (the change the rider agreed to).
 */
export async function quoteTripRoute(
  deps: { redis: RedisClient; routePlanner: Planner },
  rideId: string,
  destination: Place,
  stops: Place[],
): Promise<TripRouteQuote> {
  const key = routeKey(destination, stops);
  let planned: PlannedRouteMetrics | null = null;
  const raw = await deps.redis.get(quoteKey(rideId)).catch(() => null);
  if (raw) {
    try {
      const kept = JSON.parse(raw) as { key?: string; planned?: PlannedRouteMetrics };
      if (kept.key === key && kept.planned && Number.isFinite(kept.planned.suggestedFareNgn)) planned = kept.planned;
    } catch {
      planned = null;
    }
  }
  if (!planned) {
    const origin = await originOf(rideId);
    const fresh = await deps.routePlanner.planRoute({ origin, stops, destination });
    // Whole naira: the hold is exactly the price the rider is shown.
    planned = { ...fresh, suggestedFareNgn: Math.round(fresh.suggestedFareNgn) };
    await deps.redis.set(quoteKey(rideId), JSON.stringify({ key, planned }), QUOTE_TTL_SECONDS).catch(() => undefined);
  }
  const fareNgn = Math.round(planned.suggestedFareNgn);
  return { fareNgn, extraNgn: fareNgn - (await heldNow(rideId)), planned };
}

/** The route change went out: its quote is spent. */
export async function forgetTripRouteQuote(redis: RedisClient, rideId: string): Promise<void> {
  await redis.del(quoteKey(rideId)).catch(() => undefined);
}
