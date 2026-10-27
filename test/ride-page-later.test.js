// The ride page's place search (Google Places, inside Lagos), stops on Plan
// your trip, rides for later ("Later") booked on the page and what happens when
// one starts its search, and the six-hour link. Through the real entry points:
// handleRidePageRoute for the page, handleRideEvent for the search starting.
// Against the local Postgres; Redis is an in-memory stand-in, Google and
// Kafka are recorded, not called.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/ride-page-later.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const local = require('../apps/api-gateway/dist/auth/local.js');
const bidState = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');
const catchup = require('../apps/api-gateway/dist/whatsapp-flows/page-catchup.js');
const { handleRidePageRoute } = require('../apps/api-gateway/dist/http/ride-page.route.js');
const { handleRideEvent } = require('../apps/api-gateway/dist/kafka/consumer.js');

const prisma = new PrismaClient();
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const realFetch = global.fetch;
const realConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
const made = { users: [], scheduled: [], rides: [] };

const YABA = { lat: 6.5095, lng: 3.3711, address: '12 Herbert Macaulay Way, Yaba, Lagos' };
const VI = { lat: 6.4281, lng: 3.4219, address: 'Adeola Odeku Street, Victoria Island, Lagos' };
const IKEJA = { lat: 6.6018, lng: 3.3515, address: 'Ikeja City Mall, Obafemi Awolowo Way, Ikeja' };
const SURULERE = { lat: 6.4995, lng: 3.3540, address: 'Adeniran Ogunsanya Street, Surulere, Lagos' };
const LEKKI = { lat: 6.4474, lng: 3.4723, address: 'Admiralty Way, Lekki Phase 1, Lagos' };

function memoryRedis() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v) { store.set(k, v); },
    async del(k) { store.delete(k); },
    async setIfNotExists(k, v) { if (store.has(k)) return false; store.set(k, v); return true; },
    // INCR for the rate limits; nothing else (lists fall back to plain keys, as in the other tests).
    async send(cmd, key) {
      if (cmd === 'INCR') { const n = Number(store.get(`n:${key}`) ?? 0) + 1; store.set(`n:${key}`, String(n)); return n; }
      return null;
    },
  };
}

function plannerFor(record = []) {
  return {
    planRoute: async (input) => {
      record.push(input);
      return { distanceKm: 11.4, durationSeconds: 1680, suggestedFareNgn: 5200, minOfferNgn: 4700, ratePerKmNgn: 420, priceReason: null, geometry: { coordinates: [], bounds: { northEast: VI, southWest: YABA } } };
    },
  };
}

function world({ scheduling = true } = {}) {
  const redis = memoryRedis();
  const queue = { added: [], removed: [], async add(name, data, opts) { this.added.push({ name, data, opts }); }, async remove(id) { this.removed.push(id); } };
  const deps = {
    jwtSecret: JWT_SECRET,
    redisClient: redis,
    publisher: { publishRideEvent: async () => {}, publishNotificationEvent: async () => {} },
    paymentsClient: {},
    googleMapsApiKey: 'server-key',
    routePlanner: plannerFor(),
    ...(scheduling ? { scheduling: { dispatcherQueue: queue, leadTimeMs: 10 * 60_000 } } : {}),
  };
  return { redis, queue, deps };
}

async function makeRider(phone = `+23480${Math.floor(1e8 + Math.random() * 9e8)}`) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `whatsapp:${phone}`, role: 'RIDER', name: 'Later Rider', phone, privacyConsent: 'AGREED' } });
  await prisma.wallet.create({ data: { userId: id, balanceNgn: 0 } });
  made.users.push(id);
  return id;
}

async function call(deps, userId, method, path, body, token) {
  const bearer = token ?? local.createWalletPageToken(userId, 'ride', JWT_SECRET, local.RIDE_PAGE_TOKEN_TTL_SECONDS);
  const raw = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = { method, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { for (const c of raw) yield c; } };
  const res = { statusCode: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, writeHead(code) { this.statusCode = code; return this; }, end(text) { this.body = text ? JSON.parse(text) : null; } };
  const handled = await handleRidePageRoute(req, res, deps, new URL(`http://x${path}`));
  return { handled, status: res.statusCode, body: res.body };
}

const inMinutes = (n) => new Date(Date.now() + n * 60_000).toISOString();

test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; });
test.afterEach(() => { Object.assign(console, realConsole); global.fetch = realFetch; });
test.after(async () => {
  await prisma.scheduledRide.deleteMany({ where: { riderId: { in: made.users } } }).catch(() => {});
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } }).catch(() => {});
  await prisma.wallet.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
  await prisma.$disconnect();
});

/* ── place search ─────────────────────────────────────────────────────── */

test('typing a place: Google Places (New) autocomplete, kept inside Lagos, one session with the pick', async () => {
  const { deps } = world();
  const rider = await makeRider();
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => ({ suggestions: [
      { placePrediction: { placeId: 'ChIJ-ikeja-city-mall', text: { text: 'Ikeja City Mall, Obafemi Awolowo Way, Ikeja, Nigeria' }, structuredFormat: { mainText: { text: 'Ikeja City Mall' }, secondaryText: { text: 'Obafemi Awolowo Way, Ikeja, Nigeria' } } } },
      { placePrediction: { placeId: 'ChIJ-ikeja-city-mall', text: { text: 'Ikeja City Mall, Obafemi Awolowo Way, Ikeja, Nigeria' }, structuredFormat: { mainText: { text: 'Ikeja City Mall' }, secondaryText: { text: 'Obafemi Awolowo Way, Ikeja, Nigeria' } } } },
      { placePrediction: { placeId: 'ChIJ-ikeja-gra', text: { text: 'Ikeja GRA, Ikeja, Nigeria' } } },
      { queryPrediction: { text: { text: 'ikeja' } } },
    ] }) };
  };

  const found = await call(deps, rider, 'GET', '/ride-page/suggest?q=ikeja%20mall&session=sess_0123456789');
  assert.equal(found.status, 200, JSON.stringify(found.body));
  assert.deepEqual(found.body.places, [
    { placeId: 'ChIJ-ikeja-city-mall', name: 'Ikeja City Mall', area: 'Obafemi Awolowo Way, Ikeja, Nigeria', address: 'Ikeja City Mall, Obafemi Awolowo Way, Ikeja, Nigeria' },
    { placeId: 'ChIJ-ikeja-gra', name: 'Ikeja GRA', area: 'Ikeja, Nigeria', address: 'Ikeja GRA, Ikeja, Nigeria' },
  ], 'one row per place, name and area as the app shows them');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://places.googleapis.com/v1/places:autocomplete');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['X-Goog-Api-Key'], 'server-key');
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.input, 'ikeja mall, Nigeria');
  assert.equal(sent.languageCode, 'en');
  assert.deepEqual(sent.includedRegionCodes, ['ng']);
  assert.equal(sent.sessionToken, 'sess_0123456789');
  const { low, high } = sent.locationRestriction.rectangle;
  assert.ok(Math.abs(low.latitude - 6.3667) < 0.02 && Math.abs(low.longitude - 2.706) < 0.02, 'the app\'s Lagos box, south-west');
  assert.ok(Math.abs(high.latitude - 6.6968) < 0.02 && Math.abs(high.longitude - 4.3509) < 0.02, 'the app\'s Lagos box, north-east');

  // Too short to look up, and a session token that is not one is not sent on.
  assert.deepEqual((await call(deps, rider, 'GET', '/ride-page/suggest?q=i')).body.places, []);
  assert.equal(calls.length, 1);
  await call(deps, rider, 'GET', '/ride-page/suggest?q=ikeja&session=' + encodeURIComponent('bad token!'));
  assert.equal(JSON.parse(calls[1].init.body).sessionToken, undefined);

  // Google failing is said in one line, not an empty list.
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const failed = await call(deps, rider, 'GET', '/ride-page/suggest?q=ikeja');
  assert.equal(failed.status, 502);
  assert.equal(failed.body.code, 'PLACES_FAILED');
});

test('picking a suggestion: its spot by id (location only), refused outside Lagos', async () => {
  const { deps } = world();
  const rider = await makeRider();
  const calls = [];
  let spot = { latitude: 6.6018, longitude: 3.3515 };
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return spot ? { ok: true, status: 200, json: async () => ({ location: spot }) } : { ok: false, status: 404, json: async () => ({}) };
  };

  const picked = await call(deps, rider, 'GET', '/ride-page/place?id=ChIJ-ikeja-city-mall&session=sess_0123456789');
  assert.equal(picked.status, 200, JSON.stringify(picked.body));
  assert.deepEqual(picked.body.place, { lat: 6.6018, lng: 3.3515 });
  assert.equal(calls[0].url, 'https://places.googleapis.com/v1/places/ChIJ-ikeja-city-mall?sessionToken=sess_0123456789');
  assert.equal(calls[0].init.headers['X-Goog-FieldMask'], 'location');
  assert.equal(calls[0].init.headers['X-Goog-Api-Key'], 'server-key');

  spot = { latitude: 7.1475, longitude: 3.3619 };   // Abeokuta
  assert.equal((await call(deps, rider, 'GET', '/ride-page/place?id=ChIJ-abeokuta-kuto')).body.code, 'OUTSIDE_SERVICE_AREA');
  spot = null;
  assert.equal((await call(deps, rider, 'GET', '/ride-page/place?id=ChIJ-gone-gone-gone')).body.code, 'PLACE_NOT_FOUND');
  assert.equal((await call(deps, rider, 'GET', '/ride-page/place?id=../../etc')).body.code, 'PLACE_INVALID');
  assert.equal(calls.length, 3, 'a bad id never reaches Google');
});

test('every lookup is limited per rider: 60 suggestions and 30 picks a minute', async () => {
  const { deps } = world();
  const rider = await makeRider();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ suggestions: [], location: { latitude: 6.5, longitude: 3.37 } }) });
  for (let i = 0; i < 60; i++) assert.equal((await call(deps, rider, 'GET', '/ride-page/suggest?q=yaba')).status, 200);
  assert.equal((await call(deps, rider, 'GET', '/ride-page/suggest?q=yaba')).body.code, 'TOO_MANY');
  for (let i = 0; i < 30; i++) assert.equal((await call(deps, rider, 'GET', '/ride-page/place?id=ChIJ-yaba-market')).status, 200);
  assert.equal((await call(deps, rider, 'GET', '/ride-page/place?id=ChIJ-yaba-market')).body.code, 'TOO_MANY');
});

test('the old lookup is still there for a page opened before this release', async () => {
  const { deps } = world();
  const rider = await makeRider();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 'OK', results: [{ formatted_address: 'Yaba Market, Yaba, Lagos, Nigeria', geometry: { location: { lat: 6.5095, lng: 3.3711 } }, address_components: [], types: ['point_of_interest'] }] }) });
  const old = await call(deps, rider, 'GET', '/ride-page/places?q=yaba%20market&field=destination');
  assert.equal(old.status, 200, JSON.stringify(old.body));
  assert.ok(Array.isArray(old.body.places));
  for (const place of old.body.places) assert.equal(typeof place.lat, 'number');
});

/* ── stops ────────────────────────────────────────────────────────────── */

test('Plan your trip with stops: planned through them, shown on the price, at most the chat\'s three', async () => {
  const { deps } = world();
  const planned = [];
  deps.routePlanner = plannerFor(planned);
  const rider = await makeRider();

  const home = await call(deps, rider, 'GET', '/ride-page/state');
  assert.equal(home.body.phase, 'idle');
  assert.equal(home.body.maxStops, 3);
  assert.equal(home.body.canSchedule, true);

  const priced = await call(deps, rider, 'POST', '/ride-page/route', { pickup: YABA, destination: VI, stops: [SURULERE, IKEJA, LEKKI, { lat: 6.45, lng: 3.39, address: 'A fourth stop, Lagos Island' }] });
  assert.equal(priced.status, 200, JSON.stringify(priced.body));
  assert.equal(priced.body.phase, 'price');
  assert.deepEqual(priced.body.route.stopAddresses, [SURULERE.address, IKEJA.address, LEKKI.address], 'the fourth is dropped');
  assert.deepEqual(priced.body.places.stops.map((s) => s.address), [SURULERE.address, IKEJA.address, LEKKI.address]);
  assert.deepEqual(planned[0].stops.map((s) => s.address), [SURULERE.address, IKEJA.address, LEKKI.address]);

  // A stop is checked like any place.
  assert.equal((await call(deps, rider, 'POST', '/ride-page/route', { pickup: YABA, destination: VI, stops: [{ lat: 7.1475, lng: 3.3619, address: 'Kuto, Abeokuta' }] })).body.code, 'OUTSIDE_SERVICE_AREA');
  assert.equal((await call(deps, rider, 'POST', '/ride-page/route', { pickup: YABA, destination: VI, stops: [{ ...YABA, address: 'Yaba again' }] })).body.code, 'SAME_PLACE');
  assert.equal((await call(deps, rider, 'POST', '/ride-page/route', { pickup: YABA, destination: VI, stops: [{ lat: 'x', address: '' }] })).body.code, 'PLACE_INVALID');
});

/* ── rides for later ──────────────────────────────────────────────────── */

test('a ride for later: priced first, then booked once, marked WhatsApp, with the scheduler\'s job', async () => {
  const { deps, queue, redis } = world();
  const rider = await makeRider();
  await bidState.markWhatsappInbound(redis, rider);
  const trip = { pickup: YABA, destination: VI, stops: [SURULERE] };

  // The app's time rules.
  assert.equal((await call(deps, rider, 'POST', '/ride-page/schedule/quote', { ...trip, scheduledFor: inMinutes(5) })).body.code, 'TIME_INVALID');
  const tooFar = await call(deps, rider, 'POST', '/ride-page/schedule/quote', { ...trip, scheduledFor: inMinutes(9 * 24 * 60) });
  assert.equal(tooFar.body.code, 'TIME_INVALID');
  assert.match(tooFar.body.error, /up to 7 days ahead/);
  assert.equal((await call(deps, rider, 'POST', '/ride-page/schedule/quote', { ...trip, scheduledFor: 'tomorrow' })).body.code, 'TIME_INVALID');
  assert.equal((await call(deps, rider, 'POST', '/ride-page/schedule', { ...trip, scheduledFor: inMinutes(8 * 24 * 60) })).body.code, 'TIME_INVALID');
  assert.equal((await call(deps, rider, 'POST', '/ride-page/schedule', { pickup: YABA, destination: { lat: 7.16, lng: 3.35, address: 'Ibara, Abeokuta' }, scheduledFor: inMinutes(120) })).body.code, 'OUTSIDE_SERVICE_AREA');

  const when = inMinutes(20 * 60);
  const quote = await call(deps, rider, 'POST', '/ride-page/schedule/quote', { ...trip, scheduledFor: when });
  assert.equal(quote.status, 200, JSON.stringify(quote.body));
  assert.deepEqual(quote.body.route, { pickupAddress: YABA.address, destAddress: VI.address, stopAddresses: [SURULERE.address], distanceKm: 11.4, durationMin: 28, suggestedFareNgn: 5200 });
  assert.equal(await prisma.scheduledRide.count({ where: { riderId: rider } }), 0, 'a quote books nothing');

  const booked = await call(deps, rider, 'POST', '/ride-page/schedule', { ...trip, scheduledFor: when, requestId: 'req_abcdef123' });
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  assert.equal(booked.body.item.fareNgn, 5200);
  assert.deepEqual(booked.body.item.stopAddresses, [SURULERE.address]);
  assert.equal(booked.body.scheduled.length, 1);
  const row = await prisma.scheduledRide.findUnique({ where: { id: booked.body.item.id } });
  assert.equal(row.channel, 'WHATSAPP', 'its search will be a WhatsApp search');
  assert.equal(row.status, 'SCHEDULED');
  assert.equal(row.riderId, rider);
  assert.equal(row.scheduledFor.toISOString(), when);
  assert.equal(queue.added.length, 1);
  assert.equal(queue.added[0].name, 'dispatch');
  assert.equal(queue.added[0].opts.jobId, `scheduled-ride-${row.id}`);
  const delay = queue.added[0].opts.delay;
  const expected = Date.parse(when) - 10 * 60_000 - Date.now();
  assert.ok(Math.abs(delay - expected) < 5_000, 'the job fires the lead time before the pickup');

  // The same tap again (a slow network): one ride.
  const again = await call(deps, rider, 'POST', '/ride-page/schedule', { ...trip, scheduledFor: when, requestId: 'req_abcdef123' });
  assert.equal(again.status, 200);
  assert.equal(await prisma.scheduledRide.count({ where: { riderId: rider } }), 1);
  assert.equal(queue.added.length, 1);

  const listed = await call(deps, rider, 'GET', '/ride-page/scheduled');
  assert.deepEqual(listed.body.scheduled.map((r) => r.id), [row.id]);
});

test('a ride for later is cancelled only by its own rider, only while it waits', async () => {
  const { deps, queue, redis } = world();
  const owner = await makeRider();
  const stranger = await makeRider();
  await bidState.markWhatsappInbound(redis, owner);
  const { body } = await call(deps, owner, 'POST', '/ride-page/schedule', { pickup: YABA, destination: VI, scheduledFor: inMinutes(180) });
  const id = body.item.id;

  const theirs = await call(deps, stranger, 'POST', `/ride-page/scheduled/${id}/cancel`);
  assert.equal(theirs.status, 404);
  assert.equal(theirs.body.code, 'SCHEDULED_GONE');
  assert.equal((await prisma.scheduledRide.findUnique({ where: { id } })).status, 'SCHEDULED');
  assert.deepEqual((await call(deps, stranger, 'GET', '/ride-page/scheduled')).body.scheduled, [], 'nobody else sees it');
  assert.equal(queue.removed.length, 0);

  assert.equal((await call(deps, owner, 'GET', `/ride-page/scheduled/${id}/cancel`)).status, 405);
  const cancelled = await call(deps, owner, 'POST', `/ride-page/scheduled/${id}/cancel`);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.deepEqual(cancelled.body.scheduled, []);
  const row = await prisma.scheduledRide.findUnique({ where: { id } });
  assert.equal(row.status, 'CANCELLED');
  assert.equal(row.cancellationReason, 'rider_cancelled_schedule');
  assert.deepEqual(queue.removed, [`scheduled-ride-${id}`]);
  assert.equal((await call(deps, owner, 'POST', `/ride-page/scheduled/${id}/cancel`)).status, 404, 'once');

  // Already searching: too late here.
  await prisma.scheduledRide.update({ where: { id }, data: { status: 'DISPATCHED' } });
  assert.equal((await call(deps, owner, 'POST', `/ride-page/scheduled/${id}/cancel`)).status, 404);
  assert.equal((await call(deps, owner, 'POST', '/ride-page/scheduled/not-a-uuid/cancel')).handled, false);
});

test('without the scheduler set up there is no Later', async () => {
  const { deps } = world({ scheduling: false });
  const rider = await makeRider();
  assert.equal((await call(deps, rider, 'GET', '/ride-page/state')).body.canSchedule, false);
  assert.equal((await call(deps, rider, 'POST', '/ride-page/schedule', { pickup: YABA, destination: VI, scheduledFor: inMinutes(60) })).body.code, 'SCHEDULE_OFF');
});

/* ── when its search starts ───────────────────────────────────────────── */

function consumerDeps(redis) {
  const pushes = []; const said = [];
  return {
    pushes, said,
    deps: {
      registry: { sendToUser: async () => {}, hasUser: () => false },
      redisClient: redis,
      publisher: { publishNotificationEvent: async (event) => { pushes.push(event); }, publishRideEvent: async () => {} },
      ridePageChat: async (event) => { said.push(event); },
    },
  };
}

const started = (riderId, extra = {}) => ({
  eventType: 'RIDE_REQUESTED', rideId: randomUUID(), riderId, scheduled: true, channel: 'WHATSAPP',
  pickup: YABA, destination: VI, stops: [SURULERE], plannedDistanceKm: 11.4, plannedDurationSeconds: 1680,
  fareEstimateNgn: 5200, riderOfferNgn: 5200, suggestedFareNgn: 5200, minOfferNgn: 4700, ratePerKmNgn: 420,
  paymentMethod: 'WALLET', timestamp: new Date().toISOString(), ...extra,
});

/** As the scheduler sends it: the ride for later's row is DISPATCHED for this search (a start no longer current is never set up). */
async function dispatchedFor(event) {
  const row = await prisma.scheduledRide.create({ data: {
    riderId: event.riderId, scheduledFor: new Date(Date.now() + 5 * 60_000), status: 'DISPATCHED', requestedRideId: event.rideId, channel: 'WHATSAPP',
    pickupLat: YABA.lat, pickupLng: YABA.lng, pickupAddress: YABA.address, destLat: VI.lat, destLng: VI.lng, destAddress: VI.address,
  } });
  made.scheduled.push(row.id);
  return event;
}

test('a ride booked on the page starts as a WhatsApp search: the page shows it, the chat gets "Your bid is in" once, no app push', async () => {
  const redis = memoryRedis();
  const { deps, pushes, said } = consumerDeps(redis);
  const rider = await makeRider('+2348031112222');
  const event = await dispatchedFor(started(rider));

  await handleRideEvent(event, deps, new Map());
  assert.equal(await bidState.getActiveRide(redis, rider), event.rideId);
  const meta = await bidState.getRideMeta(redis, event.rideId);
  assert.equal(meta.riderId, rider);
  assert.equal(meta.phone, '+2348031112222');
  assert.equal(meta.offerNgn, 5200);
  assert.deepEqual(meta.stops.map((s) => s.address), [SURULERE.address]);
  assert.equal(said.length, 1);
  assert.equal(said[0].kind, 'search_started');
  assert.equal(said[0].rideId, event.rideId);
  assert.equal(said[0].scheduled, true);
  assert.equal(pushes.length, 0, 'not the app\'s "Open Wheelers to see the offers"');
  assert.equal(await redis.get(`ride:${event.rideId}:app-only`), null);

  // The page: the offers screen for this search.
  const page = world();
  page.deps.redisClient = redis;
  const state = await call(page.deps, rider, 'GET', '/ride-page/state');
  assert.equal(state.body.phase, 'offers');
  assert.equal(state.body.rideId, event.rideId);
  assert.equal(state.body.offerNgn, 5200);
  assert.deepEqual(state.body.route.stopAddresses, [SURULERE.address]);

  // Delivered again: nothing more.
  await handleRideEvent(event, deps, new Map());
  assert.equal(said.length, 1);
});

test('on the ride page when it starts: the chat waits for them to leave', async () => {
  const redis = memoryRedis();
  const { deps, said } = consumerDeps(redis);
  const rider = await makeRider();
  await bidState.markRidePageSeen(redis, rider);
  const event = await dispatchedFor(started(rider));
  await handleRideEvent(event, deps, new Map());
  assert.equal(said.length, 0);
  const waiting = await catchup.pendingCatchup(redis, rider);
  assert.deepEqual(waiting.map((item) => [item.kind, item.rideId]), [['search_started', event.rideId]]);
});

test('a rider on a trip when it starts keeps their trip in the chat; it waits for them, never the app\'s', async () => {
  const redis = memoryRedis();
  const { deps, pushes, said } = consumerDeps(redis);
  const rider = await makeRider();
  const trip = await prisma.ride.create({ data: { riderId: rider, status: 'IN_PROGRESS', pickupLat: YABA.lat, pickupLng: YABA.lng, pickupAddress: YABA.address, destLat: VI.lat, destLng: VI.lng, destAddress: VI.address } });
  made.rides.push(trip.id);
  await bidState.setActiveRide(redis, rider, trip.id);
  await bidState.setRideState(redis, trip.id, 'in_progress');
  const event = started(rider);
  await handleRideEvent(event, deps, new Map());
  assert.equal(await bidState.getActiveRide(redis, rider), trip.id);
  assert.equal(said.length, 0);
  assert.equal(await redis.get(`ride:${event.rideId}:app-only`), null, 'not the app\'s');
  assert.equal(pushes.length, 0);
});

test('a ride booked in the app is unchanged: the app\'s push, its offers stay in the app', async () => {
  const redis = memoryRedis();
  const { deps, pushes, said } = consumerDeps(redis);
  const rider = await makeRider();
  const event = started(rider, { channel: 'APP' });
  await handleRideEvent(event, deps, new Map());
  assert.equal(said.length, 0);
  assert.equal(await bidState.getActiveRide(redis, rider), null);
  assert.equal(await redis.get(`ride:${event.rideId}:app-only`), '1');
  assert.deepEqual(pushes.map((p) => p.eventType), ['PUSH_SEND', 'IN_APP_SEND']);
});
