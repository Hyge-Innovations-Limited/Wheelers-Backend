import {
  calculateSuggestedFare,
  isRushHour,
  trafficFactorOn,
  zoneFor,
  GoogleMapsRoutePlanner,
  type PlannedRouteMetrics,
  type RouteWaypoint,
} from '@wheleers/config';
import { pricingClient } from '@wheleers/db';
import { demandFactorAt } from '../pricing/busyness';
import { cachedMaps, mapsKey } from './shared-cache';

/**
 * The route planner, with Google's answer for a trip remembered for a few
 * hours. The same ride asks for its route several times (quote, edit, re-quote,
 * confirm) and popular pickups and drop-offs repeat across riders; each now
 * costs one call to Google.
 *
 * Only distance, duration and the line on the map are kept. The fare is
 * worked out fresh on every call, so a pricing change applies at once.
 * Points are matched to about a metre: a pin 10 m away can be across a
 * divided road, with a different route, so near enough is not the same.
 * The version goes up whenever the request to Google changes (e.g. live
 * traffic), and nothing cached before is read again.
 */
const ROUTE_CACHE_VERSION = 1;
const ROUTE_TTL_SECONDS = 6 * 60 * 60;
// With the traffic factor on, an answer is about the road right now: its own
// keys (so a no-traffic answer is never read as a traffic one) and minutes, not hours.
const TRAFFIC_ROUTE_CACHE_VERSION = 101;
const TRAFFIC_ROUTE_TTL_SECONDS = 5 * 60;

type CachedRoute = Pick<PlannedRouteMetrics, 'distanceKm' | 'durationSeconds' | 'geometry' | 'trafficRatio'>;

const point = (p: RouteWaypoint) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

function isCachedRoute(value: unknown): value is CachedRoute {
  const v = value as CachedRoute | null;
  return Boolean(
    v && typeof v.distanceKm === 'number' && v.distanceKm > 0 && typeof v.durationSeconds === 'number'
      && v.geometry && Array.isArray(v.geometry.coordinates) && v.geometry.bounds,
  );
}

// A ride asks for its price several times in a row (quote, edit, confirm):
// the same trip at the same price is written to the quote log once in two minutes.
const QUOTE_REPEAT_MS = 2 * 60_000;
const recentQuotes = new Map<string, number>();

function recordQuote(
  params: { origin: RouteWaypoint; destination: RouteWaypoint },
  route: CachedRoute,
  price: ReturnType<typeof calculateSuggestedFare>,
  demandFactor: number,
): void {
  const now = Date.now();
  const key = `${point(params.origin)}>${point(params.destination)}=${price.suggestedFareNgn}`;
  const last = recentQuotes.get(key);
  if (last !== undefined && now - last < QUOTE_REPEAT_MS) return;
  recentQuotes.set(key, now);
  if (recentQuotes.size > 5000) {
    for (const [k, at] of recentQuotes) if (now - at >= QUOTE_REPEAT_MS) recentQuotes.delete(k);
  }
  // Never in the way of the quote itself.
  void pricingClient.logQuote({
    origin: params.origin, destination: params.destination,
    pickupZone: zoneFor(params.origin.lat, params.origin.lng),
    distanceKm: route.distanceKm, durationSeconds: route.durationSeconds,
    trafficRatio: route.trafficRatio ?? null, demandFactor, rush: isRushHour(),
    marketFareNgn: price.marketFareNgn, floorFareNgn: price.floorFareNgn, rulesFareNgn: price.rulesFareNgn,
    modelFareNgn: price.modelFareNgn, suggestedFareNgn: price.suggestedFareNgn, minOfferNgn: price.minOfferNgn, setBy: price.setBy,
  }).catch((error) => console.warn('[pricing] quote not logged', { error: error instanceof Error ? error.message : String(error) }));
}

export class CachedRoutePlanner extends GoogleMapsRoutePlanner {
  override async planRoute(params: {
    origin: RouteWaypoint;
    stops?: RouteWaypoint[];
    destination: RouteWaypoint;
  }): Promise<PlannedRouteMetrics> {
    const traffic = trafficFactorOn();
    const key = mapsKey('route', traffic ? TRAFFIC_ROUTE_CACHE_VERSION : ROUTE_CACHE_VERSION, point(params.origin), (params.stops ?? []).map(point).join(';'), point(params.destination));
    const route = await cachedMaps<CachedRoute>(key, traffic ? TRAFFIC_ROUTE_TTL_SECONDS : ROUTE_TTL_SECONDS, async () => {
      const fresh = await super.planRoute(params);
      return { distanceKm: fresh.distanceKm, durationSeconds: fresh.durationSeconds, geometry: fresh.geometry, trafficRatio: fresh.trafficRatio };
    }, { keep: isCachedRoute, valid: isCachedRoute });

    // The pickup area's busyness and the trip's time go into the price here,
    // fresh on every call; the cached route is only the road.
    const demandFactor = demandFactorAt(params.origin.lat, params.origin.lng);
    const ridePrice = calculateSuggestedFare(route.distanceKm, {
      trafficRatio: route.trafficRatio, durationSeconds: route.durationSeconds, demandFactor,
    });
    recordQuote(params, route, ridePrice, demandFactor);
    return {
      distanceKm: route.distanceKm,
      durationSeconds: route.durationSeconds,
      suggestedFareNgn: ridePrice.suggestedFareNgn,
      minOfferNgn: ridePrice.minOfferNgn,
      ratePerKmNgn: ridePrice.ratePerKmNgn,
      fareEstimateNgn: ridePrice.suggestedFareNgn,
      ridePrice,
      geometry: route.geometry,
      ...(route.trafficRatio !== undefined ? { trafficRatio: route.trafficRatio } : {}),
    };
  }
}
