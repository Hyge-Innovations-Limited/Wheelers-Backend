export interface GeocodeResult {
  lat: number;
  lng: number;
  /** What we show the rider. For a named place it leads with the name. */
  formattedAddress: string;
  /** ISO 3166-1 alpha-2, when Google reported one. */
  countryCode?: string;
  /** The place's own name ("Caleb University College of Law"), when it has one. */
  name?: string;
  /** Straight-line km from the other end of the trip, when that is known. */
  distanceKm?: number;
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
  `Wheelers runs in ${SERVICE_COUNTRY_NAME} only for now`;

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
export interface GeocodeOptions {
  /**
   * What the rider actually typed. When the address came from the language
   * model, this is how we tell the rider's words from the model's guesses.
   */
  spokenText?: string;
  /**
   * Where the other end of the trip is. A rider who gave a pickup in Akoka and
   * then types "7 Osaro Isokpan" means the one in Lagos — without this, Google
   * answered with Isokpan Street in Benin City, 311 km away, and the bot quoted
   * ₦97,100 for it. A lean, never a filter: a rider really going to Benin still can.
   */
  near?: GeoPoint;
}

export interface GeoPoint { lat: number; lng: number }

/** Within this, two matches are the same place for a driver's purposes. */
export const SAME_PLACE_KM = 0.4;

/** Beyond this, two points are in different cities, not different streets. */
export const SAME_CITY_KM = 100;
/** Half-width of the box we ask Google to favour around `near` (~55 km). */
const NEAR_BOX_DEGREES = 0.5;
const NEAR_PLACES_RADIUS_M = 50_000;

export function kmBetween(a: GeoPoint, b: GeoPoint): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function boundsAround(near: GeoPoint): string {
  const d = NEAR_BOX_DEGREES;
  return `${near.lat - d},${near.lng - d}|${near.lat + d},${near.lng + d}`;
}

export async function geocodeAddress(
  apiKey: string,
  address: string,
  options: GeocodeOptions = {},
): Promise<GeocodeResult | null> {
  const direct = await geocodeAsWritten(apiKey, address, options.near);
  if (direct) return preferNearby(apiKey, address, direct, options.near);

  // The address as written found nothing. Two recoveries, in order:
  //   1. Drop geography the rider never said. The model once turned "Caleb
  //      University" into "Caleb University, Nasarawa State, Nigeria" — a
  //      state it invented — and Google answered with Nasarawa State itself.
  //   2. Ask Places. The address geocoder is built for streets; named places
  //      (universities, malls, gates, bus stops) are what Places is for.
  for (const simpler of simplerQueries(address, options.spokenText)) {
    const viaPlaces = await findPlace(apiKey, simpler);
    const found = viaPlaces ?? (await geocodeAsWritten(apiKey, simpler));
    if (found) {
      console.info('[geocoding] recovered with a simpler query', {
        asked: address,
        resolvedWith: simpler,
        via: viaPlaces ? 'places' : 'geocoder',
        resolvedTo: found.formattedAddress,
      });
      return found;
    }
  }

  const viaPlaces = await findPlace(apiKey, address);
  if (viaPlaces) {
    console.info('[geocoding] resolved by place search', { address, resolvedTo: viaPlaces.formattedAddress });
  }
  return viaPlaces;
}

/** A match in another city gets one second opinion from Places, around `near`. */
async function preferNearby(
  apiKey: string,
  address: string,
  found: GeocodeResult,
  near?: GeoPoint,
): Promise<GeocodeResult> {
  if (!near || kmBetween(near, found) <= SAME_CITY_KM) return found;
  const nearby = await findPlace(apiKey, address, near);
  if (nearby && kmBetween(near, nearby) <= SAME_CITY_KM) {
    console.info('[geocoding] preferred a match near the other end of the trip', {
      address,
      insteadOf: found.formattedAddress,
      resolvedTo: nearby.formattedAddress,
    });
    return nearby;
  }
  return found;
}

async function geocodeAsWritten(apiKey: string, address: string, near?: GeoPoint): Promise<GeocodeResult | null> {
  const biased = await geocodeOnce(apiKey, address, {
    ...(GEOCODE_REGION ? { region: GEOCODE_REGION } : {}),
    ...(near ? { bounds: boundsAround(near) } : {}),
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

const ADMINISTRATIVE_PART = /\b(state|nigeria|fct|federal capital territory)\b/i;

/**
 * Shorter versions of a comma-separated address, most specific first.
 *
 * With the rider's own text: every trailing part they did not say is treated
 * as the model's guess and dropped ("Covenant University, Lagos" when the
 * rider only typed "covenant university"). A part they DID say is kept — a
 * rider who typed "Shoprite Ibadan" must never be quietly sent to Lagos.
 *
 * Without it: only purely administrative tails ("… State", "Nigeria") are
 * dropped, since those carry no information a rider would miss.
 */
export function simplerQueries(address: string, spokenText?: string): string[] {
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return [];
  const [head, ...tail] = parts;

  const spoken = spokenText?.toLowerCase();
  const saidByRider = (part: string) =>
    part
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3 && !/^(state|nigeria)$/.test(word))
      .some((word) => spoken!.includes(word));

  const kept = spoken
    ? tail.filter((part) => !ADMINISTRATIVE_PART.test(part) && saidByRider(part))
    : tail.filter((part) => !ADMINISTRATIVE_PART.test(part));
  if (kept.length === tail.length) return []; // nothing to drop

  const core = [head, ...kept].join(', ');
  const normalizedOriginal = parts.join(', ').toLowerCase();
  return [`${core}, ${SERVICE_COUNTRY_NAME}`, core].filter(
    (query, index, all) => query.toLowerCase() !== normalizedOriginal && all.indexOf(query) === index,
  );
}

// Roughly Nigeria — a bias, not a filter; the service-area check still runs.
const NIGERIA_RECTANGLE = {
  low: { latitude: 4.0, longitude: 2.6 },
  high: { latitude: 14.0, longitude: 14.8 },
};
const PLACES_SEARCH_URL = (process.env['GOOGLE_PLACES_SEARCH_URL'] ?? 'https://places.googleapis.com/v1/places:searchText').trim();
const PLACES_FIELDS = 'places.displayName,places.formattedAddress,places.shortFormattedAddress,places.location,places.types,places.addressComponents';
let placesDisabled = false;

interface PlacesSearchResponse {
  places?: Array<{
    displayName?: { text?: string };
    formattedAddress?: string;
    shortFormattedAddress?: string;
    location?: { latitude?: number; longitude?: number };
    types?: string[];
    addressComponents?: Array<{ shortText?: string; types?: string[] }>;
  }>;
  error?: { status?: string; message?: string };
}

/** "J94G+2QW, Ketu, Lagos" → "Ketu, Lagos". A plus code is a map reference, not something a rider recognises. */
export function stripPlusCode(address: string): string {
  return address
    .replace(/(^|,\s*|\s)[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}(?=\s*,|\s|$)\s*,?/gi, '$1')
    .replace(/\b([A-Za-z]{3,})(\s+\1\b)+/gi, '$1')
    .replace(/\s*,\s*,+/g, ',')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .replace(/\s{2,}/g, ' ');
}

/** "Caleb University College of Law, Magodo, Lagos" — the name first, so the rider sees we understood. */
function placeLabel(name: string | undefined, address: string): string {
  // "Nigeria" says nothing to a rider in Nigeria — wherever Google put it.
  const clean = stripPlusCode(address).split(',').map((part) => part.trim()).filter((part) => part && !/^nigeria$/i.test(part)).join(', ');
  if (!name) return clean || address;
  return clean.toLowerCase().includes(name.toLowerCase()) ? clean : [name, clean].filter(Boolean).join(', ');
}

function meaningfulWords(query: string): string[] {
  return query.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3 && !GENERIC_QUERY_WORDS.has(word));
}

// A few hours of memory: the same famous places are asked for again and again,
// and every search is billed.
const PLACES_CACHE_TTL_MS = 6 * 60 * 60_000;
const PLACES_CACHE_MAX = 500;
const placesCache = new Map<string, { at: number; results: GeocodeResult[] }>();

/**
 * Named places matching some words, the way a ride app's search box lists them:
 * "Caleb University" → the main campus, the College of Law, Admissions, the
 * staff residence. The address geocoder cannot do this — it answers a named
 * place with ONE result, often mislabelled ("Ikorodu, Ibadan-Ijebu Ode Rd" for
 * Caleb University), which is why the bot used to guess instead of asking.
 *
 * Google Places API (New). Returns [] when the API is not enabled for the key,
 * and says so once — everything then falls back to the address geocoder.
 */
export async function textSearchPlaces(
  apiKey: string,
  query: string,
  near?: GeoPoint,
  limit = 5,
  /** Skip the "every typed word must appear" filter — for descriptive queries like "bus stops in Ikorodu". */
  anyMatch = false,
): Promise<GeocodeResult[]> {
  const text = query.trim();
  if (placesDisabled || !text || !apiKey) return [];

  const cacheKey = `text|${anyMatch}|${text.toLowerCase()}|${near ? `${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : ''}|${limit}`;
  const cached = placesCache.get(cacheKey);
  if (cached && Date.now() - cached.at < PLACES_CACHE_TTL_MS) return cached.results;

  try {
    const response = await fetch(PLACES_SEARCH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey, 'x-goog-fieldmask': PLACES_FIELDS },
      body: JSON.stringify({
        textQuery: text,
        regionCode: SERVICE_COUNTRY || 'NG',
        maxResultCount: Math.min(20, limit * 3),
        locationBias: near
          ? { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: NEAR_PLACES_RADIUS_M } }
          : { rectangle: NIGERIA_RECTANGLE },
      }),
    });
    const data = (await response.json().catch(() => null)) as PlacesSearchResponse | null;

    if (response.status === 403 || data?.error?.status === 'PERMISSION_DENIED') {
      // The key's project does not have Places API (New) switched on. Say so
      // once, then stop paying a round-trip on every lookup.
      placesDisabled = true;
      console.error('[geocoding] Places API (New) is not enabled for GOOGLE_MAPS_API_KEY — riders will not be offered a list of matching places, and named places will be found less often. Enable "Places API (New)" in Google Cloud for this key\'s project.', {
        message: data?.error?.message?.slice(0, 300),
      });
      return [];
    }
    if (!response.ok) return [];

    const words = meaningfulWords(text);
    const results: GeocodeResult[] = [];
    for (const place of data?.places ?? []) {
      const lat = place.location?.latitude;
      const lng = place.location?.longitude;
      if (lat == null || lng == null) continue;
      if (place.types?.some((type) => TOO_COARSE_TYPES.has(type))) continue;

      const name = place.displayName?.text?.trim() || undefined;
      const address = place.formattedAddress ?? place.shortFormattedAddress ?? '';
      // Google's own country code decides. Checking for the word "Nigeria" at
      // the end of the address threw away 16 of 20 real Ikorodu bus stops —
      // most Nigerian addresses end "…, Lagos".
      const country = place.addressComponents?.find((part) => part.types?.includes('country'))?.shortText?.toUpperCase();
      const inNigeria = isWithinServiceBounds(lat, lng) && (!SERVICE_COUNTRY || !country || country === SERVICE_COUNTRY);
      if (!inNigeria) {
        rememberOutsideMatch(text, placeLabel(name, address));
        continue;
      }
      results.push({ lat, lng, name, formattedAddress: placeLabel(name, place.shortFormattedAddress ?? address), countryCode: SERVICE_COUNTRY || undefined });
    }

    // Every word the rider typed should be somewhere in the match ("caleb law"
    // → "Caleb University College of Law"). If that leaves nothing, settle for
    // any shared word rather than an empty list.
    const haystack = (r: GeocodeResult) => `${r.name ?? ''} ${r.formattedAddress}`.toLowerCase();
    const strict = results.filter((r) => words.length > 0 && words.every((word) => haystack(r).includes(word)));
    const related = anyMatch ? results : strict.length > 0 ? strict : results.filter((r) => words.some((word) => haystack(r).includes(word)));

    // The same place listed twice (or two doors of one building) is one option.
    const distinct: GeocodeResult[] = [];
    for (const candidate of related) {
      const twin = distinct.some((kept) =>
        kmBetween(kept, candidate) < 0.12 || (kept.name && candidate.name && kept.name.toLowerCase() === candidate.name.toLowerCase() && kmBetween(kept, candidate) < 3));
      if (!twin) distinct.push(candidate);
      if (distinct.length >= limit) break;
    }

    if (placesCache.size >= PLACES_CACHE_MAX) placesCache.clear();
    placesCache.set(cacheKey, { at: Date.now(), results: distinct });
    return distinct;
  } catch (error) {
    console.warn('[geocoding] place search failed', { query: text, error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

const PLACES_AUTOCOMPLETE_URL = (process.env['GOOGLE_PLACES_AUTOCOMPLETE_URL'] ?? 'https://places.googleapis.com/v1/places:autocomplete').trim();
const PLACE_DETAILS_URL = (process.env['GOOGLE_PLACE_DETAILS_URL'] ?? 'https://places.googleapis.com/v1/places').replace(/\/+$/, '');

// A whole town or state is not somewhere a driver can stop.
const NOT_A_STOP = new Set([
  'locality', 'political', 'country', 'postal_code', 'postal_town',
  'administrative_area_level_1', 'administrative_area_level_2', 'administrative_area_level_3',
  'sublocality', 'sublocality_level_1', 'neighborhood',
]);

interface AutocompleteResponse {
  suggestions?: Array<{
    placePrediction?: {
      placeId?: string;
      structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
      types?: string[];
    };
  }>;
  error?: { status?: string; message?: string };
}

const locationCache = new Map<string, GeoPoint>();

/** Where a place id is. Location only — the cheapest details lookup there is. */
async function placeLocation(apiKey: string, placeId: string): Promise<GeoPoint | null> {
  const cached = locationCache.get(placeId);
  if (cached) return cached;
  try {
    const response = await fetch(`${PLACE_DETAILS_URL}/${encodeURIComponent(placeId)}`, {
      headers: { 'x-goog-api-key': apiKey, 'x-goog-fieldmask': 'location' },
    });
    if (!response.ok) return null;
    const data = (await response.json().catch(() => null)) as { location?: { latitude?: number; longitude?: number } } | null;
    const lat = data?.location?.latitude;
    const lng = data?.location?.longitude;
    if (lat == null || lng == null) return null;
    if (locationCache.size >= PLACES_CACHE_MAX * 4) locationCache.clear();
    locationCache.set(placeId, { lat, lng });
    return { lat, lng };
  } catch {
    return null;
  }
}

/**
 * Places matching what the rider typed, the way a ride app's search box lists
 * them as you type. Measured live: "Caleb University" → the main campus, the
 * College of Law, Admissions, the staff residence, a faculty building.
 * A whole-name text search returns only the first of those — which is why it
 * is autocomplete, not text search, that sits behind the picker.
 *
 * Google Places API (New): one autocomplete call, then a location-only lookup
 * for each suggestion (so options can be measured, filtered and de-duplicated).
 */
export async function searchPlaces(apiKey: string, query: string, near?: GeoPoint, limit = 5): Promise<GeocodeResult[]> {
  const text = query.trim();
  if (placesDisabled || !text || !apiKey) return [];

  const cacheKey = `auto|${text.toLowerCase()}|${near ? `${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : ''}|${limit}`;
  const cached = placesCache.get(cacheKey);
  if (cached && Date.now() - cached.at < PLACES_CACHE_TTL_MS) return cached.results;

  try {
    const centre = near ? { latitude: near.lat, longitude: near.lng } : undefined;
    const response = await fetch(PLACES_AUTOCOMPLETE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        input: text,
        includedRegionCodes: [(SERVICE_COUNTRY || 'NG').toLowerCase()],
        ...(centre ? { origin: centre, locationBias: { circle: { center: centre, radius: NEAR_PLACES_RADIUS_M } } } : { locationBias: { rectangle: NIGERIA_RECTANGLE } }),
      }),
    });
    const data = (await response.json().catch(() => null)) as AutocompleteResponse | null;

    if (response.status === 403 || data?.error?.status === 'PERMISSION_DENIED') {
      placesDisabled = true;
      console.error('[geocoding] Places API (New) is not enabled for GOOGLE_MAPS_API_KEY — riders will not be offered a list of matching places, and named places will be found less often. Enable "Places API (New)" in Google Cloud for this key\'s project.', {
        message: data?.error?.message?.slice(0, 300),
      });
      return [];
    }
    if (!response.ok) return [];

    const suggestions = (data?.suggestions ?? [])
      .map((entry) => entry.placePrediction)
      .filter((prediction): prediction is NonNullable<typeof prediction> => Boolean(prediction?.placeId && prediction.structuredFormat?.mainText?.text))
      .filter((prediction) => !(prediction.types ?? []).some((type) => NOT_A_STOP.has(type)))
      .slice(0, limit + 2);

    const located = await Promise.all(suggestions.map(async (prediction) => {
      const point = await placeLocation(apiKey, prediction.placeId!);
      if (!point || !isWithinServiceBounds(point.lat, point.lng)) return null;
      const name = prediction.structuredFormat!.mainText!.text!.trim();
      const where = (prediction.structuredFormat?.secondaryText?.text ?? '').trim();
      const result: GeocodeResult = { ...point, name, formattedAddress: placeLabel(name, where), countryCode: SERVICE_COUNTRY || undefined };
      // A suggestion that shares no word with what was typed is a guess, not a
      // match — "University gate" once came back as a road called "Street U".
      if (!partialMatchLooksRelated(text, result.formattedAddress)) {
        console.warn('[geocoding] ignoring suggestion — unrelated to query', { query: text, suggestion: result.formattedAddress });
        return null;
      }
      return result;
    }));

    const distinct: GeocodeResult[] = [];
    for (const candidate of located) {
      if (!candidate) continue;
      // Google often lists one place twice ("Ikorodu garage market" on the road
      // and again in the town). Same spot, or same name within a kilometre: one option.
      const twin = distinct.some((kept) =>
        kmBetween(kept, candidate) < 0.05 ||
        ((kept.name ?? '').toLowerCase() === (candidate.name ?? '').toLowerCase() && kmBetween(kept, candidate) < 1));
      if (twin) continue;
      distinct.push(candidate);
      if (distinct.length >= limit) break;
    }

    // Autocomplete found nothing usable: a whole-name search still might.
    const results = distinct.length > 0 ? distinct : await textSearchPlaces(apiKey, text, near, limit);
    if (placesCache.size >= PLACES_CACHE_MAX) placesCache.clear();
    placesCache.set(cacheKey, { at: Date.now(), results });
    return results;
  } catch (error) {
    console.warn('[geocoding] place autocomplete failed', { query: text, error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

/**
 * Well-known spots inside an area, for a rider who said only "Ikorodu". Bus
 * stops and landmarks are how Lagos riders name a pickup; measured live this
 * returns Agric Bus Terminal, Benson Bus Stop, Aruna, Ajose, Adamo…
 */
export async function findAreaSpots(apiKey: string, area: string, near?: GeoPoint, limit = 8): Promise<GeocodeResult[]> {
  const raw = await textSearchPlaces(apiKey, `bus stops and landmarks in ${area.trim()}`, near, 20, true);

  // "…in Ikorodu" also returns Ojota and Oshodi (they sit on Ikorodu ROAD).
  // Keep what clusters around the middle of the results.
  const middle = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
  const centre = { lat: middle(raw.map((spot) => spot.lat)), lng: middle(raw.map((spot) => spot.lng)) };
  const spots = raw.filter((spot) => kmBetween(centre, spot) <= 12).slice(0, limit);

  return spots.map((spot) => ({
    ...spot,
    ...(near ? { distanceKm: Math.round(kmBetween(near, spot) * 10) / 10 } : {}),
  }));
}

/** The single best named place for some words, or null. */
export async function findPlace(apiKey: string, query: string, near?: GeoPoint): Promise<GeocodeResult | null> {
  const [best] = await searchPlaces(apiKey, query, near, 1);
  return best ?? null;
}

function normalisePlaceName(text: string): string {
  return text.toLowerCase().split(',')[0]!.replace(/[^a-z0-9]+/g, ' ').trim();
}

const ADDRESS_LIKE = /^\s*(?:no\.?\s*)?\d+[a-z]?\b|\b(street|str|road|rd|avenue|ave|close|crescent|lane|drive|estate|way)\b/i;

/**
 * Everything a rider might mean by what they typed — the list behind the
 * "which one did you mean?" picker.
 *
 *   a named place ("caleb university", "ikorodu garage", "shoprite") → Places
 *     first: it knows names and branches; the geocoder is the fallback.
 *   a street address ("no 7 osaro isokpan", "15 Aiyetoro Street") → the address
 *     geocoder first: it knows house numbers; Places is the fallback.
 *
 * One option means "just use it". Several means "ask". With `near`, options in
 * the same city as the other end of the trip push out far-away ones.
 */
export async function findPlaceOptions(
  apiKey: string,
  query: string,
  options: Pick<GeocodeOptions, 'near' | 'spokenText'> & { limit?: number } = {},
): Promise<GeocodeResult[]> {
  const limit = options.limit ?? 5;
  const near = options.near;
  // The rider's own words first; the model's tidied-up version second.
  const queries = [...simplerQueries(query, options.spokenText).reverse(), query].filter((q, i, all) => q.trim() && all.indexOf(q) === i);

  let found: GeocodeResult[] = [];
  for (const q of queries) {
    const viaPlaces = () => searchPlaces(apiKey, q, near, limit);
    const viaGeocoder = () => geocodeAddressCandidates(apiKey, q, Math.min(limit, 3), { near });
    found = ADDRESS_LIKE.test(q) ? await viaGeocoder() : await viaPlaces();
    if (found.length === 0) found = ADDRESS_LIKE.test(q) ? await viaPlaces() : await viaGeocoder();
    if (found.length > 0) break;
  }

  found = found.map((option) => ({ ...option, formattedAddress: stripPlusCode(option.formattedAddress) || option.formattedAddress }));
  if (near) {
    found = found.map((option) => ({ ...option, distanceKm: Math.round(kmBetween(near, option) * 10) / 10 }));
    const sameCity = found.filter((option) => (option.distanceKm ?? 0) <= SAME_CITY_KM);
    if (sameCity.length > 0) found = sameCity;
  }

  // "Ikeja City Mall" also matches its paid parking and the shops inside it.
  // When the rider typed a place's exact name, the only REAL alternatives are
  // other places carrying that whole name somewhere else ("Caleb University
  // College of Law", another "Shoprite") — not doors of the same building and
  // not things that merely share a word ("City mall").
  const said = normalisePlaceName((options.spokenText && simplerQueries(query, options.spokenText).pop()) || query);
  const exact = found.find((option) => normalisePlaceName(option.name ?? '') === said);
  if (exact) {
    const alternatives = found.filter((option) =>
      option !== exact &&
      normalisePlaceName(option.name ?? option.formattedAddress).includes(said) &&
      kmBetween(exact, option) > SAME_PLACE_KM);
    found = [exact, ...alternatives];
  }

  // Several matches a short walk apart are one destination.
  const [first, ...others] = found;
  if (first && others.length > 0 && others.every((option) => kmBetween(first, option) <= SAME_PLACE_KM)) return [first];

  return found.slice(0, limit);
}

/** Test hook: forget that Places was ever refused. */
export function resetPlacesAvailability(): void {
  placesDisabled = false;
  placesCache.clear();
  locationCache.clear();
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
  options: Pick<GeocodeOptions, 'near'> = {},
): Promise<GeocodeResult[]> {
  const found = await geocodeCandidatesAnywhere(apiKey, address, limit, options.near);
  const near = options.near;
  if (!near || found.length === 0) return found;

  // Same-city matches first. Google's own order is kept within each group.
  const close = found.filter((c) => kmBetween(near, c) <= SAME_CITY_KM);
  if (close.length > 0) return close;

  // Every match is in another city. Before believing that, ask Places for the
  // same words around the pickup — street geocoding favours the best-known
  // street of that name nationally, Places favours what is nearby.
  const nearby = await findPlace(apiKey, address, near);
  if (nearby && kmBetween(near, nearby) <= SAME_CITY_KM) {
    console.info('[geocoding] preferred a match near the other end of the trip', {
      address,
      insteadOf: found[0]?.formattedAddress,
      resolvedTo: nearby.formattedAddress,
    });
    return [nearby];
  }
  return found;
}

async function geocodeCandidatesAnywhere(
  apiKey: string,
  address: string,
  limit: number,
  near?: GeoPoint,
): Promise<GeocodeResult[]> {
  const biased = await geocodeManyOnce(apiKey, address, {
    ...(GEOCODE_REGION ? { region: GEOCODE_REGION } : {}),
    ...(near ? { bounds: boundsAround(near) } : {}),
  }, limit);
  if (biased.length > 0) return biased;

  if (GEOCODE_FALLBACK_COUNTRY) {
    const restricted = await geocodeManyOnce(apiKey, address, {
      components: `country:${GEOCODE_FALLBACK_COUNTRY}`,
    }, limit);
    if (restricted.length > 0) return restricted;
  }

  // A named place the address geocoder does not know (a school, a plaza, a
  // church) — one confident answer from Places beats "could not find".
  const place = await findPlace(apiKey, address);
  return place ? [place] : [];
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
