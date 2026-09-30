// An operator's nudge sends the ride itself to that driver, however far; and a
// rider raising their price is saved on the ride, so a driver can always take
// the rider's price, however high. Against the local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/nudge-and-raised-price.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { createRideRequestedConsumer } = require('../apps/ride-service/dist/consumers/ride-requested.consumer.js');
const { assertOfferWithinBand } = require('../apps/api-gateway/dist/websocket/handlers/ride.handler.js');

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
  await prisma.user.create({ data: { id, privyDid: `test:nudge:${id}`, role, name: `Test ${role}` } });
  made.users.push(id);
  return id;
}
async function openRide(offer = 2500) {
  const riderId = await user('RIDER');
  const ride = await prisma.ride.create({ data: { riderId, status: 'MATCHING', pickupLat: AKOKA.lat, pickupLng: AKOKA.lng, pickupAddress: AKOKA.address, destLat: YABA.lat, destLng: YABA.lng, destAddress: YABA.address, riderOfferNgn: offer, fareEstimateNgn: 2800, distanceKm: 3.2, paymentMethod: 'WALLET' } });
  made.rides.push(ride.id);
  return { rideId: ride.id, riderId };
}
async function driver({ status, at }) {
  const userId = await user('DRIVER');
  const row = await prisma.driver.create({ data: { userId, kycStatus: 'APPROVED', status, lat: at?.lat ?? null, lng: at?.lng ?? null, lastSeenAt: new Date() } });
  return { driverId: row.id, userId };
}
const pendingOf = (state, rideId) => state.pendingMatchesByRideId.get(rideId);
const stop = (state) => { for (const p of state.pendingMatchesByRideId.values()) if (p.timeout) clearTimeout(p.timeout); };

test('a nudge sends the ride to an online driver 25 km away, who then also gets the rider\'s price changes', async () => {
  const { rideId, riderId } = await openRide();
  const far = await driver({ status: 'ONLINE', at: { lat: AKOKA.lat + 25 / 111, lng: AKOKA.lng } });
  const { state, produced, send } = service();

  await send({ eventType: 'RIDE_DISPATCH_DIRECTED', rideId, driverId: far.driverId, driverUserId: far.userId });
  // (Picking the ride up also re-offers it to drivers near the pickup: only offers to OUR driver count.)
  const offers = produced.filter((p) => p.name === 'broadcastRideOffer' && p.payload.drivers.some((d) => d.driverId === far.driverId));
  assert.equal(offers.length, 1);
  assert.deepEqual(offers[0].payload.drivers.map((d) => d.driverId), [far.driverId], 'the offer went to them');
  assert.ok(offers[0].payload.drivers[0].distanceKm > 20, 'however far');
  assert.ok(pendingOf(state, rideId).directedDriverIds.has(far.driverId));

  await send({ eventType: 'RIDE_RIDER_COUNTER_OFFER', rideId, riderId, counterOfferNgn: 4000 });
  const updates = produced.filter((p) => p.name === 'sendUpdatedOfferToDriver').map((p) => p.payload.driver.driverId);
  assert.ok(updates.includes(far.driverId), 'the new price reaches them too');
  stop(state);
});

test('an offline driver: the ride is held for them, nothing is sent until they go online', async () => {
  const { rideId } = await openRide();
  const off = await driver({ status: 'OFFLINE' });
  const { state, produced, send } = service();
  await send({ eventType: 'RIDE_DISPATCH_DIRECTED', rideId, driverId: off.driverId, driverUserId: off.userId });
  assert.equal(produced.filter((p) => p.name === 'broadcastRideOffer' && p.payload.drivers.some((d) => d.driverId === off.driverId)).length, 0);
  assert.ok(pendingOf(state, rideId).directedDriverIds.has(off.driverId), 'held for them');
  stop(state);
});

test('a raised price is saved on the ride, and a driver can take it however high; only a typed counter-bid has the typo guard', async () => {
  const { rideId, riderId } = await openRide(2500);
  const { state, send } = service();
  await send({ eventType: 'RIDE_RIDER_COUNTER_OFFER', rideId, riderId, counterOfferNgn: 50000 });
  assert.equal(Number((await prisma.ride.findUnique({ where: { id: rideId } })).riderOfferNgn), 50000, 'saved: the old ₦2,500 is gone');

  await assertOfferWithinBand(rideId, 50000, 'driver');   // taking the rider's price: goes through
  await assertOfferWithinBand(rideId, 60000, 'driver');   // a counter-bid a little above: fine
  await assert.rejects(assertOfferWithinBand(rideId, 5_000_000, 'driver'), 'a typed bid 100x the price is still caught');
  stop(state);
});

test.after(async () => {
  await prisma.driverBid.deleteMany({ where: { rideId: { in: made.rides } } }).catch(() => {});
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
  await prisma.$disconnect();
});
