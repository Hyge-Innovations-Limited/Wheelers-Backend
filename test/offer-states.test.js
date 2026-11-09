// What a driver's bid card hears, and when: the rider declined every offer
// (DECLINED, told at once), the rider is paying for this driver, and the
// request was taken by someone else (told to every driver who got it, not
// only those who bid). Against the local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/offer-states.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { driverBidClient } = require('../packages/db/dist/index.js');
const { declineAllOffers } = require('../apps/api-gateway/dist/rides/whatsapp-ride.service.js');
const { getBids } = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');
const { createRideRequestedConsumer } = require('../apps/ride-service/dist/consumers/ride-requested.consumer.js');
const { handleRideEvent } = require('../apps/api-gateway/dist/kafka/consumer.js');

const prisma = new PrismaClient();
const made = { users: [], rides: [] };
test.beforeEach(() => { console.log = console.info = console.warn = () => {}; });

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
  await prisma.user.create({ data: { id, privyDid: `test:states:${id}`, role, name: `Test ${role}` } });
  made.users.push(id);
  return id;
}
async function driver() {
  const userId = await user('DRIVER');
  const row = await prisma.driver.create({ data: { userId, kycStatus: 'APPROVED', status: 'ONLINE', lat: 6.52, lng: 3.38, lastSeenAt: new Date() } });
  return { driverId: row.id, userId };
}
async function openRide(riderId) {
  const ride = await prisma.ride.create({ data: { riderId, status: 'MATCHING', pickupLat: 6.5244, pickupLng: 3.387, pickupAddress: 'Akoka', destLat: 6.5095, destLng: 3.3711, destAddress: 'Yaba', riderOfferNgn: 3000, fareEstimateNgn: 3000, distanceKm: 3, paymentMethod: 'WALLET' } });
  made.rides.push(ride.id);
  return ride.id;
}

test('decline all: the open bids become DECLINED and each of those drivers is told; a bid already resolved is left alone', async () => {
  const riderId = await user('RIDER');
  const rideId = await openRide(riderId);
  const a = await driver(); const b = await driver(); const c = await driver();
  for (const d of [a, b, c]) await driverBidClient.record({ rideId, driverId: d.driverId, driverUserId: d.userId, riderId, amountNgn: 3000, etaSeconds: 300 });
  await driverBidClient.markWithdrawn(rideId, c.driverId);

  const redis = memoryRedis();
  const published = [];
  const publisher = { publishRideEvent: async (event) => { published.push(event); } };
  const result = await declineAllOffers({ redisClient: redis, publisher }, riderId, rideId);

  assert.equal(result.declined, 2);
  const rows = await prisma.driverBid.findMany({ where: { rideId }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(rows.map((r) => r.status).sort(), ['DECLINED', 'DECLINED', 'WITHDRAWN']);
  assert.equal(published.length, 1);
  assert.equal(published[0].eventType, 'RIDE_BIDS_DECLINED');
  assert.deepEqual([...published[0].driverUserIds].sort(), [a.userId, b.userId].sort());
  assert.deepEqual(await getBids(redis, rideId), [], 'and the offers list is empty');

  const again = await declineAllOffers({ redisClient: redis, publisher }, riderId, rideId);
  assert.equal(again.declined, 0);
  assert.deepEqual(published[1].driverUserIds, [], 'no driver to tell the second time (the count on the message still resets)');
});

test('the rider accepts one driver: every OTHER driver who got the request is listed to be told it is taken', async () => {
  const riderId = await user('RIDER');
  const rideId = await openRide(riderId);
  const winner = await driver(); const other = await driver(); const silent = await driver();
  const state = { onlineDrivers: new Map(), assignedDriversByRideId: new Map(), rideParticipantsByRideId: new Map(), gpsByRideId: new Map(), routeByRideId: new Map(), pendingMatchesByRideId: new Map() };
  const produced = [];
  const producer = new Proxy({}, { get: (_t, name) => async (payload) => { produced.push({ name: String(name), payload }); } });
  const consumer = createRideRequestedConsumer({ state, rideEnv: { MATCH_RADIUS_KM: '5', MAX_MATCH_ATTEMPTS: '200' }, rideEventsProducer: producer });
  const send = (event) => consumer.handle(JSON.stringify({ ...event, timestamp: new Date().toISOString() }), { topic: 'ride.events' });

  await send({ eventType: 'RIDE_RIDER_COUNTER_OFFER', rideId, riderId, counterOfferNgn: 3000 });   // puts the search in memory
  const pending = state.pendingMatchesByRideId.get(rideId);
  for (const d of [winner, other, silent]) pending.candidates = [...pending.candidates, { driverId: d.driverId, userId: d.userId, lat: 6.52, lng: 3.38, vehiclePlate: '', vehicleModel: '' }];

  await send({ eventType: 'RIDE_OFFER_ACCEPTED', rideId, riderId, driverId: winner.driverId, driverUserId: winner.userId, agreedFareNgn: 3000, paymentMethod: 'WALLET' });
  const assigned = produced.find((p) => p.name === 'rideDriverAssigned');
  assert.ok(assigned, 'assigned');
  const told = assigned.payload.offeredDriverUserIds;
  assert.ok(told.includes(other.userId) && told.includes(silent.userId), 'bidders and non-bidders alike');
  assert.ok(!told.includes(winner.userId), 'never the winner');
  for (const p of state.pendingMatchesByRideId.values()) if (p.timeout) clearTimeout(p.timeout);
});

test('the rider pays one driver: every other bidder\'s request ends at once — including a driver they had declined', async () => {
  const riderId = await user('RIDER');
  const rideId = await openRide(riderId);
  const winner = await driver(); const waiting = await driver(); const declined = await driver();
  for (const d of [winner, waiting, declined]) await driverBidClient.record({ rideId, driverId: d.driverId, driverUserId: d.userId, riderId, amountNgn: 3000, etaSeconds: 300 });
  await prisma.driverBid.updateMany({ where: { rideId, driverId: declined.driverId }, data: { status: 'DECLINED' } });

  const told = [];
  const deps = {
    registry: { sendToUser: async (userId, type, payload) => { told.push({ userId, type, payload }); }, isUserConnected: async () => false },
    redisClient: memoryRedis(),
    publisher: { publishRideEvent: async () => {}, publishDriverEvent: async () => {}, publishNotificationEvent: async () => {} },
  };
  await handleRideEvent({
    eventType: 'RIDE_DRIVER_ASSIGNED', rideId, riderId, driverId: winner.driverId, driverUserId: winner.userId,
    driverName: 'Winner', driverRating: 5, vehiclePlate: 'LAG1', vehicleModel: 'Camry', etaSeconds: 180,
    agreedFareNgn: 3000, lockedFareNgn: 3000, paymentMethod: 'WALLET',
    offeredDriverUserIds: [winner.userId, waiting.userId, declined.userId], timestamp: new Date().toISOString(),
  }, deps, new Map());

  const taken = (userId) => told.filter((m) => m.userId === userId && m.type === 'ride:bid_lost').length;
  assert.equal(taken(waiting.userId), 1, 'the driver waiting on the rider: taken');
  assert.equal(taken(declined.userId), 1, 'the declined driver too — their red card closes');
  assert.equal(taken(winner.userId), 0, 'never the winner');
  const status = async (d) => (await prisma.driverBid.findFirst({ where: { rideId, driverId: d.driverId } })).status;
  assert.equal(await status(waiting), 'LOST');
  assert.equal(await status(declined), 'LOST', 'not left DECLINED, which the app would rebuild as a live card');
});

test.after(async () => {
  await prisma.driverBid.deleteMany({ where: { rideId: { in: made.rides } } }).catch(() => {});
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
  await prisma.$disconnect();
});
