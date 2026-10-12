// A ride booked for later, at the moment it matters: when its search starts
// the rider is told (they are not watching the app), the first offer and a
// search that ends unseen are told too, its offers stay in the app, a pickup
// time that cannot be honoured is refused, a cancel in the last instant holds,
// and a rider mid-trip gets their trip back, not the new search.
// Against the local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/scheduled-rides.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { prisma, scheduledRideClient, rideClient } = require('@wheleers/db');
const { handleRideEvent } = require('../apps/api-gateway/dist/kafka/consumer.js');
const { parseScheduledFor } = require('../apps/api-gateway/dist/http/ride.route.js');

const made = { users: [], rides: [], scheduled: [], drivers: [] };
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
    async smembers() { return []; },
    async lrange() { return []; },
  };
}

/** The gateway with an app rider whose app is open (`online`) or closed. */
function gateway({ online }) {
  const pushes = []; const socket = [];
  const deps = {
    registry: { sendToUser: async (userId, type, payload) => { socket.push({ userId, type, payload }); }, hasUser: () => online },
    redisClient: memoryRedis(),
    publisher: { publishNotificationEvent: async (event) => { pushes.push(event); } },
  };
  return { deps, pushes, socket, send: (event) => handleRideEvent({ timestamp: new Date().toISOString(), ...event }, deps, new Map()) };
}
const offer = (rideId, riderId, priceNgn, name = 'Tunde Ade') => ({
  eventType: 'RIDE_COUNTER_OFFER', rideId, riderId, driverId: randomUUID(), driverUserId: randomUUID(), bidId: randomUUID(),
  counterOfferNgn: priceNgn, driverName: name, driverRating: 4.9, vehiclePlate: 'LAG-482-XY', vehicleModel: 'Toyota Corolla', etaSeconds: 240,
});

async function rider() {
  const user = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'RIDER', name: 'Scheduled Rider' } });
  made.users.push(user.id);
  return user;
}
const place = { pickupLat: 6.51, pickupLng: 3.37, pickupAddress: '12 Herbert Macaulay Way, Yaba', destLat: 6.43, destLng: 3.42, destAddress: 'Adeola Odeku Street, Victoria Island' };

test.after(async () => {
  await prisma.outboxEvent.deleteMany({ where: { key: { in: made.rides } } }).catch(() => {});
  await prisma.scheduledRide.deleteMany({ where: { id: { in: made.scheduled } } }).catch(() => {});
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
  await prisma.$disconnect();
});

test('a pickup time must be at least ten minutes ahead and no more than a week', () => {
  const inMinutes = (n) => new Date(Date.now() + n * 60_000).toISOString();
  assert.ok(parseScheduledFor(inMinutes(15)) instanceof Date);
  assert.ok(parseScheduledFor(inMinutes(11)) instanceof Date);
  assert.throws(() => parseScheduledFor(inMinutes(-5)), /at least 10 minutes from now/, 'a time already gone');
  assert.throws(() => parseScheduledFor(inMinutes(3)), /at least 10 minutes from now/, 'sooner than the search can start');
  assert.ok(parseScheduledFor(inMinutes(7 * 24 * 60)) instanceof Date, 'the last slot of the seventh day');
  assert.throws(() => parseScheduledFor(inMinutes(9 * 24 * 60)), /up to 7 days ahead/);
  assert.throws(() => parseScheduledFor('tomorrow morning'), /valid ISO datetime/);
});

test('when a scheduled ride starts its search the rider is told by push and in the app; a ride they started themselves says nothing', async () => {
  const at = gateway({ online: false });
  const rideId = randomUUID(); const riderId = randomUUID();
  const request = { eventType: 'RIDE_REQUESTED', rideId, riderId };

  await at.send({ ...request, rideId: randomUUID() });
  assert.equal(at.pushes.length, 0, 'the rider is looking at the search they just started');

  await at.send({ ...request, scheduled: true, channel: 'APP' });
  assert.deepEqual(at.pushes.map((p) => p.eventType), ['PUSH_SEND', 'IN_APP_SEND']);
  assert.equal(at.pushes[0].userId, riderId);
  assert.equal(at.pushes[0].title, 'Your scheduled ride');
  assert.match(at.pushes[0].body, /finding your driver now\. Open Wheelers/);
  assert.deepEqual(at.pushes[0].data, { type: 'ride:scheduled_started', rideId });
});

test('with the app closed the first offer is a push, once; with it open the offer is on screen and nothing is pushed', async () => {
  const closed = gateway({ online: false });
  const rideId = randomUUID(); const riderId = randomUUID();
  await closed.send(offer(rideId, riderId, 6000));
  await closed.send(offer(rideId, riderId, 6300, 'Aisha Bello'));
  const pushes = closed.pushes.filter((p) => p.eventType === 'PUSH_SEND');
  assert.equal(pushes.length, 1, 'one push for the search, not one per offer');
  assert.equal(pushes[0].title, 'A driver made an offer');
  assert.match(pushes[0].body, /^Tunde Ade offered ₦6,000\./);
  assert.deepEqual(pushes[0].data, { type: 'ride:offer', rideId });
  assert.equal(closed.socket.filter((s) => s.type === 'ride:counter_offer').length, 2, 'both still go to the socket for when the app opens');

  const open = gateway({ online: true });
  await open.send(offer(randomUUID(), randomUUID(), 6000));
  assert.equal(open.pushes.length, 0);
  assert.equal(open.socket.length, 1);
});

test('a search that ends with the app closed says so by push; with the app open the screen says it', async () => {
  const closed = gateway({ online: false });
  const rideId = randomUUID(); const riderId = randomUUID();
  await closed.send({ eventType: 'RIDE_BID_TIMEOUT', rideId, riderId });
  assert.deepEqual(closed.pushes.map((p) => p.eventType), ['PUSH_SEND', 'IN_APP_SEND']);
  assert.equal(closed.pushes[0].title, 'No driver accepted your ride');
  assert.match(closed.pushes[0].body, /You were not charged/);
  assert.equal(closed.socket[0].type, 'ride:bid_timeout');

  const open = gateway({ online: true });
  await open.send({ eventType: 'RIDE_BID_TIMEOUT', rideId: randomUUID(), riderId: randomUUID() });
  assert.equal(open.pushes.length, 0);
});

test('a ride cancelled in the instant it was being dispatched stays cancelled, and no search goes out', async () => {
  const user = await rider();
  const scheduled = await prisma.scheduledRide.create({ data: { riderId: user.id, scheduledFor: new Date(Date.now() + 5 * 60_000), status: 'DISPATCHING', ...place } });
  made.scheduled.push(scheduled.id);
  const rideId = randomUUID(); made.rides.push(rideId);

  const cancelled = await scheduledRideClient.cancel(scheduled.id, user.id, 'changed my mind');
  assert.equal(cancelled.count, 1);
  await assert.rejects(scheduledRideClient.markDispatchedWithOutbox({ id: scheduled.id, rideId, outbox: { topic: 'ride.events', key: rideId, payload: { eventType: 'RIDE_REQUESTED', rideId } } }));
  assert.equal((await prisma.scheduledRide.findUnique({ where: { id: scheduled.id } })).status, 'CANCELLED');
  assert.equal(await prisma.outboxEvent.count({ where: { key: rideId } }), 0, 'nothing was queued for drivers');

  // One still being dispatched goes through as before.
  const live = await prisma.scheduledRide.create({ data: { riderId: user.id, scheduledFor: new Date(Date.now() + 5 * 60_000), status: 'DISPATCHING', ...place } });
  made.scheduled.push(live.id);
  const liveRideId = randomUUID(); made.rides.push(liveRideId);
  await scheduledRideClient.markDispatchedWithOutbox({ id: live.id, rideId: liveRideId, outbox: { topic: 'ride.events', key: liveRideId, payload: { eventType: 'RIDE_REQUESTED', rideId: liveRideId } } });
  assert.equal((await prisma.scheduledRide.findUnique({ where: { id: live.id } })).status, 'DISPATCHED');
  assert.equal(await prisma.outboxEvent.count({ where: { key: liveRideId } }), 1);
});

test('a rider mid-trip whose scheduled ride has just started searching gets the trip back, not the search', async () => {
  const user = await rider();
  const driverUser = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'DRIVER', name: 'Tunde Ade' } });
  made.users.push(driverUser.id);
  const driver = await prisma.driver.create({ data: { userId: driverUser.id, kycStatus: 'APPROVED' } });
  made.drivers.push(driver.id);
  const trip = await prisma.ride.create({ data: { riderId: user.id, driverId: driver.id, status: 'IN_PROGRESS', createdAt: new Date(Date.now() - 20 * 60_000), ...place } });
  const search = await prisma.ride.create({ data: { riderId: user.id, status: 'MATCHING', ...place } });
  made.rides.push(trip.id, search.id);

  assert.equal((await rideClient.findActiveByRider(user.id)).id, trip.id, 'the newer search does not hide the trip');
  await prisma.ride.update({ where: { id: trip.id }, data: { status: 'COMPLETED' } });
  assert.equal((await rideClient.findActiveByRider(user.id)).id, search.id, 'with the trip over, the search is what is live');
  await prisma.ride.update({ where: { id: search.id }, data: { createdAt: new Date(Date.now() - 40 * 60_000) } });
  assert.equal(await rideClient.findActiveByRider(user.id), null, 'a search older than its window is not live');
});
