// Group ride in ride-service (Timi, 17 Nov 2026): every group trip is owned by one group account, so a new group never
// replaces another group's search; a rider in a group is never searched for alone; and (an old hole) a ride that never
// started is never completed, a late start never revives a finished ride. Real Postgres, the producer faked.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/group-ride-service.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { TOPICS } = require('../packages/kafka-schemas/dist/index.js');
const { createRideRequestedConsumer } = require('../apps/ride-service/dist/consumers/ride-requested.consumer.js');
const { createTripLifecycleHandler } = require('../apps/ride-service/dist/handlers/trip-lifecycle.handler.js');

const prisma = new PrismaClient();
const made = { users: [], rides: [] };
const CTX = { topic: TOPICS.RIDE_EVENTS, partition: 0, offset: '0', timestamp: new Date().toISOString(), headers: {} };
console.info = () => {}; console.log = () => {}; console.warn = () => {};

function rideService() {
  const state = { onlineDrivers: new Map(), assignedDriversByRideId: new Map(), rideParticipantsByRideId: new Map(), gpsByRideId: new Map(), routeByRideId: new Map(), pendingMatchesByRideId: new Map() };
  const produced = [];
  const producer = new Proxy({}, { get: (_t, name) => async (payload) => { produced.push({ name: String(name), payload }); } });
  const consumer = createRideRequestedConsumer({ state, rideEnv: { MATCH_RADIUS_KM: '5', MAX_MATCH_ATTEMPTS: '200' }, rideEventsProducer: producer });
  return { state, produced, producer, send: (event) => consumer.handle(JSON.stringify({ ...event, timestamp: event.timestamp ?? new Date().toISOString() }), CTX) };
}
async function user(role = 'RIDER') {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:group-rs:${id}`, role, name: 'Ada Obi' } });
  made.users.push(id);
  return id;
}
const tripRequest = (rideId, riderId, stops) => ({
  eventType: 'RIDE_REQUESTED', rideId, riderId,
  pickup: { lat: 6.5095, lng: 3.3711, address: 'Yaba' }, destination: { lat: 6.62, lng: 3.51, address: 'Ikorodu' }, stops: [],
  fareEstimateNgn: 15750, paymentMethod: 'CASH', riderOfferNgn: 15750, suggestedFareNgn: 15750, minOfferNgn: 2600, ratePerKmNgn: 500, channel: 'APP',
  groupTrip: { stops },
});

test('a second group trip never ends the first one (both owned by the group account)', async () => {
  const groupAccount = await user();
  const rs = rideService();
  const [t1, t2] = [randomUUID(), randomUUID()];
  made.rides.push(t1, t2);
  const stops = () => {
    const [a, b] = [randomUUID(), randomUUID()];
    return [{ rideId: a, kind: 'pickup', lat: 6.5, lng: 3.37, address: 'Yaba' }, { rideId: b, kind: 'pickup', lat: 6.51, lng: 3.38, address: 'Sabo' }, { rideId: b, kind: 'dropoff', lat: 6.6, lng: 3.5, address: 'Ikorodu' }, { rideId: a, kind: 'dropoff', lat: 6.62, lng: 3.51, address: 'Ikorodu' }];
  };
  await rs.send(tripRequest(t1, groupAccount, stops()));
  await rs.send(tripRequest(t2, groupAccount, stops()));
  const rows = await prisma.ride.findMany({ where: { id: { in: [t1, t2] } } });
  assert.deepEqual(rows.map((r) => [r.groupRole, r.status]).sort(), [['TRIP', 'MATCHING'], ['TRIP', 'MATCHING']]);
});

test('a rider in a group is never searched for alone (a price change or a late bid)', async () => {
  const riderId = await user();
  const rs = rideService();
  const seat = (await prisma.ride.create({ data: { riderId, status: 'MATCHING', paymentMethod: 'WALLET', riderOfferNgn: 9000, pickupLat: 6.5, pickupLng: 3.37, pickupAddress: 'Yaba', destLat: 6.6, destLng: 3.5, destAddress: 'Ikorodu', groupTripId: randomUUID(), groupRole: 'SEAT' } })).id;
  made.rides.push(seat);
  await rs.send({ eventType: 'RIDE_RIDER_COUNTER_OFFER', rideId: seat, riderId, counterOfferNgn: 8000 });
  assert.equal(rs.state.pendingMatchesByRideId.has(seat), false);
  assert.equal(rs.produced.some((p) => JSON.stringify(p.payload ?? '').includes(seat)), false);
});

test('a ride that never started is not completed; a late start never revives a cancelled ride', async () => {
  const riderId = await user();
  const driverUserId = await user('DRIVER');
  const driver = await prisma.driver.create({ data: { userId: driverUserId, kycStatus: 'APPROVED', status: 'ONLINE' } });
  const produced = [];
  const producer = new Proxy({}, { get: (_t, name) => async (payload) => { produced.push({ name: String(name), payload }); } });
  const lifecycle = createTripLifecycleHandler({ rideEventsProducer: producer });
  const mk = async (status) => (await prisma.ride.create({ data: { riderId, driverId: driver.id, status, paymentMethod: 'WALLET', riderOfferNgn: 5000, agreedFareNgn: 5000, pickupLat: 6.5, pickupLng: 3.37, pickupAddress: 'Yaba', destLat: 6.6, destLng: 3.5, destAddress: 'Ikeja' } })).id;
  const arrived = await mk('ARRIVED');
  const cancelled = await mk('CANCELLED');
  made.rides.push(arrived, cancelled);
  await lifecycle.handleRideEvent({ eventType: 'RIDE_COMPLETION_REQUESTED', rideId: arrived, riderId, driverId: driver.id, fareNgn: 5000, endedBy: 'driver', timestamp: new Date().toISOString() }, CTX);
  assert.equal((await prisma.ride.findUnique({ where: { id: arrived } })).status, 'ARRIVED');
  assert.equal(produced.length, 0, 'no RIDE_COMPLETED: nobody charged, nobody paid');
  await lifecycle.handleRideEvent({ eventType: 'RIDE_STARTED', rideId: cancelled, riderId, driverId: driver.id, lockedFareNgn: 5000, paymentMethod: 'WALLET', startedAt: new Date().toISOString(), timestamp: new Date().toISOString() }, CTX);
  assert.equal((await prisma.ride.findUnique({ where: { id: cancelled } })).status, 'CANCELLED');
  await prisma.ride.deleteMany({ where: { id: { in: [arrived, cancelled] } } });
  await prisma.driver.delete({ where: { id: driver.id } });
});

test.after(async () => {
  await prisma.rideStop.deleteMany({ where: { rideId: { in: made.rides } } }).catch(() => {});
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});
