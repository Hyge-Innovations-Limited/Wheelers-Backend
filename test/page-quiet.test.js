// The whole-branch audit: a rider is never booked at a price they did not see;
// Quick Actions' Book a ride reaches the ride page through the real form
// endpoint; while the rider is on the ride page the chat stays quiet (trip
// chat and calls, a deposit booking their driver, a driver pulling out) and
// catches up with ONE message when they leave; a redelivered bail never
// touches the next driver's booking; an auto booking said in the chat is
// unsaid when it falls through. Against the local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/page-quiet.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { driverBidClient, walletClient } = require('../packages/db/dist/index.js');
const { handleRidePageRoute } = require('../apps/api-gateway/dist/http/ride-page.route.js');
const { handleFlowAction } = require('../apps/api-gateway/dist/whatsapp-flows/flow-endpoint.js');
const { signFlowToken } = require('../apps/api-gateway/dist/whatsapp-flows/encryption.js');
const { confirmRideWithOffer } = require('../apps/api-gateway/dist/rides/whatsapp-ride.service.js');
const { handleRideEvent, deliverPageCatchup } = require('../apps/api-gateway/dist/kafka/consumer.js');
const { createWhatsappDepositFinisher } = require('../apps/api-gateway/dist/whatsapp/ride-card.js');
const { createTripWhatsapp } = require('../apps/api-gateway/dist/trip-chat/whatsapp.js');
const { rememberRideCard } = require('../apps/api-gateway/dist/trip-chat/card-status.js');
const { createPageCatchup, pendingCatchup } = require('../apps/api-gateway/dist/whatsapp-flows/page-catchup.js');
const lockLib = require('../apps/api-gateway/dist/rides/booking-lock.js');
const bidState = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');
const local = require('../apps/api-gateway/dist/auth/local.js');

const prisma = new PrismaClient();
const JWT = 'test-secret-that-is-at-least-32-characters-long';
const made = { users: [], rides: [], drivers: [] };
const realConsole = { ...console };
const realFetch = global.fetch;
test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; });
test.afterEach(() => { Object.assign(console, realConsole); global.fetch = realFetch; });
test.after(async () => {
  await prisma.rideHold.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.transaction.deleteMany({ where: { wallet: { userId: { in: made.users } } } });
  await prisma.driverBid.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } });
  await prisma.wallet.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

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
/** Every message to Meta, and reactions apart. */
function metaCapture() {
  const sent = [];
  global.fetch = async (url, init) => {
    if (String(url).includes('graph.facebook.com')) { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ messages: [{ id: `wamid.${sent.length}` }] }), { status: 200 }); }
    return realFetch(url, init);
  };
  return { sent, messages: () => sent.filter((m) => m.type !== 'reaction'), reactions: () => sent.filter((m) => m.type === 'reaction') };
}
async function user(role, phone = `+234803${Math.floor(1000000 + Math.random() * 8999999)}`) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:quiet:${id}`, role, name: `Quiet ${role}`, phone } });
  made.users.push(id);
  return { id, phone };
}
async function rider(balanceNgn) {
  const r = await user('RIDER');
  await prisma.wallet.create({ data: { userId: r.id, balanceNgn } });
  return r;
}
async function driver() {
  const u = await user('DRIVER');
  const d = await prisma.driver.create({ data: { userId: u.id, kycStatus: 'APPROVED', status: 'ONLINE', lastSeenAt: new Date(), vehicleModel: 'Corolla', vehiclePlate: 'KJA1' } });
  made.drivers.push(d.id);
  return { id: d.id, userId: u.id };
}
async function ride(riderId, extra = {}) {
  const r = await prisma.ride.create({ data: { riderId, channel: 'WHATSAPP', status: 'MATCHING', pickupLat: 6.6, pickupLng: 3.35, pickupAddress: 'Opebi', destLat: 6.5, destLng: 3.36, destAddress: 'Surulere', riderOfferNgn: 3000, fareEstimateNgn: 3000, ...extra } });
  made.rides.push(r.id);
  return r;
}
async function whatsappSearch(redis, r, riderRow, bids) {
  await bidState.storeWhatsappRide(redis, r.id, { riderId: riderRow.id, phone: riderRow.phone, pickupAddress: 'Opebi', destinationAddress: 'Surulere', offerNgn: 3000, suggestedFareNgn: 3000, paymentMethod: 'WALLET', createdAt: new Date().toISOString() });
  await bidState.setActiveRide(redis, riderRow.id, r.id);
  await bidState.setPhoneLookup(redis, riderRow.id, riderRow.phone);
  const out = [];
  for (const [d, price] of bids) {
    const row = await driverBidClient.record({ rideId: r.id, driverId: d.id, driverUserId: d.userId, riderId: riderRow.id, amountNgn: price, etaSeconds: 300, distanceKm: 2 });
    await bidState.addBid(redis, r.id, { bidId: row.id, driverId: d.id, driverUserId: d.userId, counterOfferNgn: price, driverName: 'Ada', driverRating: 5, vehiclePlate: 'KJA1', vehicleModel: 'Corolla', etaSeconds: 300, distanceKm: 2, receivedAt: new Date().toISOString() });
    out.push(row);
  }
  return out;
}
const publisherInto = (events) => ({ publishRideEvent: async (e) => { events.push(e); }, publishNotificationEvent: async () => {}, publishWalletEvent: async () => {}, publishDriverEvent: async () => {} });

/* ── 1. never booked at a price not seen ─────────────────────────────── */

test('the ride page and the chat never book at a price the rider did not see: refused as changed, nothing held', async () => {
  const redis = memoryRedis();
  const events = [];
  const r = await rider(20_000);
  const d = await driver();
  const rr = await ride(r.id);
  const [row] = await whatsappSearch(redis, rr, r, [[d, 3500]]);
  const deps = { jwtSecret: JWT, redisClient: redis, publisher: publisherInto(events), paymentsClient: {} };
  const bearer = local.createWalletPageToken(r.id, 'ride', JWT, local.RIDE_PAGE_TOKEN_TTL_SECONDS);
  const req = { method: 'POST', headers: { authorization: `Bearer ${bearer}` }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ key: row.id, priceNgn: 3000 })); } };
  const res = { statusCode: 200, body: null, setHeader() {}, writeHead(code) { this.statusCode = code; return this; }, end(text) { this.body = text ? JSON.parse(text) : null; } };
  await handleRidePageRoute(req, res, deps, new URL('http://x/ride-page/accept'));
  assert.deepEqual([res.statusCode, res.body.code, res.body.fareNgn], [409, 'OFFER_CHANGED', 3500]);
  assert.equal((await confirmRideWithOffer(deps, r.id, rr.id, row.id, { expectedFareNgn: 3000 })).code, 'OFFER_CHANGED');
  assert.equal(events.filter((e) => e.eventType === 'RIDE_OFFER_ACCEPTED').length, 0);
  assert.equal(await prisma.rideHold.count({ where: { rideId: rr.id } }), 0);
});

/* ── 2. Book a ride → the ride page, through the real form endpoint ──── */

test('Quick Actions · Book a ride goes through the form endpoint to the ride page: the chat gets its one button', async () => {
  const r = await rider(0);
  const booked = [];
  const deps = {
    redisClient: memoryRedis(), publisher: publisherInto([]), tokenSecret: JWT, privateKeyPem: '', googleMapsApiKey: '', routePlanner: {},
    onBookOnPage: async (userId) => { booked.push(userId); return true; },
  };
  const screen = await handleFlowAction({ action: 'data_exchange', screen: 'MENU', flow_token: signFlowToken(`menu:${r.id}`, JWT), data: { choice: 'book' } }, deps);
  assert.deepEqual(booked, [r.id]);
  assert.equal(screen.screen, 'NOTE');
  assert.equal(screen.data.headline, 'Swipe down to book');
});

/* ── 3. trip chat while on the page ──────────────────────────────────── */

test('trip chat while on the ride page, with the card held: no bubble; the card wears 💬 when it is sent', async () => {
  const redis = memoryRedis();
  const r = await rider(0);
  const rideId = randomUUID();
  const trip = createTripWhatsapp({ metaAccessToken: 't', metaPhoneNumberId: '1' }, 'https://app.test', JWT, redis);
  assert.equal(await trip.setCardStatus(rideId, 'message'), false, 'no card yet');
  assert.equal(await trip.heldForPage(r.id, rideId, 'message'), false, 'off the page: the caller sends the message');
  await bidState.markRidePageSeen(redis, r.id);
  assert.equal(await trip.heldForPage(r.id, rideId, 'message'), true, 'on the page: nothing sent, kept for the card');
  const meta = metaCapture();
  await rememberRideCard({ redis, meta: { metaAccessToken: 't', metaPhoneNumberId: '1' } }, rideId, r.phone, 'wamid.card');
  assert.deepEqual(meta.reactions().map((m) => m.reaction.emoji), ['💬']);
});

/* ── 4. a deposit while on the page ──────────────────────────────────── */

test('a deposit books the chosen driver while the rider is on the page: no card, no "₦X received" — the card waits for them to leave', async () => {
  const redis = memoryRedis();
  const events = [];
  const r = await rider(3000);
  const d = await driver();
  const rr = await ride(r.id);
  const [row] = await whatsappSearch(redis, rr, r, [[d, 3000]]);
  await bidState.storePendingAccept(redis, r.id, { bidId: row.id, rideId: rr.id, driverId: d.id, driverUserId: d.userId, driverName: 'Ada', driverPhone: '', driverRating: 5, totalRides: 1, vehicleModel: 'Corolla', vehiclePlate: 'KJA1', etaSeconds: 300, fareNgn: 3000 });
  await bidState.markRidePageSeen(redis, r.id);
  const meta = metaCapture();
  const finish = createWhatsappDepositFinisher({ redisClient: redis, publisher: publisherInto(events), metaAccessToken: 't', metaPhoneNumberId: '1', jwtSecret: JWT });
  assert.equal(await finish({ userId: r.id, amountNgn: 3000, newBalanceNgn: 3000 }), true);
  assert.equal(events.filter((e) => e.eventType === 'RIDE_OFFER_ACCEPTED').length, 1);
  assert.equal(meta.messages().length, 0, 'nothing in the chat');
  assert.deepEqual((await pendingCatchup(redis, r.id)).map((i) => i.kind), ['ride_confirmed']);

  // Another booking already went out: on the page, still nothing — and not twice.
  const r2 = await rider(3000);
  const rr2 = await ride(r2.id);
  const [row2] = await whatsappSearch(redis, rr2, r2, [[d, 3000]]);
  await bidState.storePendingAccept(redis, r2.id, { bidId: row2.id, rideId: rr2.id, driverId: d.id, driverUserId: d.userId, driverName: 'Ada', driverPhone: '', driverRating: 5, totalRides: 1, vehicleModel: 'Corolla', vehiclePlate: 'KJA1', etaSeconds: 300, fareNgn: 3000 });
  await lockLib.noteAcceptSent(redis, rr2.id, 'someone-else');
  await bidState.markRidePageSeen(redis, r2.id);
  assert.equal(await finish({ userId: r2.id, amountNgn: 3000, newBalanceNgn: 3000 }), true, 'swallowed on the page');
  assert.equal(meta.messages().length, 0);
});

/* ── 5. a driver bails, and the bail is delivered again ──────────────── */

test('a bail releases only the bailing driver\'s hold; delivered again it touches nothing of the next booking; on the page it waits', async () => {
  const redis = memoryRedis();
  const r = await rider(20_000);
  const a = await driver();
  const b = await driver();
  const rr = await ride(r.id, { status: 'DRIVER_ASSIGNED', driverId: a.id });
  await whatsappSearch(redis, rr, r, []);
  const wallet = await prisma.wallet.findUnique({ where: { userId: r.id } });
  await walletClient.createRideHold({ rideId: rr.id, walletId: wallet.id, riderId: r.id, driverUserId: a.userId, amountNgn: 3000 });
  await bidState.markRidePageSeen(redis, r.id);
  const deps = { registry: { sendToUser: async () => {}, isUserConnected: async () => true, hasUser: () => false }, redisClient: redis, publisher: publisherInto([]), whatsappNotifier: { metaAccessToken: 't', metaPhoneNumberId: '1' } };
  const bail = { eventType: 'RIDE_CANCELLED', rideId: rr.id, riderId: r.id, driverId: a.id, driverUserId: a.userId, cancelledBy: 'driver', reason: 'Car trouble', timestamp: new Date().toISOString() };
  const meta = metaCapture();
  await handleRideEvent(bail, deps, new Map());
  assert.notEqual((await prisma.rideHold.findUnique({ where: { rideId: rr.id } })).status, 'ACTIVE', 'A\'s money went back');
  assert.equal(meta.messages().length, 0, 'on the page: no chat message');
  assert.deepEqual((await pendingCatchup(redis, r.id)).map((i) => i.kind), ['driver_cancelled']);

  // The search went on and B is being booked; then the bail arrives again.
  await prisma.ride.update({ where: { id: rr.id }, data: { status: 'MATCHING', driverId: null } });
  await walletClient.createRideHold({ rideId: rr.id, walletId: wallet.id, riderId: r.id, driverUserId: b.userId, amountNgn: 3200 });
  await lockLib.noteAcceptSent(redis, rr.id, b.userId);
  await handleRideEvent(bail, deps, new Map());
  const hold = await prisma.rideHold.findUnique({ where: { rideId: rr.id } });
  assert.deepEqual([hold.status, hold.driverUserId], ['ACTIVE', b.userId], 'B\'s hold stays');
  assert.equal(await lockLib.acceptSentFor(redis, rr.id), b.userId, 'B\'s acceptance stays');
  assert.equal(meta.messages().length, 0);
});

/* ── 6. an auto booking said in the chat, then the driver is busy ────── */

test('auto-accept said "booked" in the chat and the driver turns out busy: the one "couldn\'t take this ride" line is sent', async () => {
  const redis = memoryRedis();
  const r = await rider(20_000);
  const d = await driver();
  const rr = await ride(r.id);
  await whatsappSearch(redis, rr, r, []);
  await bidState.storeAcceptedBid(redis, rr.id, { driverName: 'Ada', driverPhone: '', driverUserId: d.userId, vehicleModel: 'Corolla', vehiclePlate: 'KJA1', vehicleColor: '', driverRating: 5, totalRides: 1, etaSeconds: 300, fareNgn: 3000 });
  await redis.set(`ride:${rr.id}:auto-accept:booked`, d.id);
  await redis.set(`ride:${rr.id}:auto-accept:told-chat`, '1');
  const deps = { registry: { sendToUser: async () => {}, isUserConnected: async () => true, hasUser: () => false }, redisClient: redis, publisher: publisherInto([]), whatsappNotifier: { metaAccessToken: 't', metaPhoneNumberId: '1', offersFormFlowId: 'form', flowTokenSecret: JWT } };
  const meta = metaCapture();
  await handleRideEvent({ eventType: 'RIDE_ASSIGNMENT_FAILED', rideId: rr.id, riderId: r.id, driverId: d.id, driverUserId: d.userId, reason: 'driver_busy', timestamp: new Date().toISOString() }, deps, new Map());
  assert.match(JSON.stringify(meta.messages()), /couldn't take this ride after all/);
});

/* ── 9. one message when they leave ──────────────────────────────────── */

test('leaving the page: ONE message, the most important still true; never the card once the trip has started', async () => {
  const redis = memoryRedis();
  const userId = randomUUID();
  const delivered = [];
  const catchup = createPageCatchup({ redis, deliver: async (_id, item) => { delivered.push(item.kind); return true; } });
  for (const item of [
    { kind: 'search_started', rideId: 'r1', event: {} },
    { kind: 'ride_confirmed', rideId: 'r1', event: {} },
    { kind: 'offer_count', rideId: 'r1' },
  ]) await require('../apps/api-gateway/dist/whatsapp-flows/page-catchup.js').deferUntilPageLeft(redis, userId, item);
  await catchup.sweep(Date.now() + 60_000);
  // The send() stand-in has no sorted set: drive the check through a fresh due entry instead.
  if (delivered.length === 0) {
    const due = { ...redis, send: async (cmd) => (cmd === 'ZRANGEBYSCORE' ? [userId] : cmd === 'ZREM' ? 1 : null) };
    await createPageCatchup({ redis: due, deliver: async (_id, item) => { delivered.push(item.kind); return true; } }).sweep(Date.now() + 60_000);
  }
  assert.deepEqual(delivered, ['offer_count', 'ride_confirmed'], 'the silent count, then the card alone');

  const r = await rider(0);
  const started = await ride(r.id, { status: 'IN_PROGRESS' });
  await bidState.setActiveRide(redis, r.id, started.id);
  await bidState.setRideState(redis, started.id, 'in_progress');
  const said = [];
  const catchDeps = { registry: {}, redisClient: redis, publisher: {}, ridePageChat: async (e) => { said.push(e); } };
  // No card was ever sent: the card goes even though the trip has started (it carries chat, calls, SOS).
  assert.equal(await deliverPageCatchup(catchDeps, r.id, { kind: 'ride_confirmed', rideId: started.id, event: { kind: 'ride_confirmed' } }), true);
  // With a card already in the chat: never a second.
  await redis.set(`tripchat:card:${started.id}`, JSON.stringify({ messageId: 'wamid.c', phone: r.phone, status: 'live' }));
  assert.equal(await deliverPageCatchup(catchDeps, r.id, { kind: 'ride_confirmed', rideId: started.id, event: { kind: 'ride_confirmed' } }), false);
  assert.equal(said.length, 1);
});
