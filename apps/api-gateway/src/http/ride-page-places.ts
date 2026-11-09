import { LAGOS_OUTLINE } from '@wheleers/config';

/**
 * The ride page's place search, as the app's (Wheelersapp lib/google-places.ts):
 * Google Places API (New) autocomplete kept inside Lagos, then the picked
 * place's spot by its id. With the rider's session token on both, Google bills
 * the typing and the pick as one session.
 */

/** Lagos State's bounding box, from the service area's outline (the app's LAGOS_BOX). */
export const LAGOS_BOX = LAGOS_OUTLINE.reduce(
  (box, [lat, lng]) => ({
    south: Math.min(box.south, lat), west: Math.min(box.west, lng),
    north: Math.max(box.north, lat), east: Math.max(box.east, lng),
  }),
  { south: 90, west: 180, north: -90, east: -180 },
);

const GOOGLE_TIMEOUT_MS = 8_000;
const MAX_SUGGESTIONS = 8;

export interface PlaceSuggestion {
  placeId: string;
  /** "Ikeja City Mall" */
  name: string;
  /** "Obafemi Awolowo Way, Ikeja, Nigeria" */
  area: string;
  /** The whole line: what is shown once picked, and what drivers read. */
  address: string;
}

export class PlacesError extends Error {}

async function google(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOOGLE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    throw new PlacesError('no answer from Google');
  } finally {
    clearTimeout(timer);
  }
}

/** Only the country is added, as in the app: "Wuse 2, Lagos" stopped resolving when a city was. */
function withCountry(input: string): string {
  return /nigeria/i.test(input) ? input : `${input}, Nigeria`;
}

/** Places matching what was typed, inside Lagos. */
export async function suggestPlaces(apiKey: string, input: string, sessionToken?: string): Promise<PlaceSuggestion[]> {
  const response = await google('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
    body: JSON.stringify({
      input: withCountry(input),
      languageCode: 'en',
      includedRegionCodes: ['ng'],
      locationRestriction: {
        rectangle: {
          low: { latitude: LAGOS_BOX.south, longitude: LAGOS_BOX.west },
          high: { latitude: LAGOS_BOX.north, longitude: LAGOS_BOX.east },
        },
      },
      ...(sessionToken ? { sessionToken } : {}),
    }),
  });
  if (!response.ok) throw new PlacesError(`autocomplete HTTP ${response.status}`);
  const data = (await response.json().catch(() => null)) as {
    suggestions?: Array<{ placePrediction?: { placeId?: string; text?: { text?: string }; structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } } } }>;
  } | null;

  const seen = new Set<string>();
  const out: PlaceSuggestion[] = [];
  for (const suggestion of data?.suggestions ?? []) {
    const p = suggestion.placePrediction;
    const placeId = p?.placeId?.trim();
    const address = p?.text?.text?.trim();
    if (!placeId || !address) continue;
    const [first, ...rest] = address.split(',').map((part) => part.trim());
    const name = p?.structuredFormat?.mainText?.text?.trim() || first || address;
    const area = p?.structuredFormat?.secondaryText?.text?.trim() ?? rest.join(', ');
    const key = `${name.toLowerCase()}|${address.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ placeId, name, area, address });
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}

/** Where a picked place is: the location field only, the cheapest lookup there is. */
export async function placeLocation(apiKey: string, placeId: string, sessionToken?: string): Promise<{ lat: number; lng: number } | null> {
  const query = sessionToken ? `?sessionToken=${encodeURIComponent(sessionToken)}` : '';
  const response = await google(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}${query}`, {
    headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'location' },
  });
  if (response.status === 404 || response.status === 400) return null;
  if (!response.ok) throw new PlacesError(`place HTTP ${response.status}`);
  const data = (await response.json().catch(() => null)) as { location?: { latitude?: number; longitude?: number } } | null;
  const lat = data?.location?.latitude;
  const lng = data?.location?.longitude;
  return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}
