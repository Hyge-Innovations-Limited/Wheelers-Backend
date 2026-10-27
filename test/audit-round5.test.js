// Round 5 of the audit, through the real entry points: the ride service's
// accept and bail (createRideRequestedConsumer.handle), the gateway's events
// (handleRideEvent), the app's socket (handleRideMessage), the WhatsApp forms
// (handleFlowAction), and the page catch-up on the REAL local Redis (its list,
// script and sorted set, not a stand-in). Against the local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/audit-round5.test.js

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
  await prisma.user.create({ data: { id, privyDid: `test:r5:${id}`, role, name: `R5 ${role}`, phone } });
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

/* ── MONEY ───────────────────────────────────────────────────────────── */

test('M1 · an accept on a search that only timed out is assigned (the ride revives), not refused as closed', async () => {
  const r = await rider();
  const d = await driver();
  const rr = await ride(r.id, { status: 'CANCELLED', cancelStage: 'BEFORE_MATCH', cancelReason: SEARCH_TIMED_OUT_REASON, cancelledAt: new Date() });
  const svc = rideService();
  await svc.send({ eventType: 'RIDE_OFFER_ACCEPTED', rideId: rr.id, riderId: r.id, driverId: d.id, driverUserId: d.userId, agreedFareNgn: 3000, paymentMethod: 'WALLET' });
  assert.deepEqual(svc.produced.map((p) => p.name), ['rideDriverAssigned']);

  const byRider = await ride(r.id, { status: 'CANCELLED', cancelStage: 'BEFORE_MATCH', cancelReason: 'My plans changed', cancelledAt: new Date() });
  await svc.send({ eventType: 'RIDE_OFFER_ACCEPTED', rideId: byRider.id, riderId: r.id, driverId: d.id, driverUserId: d.userId, agreedFareNgn: 3000, paymentMethod: 'WALLET' });
  assert.equal(svc.produced.at(-1).payload.reason, 'ride_closed', 'a rider\'s own cancel stays closed');
});

test('M1 · a WhatsApp rider told "booked" hears once that it did not go through when the ride had closed', async () => {
  const redis = memoryRedis();
  const r = await rider();
  const d = await driver();
  const rr = await ride(r.id, { status: 'CANCELLED', cancelReason: 'My plans changed' });
  await whatsappRider(redis, r, rr);
  await bidState.setRideState(redis, rr.id, 'confirmed');
  const meta = metaCapture();
  const failed = { eventType: 'RIDE_ASSIGNMENT_FAILED', rideId: rr.id, riderId: r.id, driverId: d.id, driverUserId: d.userId, reason: 'ride_closed', timestamp: new Date().toISOString() };
  await handleRideEvent(failed, gatewayDeps(redis), new Map());
  await bidState.setRideState(redis, rr.id, 'confirmed');
  await handleRideEvent(failed, gatewayDeps(redis), new Map());
  assert.equal(meta.messages().filter((m) => /didn't go through/.test(JSON.stringify(m))).length, 1);
});

test('M6 · a redelivered driver bail never reopens a ride another driver has, and reopens nothing twice', async () => {
  const r = await rider();
  const a = await driver();
  const b = await driver();
  const rr = await ride(r.id, { status: 'DRIVER_ASSIGNED', driverId: a.id });
  const svc = rideService();
  const bail = { eventType: 'RIDE_CANCELLED', rideId: rr.id, riderId: r.id, driverId: a.id, cancelledBy: 'driver', reason: 'Car trouble', timestamp: new Date().toISOString() };
  await svc.send(bail);
  assert.equal((await prisma.ride.findUnique({ where: { id: rr.id } })).status, 'MATCHING');
  await prisma.ride.update({ where: { id: rr.id }, data: { status: 'DRIVER_ASSIGNED', driverId: b.id } });
  await svc.send(bail);
  const after = await prisma.ride.findUnique({ where: { id: rr.id } });
  assert.deepEqual([after.status, after.driverId], ['DRIVER_ASSIGNED', b.id], 'B keeps the ride');
});

test('M2 · the search clock running out just as an acceptance went out leaves the booking alone', async () => {
  const redis = memoryRedis();
  const r = await rider();
  const d = await driver();
  const rr = await ride(r.id);
  await whatsappRider(redis, r, rr);
  const wallet = await prisma.wallet.findUnique({ where: { userId: r.id } });
  await walletClient.createRideHold({ rideId: rr.id, walletId: wallet.id, riderId: r.id, driverUserId: d.userId, amountNgn: 3000 });
  await lockLib.noteAcceptSent(redis, rr.id, d.userId);
  const meta = metaCapture();
  await handleRideEvent({ eventType: 'RIDE_BID_TIMEOUT', rideId: rr.id, riderId: r.id, timestamp: new Date().toISOString() }, gatewayDeps(redis), new Map());
  assert.equal((await prisma.rideHold.findUnique({ where: { rideId: rr.id } })).status, 'ACTIVE', 'the hold stays');
  assert.equal(await bidState.getActiveRide(redis, r.id), rr.id, 'nothing cleaned up');
  assert.equal(meta.messages().length, 0, 'no "no driver"');
});

test('M3/W9 · the offers form\'s cancel ends the search for auto-accept and is said once (by the form, not again by the event)', async () => {
  const redis = memoryRedis();
  const events = [];
  const r = await rider();
  const rr = await ride(r.id);
  await whatsappRider(redis, r, rr);
  const told = [];
  const deps = { redisClient: redis, publisher: publisherInto(events), tokenSecret: JWT, privateKeyPem: '', googleMapsApiKey: '', routePlanner: {}, onSearchCancelled: async (id) => { told.push(id); } };
  await handleFlowAction({ action: 'data_exchange', screen: 'CANCEL_SEARCH', flow_token: signFlowToken(`bids:${r.id}`, JWT), data: { reason: '1' } }, deps);
  assert.equal(await lockLib.isSearchEnded(redis, rr.id), true);
  assert.deepEqual(told, [r.id]);
  const meta = metaCapture();
  await handleRideEvent(events.find((e) => e.eventType === 'RIDE_CANCELLED'), gatewayDeps(redis), new Map());
  assert.equal(meta.messages().length, 0, 'the event says nothing more');
});

test('M4 · the old WhatsApp form never books at a price the rider did not see', async () => {
  const redis = memoryRedis();
  const events = [];
  const r = await rider();
  const d = await driver();
  const rr = await ride(r.id);
  await whatsappRider(redis, r, rr);
  await bidState.addBid(redis, rr.id, { driverId: d.id, driverUserId: d.userId, counterOfferNgn: 3500, driverName: 'Ade', driverRating: 5, vehiclePlate: 'KJA5', vehicleModel: 'Corolla', etaSeconds: 300, receivedAt: new Date().toISOString() });
  const deps = { redisClient: redis, publisher: publisherInto(events), tokenSecret: JWT, privateKeyPem: '', googleMapsApiKey: '', routePlanner: {} };
  const screen = await handleFlowAction({ action: 'data_exchange', screen: 'BID_LIST', flow_token: signFlowToken(`${rr.id}:${r.id}`, JWT), data: { bid_action: 'accept', selected_bid: `bid-${d.id}@3000` } }, deps);
  assert.equal(screen.screen, 'BID_LIST');
  assert.match(JSON.stringify(screen.data), /changed their price to ₦3,500/);
  assert.equal(events.filter((e) => e.eventType === 'RIDE_OFFER_ACCEPTED').length, 0);
  assert.equal(await prisma.rideHold.count({ where: { rideId: rr.id } }), 0);
});

test('M5/R1 · the app\'s accept needs the driver\'s open bid; a changed price comes back with the offer as it stands', async () => {
  const redis = memoryRedis();
  const r = await rider();
  const d = await driver();
  const rr = await ride(r.id, { channel: 'APP' });
  await driverBidClient.record({ rideId: rr.id, driverId: d.id, driverUserId: d.userId, riderId: r.id, amountNgn: 3600, etaSeconds: 240, distanceKm: 1.5 });
  const answer = await handleRideMessage('ride:accept_offer', { rideId: rr.id, driverId: d.id, driverUserId: 'someone-else', agreedFareNgn: 3000, paymentMethod: 'wallet' }, { userId: r.id, role: 'RIDER' }, publisherInto([]), {}, redis);
  assert.equal(answer.payload.reason, 'offer_changed');
  assert.deepEqual([answer.payload.counterOffer.counterOfferNgn, answer.payload.counterOffer.driverUserId, answer.payload.counterOffer.driverId], [3600, d.userId, d.id], 'the driver\'s own user, never the app\'s');
});

test('M7 · a hold whose acceptance is still being published is never taken for stale', async () => {
  const redis = memoryRedis();
  const r = await rider();
  const a = await driver();
  const rr = await ride(r.id);
  const wallet = await prisma.wallet.findUnique({ where: { userId: r.id } });
  await walletClient.createRideHold({ rideId: rr.id, walletId: wallet.id, riderId: r.id, driverUserId: a.userId, amountNgn: 3000 });
  await prisma.$executeRaw`UPDATE "RideHold" SET "updatedAt" = now() - interval '60 seconds' WHERE "rideId" = ${rr.id}`;
  await lockLib.notePublishing(redis, rr.id, a.userId);
  assert.equal(await lockLib.releaseStaleHoldForOther(redis, rr.id, 'another-driver'), 'blocked');
  await lockLib.clearPublishing(redis, rr.id);
  assert.equal(await lockLib.releaseStaleHoldForOther(redis, rr.id, 'another-driver'), 'released');
});

/* ── MESSAGES (page catch-up on the real Redis) ─────────────────────── */

test('W1/W3/W11/R5 · the catch-up on real Redis: list + script + due set; one message (the card first when none was sent); a failed delivery is kept; riders with list items are requeued at start', async () => {
  const redis = await realRedis();
  const userId = randomUUID();
  await catchupLib.deferUntilPageLeft(redis, userId, { kind: 'search_started', rideId: 'r1', event: {} });
  await catchupLib.deferUntilPageLeft(redis, userId, { kind: 'arrived', rideId: 'r1' });
  await catchupLib.deferUntilPageLeft(redis, userId, { kind: 'ride_confirmed', rideId: 'r1', event: {} });
  await catchupLib.deferUntilPageLeft(redis, userId, { kind: 'ride_confirmed', rideId: 'r1', event: { newest: true } });
  assert.deepEqual((await catchupLib.pendingCatchup(redis, userId)).map((i) => i.kind), ['search_started', 'arrived', 'ride_confirmed'], 'one of each per ride, newest kept');

  // R5: a rider with items is found again at start.
  await redis.send('ZREM', 'ride_page:catchup_due', userId);
  assert.ok(await catchupLib.requeueWaitingRiders(redis) >= 1);
  assert.notEqual(await redis.send('ZSCORE', 'ride_page:catchup_due', userId), null);

  // The first delivery throws: kept for the next look; then the card goes, alone.
  const delivered = [];
  let fail = true;
  const deliver = async (_id, item) => { if (fail && item.kind === 'ride_confirmed') throw new Error('Meta down'); delivered.push(item); return true; };
  await catchupLib.deliverCatchup({ redis, deliver }, userId);
  assert.deepEqual(delivered.map((i) => i.kind), ['arrived'], 'the card failed: the next most important went');
  fail = false;
  delivered.length = 0;
  await catchupLib.deferUntilPageLeft(redis, userId, { kind: 'ride_confirmed', rideId: 'r1', event: { newest: true } });
  await catchupLib.deliverCatchup({ redis, deliver }, userId);
  assert.deepEqual(delivered.map((i) => [i.kind, i.event?.newest]), [['ride_confirmed', true]]);
  assert.deepEqual(await catchupLib.pendingCatchup(redis, userId), [], 'taken');
  await redis.send('ZREM', 'ride_page:catchup_due', userId);
});

test('W7 · a system cancellation while on the page waits for them to leave, is said if still cancelled, and only once', async () => {
  const redis = memoryRedis();
  const r = await rider();
  const rr = await ride(r.id, { status: 'CANCELLED' });
  await whatsappRider(redis, r, rr);
  await bidState.markRidePageSeen(redis, r.id);
  const meta = metaCapture();
  const cancel = { eventType: 'RIDE_CANCELLED', rideId: rr.id, riderId: r.id, cancelledBy: 'system', reason: 'Admin cancelled', timestamp: new Date().toISOString() };
  await handleRideEvent(cancel, gatewayDeps(redis), new Map());
  await handleRideEvent(cancel, gatewayDeps(redis), new Map());
  assert.equal(meta.messages().length, 0);
  const waiting = (await catchupLib.pendingCatchup(redis, r.id)).filter((i) => i.kind === 'cancelled');
  assert.equal(waiting.length, 1);
  assert.equal(await deliverPageCatchup(gatewayDeps(redis), r.id, waiting[0]), true);
  assert.equal(meta.messages().length, 1);
});

test('W4/W5 · the receipt is sent once however often the trip ends; "₦X received" is not sent on the page, and once off it', async () => {
  const redis = memoryRedis();
  const r = await rider();
  const d = await driver();
  const rr = await ride(r.id, { status: 'COMPLETED', driverId: d.id });
  await whatsappRider(redis, r, rr);
  const meta = metaCapture();
  const done = { eventType: 'RIDE_COMPLETED', rideId: rr.id, riderId: r.id, driverId: d.id, driverUserId: d.userId, fareNgn: 3000, distanceKm: 3, durationSeconds: 900, paymentMethod: 'WALLET', completedAt: new Date().toISOString(), timestamp: new Date().toISOString() };
  await handleRideEvent(done, gatewayDeps(redis), new Map());
  const afterFirst = meta.messages().length;
  await handleRideEvent(done, gatewayDeps(redis), new Map());
  assert.ok(afterFirst >= 1);
  assert.equal(meta.messages().length, afterFirst, 'delivered again: no second receipt');

  const { startGatewayKafkaConsumer } = require('../apps/api-gateway/dist/kafka/consumer.js');
  let handler;
  await startGatewayKafkaConsumer({ consumer: { subscribe: async (_topics, fn) => { handler = fn; } }, ...gatewayDeps(redis) });
  const credit = { eventType: 'WALLET_CREDITED', userId: r.id, walletId: randomUUID(), amountNgn: 2000, newBalanceNgn: 22000, creditType: 'deposit', referenceId: `ref-${randomUUID()}`, timestamp: new Date().toISOString() };
  const before = meta.messages().length;
  await bidState.markRidePageSeen(redis, r.id);
  await handler(credit, { topic: 'wallet.events' });
  assert.equal(meta.messages().length, before, 'on the page: the page shows the balance');
  redis.store.delete(`whatsapp:user:${r.id}:ride_page_seen`);
  const credit2 = { ...credit, referenceId: `ref-${randomUUID()}` };
  await handler(credit2, { topic: 'wallet.events' });
  await handler(credit2, { topic: 'wallet.events' });
  assert.equal(meta.messages().length, before + 1, 'off the page: once per deposit');
});

test('W10 · a decline while on the page puts the offer count right when they leave, not live', async () => {
  const redis = memoryRedis();
  const r = await rider();
  const rr = await ride(r.id);
  await whatsappRider(redis, r, rr);
  await redis.set(`offers:page:message:${rr.id}`, JSON.stringify({ phone: r.phone, messageId: 'wamid.bid', count: 2 }));
  await bidState.markRidePageSeen(redis, r.id);
  const meta = metaCapture();
  await handleRideEvent({ eventType: 'RIDE_BIDS_DECLINED', rideId: rr.id, riderId: r.id, driverUserIds: [], remainingOffers: 0, timestamp: new Date().toISOString() }, gatewayDeps(redis), new Map());
  assert.equal(meta.reactions().length, 0);
  assert.deepEqual((await catchupLib.pendingCatchup(redis, r.id)).map((i) => i.kind), ['offer_count'], 'put right on leave');
  // Off the page: live, as before.
  redis.store.delete(`whatsapp:user:${r.id}:ride_page_seen`);
  await handleRideEvent({ eventType: 'RIDE_BIDS_DECLINED', rideId: rr.id, riderId: r.id, driverUserIds: [], remainingOffers: 0, timestamp: new Date().toISOString() }, gatewayDeps(redis), new Map());
  assert.equal(meta.reactions().length, 1);
});

test('W2 · back in the chat with "Your bid is in" still waiting: the next offer delivers that one message, not an offers message before it', async () => {
  const redis = memoryRedis();
  const r = await rider();
  const d = await driver();
  const rr = await ride(r.id);
  await whatsappRider(redis, r, rr);
  await catchupLib.deferUntilPageLeft(redis, r.id, { kind: 'search_started', rideId: rr.id, event: { kind: 'search_started', userId: r.id, phone: r.phone, rideId: rr.id } });
  const said = [];
  const meta = metaCapture();
  const offer = { eventType: 'RIDE_COUNTER_OFFER', rideId: rr.id, riderId: r.id, driverId: d.id, driverUserId: d.userId, counterOfferNgn: 3000, driverName: 'Ade', driverRating: 5, vehiclePlate: 'KJA5', vehicleModel: 'Corolla', etaSeconds: 300, timestamp: new Date().toISOString() };   // no server position: left to the rider, not auto-booked
  await handleRideEvent(offer, gatewayDeps(redis, { ridePageChat: async (event) => { said.push(event.kind); } }), new Map());
  assert.deepEqual(said, ['search_started']);
  assert.equal(meta.messages().length, 0, 'no offers message before it');
  assert.deepEqual(await catchupLib.pendingCatchup(redis, r.id), []);
});

test('W8 · a booking whose card was in the chat falls through while the rider is on the page: unsaid when they leave', async () => {
  const redis = memoryRedis();
  const r = await rider();
  const d = await driver();
  const rr = await ride(r.id);
  await whatsappRider(redis, r, rr);
  await bidState.setRideState(redis, rr.id, 'confirmed');
  await bidState.storeAcceptedBid(redis, rr.id, { driverName: 'Ade', driverPhone: '', driverUserId: d.userId, vehicleModel: 'Corolla', vehiclePlate: 'KJA5', vehicleColor: '', driverRating: 5, totalRides: 1, etaSeconds: 300, fareNgn: 3000 });
  await redis.set(`tripchat:card:${rr.id}`, JSON.stringify({ messageId: 'wamid.card', phone: r.phone, status: 'live' }));
  await bidState.markRidePageSeen(redis, r.id);
  const meta = metaCapture();
  await handleRideEvent({ eventType: 'RIDE_ASSIGNMENT_FAILED', rideId: rr.id, riderId: r.id, driverId: d.id, driverUserId: d.userId, reason: 'driver_busy', timestamp: new Date().toISOString() }, gatewayDeps(redis), new Map());
  assert.equal(meta.messages().length, 0);
  const waiting = (await catchupLib.pendingCatchup(redis, r.id)).filter((i) => i.kind === 'booking_failed');
  assert.equal(waiting.length, 1);
  assert.match(waiting[0].text, /couldn't take this ride after all/);
  assert.deepEqual(meta.reactions().map((m) => m.reaction.emoji), [''], 'the card\'s light goes off');
});

test('R3 · the old form\'s offers message while on the page waits for them to leave', async () => {
  const redis = memoryRedis();
  const r = await rider();
  const d = await driver();
  const rr = await ride(r.id);
  await bidState.storeWhatsappRide(redis, rr.id, { riderId: r.id, phone: r.phone, source: 'flow', pickupAddress: 'Akoka', destinationAddress: 'Yaba', offerNgn: 3000, suggestedFareNgn: 3000, paymentMethod: 'WALLET', createdAt: new Date().toISOString() });
  await bidState.setActiveRide(redis, r.id, rr.id);
  await bidState.setPhoneLookup(redis, r.id, r.phone);
  await bidState.markRidePageSeen(redis, r.id);
  const meta = metaCapture();
  await handleRideEvent({ eventType: 'RIDE_COUNTER_OFFER', rideId: rr.id, riderId: r.id, driverId: d.id, driverUserId: d.userId, counterOfferNgn: 3000, driverName: 'Ade', driverRating: 5, vehiclePlate: 'KJA5', vehicleModel: 'Corolla', etaSeconds: 300, timestamp: new Date().toISOString() }, gatewayDeps(redis), new Map());
  assert.equal(meta.messages().length, 0);
  assert.deepEqual((await catchupLib.pendingCatchup(redis, r.id)).map((i) => i.kind), ['legacy_offers']);
});
