// The old WhatsApp form's "I've transferred" (TOP_UP) check under the ride's one
// booking lock: while another booking holds it, the screen stays on top-up with
// "tap again in a moment" and the rider's choice is kept; a ride already booked
// says so; a free lock books the chosen driver as before. Against the local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/legacy-topup-lock.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { handleFlowAction } = require('../apps/api-gateway/dist/whatsapp-flows/flow-endpoint.js');
const { signFlowToken } = require('../apps/api-gateway/dist/whatsapp-flows/encryption.js');
const bidState = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');
const lockLib = require('../apps/api-gateway/dist/rides/booking-lock.js');

const prisma = new PrismaClient();
const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const made = { users: [], rides: [], drivers: [] };
const realConsole = { ...console };
test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; });
test.afterEach(() => { Object.assign(console, realConsole); });
test.after(async () => {
  await prisma.rideHold.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.transaction.deleteMany({ where: { wallet: { userId: { in: made.users } } } });
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
  await prisma.user.create({ data: { id, privyDid: `test:legacy-topup:${id}`, role, name: `Legacy ${role}`, phone: '+2348030000099' } });
  made.users.push(id);
  return id;
}

/** A rider on the old form's top-up screen for a chosen driver, with the money now in the wallet. */
async function onTopUp() {
  const redis = memoryRedis();
  const published = [];
  const deps = { redisClient: redis, publisher: { publishRideEvent: async (e) => { published.push(e); }, publishNotificationEvent: async () => {} }, tokenSecret: SECRET, privateKeyPem: '', googleMapsApiKey: '', routePlanner: {} };
  const riderId = await user('RIDER');
  await prisma.wallet.create({ data: { userId: riderId, balanceNgn: 5000 } });
  const driverUserId = await user('DRIVER');
  const d = await prisma.driver.create({ data: { userId: driverUserId, kycStatus: 'APPROVED', status: 'ONLINE', lastSeenAt: new Date(), vehicleModel: 'Corolla', vehiclePlate: 'KJA1' } });
  made.drivers.push(d.id);
  const ride = await prisma.ride.create({ data: { riderId, status: 'MATCHING', pickupLat: 6.6, pickupLng: 3.35, pickupAddress: 'Opebi', destLat: 6.5, destLng: 3.36, destAddress: 'Surulere', riderOfferNgn: 3000, fareEstimateNgn: 3000 } });
  made.rides.push(ride.id);
  await bidState.storeWhatsappRide(redis, ride.id, { riderId, phone: '+2348030000099', pickupAddress: 'Opebi', destinationAddress: 'Surulere', offerNgn: 3000, suggestedFareNgn: 3000, paymentMethod: 'WALLET', createdAt: new Date().toISOString() });
  await bidState.addBid(redis, ride.id, { driverId: d.id, driverUserId, counterOfferNgn: 3000, driverName: 'Ade', driverRating: 5, vehiclePlate: 'KJA1', vehicleModel: 'Corolla', etaSeconds: 300, distanceKm: 2, receivedAt: new Date().toISOString() });
  await bidState.storeFlowPendingAccept(redis, riderId, { rideId: ride.id, driverId: d.id });
  const check = () => handleFlowAction({ action: 'data_exchange', screen: 'TOP_UP', flow_token: signFlowToken(`${ride.id}:${riderId}`, SECRET), data: {} }, deps);
  const accepted = () => published.filter((e) => e.eventType === 'RIDE_OFFER_ACCEPTED');
  return { redis, riderId, ride, d, check, accepted };
}

test('another booking holds the lock: the top-up screen stays, says to tap again, and the choice is kept', async () => {
  const t = await onTopUp();
  await t.redis.set(lockLib.bookingLockKey(t.ride.id), 'another-booking');
  const screen = await t.check();
  assert.equal(screen.screen, 'TOP_UP');
  assert.match(screen.data.status_line, /tap again in a moment/);
  assert.equal(screen.data.has_status, true);
  assert.deepEqual(await bidState.getFlowPendingAccept(t.redis, t.riderId), { rideId: t.ride.id, driverId: t.d.id }, 'the choice is kept');
  assert.equal(t.accepted().length, 0);
  assert.equal(await prisma.rideHold.count({ where: { rideId: t.ride.id } }), 0, 'no money moved');
});

test('the ride is already booked: said so, nothing booked twice', async () => {
  const t = await onTopUp();
  await bidState.setRideState(t.redis, t.ride.id, 'confirmed');
  const screen = await t.check();
  assert.equal(screen.screen, 'SUCCESS');
  assert.match(JSON.stringify(screen.data), /Your ride is already booked\./);
  assert.equal(t.accepted().length, 0);

  const t2 = await onTopUp();
  await lockLib.noteAcceptSent(t2.redis, t2.ride.id, 'another-driver-user');
  const screen2 = await t2.check();
  assert.match(JSON.stringify(screen2.data), /Your ride is already booked\./);
  assert.equal(t2.accepted().length, 0);
});

test('the lock is free: the chosen driver is booked as before, the fare held first', async () => {
  const t = await onTopUp();
  const screen = await t.check();
  assert.equal(screen.screen, 'RIDE_CONFIRMED', JSON.stringify(screen));
  assert.deepEqual(t.accepted().map((e) => [e.driverId, e.agreedFareNgn]), [[t.d.id, 3000]]);
  assert.equal((await prisma.rideHold.findUnique({ where: { rideId: t.ride.id } })).status, 'ACTIVE');
  assert.equal(t.redis.store.has(lockLib.bookingLockKey(t.ride.id)), false, 'the lock is let go');
  assert.equal(await lockLib.acceptSentFor(t.redis, t.ride.id), t.d.userId);
});
