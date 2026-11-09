// Google Maps answers cached in Redis, without stale or wrong answers: the
// fare is always worked out fresh, failures are never kept, two identical
// questions at once make one call, a bad cached value is ignored, and a
// point a few metres away is a different route. Real Redis (database 15),
// Google faked.
//
//   npm -w @wheleers/config run build && npm -w @wheleers/api-gateway run build
//   node --test --test-force-exit test/maps-cache.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateSuggestedFare } = require('../packages/config/dist/index.js');
const { RedisClient } = require('../apps/api-gateway/dist/redis/client.js');
const { configureMapsCache, cachedMaps, mapsKey } = require('../apps/api-gateway/dist/maps/shared-cache.js');
const { CachedRoutePlanner } = require('../apps/api-gateway/dist/maps/cached-route-planner.js');
const geocoding = require('../apps/api-gateway/dist/LLM/geocoding.js');

const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15';
let redis;
const realFetch = globalThis.fetch;
const calls = { routes: 0, geocode: 0 };
let routeAnswer = { status: 200, distanceMeters: 10_000 };

test.before(async () => {
  console.warn = () => {};
  console.info = () => {};
  redis = new RedisClient(REDIS_URL);
  await redis.connect();
  await redis.send('FLUSHDB');
  configureMapsCache(redis);
  globalThis.fetch = async (input) => {
    const url = String(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
    if (url.includes('computeRoutes')) {
      calls.routes += 1;
      await new Promise((r) => setTimeout(r, 30));
      if (routeAnswer.status !== 200) return new Response('{"error":"boom"}', { status: routeAnswer.status, headers: { 'content-type': 'application/json' } });
      return Response.json({ routes: [{ distanceMeters: routeAnswer.distanceMeters, duration: '1200s', polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC' } }] });
    }
    if (url.includes('/geocode/json')) {
      calls.geocode += 1;
      const address = new URL(url).searchParams.get('address');
      if (address === 'nowhere at all') return Response.json({ status: 'ZERO_RESULTS', results: [] });
      return Response.json({ status: 'OK', results: [{ formatted_address: 'Yaba, Lagos, Nigeria', geometry: { location: { lat: 6.5095, lng: 3.3711 } }, types: ['sublocality'], address_components: [{ short_name: 'NG', types: ['country'] }] }] });
    }
    return Response.json({ suggestions: [], places: [] });
  };
});
test.after(async () => {
  globalThis.fetch = realFetch;
  configureMapsCache(null);
  await redis.send('FLUSHDB');
  await redis.disconnect();
});

const planner = new CachedRoutePlanner('https://routes.googleapis.com/', 'test-key');
const trip = (dLat = 0) => ({ origin: { lat: 6.5244 + dLat, lng: 3.3792 }, destination: { lat: 6.5158, lng: 3.3896 } });

test('the same trip asks Google once; the fare is worked out fresh each time', async () => {
  const before = calls.routes;
  const first = await planner.planRoute(trip());
  const second = await planner.planRoute(trip());
  assert.equal(calls.routes - before, 1);
  assert.equal(second.distanceKm, 10);
  assert.equal(second.suggestedFareNgn, calculateSuggestedFare(10).suggestedFareNgn);
  assert.deepEqual(second.geometry, first.geometry);
});

test('two identical questions at the same moment make one call', async () => {
  const before = calls.routes;
  await Promise.all(Array.from({ length: 5 }, () => planner.planRoute(trip(0.002))));
  assert.equal(calls.routes - before, 1);
});

test('a point a few metres away is a different route', async () => {
  const before = calls.routes;
  await planner.planRoute(trip(0.003));
  await planner.planRoute(trip(0.00305));
  assert.equal(calls.routes - before, 2);
});

test('a failure is never kept: the next ask goes to Google again', async () => {
  routeAnswer = { status: 500 };
  const before = calls.routes;
  await assert.rejects(planner.planRoute(trip(0.004)));
  routeAnswer = { status: 200, distanceMeters: 7_000 };
  const ok = await planner.planRoute(trip(0.004));
  assert.equal(calls.routes - before, 2);
  assert.equal(ok.distanceKm, 7);
  routeAnswer = { status: 200, distanceMeters: 10_000 };
});

test('a cached value in the wrong shape is ignored and asked again', async () => {
  const key = mapsKey('demo', 1, 'x');
  await redis.set(key, JSON.stringify({ nonsense: true }), 60);
  let loads = 0;
  const value = await cachedMaps(key, 60, async () => { loads += 1; return { lat: 1, lng: 2 }; }, {
    keep: () => true, valid: (v) => typeof v?.lat === 'number',
  });
  assert.equal(loads, 1);
  assert.deepEqual(value, { lat: 1, lng: 2 });
  assert.deepEqual(JSON.parse(await redis.get(key)), { lat: 1, lng: 2 }, 'replaced with the real answer');
});

test('an address is looked up once; "not found" is asked again next time', async () => {
  let before = calls.geocode;
  await geocoding.geocodeAddress('k', 'Yaba bus stop');
  await geocoding.geocodeAddress('k', 'Yaba bus stop');
  assert.equal(calls.geocode - before, 1);

  before = calls.geocode;
  await geocoding.geocodeAddress('k', 'nowhere at all');
  const firstMiss = calls.geocode - before;
  await geocoding.geocodeAddress('k', 'nowhere at all');
  assert.ok(firstMiss >= 1);
  assert.equal(calls.geocode - before, firstMiss * 2, 'not found was not remembered');
});
