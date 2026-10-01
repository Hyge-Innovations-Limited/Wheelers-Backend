// The rider declined every offer and the search goes on: a declined driver is
// still in it. They get the rider's next price, and a new bid from them is
// live again (PENDING) — the rider sees it. Against the local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/declined-can-bid-again.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { createRideRequestedConsumer } = require('../apps/ride-service/dist/consumers/ride-requested.consumer.js');
const { driverBidClient } = require('../packages/db/dist/index.js');

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

test('declined: the driver still gets the rider\'s next price, and their new bid is live again', async () => {
  const riderId = await user('RIDER');
  const ride = await prisma.ride.create({ data: { riderId, status: 'MATCHING', pickupLat: AKOKA.lat, pickupLng: AKOKA.lng, pickupAddress: AKOKA.address, destLat: YABA.lat, destLng: YABA.lng, destAddress: YABA.address, riderOfferNgn: 4200, fareEstimateNgn: 4200, distanceKm: 3.2, paymentMethod: 'WALLET' } });
  made.rides.push(ride.id);
  const userId = await user('DRIVER');
  const at = { lat: AKOKA.lat + 0.005, lng: AKOKA.lng };
  const driver = await prisma.driver.create({ data: { userId, kycStatus: 'APPROVED', status: 'ONLINE', lat: at.lat, lng: at.lng, lastSeenAt: new Date() } });

  const { state, produced, send } = service();
  state.onlineDrivers.set(driver.id, { driverId: driver.id, userId, lat: at.lat, lng: at.lng, vehiclePlate: 'LAG23469', vehicleModel: 'Camry' });
  await send({ eventType: 'RIDE_RIDER_COUNTER_OFFER', rideId: ride.id, riderId, counterOfferNgn: 4300 });

  await driverBidClient.record({ rideId: ride.id, driverId: driver.id, driverUserId: userId, riderId, amountNgn: 4400, etaSeconds: 300 });
  const declined = await driverBidClient.declineOpen(ride.id);
  assert.deepEqual(declined.map((b) => b.driverId), [driver.id]);
  await send({ eventType: 'RIDE_BIDS_DECLINED', rideId: ride.id, riderId, driverUserIds: [userId] });

  await send({ eventType: 'RIDE_RIDER_COUNTER_OFFER', rideId: ride.id, riderId, counterOfferNgn: 4600 });
  const updates = produced.filter((p) => p.name === 'sendUpdatedOfferToDriver' && p.payload.driver.driverId === driver.id);
  assert.equal(updates.length, 2, 'the new price reaches the declined driver');
  assert.equal(updates[1].payload.updatedOfferNgn, 4600);

  await driverBidClient.record({ rideId: ride.id, driverId: driver.id, driverUserId: userId, riderId, amountNgn: 4600, etaSeconds: 300 });
  const row = await prisma.driverBid.findUnique({ where: { rideId_driverId: { rideId: ride.id, driverId: driver.id } } });
  assert.equal(row.status, 'PENDING', 'a new bid is live again');
  assert.equal(Number(row.amountNgn), 4600);
  for (const p of state.pendingMatchesByRideId.values()) if (p.timeout) clearTimeout(p.timeout);
});

test.after(async () => {
  await prisma.driverBid.deleteMany({ where: { rideId: { in: made.rides } } }).catch(() => {});
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
  await prisma.$disconnect();
});
