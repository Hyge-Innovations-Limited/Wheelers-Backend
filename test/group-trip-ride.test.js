// Group ride, the trip (Timi, 17 Nov 2026): the driver drives the TRIP; each seat moves at its own pickup and
// drop-off. The trip follows the first Arrived and the first code, once; "Continue without them" leaves a rider who
// is not there after their 5 free minutes (free, never when they agreed a waiting price); when every seat is done
// the trip ends once and the driver is freed. Real Postgres and Redis (database 15), the publisher faked.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/group-trip-ride.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const { RedisClient } = require('../apps/api-gateway/dist/redis/client.js');
const gt = require('../apps/api-gateway/dist/rides/group-trip.js');
const { loadDriverRideSnapshot } = require('../apps/api-gateway/dist/websocket/driver-ride-sync.js');

const prisma = new PrismaClient();
let redis;
const made = { users: new Set(), rides: [], drivers: [] };
const events = [];
const publisher = { publishRideEvent: async (e) => { events.push(e); }, publishGroupRideEvent: async (e) => { events.push(e); } };
const deps = (extra = {}) => ({ redis, publisher, schedule: () => {}, ...extra });
const minutesAgo = (m) => new Date(Date.now() - m * 60_000);

async function user(role, name) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:group-ride:${id}`, role, name } });
  await prisma.wallet.create({ data: { userId: id, balanceNgn: 30000 } });
  made.users.add(id);
  return id;
}
/** A group trip already booked to a driver: two seats (Yaba→Ikorodu, Ketu→Mile 12), the trip assigned. */
async function bookedTrip() {
  const [a, b] = [await user('RIDER', 'Ada Obi'), await user('RIDER', 'Chika Eze')];
  const driverUserId = await user('DRIVER', 'Tunde Bakare');
  const driver = await prisma.driver.create({ data: { userId: driverUserId, kycStatus: 'APPROVED', status: 'ONLINE', lastSeenAt: new Date() } });
  made.drivers.push(driver.id);
  const ra = (await prisma.ride.create({ data: { riderId: a, status: 'MATCHING', paymentMethod: 'WALLET', riderOfferNgn: 12000, pickupLat: 6.5095, pickupLng: 3.3711, pickupAddress: 'Yaba', destLat: 6.619, destLng: 3.51, destAddress: 'Ikorodu Garage' } })).id;
  const rb = (await prisma.ride.create({ data: { riderId: b, status: 'MATCHING', paymentMethod: 'WALLET', riderOfferNgn: 9000, pickupLat: 6.596, pickupLng: 3.391, pickupAddress: 'Ketu', destLat: 6.606, destLng: 3.404, destAddress: 'Mile 12' } })).id;
  made.rides.push(ra, rb);
  const joined = [
    { rideId: ra, riderId: a, offerNgn: 12000, seatPriceNgn: 9000, soloSeconds: 3000, extraSeconds: 60 },
    { rideId: rb, riderId: b, offerNgn: 9000, seatPriceNgn: 6750, soloSeconds: 2000, extraSeconds: 0 },
  ];
  const offer = { offerId: randomUUID(), members: joined, totalSeconds: 3000, savedSeconds: 2000, createdAt: '', expiresAt: '', stops: [
    { rideId: ra, kind: 'pickup', lat: 6.5095, lng: 3.3711, address: 'Yaba' }, { rideId: rb, kind: 'pickup', lat: 6.596, lng: 3.391, address: 'Ketu' },
    { rideId: rb, kind: 'dropoff', lat: 6.606, lng: 3.404, address: 'Mile 12' }, { rideId: ra, kind: 'dropoff', lat: 6.619, lng: 3.51, address: 'Ikorodu Garage' },
  ] };
  events.length = 0;
  const tripId = await gt.startGroupTrip(deps(), offer, joined);
  const req = events.find((e) => e.eventType === 'RIDE_REQUESTED');
  await prisma.ride.create({ data: {
    id: tripId, riderId: req.riderId, status: 'MATCHING', paymentMethod: 'CASH', riderOfferNgn: req.riderOfferNgn,
    pickupLat: req.pickup.lat, pickupLng: req.pickup.lng, pickupAddress: req.pickup.address, destLat: req.destination.lat, destLng: req.destination.lng, destAddress: req.destination.address,
    groupTripId: tripId, groupRole: 'TRIP', groupStops: req.groupTrip.stops,
  } });
  made.rides.push(tripId);
  assert.equal(await gt.onTripBid(deps(), { tripId, driverId: driver.id, driverUserId, priceNgn: 15750 }), 'booked');
  await prisma.ride.update({ where: { id: tripId }, data: { driverId: driver.id, status: 'DRIVER_ASSIGNED' } });
  events.length = 0;
  return { tripId, ra, rb, a, b, driverId: driver.id, driverUserId };
}

test.before(async () => {
  console.warn = () => {};
  console.error = () => {};
  redis = new RedisClient(process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15');
  await redis.connect();
  await redis.send('FLUSHDB');
});

test('the driver\'s trip carries the group: every stop in order, each rider\'s seat, price and code', async () => {
  const t = await bookedTrip();
  const snap = await loadDriverRideSnapshot(t.tripId);
  assert.equal(snap.tripCodeRequired, false, 'the trip has no code of its own');
  assert.deepEqual(snap.group.stops.map((s) => `${s.kind}:${s.address}:${s.done}`), ['pickup:Yaba:false', 'pickup:Ketu:false', 'dropoff:Mile 12:false', 'dropoff:Ikorodu Garage:false']);
  const seats = new Map(snap.group.seats.map((s) => [s.rideId, s]));
  assert.deepEqual([seats.get(t.ra).riderName, seats.get(t.ra).seatPriceNgn, seats.get(t.ra).status], ['Ada', 9000, 'DRIVER_ASSIGNED']);
  assert.deepEqual([seats.get(t.rb).riderName, seats.get(t.rb).dropoff.address], ['Chika', 'Mile 12']);
});

test('the trip follows the first Arrived and the first code, once each', async () => {
  const t = await bookedTrip();
  await Promise.all([gt.mirrorTrip(deps(), t.ra, 'arrived', t.driverId), gt.mirrorTrip(deps(), t.rb, 'arrived', t.driverId)]);
  await gt.mirrorTrip(deps(), t.ra, 'started', t.driverId);
  await gt.mirrorTrip(deps(), t.rb, 'started', t.driverId);
  assert.deepEqual(events.map((e) => [e.eventType, e.rideId]), [['RIDE_ARRIVED', t.tripId], ['RIDE_STARTED', t.tripId]]);
  assert.equal(events[1].paymentMethod, 'CASH');
});

test('Continue without them: only after the 5 free minutes, never when they agreed a price; free, once', async () => {
  const t = await bookedTrip();
  await assert.rejects(gt.skipSeat(deps(), t.driverId, t.rb), (e) => e.code === 'NOT_ARRIVED');
  await prisma.ride.update({ where: { id: t.rb }, data: { status: 'ARRIVED', arrivedAt: minutesAgo(3) } });
  await assert.rejects(gt.skipSeat(deps(), t.driverId, t.rb), (e) => e.code === 'STILL_FREE');
  await prisma.ride.update({ where: { id: t.rb }, data: { arrivedAt: minutesAgo(7), waitingRateNgn: 60, waitingAgreedAt: minutesAgo(1) } });
  await assert.rejects(gt.skipSeat(deps(), t.driverId, t.rb), (e) => e.code === 'AGREED');
  await prisma.ride.update({ where: { id: t.rb }, data: { waitingRateNgn: null, waitingAgreedAt: null } });
  const other = await user('DRIVER', 'Someone Else');
  await assert.rejects(gt.skipSeat(deps(), randomUUID(), t.rb), (e) => e.code === 'NOT_SEAT');
  await Promise.all([gt.skipSeat(deps(), t.driverId, t.rb), gt.skipSeat(deps(), t.driverId, t.rb)]);
  const cancels = events.filter((e) => e.eventType === 'RIDE_CANCELLED');
  assert.equal(cancels.length, 1);
  assert.deepEqual([cancels[0].rideId, cancels[0].cancelledBy], [t.rb, 'system'], 'not the driver: their seat is never searched again');
  assert.ok(other);
});

test('every seat done: the trip ends once (even when two finish at the same moment, before their rows say so); the driver is told', async () => {
  const t = await bookedTrip();
  const told = [];
  const d = deps({ tellDriver: async (userId, payload) => { told.push({ userId, payload }); } });
  await prisma.ride.update({ where: { id: t.ra }, data: { status: 'COMPLETED' } });
  // Chika's cancel and Ada's drop handled at the same moment; Chika's row not yet written.
  const ended = await Promise.all([gt.seatFinished(d, t.rb), gt.seatFinished(d, t.ra)]);
  assert.equal(ended.filter(Boolean).length, 1);
  assert.equal((await prisma.ride.findUnique({ where: { id: t.tripId } })).status, 'COMPLETED');
  assert.equal(events.filter((e) => e.eventType === 'GROUP_TRIP_ENDED' && e.groupId === t.tripId).length, 1);
  assert.deepEqual(told, [{ userId: t.driverUserId, payload: { tripId: t.tripId, ridersDropped: 1, faresNgn: 9000 } }]);
  assert.equal(await gt.seatFinished(d, t.ra), false, 'already ended');
});

test('one seat still riding: the trip goes on', async () => {
  const t = await bookedTrip();
  await prisma.ride.update({ where: { id: t.rb }, data: { status: 'COMPLETED' } });
  await prisma.ride.update({ where: { id: t.ra }, data: { status: 'IN_PROGRESS' } });
  assert.equal(await gt.seatFinished(deps(), t.rb), false);
  assert.notEqual((await prisma.ride.findUnique({ where: { id: t.tripId } })).status, 'COMPLETED');
});

test.after(async () => {
  const users = [...made.users];
  await prisma.rideHold.deleteMany({ where: { rideId: { in: made.rides } } }).catch(() => {});
  await prisma.driverBid.deleteMany({ where: { rideId: { in: made.rides } } }).catch(() => {});
  await prisma.rideStop.deleteMany({ where: { rideId: { in: made.rides } } }).catch(() => {});
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.wallet.deleteMany({ where: { userId: { in: users } } });
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
  await redis.disconnect().catch(() => {});
});
