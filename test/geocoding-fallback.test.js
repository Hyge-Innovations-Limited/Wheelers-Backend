// When the address as written finds nothing, the lookup must recover instead
// of telling the rider "could not find". Google is stubbed: each test names
// exactly what the geocoder and Places would answer.
//
//   npm -w @wheleers/api-gateway run build && node --test test/geocoding-fallback.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  geocodeAddress, geocodeAddressCandidates, simplerQueries, resetPlacesAvailability,
} = require('../apps/api-gateway/dist/LLM/geocoding.js');

const realFetch = global.fetch;
const realLog = { info: console.info, warn: console.warn, error: console.error };
let calls;

/** geocoder / places: query text → canned Google body. Anything unlisted is a miss. */
function stubGoogle({ geocoder = {}, places = {}, placesDenied = false }) {
  calls = [];
  global.fetch = async (url) => {
    const u = new URL(url);
    const isPlaces = u.pathname.includes('/place/');
    const query = isPlaces ? u.searchParams.get('input') : u.searchParams.get('address');
    calls.push(`${isPlaces ? 'places' : 'geocode'}:${query}`);
    let body;
    if (isPlaces) {
      body = placesDenied
        ? { status: 'REQUEST_DENIED', error_message: 'This API project is not authorized to use this API.' }
        : places[query] ? { status: 'OK', candidates: [places[query]] } : { status: 'ZERO_RESULTS', candidates: [] };
    } else {
      body = geocoder[query] ? { status: 'OK', results: [geocoder[query]] } : { status: 'ZERO_RESULTS', results: [] };
    }
    return { ok: true, json: async () => body };
  };
}

const NASARAWA_STATE = {
  formatted_address: 'Nasarawa, Nigeria', types: ['administrative_area_level_1', 'political'],
  geometry: { location: { lat: 8.5, lng: 8.2 } },
  address_components: [{ short_name: 'NG', types: ['country'] }],
};
const CALEB = {
  name: 'Caleb University', formatted_address: 'Imota, Ikorodu, Lagos, Nigeria',
  types: ['university', 'point_of_interest'], geometry: { location: { lat: 6.6672, lng: 3.6673 } },
};

test.beforeEach(() => { resetPlacesAvailability(); console.info = console.warn = console.error = () => {}; });
test.afterEach(() => { global.fetch = realFetch; Object.assign(console, realLog); });

test('the production failure: a state the model invented no longer loses the place', async () => {
  stubGoogle({
    geocoder: { 'Caleb University, Nasarawa State, Nigeria': NASARAWA_STATE },
    places: { 'Caleb University, Nigeria': CALEB },
  });
  const found = await geocodeAddress('key', 'Caleb University, Nasarawa State, Nigeria', { spokenText: 'take me to caleb university' });
  assert.ok(found, 'must resolve');
  assert.equal(found.lat, 6.6672);
  assert.match(found.formattedAddress, /^Caleb University, Imota/);
});

test('a city the model assumed is dropped when the rider never said it', async () => {
  stubGoogle({ places: { 'Covenant University, Nigeria': { name: 'Covenant University', formatted_address: 'Km 10 Idiroko Rd, Ota, Ogun, Nigeria', types: ['university'], geometry: { location: { lat: 6.6718, lng: 3.1581 } } } } });
  const found = await geocodeAddress('key', 'Covenant University, Lagos', { spokenText: 'going to covenant university' });
  assert.match(found.formattedAddress, /Ota, Ogun/);
});

test('a city the rider DID say is never dropped — no quiet trip to the wrong town', async () => {
  assert.deepEqual(simplerQueries('Shoprite, Ibadan, Oyo State, Nigeria', 'shoprite ibadan abeg'), ['Shoprite, Ibadan, Nigeria', 'Shoprite, Ibadan']);
  stubGoogle({ places: { Shoprite: { name: 'Shoprite', formatted_address: 'Ikeja, Lagos, Nigeria', types: ['store'], geometry: { location: { lat: 6.6, lng: 3.35 } } } } });
  const found = await geocodeAddress('key', 'Shoprite, Ibadan, Oyo State, Nigeria', { spokenText: 'shoprite ibadan abeg' });
  assert.equal(found, null, 'a bare "Shoprite" lookup must never be attempted');
  assert.ok(!calls.includes('places:Shoprite') && !calls.includes('geocode:Shoprite'));
});

test('without the rider\'s text only administrative tails are dropped', () => {
  assert.deepEqual(simplerQueries('Caleb University, Nasarawa State, Nigeria'), ['Caleb University, Nigeria', 'Caleb University']);
  assert.deepEqual(simplerQueries('Shoprite, Ikeja, Lagos'), [], 'real localities are kept');
  assert.deepEqual(simplerQueries('Caleb University'), []);
});

test('an address the geocoder already knows costs no extra calls', async () => {
  stubGoogle({ geocoder: { 'Allen Roundabout, Ikeja, Lagos': { formatted_address: 'Allen Rndbt, Ikeja, Lagos, Nigeria', types: ['intersection'], geometry: { location: { lat: 6.6, lng: 3.35 } }, address_components: [{ short_name: 'NG', types: ['country'] }] } } });
  const found = await geocodeAddress('key', 'Allen Roundabout, Ikeja, Lagos', { spokenText: 'allen roundabout' });
  assert.ok(found);
  assert.deepEqual(calls, ['geocode:Allen Roundabout, Ikeja, Lagos']);
});

test('Places still respects the rules: no whole states, nothing abroad, nothing unrelated', async () => {
  stubGoogle({ places: {
    'Nasarawa': { name: 'Nasarawa', formatted_address: 'Nasarawa, Nigeria', types: ['administrative_area_level_1'], geometry: { location: { lat: 8.5, lng: 8.2 } } },
    'Eiffel Tower': { name: 'Eiffel Tower', formatted_address: 'Av. Gustave Eiffel, 75007 Paris, France', types: ['tourist_attraction'], geometry: { location: { lat: 48.8584, lng: 2.2945 } } },
    'University gate': { name: 'Street U', formatted_address: 'Eti-Osa, Lekki, Lagos, Nigeria', types: ['route'], geometry: { location: { lat: 6.44, lng: 3.5 } } },
  } });
  assert.equal(await geocodeAddress('key', 'Nasarawa'), null);
  assert.equal(await geocodeAddress('key', 'Eiffel Tower'), null);
  assert.equal(await geocodeAddress('key', 'University gate'), null);
});

test('a key without the Places API is noticed once, then left alone', async () => {
  stubGoogle({ placesDenied: true });
  assert.equal(await geocodeAddress('key', 'Caleb University, Nasarawa State, Nigeria', { spokenText: 'caleb university' }), null);
  const placesCallsFirst = calls.filter((c) => c.startsWith('places:')).length;
  assert.equal(placesCallsFirst, 1, 'stops asking after the first refusal');
  await geocodeAddress('key', 'Some Other Place, Kano State, Nigeria', { spokenText: 'some other place' });
  assert.equal(calls.filter((c) => c.startsWith('places:')).length, 1, 'the second lookup must not ask Places again');
});

test('a typed destination the geocoder does not know falls back to one Places answer', async () => {
  stubGoogle({ places: { 'caleb university': CALEB } });
  const candidates = await geocodeAddressCandidates('key', 'caleb university');
  assert.equal(candidates.length, 1);
  assert.match(candidates[0].formattedAddress, /Caleb University/);
});
