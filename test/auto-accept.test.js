// Auto-accept, only for a search the rider said yes to at Find (autoAccept: true):
// the first driver at or under the rider's price and at most 10 minutes away is
// booked and paid from the wallet, through the same accept a tap uses — when the
// wallet covers that offer; otherwise the rider chooses as before. Once only,
// whatever Kafka redelivers and however many gateway processes see the offer.
// A search without that yes (an older app, the WhatsApp chat, a ride for later)
// never books by itself. The explicit switch (on / off) is still honoured.
// Against the local Postgres; Redis is an in-memory stand-in shared by "both processes".
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/auto-accept.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { driverBidClient } = require('../packages/db/dist/index.js');
const { handleRideMessage } = require('../apps/api-gateway/dist/websocket/handlers/ride.handler.js');
const { handleRideEvent } = require('../apps/api-gateway/dist/kafka/consumer.js');
const { handleRidePageRoute } = require('../apps/api-gateway/dist/http/ride-page.route.js');
const { tryAutoAccept, autoAcceptOnAtStart, AUTO_ACCEPT_MAX_ETA_SECONDS } = require('../apps/api-gateway/dist/rides/auto-accept.js');
const { pendingCatchup } = require('../apps/api-gateway/dist/whatsapp-flows/page-catchup.js');
const bidState = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');
const local = require('../apps/api-gateway/dist/auth/local.js');

const prisma = new PrismaClient();
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const made = { users: [], rides: [], drivers: [] };
const realConsole = { ...console };
test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; });
test.afterEach(() => { Object.assign(console, realConsole); });

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

async function user(role, name = `Auto ${role}`) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:auto-accept:${id}`, role, name, phone: '+2348030000009' } });
  made.users.push(id);
  return id;
}
async function rider(balanceNgn) {
  const id = await user('RIDER');
  await prisma.wallet.create({ data: { userId: id, balanceNgn } });
  return id;
}
async function driver() {
  const userId = await user('DRIVER', 'Chinedu Okafor');
  await prisma.wallet.create({ data: { userId, balanceNgn: 0 } });
  const d = await prisma.driver.create({ data: { userId, kycStatus: 'APPROVED', status: 'ONLINE', lastSeenAt: new Date(), lat: 6.6, lng: 3.35, vehicleModel: 'Corolla', vehiclePlate: 'KJA1' } });
  made.drivers.push(d.id);
  return { id: d.id, userId };
}
/** A search the rider started with autoAccept: true (ride:request writes this; tested below). */
async function consented(riderId, offerNgn = 7900) {
  const r = await searching(riderId, offerNgn);
  await autoAcceptOnAtStart(sharedRedis.current, r.id, riderId);
  return r;
}
const sharedRedis = { current: null };
async function searching(riderId, offerNgn = 7900, id = undefined) {
  const r = await prisma.ride.create({
    data: {
      ...(id ? { id } : {}), riderId, status: 'MATCHING',
      pickupLat: 6.6018, pickupLng: 3.3515, pickupAddress: 'Opebi', destLat: 6.4969, destLng: 3.3556, destAddress: 'Surulere',
      fareEstimateNgn: offerNgn, riderOfferNgn: offerNgn,
    },
  });
  made.rides.push(r.id);
  return r;
}
async function bid(r, d, amountNgn, etaSeconds = 300) {
  return driverBidClient.record({ rideId: r.id, driverId: d.id, driverUserId: d.userId, riderId: r.riderId, amountNgn, etaSeconds, distanceKm: 2 });
}
const counterOffer = (r, d, row, amountNgn, etaSeconds = 300) => ({
  eventType: 'RIDE_COUNTER_OFFER', rideId: r.id, bidId: row.id, riderId: r.riderId, driverId: d.id, driverUserId: d.userId,
  counterOfferNgn: amountNgn, driverName: 'Chinedu Okafor', driverRating: 4.9, vehiclePlate: 'KJA1', vehicleModel: 'Corolla', etaSeconds,
  timestamp: new Date().toISOString(),
});

function world() {
  const redis = memoryRedis();
  const published = [];
  const toApp = [];
  const publisher = {
    publishRideEvent: async (e) => { published.push(e); },
    publishWalletEvent: async () => {}, publishNotificationEvent: async () => {}, publishDriverEvent: async () => {},
  };
  const registry = {
    sendToUser: async (userId, type, payload) => { toApp.push({ userId, type, payload }); },
    isUserConnected: async () => true, hasUser: () => true,
  };
  sharedRedis.current = redis;
  return { redis, published, toApp, publisher, deps: { registry, redisClient: redis, publisher } };
}
const say = (w, riderId, type, payload) => handleRideMessage(type, payload, { userId: riderId, role: 'RIDER' }, w.publisher, {}, w.redis);
const accepted = (w, rideId) => w.published.filter((e) => e.eventType === 'RIDE_OFFER_ACCEPTED' && e.rideId === rideId);

test.after(async () => {
  await prisma.rideHold.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.transaction.deleteMany({ where: { wallet: { userId: { in: made.users } } } });
  await prisma.wallet.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.driverBid.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

test('app, said yes at Find: the first offer at or under the price is booked once — a redelivered offer and a second process book nothing more', async () => {
  const w = world();
  const riderId = await rider(10_000);
  const r = await consented(riderId);
  const d = await driver();
  const row = await bid(r, d, 7500);
  const event = counterOffer(r, d, row, 7500);
  // The same offer, twice (Kafka redelivery), on two processes at once — and once more later.
  await Promise.all([handleRideEvent(event, w.deps, new Map()), handleRideEvent(event, w.deps, new Map())]);
  await handleRideEvent(event, w.deps, new Map());

  const booked = accepted(w, r.id);
  assert.equal(booked.length, 1, 'booked once');
  assert.deepEqual([booked[0].driverId, booked[0].agreedFareNgn, booked[0].paymentMethod, booked[0].bidId], [d.id, 7500, 'WALLET', row.id]);
  const hold = await prisma.rideHold.findUnique({ where: { rideId: r.id } });
  assert.equal(Number(hold.amountNgn), 7500, 'held from the wallet before the booking went out');
  assert.deepEqual(w.toApp.filter((m) => m.type === 'ride:auto_accept:done').map((m) => [m.payload.reason, m.payload.driverId]), [['booked', d.id]]);

  // A second driver's offer after the booking: nothing more.
  const d2 = await driver();
  const row2 = await bid(r, d2, 7000);
  await handleRideEvent(counterOffer(r, d2, row2, 7000), w.deps, new Map());
  assert.equal(accepted(w, r.id).length, 1);
});

test('not when the wallet does not cover the offer: nothing is booked and the rider chooses; an offer it covers is booked', async () => {
  const w = world();
  const riderId = await rider(5_000);
  const r = await consented(riderId, 7900);
  const d = await driver();
  const row = await bid(r, d, 7000);
  await handleRideEvent(counterOffer(r, d, row, 7000), w.deps, new Map());
  assert.equal(accepted(w, r.id).length, 0);
  assert.equal(await prisma.rideHold.count({ where: { rideId: r.id } }), 0, 'no money moved');
  assert.equal(w.published.filter((e) => e.eventType === 'RIDE_RIDER_PAYING').length, 0, 'the driver is not told the rider is paying');
  assert.equal(w.toApp.filter((m) => m.type === 'ride:counter_offer').length, 1, 'the offer is there to choose');

  const cheap = await driver();
  const cheapRow = await bid(r, cheap, 4_500);
  await handleRideEvent(counterOffer(r, cheap, cheapRow, 4_500), w.deps, new Map());
  assert.deepEqual(accepted(w, r.id).map((e) => [e.driverId, e.agreedFareNgn]), [[cheap.id, 4500]]);
});

test('not a driver more than 10 minutes away, nor one asking more than the price; a near one at the price is booked', async () => {
  const w = world();
  const riderId = await rider(20_000);
  const r = await consented(riderId, 7900);

  const far = await driver();
  const farRow = await bid(r, far, 7000, AUTO_ACCEPT_MAX_ETA_SECONDS + 60);
  await handleRideEvent(counterOffer(r, far, farRow, 7000, AUTO_ACCEPT_MAX_ETA_SECONDS + 60), w.deps, new Map());
  const dear = await driver();
  const dearRow = await bid(r, dear, 8500, 120);
  await handleRideEvent(counterOffer(r, dear, dearRow, 8500, 120), w.deps, new Map());
  assert.equal(accepted(w, r.id).length, 0, 'neither is booked');

  const near = await driver();
  const nearRow = await bid(r, near, 7900, 240);
  await handleRideEvent(counterOffer(r, near, nearRow, 7900, 240), w.deps, new Map());
  assert.deepEqual(accepted(w, r.id).map((e) => e.driverId), [near.id]);
});

test('a raised price books an offer now under it while the wallet covers it; raised past the wallet, nothing is booked', async () => {
  const w = world();
  const riderId = await rider(8_500);
  const r = await consented(riderId, 7900);
  const d = await driver();
  const row = await bid(r, d, 8400, 200);
  await handleRideEvent(counterOffer(r, d, row, 8400, 200), w.deps, new Map());
  assert.equal(accepted(w, r.id).length, 0, '₦8,400 is over the ₦7,900 offered');

  const raised = { eventType: 'RIDE_RIDER_COUNTER_OFFER', rideId: r.id, riderId, counterOfferNgn: 8500, timestamp: new Date().toISOString() };
  await handleRideEvent(raised, w.deps, new Map());
  assert.deepEqual(accepted(w, r.id).map((e) => e.agreedFareNgn), [8400]);

  // Another search: raised to ₦9,500 with ₦8,500 in the wallet — an ₦8,800 offer is the rider's to choose.
  const w2 = world();
  const r2 = await consented(riderId, 7900);
  await handleRideEvent({ ...raised, rideId: r2.id, counterOfferNgn: 9_500 }, w2.deps, new Map());
  const d2 = await driver();
  const row2 = await bid(r2, d2, 8_800, 100);
  await handleRideEvent(counterOffer(r2, d2, row2, 8_800, 100), w2.deps, new Map());
  assert.equal(accepted(w2, r2.id).length, 0);
  assert.equal(await prisma.rideHold.count({ where: { rideId: r2.id } }), 0);
});

test('an explicit off (ride:auto_accept) is honoured; on again books the offer on the table', async () => {
  const w = world();
  const riderId = await rider(10_000);
  const r = await consented(riderId);
  const off = await say(w, riderId, 'ride:auto_accept', { rideId: r.id, on: false });
  assert.deepEqual([off.type, off.payload.on], ['ride:auto_accept:done', false]);
  const d = await driver();
  const row = await bid(r, d, 7000);
  await handleRideEvent(counterOffer(r, d, row, 7000), w.deps, new Map());
  assert.equal(accepted(w, r.id).length, 0, 'off means off');
  const on = await say(w, riderId, 'ride:auto_accept', { rideId: r.id, on: true });
  assert.deepEqual([on.payload.on, on.payload.reason], [false, 'booked'], 'switched on, and spent at once on the offer waiting');
  assert.equal(accepted(w, r.id).length, 1);

  const over = await searching(riderId, 4000);
  await prisma.ride.update({ where: { id: over.id }, data: { status: 'CANCELLED' } });
  assert.equal((await say(w, riderId, 'ride:auto_accept', { rideId: over.id, on: true })).payload.reason, 'not_searching');
});

test('ride:request: auto-accept only with autoAccept: true; an older app (no field) and false are off; the price reason travels with it', async () => {
  const w = world();
  const riderId = await rider(3_000);
  const planner = { planRoute: async () => ({ distanceKm: 10, durationSeconds: 1500, suggestedFareNgn: 5000, minOfferNgn: 4100, ratePerKmNgn: 400, geometry: { coordinates: [{ lat: 6.6, lng: 3.35 }, { lat: 6.5, lng: 3.36 }], bounds: { northEast: { lat: 6.6, lng: 3.4 }, southWest: { lat: 6.5, lng: 3.3 } } }, priceReason: { label: 'Raining', extraNgn: 600 } }) };
  const ask = (extra) => handleRideMessage('ride:request', {
    pickup: { lat: 6.6018, lng: 3.3515, address: 'Opebi' }, destination: { lat: 6.4969, lng: 3.3556, address: 'Surulere' }, offerNgn: 5000, ...extra,
  }, { userId: riderId, role: 'RIDER' }, w.publisher, planner, w.redis);
  const plain = await ask({});
  assert.equal(plain.payload.autoAccept, false, 'an older app that never asks: off');
  assert.deepEqual(plain.payload.priceReason, { label: 'Raining', extraNgn: 600 });
  const off = await ask({ autoAccept: false });
  assert.equal(off.payload.autoAccept, false);
  const yes = await ask({ autoAccept: true });
  assert.equal(yes.payload.autoAccept, true);
  assert.match(w.redis.store.get(`ride:${yes.payload.rideId}:auto-accept`), /"off":false/);
});

test('the rider\'s yes decides: a search started with autoAccept: true books; one without (an older app, or false) never does', async () => {
  const w = world();
  const planner = { planRoute: async () => ({ distanceKm: 10, durationSeconds: 1500, suggestedFareNgn: 5000, minOfferNgn: 4100, ratePerKmNgn: 400, geometry: { coordinates: [{ lat: 6.6, lng: 3.35 }, { lat: 6.5, lng: 3.36 }], bounds: { northEast: { lat: 6.6, lng: 3.4 }, southWest: { lat: 6.5, lng: 3.3 } } } }) };
  const start = async (riderId, extra) => {
    const sent = await handleRideMessage('ride:request', {
      pickup: { lat: 6.6018, lng: 3.3515, address: 'Opebi' }, destination: { lat: 6.4969, lng: 3.3556, address: 'Surulere' }, offerNgn: 5000, ...extra,
    }, { userId: riderId, role: 'RIDER' }, w.publisher, planner, w.redis);
    // The ride service writes the row when it hears RIDE_REQUESTED.
    return searching(riderId, 5000, sent.payload.rideId);
  };
  const offerTo = async (r) => {
    const d = await driver();
    const row = await bid(r, d, 4800, 200);
    await handleRideEvent(counterOffer(r, d, row, 4800, 200), w.deps, new Map());
  };

  const oldApp = await start(await rider(10_000), {});
  await offerTo(oldApp);
  assert.equal(accepted(w, oldApp.id).length, 0, 'an older app\'s search never books by itself');
  assert.equal(await prisma.rideHold.count({ where: { rideId: oldApp.id } }), 0);

  const saidNo = await start(await rider(10_000), { autoAccept: false });
  await offerTo(saidNo);
  assert.equal(accepted(w, saidNo.id).length, 0);

  const saidYes = await start(await rider(10_000), { autoAccept: true });
  await offerTo(saidYes);
  assert.equal(accepted(w, saidYes.id).length, 1, 'with the rider\'s yes, the offer is booked');
});

test('ride page: an offer that qualifies is booked through the page accept — confirmed phase, held once, the chat told once the page is left', async () => {
  const w = world();
  const riderId = await rider(10_000);
  const deps = { jwtSecret: JWT_SECRET, redisClient: w.redis, publisher: w.publisher, paymentsClient: {}, notifyChat: async () => {} };
  const call = async (method, path, body) => {
    const bearer = local.createWalletPageToken(riderId, 'ride', JWT_SECRET, local.RIDE_PAGE_TOKEN_TTL_SECONDS);
    const raw = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = { method, headers: { authorization: `Bearer ${bearer}` }, async *[Symbol.asyncIterator]() { for (const c of raw) yield c; } };
    const res = { statusCode: 200, body: null, setHeader() {}, writeHead(code) { this.statusCode = code; return this; }, end(text) { this.body = text ? JSON.parse(text) : null; } };
    await handleRidePageRoute(req, res, deps, new URL(`http://x${path}`));
    return res;
  };
  await bidState.storePendingRoute(w.redis, riderId, {
    pickupLat: 6.6018, pickupLng: 3.3515, pickupAddress: 'Opebi', destLat: 6.4969, destLng: 3.3556, destAddress: 'Surulere',
    distanceKm: 12, durationSeconds: 1800, suggestedFareNgn: 7900, minOfferNgn: 7000, ratePerKmNgn: 400,
  });
  const found = await call('POST', '/ride-page/find', { amountNgn: 7900, autoAccept: true });
  assert.equal(found.body.phase, 'offers');
  assert.equal(found.body.autoAccept, true, 'the rider said yes at Find');
  const rideId = found.body.rideId;
  await searching(riderId, 7900, rideId);
  assert.equal((await call('POST', '/ride-page/auto-accept', { on: false })).body.autoAccept, false, 'an explicit off is kept');
  assert.equal((await call('POST', '/ride-page/auto-accept', { on: true })).body.autoAccept, true);

  const d = await driver();
  const row = await bid({ id: rideId, riderId }, d, 7600, 300);
  await bidState.addBid(w.redis, rideId, {
    bidId: row.id, driverId: d.id, driverUserId: d.userId, counterOfferNgn: 7600, driverName: 'Chinedu Okafor', driverRating: 4.9,
    vehiclePlate: 'KJA1', vehicleModel: 'Corolla', etaSeconds: 300, receivedAt: new Date().toISOString(),
  });
  await Promise.all([tryAutoAccept(w.deps, rideId), tryAutoAccept(w.deps, rideId)]);
  await tryAutoAccept(w.deps, rideId);
  assert.equal(accepted(w, rideId).length, 1);
  const state = await call('GET', '/ride-page/state');
  assert.equal(state.body.phase, 'confirmed');
  assert.equal(Number((await prisma.wallet.findUnique({ where: { userId: riderId } })).lockedNgn), 7600);
  // On the page: the chat waits until they leave it.
  assert.deepEqual((await pendingCatchup(w.redis, riderId)).map((item) => item.kind), ['ride_confirmed']);
});

test('ride page: Find without the rider\'s yes (an older page, or "No, I\'ll choose") never books; the switch still turns it on', async () => {
  const w = world();
  const riderId = await rider(10_000);
  const deps = { jwtSecret: JWT_SECRET, redisClient: w.redis, publisher: w.publisher, paymentsClient: {}, notifyChat: async () => {} };
  const call = async (method, path, body) => {
    const bearer = local.createWalletPageToken(riderId, 'ride', JWT_SECRET, local.RIDE_PAGE_TOKEN_TTL_SECONDS);
    const raw = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = { method, headers: { authorization: `Bearer ${bearer}` }, async *[Symbol.asyncIterator]() { for (const c of raw) yield c; } };
    const res = { statusCode: 200, body: null, setHeader() {}, writeHead(code) { this.statusCode = code; return this; }, end(text) { this.body = text ? JSON.parse(text) : null; } };
    await handleRidePageRoute(req, res, deps, new URL(`http://x${path}`));
    return res;
  };
  await bidState.storePendingRoute(w.redis, riderId, {
    pickupLat: 6.6018, pickupLng: 3.3515, pickupAddress: 'Opebi', destLat: 6.4969, destLng: 3.3556, destAddress: 'Surulere',
    distanceKm: 12, durationSeconds: 1800, suggestedFareNgn: 7900, minOfferNgn: 7000, ratePerKmNgn: 400,
  });
  const found = await call('POST', '/ride-page/find', { amountNgn: 7900 });
  assert.equal(found.body.autoAccept, false);
  const rideId = found.body.rideId;
  await searching(riderId, 7900, rideId);
  const d = await driver();
  const row = await bid({ id: rideId, riderId }, d, 7600, 300);
  await bidState.addBid(w.redis, rideId, {
    bidId: row.id, driverId: d.id, driverUserId: d.userId, counterOfferNgn: 7600, driverName: 'Chinedu Okafor', driverRating: 4.9,
    vehiclePlate: 'KJA1', vehicleModel: 'Corolla', etaSeconds: 300, receivedAt: new Date().toISOString(),
  });
  await handleRideEvent(counterOffer({ id: rideId, riderId }, d, row, 7600, 300), w.deps, new Map());
  assert.equal(accepted(w, rideId).length, 0, 'the rider chooses');
  assert.equal((await call('GET', '/ride-page/state')).body.phase, 'offers');
  // The switch (owner-checked) still works: on is their yes, and books the offer waiting.
  await call('POST', '/ride-page/auto-accept', { on: true });
  assert.equal(accepted(w, rideId).length, 1);
});
