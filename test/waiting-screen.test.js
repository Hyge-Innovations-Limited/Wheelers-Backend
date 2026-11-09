// What the rider sees while a price is out: why the price is up (one line),
// how many drivers saw it and when the search closes, and — when nobody took
// it — the last search to try again at a new price. Pricing is pure; the rest
// runs against the local Postgres with an in-memory Redis.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/waiting-screen.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const config = require('@wheleers/config');
const { PrismaClient } = require('@prisma/client');
const { handleRideEvent, SEARCH_STATUS_DELAY_MS } = require('../apps/api-gateway/dist/kafka/consumer.js');
const { handleRidePageRoute } = require('../apps/api-gateway/dist/http/ride-page.route.js');
const bidState = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');
const local = require('../apps/api-gateway/dist/auth/local.js');

const prisma = new PrismaClient();
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const realConsole = { ...console };
const made = [];
test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; });
test.afterEach(() => { Object.assign(console, realConsole); });
test.after(async () => {
  config.setPricingSettings({});
  await prisma.ride.updateMany({ where: { riderId: { in: made } }, data: { status: 'CANCELLED' } }).catch(() => {});
  await prisma.wallet.deleteMany({ where: { userId: { in: made } } });
  await prisma.user.deleteMany({ where: { id: { in: made } } });
  await prisma.$disconnect();
});

// Lagos time (UTC+1).
const lagos = (date, hour, minute = 0) => new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hour - 1, minute));
const WEDNESDAY = '2026-10-21';
const live = {
  marketFloorOn: true, liftCap: 1, extraNgn: 900, surgeOn: true, surgeMin: 0.9, surgeMax: 1.15, rainOn: true,
  quiet: { baseNgn: 500, perKmNgn: 301, perMinuteNgn: 28 },
};

function memoryRedis() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v) { store.set(k, v); },
    async del(k) { store.delete(k); },
    async setIfNotExists(k, v) { if (store.has(k)) return false; store.set(k, v); return true; },
    async send(cmd, key, ...rest) {
      if (cmd === 'SADD') { const s = store.get(key) ?? new Set(); const had = s.has(rest[0]); s.add(rest[0]); store.set(key, s); return had ? 0 : 1; }
      if (cmd === 'SCARD') return store.get(key)?.size ?? 0;
      return null;
    },
  };
}

/* ── the price reason ─────────────────────────────────────────────────── */

test('the price line names the single biggest lift and what it added, in ₦50s; nothing notable is null', () => {
  config.setPricingSettings(live);
  const at = lagos(WEDNESDAY, 14);
  const trip = { durationSeconds: 2400, at, origin: { lat: 6.6018, lng: 3.3515 }, destination: { lat: 6.4969, lng: 3.3556 } };
  const quote = (factors) => config.calculateSuggestedFare(15, factors);

  const plain = config.priceReasonOf(15, trip, quote(trip));
  assert.equal(plain, null, 'a dry, quiet afternoon');
  const slight = { ...trip, surgeFactor: 1.03 };
  assert.equal(config.priceReasonOf(15, slight, quote(slight)), null, 'a surge of 3% is not worth a line');

  const busy = { ...trip, surgeFactor: 1.12 };
  const busyFare = quote(busy);
  const reason = config.priceReasonOf(15, busy, busyFare);
  assert.equal(reason.label, 'Busy in this area');
  assert.ok(reason.extraNgn > 0 && reason.extraNgn % 50 === 0, String(reason.extraNgn));
  const without = quote({ ...busy, surgeFactor: 1 }).suggestedFareNgn;
  assert.equal(reason.extraNgn, Math.round((busyFare.suggestedFareNgn - without) / 50) * 50, 'what the surge really added');

  // Heavy rain lifts more than a 12% surge: rain is the one line.
  const storm = { ...busy, rain: 'heavy' };
  const stormReason = config.priceReasonOf(15, storm, quote(storm));
  assert.equal(stormReason.label, 'Raining');
  assert.ok(stormReason.extraNgn > reason.extraNgn);
});

test('rush hour is never named under the price, however busy the hour', () => {
  const curve = config.seedHourCurve(config.normalizePricingSettings(live));
  const flat = curve.weekday.map((v, h) => (config.isNightHour(h) ? v : 1));
  flat[8] = 1.15;
  config.setPricingSettings({ ...live, hourCurveOn: true, hourCurve: { ...curve, weekday: flat } });
  const trip = { durationSeconds: 2400, origin: { lat: 6.6018, lng: 3.3515 }, destination: { lat: 6.4969, lng: 3.3556 } };
  const rush = { ...trip, at: lagos(WEDNESDAY, 8, 30) };
  assert.equal(config.priceReasonOf(15, rush, config.calculateSuggestedFare(15, rush)), null);
  config.setPricingSettings({});
});

/* ── the ride page and the app ────────────────────────────────────────── */

async function makeRider(balanceNgn) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:waiting:${id}`, role: 'RIDER', name: 'Timi Rider', phone: '+2348030000011' } });
  await prisma.wallet.create({ data: { userId: id, balanceNgn } });
  made.push(id);
  return id;
}
function page(redis, extra = {}) {
  const published = [];
  const deps = {
    jwtSecret: JWT_SECRET, redisClient: redis, paymentsClient: {}, notifyChat: async () => {},
    publisher: { publishRideEvent: async (e) => { published.push(e); }, publishNotificationEvent: async () => {} },
    ...extra,
  };
  const call = async (userId, method, path, body) => {
    const bearer = local.createWalletPageToken(userId, 'ride', JWT_SECRET, local.RIDE_PAGE_TOKEN_TTL_SECONDS);
    const raw = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = { method, headers: { authorization: `Bearer ${bearer}` }, async *[Symbol.asyncIterator]() { for (const c of raw) yield c; } };
    const res = { statusCode: 200, body: null, setHeader() {}, writeHead(code) { this.statusCode = code; return this; }, end(text) { this.body = text ? JSON.parse(text) : null; } };
    await handleRidePageRoute(req, res, deps, new URL(`http://x${path}`));
    return res;
  };
  return { call, published };
}
const QUOTE = {
  pickupLat: 6.6018, pickupLng: 3.3515, pickupAddress: 'Opebi', destLat: 6.4969, destLng: 3.3556, destAddress: 'Surulere',
  distanceKm: 12, durationSeconds: 1800, suggestedFareNgn: 7900, minOfferNgn: 7000, ratePerKmNgn: 400,
  route: { coordinates: [{ lat: 6.6018, lng: 3.3515 }, { lat: 6.4969, lng: 3.3556 }], bounds: { northEast: { lat: 6.61, lng: 3.36 }, southWest: { lat: 6.49, lng: 3.35 } } },
  priceReason: { label: 'Busy in this area', extraNgn: 1200 },
};

test('the price and the offers screens carry the reason line; offers say how many drivers saw the price and when it closes — the app hears it once per burst', async () => {
  const redis = memoryRedis();
  const rider = await makeRider(10_000);
  const { call } = page(redis);
  await bidState.storePendingRoute(redis, rider, QUOTE);
  const price = await call(rider, 'GET', '/ride-page/state');
  assert.deepEqual(price.body.route.priceReason, { label: 'Busy in this area', extraNgn: 1200 });

  const found = await call(rider, 'POST', '/ride-page/find', { amountNgn: 7900 });
  assert.deepEqual(found.body.route.priceReason, { label: 'Busy in this area', extraNgn: 1200 });
  assert.equal(found.body.driversNotified, null, 'nobody reached yet');
  assert.ok(Date.parse(found.body.bidsCloseAt) > Date.now(), 'the clock starts with the search');
  assert.deepEqual(found.body.places.pickup, { lat: 6.6018, lng: 3.3515, address: 'Opebi' });
  assert.equal(found.body.line.length, 2, 'the road, for the Finding map');
  const rideId = found.body.rideId;

  const toApp = [];
  const deps = { redisClient: redis, publisher: { publishNotificationEvent: async () => {} }, registry: { sendToUser: async (userId, type, payload) => { toApp.push({ userId, type, payload }); }, isUserConnected: async () => true } };
  const closes = new Date(Date.now() + 1_800_000).toISOString();
  const sent = (driverId) => ({ eventType: 'RIDE_OFFER_SENT', rideId, riderId: rider, driverId, driverUserId: `user-${driverId}`, pickup: { address: 'Opebi' }, destination: { address: 'Surulere' }, riderOfferNgn: 7900, expiresAt: closes, bidsCloseAt: closes });
  for (const id of ['d1', 'd2', 'd3', 'd2']) await handleRideEvent(sent(id), deps, new Map());
  await new Promise((resolve) => setTimeout(resolve, SEARCH_STATUS_DELAY_MS + 100));
  const status = toApp.filter((m) => m.type === 'ride:search_status');
  assert.deepEqual(status.map((m) => [m.userId, m.payload]), [[rider, { rideId, driversNotified: 3, bidsCloseAt: closes }]], 'one message, three drivers (one offer was a repeat)');

  const offers = await call(rider, 'GET', '/ride-page/state');
  assert.equal(offers.body.driversNotified, 3);
  assert.equal(offers.body.bidsCloseAt, closes);
  assert.equal(offers.body.autoAccept, false, 'Find without the rider\'s yes: they choose');
});

test('no driver took it: the idle page shows the last search, and Search again at a new price starts it from that trip', async () => {
  const redis = memoryRedis();
  const rider = await makeRider(10_000);
  const planned = [];
  const routePlanner = { planRoute: async (params) => { planned.push(params); return { distanceKm: 12.4, durationSeconds: 1900, suggestedFareNgn: 8100, minOfferNgn: 7200, ratePerKmNgn: 410, geometry: QUOTE.route, priceReason: null }; } };
  const { call, published } = page(redis, { routePlanner });
  await bidState.storeLastRoute(redis, rider, { ...QUOTE, offerNgn: 7900 });
  await bidState.markSearchTimedOut(redis, rider, { rideId: randomUUID(), offerNgn: 8000, at: new Date().toISOString() });

  const idle = await call(rider, 'GET', '/ride-page/state');
  assert.equal(idle.body.phase, 'idle');
  assert.deepEqual(idle.body.lastSearch, {
    offerNgn: 8000,
    route: { pickupAddress: 'Opebi', destAddress: 'Surulere', distanceKm: 12, durationMin: 30, suggestedFareNgn: 7900 },
  });

  const low = await call(rider, 'POST', '/ride-page/search-again', { amountNgn: 5000 });
  assert.equal(low.statusCode, 400);
  assert.equal(low.body.code, 'BELOW_MINIMUM');

  const again = await call(rider, 'POST', '/ride-page/search-again', { amountNgn: 8400 });
  assert.equal(again.statusCode, 200, JSON.stringify(again.body));
  assert.equal(again.body.phase, 'offers');
  assert.equal(again.body.offerNgn, 8400);
  assert.equal(again.body.route.suggestedFareNgn, 8100, 'planned again: today\'s price');
  assert.equal(planned.length, 1);
  const requested = published.filter((e) => e.eventType === 'RIDE_REQUESTED');
  assert.equal(requested.length, 1);
  assert.deepEqual([requested[0].riderOfferNgn, requested[0].pickup.address, requested[0].destination.address], [8400, 'Opebi', 'Surulere']);
  assert.equal(await bidState.getSearchTimedOut(redis, rider), null, 'a new search clears "no driver took it"');

  // With no trip remembered at all: said plainly.
  const stranger = await makeRider(0);
  const none = await call(stranger, 'POST', '/ride-page/search-again', { amountNgn: 8400 });
  assert.equal(none.statusCode, 409);
  assert.equal(none.body.code, 'QUOTE_EXPIRED');
});
