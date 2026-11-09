// A1: who cancelled a ride, the rider's first price, and how often they changed it.
// Real Postgres; the cancel goes through ride-service's trip-lifecycle handler.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit --test-concurrency=1 test/ride-cancel-offer-columns.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const { TOPICS } = require('../packages/kafka-schemas/dist/index.js');
const { rideClient } = require('../packages/db/dist/index.js');
const { createTripLifecycleHandler } = require('../apps/ride-service/dist/handlers/trip-lifecycle.handler.js');

const prisma = new PrismaClient();
const made = { users: [], rides: [], drivers: [] };
const CTX = { topic: TOPICS.RIDE_EVENTS, partition: 0, offset: '0', timestamp: new Date().toISOString(), headers: {} };
const lifecycle = createTripLifecycleHandler({});
const realConsole = { info: console.info, log: console.log, warn: console.warn };
console.info = () => {}; console.log = () => {}; console.warn = () => {};

async function makeUser(role) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `local:${id}`, role, name: 'A1 Test', phone: `+23480${Math.floor(1e8 + Math.random() * 9e8)}` } });
  made.users.push(id);
  return id;
}
async function makeDriver() {
  const userId = await makeUser('DRIVER');
  const d = await prisma.driver.create({ data: { userId, status: 'ON_RIDE', kycStatus: 'APPROVED', lat: 6.5, lng: 3.37, vehicleModel: 'Corolla', vehiclePlate: `A1-${Math.floor(100 + Math.random() * 900)}XA` } });
  made.drivers.push(d.id);
  return { userId, driverId: d.id };
}
async function makeRide(riderId, extra = {}) {
  const id = randomUUID();
  made.rides.push(id);
  await rideClient.create({
    id, riderId, status: 'MATCHING',
    pickupLat: 6.5095, pickupLng: 3.3711, pickupAddress: 'Yaba',
    destLat: 6.4281, destLng: 3.4219, destAddress: 'Victoria Island',
    fareEstimateNgn: 5000, riderOfferNgn: 4500, ...extra,
  });
  return id;
}
const row = (id) => prisma.ride.findUniqueOrThrow({ where: { id } });
const cancelEvent = (rideId, riderId, extra = {}) => ({
  eventType: 'RIDE_CANCELLED', rideId, riderId, timestamp: new Date().toISOString(), ...extra,
});

test.after(async () => {
  await prisma.driverBid.deleteMany({ where: { rideId: { in: made.rides } } }).catch(() => {});
  await prisma.rideStop.deleteMany({ where: { rideId: { in: made.rides } } }).catch(() => {});
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } }).catch(() => {});
  await prisma.wallet.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
  await prisma.$disconnect();
  Object.assign(console, realConsole);
});

test('a rider cancel writes cancelledBy rider with CANCELLED', async () => {
  const riderId = await makeUser('RIDER');
  const id = await makeRide(riderId);
  await lifecycle.handleRideEvent(cancelEvent(id, riderId, { cancelledBy: 'rider', reason: 'Changed my mind' }), CTX);
  const r = await row(id);
  assert.equal(r.status, 'CANCELLED');
  assert.equal(r.cancelledBy, 'rider');
});

test('a cancel event with no cancelledBy counts as rider (older publishers)', async () => {
  const riderId = await makeUser('RIDER');
  const id = await makeRide(riderId);
  await lifecycle.handleRideEvent(cancelEvent(id, riderId), CTX);
  assert.equal((await row(id)).cancelledBy, 'rider');
});

test('a system cancel event writes cancelledBy system', async () => {
  const riderId = await makeUser('RIDER');
  const id = await makeRide(riderId);
  await lifecycle.handleRideEvent(cancelEvent(id, riderId, { cancelledBy: 'system', reason: 'x' }), CTX);
  assert.equal((await row(id)).cancelledBy, 'system');
});

test('a search timeout and a superseded search write system, same update as CANCELLED', async () => {
  const riderId = await makeUser('RIDER');
  const a = await makeRide(riderId);
  assert.equal((await rideClient.cancelIfUnmatched(a)).count, 1);
  const ra = await row(a);
  assert.equal(ra.status, 'CANCELLED');
  assert.equal(ra.cancelledBy, 'system');
  const b = await makeRide(riderId);
  await rideClient.cancelIfUnmatched(b, 'Replaced by a newer request');
  assert.equal((await row(b)).cancelledBy, 'system');
});

test('a timed-out search that is later won loses its cancelledBy', async () => {
  const riderId = await makeUser('RIDER');
  const { driverId } = await makeDriver();
  const id = await makeRide(riderId);
  await rideClient.cancelIfUnmatched(id);
  assert.equal((await rideClient.assignDriver(id, driverId, { agreedFareNgn: 4500 })).count, 1);
  const r = await row(id);
  assert.equal(r.status, 'DRIVER_ASSIGNED');
  assert.equal(r.cancelledBy, null);
});

test('a driver backing out after accept writes nothing on the ride', async () => {
  const riderId = await makeUser('RIDER');
  const { driverId, userId } = await makeDriver();
  const id = await makeRide(riderId);
  await rideClient.assignDriver(id, driverId, { agreedFareNgn: 4500 });
  await lifecycle.handleRideEvent(cancelEvent(id, riderId, { cancelledBy: 'driver', driverId, driverUserId: userId }), CTX);
  const r = await row(id);
  assert.equal(r.cancelledBy, null);
  assert.notEqual(r.status, 'CANCELLED');
  assert.equal(r.cancelledAt, null);
});

test('two counter offers: riderOfferChanges 2, the first price kept, the current price updated', async () => {
  const riderId = await makeUser('RIDER');
  const id = await makeRide(riderId);
  let r = await row(id);
  assert.equal(Number(r.firstRiderOfferNgn), 4500);
  assert.equal(r.riderOfferChanges, 0);
  await rideClient.updateRiderOffer(id, 5000);
  await rideClient.updateRiderOffer(id, 5500);
  r = await row(id);
  assert.equal(r.riderOfferChanges, 2);
  assert.equal(Number(r.firstRiderOfferNgn), 4500);
  assert.equal(Number(r.riderOfferNgn), 5500);
});

test('the same price twice, or a redelivered offer, is not a change', async () => {
  const riderId = await makeUser('RIDER');
  const id = await makeRide(riderId);
  await rideClient.updateRiderOffer(id, 5000);
  await rideClient.updateRiderOffer(id, 5000);
  await rideClient.updateRiderOffer(id, 4500);
  const r = await row(id);
  assert.equal(r.riderOfferChanges, 2);
  assert.equal(Number(r.riderOfferNgn), 4500);
});

test('a counter offer after the search closed changes nothing', async () => {
  const riderId = await makeUser('RIDER');
  const id = await makeRide(riderId);
  await rideClient.cancelIfUnmatched(id);
  assert.equal((await rideClient.updateRiderOffer(id, 9000)).count, 0);
  assert.equal((await row(id)).riderOfferChanges, 0);
});

test('ride_facts keeps its old columns in order and appends the new ones at the end', async () => {
  const cols = await prisma.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_name = 'ride_facts' ORDER BY ordinal_position`;
  const names = cols.map((c) => c.column_name);
  const i = names.indexOf('whatsapp_fee_ngn');
  assert.ok(i > 0);
  assert.deepEqual(names.slice(0, 8), ['id', 'rider_id', 'driver_id', 'status', 'payment_method', 'channel', 'pickup_zone', 'dest_zone']);
  assert.deepEqual(names.slice(i + 1), ['arrived_at', 'booking_suggested_fare_ngn', 'planned_distance_km', 'bargain_rate', 'cancelled_by', 'first_rider_offer_ngn', 'rider_offer_changes']);
});
