// A ride sent to a driver again (a nudge, a reconnect, a rebuild) shows the
// time its search actually has left — the countdown does not start over.
// Only the rider changing their price moves it (the search really restarts).
// Against the local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/offer-clock.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { createRideRequestedConsumer } = require('../apps/ride-service/dist/consumers/ride-requested.consumer.js');

const prisma = new PrismaClient();
const AKOKA = { lat: 6.5244, lng: 3.3870, address: '31 Emily Akinola St, Akoka, Lagos' };
const YABA = { lat: 6.5095, lng: 3.3711, address: '7 Osaro Isokpan St, Yaba, Lagos' };
const made = { users: [], rides: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.beforeEach(() => { console.log = console.info = console.warn = () => {}; });

async function user(role) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:clock:${id}`, role, name: `Test ${role}` } });
  made.users.push(id);
  return id;
}

test('a nudge after the search started carries the search\'s own clock; a new rider price restarts it', async () => {
  const riderId = await user('RIDER');
  const ride = await prisma.ride.create({ data: { riderId, status: 'MATCHING', pickupLat: AKOKA.lat, pickupLng: AKOKA.lng, pickupAddress: AKOKA.address, destLat: YABA.lat, destLng: YABA.lng, destAddress: YABA.address, riderOfferNgn: 4200, fareEstimateNgn: 4200, distanceKm: 3.2, paymentMethod: 'WALLET' } });
  made.rides.push(ride.id);
  const userId = await user('DRIVER');
  const driver = await prisma.driver.create({ data: { userId, kycStatus: 'APPROVED', status: 'ONLINE', lat: AKOKA.lat + 0.3, lng: AKOKA.lng, lastSeenAt: new Date() } });

  const state = { onlineDrivers: new Map(), assignedDriversByRideId: new Map(), rideParticipantsByRideId: new Map(), gpsByRideId: new Map(), routeByRideId: new Map(), pendingMatchesByRideId: new Map() };
  const produced = [];
  const producer = new Proxy({}, { get: (_t, name) => async (payload) => { produced.push({ name: String(name), payload }); } });
  const consumer = createRideRequestedConsumer({ state, rideEnv: { MATCH_RADIUS_KM: '5', MAX_MATCH_ATTEMPTS: '200' }, rideEventsProducer: producer });
  const send = (event) => consumer.handle(JSON.stringify({ ...event, timestamp: new Date().toISOString() }), { topic: 'ride.events' });

  // The search is picked up (as after a restart): its clock is set once.
  await send({ eventType: 'RIDE_RIDER_COUNTER_OFFER', rideId: ride.id, riderId, counterOfferNgn: 4200 });
  const closesAt = state.pendingMatchesByRideId.get(ride.id).closesAt;
  assert.ok(closesAt > Date.now(), 'the search has a closing time');

  await sleep(1200);
  await send({ eventType: 'RIDE_DISPATCH_DIRECTED', rideId: ride.id, driverId: driver.id, driverUserId: userId });
  const nudged = produced.filter((p) => p.name === 'broadcastRideOffer' && p.payload.drivers.some((d) => d.driverId === driver.id));
  assert.equal(nudged.length, 1);
  assert.equal(nudged[0].payload.expiresAt.getTime(), closesAt, 'same clock, not a fresh half hour');

  await sleep(50);
  await send({ eventType: 'RIDE_RIDER_COUNTER_OFFER', rideId: ride.id, riderId, counterOfferNgn: 4800 });
  const pending = state.pendingMatchesByRideId.get(ride.id);
  assert.ok(pending.closesAt > closesAt, 'a new price restarts the search window');
  const update = produced.filter((p) => p.name === 'sendUpdatedOfferToDriver' && p.payload.driver.driverId === driver.id).pop();
  assert.equal(update.payload.expiresAt.getTime(), pending.closesAt, 'and the update says so');
  if (pending.timeout) clearTimeout(pending.timeout);
});

test.after(async () => {
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
  await prisma.$disconnect();
});
