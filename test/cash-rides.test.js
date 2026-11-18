// Pay with cash (Timi, 18 Nov 2026). Any rider may pay the driver in cash once the price is agreed: nothing is held.
// At the end Wheelers' share of the fare is taken from the driver's wallet, below zero if it has to (only a wallet
// marked mayOwe may go below zero). A driver owing more than ₦1,000 gets no new requests and their bids are refused
// until a deposit brings the wallet back. A group trip's row is CASH too, and is never charged.
// Real Postgres; Redis in memory (the booking paths) or database 15 (presence).
//
//   npm -w @wheleers/config run build && npm -w @wheleers/db run build && npm -w @wheleers/api-gateway run build && npm -w @wheleers/wallet-service run build
//   node scripts/run-with-env.cjs node --test --test-force-exit test/cash-rides.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const { walletClient, driverClient, driverBidClient, driverPresence, adminAnalyticsClient, lagosToday } = require('../packages/db/dist/index.js');
const { RedisClient } = require('../apps/api-gateway/dist/redis/client.js');
const { calculateRideFees, CASH_OWED_LIMIT_NGN, depositNeededFor } = require('../packages/config/dist/index.js');
const { createRideEventsConsumer } = require('../apps/wallet-service/dist/consumers/ride-events.consumer.js');
const { handleRideMessage } = require('../apps/api-gateway/dist/websocket/handlers/ride.handler.js');
const { confirmRideWithOffer } = require('../apps/api-gateway/dist/rides/whatsapp-ride.service.js');
const { owedOf, owedMessage, assertNotOwingPastLimit } = require('../apps/api-gateway/dist/rides/cash-owed.js');
const { rideDetailsText } = require('../apps/api-gateway/dist/whatsapp/ride-card.js');
const bidState = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');

const prisma = new PrismaClient();
const made = { users: [], rides: [], drivers: [] };
const realConsole = { ...console };
test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; });
test.afterEach(() => { Object.assign(console, realConsole); delete process.env.CASH_RIDES_ENABLED; });
test.after(async () => {
  await prisma.rideHold.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.transaction.deleteMany({ where: { OR: [{ wallet: { userId: { in: made.users } } }, { referenceId: { in: made.rides } }] } });
  await prisma.driverBid.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } });
  await prisma.wallet.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

// Wheelers' own wallet: the platform credit lands there (created by the code when missing).
const PLATFORM_USER_ID = '00000000-0000-0000-0000-000000000001';
const platformBalance = async () => Number((await prisma.wallet.findUnique({ where: { userId: PLATFORM_USER_ID } }))?.balanceNgn ?? 0);

async function user(role) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:cash:${id}`, role, name: `Cash ${role}`, phone: '+2348030000077' } });
  made.users.push(id);
  return id;
}
async function rider(balanceNgn = 0) {
  const id = await user('RIDER');
  await prisma.wallet.create({ data: { userId: id, balanceNgn } });
  return id;
}
async function driver({ balanceNgn = null, lat = null, lng = null } = {}) {
  const userId = await user('DRIVER');
  const d = await prisma.driver.create({ data: { userId, kycStatus: 'APPROVED', status: 'ONLINE', lastSeenAt: new Date(), vehicleModel: 'Corolla', vehiclePlate: 'KJA1', lat, lng } });
  made.drivers.push(d.id);
  if (balanceNgn !== null) await prisma.wallet.create({ data: { userId, balanceNgn, mayOwe: balanceNgn < 0 } });
  return { id: d.id, userId };
}
async function ride(riderId, extra = {}) {
  const r = await prisma.ride.create({
    data: { riderId, status: 'MATCHING', pickupLat: 6.6, pickupLng: 3.35, pickupAddress: 'Opebi', destLat: 6.5, destLng: 3.36, destAddress: 'Surulere', fareEstimateNgn: 5000, riderOfferNgn: 5000, ...extra },
  });
  made.rides.push(r.id);
  return r;
}
/** A cash trip the driver is on (what ride-service has when RIDE_COMPLETED goes out). */
async function cashTrip(d, extra = {}) {
  const riderId = await rider(0);
  return ride(riderId, { status: 'IN_PROGRESS', driverId: d.id, paymentMethod: 'CASH', agreedFareNgn: 5000, startedAt: new Date(), ...extra });
}
const balanceOf = async (userId) => Number((await prisma.wallet.findUnique({ where: { userId } })).balanceNgn);
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
function world() {
  const redis = memoryRedis();
  const published = [];
  const publisher = { publishRideEvent: async (e) => { published.push(e); }, publishWalletEvent: async () => {}, publishDriverEvent: async () => {}, publishNotificationEvent: async () => {} };
  return { redis, published, publisher, deps: { redisClient: redis, publisher } };
}
const bidRow = (r, d, amountNgn) => driverBidClient.record({ rideId: r.id, driverId: d.id, driverUserId: d.userId, riderId: r.riderId, amountNgn, etaSeconds: 300, distanceKm: 2 });
const appAccept = (w, riderId, r, d, fare, paymentMethod) => handleRideMessage('ride:accept_offer',
  { rideId: r.id, driverId: d.id, driverUserId: d.userId, agreedFareNgn: fare, paymentMethod },
  { userId: riderId, role: 'RIDER' }, w.publisher, {}, w.redis);

// ── The fee at the end ────────────────────────────────────────────────────

test('a cash trip ends: Wheelers\' share comes off the driver\'s wallet once, Wheelers is credited, the ride carries the split', async () => {
  const d = await driver({ balanceNgn: 2000 });
  const r = await cashTrip(d);
  const fees = calculateRideFees(5000, 4);
  const before = await platformBalance();

  const taken = await walletClient.takeCashRideFees({ rideId: r.id, fareNgn: 5000 });
  assert.equal(taken.applied, true);
  assert.equal(taken.owedNgn, fees.platformTotalNgn);
  assert.equal(await balanceOf(d.userId), 2000 - fees.platformTotalNgn);
  assert.equal(Math.round((await platformBalance() - before) * 100) / 100, fees.platformTotalNgn, 'Wheelers gets exactly what the driver gave');

  const credit = await prisma.transaction.findFirst({ where: { referenceId: r.id, type: 'PLATFORM_FEE', direction: 'CREDIT' } });
  assert.deepEqual([credit.metadata.kind, credit.metadata.paidInCash], ['ride_fee', true], 'counted as a ride fee in every report, marked cash');
  const row = await prisma.transaction.findFirst({ where: { referenceId: r.id, type: 'CASH_RIDE_FEE' } });
  assert.equal(row.direction, 'DEBIT');
  assert.equal(Number(row.amountNgn), fees.platformTotalNgn);
  const saved = await prisma.ride.findUnique({ where: { id: r.id } });
  assert.deepEqual([Number(saved.platformFeeNgn), Number(saved.commissionNgn), Number(saved.vatNgn)], [fees.platformTotalNgn, fees.commissionNgn, fees.vatNgn]);

  const again = await walletClient.takeCashRideFees({ rideId: r.id, fareNgn: 5000 });
  assert.deepEqual(again, { applied: false, reason: 'already_taken' }, 'a redelivered event takes nothing more');
  assert.equal(await balanceOf(d.userId), 2000 - fees.platformTotalNgn);
});

test('a driver with nothing in the wallet goes below zero by the fees (the wallet is marked as allowed to); one with no wallet gets one', async () => {
  const d = await driver({ balanceNgn: 0 });
  const r = await cashTrip(d);
  const fees = calculateRideFees(5000, 4);
  await walletClient.takeCashRideFees({ rideId: r.id, fareNgn: 5000 });
  const w = await prisma.wallet.findUnique({ where: { userId: d.userId } });
  assert.equal(Number(w.balanceNgn), -fees.platformTotalNgn);
  assert.equal(w.mayOwe, true);

  const noWallet = await driver();
  const r2 = await cashTrip(noWallet);
  assert.equal((await walletClient.takeCashRideFees({ rideId: r2.id, fareNgn: 5000 })).applied, true);
  assert.equal(await balanceOf(noWallet.userId), -fees.platformTotalNgn);
});

test('never charged: a wallet ride, a group trip (its row is CASH), a group seat, a ride that never started', async () => {
  const d = await driver({ balanceNgn: 1000 });
  const wallet = await cashTrip(d, { paymentMethod: 'WALLET' });
  const trip = await cashTrip(d);
  await prisma.ride.update({ where: { id: trip.id }, data: { groupRole: 'TRIP', groupTripId: trip.id } });
  const seat = await cashTrip(d, { groupRole: 'SEAT', groupTripId: trip.id });
  const notStarted = await cashTrip(d, { status: 'DRIVER_ASSIGNED', startedAt: null });
  assert.equal((await walletClient.takeCashRideFees({ rideId: wallet.id, fareNgn: 5000 })).reason, 'not_cash');
  assert.equal((await walletClient.takeCashRideFees({ rideId: trip.id, fareNgn: 15000 })).reason, 'not_cash');
  assert.equal((await walletClient.takeCashRideFees({ rideId: seat.id, fareNgn: 5000 })).reason, 'not_cash');
  assert.equal((await walletClient.takeCashRideFees({ rideId: notStarted.id, fareNgn: 5000 })).reason, 'not_finished');
  assert.equal(await balanceOf(d.userId), 1000, 'nothing taken');
});

test('wallet-service: RIDE_COMPLETED on a cash ride takes the fees once and tells the driver\'s app once', async () => {
  const d = await driver({ balanceNgn: 500 });
  const r = await cashTrip(d);
  const debited = [];
  const producer = { publishDebited: async (e) => { debited.push(e); }, publishCredited: async () => {}, publishLocked: async () => {}, publishUnlocked: async () => {}, publishHoldAdjusted: async () => {} };
  const consumer = createRideEventsConsumer({ walletRepository: walletClient, walletEventsProducer: producer, waitingClient: { payDriver: async () => null, giveBack: async () => null } });
  const event = {
    eventType: 'RIDE_COMPLETED', rideId: r.id, riderId: r.riderId, driverId: d.id, driverUserId: d.userId, fareNgn: 5000,
    distanceKm: 8, durationSeconds: 1200, endedBy: 'both_confirmed', completedAt: new Date().toISOString(), paymentMethod: 'CASH', timestamp: new Date().toISOString(),
  };
  await consumer.handle(event, {});
  await consumer.handle(event, {});   // redelivered
  const fees = calculateRideFees(5000, 4);
  assert.equal(await balanceOf(d.userId), 500 - fees.platformTotalNgn);
  assert.equal(debited.length, 1, 'one wallet update to the driver, not two');
  assert.deepEqual([debited[0].debitType, debited[0].amountNgn, debited[0].userId], ['cash_ride_fee', fees.platformTotalNgn, d.userId]);
});

test('the admin money check: a cash trip adds to "cash fees owed" on both sides, never to fares paid or driver payouts', async () => {
  const range = { from: lagosToday(), to: lagosToday() };
  const byKey = (checks) => Object.fromEntries(checks.map((c) => [c.key, c]));
  const before = byKey(await adminAnalyticsClient.reconcile(range));
  const d = await driver({ balanceNgn: 0 });
  const r = await cashTrip(d);
  await walletClient.takeCashRideFees({ rideId: r.id, fareNgn: 5000 });
  await prisma.ride.update({ where: { id: r.id }, data: { status: 'COMPLETED', completedAt: new Date(), fareFinalNgn: 5000 } });
  const after = byKey(await adminAnalyticsClient.reconcile(range));
  const owed = calculateRideFees(5000, 4).platformTotalNgn;
  const delta = (key, side) => Math.round((after[key][side].value - before[key][side].value) * 100) / 100;
  assert.deepEqual([delta('cashFees', 'left'), delta('cashFees', 'right')], [owed, owed]);
  assert.deepEqual([delta('fees', 'left'), delta('fees', 'right')], [owed, owed], 'Wheelers\' fee income counts it');
  assert.deepEqual([delta('fares', 'left'), delta('fares', 'right'), delta('payouts', 'left'), delta('payouts', 'right')], [0, 0, 0, 0]);
});

// ── What owing means ──────────────────────────────────────────────────────

test('the database still refuses a rider\'s wallet below zero; a driver who owes cannot spend or withdraw it', async () => {
  const riderId = await rider(100);
  await assert.rejects(prisma.wallet.update({ where: { userId: riderId }, data: { balanceNgn: -1 } }), /Wallet_balance_not_negative|check constraint/i);

  const d = await driver({ balanceNgn: -800 });
  const w = await prisma.wallet.findUnique({ where: { userId: d.userId } });
  await assert.rejects(walletClient.debit({ walletId: w.id, amountNgn: 100, type: 'WITHDRAWAL', referenceId: randomUUID() }), /Insufficient/);
  assert.equal(await balanceOf(d.userId), -800);
});

test('a deposit clears what is owed first; the rest is theirs', async () => {
  const d = await driver({ balanceNgn: -1400 });
  const w = await prisma.wallet.findUnique({ where: { userId: d.userId } });
  await walletClient.creditDeposit({ walletId: w.id, amountNgn: depositNeededFor(1400) + 2000, providerFeeNgn: 0, referenceId: `test-cash-${randomUUID()}` });
  const after = await balanceOf(d.userId);
  assert.ok(after >= 2000 && after < 2100, `back above zero with the rest (${after})`);
  await prisma.transaction.deleteMany({ where: { walletId: w.id } });
});

test('owing: up to ₦1,000 is fine; past it, a deposit to get back to ₦0 (fees in) and a refused bid', async () => {
  assert.equal(CASH_OWED_LIMIT_NGN, 1000);
  assert.deepEqual(owedOf(250), { owedNgn: 0, paused: false, depositNgn: 0 });
  assert.equal(owedOf(-1000).paused, false, 'exactly ₦1,000 owed still drives');
  const past = owedOf(-1400);
  assert.equal(past.paused, true);
  assert.equal(past.depositNgn, depositNeededFor(1400));
  assert.match(owedMessage(past), /^You owe Wheelers ₦1,400 from cash trips\. Deposit ₦[\d,]+ to keep driving\.$/);

  const owing = await driver({ balanceNgn: -1400 });
  const fine = await driver({ balanceNgn: -1000 });
  await assert.rejects(assertNotOwingPastLimit(owing.userId), /You owe Wheelers ₦1,400/);
  await assertNotOwingPastLimit(fine.userId);
  await assertNotOwingPastLimit((await driver()).userId);   // no wallet: owes nothing
});

test('a driver owing past ₦1,000 is not found for new requests (Postgres and Redis presence); at ₦1,000 they are', async () => {
  // Far from any other test's drivers: Lekki Free Trade Zone.
  const at = { lat: 6.4321, lng: 3.9876 };
  const owing = await driver({ balanceNgn: -1001, ...at });
  const atLimit = await driver({ balanceNgn: -1000, ...at });
  const clean = await driver({ ...at });
  const ids = (rows) => rows.map((row) => row.id).filter((id) => [owing.id, atLimit.id, clean.id].includes(id)).sort();
  const expected = [atLimit.id, clean.id].sort();
  assert.deepEqual(ids(await driverClient.findNearby(at.lat, at.lng, 2, 50)), expected, 'Postgres');

  // Redis presence answers who is near; the database then leaves out the one who owes.
  const redis = new RedisClient(process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15');
  await redis.connect();
  driverPresence.configure((...args) => redis.send(...args));
  try {
    for (const d of [owing, atLimit, clean]) await driverPresence.noteLocation(d.id, at.lat, at.lng, Date.now());
    assert.deepEqual(ids(await driverClient.findNearby(at.lat, at.lng, 2, 50)), expected, 'Redis presence');
  } finally {
    driverPresence.configure(null);
    await redis.send('FLUSHDB').catch(() => {});
    await redis.disconnect().catch(() => {});
  }
});

// ── Booking with cash ─────────────────────────────────────────────────────

test('app: a rider with an empty wallet books with cash: nothing held, the acceptance says CASH', async () => {
  const w = world();
  const riderId = await rider(0);
  const r = await ride(riderId);
  const d = await driver();
  await bidRow(r, d, 4500);
  const reply = await appAccept(w, riderId, r, d, 4500, 'cash');
  assert.equal(reply.type, 'ride:accept_offer:accepted', JSON.stringify(reply));
  const acceptance = w.published.find((e) => e.eventType === 'RIDE_OFFER_ACCEPTED');
  assert.deepEqual([acceptance.paymentMethod, acceptance.agreedFareNgn], ['CASH', 4500]);
  assert.equal(await prisma.rideHold.findUnique({ where: { rideId: r.id } }), null);
});

test('app: cash after a wallet try on the same ride gives the held money back', async () => {
  const w = world();
  const riderId = await rider(6000);
  const r = await ride(riderId);
  const d = await driver();
  await bidRow(r, d, 4500);
  const wallet = await prisma.wallet.findUnique({ where: { userId: riderId } });
  await walletClient.createRideHold({ rideId: r.id, walletId: wallet.id, riderId, driverUserId: d.userId, amountNgn: 4500 });
  assert.equal(await balanceOf(riderId), 1500);
  const reply = await appAccept(w, riderId, r, d, 4500, 'CASH');
  assert.equal(reply.type, 'ride:accept_offer:accepted');
  assert.equal(await balanceOf(riderId), 6000, 'the hold is let go');
  assert.equal((await prisma.rideHold.findUnique({ where: { rideId: r.id } })).status, 'RELEASED');
});

test('cash switched off (CASH_RIDES_ENABLED=false): the app and the page/chat are told to pay from the wallet', async () => {
  process.env.CASH_RIDES_ENABLED = 'false';
  const w = world();
  const riderId = await rider(0);
  const r = await ride(riderId);
  const d = await driver();
  const row = await bidRow(r, d, 4500);
  const reply = await appAccept(w, riderId, r, d, 4500, 'cash');
  assert.deepEqual([reply.type, reply.payload.reason], ['ride:accept_offer:rejected', 'cash_unavailable']);

  await bidState.storeWhatsappRide(w.redis, r.id, { riderId, phone: '+2348030000077', pickupAddress: 'Opebi', destinationAddress: 'Surulere', offerNgn: 5000, suggestedFareNgn: 5000, paymentMethod: 'WALLET', createdAt: new Date().toISOString() });
  await bidState.addBid(w.redis, r.id, { bidId: row.id, driverId: d.id, driverUserId: d.userId, counterOfferNgn: 4500, driverName: 'Cash Driver', driverRating: 5, vehiclePlate: 'KJA1', vehicleModel: 'Corolla', etaSeconds: 300, distanceKm: 2, receivedAt: new Date().toISOString() });
  assert.equal((await confirmRideWithOffer(w.deps, riderId, r.id, row.id, { method: 'CASH' })).code, 'CASH_UNAVAILABLE');
  assert.equal(w.published.length, 0, 'nothing booked');
});

test('page/chat: cash books with no wallet check; the ride row says CASH; the chat card says pay in cash', async () => {
  const w = world();
  const riderId = await rider(0);
  const r = await ride(riderId);
  const d = await driver();
  const row = await bidRow(r, d, 4500);
  await bidState.storeWhatsappRide(w.redis, r.id, { riderId, phone: '+2348030000077', pickupAddress: 'Opebi', destinationAddress: 'Surulere', offerNgn: 5000, suggestedFareNgn: 5000, paymentMethod: 'WALLET', createdAt: new Date().toISOString() });
  await bidState.addBid(w.redis, r.id, { bidId: row.id, driverId: d.id, driverUserId: d.userId, counterOfferNgn: 4500, driverName: 'Cash Driver', driverRating: 5, vehiclePlate: 'KJA1', vehicleModel: 'Corolla', etaSeconds: 300, distanceKm: 2, receivedAt: new Date().toISOString() });

  assert.equal((await confirmRideWithOffer(w.deps, riderId, r.id, row.id)).code, 'WALLET_SHORT', 'the wallet way still asks for money');
  const result = await confirmRideWithOffer(w.deps, riderId, r.id, row.id, { method: 'CASH', expectedFareNgn: 4500 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.ride.paidInCash, true);
  assert.equal((await prisma.ride.findUnique({ where: { id: r.id } })).paymentMethod, 'CASH');
  assert.equal(w.published.find((e) => e.eventType === 'RIDE_OFFER_ACCEPTED').paymentMethod, 'CASH');
  assert.equal(await prisma.rideHold.findUnique({ where: { rideId: r.id } }), null);
  assert.match(rideDetailsText(result.ride), /Fare ₦4,500 · \*pay your driver in cash\* when you arrive/);
});

test('a driver owing past ₦1,000 cannot bid (driver:accept)', async () => {
  const w = world();
  const riderId = await rider(0);
  const r = await ride(riderId);
  const owing = await driver({ balanceNgn: -2500 });
  await assert.rejects(
    handleRideMessage('driver:accept', { rideId: r.id, agreedFareNgn: 5000, etaSeconds: 300 }, { userId: owing.userId, driverId: owing.id, role: 'DRIVER' }, w.publisher, {}, w.redis),
    /You owe Wheelers ₦2,500 from cash trips/,
  );
  assert.equal(w.published.length, 0);
});
