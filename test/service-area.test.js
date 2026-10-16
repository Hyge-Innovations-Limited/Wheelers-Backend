/**
 * Rides are taken in Lagos State only: the outline, checked on both sides of the Ogun border.
 *
 *   node --test test/service-area.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { isInLagos, isInServiceArea, firstOutsideServiceArea } = require('@wheleers/config');

const LAGOS = {
  Yaba: [6.5095, 3.3711], 'Ilemere, Ikorodu': [6.5446, 3.4894], Ikeja: [6.6018, 3.3515], 'Lekki Phase 1': [6.4474, 3.474],
  Badagry: [6.415, 2.8813], Epe: [6.5841, 3.9834], 'Ikorodu town': [6.6194, 3.5105], 'Victoria Island': [6.4281, 3.4219],
  Alagbado: [6.6597, 3.2636], 'Ojodu Berger, Lagos side': [6.6375, 3.364], 'Murtala Muhammed Airport': [6.5774, 3.3212],
};
const OUTSIDE = {
  'Sango Ota, Ogun': [6.6979, 3.2339], 'Akute, Ogun': [6.6789, 3.3672], 'Mowe, Ogun': [6.8017, 3.4339], 'Arepo, Ogun': [6.699, 3.412],
  'Ibafo, Ogun': [6.7558, 3.4277], 'Abeokuta, Ogun': [7.1475, 3.3619], 'Ijebu Ode, Ogun': [6.8204, 3.9173], 'Ibadan, Oyo': [7.3775, 3.947],
  Abuja: [9.0765, 7.3986], Accra: [5.6037, -0.187],
};

test('places in Lagos State are in, right up to the Ogun border', () => {
  for (const [name, [lat, lng]] of Object.entries(LAGOS)) assert.equal(isInLagos(lat, lng), true, name);
});

test('places outside Lagos State are out, the Ogun border towns included', () => {
  for (const [name, [lat, lng]] of Object.entries(OUTSIDE)) assert.equal(isInLagos(lat, lng), false, name);
  assert.equal(isInLagos(Number.NaN, 3.3), false);
});

test('a trip is refused by its first point outside; SERVICE_AREA=off lifts the fence', () => {
  const yaba = { lat: 6.5095, lng: 3.3711 };
  const ota = { lat: 6.6979, lng: 3.2339 };
  assert.equal(firstOutsideServiceArea([yaba, null, yaba]), null);
  assert.equal(firstOutsideServiceArea([yaba, ota]), ota);
  process.env.SERVICE_AREA = 'off';
  try {
    assert.equal(isInServiceArea(ota.lat, ota.lng), true);
  } finally {
    delete process.env.SERVICE_AREA;
  }
});

/* ── On WhatsApp: places and pins outside Lagos are refused, with the reason ── */

const { findPlaceOptions, geocodeMissLine, isPinInsideServiceArea, resetPlacesAvailability } = require('../apps/api-gateway/dist/LLM/geocoding.js');
const { assertInServiceArea } = require('../apps/api-gateway/dist/utils/service-area.js');

const OTA = { name: 'Sango Ota', formatted_address: 'Sango Ota, Ogun State, Nigeria', types: ['locality', 'political'], geometry: { location: { lat: 6.6979, lng: 3.2339 } } };
const ICM = { name: 'Ikeja City Mall', formatted_address: 'Obafemi Awolowo Way, Ikeja, Lagos, Nigeria', types: ['shopping_mall'], geometry: { location: { lat: 6.6143, lng: 3.3581 } } };

/** Places answers with these, whatever was asked; the geocoder finds nothing. */
function stubPlaces(found) {
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.hostname === 'places.googleapis.com' && init?.method === 'POST') {
      const asked = JSON.parse(init.body);
      if (asked.input !== undefined) return { ok: true, status: 200, json: async () => ({ suggestions: [] }) };
      return { ok: true, status: 200, json: async () => ({ places: found.map((hit) => ({ displayName: { text: hit.name }, formattedAddress: hit.formatted_address, location: { latitude: hit.geometry.location.lat, longitude: hit.geometry.location.lng }, types: hit.types })) }) };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ZERO_RESULTS', results: [] }) };
  };
  return () => { global.fetch = realFetch; };
}

test('a place outside Lagos is not offered, and the reply says why', async () => {
  delete process.env.SERVICE_AREA;
  resetPlacesAvailability();
  const restore = stubPlaces([OTA]);
  try {
    assert.deepEqual(await findPlaceOptions('test-key', 'sango ota', { limit: 5 }), []);
    assert.match(geocodeMissLine('sango ota'), /is outside Lagos \(.*Ogun.*\)\. Wheelers is only in Lagos for now/);
  } finally {
    restore();
  }
});

test('Lagos places are kept when Ogun ones come back beside them', async () => {
  delete process.env.SERVICE_AREA;
  resetPlacesAvailability();
  const restore = stubPlaces([OTA, ICM]);
  try {
    const found = await findPlaceOptions('test-key', 'mall', { limit: 5 });
    assert.deepEqual(found.map((place) => place.name), ['Ikeja City Mall']);
  } finally {
    restore();
  }
});

test('a pin dropped in Ogun is outside; one in Lagos is in', () => {
  delete process.env.SERVICE_AREA;
  assert.equal(isPinInsideServiceArea(6.6979, 3.2339, { countryCode: 'NG' }), false);
  assert.equal(isPinInsideServiceArea(6.5095, 3.3711, { countryCode: 'NG' }), true);
});

test('the server refuses a trip with any point outside Lagos, with a code the app can read', () => {
  delete process.env.SERVICE_AREA;
  assert.doesNotThrow(() => assertInServiceArea([{ lat: 6.5095, lng: 3.3711 }, { lat: 6.4474, lng: 3.474 }]));
  assert.throws(
    () => assertInServiceArea([{ lat: 6.5095, lng: 3.3711 }, { lat: 6.6979, lng: 3.2339 }]),
    (error) => error.code === 'OUTSIDE_SERVICE_AREA' && /only in Lagos for now/.test(error.message),
  );
});
