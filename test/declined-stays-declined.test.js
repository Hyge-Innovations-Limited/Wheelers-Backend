// The rider declined every offer and the search goes on: the drivers declined
// never get that ride again — not with the rider's next price, not on a
// reconnect, not after ride-service restarts. Against the local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/declined-stays-declined.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { createRideRequestedConsumer } = require('../apps/ride-service/dist/consumers/ride-requested.consumer.js');

const prisma = new PrismaClient();
const AKOKA = { lat: 6.5244, lng: 3.3870, address: '31 Emily Akinola St, Akoka, Lagos' };
const YABA = { lat: 6.5095, lng: 3.3711, address: '7 Osaro Isokpan St, Yaba, Lagos' };
const made = { users: [], rides: [] };

test.beforeEach(() => { console.log = console.info = console.warn = () => {}; });

function service() {
  const state = { onlineDrivers: new Map(), assignedDriversByRideId: new Map(), rideParticipantsByRideId: new Map(), gpsByRideId: new Map(), routeByRideId: new Map(), pendingMatchesByRideId: new Map() };
  const produced = [];
  const producer = new Proxy({}, { get: (_t, name) => async (payload) => { produced.push({ name: String(name), payload }); } });
  const consumer = createRideRequestedConsumer({ state, rideEnv: { MATCH_RADIUS_KM: '5', MAX_MATCH_ATTEMPTS: '200' }, rideEventsProducer: producer });
  const send = (event) => consumer.handle(JSON.stringify({ ...event, timestamp: new Date().toISOString() }), { topic: 'ride.events' });
  return { state, produced, send };
}
async function user(role) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:declined:${id}`, role, name: `Test ${role}` } });
  made.users.push(id);
  return id;
}
async function openRide() {
  const riderId = await user('RIDER');
  const ride = await prisma.ride.create({ data: { riderId, status: 'MATCHING', pickupLat: AKOKA.lat, pickupLng: AKOKA.lng, pickupAddress: AKOKA.address, destLat: YABA.lat, destLng: YABA.lng, destAddress: YABA.address, riderOfferNgn: 4200, fareEstimateNgn: 4200, distanceKm: 3.2, paymentMethod: 'WALLET' } });
  made.rides.push(ride.id);
  return { rideId: ride.id, riderId };
}
async function nearbyDriver(state) {
  const userId = await user('DRIVER');
  const at = { lat: AKOKA.lat + 0.005, lng: AKOKA.lng };
  const row = await prisma.driver.create({ data: { userId, kycStatus: 'APPROVED', status: 'ONLINE', lat: at.lat, lng: at.lng, lastSeenAt: new Date() } });
  state.onlineDrivers.set(row.id, { driverId: row.id, userId, lat: at.lat, lng: at.lng, vehiclePlate: 'LAG23469', vehicleModel: 'Camry' });
  return { driverId: row.id, userId };
}
const priceUpdatesTo = (produced, driverId) => produced.filter((p) => p.name === 'sendUpdatedOfferToDriver' && p.payload.driver.driverId === driverId).length;
const offersTo = (produced, driverId) => produced.filter((p) => p.name === 'broadcastRideOffer' && p.payload.drivers.some((d) => d.driverId === driverId)).length;
const stop = (state) => { for (const p of state.pendingMatchesByRideId.values()) if (p.timeout) clearTimeout(p.timeout); };

test('declined: the rider\'s next price skips them, and a reconnect would too', async () => {
  const { rideId, riderId } = await openRide();
  const { state, produced, send } = service();
  const d = await nearbyDriver(state);
  const other = await nearbyDriver(state);

  await send({ eventType: 'RIDE_RIDER_COUNTER_OFFER', rideId, riderId, counterOfferNgn: 4300 });
  assert.equal(priceUpdatesTo(produced, d.driverId), 1, 'before: they get the price');

  await send({ eventType: 'RIDE_BIDS_DECLINED', rideId, riderId, driverUserIds: [d.userId], driverIds: [d.driverId] });
  await send({ eventType: 'RIDE_RIDER_COUNTER_OFFER', rideId, riderId, counterOfferNgn: 4600 });
  assert.equal(priceUpdatesTo(produced, d.driverId), 1, 'after: the new price does not reach them');
  assert.equal(priceUpdatesTo(produced, other.driverId), 2, 'a driver who was not declined still gets it');
  const pending = state.pendingMatchesByRideId.get(rideId);
  assert.ok(pending.attemptedDriverIds.has(d.driverId), 'a reconnect (onDriverOnline) skips them');
  stop(state);
});

test('an older event with user ids only still finds the driver', async () => {
  const { rideId, riderId } = await openRide();
  const { state, send } = service();
  const d = await nearbyDriver(state);
  await send({ eventType: 'RIDE_RIDER_COUNTER_OFFER', rideId, riderId, counterOfferNgn: 4300 });
  await send({ eventType: 'RIDE_BIDS_DECLINED', rideId, riderId, driverUserIds: [d.userId] });
  assert.ok(state.pendingMatchesByRideId.get(rideId).attemptedDriverIds.has(d.driverId));
  stop(state);
});

test('after a restart: a DECLINED bid in the database keeps them out of the rebuilt search', async () => {
  const { rideId, riderId } = await openRide();
  const { state, produced, send } = service();
  const d = await nearbyDriver(state);
  await prisma.driverBid.create({ data: { rideId, driverId: d.driverId, driverUserId: d.userId, riderId, amountNgn: 4400, etaSeconds: 300, status: 'DECLINED', resolvedAt: new Date() } });

  await send({ eventType: 'RIDE_RIDER_COUNTER_OFFER', rideId, riderId, counterOfferNgn: 4500 });
  assert.equal(offersTo(produced, d.driverId), 0, 'not re-offered');
  assert.equal(priceUpdatesTo(produced, d.driverId), 0, 'no price update either');
  assert.ok(state.pendingMatchesByRideId.get(rideId).attemptedDriverIds.has(d.driverId));
  stop(state);
});

test.after(async () => {
  await prisma.driverBid.deleteMany({ where: { rideId: { in: made.rides } } }).catch(() => {});
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
  await prisma.$disconnect();
});
