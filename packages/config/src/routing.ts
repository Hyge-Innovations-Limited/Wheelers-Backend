import { calculateSuggestedFare, trafficFactorOn, type SuggestedFare } from './pricing';

export type RouteWaypoint = {
  lat: number;
  lng: number;
};

export type RouteBounds = {
  northEast: RouteWaypoint;
  southWest: RouteWaypoint;
};

export type PlannedRouteGeometry = {
  coordinates: RouteWaypoint[];
  bounds: RouteBounds;
};

export type PlannedRouteMetrics = {
  distanceKm: number;
  durationSeconds: number;
  suggestedFareNgn: number;
  minOfferNgn: number;
  ratePerKmNgn: number;
  fareEstimateNgn: number;
  ridePrice: SuggestedFare;
  geometry: PlannedRouteGeometry;
  /**
   * Travel time now ÷ travel time on an empty road, when the traffic factor
   * is on (PRICING_TRAFFIC_FACTOR=on). Absent otherwise.
   */
  trafficRatio?: number;
};

export class RoutePlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutePlanningError';
  }
}

export class GoogleMapsRoutePlanner {
  private readonly normalizedBaseUrl: URL;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {
    this.normalizedBaseUrl = normalizeGoogleMapsBaseUrl(baseUrl);
  }

  async planRoute(params: {
    origin: RouteWaypoint;
    stops?: RouteWaypoint[];
    destination: RouteWaypoint;
  }): Promise<PlannedRouteMetrics> {
    const traffic = trafficFactorOn();
    const response = await fetch(
      new URL('directions/v2:computeRoutes', this.normalizedBaseUrl),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.apiKey,
          // With the traffic factor on, Google is asked for the time now AND
          // the time on an empty road; their ratio is what moves the price.
          'x-goog-fieldmask': traffic
            ? 'routes.distanceMeters,routes.duration,routes.staticDuration,routes.polyline.encodedPolyline,routes.viewport'
            : 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.viewport',
        },
        body: JSON.stringify({
          origin: buildWaypoint(params.origin),
          destination: buildWaypoint(params.destination),
          ...(params.stops?.length
            ? { intermediates: params.stops.map((stop) => buildWaypoint(stop)) }
            : {}),
          travelMode: 'DRIVE',
          routingPreference: traffic ? 'TRAFFIC_AWARE' : 'TRAFFIC_UNAWARE',
          computeAlternativeRoutes: false,
          languageCode: 'en-US',
          units: 'METRIC',
          polylineQuality: 'OVERVIEW',
          polylineEncoding: 'ENCODED_POLYLINE',
        }),
      },
    );

    const contentType = response.headers.get('content-type') ?? '';
    const payload = contentType.includes('application/json')
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      const detail =
        typeof payload === 'string'
          ? payload
          : safeSerializeErrorPayload(payload);
      throw new RoutePlanningError(
        `Google Maps route request failed with status ${response.status}${
          detail ? `: ${detail}` : ''
        }`,
      );
    }

    const route = extractPrimaryRoute(payload);
    const distanceKm = round3(route.distanceMeters / 1000);
    const durationSeconds = Math.max(0, Math.round(route.durationSeconds));
    const trafficRatio = traffic ? trafficRatioOf(payload, route.durationSeconds) : undefined;
    const ridePrice = calculateSuggestedFare(distanceKm, { trafficRatio });

    return {
      distanceKm,
      durationSeconds,
      suggestedFareNgn: ridePrice.suggestedFareNgn,
      minOfferNgn: ridePrice.minOfferNgn,
      ratePerKmNgn: ridePrice.ratePerKmNgn,
      fareEstimateNgn: ridePrice.suggestedFareNgn,
      ridePrice,
      geometry: {
        coordinates: route.coordinates,
        bounds: route.bounds,
      },
      ...(trafficRatio !== undefined ? { trafficRatio } : {}),
    };
  }
}

/** Time now ÷ time on an empty road for the first route, or undefined when Google did not say. */
function trafficRatioOf(payload: unknown, durationSeconds: number): number | undefined {
  const first = (payload as { routes?: Array<{ staticDuration?: unknown }> } | null)?.routes?.[0];
  const raw = typeof first?.staticDuration === 'string' ? Number.parseFloat(first.staticDuration) : NaN;
  if (!Number.isFinite(raw) || raw <= 0 || !(durationSeconds > 0)) return undefined;
  return Math.max(1, Math.round((durationSeconds / raw) * 100) / 100);
}

function normalizeGoogleMapsBaseUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if (!url.pathname.endsWith('/')) {
    url.pathname = `${url.pathname}/`;
  }
  return url;
}

function buildWaypoint(point: RouteWaypoint): {
  location: {
    latLng: {
      latitude: number;
      longitude: number;
    };
  };
} {
  return {
    location: {
      latLng: {
        latitude: point.lat,
        longitude: point.lng,
      },
    },
  };
}

export function estimateRideFareNgn(
  ridePrice: SuggestedFare,
): number {
  return ridePrice.suggestedFareNgn;
}

function extractPrimaryRoute(payload: unknown): {
  distanceMeters: number;
  durationSeconds: number;
  coordinates: RouteWaypoint[];
  bounds: RouteBounds;
} {
  if (!payload || typeof payload !== 'object') {
    throw new RoutePlanningError('Google Maps returned an invalid response body');
  }

  const routes = (payload as { routes?: unknown }).routes;
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new RoutePlanningError('Google Maps returned no routes');
  }

  const primaryRoute = routes[0];
  if (!primaryRoute || typeof primaryRoute !== 'object') {
    throw new RoutePlanningError('Google Maps returned an invalid route');
  }

  const distanceMeters = (primaryRoute as { distanceMeters?: unknown }).distanceMeters;
  if (typeof distanceMeters !== 'number' || !Number.isFinite(distanceMeters)) {
    throw new RoutePlanningError('Google Maps response is missing route distance');
  }

  const durationSeconds = parseDurationSeconds(
    (primaryRoute as { duration?: unknown }).duration,
  );

  const encodedPolyline = extractEncodedPolyline(primaryRoute);
  const coordinates = decodePolyline(encodedPolyline);
  const bounds =
    parseViewport((primaryRoute as { viewport?: unknown }).viewport) ??
    computeBounds(coordinates);

  return {
    distanceMeters,
    durationSeconds,
    coordinates,
    bounds,
  };
}

function parseDurationSeconds(value: unknown): number {
  if (typeof value !== 'string') {
    throw new RoutePlanningError('Google Maps response is missing route duration');
  }

  const match = /^(-?\d+(?:\.\d+)?)s$/.exec(value.trim());
  if (!match) {
    throw new RoutePlanningError('Google Maps returned an invalid route duration');
  }

  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) {
    throw new RoutePlanningError('Google Maps returned an invalid route duration');
  }

  return parsed;
}

function extractEncodedPolyline(route: object): string {
  const polyline = (route as { polyline?: unknown }).polyline;
  if (!polyline || typeof polyline !== 'object') {
    throw new RoutePlanningError('Google Maps response is missing route polyline');
  }

  const encodedPolyline = (polyline as { encodedPolyline?: unknown }).encodedPolyline;
  if (typeof encodedPolyline !== 'string' || encodedPolyline.length === 0) {
    throw new RoutePlanningError('Google Maps returned an invalid route polyline');
  }

  return encodedPolyline;
}

function parseViewport(value: unknown): RouteBounds | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const low = parseGoogleLatLng((value as { low?: unknown }).low);
  const high = parseGoogleLatLng((value as { high?: unknown }).high);
  if (!low || !high) {
    return null;
  }

  return {
    southWest: low,
    northEast: high,
  };
}

function parseGoogleLatLng(value: unknown): RouteWaypoint | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const latitude = (value as { latitude?: unknown }).latitude;
  const longitude = (value as { longitude?: unknown }).longitude;
  if (
    typeof latitude !== 'number' ||
    !Number.isFinite(latitude) ||
    typeof longitude !== 'number' ||
    !Number.isFinite(longitude)
  ) {
    return null;
  }

  return {
    lat: latitude,
    lng: longitude,
  };
}

function computeBounds(coordinates: RouteWaypoint[]): RouteBounds {
  let minLat = coordinates[0]?.lat ?? 0;
  let maxLat = minLat;
  let minLng = coordinates[0]?.lng ?? 0;
  let maxLng = minLng;

  coordinates.forEach((coordinate) => {
    minLat = Math.min(minLat, coordinate.lat);
    maxLat = Math.max(maxLat, coordinate.lat);
    minLng = Math.min(minLng, coordinate.lng);
    maxLng = Math.max(maxLng, coordinate.lng);
  });

  return {
    southWest: {
      lat: minLat,
      lng: minLng,
    },
    northEast: {
      lat: maxLat,
      lng: maxLng,
    },
  };
}

function decodePolyline(encoded: string): RouteWaypoint[] {
  const coordinates: RouteWaypoint[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    const latitudeDelta = decodePolylineValue(encoded, index);
    lat += latitudeDelta.value;
    index = latitudeDelta.nextIndex;

    const longitudeDelta = decodePolylineValue(encoded, index);
    lng += longitudeDelta.value;
    index = longitudeDelta.nextIndex;

    coordinates.push({
      lat: lat / 1e5,
      lng: lng / 1e5,
    });
  }

  if (coordinates.length < 2) {
    throw new RoutePlanningError('Google Maps returned too few polyline coordinates');
  }

  return coordinates;
}

function decodePolylineValue(
  encoded: string,
  startIndex: number,
): { value: number; nextIndex: number } {
  let result = 0;
  let shift = 0;
  let index = startIndex;

  while (index < encoded.length) {
    const byte = encoded.charCodeAt(index) - 63;
    index += 1;
    result |= (byte & 0x1f) << shift;
    shift += 5;

    if (byte < 0x20) {
      const value = result & 1 ? ~(result >> 1) : result >> 1;
      return { value, nextIndex: index };
    }
  }

  throw new RoutePlanningError('Google Maps returned an invalid encoded polyline');
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function safeSerializeErrorPayload(payload: unknown): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return '';
  }
}
