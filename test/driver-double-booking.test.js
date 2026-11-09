// "CEO was able to accept 2 rides": one driver must never be matched to two live rides.
// Local Postgres, built tree.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit --test-concurrency=1 test/driver-double-booking.test.js
//
// The only thing keeping one driver on one ride before the DB says so is the Redis
// claim `whatsapp:driver:<id>:accepting` (60 s). The ride-service busy check reads the
// DB, but the DB is written one Kafka hop LATER (RIDE_DRIVER_ASSIGNED -> trip-lifecycle
// -> rideClient.assignDriver), and assignDriver never looks at the driver.

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { handleRideMessage } = require('../apps/api-gateway/dist/websocket/handlers/ride.handler.js');
const { createRideRequestedConsumer } = require('../apps/ride-service/dist/consumers/ride-requested.consumer.js');
const { createTripLifecycleHandler } = require('../apps/ride-service/dist/handlers/trip-lifecycle.handler.js');
const { handleRideEvent } = require('../apps/api-gateway/dist/kafka/consumer.js');
const { driverBidClient } = require('../packages/db/dist/index.js');

const prisma = new PrismaClient();
const made = { users: [], rides: [], drivers: [] };
const realConsole = { ...console };
test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; });
test.afterEach(() => { Object.assign(console, realConsole); });
test.after(async () => {
  await prisma.driverBid.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

async function user(role) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:double:${id}`, role, name: `Test ${role}` } });
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

test('ride-service: two riders accept the same driver before the first assignment is saved -> the driver is on two rides', async () => {
  const d = await driver();
  const riderA = await user('RIDER');
  const riderB = await user('RIDER');
  const rideA = await searching(riderA);
  const rideB = await searching(riderB);

  const assignedEvents = [];
  const producer = new Proxy({}, { get: (_t, name) => async (e) => { if (name === 'rideDriverAssigned') assignedEvents.push(e); } });
  const state = { pendingMatchesByRideId: new Map(), onlineDrivers: new Map(), rideParticipantsByRideId: new Map(), rideRouteStopsByRideId: new Map() };
  const consumer = createRideRequestedConsumer({ state, rideEnv: {}, rideEventsProducer: producer });
  const lifecycle = createTripLifecycleHandler({ state, rideEventsProducer: producer });
  const ctx = { topic: 'ride.events' };
  const accept = (r, riderId) => ({ eventType: 'RIDE_OFFER_ACCEPTED', rideId: r.id, riderId, driverId: d.id, driverUserId: d.userId, agreedFareNgn: 3000, paymentMethod: 'CASH', timestamp: new Date().toISOString() });

  // Two partitions (Kafka key = rideId): both accepts are handled before either assignment lands.
  await Promise.all([consumer.handle(accept(rideA, riderA), ctx), consumer.handle(accept(rideB, riderB), ctx)]);
  // The assignments then land one by one.
  for (const e of assignedEvents) await lifecycle.handleRideEvent(e, ctx);

  assert.equal(await liveRidesOf(d.id), 1, `BUG: driver is on ${await liveRidesOf(d.id)} rides at once (RIDE_DRIVER_ASSIGNED emitted ${assignedEvents.length}x)`);
});

test('gateway: with the Redis claim unavailable (Redis error) two riders can both tap the same driver, and the ride service still books only one', async () => {
  const d = await driver();
  const riderA = await user('RIDER');
  const riderB = await user('RIDER');
  const rideA = await searching(riderA);
  const rideB = await searching(riderB);
  for (const [r, riderId] of [[rideA, riderA], [rideB, riderB]]) {
    await driverBidClient.record({ rideId: r.id, driverId: d.id, driverUserId: d.userId, riderId, etaSeconds: 300, amountNgn: 3000 });
  }
  const published = [];
  const publisher = { publishRideEvent: async (e) => { published.push(e); }, publishWalletEvent: async () => {}, publishNotificationEvent: async () => {} };
  // A Redis that errors on the claim (a blip) but still serves the booking lock.
  const lockStore = new Map();
  const redis = {
    async get(k) { if (k.includes(':accepting')) throw new Error('redis down'); return lockStore.get(k) ?? null; },
    async set(k, v) { lockStore.set(k, v); },
    async del(k) { lockStore.delete(k); },
    async setIfNotExists(k, v) { if (k.includes(':accepting')) throw new Error('redis down'); if (lockStore.has(k)) return false; lockStore.set(k, v); return true; },
    async send() { return null; },
  };
  const accept = (r, riderId) => handleRideMessage('ride:accept_offer', { rideId: r.id, driverId: d.id, driverUserId: d.userId, agreedFareNgn: 3000, paymentMethod: 'CASH' }, { userId: riderId, role: 'RIDER' }, publisher, {}, redis);
  await accept(rideA, riderA);
  await accept(rideB, riderB);
  // With Redis down the gateway cannot stop the second tap: both acceptances are published. The ride
  // service's locked write is what keeps the driver on one ride, before anything is announced.
  const bookings = published.filter((e) => e.eventType === 'RIDE_OFFER_ACCEPTED' && e.driverId === d.id);
  assert.equal(bookings.length, 2);
  const { sent, producer } = recorder();
  const consumer = consumerFor(producer);
  await Promise.all(bookings.map((e) => consumer.handle(e, { topic: 'ride.events' })));
  assert.equal(sent.filter(([n]) => n === 'rideDriverAssigned').length, 1);
  const failed = sent.filter(([n]) => n === 'rideAssignmentFailed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0][1].reason, 'driver_busy');
  assert.equal(await liveRidesOf(d.id), 1);
});

const planner = { planRoute: async () => ({ distanceKm: 10, durationSeconds: 1500, suggestedFareNgn: 5000, minOfferNgn: 4100, ratePerKmNgn: 400, geometry: { coordinates: [{ lat: 6.6, lng: 3.35 }, { lat: 6.5, lng: 3.36 }], bounds: { northEast: { lat: 6.6, lng: 3.4 }, southWest: { lat: 6.5, lng: 3.3 } } } }) };

test('rider side: a rider already on a trip can start a second ride through the app socket (ride:request)', async () => {
  const riderId = await user('RIDER');
  const d = await driver();
  const trip = await searching(riderId);
  await prisma.ride.update({ where: { id: trip.id }, data: { status: 'IN_PROGRESS', driverId: d.id } });
  const published = [];
  const publisher = { publishRideEvent: async (e) => { published.push(e); }, publishWalletEvent: async () => {}, publishNotificationEvent: async () => {} };
  // Thrown, so the app gets its error frame (it has no handler for ride:request:rejected).
  await assert.rejects(
    handleRideMessage('ride:request', { pickup: { lat: 6.5244, lng: 3.387, address: 'Akoka' }, destination: { lat: 6.5095, lng: 3.3711, address: 'Yaba' }, offerNgn: 5000 }, { userId: riderId, role: 'RIDER' }, publisher, planner, undefined),
    /You already have a ride in progress\. To book a new one, cancel it first\./,
  );
  assert.equal(published.length, 0, 'nothing was published');
});

test('when the assignment is announced, the driver\'s open bid on another ride is withdrawn and that rider\'s lists drop it', async () => {
  const d = await driver();
  const riderA = await user('RIDER');
  const riderB = await user('RIDER');
  const rideA = await searching(riderA);
  const rideB = await searching(riderB);
  for (const [r, riderId] of [[rideA, riderA], [rideB, riderB]]) {
    await driverBidClient.record({ rideId: r.id, driverId: d.id, driverUserId: d.userId, riderId, etaSeconds: 300, amountNgn: 3000 });
  }
  const toApp = [];
  const registry = { sendToUser: async (userId, type, payload) => { toApp.push({ userId, type, payload }); }, isUserConnected: async () => true, hasUser: () => true };
  const redis = { async get() { return null; }, async set() {}, async del() {}, async setIfNotExists() { return true; }, async send() { return null; } };
  const publisher = { publishRideEvent: async () => {}, publishWalletEvent: async () => {}, publishNotificationEvent: async () => {} };
  await handleRideEvent({ eventType: 'RIDE_DRIVER_ASSIGNED', rideId: rideA.id, riderId: riderA, driverId: d.id, driverUserId: d.userId, driverName: 'D', driverRating: 5, vehiclePlate: 'K', vehicleModel: 'C', etaSeconds: 0, agreedFareNgn: 3000, lockedFareNgn: 3000, paymentMethod: 'CASH', offeredDriverUserIds: [], timestamp: new Date().toISOString() }, { registry, redisClient: redis, publisher }, new Map()).catch(() => undefined);
  assert.equal((await prisma.driverBid.findUnique({ where: { rideId_driverId: { rideId: rideB.id, driverId: d.id } } })).status, 'WITHDRAWN');
  const told = toApp.find((m) => m.type === 'ride:driver_rejected' && m.userId === riderB);
  assert.deepEqual([told.payload.rideId, told.payload.driverId], [rideB.id, d.id]);
});

const acceptEvent = (r, riderId, d) => ({ eventType: 'RIDE_OFFER_ACCEPTED', rideId: r.id, riderId, driverId: d.id, driverUserId: d.userId, agreedFareNgn: 3000, paymentMethod: 'CASH', timestamp: new Date().toISOString() });
function recorder() {
  const sent = [];
  const producer = new Proxy({}, { get: (_t, name) => async (e) => { sent.push([name, e]); } });
  return { sent, producer };
}
const consumerFor = (producer) => createRideRequestedConsumer({ state: { pendingMatchesByRideId: new Map(), onlineDrivers: new Map(), rideParticipantsByRideId: new Map(), rideRouteStopsByRideId: new Map() }, rideEnv: {}, rideEventsProducer: producer });

test('two acceptances of one driver handled at the same moment: exactly one RIDE_DRIVER_ASSIGNED, the other is refused driver_busy BEFORE anything is announced', async () => {
  const d = await driver();
  const riderA = await user('RIDER');
  const riderB = await user('RIDER');
  const rideA = await searching(riderA);
  const rideB = await searching(riderB);
  const { sent, producer } = recorder();
  const consumer = consumerFor(producer);
  const ctx = { topic: 'ride.events' };
  await Promise.all([consumer.handle(acceptEvent(rideA, riderA, d), ctx), consumer.handle(acceptEvent(rideB, riderB, d), ctx)]);
  const assigned = sent.filter(([n]) => n === 'rideDriverAssigned');
  const failed = sent.filter(([n]) => n === 'rideAssignmentFailed');
  assert.equal(assigned.length, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0][1].reason, 'driver_busy');
  assert.notEqual(failed[0][1].rideId, assigned[0][1].rideId);
  assert.equal(await liveRidesOf(d.id), 1);
});

test('a redelivered acceptance (written, announcement lost) announces again; it is not refused as busy or closed', async () => {
  const d = await driver();
  const riderA = await user('RIDER');
  const rideA = await searching(riderA);
  const { sent, producer } = recorder();
  const consumer = consumerFor(producer);
  const ctx = { topic: 'ride.events' };
  await consumer.handle(acceptEvent(rideA, riderA, d), ctx);
  await consumer.handle(acceptEvent(rideA, riderA, d), ctx);
  assert.equal(sent.filter(([n]) => n === 'rideDriverAssigned').length, 2);
  assert.equal(sent.filter(([n]) => n === 'rideAssignmentFailed').length, 0);
  assert.equal(await liveRidesOf(d.id), 1);
});

test('the lock itself: two assignments of one driver run at the same moment through the lifecycle give one live ride', async () => {
  for (let round = 0; round < 5; round += 1) {
    const d = await driver();
    const riderA = await user('RIDER');
    const riderB = await user('RIDER');
    const rideA = await searching(riderA);
    const rideB = await searching(riderB);
    const { sent, producer } = recorder();
    const lifecycle = createTripLifecycleHandler({ state: { rideParticipantsByRideId: new Map() }, rideEventsProducer: producer });
    const assigned = (r, riderId) => ({ eventType: 'RIDE_DRIVER_ASSIGNED', rideId: r.id, riderId, driverId: d.id, driverUserId: d.userId, driverName: 'D', driverRating: 5, vehiclePlate: 'K', vehicleModel: 'C', etaSeconds: 0, agreedFareNgn: 3000, lockedFareNgn: 3000, paymentMethod: 'CASH', offeredDriverUserIds: [], timestamp: new Date().toISOString() });
    await Promise.all([lifecycle.handleRideEvent(assigned(rideA, riderA), { topic: 'ride.events' }), lifecycle.handleRideEvent(assigned(rideB, riderB), { topic: 'ride.events' })]);
    assert.equal(await liveRidesOf(d.id), 1, `round ${round}`);
    assert.equal(sent.filter(([n]) => n === 'rideAssignmentFailed' && true).length, 1, `round ${round}`);
  }
});

test('the driver is refused with driver_busy through the lifecycle (the same failure the busy check sends), and a redelivery of the winning assignment is not refused', async () => {
  const d = await driver();
  const riderA = await user('RIDER');
  const riderB = await user('RIDER');
  const rideA = await searching(riderA);
  const rideB = await searching(riderB);
  const sent = [];
  const producer = new Proxy({}, { get: (_t, name) => async (e) => { sent.push([name, e]); } });
  const lifecycle = createTripLifecycleHandler({ state: { rideParticipantsByRideId: new Map() }, rideEventsProducer: producer });
  const assigned = (r, riderId) => ({ eventType: 'RIDE_DRIVER_ASSIGNED', rideId: r.id, riderId, driverId: d.id, driverUserId: d.userId, driverName: 'D', driverRating: 5, vehiclePlate: 'K', vehicleModel: 'C', etaSeconds: 0, agreedFareNgn: 3000, lockedFareNgn: 3000, paymentMethod: 'CASH', offeredDriverUserIds: [], timestamp: new Date().toISOString() });
  await lifecycle.handleRideEvent(assigned(rideA, riderA), { topic: 'ride.events' });
  await lifecycle.handleRideEvent(assigned(rideA, riderA), { topic: 'ride.events' });
  assert.equal(sent.filter(([n]) => n === 'rideAssignmentFailed').length, 0);
  await lifecycle.handleRideEvent(assigned(rideB, riderB), { topic: 'ride.events' });
  const failed = sent.filter(([n]) => n === 'rideAssignmentFailed');
  assert.equal(failed.length, 1);
  assert.deepEqual([failed[0][1].rideId, failed[0][1].reason], [rideB.id, 'driver_busy']);
  assert.equal((await prisma.ride.findUnique({ where: { id: rideB.id } })).driverId, null);
  assert.equal(await liveRidesOf(d.id), 1);
});

test('rider side: a search still on, and a ride that ended or was cancelled, do not stop a new request', async () => {
  const riderId = await user('RIDER');
  const published = [];
  const publisher = { publishRideEvent: async (e) => { published.push(e); }, publishWalletEvent: async () => {}, publishNotificationEvent: async () => {} };
  const request = () => handleRideMessage('ride:request', { pickup: { lat: 6.5244, lng: 3.387, address: 'Akoka' }, destination: { lat: 6.5095, lng: 3.3711, address: 'Yaba' }, offerNgn: 5000 }, { userId: riderId, role: 'RIDER' }, publisher, planner, undefined);
  // A search still looking for a driver (MATCHING) is not a trip.
  await searching(riderId);
  const whileSearching = await request();
  assert.notEqual(whileSearching.type, 'ride:request:rejected', JSON.stringify(whileSearching.payload));
  for (const status of ['CANCELLED', 'COMPLETED']) {
    const old = await searching(riderId);
    await prisma.ride.update({ where: { id: old.id }, data: { status } });
    const reply = await request();
    assert.notEqual(reply.type, 'ride:request:rejected', `${status}: ${JSON.stringify(reply.payload)}`);
  }
  for (const e of published) if (e.rideId) made.rides.push(e.rideId);
});

const { rideClient } = require('../packages/db/dist/index.js');
const fastConsumer = (producer) => createRideRequestedConsumer({ state: { pendingMatchesByRideId: new Map(), onlineDrivers: new Map(), rideParticipantsByRideId: new Map(), rideRouteStopsByRideId: new Map() }, rideEnv: {}, rideEventsProducer: producer, assignRetryDelaysMs: [5, 5, 5] });

test('a database error on the write before announcing is retried; still failing, nothing is announced and the rider is told driver_busy', async () => {
  const d = await driver();
  const riderA = await user('RIDER');
  const rideA = await searching(riderA);
  const real = rideClient.assignDriver;
  let calls = 0;
  try {
    // Fails twice, then works: announced.
    rideClient.assignDriver = (...args) => { calls += 1; if (calls <= 2) return Promise.reject(Object.assign(new Error('db blip'), { code: 'P1001' })); return real(...args); };
    const ok = recorder();
    await fastConsumer(ok.producer).handle(acceptEvent(rideA, riderA, d), { topic: 'ride.events' });
    assert.equal(calls, 3);
    assert.equal(ok.sent.filter(([n]) => n === 'rideDriverAssigned').length, 1);
    assert.equal(ok.sent.filter(([n]) => n === 'rideAssignmentFailed').length, 0);

    // Always failing: refused before any announcement.
    const riderB = await user('RIDER');
    const rideB = await searching(riderB);
    const d2 = await driver();
    calls = 0;
    rideClient.assignDriver = () => { calls += 1; return Promise.reject(Object.assign(new Error('db down'), { code: 'P1001' })); };
    const bad = recorder();
    await fastConsumer(bad.producer).handle(acceptEvent(rideB, riderB, d2), { topic: 'ride.events' });
    assert.equal(calls, 4, 'one try and three retries');
    assert.equal(bad.sent.filter(([n]) => n === 'rideDriverAssigned').length, 0);
    const failed = bad.sent.filter(([n]) => n === 'rideAssignmentFailed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0][1].reason, 'driver_busy');

    // A error that is not a passing database trouble is not retried.
    const riderC = await user('RIDER');
    const rideC = await searching(riderC);
    const d3 = await driver();
    calls = 0;
    rideClient.assignDriver = () => { calls += 1; return Promise.reject(new Error('some other failure')); };
    const other = recorder();
    await fastConsumer(other.producer).handle(acceptEvent(rideC, riderC, d3), { topic: 'ride.events' });
    assert.equal(calls, 1);
    assert.equal(other.sent.filter(([n]) => n === 'rideDriverAssigned').length, 0);
    assert.equal(other.sent.filter(([n]) => n === 'rideAssignmentFailed').length, 1);
  } finally {
    rideClient.assignDriver = real;
  }
});

test('a failed RIDE_DRIVER_ASSIGNED publish after the saved write puts the ride back to matching and the error goes on', async () => {
  const d = await driver();
  const riderA = await user('RIDER');
  const rideA = await searching(riderA);
  const failedSent = [];
  const producer = new Proxy({}, { get: (_t, name) => async (e) => { if (name === 'rideDriverAssigned') throw new Error('kafka down'); if (name === 'rideAssignmentFailed') failedSent.push(e); } });
  await assert.rejects(fastConsumer(producer).handle(acceptEvent(rideA, riderA, d), { topic: 'ride.events' }), /kafka down/);
  assert.equal(failedSent.length, 1, 'the gateway is told, so it lets go of the driver\'s hold and claim');
  assert.equal(failedSent[0].reason, 'driver_busy');
  const row = await prisma.ride.findUnique({ where: { id: rideA.id } });
  assert.equal(row.status, 'MATCHING');
  assert.equal(row.driverId, null);
  assert.equal(await liveRidesOf(d.id), 0);
});

test('a half-published RIDE_DRIVER_ASSIGNED (publish threw, Kafka wrote it): the lifecycle does not book it, so the outcome is "not booked, hold released"', async () => {
  const d = await driver();
  const riderA = await user('RIDER');
  const rideA = await searching(riderA);
  const state = { pendingMatchesByRideId: new Map(), onlineDrivers: new Map(), rideParticipantsByRideId: new Map(), rideRouteStopsByRideId: new Map(), routeByRideId: new Map(), assignedDriversByRideId: new Map(), gpsByRideId: new Map(), reopenedAssignments: new Set() };
  const writtenAnyway = [];
  const producer = new Proxy({}, { get: (_t, name) => async (e) => { if (name === 'rideDriverAssigned') { writtenAnyway.push(e); throw new Error('timeout after the write'); } } });
  const consumer = createRideRequestedConsumer({ state, rideEnv: {}, rideEventsProducer: producer, assignRetryDelaysMs: [5] });
  await assert.rejects(consumer.handle(acceptEvent(rideA, riderA, d), { topic: 'ride.events' }), /timeout after the write/);
  assert.equal((await prisma.ride.findUnique({ where: { id: rideA.id } })).status, 'MATCHING');
  const { sent, producer: quiet } = recorder();
  const lifecycle = createTripLifecycleHandler({ state, rideEventsProducer: quiet });
  await lifecycle.handleRideEvent(writtenAnyway[0], { topic: 'ride.events' });
  const row = await prisma.ride.findUnique({ where: { id: rideA.id } });
  assert.equal(row.status, 'MATCHING');
  assert.equal(row.driverId, null);
  assert.equal(state.reopenedAssignments.size, 0, 'the marker is cleared');
  assert.equal((await prisma.driver.findUnique({ where: { id: d.id } })).status, 'ONLINE', 'the driver is not put on a ride');
  void sent;
});

test('a group\'s last seat after a ride-service restart (no pending group in memory): accepted when its match request is GROUPED with a group; ride_closed otherwise', async () => {
  const d = await driver();
  const rider = await user('RIDER');
  const group = await prisma.groupRideMatchRequest.create({ data: { userId: rider, status: 'GROUPED', groupId: randomUUID(), pickupLat: 6.5, pickupLng: 3.3, pickupAddress: 'A', destLat: 6.6, destLng: 3.4, destAddress: 'B' } });
  const open = recorder();
  await consumerFor(open.producer).handle({ eventType: 'RIDE_OFFER_ACCEPTED', rideId: group.id, riderId: rider, driverId: d.id, driverUserId: d.userId, agreedFareNgn: 3000, paymentMethod: 'CASH', timestamp: new Date().toISOString() }, { topic: 'ride.events' });
  assert.equal(open.sent.filter(([n]) => n === 'rideDriverAssigned').length, 1);
  assert.equal(open.sent.filter(([n]) => n === 'rideAssignmentFailed').length, 0);
  await prisma.groupRideMatchRequest.update({ where: { id: group.id }, data: { status: 'CANCELLED' } });
  const d2 = await driver();
  const closed = recorder();
  await consumerFor(closed.producer).handle({ eventType: 'RIDE_OFFER_ACCEPTED', rideId: group.id, riderId: rider, driverId: d2.id, driverUserId: d2.userId, agreedFareNgn: 3000, paymentMethod: 'CASH', timestamp: new Date().toISOString() }, { topic: 'ride.events' });
  assert.equal(closed.sent.find(([n]) => n === 'rideAssignmentFailed')[1].reason, 'ride_closed');
  await prisma.groupRideMatchRequest.delete({ where: { id: group.id } });
});
