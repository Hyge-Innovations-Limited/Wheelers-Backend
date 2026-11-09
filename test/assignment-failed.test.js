// A booking that does not go through (RIDE_ASSIGNMENT_FAILED), told once and
// only while it is still true: a late or repeated "that driver was busy" never
// releases the money held for the driver the rider chose next, and "the ride
// is closed" never wipes a trip another driver has. Against the local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/assignment-failed.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { walletClient } = require('../packages/db/dist/index.js');
const { handleRideEvent } = require('../apps/api-gateway/dist/kafka/consumer.js');
const { setRideState, getRideState, setActiveRide, getActiveRide } = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');

const prisma = new PrismaClient();
const made = { users: [], rides: [], drivers: [] };
test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; });

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
  await prisma.user.create({ data: { id, privyDid: `test:assign-failed:${id}`, role, name: `Test ${role}` } });
  made.users.push(id);
  return id;
}
async function driver() {
  const userId = await user('DRIVER');
  const d = await prisma.driver.create({ data: { userId, kycStatus: 'APPROVED', status: 'ONLINE', lastSeenAt: new Date() } });
  made.drivers.push(d.id);
  return { id: d.id, userId };
}
async function ride(riderId, extra = {}) {
  const r = await prisma.ride.create({ data: { riderId, status: 'MATCHING', pickupLat: 6.5244, pickupLng: 3.387, pickupAddress: 'Akoka', destLat: 6.5095, destLng: 3.3711, destAddress: 'Yaba', riderOfferNgn: 3000, fareEstimateNgn: 3000, ...extra } });
  made.rides.push(r.id);
  return r;
}
async function riderWithMoney(balanceNgn) {
  const id = await user('RIDER');
  const wallet = await prisma.wallet.create({ data: { userId: id, balanceNgn } });
  return { id, walletId: wallet.id };
}
function world() {
  const toApp = [];
  const redis = memoryRedis();
  return {
    toApp,
    redis,
    deps: {
      registry: { sendToUser: async (userId, type, payload) => { toApp.push({ userId, type, payload }); }, isUserConnected: async () => true },
      redisClient: redis,
      publisher: { publishRideEvent: async () => {}, publishDriverEvent: async () => {}, publishNotificationEvent: async () => {} },
    },
  };
}
const failed = (r, riderId, d, reason) => ({ eventType: 'RIDE_ASSIGNMENT_FAILED', rideId: r.id, riderId, driverId: d.id, driverUserId: d.userId, reason, timestamp: new Date().toISOString() });
const holdOf = (rideId) => prisma.rideHold.findUnique({ where: { rideId } });

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

test('driver busy: the money comes back and the rider chooses again, once — a repeat changes nothing', async () => {
  const rider = await riderWithMoney(10_000);
  const d = await driver();
  const r = await ride(rider.id);
  await walletClient.createRideHold({ rideId: r.id, walletId: rider.walletId, riderId: rider.id, driverUserId: d.userId, amountNgn: 3000 });
  const { deps, toApp } = world();

  await handleRideEvent(failed(r, rider.id, d, 'driver_busy'), deps, new Map());
  assert.equal((await holdOf(r.id)).status, 'RELEASED');
  assert.equal(toApp.filter((m) => m.userId === rider.id && m.type === 'ride:accept_offer:rejected').length, 1);

  await handleRideEvent(failed(r, rider.id, d, 'driver_busy'), deps, new Map());
  assert.equal(toApp.filter((m) => m.userId === rider.id && m.type === 'ride:accept_offer:rejected').length, 1, 'told once');
});

test('a late "driver busy" after the rider chose another driver leaves that booking and its money alone', async () => {
  const rider = await riderWithMoney(10_000);
  const busy = await driver();
  const next = await driver();
  const r = await ride(rider.id);
  // The rider has moved on: the money is now held for the next driver.
  await walletClient.createRideHold({ rideId: r.id, walletId: rider.walletId, riderId: rider.id, driverUserId: next.userId, amountNgn: 3000 });
  const { deps, toApp, redis } = world();
  await setRideState(redis, r.id, 'confirmed');

  await handleRideEvent(failed(r, rider.id, busy, 'driver_busy'), deps, new Map());
  assert.equal((await holdOf(r.id)).status, 'ACTIVE', "the next driver's hold stays");
  assert.equal(toApp.filter((m) => m.userId === rider.id).length, 0, 'the rider is not sent back to choosing');
  assert.equal(await getRideState(redis, r.id), 'confirmed');
  assert.ok(toApp.some((m) => m.userId === busy.userId && m.type === 'ride:bid_lost'), 'the busy driver hears they did not get it');
});

test('ride closed because another driver has it: that trip is left as it is; this driver hears they lost', async () => {
  const rider = await riderWithMoney(10_000);
  const winner = await driver();
  const loser = await driver();
  const r = await ride(rider.id, { status: 'DRIVER_ASSIGNED', driverId: winner.id });
  await walletClient.createRideHold({ rideId: r.id, walletId: rider.walletId, riderId: rider.id, driverUserId: winner.userId, amountNgn: 3000 });
  const { deps, toApp, redis } = world();
  await setActiveRide(redis, rider.id, r.id);
  await setRideState(redis, r.id, 'confirmed');

  await handleRideEvent(failed(r, rider.id, loser, 'ride_closed'), deps, new Map());
  assert.equal(await getActiveRide(redis, rider.id), r.id, "the rider's live trip is untouched");
  assert.equal(await getRideState(redis, r.id), 'confirmed');
  assert.equal((await holdOf(r.id)).status, 'ACTIVE');
  assert.ok(toApp.some((m) => m.userId === loser.userId && m.type === 'ride:bid_lost'));
  assert.ok(!toApp.some((m) => m.type === 'ride:cancelled'));
});

test('ride closed because the rider cancelled: any hold an assignment re-armed is released, the driver hears it is off', async () => {
  const rider = await riderWithMoney(10_000);
  const d = await driver();
  const r = await ride(rider.id, { status: 'CANCELLED' });
  await walletClient.createRideHold({ rideId: r.id, walletId: rider.walletId, riderId: rider.id, driverUserId: d.userId, amountNgn: 3000 });
  const { deps, toApp } = world();

  await handleRideEvent(failed(r, rider.id, d, 'ride_closed'), deps, new Map());
  assert.equal((await holdOf(r.id)).status, 'RELEASED');
  const wallet = await prisma.wallet.findUnique({ where: { id: rider.walletId } });
  assert.equal(Number(wallet.balanceNgn), 10_000, 'all the money is back');
  assert.ok(toApp.some((m) => m.userId === d.userId && m.type === 'ride:cancelled'));
});
