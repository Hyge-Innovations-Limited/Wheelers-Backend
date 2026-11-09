// Round 6 of the audit (the re-audit of round 5), through the real entry
// points: the ride service's accept (createRideRequestedConsumer.handle), the
// gateway's events (handleRideEvent), and the page catch-up on the REAL local
// Redis. Against the local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/audit-round6.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { driverBidClient, walletClient, SEARCH_TIMED_OUT_REASON } = require('../packages/db/dist/index.js');
const { createRideRequestedConsumer } = require('../apps/ride-service/dist/consumers/ride-requested.consumer.js');
const { handleRideEvent, deliverPageCatchup } = require('../apps/api-gateway/dist/kafka/consumer.js');
const { handleRideMessage } = require('../apps/api-gateway/dist/websocket/handlers/ride.handler.js');
const { handleFlowAction } = require('../apps/api-gateway/dist/whatsapp-flows/flow-endpoint.js');
const { signFlowToken } = require('../apps/api-gateway/dist/whatsapp-flows/encryption.js');
const { RedisClient } = require('../apps/api-gateway/dist/redis/client.js');
const catchupLib = require('../apps/api-gateway/dist/whatsapp-flows/page-catchup.js');
const lockLib = require('../apps/api-gateway/dist/rides/booking-lock.js');
const bidState = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');

const prisma = new PrismaClient();
const JWT = 'test-secret-that-is-at-least-32-characters-long';
const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15';
const made = { users: [], rides: [], drivers: [] };
const realConsole = { ...console };
const realFetch = global.fetch;
const clients = [];
test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; });
test.afterEach(() => { Object.assign(console, realConsole); global.fetch = realFetch; });
test.after(async () => {
  for (const c of clients) await c.disconnect().catch(() => {});
  await prisma.rideHold.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.transaction.deleteMany({ where: { wallet: { userId: { in: made.users } } } });
  await prisma.driverBid.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } });
  await prisma.wallet.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

async function realRedis() {
  const client = new RedisClient(REDIS_URL);
  await client.connect();
  clients.push(client);
  return client;
}
function memoryRedis() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v) { store.set(k, v); },
    async del(k) { store.delete(k); },
    async setIfNotExists(k, v) { if (store.has(k)) return false; store.set(k, v); return true; },
    async send() { return null; },
  };
}
function metaCapture() {
  const sent = [];
  global.fetch = async (url, init) => {
    if (String(url).includes('graph.facebook.com')) { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ messages: [{ id: `wamid.${sent.length}` }] }), { status: 200 }); }
    return realFetch(url, init);
  };
  return { sent, messages: () => sent.filter((m) => m.type !== 'reaction'), reactions: () => sent.filter((m) => m.type === 'reaction') };
}
async function user(role) {
  const id = randomUUID();
  const phone = `+234805${Math.floor(1000000 + Math.random() * 8999999)}`;
  await prisma.user.create({ data: { id, privyDid: `test:r6:${id}`, role, name: `R6 ${role}`, phone } });
  made.users.push(id);
  return { id, phone };
}
async function rider(balanceNgn = 20_000) {
  const r = await user('RIDER');
  await prisma.wallet.create({ data: { userId: r.id, balanceNgn } });
  return r;
}
async function driver() {
  const u = await user('DRIVER');
  const d = await prisma.driver.create({ data: { userId: u.id, kycStatus: 'APPROVED', status: 'ONLINE', lastSeenAt: new Date(), lat: 6.52, lng: 3.38, vehicleModel: 'Corolla', vehiclePlate: 'KJA5' } });
  made.drivers.push(d.id);
  return { id: d.id, userId: u.id };
}
async function ride(riderId, extra = {}) {
  const r = await prisma.ride.create({ data: { riderId, channel: 'WHATSAPP', status: 'MATCHING', pickupLat: 6.5244, pickupLng: 3.387, pickupAddress: 'Akoka', destLat: 6.5095, destLng: 3.3711, destAddress: 'Yaba', riderOfferNgn: 3000, fareEstimateNgn: 3000, distanceKm: 3, ...extra } });
  made.rides.push(r.id);
  return r;
}
const publisherInto = (events) => ({ publishRideEvent: async (e) => { events.push(e); }, publishNotificationEvent: async (e) => { events.push(e); }, publishWalletEvent: async () => {}, publishDriverEvent: async () => {} });
const gatewayDeps = (redis, extra = {}) => ({
  registry: { sendToUser: async () => {}, isUserConnected: async () => true, hasUser: () => false },
  redisClient: redis, publisher: publisherInto([]), whatsappNotifier: { metaAccessToken: 't', metaPhoneNumberId: '1' }, ...extra,
});
async function whatsappRider(redis, r, rr) {
  await bidState.storeWhatsappRide(redis, rr.id, { riderId: r.id, phone: r.phone, pickupAddress: 'Akoka', destinationAddress: 'Yaba', offerNgn: 3000, suggestedFareNgn: 3000, paymentMethod: 'WALLET', createdAt: new Date().toISOString() });
  await bidState.setActiveRide(redis, r.id, rr.id);
  await bidState.setPhoneLookup(redis, r.id, r.phone);
}
function rideService() {
  const state = { onlineDrivers: new Map(), assignedDriversByRideId: new Map(), rideParticipantsByRideId: new Map(), gpsByRideId: new Map(), routeByRideId: new Map(), pendingMatchesByRideId: new Map() };
  const produced = [];
  const producer = new Proxy({}, { get: (_t, name) => async (payload) => { produced.push({ name: String(name), payload }); } });
  const consumer = createRideRequestedConsumer({ state, rideEnv: { MATCH_RADIUS_KM: '5', MAX_MATCH_ATTEMPTS: '200' }, rideEventsProducer: producer });
  return { produced, send: (event) => consumer.handle(JSON.stringify({ ...event, timestamp: event.timestamp ?? new Date().toISOString() }), { topic: 'ride.events' }) };
}


const cardDepsFor = (redis) => ({ redis, meta: { metaAccessToken: 't', metaPhoneNumberId: '1' } });
const cardLib = require('../apps/api-gateway/dist/trip-chat/card-status.js');
function socketCapture() {
  const sent = [];
  return { sent, registry: { sendToUser: async (userId, type, payload) => { sent.push({ userId, type, payload }); }, isUserConnected: async () => true, hasUser: () => true } };
}
const timedOut = () => ({ status: 'CANCELLED', cancelStage: 'BEFORE_MATCH', cancelReason: SEARCH_TIMED_OUT_REASON, cancelledAt: new Date() });
const holdOf = async (rideId) => (await prisma.rideHold.findUnique({ where: { rideId } }))?.status;

/* ── 1. The bid timeout waits for a booking in progress ─────────────── */

test('1 · RIDE_BID_TIMEOUT waits on the booking lock: an accept between its hold and its "sent" mark keeps its hold', async () => {
  const redis = memoryRedis();
  const r = await rider();
  const d = await driver();
  const rr = await ride(r.id);
  await whatsappRider(redis, r, rr);
  const meta = metaCapture();
  // An accept holds the lock and has made its hold, not yet marked "sent".
  const lock = await lockLib.takeBookingLock(redis, rr.id);
  const wallet = await prisma.wallet.findUnique({ where: { userId: r.id } });
  await walletClient.createRideHold({ rideId: rr.id, walletId: wallet.id, riderId: r.id, driverUserId: d.userId, amountNgn: 3000 });
  const timeout = handleRideEvent({ eventType: 'RIDE_BID_TIMEOUT', rideId: rr.id, riderId: r.id, timestamp: new Date().toISOString() }, gatewayDeps(redis), new Map());
  await new Promise((resolve) => setTimeout(resolve, 400));
  await lockLib.noteAcceptSent(redis, rr.id, d.userId);
  await lockLib.releaseBookingLock(redis, lock);
  await timeout;
  assert.equal(await holdOf(rr.id), 'ACTIVE', 'the hold stays');
  assert.equal(await lockLib.isSearchEnded(redis, rr.id), false);
  assert.equal(await bidState.getActiveRide(redis, r.id), rr.id, 'nothing cleaned up');
  assert.equal(meta.messages().length, 0, 'no "no driver"');
  assert.equal(await redis.get(lockLib.bookingLockKey(rr.id)), null, 'the accept\'s lock was let go, and the timeout took none it kept');
});

test('1 · RIDE_BID_TIMEOUT with an acceptance being published, or the lock never freed, releases nothing', async () => {
  const redis = memoryRedis();
  const r = await rider();
  const d = await driver();
  const rr = await ride(r.id);
  await whatsappRider(redis, r, rr);
  const wallet = await prisma.wallet.findUnique({ where: { userId: r.id } });
  await walletClient.createRideHold({ rideId: rr.id, walletId: wallet.id, riderId: r.id, driverUserId: d.userId, amountNgn: 3000 });
  const meta = metaCapture();
  const timeout = { eventType: 'RIDE_BID_TIMEOUT', rideId: rr.id, riderId: r.id, timestamp: new Date().toISOString() };
  await lockLib.notePublishing(redis, rr.id, d.userId);
  await handleRideEvent(timeout, gatewayDeps(redis), new Map());
  assert.equal(await holdOf(rr.id), 'ACTIVE', 'publishing: the hold stays');
  await lockLib.clearPublishing(redis, rr.id);
  const lock = await lockLib.takeBookingLock(redis, rr.id);
  await handleRideEvent(timeout, gatewayDeps(redis), new Map());
  assert.equal(await holdOf(rr.id), 'ACTIVE', 'lock busy past the wait: in flight, the hold stays');
  assert.equal(await lockLib.isSearchEnded(redis, rr.id), false);
  assert.equal(meta.messages().length, 0);
  assert.equal(await redis.get(lockLib.bookingLockKey(rr.id)), lock.token, 'the other holder\'s lock untouched');
  await lockLib.releaseBookingLock(redis, lock);
  // Nothing in flight: the timeout runs as before.
  await handleRideEvent(timeout, gatewayDeps(redis), new Map());
  assert.equal(await holdOf(rr.id), 'RELEASED');
  assert.equal(await lockLib.isSearchEnded(redis, rr.id), true);
  assert.equal(meta.messages().length, 1, '"no driver" once');
  assert.equal(await redis.get(lockLib.bookingLockKey(rr.id)), null, 'its own lock let go');
});

/* ── 2. driver_busy (and ride_closed) on a search that timed out meanwhile ── */

test('2 · the timeout stood aside for an acceptance, then the driver was busy: money back, marks gone, search ended, the chat told once', async () => {
  const redis = memoryRedis();
  const r = await rider();
  const d = await driver();
  const other = await rider();
  await ride(other.id, { status: 'DRIVER_ASSIGNED', driverId: d.id });    // the driver is on another trip
  const rr = await ride(r.id);
  await whatsappRider(redis, r, rr);
  const wallet = await prisma.wallet.findUnique({ where: { userId: r.id } });
  await walletClient.createRideHold({ rideId: rr.id, walletId: wallet.id, riderId: r.id, driverUserId: d.userId, amountNgn: 3000 });
  await lockLib.noteAcceptSent(redis, rr.id, d.userId);
  await bidState.setRideState(redis, rr.id, 'confirmed');
  await redis.set(`tripchat:card:${rr.id}`, JSON.stringify({ messageId: 'wamid.card', phone: r.phone, status: 'live' }));
  const meta = metaCapture();
  // The clock runs out with the acceptance sent: the gateway stands aside; the ride service cancels the row.
  await handleRideEvent({ eventType: 'RIDE_BID_TIMEOUT', rideId: rr.id, riderId: r.id, timestamp: new Date().toISOString() }, gatewayDeps(redis), new Map());
  assert.equal(await holdOf(rr.id), 'ACTIVE');
  await prisma.ride.update({ where: { id: rr.id }, data: timedOut() });
  // The ride service then finds the driver busy.
  const svc = rideService();
  await svc.send({ eventType: 'RIDE_OFFER_ACCEPTED', rideId: rr.id, riderId: r.id, driverId: d.id, driverUserId: d.userId, agreedFareNgn: 3000, paymentMethod: 'WALLET' });
  const failed = svc.produced.find((p) => p.name === 'rideAssignmentFailed').payload;
  assert.equal(failed.reason, 'driver_busy');
  await handleRideEvent(failed, gatewayDeps(redis), new Map());
  assert.equal(await holdOf(rr.id), 'RELEASED', 'the money goes back');
  assert.equal(await lockLib.acceptSentFor(redis, rr.id), null);
  assert.equal(await bidState.getRideState(redis, rr.id), null, 'no longer "confirmed"');
  assert.equal(await lockLib.isSearchEnded(redis, rr.id), true);
  assert.equal(await bidState.getActiveRide(redis, r.id), null);
  assert.equal(await cardLib.hasRideCard(redis, rr.id), false, 'the card\'s light off');
  const said = meta.messages().map((m) => JSON.stringify(m));
  assert.equal(said.length, 1);
  assert.match(said[0], /didn't go through/);
  // Delivered again: nothing more.
  redis.store.delete(`ride:${rr.id}:busy:${d.id}`);
  await handleRideEvent(failed, gatewayDeps(redis), new Map());
  assert.equal(meta.messages().length, 1);
  assert.equal(await redis.get(lockLib.bookingLockKey(rr.id)), null, 'its lock let go');
});

test('2 · same, on the ride page: no chat message (the card was in the chat: unsaid on leave); not told "booked": the timeout\'s message', async () => {
  const redis = memoryRedis();
  const r = await rider();
  const d = await driver();
  const rr = await ride(r.id, timedOut());
  await whatsappRider(redis, r, rr);
  const wallet = await prisma.wallet.findUnique({ where: { userId: r.id } });
  await walletClient.createRideHold({ rideId: rr.id, walletId: wallet.id, riderId: r.id, driverUserId: d.userId, amountNgn: 3000 });
  await lockLib.noteAcceptSent(redis, rr.id, d.userId);
  await bidState.setRideState(redis, rr.id, 'confirmed');
  await redis.set(`tripchat:card:${rr.id}`, JSON.stringify({ messageId: 'wamid.card', phone: r.phone, status: 'live' }));
  await bidState.markRidePageSeen(redis, r.id);
  const meta = metaCapture();
  const busy = { eventType: 'RIDE_ASSIGNMENT_FAILED', rideId: rr.id, riderId: r.id, driverId: d.id, driverUserId: d.userId, reason: 'driver_busy', timestamp: new Date().toISOString() };
  await handleRideEvent(busy, gatewayDeps(redis), new Map());
  assert.equal(meta.messages().length, 0, 'quiet on the page');
  assert.equal(await holdOf(rr.id), 'RELEASED');
  const waiting = (await catchupLib.pendingCatchup(redis, r.id)).filter((i) => i.kind === 'booking_failed');
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].ended, true);
  assert.equal(await deliverPageCatchup(gatewayDeps(redis), r.id, waiting[0]), true, 'said on leave (still cancelled)');

  // Not told "booked" (an app-style tap, no card, no "confirmed"): off the page, the timeout's own words.
  const r2 = await rider();
  const rr2 = await ride(r2.id, timedOut());
  await whatsappRider(redis, r2, rr2);
  const wallet2 = await prisma.wallet.findUnique({ where: { userId: r2.id } });
  await walletClient.createRideHold({ rideId: rr2.id, walletId: wallet2.id, riderId: r2.id, driverUserId: d.userId, amountNgn: 3000 });
  await lockLib.noteAcceptSent(redis, rr2.id, d.userId);
  const before = meta.messages().length;
  await handleRideEvent({ ...busy, rideId: rr2.id, riderId: r2.id }, gatewayDeps(redis), new Map());
  assert.equal(await holdOf(rr2.id), 'RELEASED');
  assert.equal(meta.messages().length, before + 1);
  assert.match(JSON.stringify(meta.messages().at(-1)), /No driver took/);
});

test('2 · an app rider hears ride:bid_timeout; another driver\'s booking in flight is left alone', async () => {
  const redis = memoryRedis();
  const r = await rider();
  const d = await driver();
  const b = await driver();
  const rr = await ride(r.id, { ...timedOut(), channel: 'APP' });
  const wallet = await prisma.wallet.findUnique({ where: { userId: r.id } });
  await walletClient.createRideHold({ rideId: rr.id, walletId: wallet.id, riderId: r.id, driverUserId: d.userId, amountNgn: 3000 });
  await lockLib.noteAcceptSent(redis, rr.id, d.userId);
  const sock = socketCapture();
  const busy = { eventType: 'RIDE_ASSIGNMENT_FAILED', rideId: rr.id, riderId: r.id, driverId: d.id, driverUserId: d.userId, reason: 'driver_busy', timestamp: new Date().toISOString() };
  await handleRideEvent(busy, gatewayDeps(redis, { registry: sock.registry }), new Map());
  assert.equal(await holdOf(rr.id), 'RELEASED');
  assert.ok(sock.sent.some((s) => s.userId === r.id && s.type === 'ride:bid_timeout'), 'the app is told the search ended');
  assert.equal(await lockLib.isSearchEnded(redis, rr.id), true);

  // Another driver's acceptance is out on a second ride: this driver's busy leaves it be.
  const rr2 = await ride(r.id, { ...timedOut(), channel: 'APP' });
  await walletClient.createRideHold({ rideId: rr2.id, walletId: wallet.id, riderId: r.id, driverUserId: b.userId, amountNgn: 3000 });
  await lockLib.noteAcceptSent(redis, rr2.id, b.userId);
  await handleRideEvent({ ...busy, rideId: rr2.id }, gatewayDeps(redis, { registry: sock.registry }), new Map());
  assert.equal(await holdOf(rr2.id), 'ACTIVE', 'B\'s hold stays');
  assert.equal(await lockLib.acceptSentFor(redis, rr2.id), b.userId);
  assert.equal(await lockLib.isSearchEnded(redis, rr2.id), false);
});

test('2 · ride_closed on a search only the clock ended (an older ride service): the search ends and the app hears it', async () => {
  const redis = memoryRedis();
  const r = await rider();
  const d = await driver();
  const rr = await ride(r.id, { ...timedOut(), channel: 'APP' });
  const wallet = await prisma.wallet.findUnique({ where: { userId: r.id } });
  await walletClient.createRideHold({ rideId: rr.id, walletId: wallet.id, riderId: r.id, driverUserId: d.userId, amountNgn: 3000 });
  await lockLib.noteAcceptSent(redis, rr.id, d.userId);
  const sock = socketCapture();
  await handleRideEvent({ eventType: 'RIDE_ASSIGNMENT_FAILED', rideId: rr.id, riderId: r.id, driverId: d.id, driverUserId: d.userId, reason: 'ride_closed', timestamp: new Date().toISOString() }, gatewayDeps(redis, { registry: sock.registry }), new Map());
  assert.equal(await holdOf(rr.id), 'RELEASED');
  assert.equal(await lockLib.acceptSentFor(redis, rr.id), null);
  assert.equal(await lockLib.isSearchEnded(redis, rr.id), true);
  assert.ok(sock.sent.some((s) => s.userId === r.id && s.type === 'ride:bid_timeout'));
});

/* ── 3. "Driver outside" once per driver ────────────────────────────── */

test('3 · a second driver arriving after the first pulled out is said; a redelivery for the same driver is not', async () => {
  const redis = memoryRedis();
  const r = await rider();
  const a = await driver();
  const b = await driver();
  const rr = await ride(r.id, { status: 'ARRIVED', driverId: a.id });
  await whatsappRider(redis, r, rr);
  const meta = metaCapture();
  const arrived = (driverId) => ({ eventType: 'RIDE_ARRIVED', rideId: rr.id, riderId: r.id, driverId, timestamp: new Date().toISOString() });
  await handleRideEvent(arrived(a.id), gatewayDeps(redis), new Map());
  const first = meta.messages().length;
  assert.ok(first >= 1);
  await handleRideEvent(arrived(a.id), gatewayDeps(redis), new Map());
  assert.equal(meta.messages().length, first, 'redelivered: nothing more');
  await prisma.ride.update({ where: { id: rr.id }, data: { driverId: b.id } });
  await handleRideEvent(arrived(b.id), gatewayDeps(redis), new Map());
  assert.ok(meta.messages().length > first, 'the second driver outside is said');
});

/* ── 4. The card record goes even when Meta refuses the reaction ──────── */

test('4 · a booking falls through and Meta refuses the reaction removal: the card record still goes (the next card is not suppressed)', async () => {
  const redis = memoryRedis();
  const r = await rider();
  const d = await driver();
  const rr = await ride(r.id);
  await whatsappRider(redis, r, rr);
  await bidState.setRideState(redis, rr.id, 'confirmed');
  await redis.set(`tripchat:card:${rr.id}`, JSON.stringify({ messageId: 'wamid.card', phone: r.phone, status: 'live' }));
  const reactions = [];
  global.fetch = async (url, init) => {
    if (String(url).includes('graph.facebook.com')) {
      const body = JSON.parse(init.body);
      if (body.type === 'reaction') { reactions.push(body); return new Response('{"error":{}}', { status: 400 }); }
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.x' }] }), { status: 200 });
    }
    return realFetch(url, init);
  };
  await handleRideEvent({ eventType: 'RIDE_ASSIGNMENT_FAILED', rideId: rr.id, riderId: r.id, driverId: d.id, driverUserId: d.userId, reason: 'driver_busy', timestamp: new Date().toISOString() }, gatewayDeps(redis), new Map());
  assert.equal(reactions.length, 1, 'removal asked');
  assert.equal(await cardLib.hasRideCard(redis, rr.id), false, 'record gone although Meta refused');
  // A status other than 'none' refused by Meta still keeps the record as it was.
  await redis.set(`tripchat:card:${rr.id}`, JSON.stringify({ messageId: 'wamid.card', phone: r.phone, status: 'live' }));
  assert.equal(await cardLib.setCardStatus(cardDepsFor(redis), rr.id, 'message'), false);
  assert.equal(await cardLib.cardStatusOf(redis, rr.id), 'live');
});

/* ── 5. A failed card in the catch-up is put back even when a lesser message went ── */

test('5 · the catch-up on real Redis: the card throws, "driver outside" goes, the card is put back and goes on the next look', async () => {
  const redis = await realRedis();
  const userId = randomUUID();
  await catchupLib.deferUntilPageLeft(redis, userId, { kind: 'arrived', rideId: 'r1' });
  await catchupLib.deferUntilPageLeft(redis, userId, { kind: 'ride_confirmed', rideId: 'r1', event: { n: 1 } });
  await catchupLib.deferUntilPageLeft(redis, userId, { kind: 'search_started', rideId: 'r1', event: {} });
  const delivered = [];
  let fail = true;
  const deliver = async (_id, item) => { if (fail && item.kind === 'ride_confirmed') throw new Error('Meta down'); delivered.push(item.kind); return true; };
  await catchupLib.deliverCatchup({ redis, deliver }, userId);
  assert.deepEqual(delivered, ['arrived']);
  assert.deepEqual((await catchupLib.pendingCatchup(redis, userId)).map((i) => i.kind), ['ride_confirmed'], 'the card is owed; the lesser search_started is not put back');
  assert.notEqual(await redis.send('ZSCORE', 'ride_page:catchup_due', userId), null, 'looked at again');
  fail = false;
  delivered.length = 0;
  await catchupLib.deliverCatchup({ redis, deliver }, userId);
  assert.deepEqual(delivered, ['ride_confirmed']);
  assert.deepEqual(await catchupLib.pendingCatchup(redis, userId), []);
  await redis.send('ZREM', 'ride_page:catchup_due', userId);
});
