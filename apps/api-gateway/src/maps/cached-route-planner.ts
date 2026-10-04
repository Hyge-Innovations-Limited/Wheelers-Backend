import {
  calculateSuggestedFare,
  GoogleMapsRoutePlanner,
  type PlannedRouteMetrics,
  type RouteWaypoint,
} from '@wheleers/config';
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

type CachedRoute = Pick<PlannedRouteMetrics, 'distanceKm' | 'durationSeconds' | 'geometry'>;

const point = (p: RouteWaypoint) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

function isCachedRoute(value: unknown): value is CachedRoute {
  const v = value as CachedRoute | null;
  return Boolean(
    v && typeof v.distanceKm === 'number' && v.distanceKm > 0 && typeof v.durationSeconds === 'number'
      && v.geometry && Array.isArray(v.geometry.coordinates) && v.geometry.bounds,
  );
}

export class CachedRoutePlanner extends GoogleMapsRoutePlanner {
  override async planRoute(params: {
    origin: RouteWaypoint;
    stops?: RouteWaypoint[];
    destination: RouteWaypoint;
  }): Promise<PlannedRouteMetrics> {
    const key = mapsKey('route', ROUTE_CACHE_VERSION, point(params.origin), (params.stops ?? []).map(point).join(';'), point(params.destination));
    const route = await cachedMaps<CachedRoute>(key, ROUTE_TTL_SECONDS, async () => {
      const fresh = await super.planRoute(params);
      return { distanceKm: fresh.distanceKm, durationSeconds: fresh.durationSeconds, geometry: fresh.geometry };
    }, { keep: isCachedRoute, valid: isCachedRoute });

    const ridePrice = calculateSuggestedFare(route.distanceKm);
    return {
      distanceKm: route.distanceKm,
      durationSeconds: route.durationSeconds,
      suggestedFareNgn: ridePrice.suggestedFareNgn,
      minOfferNgn: ridePrice.minOfferNgn,
      ratePerKmNgn: ridePrice.ratePerKmNgn,
      fareEstimateNgn: ridePrice.suggestedFareNgn,
      ridePrice,
      geometry: route.geometry,
    };
  }
}
