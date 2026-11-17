// Group ride, the booking (Timi, 17 Nov 2026): a formed group becomes a group trip. Drivers see one request (the
// trip, owned by the Wheelers group account); a price at or under the total (or a counter within +10% of every seat)
// books every seat at once: each held from its own rider's wallet and assigned, all or none; then the trip's accept.
// No driver in 2 min: every rider's own search goes on. Real Postgres and Redis (database 15), the publisher faked,
// the race cases at the same moment.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/group-trip.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const { RedisClient } = require('../apps/api-gateway/dist/redis/client.js');
const gt = require('../apps/api-gateway/dist/rides/group-trip.js');
const { acceptOfferInApp } = require('../apps/api-gateway/dist/rides/app-accept.js');
const { rideClient, walletClient, groupTripClient } = require('../packages/db/dist/index.js');

const prisma = new PrismaClient();
let redis;
const made = { users: new Set(), rides: [], drivers: [] };
const events = [];
const publisher = { publishRideEvent: async (e) => { events.push(e); }, publishGroupRideEvent: async (e) => { events.push(e); } };
const deps = (extra = {}) => ({ redis, publisher, schedule: () => {}, ...extra });

async function rider(balanceNgn = 20000) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:group-trip:${id}`, role: 'RIDER', name: 'Ada Obi' } });
  await prisma.wallet.create({ data: { userId: id, balanceNgn } });
  made.users.add(id);
  return id;
}
async function search(riderId, extra = {}) {
  const ride = await prisma.ride.create({ data: { riderId, status: 'MATCHING', paymentMethod: 'WALLET', riderOfferNgn: 12000, pickupLat: 6.5, pickupLng: 3.37, pickupAddress: 'Yaba', destLat: 6.62, destLng: 3.51, destAddress: 'Ikorodu', ...extra } });
  made.rides.push(ride.id);
  return ride.id;
}
async function onlineDriver() {
  const userId = randomUUID();
  await prisma.user.create({ data: { id: userId, privyDid: `test:group-trip:${userId}`, role: 'DRIVER', name: 'Tunde Bakare' } });
  made.users.add(userId);
  const driver = await prisma.driver.create({ data: { userId, kycStatus: 'APPROVED', status: 'ONLINE', lastSeenAt: new Date() } });
  made.drivers.push(driver.id);
  return { driverId: driver.id, driverUserId: userId };
}
/** Two riders searching, a group offer formed for them (as rides/group-live.ts hands it over). */
async function formedPair(balances = [20000, 20000]) {
  const [a, b] = [await rider(balances[0]), await rider(balances[1])];
  const [ra, rb] = [await search(a), await search(b, { riderOfferNgn: 9000 })];
  const joined = [
    { rideId: ra, riderId: a, offerNgn: 12000, seatPriceNgn: 9000, soloSeconds: 3000, extraSeconds: 60 },
    { rideId: rb, riderId: b, offerNgn: 9000, seatPriceNgn: 6750, soloSeconds: 2000, extraSeconds: 0 },
  ];
  const offer = { offerId: randomUUID(), members: joined, totalSeconds: 3000, savedSeconds: 2000, createdAt: '', expiresAt: '', stops: [
    { rideId: ra, kind: 'pickup', lat: 6.5095, lng: 3.3711, address: 'Yaba' }, { rideId: rb, kind: 'pickup', lat: 6.596, lng: 3.391, address: 'Ketu' },
    { rideId: rb, kind: 'dropoff', lat: 6.606, lng: 3.404, address: 'Mile 12' }, { rideId: ra, kind: 'dropoff', lat: 6.619, lng: 3.51, address: 'Ikorodu Garage' },
  ] };
  return { a, b, ra, rb, joined, offer };
}
/** What ride-service does with the trip's RIDE_REQUESTED: the TRIP row. */
async function tripRowFrom(event) {
  await prisma.ride.create({ data: {
    id: event.rideId, riderId: event.riderId, status: 'MATCHING', paymentMethod: 'CASH', riderOfferNgn: event.riderOfferNgn,
    pickupLat: event.pickup.lat, pickupLng: event.pickup.lng, pickupAddress: event.pickup.address, destLat: event.destination.lat, destLng: event.destination.lng, destAddress: event.destination.address,
    groupTripId: event.rideId, groupRole: 'TRIP', groupStops: event.groupTrip.stops,
  } });
  made.rides.push(event.rideId);
}
const wallet = async (userId) => { const w = await prisma.wallet.findUnique({ where: { userId } }); return { balance: Number(w.balanceNgn), locked: Number(w.lockedNgn) }; };

test.before(async () => {
  console.warn = () => {};
  console.error = () => {};
  redis = new RedisClient(process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15');
  await redis.connect();
  await redis.send('FLUSHDB');
});

test('the seat prices for a driver\'s price: the total as agreed; a counter shared by fare within +10%; more is not taken', () => {
  const seats = [{ rideId: 'a', offerNgn: 12000, seatPriceNgn: 9000 }, { rideId: 'b', offerNgn: 9000, seatPriceNgn: 6750 }];
  assert.deepEqual([...gt.seatPricesFor(seats, 15750)], [['a', 9000], ['b', 6750]]);
  assert.deepEqual([...gt.seatPricesFor(seats, 15000)], [['a', 9000], ['b', 6750]], 'under the total: the seats as agreed');
  const counter = gt.seatPricesFor(seats, 17000);
  assert.equal([...counter.values()].reduce((x, y) => x + y, 0), 17000, 'the seats add up to the driver\'s price');
  assert.ok(counter.get('a') > counter.get('b') - 6750 + 9000 - 1000, 'the longer trip takes more of the extra');
  assert.equal(gt.seatPricesFor(seats, 18000), null, 'over +10% for a seat: not taken');
});

test('the group trip starts: seats linked, their own offers end, the trip goes to drivers as one request at the total', async () => {
  const { a, ra, rb, joined, offer } = await formedPair();
  const solo = await onlineDriver();
  await prisma.driverBid.create({ data: { rideId: ra, riderId: a, driverId: solo.driverId, driverUserId: solo.driverUserId, amountNgn: 11000, status: 'PENDING', etaSeconds: 300 } });
  events.length = 0;
  const tripId = await gt.startGroupTrip(deps(), offer, joined);
  assert.ok(tripId);
  const seats = await prisma.ride.findMany({ where: { id: { in: [ra, rb] } } });
  assert.ok(seats.every((s) => s.groupRole === 'SEAT' && s.groupTripId === tripId));
  assert.equal((await prisma.driverBid.findFirst({ where: { rideId: ra } })).status, 'WITHDRAWN', 'a driver\'s offer on a seat ends');
  const formed = events.find((e) => e.eventType === 'GROUP_TRIP_FORMED');
  assert.deepEqual(formed.seatRideIds, [ra, rb]);
  const req = events.find((e) => e.eventType === 'RIDE_REQUESTED');
  assert.equal(req.rideId, tripId);
  assert.equal(req.riderId, await gt.groupAccountId());
  assert.notEqual(req.riderId, a, 'the trip is never a rider\'s own');
  assert.deepEqual([req.riderOfferNgn, req.suggestedFareNgn, req.paymentMethod], [15750, 15750, 'CASH']);
  assert.deepEqual([req.pickup.address, req.stops.map((s) => s.address), req.destination.address], ['Yaba', ['Ketu', 'Mile 12'], 'Ikorodu Garage']);
  assert.equal(req.groupTrip.stops.length, 4);
  assert.equal(await gt.tripOfSeat(redis, ra), tripId);
});

test('a price at the total books every seat at once (each held from its own wallet), then the trip; two prices at the same moment book once', async () => {
  const { a, b, ra, rb, joined, offer } = await formedPair();
  events.length = 0;
  const tripId = await gt.startGroupTrip(deps(), offer, joined);
  await tripRowFrom(events.find((e) => e.eventType === 'RIDE_REQUESTED'));
  const [d1, d2] = [await onlineDriver(), await onlineDriver()];
  events.length = 0;
  const outcomes = await Promise.all([
    gt.onTripBid(deps(), { tripId, driverId: d1.driverId, driverUserId: d1.driverUserId, priceNgn: 15750 }),
    gt.onTripBid(deps(), { tripId, driverId: d2.driverId, driverUserId: d2.driverUserId, priceNgn: 15000 }),
  ]);
  assert.deepEqual(outcomes.filter((o) => o === 'booked').length, 1, outcomes.join(','));
  const winner = outcomes[0] === 'booked' ? d1 : d2;
  const seats = await prisma.ride.findMany({ where: { id: { in: [ra, rb] } }, orderBy: { createdAt: 'asc' } });
  assert.ok(seats.every((s) => s.status === 'DRIVER_ASSIGNED' && s.driverId === winner.driverId));
  assert.deepEqual(seats.map((s) => Number(s.agreedFareNgn)), [9000, 6750]);
  assert.deepEqual(await wallet(a), { balance: 11000, locked: 9000 });
  assert.deepEqual(await wallet(b), { balance: 13250, locked: 6750 });
  const accepted = events.filter((e) => e.eventType === 'RIDE_OFFER_ACCEPTED');
  assert.equal(accepted.length, 1);
  assert.deepEqual([accepted[0].rideId, accepted[0].riderId, accepted[0].paymentMethod], [tripId, await gt.groupAccountId(), 'CASH']);

  // ride-service assigns the trip: the driver's seats are this group's, so they are not "busy".
  const assigned = await rideClient.assignDriver(tripId, winner.driverId, { agreedFareNgn: accepted[0].agreedFareNgn, paymentMethod: 'CASH', riderId: await gt.groupAccountId() });
  assert.deepEqual(assigned, { count: 1 });
  assert.equal((await rideClient.findActiveByDriver(winner.driverId)).id, tripId, 'the driver\'s ride is the trip, never a seat');
  const other = await search(await rider());
  assert.equal((await rideClient.assignDriver(other, winner.driverId, {})).busy, true, 'any other ride: busy, as before');

  // The trip assigned: each seat announced to its own rider, once.
  events.length = 0;
  const tripAssigned = { eventType: 'RIDE_DRIVER_ASSIGNED', rideId: tripId, riderId: await gt.groupAccountId(), driverId: winner.driverId, driverUserId: winner.driverUserId, driverName: 'Tunde', driverRating: 4.9, vehiclePlate: 'LAG 234 KJ', vehicleModel: 'Camry', etaSeconds: 240, agreedFareNgn: 15750, lockedFareNgn: 15750, paymentMethod: 'CASH', timestamp: new Date().toISOString() };
  await Promise.all([gt.onTripAssigned(deps(), tripAssigned), gt.onTripAssigned(deps(), tripAssigned)]);
  const announced = events.filter((e) => e.eventType === 'RIDE_DRIVER_ASSIGNED');
  assert.deepEqual(announced.map((e) => [e.rideId, e.riderId, e.agreedFareNgn, e.paymentMethod, e.groupSeat]), [[ra, a, 9000, 'WALLET', true], [rb, b, 6750, 'WALLET', true]]);
  assert.equal(await gt.endUnbookedTrip(deps(), tripId), false, 'a booked trip never ends for want of a driver');
});

test('the driver took another job in between: every seat and its money let go, the next price books', async () => {
  const { a, ra, rb, joined, offer } = await formedPair();
  events.length = 0;
  const tripId = await gt.startGroupTrip(deps(), offer, joined);
  await tripRowFrom(events.find((e) => e.eventType === 'RIDE_REQUESTED'));
  const d1 = await onlineDriver();
  assert.equal(await gt.onTripBid(deps(), { tripId, driverId: d1.driverId, driverUserId: d1.driverUserId, priceNgn: 15750 }), 'booked');
  await gt.onTripAssignmentFailed(deps(), { rideId: tripId, driverId: d1.driverId });
  const seats = await prisma.ride.findMany({ where: { id: { in: [ra, rb] } } });
  assert.ok(seats.every((s) => s.status === 'MATCHING' && s.driverId === null && s.groupRole === 'SEAT'));
  assert.deepEqual(await wallet(a), { balance: 20000, locked: 0 });
  const d2 = await onlineDriver();
  assert.equal(await gt.onTripBid(deps(), { tripId, driverId: d2.driverId, driverUserId: d2.driverUserId, priceNgn: 15750 }), 'booked');
  assert.deepEqual(await wallet(a), { balance: 11000, locked: 9000 }, 'held again for the new driver');
});

test('a driver already on another ride, or a counter over every seat\'s +10%: nothing booked, nothing held', async () => {
  const { a, ra, joined, offer } = await formedPair();
  events.length = 0;
  const tripId = await gt.startGroupTrip(deps(), offer, joined);
  await tripRowFrom(events.find((e) => e.eventType === 'RIDE_REQUESTED'));
  const busy = await onlineDriver();
  const elsewhere = await search(await rider());
  await rideClient.assignDriver(elsewhere, busy.driverId, {});
  assert.equal(await gt.onTripBid(deps(), { tripId, driverId: busy.driverId, driverUserId: busy.driverUserId, priceNgn: 15750 }), 'busy');
  const d = await onlineDriver();
  assert.equal(await gt.onTripBid(deps(), { tripId, driverId: d.driverId, driverUserId: d.driverUserId, priceNgn: 19000 }), 'not_taken');
  assert.deepEqual(await wallet(a), { balance: 20000, locked: 0 });
  assert.equal((await prisma.ride.findUnique({ where: { id: ra } })).status, 'MATCHING');
});

test('a rider in a group never books a driver alone, in the app or by any hold', async () => {
  const { a, ra, joined, offer } = await formedPair();
  await gt.startGroupTrip(deps(), offer, joined);
  const d = await onlineDriver();
  const answer = await acceptOfferInApp({ publisher, redis }, a, { rideId: ra, driverId: d.driverId, driverUserId: d.driverUserId, paymentMethod: 'WALLET', agreedFareNgn: 11000 });
  assert.equal(answer.type, 'ride:accept_offer:rejected');
  assert.equal(answer.payload.message, "You're riding in a group. We're finding your driver.");
  const w = await prisma.wallet.findUnique({ where: { userId: a } });
  await assert.rejects(walletClient.createRideHold({ rideId: ra, walletId: w.id, riderId: a, driverUserId: d.driverUserId, amountNgn: 1000 }), /group ride seat/);
});

test('no driver in time, or a wallet short at booking: the group ends once, every rider\'s own search goes on at their own price', async () => {
  const { ra, rb, joined, offer } = await formedPair([20000, 1000]);
  events.length = 0;
  const tripId = await gt.startGroupTrip(deps(), offer, joined);
  await tripRowFrom(events.find((e) => e.eventType === 'RIDE_REQUESTED'));
  const told = [];
  const d = await onlineDriver();
  events.length = 0;
  assert.equal(await gt.onTripBid(deps({ tell: async (c) => { told.push(c); } }), { tripId, driverId: d.driverId, driverUserId: d.driverUserId, priceNgn: 15750 }), 'seats_moved');
  assert.equal(await gt.endUnbookedTrip(deps(), tripId), false, 'ended once');
  const seats = await prisma.ride.findMany({ where: { id: { in: [ra, rb] } } });
  assert.ok(seats.every((s) => s.groupRole === null && s.groupTripId === null && s.status === 'MATCHING'));
  assert.deepEqual(events.filter((e) => e.eventType === 'RIDE_RIDER_COUNTER_OFFER').map((e) => [e.rideId, e.counterOfferNgn]), [[ra, 12000], [rb, 9000]], 'their own searches, their own prices');
  assert.ok(events.some((e) => e.eventType === 'GROUP_TRIP_ENDED' && e.groupId === tripId));
  assert.equal((await prisma.ride.findUnique({ where: { id: tripId } })).status, 'CANCELLED');
  assert.equal(told[0].kind, 'no_driver');
  assert.equal(await gt.tripOfSeat(redis, ra), null);
  assert.equal(await gt.onTripBid(deps(), { tripId, driverId: d.driverId, driverUserId: d.driverUserId, priceNgn: 15750 }), 'ended');
});

test.after(async () => {
  const users = [...made.users];
  await prisma.walletReservation.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
  await prisma.rideHold.deleteMany({ where: { rideId: { in: made.rides } } }).catch(() => {});
  await prisma.transaction.deleteMany({ where: { referenceId: { in: made.rides } } }).catch(() => {});
  await prisma.driverBid.deleteMany({ where: { rideId: { in: made.rides } } }).catch(() => {});
  await prisma.rideStop.deleteMany({ where: { rideId: { in: made.rides } } }).catch(() => {});
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.wallet.deleteMany({ where: { userId: { in: users } } });
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
  await redis.disconnect().catch(() => {});
});
