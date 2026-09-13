interface GeocodeResult {
  lat: number;
  lng: number;
  formattedAddress: string;
  /** ISO 3166-1 alpha-2, when Google reported one. */
  countryCode?: string;
}

interface GoogleGeocodingResult {
  geometry?: {
    location?: {
      lat?: number;
      lng?: number;
    };
  };
  formatted_address?: string;
  types?: string[];
  partial_match?: boolean;
  address_components?: Array<{
    short_name?: string;
    long_name?: string;
    types?: string[];
  }>;
}

interface GoogleGeocodingResponse {
  status: string;
  results?: GoogleGeocodingResult[];
}

/* ───────────────────────── service area ───────────────────────── */

/**
 * Wheelers runs in one country. Anything Google resolves elsewhere — "Eiffel
 * Tower", "Pier 39", a pin dropped in Accra — is refused before it can become
 * a pickup or drop-off. Set GEOCODE_SERVICE_COUNTRY='' to lift the fence.
 */
const SERVICE_COUNTRY = (process.env['GEOCODE_SERVICE_COUNTRY'] ?? 'NG').trim().toUpperCase();
const SERVICE_COUNTRY_NAME = 'Nigeria';

/** Nigeria's bounding box — a cheap first check for raw coordinates. */
const NIGERIA_BOUNDS = { minLat: 4.0, maxLat: 14.0, minLng: 2.6, maxLng: 14.8 };

export function isWithinServiceBounds(lat: number, lng: number): boolean {
  if (!SERVICE_COUNTRY) return true;
  if (SERVICE_COUNTRY !== 'NG') return true; // only Nigeria has a box on file
  return lat >= NIGERIA_BOUNDS.minLat && lat <= NIGERIA_BOUNDS.maxLat
    && lng >= NIGERIA_BOUNDS.minLng && lng <= NIGERIA_BOUNDS.maxLng;
}

function countryOf(result: GoogleGeocodingResult): string | undefined {
  const component = result.address_components?.find((c) => c.types?.includes('country'));
  return component?.short_name?.toUpperCase();
}

function isOutsideServiceArea(result: GoogleGeocodingResult): boolean {
  if (!SERVICE_COUNTRY) return false;
  const country = countryOf(result);
  if (country) return country !== SERVICE_COUNTRY;
  const location = result.geometry?.location;
  if (location?.lat != null && location?.lng != null) {
    return !isWithinServiceBounds(location.lat, location.lng);
  }
  return false;
}

/**
 * Queries Google matched somewhere outside the service area, kept briefly so
 * the reply can say "that's outside Nigeria" instead of "could not find".
 */
const OUTSIDE_MATCH_TTL_MS = 10 * 60_000;
const recentOutsideMatches = new Map<string, { resolvedTo: string; at: number }>();

function rememberOutsideMatch(query: string, resolvedTo: string): void {
  if (recentOutsideMatches.size > 500) recentOutsideMatches.clear();
  recentOutsideMatches.set(query.trim().toLowerCase(), { resolvedTo, at: Date.now() });
}

/** Where a failed query actually landed, if it was refused for being abroad. */
export function outsideServiceAreaMatch(query: string): string | null {
  const hit = recentOutsideMatches.get(query.trim().toLowerCase());
  if (!hit) return null;
  if (Date.now() - hit.at > OUTSIDE_MATCH_TTL_MS) {
    recentOutsideMatches.delete(query.trim().toLowerCase());
    return null;
  }
  return hit.resolvedTo;
}

export const OUTSIDE_SERVICE_AREA_LINE =
  `Wheelers runs in ${SERVICE_COUNTRY_NAME} only for now 🇳🇬`;

/**
 * The first line of a "we could not use that address" reply. Says why: a
 * place that exists but is abroad gets the geofence message, not a shrug.
 */
export function geocodeMissLine(query: string): string {
  const abroad = outsideServiceAreaMatch(query);
  if (abroad) {
    return `"${query}" is outside ${SERVICE_COUNTRY_NAME} (${abroad}). ${OUTSIDE_SERVICE_AREA_LINE}`;
  }
  return `Could not find "${query}" on the map.`;
}

/**
 * Result types too coarse to be a pickup or drop-off. Under a country
 * restriction Google will happily answer unrecognised text with the country
 * itself — "asdkjhasd nonsense" resolves to "Nigeria" — which would otherwise
 * be accepted as a real address and send a driver to the country centroid.
 */
const TOO_COARSE_TYPES = new Set([
  'country',
  'administrative_area_level_1',
  'administrative_area_level_2',
]);

/**
 * Google marks a result `partial_match` when it could not match the whole
 * query and guessed. Some guesses are fine ("Shoprite Ikeja" → "Shoprite,
 * Ikeja Roundabout") but some are garbage — "University gate" resolved to
 * "Street U, Eti-Osa, Lekki", 50 km from anywhere the rider meant, purely
 * because the street is named "U". The garbage guesses share no words with
 * the query, so a partial match is accepted only when at least one meaningful
 * query word appears in the returned address.
 */
const GENERIC_QUERY_WORDS = new Set([
  'the', 'and', 'near', 'beside', 'opposite', 'behind',
  'street', 'road', 'avenue', 'close', 'crescent', 'way',
  'lagos', 'nigeria', 'state',
]);

function partialMatchLooksRelated(query: string, formattedAddress: string): boolean {
  const address = formattedAddress.toLowerCase();
  const meaningfulWords = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !GENERIC_QUERY_WORDS.has(word));
  if (meaningfulWords.length === 0) return false;
  return meaningfulWords.some((word) => address.includes(word));
}

export async function reverseGeocode(
  apiKey: string,
  lat: number,
  lng: number,
): Promise<GeocodeResult | null> {
  const params = new URLSearchParams({
    latlng: `${lat},${lng}`,
    key: apiKey,
  });

  const url = `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`;

  try {
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = (await response.json()) as GoogleGeocodingResponse;
    if (data.status !== 'OK' || !data.results?.length) return null;

    const result = data.results[0];
    return {
      lat,
      lng,
      formattedAddress: result.formatted_address ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
      countryCode: countryOf(result),
    };
  } catch {
    return null;
  }
}

/**
 * Is a dropped pin somewhere we operate? Bounding box first (free), then the
 * reverse-geocoded country when Google answered. A pin we cannot place at all
 * is allowed through — the box already excludes the obvious cases.
 */
export function isPinInsideServiceArea(
  lat: number,
  lng: number,
  reverse: GeocodeResult | null,
): boolean {
  if (!SERVICE_COUNTRY) return true;
  if (!isWithinServiceBounds(lat, lng)) return false;
  if (reverse?.countryCode && reverse.countryCode !== SERVICE_COUNTRY) return false;
  return true;
}

/**
 * Home region, as a Google `region` bias. Set GEOCODE_REGION='' to disable when
 * testing abroad — the reason the bias was removed in the first place.
 */
const GEOCODE_REGION = (process.env['GEOCODE_REGION'] ?? 'ng').trim().toLowerCase();

/**
 * Hard country restriction, used ONLY as a second attempt.
 */
const GEOCODE_FALLBACK_COUNTRY = (process.env['GEOCODE_FALLBACK_COUNTRY'] ?? 'NG')
  .trim()
  .toUpperCase();

/**
 * Two attempts, because neither bias is right on its own. Measured against the
 * live API:
 *
 *   query              no bias        components=country:NG     region=ng
 *   "Allen"            ZERO_RESULTS   Allen area                ZERO_RESULTS
 *   "Allen roundabout" Allen Rndbt    Allen area (worse)        Allen Rndbt
 *   "Pier 39"          SF             — (NG only)               SF
 *
 * `region` biases ranking without excluding anything, so precise local
 * landmarks and international addresses both survive. `components=country`
 * filters, which rescues a bare neighbourhood name like "Allen" but flattens a
 * precise match to the broad area and blocks anywhere outside the country.
 * So: bias first, and only fall back to the restriction when that finds
 * nothing at all.
 */
export async function geocodeAddress(
  apiKey: string,
  address: string,
): Promise<GeocodeResult | null> {
  const biased = await geocodeOnce(apiKey, address, {
    ...(GEOCODE_REGION ? { region: GEOCODE_REGION } : {}),
  });
  if (biased) return biased;

  if (!GEOCODE_FALLBACK_COUNTRY) return null;

  const restricted = await geocodeOnce(apiKey, address, {
    components: `country:${GEOCODE_FALLBACK_COUNTRY}`,
  });
  if (restricted) {
    console.info('[geocoding] resolved only under country restriction', {
      address,
      country: GEOCODE_FALLBACK_COUNTRY,
      resolvedTo: restricted.formattedAddress,
    });
  }
  return restricted;
}

/**
 * All plausible matches for an ambiguous place name. "Aiyetoro Street" exists
 * in both Surulere and Akoka — assuming one silently books a ride to the
 * wrong district. Callers show ≥2 candidates as a numbered choice; a query
 * that already pins the area ("15 Aiyetoro Street Akoka") returns one.
 */
export async function geocodeAddressCandidates(
  apiKey: string,
  address: string,
  limit = 3,
): Promise<GeocodeResult[]> {
  const biased = await geocodeManyOnce(apiKey, address, {
    ...(GEOCODE_REGION ? { region: GEOCODE_REGION } : {}),
  }, limit);
  if (biased.length > 0) return biased;

  if (!GEOCODE_FALLBACK_COUNTRY) return [];
  return geocodeManyOnce(apiKey, address, {
    components: `country:${GEOCODE_FALLBACK_COUNTRY}`,
  }, limit);
}

async function geocodeManyOnce(
  apiKey: string,
  address: string,
  extra: Record<string, string>,
  limit: number,
): Promise<GeocodeResult[]> {
  const params = new URLSearchParams({ address, key: apiKey, ...extra });
  const url = `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`;

  try {
    const response = await fetch(url);
    if (!response.ok) return [];

    const data = (await response.json()) as GoogleGeocodingResponse;
    if (data.status !== 'OK' || !data.results?.length) return [];

    const seen = new Set<string>();
    const candidates: GeocodeResult[] = [];
    for (const result of data.results) {
      const location = result.geometry?.location;
      if (!location?.lat || !location?.lng) continue;
      if (result.types?.some((type) => TOO_COARSE_TYPES.has(type))) continue;
      if (isOutsideServiceArea(result)) {
        rememberOutsideMatch(address, result.formatted_address ?? address);
        continue;
      }
      if (
        result.partial_match &&
        !partialMatchLooksRelated(address, result.formatted_address ?? '')
      ) continue;
      const formattedAddress = result.formatted_address ?? address;
      if (seen.has(formattedAddress)) continue;
      seen.add(formattedAddress);
      candidates.push({ lat: location.lat, lng: location.lng, formattedAddress, countryCode: countryOf(result) });
      if (candidates.length >= limit) break;
    }
    return candidates;
  } catch {
    return [];
  }
}

async function geocodeOnce(
  apiKey: string,
  address: string,
  extra: Record<string, string>,
): Promise<GeocodeResult | null> {
  const params = new URLSearchParams({
    address,
    key: apiKey,
    ...extra,
  });

  const url = `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.warn('[geocoding] Google API error', { status: response.status });
      return null;
    }

    const data = (await response.json()) as GoogleGeocodingResponse;
    if (data.status !== 'OK' || !data.results?.length) {
      return null;
    }

    const result = data.results[0];
    const location = result.geometry?.location;
    if (!location?.lat || !location?.lng) {
      return null;
    }

    if (result.types?.some((type) => TOO_COARSE_TYPES.has(type))) {
      console.warn('[geocoding] ignoring result — too coarse to route to', {
        address,
        resolvedTo: result.formatted_address,
        types: result.types,
      });
      return null;
    }

    if (
      result.partial_match &&
      !partialMatchLooksRelated(address, result.formatted_address ?? '')
    ) {
      console.warn('[geocoding] ignoring partial match — unrelated to query', {
        address,
        resolvedTo: result.formatted_address,
      });
      return null;
    }

    if (isOutsideServiceArea(result)) {
      console.info('[geocoding] refusing result outside service area', {
        address,
        resolvedTo: result.formatted_address,
        country: countryOf(result) ?? 'unknown',
      });
      rememberOutsideMatch(address, result.formatted_address ?? address);
      return null;
    }

    return {
      lat: location.lat,
      lng: location.lng,
      formattedAddress: result.formatted_address ?? address,
      countryCode: countryOf(result),
    };
  } catch (error) {
    console.warn('[geocoding] Failed', {
      address,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
