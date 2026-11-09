// A driver cancelling gives the rider their money back at once, and the search
// goes on without them. Any hold still locked on a ride that ended is released
// by the sweeper. Against the local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/driver-cancel-refund.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { walletClient } = require('../packages/db/dist/index.js');
const { sweepStrandedHolds, STRANDED_AFTER_MS } = require('../apps/api-gateway/dist/payments/hold-sweeper.js');
const { sendRideCancelledNotification } = require('../apps/api-gateway/dist/whatsapp-flows/whatsapp-notifier.js');
const { createRideRequestedConsumer } = require('../apps/ride-service/dist/consumers/ride-requested.consumer.js');

const prisma = new PrismaClient();
const made = { users: [], rides: [] };
const AKOKA = { lat: 6.5244, lng: 3.3870, address: 'Akoka' };
const YABA = { lat: 6.5095, lng: 3.3711, address: 'Yaba' };

test.beforeEach(() => { console.log = console.info = console.warn = () => {}; });

async function riderWithWallet(balanceNgn) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:refund:${id}`, role: 'RIDER', name: 'Refund Rider' } });
  made.users.push(id);
  const wallet = await prisma.wallet.create({ data: { userId: id, balanceNgn } });
  return { riderId: id, walletId: wallet.id };
}
async function ride(riderId, fields = {}) {
  const row = await prisma.ride.create({ data: { riderId, status: 'MATCHING', pickupLat: AKOKA.lat, pickupLng: AKOKA.lng, pickupAddress: AKOKA.address, destLat: YABA.lat, destLng: YABA.lng, destAddress: YABA.address, riderOfferNgn: 3000, fareEstimateNgn: 3000, distanceKm: 3, paymentMethod: 'WALLET', ...fields } });
  made.rides.push(row.id);
  return row.id;
}
const balances = async (walletId) => {
  const w = await prisma.wallet.findUnique({ where: { id: walletId } });
  return [Number(w.balanceNgn), Number(w.lockedNgn)];
};

test('the sweeper releases a hold left on a ride cancelled long ago, and leaves a live or recent one alone', async () => {
  const { riderId, walletId } = await riderWithWallet(10000);
  const old = await ride(riderId, { status: 'CANCELLED' });
  const recent = await ride(riderId, { status: 'CANCELLED' });
  const live = await ride(riderId);
  for (const rideId of [old, recent, live]) await walletClient.createRideHold({ rideId, walletId, riderId, amountNgn: 3000 });
  assert.deepEqual(await balances(walletId), [1000, 9000]);
  await prisma.$executeRaw`UPDATE "Ride" SET "updatedAt" = ${new Date(Date.now() - STRANDED_AFTER_MS - 60_000)} WHERE id = ${old}`;

  await sweepStrandedHolds();
  assert.deepEqual(await balances(walletId), [4000, 6000], 'only the old one came back');
  assert.equal((await prisma.rideHold.findUnique({ where: { rideId: old } })).status, 'RELEASED');
  assert.equal((await prisma.rideHold.findUnique({ where: { rideId: recent } })).status, 'ACTIVE', 'a rider may still be paying for a driver');
  assert.equal((await prisma.rideHold.findUnique({ where: { rideId: live } })).status, 'ACTIVE');
  await sweepStrandedHolds();
  assert.deepEqual(await balances(walletId), [4000, 6000], 'never twice');
});

test('after a refund the next driver the rider accepts takes a fresh hold on the same ride', async () => {
  const { riderId, walletId } = await riderWithWallet(5000);
  const rideId = await ride(riderId);
  await walletClient.createRideHold({ rideId, walletId, riderId, amountNgn: 3000 });
  await walletClient.cancelRideHold(rideId);   // the driver cancelled
  assert.deepEqual(await balances(walletId), [5000, 0], 'all of it back');
  await walletClient.createRideHold({ rideId, walletId, riderId, amountNgn: 3500 });
  assert.deepEqual(await balances(walletId), [1500, 3500], 'held again for the new driver, at the new fare');
});

test('the rider is told their money is back and another driver is being found', async () => {
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const text = body.text?.body ?? body.interactive?.body?.text;
    if (text) sent.push(text);
    return { ok: true, json: async () => ({}), text: async () => '' };
  };
  try {
    await sendRideCancelledNotification({ metaAccessToken: 't', metaPhoneNumberId: '1' }, '+2348000000000', { cancelledBy: 'driver', refundedNgn: 3000, balanceNgn: 5000, searchingAgain: true });
  } finally { global.fetch = realFetch; }
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Your driver had to cancel/);
  assert.match(sent[0], /Your ₦3,000 is back in your wallet \(balance ₦5,000\)\./);
  assert.match(sent[0], /finding you another driver/);
  assert.doesNotMatch(sent[0], /Book another ride/);
});

test('the search re-opens without the driver who left', async () => {
  const { riderId } = await riderWithWallet(0);
  const userId = randomUUID();
  await prisma.user.create({ data: { id: userId, privyDid: `test:refund:${userId}`, role: 'DRIVER', name: 'Leaving Driver' } });
  made.users.push(userId);
  const driver = await prisma.driver.create({ data: { userId, kycStatus: 'APPROVED', status: 'ON_RIDE' } });
  const rideId = await ride(riderId, { status: 'DRIVER_ASSIGNED', driverId: driver.id });

  const state = { onlineDrivers: new Map(), assignedDriversByRideId: new Map(), rideParticipantsByRideId: new Map(), gpsByRideId: new Map(), routeByRideId: new Map(), pendingMatchesByRideId: new Map() };
  const producer = new Proxy({}, { get: () => async () => {} });
  const consumer = createRideRequestedConsumer({ state, rideEnv: { MATCH_RADIUS_KM: '5', MAX_MATCH_ATTEMPTS: '200' }, rideEventsProducer: producer });
  await consumer.handle(JSON.stringify({ eventType: 'RIDE_CANCELLED', rideId, riderId, driverId: driver.id, driverUserId: userId, cancelledBy: 'driver', reason: 'driver_cancelled', timestamp: new Date().toISOString() }), { topic: 'ride.events' });

  const row = await prisma.ride.findUnique({ where: { id: rideId } });
  assert.deepEqual([row.status, row.driverId], ['MATCHING', null]);
  for (const p of state.pendingMatchesByRideId.values()) if (p.timeout) clearTimeout(p.timeout);
});

test.after(async () => {
  await prisma.rideHold.deleteMany({ where: { rideId: { in: made.rides } } }).catch(() => {});
  await prisma.transaction?.deleteMany?.({ where: { wallet: { userId: { in: made.users } } } }).catch(() => {});
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } }).catch(() => {});
  await prisma.wallet.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
  await prisma.$disconnect();
});
