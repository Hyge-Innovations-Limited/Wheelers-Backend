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
const { handleRideMessage } = require('../apps/api-gateway/dist/websocket/handlers/ride.handler.js');
const { handleGpsProcessedEvent } = require('../apps/api-gateway/dist/kafka/consumer.js');

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

test('the driver leaves before anyone got in: each seat goes back to its own search the way a driver backing out does; the trip ends once', async () => {
  const t = await bookedTrip();
  await prisma.ride.update({ where: { id: t.ra }, data: { status: 'ARRIVED', arrivedAt: minutesAgo(2), waitingRateNgn: 50, waitingAgreedAt: minutesAgo(1) } });
  const driver = { driverId: t.driverId, driverUserId: t.driverUserId };
  await Promise.all([gt.leaveTrip(deps(), driver, t.tripId), gt.leaveTrip(deps(), driver, t.tripId)]);
  const trip = await prisma.ride.findUnique({ where: { id: t.tripId } });
  assert.deepEqual([trip.status, trip.cancelledBy], ['CANCELLED', 'driver']);
  assert.equal(events.filter((e) => e.eventType === 'GROUP_TRIP_ENDED' && e.groupId === t.tripId).length, 1);
  const cancels = events.filter((e) => e.eventType === 'RIDE_CANCELLED');
  assert.deepEqual(cancels.map((e) => [e.rideId, e.cancelledBy, e.driverId, e.driverUserId]).sort(), [[t.ra, 'driver', t.driverId, t.driverUserId], [t.rb, 'driver', t.driverId, t.driverUserId]].sort());
  const ada = await prisma.ride.findUnique({ where: { id: t.ra } });
  // Still the driver's until ride-service reopens it (only from that driver); out of the group, its arrival and waiting gone.
  assert.deepEqual([ada.driverId, ada.groupTripId, ada.groupRole, ada.arrivedAt, ada.waitingRateNgn], [t.driverId, null, null, null, null]);
  assert.equal(await gt.tripOfSeat(redis, t.ra), null, 'a plain driver cancel to everyone who reads it');
  assert.equal(await gt.seatFinished(deps(), t.rb), false, 'already ended');
});

test('the driver cannot leave with a rider in the car', async () => {
  const t = await bookedTrip();
  await prisma.ride.update({ where: { id: t.ra }, data: { status: 'IN_PROGRESS' } });
  await assert.rejects(gt.leaveTrip(deps(), { driverId: t.driverId, driverUserId: t.driverUserId }, t.tripId), (e) => e.code === 'RIDING');
  await assert.rejects(gt.leaveTrip(deps(), { driverId: randomUUID(), driverUserId: t.driverUserId }, t.tripId), (e) => e.code === 'NOT_TRIP');
  assert.equal(events.length, 0);
});

test('the socket: the TRIP itself is never arrived, started or ended; one seat is not cancelled by the driver; no route changes on a group ride', async () => {
  const t = await bookedTrip();
  const auth = { userId: t.driverUserId, driverId: t.driverId, role: 'DRIVER' };
  const send = (type, payload, who = auth) => handleRideMessage(type, payload, who, publisher, {}, redis);
  await assert.rejects(send('ride:arrived', { rideId: t.tripId }), /group ride/);
  await assert.rejects(send('ride:start', { rideId: t.tripId, riderId: t.a, lockedFareNgn: 15750 }), /group ride/);
  await assert.rejects(send('ride:end', { rideId: t.tripId, riderId: t.a }), /group ride/);
  await assert.rejects(send('ride:cancel', { rideId: t.rb }), /Continue without them/);
  await prisma.ride.update({ where: { id: t.ra }, data: { status: 'IN_PROGRESS' } });
  await assert.rejects(send('ride:route:update', { rideId: t.ra, destination: { lat: 6.6, lng: 3.5, address: 'Ikorodu' }, stops: [] }, { userId: t.a, role: 'RIDER' }), /group ride/);
  await assert.rejects(send('ride:cancel', { rideId: t.tripId }), /in the car/);
  assert.equal(events.length, 0, 'nothing published');
  // A seat's own Arrived works, and the trip follows.
  await prisma.ride.update({ where: { id: t.ra }, data: { status: 'DRIVER_ASSIGNED' } });
  assert.equal((await send('ride:arrived', { rideId: t.ra })).type, 'ride:arrived:ack');
  assert.deepEqual(events.map((e) => [e.eventType, e.rideId]), [['RIDE_ARRIVED', t.ra], ['RIDE_ARRIVED', t.tripId]]);
});

test('the car on each rider\'s own ride: a rider dropped off or gone stops seeing it; a ride of one rider as before', async () => {
  const t = await bookedTrip();
  const sent = [];
  const registry = { sendToUser: async (userId, type, payload) => { sent.push({ userId, type, payload }); } };
  const gps = (rideId) => ({ eventType: 'GPS_PROCESSED', rideId, driverId: t.driverId, lat: 6.55, lng: 3.38, distanceFromLastKm: 0.1, totalDistanceKm: 2, isStale: false, isConsistent: true, distanceToNextStopKm: 1.2, nextStopAddress: 'Ketu', timestamp: new Date().toISOString() });
  await handleGpsProcessedEvent(gps(t.tripId), registry, new Map(), redis);
  const toRiders = sent.filter((m) => m.type === 'ride:driver_location');
  assert.deepEqual(toRiders.map((m) => [m.userId, m.payload.rideId]).sort(), [[t.a, t.ra], [t.b, t.rb]].sort());
  assert.equal(toRiders[0].payload.nextStopAddress, undefined, 'the trip\'s stops are not theirs');
  assert.deepEqual(sent.filter((m) => m.type === 'ride:gps_update').map((m) => m.userId), [t.driverUserId]);

  await redis.set(`gt:seatdone:${t.rb}`, '1', 60);
  sent.length = 0;
  await handleGpsProcessedEvent(gps(t.tripId), registry, new Map(), redis);
  assert.deepEqual(sent.filter((m) => m.type === 'ride:driver_location').map((m) => m.userId), [t.a]);

  // A seat is a ride of its rider: its own GPS (none is sent for it) would go to that rider as always.
  sent.length = 0;
  await handleGpsProcessedEvent(gps(t.ra), registry, new Map(), redis);
  assert.deepEqual(sent.map((m) => [m.userId, m.type]), [[t.a, 'ride:driver_location'], [t.driverUserId, 'ride:gps_update']]);
});

test('a rider\'s own trip: who else is in the car and every stop, theirs marked, others by area only; a rider who left is gone from it', async () => {
  const t = await bookedTrip();
  let view = await gt.riderGroupView(redis, t.rb);
  assert.deepEqual(view.others, ['Ada']);
  assert.deepEqual(view.stops.map((s) => `${s.kind}:${s.name}:${s.area}:${s.yours}:${s.done}`), [
    'pickup:Ada:Yaba:false:false', 'pickup:You:Ketu:true:false', 'dropoff:You:Mile 12:true:false', 'dropoff:Ada:Ikorodu Garage:false:false',
  ]);
  await prisma.ride.update({ where: { id: t.ra }, data: { status: 'IN_PROGRESS' } });
  view = await gt.riderGroupView(redis, t.rb);
  assert.equal(view.stops[0].done, true, 'Ada picked up');
  await prisma.ride.update({ where: { id: t.ra }, data: { status: 'CANCELLED' } });
  view = await gt.riderGroupView(redis, t.rb);
  assert.deepEqual([view.others, view.stops.map((s) => s.name)], [[], ['You', 'You']]);
  assert.equal(await gt.riderGroupView(redis, randomUUID()), null, 'not a seat');
});

test('the dashboards count each rider\'s seat, never the trip (the driver\'s job)', async () => {
  const t = await bookedTrip();
  const { NOT_GROUP_TRIP } = require('../packages/db/dist/index.js');
  const facts = await prisma.$queryRawUnsafe(`SELECT id, is_group FROM ride_facts WHERE id = ANY($1::text[])`, [t.tripId, t.ra, t.rb]);
  assert.deepEqual(facts.map((f) => [f.id, f.is_group]).sort(), [[t.ra, true], [t.rb, true]].sort());
  const funnel = await prisma.$queryRawUnsafe(`SELECT ride_id FROM ride_funnel WHERE ride_id = $1`, t.tripId);
  assert.equal(funnel.length, 0);
  const ids = [t.tripId, t.ra, t.rb];
  assert.equal(await prisma.ride.count({ where: { id: { in: ids }, ...NOT_GROUP_TRIP } }), 2);
  const solo = await prisma.ride.create({ data: { riderId: t.a, status: 'MATCHING', paymentMethod: 'WALLET', riderOfferNgn: 5000, pickupLat: 6.5, pickupLng: 3.3, pickupAddress: 'Yaba', destLat: 6.6, destLng: 3.4, destAddress: 'Ikeja' } });
  made.rides.push(solo.id);
  assert.equal(await prisma.ride.count({ where: { id: solo.id, ...NOT_GROUP_TRIP } }), 1, 'a ride with no group role is counted');
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
