// One booking per ride, whatever the door: the app's Accept, the chat's tap,
// the ride page and auto-accept all take the ride's one booking lock, never
// adopt money held for another driver, and never send a second acceptance.
// Auto-accept stays off searches the gateway already knows are over, off other
// riders' switches, off the taps' side effects ("They tapped Accept", "Rider is
// paying…"), and is never reported as a refused tap. Driver pushes go once.
// Against the local Postgres; Redis is an in-memory stand-in.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/booking-guards.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { driverBidClient } = require('../packages/db/dist/index.js');
const { handleRideMessage } = require('../apps/api-gateway/dist/websocket/handlers/ride.handler.js');
const { handleRideEvent } = require('../apps/api-gateway/dist/kafka/consumer.js');
const { confirmRideWithOffer, cancelWhatsappRide } = require('../apps/api-gateway/dist/rides/whatsapp-ride.service.js');
const { tryAutoAccept } = require('../apps/api-gateway/dist/rides/auto-accept.js');
const bidState = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');

const prisma = new PrismaClient();
const made = { users: [], rides: [], drivers: [] };
const realConsole = { ...console };
test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; });
test.afterEach(() => { Object.assign(console, realConsole); });
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
async function user(role) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:guards:${id}`, role, name: `Guard ${role}`, phone: '+2348030000088' } });
  made.users.push(id);
  return id;
}
async function rider(balanceNgn) {
  const id = await user('RIDER');
  await prisma.wallet.create({ data: { userId: id, balanceNgn } });
  return id;
}
async function driver({ seenSecondsAgo = 5 } = {}) {
  const userId = await user('DRIVER');
  const d = await prisma.driver.create({ data: { userId, kycStatus: 'APPROVED', status: 'ONLINE', lastSeenAt: new Date(Date.now() - seenSecondsAgo * 1000), vehicleModel: 'Corolla', vehiclePlate: 'KJA1' } });
  made.drivers.push(d.id);
  return { id: d.id, userId };
}
async function searching(riderId, extra = {}) {
  const r = await prisma.ride.create({
    data: { riderId, status: 'MATCHING', pickupLat: 6.6, pickupLng: 3.35, pickupAddress: 'Opebi', destLat: 6.5, destLng: 3.36, destAddress: 'Surulere', fareEstimateNgn: 7900, riderOfferNgn: 7900, ...extra },
  });
  made.rides.push(r.id);
  return r;
}
const bid = (r, d, amountNgn, extra = {}) => driverBidClient.record({ rideId: r.id, driverId: d.id, driverUserId: d.userId, riderId: r.riderId, amountNgn, etaSeconds: 300, distanceKm: 2, ...extra });
function world() {
  const redis = memoryRedis();
  const published = [];
  const pushes = [];
  const toApp = [];
  const publisher = {
    publishRideEvent: async (e) => { published.push(e); },
    publishWalletEvent: async () => {}, publishDriverEvent: async () => {},
    publishNotificationEvent: async (e) => { if (e.eventType === 'PUSH_SEND') pushes.push(e); },
  };
  const registry = { sendToUser: async (userId, type, payload) => { toApp.push({ userId, type, payload }); }, isUserConnected: async () => false, hasUser: () => false };
  return { redis, published, pushes, toApp, publisher, deps: { registry, redisClient: redis, publisher } };
}
const appAccept = (w, riderId, r, d, fare) => handleRideMessage('ride:accept_offer',
  { rideId: r.id, driverId: d.id, driverUserId: d.userId, agreedFareNgn: fare, paymentMethod: 'wallet_balance' },
  { userId: riderId, role: 'RIDER' }, w.publisher, {}, w.redis);
const accepted = (w, rideId) => w.published.filter((e) => e.eventType === 'RIDE_OFFER_ACCEPTED' && e.rideId === rideId);
async function whatsappSearch(w, riderId, r, bids) {
  await bidState.storeWhatsappRide(w.redis, r.id, { riderId, phone: '+2348030000088', pickupAddress: 'Opebi', destinationAddress: 'Surulere', offerNgn: 7900, suggestedFareNgn: 7900, paymentMethod: 'WALLET', createdAt: new Date().toISOString() });
  await bidState.setActiveRide(w.redis, riderId, r.id);
  for (const [d, row, price] of bids) {
    await bidState.addBid(w.redis, r.id, { bidId: row.id, driverId: d.id, driverUserId: d.userId, counterOfferNgn: price, driverName: 'Guard', driverRating: 5, vehiclePlate: 'KJA1', vehicleModel: 'Corolla', etaSeconds: 300, distanceKm: 2, receivedAt: new Date().toISOString() });
  }
}

test('two accepts at once on one ride (two drivers, app and chat): one acceptance, one hold, for one driver — a repeat for that driver sends nothing more', async () => {
  const w = world();
  const riderId = await rider(20_000);
  const r = await searching(riderId);
  const a = await driver();
  const b = await driver();
  const rowA = await bid(r, a, 7000);
  const rowB = await bid(r, b, 7500);
  await whatsappSearch(w, riderId, r, [[a, rowA, 7000], [b, rowB, 7500]]);

  const [tapA, chatB] = await Promise.all([appAccept(w, riderId, r, a, 7000), confirmRideWithOffer(w.deps, riderId, r.id, rowB.id)]);
  const booked = accepted(w, r.id);
  assert.equal(booked.length, 1, 'one acceptance');
  const hold = await prisma.rideHold.findUnique({ where: { rideId: r.id } });
  assert.equal(hold.driverUserId, booked[0].driverUserId, 'the hold is the booked driver\'s');
  assert.equal(Number(hold.amountNgn), booked[0].agreedFareNgn, 'never adjusted onto the other driver\'s fare');
  assert.ok(tapA.type === 'ride:accept_offer:rejected' || chatB.ok === false, 'the other door was refused');

  // Afterwards, one at a time: the other driver is refused at either door; the same driver again sends nothing.
  const winner = booked[0].driverId === a.id ? a : b;
  const loser = winner === a ? b : a;
  const loserRow = loser === a ? rowA : rowB;
  const again = await appAccept(w, riderId, r, loser, 7000);
  assert.equal(again.payload.reason, 'already_matched');
  const viaChat = await confirmRideWithOffer(w.deps, riderId, r.id, loserRow.id);
  assert.equal(viaChat.code, 'ALREADY_CONFIRMING');
  if (winner === a) {
    const repeat = await appAccept(w, riderId, r, a, 7000);
    assert.equal(repeat.type, 'ride:accept_offer:accepted');
  }
  assert.equal(accepted(w, r.id).length, 1, 'still one acceptance');
});

test('a chat accept whose message did not go out keeps its hold, and the same driver can still be booked; another driver cannot take that money', async () => {
  const w = world();
  const riderId = await rider(20_000);
  const r = await searching(riderId);
  const a = await driver();
  const c = await driver();
  const rowA = await bid(r, a, 7000);
  await bid(r, c, 6500);
  await whatsappSearch(w, riderId, r, [[a, rowA, 7000]]);
  const realPublish = w.publisher.publishRideEvent;
  w.publisher.publishRideEvent = async (e) => { if (e.eventType === 'RIDE_OFFER_ACCEPTED') throw new Error('kafka down'); return realPublish(e); };
  assert.equal((await confirmRideWithOffer(w.deps, riderId, r.id, rowA.id)).code, 'CONFIRM_FAILED');
  w.publisher.publishRideEvent = realPublish;
  assert.equal((await prisma.rideHold.findUnique({ where: { rideId: r.id } })).status, 'ACTIVE', 'a tap keeps its hold');

  assert.equal((await appAccept(w, riderId, r, c, 6500)).payload.reason, 'already_matched', 'not on driver A\'s money');
  const retry = await appAccept(w, riderId, r, a, 7000);
  assert.equal(retry.type, 'ride:accept_offer:accepted', 'the same driver: a legitimate retry');
  assert.deepEqual(accepted(w, r.id).map((e) => e.driverId), [a.id]);
});

test('auto-accept never books a search the gateway knows is over: cancelled (before the ride service writes it), timed out, or no longer the rider\'s live one', async () => {
  const w = world();
  const riderId = await rider(20_000);
  const d = await driver();

  const cancelled = await searching(riderId, { channel: 'WHATSAPP' });
  const row1 = await bid(cancelled, d, 7000);
  await whatsappSearch(w, riderId, cancelled, [[d, row1, 7000]]);
  await cancelWhatsappRide(w.deps, riderId, cancelled.id, 'My plans changed');
  // The row still says MATCHING: the ride service has not got to it yet.
  assert.equal((await tryAutoAccept(w.deps, cancelled.id)).booked, false);

  const timedOut = await searching(riderId);
  const row2 = await bid(timedOut, d, 7000);
  await whatsappSearch(w, riderId, timedOut, [[d, row2, 7000]]);
  await bidState.markSearchTimedOut(w.redis, riderId, { rideId: timedOut.id, offerNgn: 7900, at: new Date().toISOString() });
  assert.equal((await tryAutoAccept(w.deps, timedOut.id)).booked, false);

  const replaced = await searching(riderId);
  const row3 = await bid(replaced, d, 7000);
  await whatsappSearch(w, riderId, replaced, [[d, row3, 7000]]);
  await bidState.setActiveRide(w.redis, riderId, randomUUID());
  assert.equal((await tryAutoAccept(w.deps, replaced.id)).booked, false);

  // The app: a rider's cancel is the end of it at once.
  const app = await searching(riderId);
  await bid(app, d, 7000);
  await handleRideMessage('ride:cancel', { rideId: app.id }, { userId: riderId, role: 'RIDER' }, w.publisher, {}, w.redis);
  assert.equal((await tryAutoAccept(w.deps, app.id)).booked, false);
  assert.equal(accepted(w, cancelled.id).length + accepted(w, timedOut.id).length + accepted(w, replaced.id).length + accepted(w, app.id).length, 0);
});

test('nobody switches auto-accept off on someone else\'s ride', async () => {
  const w = world();
  const owner = await rider(20_000);
  const stranger = await rider(0);
  const r = await searching(owner);
  const answer = await handleRideMessage('ride:auto_accept', { rideId: r.id, on: false }, { userId: stranger, role: 'RIDER' }, w.publisher, {}, w.redis);
  assert.equal(answer.type, 'ride:auto_accept:rejected');
  assert.equal(w.redis.store.has(`ride:${r.id}:auto-accept`), false);
  const d = await driver();
  await bid(r, d, 7000);
  assert.equal((await tryAutoAccept(w.deps, r.id)).booked, true, 'still on for its owner');
});

test('auto-accept skips the taps\' side effects: no "a rider wants to book you" ping; a failed acceptance lets go of the hold and stops', async () => {
  const w = world();
  const riderId = await rider(20_000);
  const r = await searching(riderId);
  const away = await driver({ seenSecondsAgo: 600 });
  const rowAway = await bid(r, away, 6000);
  await whatsappSearch(w, riderId, r, [[away, rowAway, 6000]]);
  assert.equal((await tryAutoAccept(w.deps, r.id)).booked, false);
  assert.equal(w.pushes.length, 0, 'the away driver is not told a rider tapped Accept');
  assert.equal(w.published.filter((e) => e.eventType === 'RIDE_RIDER_PAYING').length, 0);

  const r2 = await searching(riderId);
  const d1 = await driver();
  const d2 = await driver();
  const row1 = await bid(r2, d1, 6000);
  const row2 = await bid(r2, d2, 6500);
  await whatsappSearch(w, riderId, r2, [[d1, row1, 6000], [d2, row2, 6500]]);
  const realPublish = w.publisher.publishRideEvent;
  w.publisher.publishRideEvent = async (e) => { if (e.eventType === 'RIDE_OFFER_ACCEPTED') throw new Error('kafka down'); return realPublish(e); };
  assert.equal((await tryAutoAccept(w.deps, r2.id)).booked, false);
  w.publisher.publishRideEvent = realPublish;
  const hold = await prisma.rideHold.findUnique({ where: { rideId: r2.id } });
  assert.notEqual(hold?.status, 'ACTIVE', 'the money went back');
  assert.equal(await prisma.rideHold.count({ where: { rideId: r2.id, status: 'ACTIVE' } }), 0);
  assert.equal(Number((await prisma.wallet.findUnique({ where: { userId: riderId } })).lockedNgn), 0);
});

test('an app rider booked by auto-accept gets no "Open Wheelers to accept" push; if that driver turns out busy, no refused tap is reported and the next driver is booked', async () => {
  const w = world();
  const riderId = await rider(20_000);
  const r = await searching(riderId);
  const a = await driver();
  const b = await driver();
  const rowA = await bid(r, a, 6000);
  const offer = { eventType: 'RIDE_COUNTER_OFFER', rideId: r.id, bidId: rowA.id, riderId, driverId: a.id, driverUserId: a.userId, counterOfferNgn: 6000, driverName: 'A', driverRating: 5, vehiclePlate: 'KJA1', vehicleModel: 'Corolla', etaSeconds: 300, distanceKm: 2, timestamp: new Date().toISOString() };
  await handleRideEvent(offer, w.deps, new Map());
  assert.deepEqual(accepted(w, r.id).map((e) => e.driverId), [a.id]);
  assert.equal(w.pushes.filter((p) => p.userId === riderId && /made an offer/.test(p.title)).length, 0);

  await bid(r, b, 6500);
  await handleRideEvent({ eventType: 'RIDE_ASSIGNMENT_FAILED', rideId: r.id, riderId, driverId: a.id, driverUserId: a.userId, reason: 'driver_busy', timestamp: new Date().toISOString() }, w.deps, new Map());
  assert.equal(w.toApp.filter((m) => m.type === 'ride:accept_offer:rejected').length, 0, 'the rider never tapped Accept');
  assert.deepEqual(accepted(w, r.id).map((e) => e.driverId), [a.id, b.id], 'the search went on, and the next driver was booked');
});

test('a redelivered booking is one "You\'re booked" push; a driver can only withdraw their own bid; a bid with no server position is left to the rider', async () => {
  const w = world();
  const riderId = await rider(20_000);
  const r = await searching(riderId, { status: 'DRIVER_ASSIGNED' });
  const d = await driver();
  await bid(r, d, 6000);
  const assigned = { eventType: 'RIDE_DRIVER_ASSIGNED', rideId: r.id, riderId, driverId: d.id, driverUserId: d.userId, driverName: 'A', driverRating: 5, vehiclePlate: 'KJA1', vehicleModel: 'Corolla', etaSeconds: 300, agreedFareNgn: 6000, lockedFareNgn: 6000, paymentMethod: 'WALLET', offeredDriverUserIds: [], timestamp: new Date().toISOString() };
  await handleRideEvent(assigned, w.deps, new Map());
  await handleRideEvent(assigned, w.deps, new Map());
  assert.equal(w.pushes.filter((p) => p.userId === d.userId && p.title === "You're booked").length, 1);

  const r2 = await searching(riderId);
  const mine = await driver();
  const theirs = await driver();
  await bid(r2, theirs, 6000);
  await handleRideMessage('driver:reject', { rideId: r2.id, driverId: theirs.id, reason: 'manual_reject' }, { userId: mine.userId, driverId: mine.id, role: 'DRIVER' }, w.publisher, {}, w.redis);
  const rejected = w.published.filter((e) => e.eventType === 'RIDE_DRIVER_REJECTED').pop();
  assert.equal(rejected.driverId, mine.id, 'the signed-in driver, never the one named in the message');

  const r3 = await searching(riderId);
  const noPosition = await driver();
  await bid(r3, noPosition, 6000, { distanceKm: undefined });
  assert.equal((await tryAutoAccept(w.deps, r3.id)).booked, false);
  assert.equal(accepted(w, r3.id).length, 0);
});
