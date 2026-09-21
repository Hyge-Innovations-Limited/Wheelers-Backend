#!/usr/bin/env node
// Is Google "Places API (New)" switched on for GOOGLE_MAPS_API_KEY, and what
// does it return? The WhatsApp bot's "which one did you mean?" list depends on
// it; without it the bot can only take the address geocoder's single answer.
//
//   npm run places:check                       # "Caleb University" near Ikorodu
//   npm run places:check -- "shoprite" 6.60,3.35
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
const key = process.env.GOOGLE_MAPS_API_KEY;
if (!key) {
  console.error('GOOGLE_MAPS_API_KEY is not set.');
  process.exit(1);
}

const query = process.argv[2] ?? 'Caleb University';
const [lat, lng] = (process.argv[3] ?? '6.6194,3.5105').split(',').map(Number);

const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-goog-api-key': key,
    'x-goog-fieldmask': 'places.displayName,places.shortFormattedAddress,places.location',
  },
  body: JSON.stringify({
    textQuery: query,
    regionCode: 'NG',
    maxResultCount: 8,
    locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 50000 } },
  }),
});
const data = await response.json().catch(() => ({}));

if (!response.ok) {
  console.error(`✗ Places API (New) refused the request (HTTP ${response.status}).`);
  console.error(`  ${data?.error?.message ?? ''}`.trimEnd());
  if (response.status === 403) {
    console.error('\n  Fix: Google Cloud Console → APIs & Services → Library → "Places API (New)" → Enable,');
    console.error('  on the SAME project as this key. If the key has API restrictions, add Places API (New) to them.');
  }
  process.exit(1);
}

const places = data.places ?? [];
console.log(`✓ Places API (New) is on. "${query}" near ${lat},${lng} → ${places.length} place(s):`);
for (const place of places) {
  console.log(`  • ${place.displayName?.text ?? '(no name)'} — ${place.shortFormattedAddress ?? ''}`);
}
if (places.length === 0) console.log('  (no matches — try another query)');
