// Owner guards on the rider's price and on booking: only the ride's rider changes its price (any
// other user, a driver included, is refused, and the ride service ignores it too); a group match request
// cannot be used to book any online driver; a rider's own price has no cap; the live-trip check fails
// closed; and a driver's claim is let go when their assignment fails. Local Postgres, built tree.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit --test-concurrency=1 test/ride-owner-guards.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { handleRideMessage } = require('../apps/api-gateway/dist/websocket/handlers/ride.handler.js');
const { handleRideEvent } = require('../apps/api-gateway/dist/kafka/consumer.js');
const { createRideRequestedConsumer } = require('../apps/ride-service/dist/consumers/ride-requested.consumer.js');
const { rideClient, driverBidClient } = require('../packages/db/dist/index.js');

const prisma = new PrismaClient();
const made = { users: [], rides: [], drivers: [], groups: [] };
const realConsole = { ...console };
test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; });
test.afterEach(() => { Object.assign(console, realConsole); });
test.after(async () => {
  await prisma.groupRideMatchRequest.deleteMany({ where: { id: { in: made.groups } } });
  await prisma.driverBid.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

async function user(role) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:owner:${id}`, role, name: `Test ${role}` } });
  made.users.push(id);
  return id;
}
async function driver() {
  const userId = await user('DRIVER');
  const d = await prisma.driver.create({ data: { userId, kycStatus: 'APPROVED', status: 'ONLINE', lastSeenAt: new Date(), vehicleModel: 'Camry', vehiclePlate: 'KJA482XY' } });
  made.drivers.push(d.id);
  return { id: d.id, userId };
}
async function searching(riderId) {
  const r = await prisma.ride.create({ data: { riderId, status: 'MATCHING', pickupLat: 6.5244, pickupLng: 3.387, pickupAddress: 'Akoka', destLat: 6.5095, destLng: 3.3711, destAddress: 'Yaba', riderOfferNgn: 3000, fareEstimateNgn: 3000 } });
  made.rides.push(r.id);
  return r;
}
const liveRidesOf = (driverId) => prisma.ride.count({ where: { driverId, status: { in: ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'] } } });


const planner = { planRoute: async () => ({ distanceKm: 10, durationSeconds: 1500, suggestedFareNgn: 5000, minOfferNgn: 4100, ratePerKmNgn: 400, geometry: { coordinates: [{ lat: 6.6, lng: 3.35 }, { lat: 6.5, lng: 3.36 }], bounds: { northEast: { lat: 6.6, lng: 3.4 }, southWest: { lat: 6.5, lng: 3.3 } } } }) };
const trip = { pickup: { lat: 6.5244, lng: 3.387, address: 'Akoka' }, destination: { lat: 6.5095, lng: 3.3711, address: 'Yaba' } };
const makePublisher = () => { const published = []; return { published, publishRideEvent: async (e) => { published.push(e); }, publishWalletEvent: async () => {}, publishNotificationEvent: async () => {} }; };
const recorder = () => { const sent = []; return { sent, producer: new Proxy({}, { get: (_t, name) => async (e) => { sent.push([name, e]); } }) }; };

test('H1: only the ride\'s own rider changes its price (a driver or another rider is refused; the ride service ignores them too)', async () => {
  const owner = await user('RIDER');
  const other = await user('RIDER');
  const d = await driver();
  const ride = await searching(owner);
  const send = (userId, role, amount = 4000) => {
    const publisher = makePublisher();
    return handleRideMessage('ride:rider_counter_offer', { rideId: ride.id, counterOfferNgn: amount }, { userId, role }, publisher, planner, undefined).then((reply) => ({ reply, publisher }));
  };
  for (const [userId, role] of [[d.userId, 'DRIVER'], [other, 'RIDER']]) {
    const publisher = makePublisher();
    await assert.rejects(handleRideMessage('ride:rider_counter_offer', { rideId: ride.id, counterOfferNgn: 4000 }, { userId, role }, publisher, planner, undefined), /This ride is not yours/);
    assert.equal(publisher.published.length, 0);
  }
  const ok = await send(owner, 'RIDER');
  assert.equal(ok.reply.type, 'ride:rider_counter_offer:accepted', JSON.stringify(ok.reply.payload));
  assert.equal(ok.publisher.published[0].riderId, owner);

  // The ride service: an event naming someone else as the rider changes nothing; the real rider's does.
  const { producer } = recorder();
  const consumer = createRideRequestedConsumer({ state: { pendingMatchesByRideId: new Map(), onlineDrivers: new Map(), rideParticipantsByRideId: new Map(), rideRouteStopsByRideId: new Map(), routeByRideId: new Map(), assignedDriversByRideId: new Map(), gpsByRideId: new Map() }, rideEnv: {}, rideEventsProducer: producer });
  const counter = (riderId, amount) => ({ eventType: 'RIDE_RIDER_COUNTER_OFFER', rideId: ride.id, riderId, counterOfferNgn: amount, timestamp: new Date().toISOString() });
  await consumer.handle(counter(other, 9999), { topic: 'ride.events' });
  assert.equal(Number((await prisma.ride.findUnique({ where: { id: ride.id } })).riderOfferNgn), 3000, 'someone else\'s event changed nothing');
  await consumer.handle(counter(owner, 4000), { topic: 'ride.events' });
  assert.equal(Number((await prisma.ride.findUnique({ where: { id: ride.id } })).riderOfferNgn), 4000);
});

test('H2: a group match request cannot be used to book any online driver at the rider\'s own price', async () => {
  const rider = await user('RIDER');
  const d = await driver();
  const group = await prisma.groupRideMatchRequest.create({ data: { userId: rider, status: 'MATCHING', pickupLat: 6.5, pickupLng: 3.3, pickupAddress: 'A', destLat: 6.6, destLng: 3.4, destAddress: 'B' } });
  made.groups.push(group.id);
  const publisher = makePublisher();
  const reply = await handleRideMessage('ride:accept_offer', { rideId: group.id, driverId: d.id, driverUserId: d.userId, agreedFareNgn: 1, paymentMethod: 'CASH' }, { userId: rider, role: 'RIDER' }, publisher, {}, undefined);
  assert.equal(reply.type, 'ride:accept_offer:rejected', JSON.stringify(reply.payload));
  assert.equal(publisher.published.length, 0);
  await prisma.groupRideMatchRequest.update({ where: { id: group.id }, data: { status: 'CANCELLED' } });
  const ended = await handleRideMessage('ride:accept_offer', { rideId: group.id, driverId: d.id, driverUserId: d.userId, agreedFareNgn: 1, paymentMethod: 'CASH' }, { userId: rider, role: 'RIDER' }, makePublisher(), {}, undefined);
  assert.equal(ended.payload.reason, 'search_ended');

  // The ride service: an acceptance for a ride it has no row for, and no group anchor, fails as ride_closed.
  const { sent, producer } = recorder();
  const consumer = createRideRequestedConsumer({ state: { pendingMatchesByRideId: new Map(), onlineDrivers: new Map(), rideParticipantsByRideId: new Map(), rideRouteStopsByRideId: new Map(), routeByRideId: new Map(), assignedDriversByRideId: new Map(), gpsByRideId: new Map() }, rideEnv: {}, rideEventsProducer: producer });
  await consumer.handle({ eventType: 'RIDE_OFFER_ACCEPTED', rideId: randomUUID(), riderId: rider, driverId: d.id, driverUserId: d.userId, agreedFareNgn: 1, paymentMethod: 'CASH', timestamp: new Date().toISOString() }, { topic: 'ride.events' });
  assert.equal(sent.filter(([n]) => n === 'rideDriverAssigned').length, 0);
  assert.equal(sent.find(([n]) => n === 'rideAssignmentFailed')[1].reason, 'ride_closed');
});

test('no cap on the rider\'s own price (Timi, 9 Nov): any amount goes through as sent', async () => {
  const rider = await user('RIDER');
  const publisher = makePublisher();
  const reply = await handleRideMessage('ride:request', { ...trip, offerNgn: 1_000_000 }, { userId: rider, role: 'RIDER' }, publisher, planner, undefined);
  assert.equal(reply.type, 'ride:request:accepted', JSON.stringify(reply.payload));
  const requested = publisher.published.find((e) => e.eventType === 'RIDE_REQUESTED');
  made.rides.push(requested.rideId);
  assert.equal(requested.riderOfferNgn, 1_000_000);

  const ride = await searching(rider);
  const counter = makePublisher();
  const answer = await handleRideMessage('ride:rider_counter_offer', { rideId: ride.id, counterOfferNgn: 500_000 }, { userId: rider, role: 'RIDER' }, counter, planner, undefined);
  assert.equal(answer.type, 'ride:rider_counter_offer:accepted');
  assert.equal(counter.published[0].counterOfferNgn, 500_000);
});

test('L2: the live-trip check on ride:request fails closed', async () => {
  const rider = await user('RIDER');
  const real = rideClient.findActiveByRider;
  rideClient.findActiveByRider = () => Promise.reject(new Error('db down'));
  const publisher = makePublisher();
  try {
    await assert.rejects(handleRideMessage('ride:request', { ...trip, offerNgn: 5000 }, { userId: rider, role: 'RIDER' }, publisher, planner, undefined), /Could not check your rides/);
    assert.equal(publisher.published.length, 0);
  } finally {
    rideClient.findActiveByRider = real;
  }
});

test('L3: a failed assignment lets go of the driver\'s 60-second claim (only if it is this ride\'s)', async () => {
  const rider = await user('RIDER');
  const d = await driver();
  const ride = await searching(rider);
  const store = new Map();
  const redis = {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v) { store.set(k, v); },
    async del(k) { store.delete(k); },
    async setIfNotExists(k, v) { if (store.has(k)) return false; store.set(k, v); return true; },
    async send() { return null; },
  };
  const registry = { sendToUser: async () => {}, isUserConnected: async () => true, hasUser: () => true };
  const deps = { registry, redisClient: redis, publisher: makePublisher() };
  const failed = { eventType: 'RIDE_ASSIGNMENT_FAILED', rideId: ride.id, riderId: rider, driverId: d.id, driverUserId: d.userId, reason: 'driver_busy', timestamp: new Date().toISOString() };
  const key = `whatsapp:driver:${d.id}:accepting`;
  store.set(key, ride.id);
  await handleRideEvent(failed, deps, new Map()).catch(() => undefined);
  assert.equal(store.has(key), false, 'this ride\'s claim is released');
  store.set(key, randomUUID());
  await handleRideEvent(failed, deps, new Map()).catch(() => undefined);
  assert.equal(store.has(key), true, 'another ride\'s claim stays');
});
