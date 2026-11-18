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
  // An app that drives group trips (driver:online { groupTrips: true }).
  await gt.noteGroupTripDriver(redis, userId);
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
  assert.deepEqual([...gt.seatPricesFor(seats, 15000)], [['a', 8600], ['b', 6400]], 'under the total: every seat a share cheaper (Timi, 17 Nov)');
  assert.deepEqual([...gt.seatPricesFor(seats, 2000)].map(([, v]) => v), [1950, 1950], 'never under the seat floor');
  const three = [{ rideId: 'a', offerNgn: 10000, seatPriceNgn: 7500 }, { rideId: 'b', offerNgn: 10000, seatPriceNgn: 7500 }, { rideId: 'c', offerNgn: 10000, seatPriceNgn: 7500 }];
  assert.ok([...gt.seatPricesFor(three, 22575).values()].every((v) => v >= 7500), 'no seat pays less when the driver asks more (rounding)');
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
    gt.onTripBid(deps(), { tripId, driverId: d2.driverId, driverUserId: d2.driverUserId, priceNgn: 15750 }),
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

test('a driver already on another ride, or a counter over +25% for a seat: nothing booked, nothing held', async () => {
  const { a, ra, joined, offer } = await formedPair();
  events.length = 0;
  const tripId = await gt.startGroupTrip(deps(), offer, joined);
  await tripRowFrom(events.find((e) => e.eventType === 'RIDE_REQUESTED'));
  const busy = await onlineDriver();
  const elsewhere = await search(await rider());
  await rideClient.assignDriver(elsewhere, busy.driverId, {});
  assert.equal(await gt.onTripBid(deps(), { tripId, driverId: busy.driverId, driverUserId: busy.driverUserId, priceNgn: 15750 }), 'busy');
  const d = await onlineDriver();
  assert.equal(await gt.onTripBid(deps(), { tripId, driverId: d.driverId, driverUserId: d.driverUserId, priceNgn: 21000 }), 'not_taken');
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

/** A group of these riders (each { offerNgn, seatPriceNgn, balance }), formed, its trip row made like ride-service does. */
async function formedGroup(specs) {
  const people = [];
  const places = [['Yaba', 6.5095, 3.3711, 'Ikorodu Garage', 6.619, 3.51], ['Ketu', 6.596, 3.391, 'Mile 12', 6.606, 3.404], ['Ojota', 6.585, 3.383, 'Ikorodu Road', 6.61, 3.45]];
  for (const [i, spec] of specs.entries()) {
    const riderId = await rider(spec.balance ?? 20000);
    const rideId = await search(riderId, { riderOfferNgn: spec.offerNgn });
    people.push({ rideId, riderId, offerNgn: spec.offerNgn, seatPriceNgn: spec.seatPriceNgn, soloSeconds: 2000, extraSeconds: 60, place: places[i] });
  }
  const stops = [
    ...people.map((m) => ({ rideId: m.rideId, kind: 'pickup', lat: m.place[1], lng: m.place[2], address: m.place[0] })),
    ...people.slice().reverse().map((m) => ({ rideId: m.rideId, kind: 'dropoff', lat: m.place[4], lng: m.place[5], address: m.place[3] })),
  ];
  const joined = people.map(({ place, ...m }) => m);
  events.length = 0;
  const tripId = await gt.startGroupTrip(deps(), { stops }, joined);
  await tripRowFrom(events.find((e) => e.eventType === 'RIDE_REQUESTED'));
  events.length = 0;
  return { tripId, seats: joined };
}

test('no driver in time: the group ends once, every rider\'s own search goes on at their own price', async () => {
  const { tripId, seats: [a, b] } = await formedGroup([{ offerNgn: 12000, seatPriceNgn: 9000 }, { offerNgn: 9000, seatPriceNgn: 6750 }]);
  const told = [];
  assert.equal(await gt.endUnbookedTrip(deps({ tell: async (c) => { told.push(c); } }), tripId), true);
  assert.equal(await gt.endUnbookedTrip(deps(), tripId), false, 'ended once');
  const rows = await prisma.ride.findMany({ where: { id: { in: [a.rideId, b.rideId] } } });
  assert.ok(rows.every((r) => r.groupRole === null && r.groupTripId === null && r.status === 'MATCHING'));
  assert.deepEqual(events.filter((e) => e.eventType === 'RIDE_RIDER_COUNTER_OFFER').map((e) => [e.rideId, e.counterOfferNgn]), [[a.rideId, 12000], [b.rideId, 9000]]);
  assert.equal((await prisma.ride.findUnique({ where: { id: tripId } })).status, 'CANCELLED');
  assert.equal(told[0].kind, 'no_driver');
  const d = await onlineDriver();
  assert.equal(await gt.onTripBid(deps(), { tripId, driverId: d.driverId, driverUserId: d.driverUserId, priceNgn: 15750 }), 'ended');
});

test('a wallet short at booking: only that rider leaves (their own search goes on); the others go out again as a group at the same seats', async () => {
  const { tripId, seats: [a, b, c] } = await formedGroup([
    { offerNgn: 12000, seatPriceNgn: 9000 }, { offerNgn: 9000, seatPriceNgn: 6750 }, { offerNgn: 10000, seatPriceNgn: 7500, balance: 1000 },
  ]);
  const told = [];
  const d = await onlineDriver();
  assert.equal(await gt.onTripBid(deps({ tell: async (x) => { told.push(x); } }), { tripId, driverId: d.driverId, driverUserId: d.driverUserId, priceNgn: 23250 }), 'regrouped');
  assert.deepEqual(told.map((x) => [x.kind, x.seats.map((m) => m.rideId)]), [['wallet_short', [c.rideId]], ['regrouped', [a.rideId, b.rideId]]]);
  const newTrip = told[1].tripId;
  assert.notEqual(newTrip, tripId);
  const request = events.find((e) => e.eventType === 'RIDE_REQUESTED');
  assert.deepEqual([request.rideId, request.riderOfferNgn, request.groupTrip.stops.map((s) => s.address)], [newTrip, 15750, ['Yaba', 'Ketu', 'Mile 12', 'Ikorodu Garage']]);
  const rows = new Map((await prisma.ride.findMany({ where: { id: { in: [a.rideId, b.rideId, c.rideId] } } })).map((r) => [r.id, r]));
  assert.deepEqual([rows.get(a.rideId).groupTripId, rows.get(b.rideId).groupTripId, rows.get(c.rideId).groupTripId], [newTrip, newTrip, null]);
  assert.deepEqual(events.filter((e) => e.eventType === 'RIDE_RIDER_COUNTER_OFFER').map((e) => [e.rideId, e.counterOfferNgn]), [[c.rideId, 10000]]);
  assert.equal((await prisma.ride.findUnique({ where: { id: tripId } })).status, 'CANCELLED');
  assert.deepEqual(await wallet(a.riderId), { balance: 20000, locked: 0 }, 'nothing held');
  made.rides.push(newTrip);
});

test('a rider leaves before the booking: with one left the group ends (their own search goes on); the one who left is not searched again', async () => {
  const { tripId, seats: [a, b] } = await formedGroup([{ offerNgn: 12000, seatPriceNgn: 9000 }, { offerNgn: 9000, seatPriceNgn: 6750 }]);
  const told = [];
  await prisma.ride.update({ where: { id: b.rideId }, data: { status: 'CANCELLED' } });
  assert.equal(await gt.seatLeftBeforeBooking(deps({ tell: async (x) => { told.push(x); } }), b.rideId), true);
  assert.deepEqual(told.map((x) => [x.kind, x.seats.map((m) => m.rideId), x.left.map((m) => m.rideId)]), [['group_ended', [a.rideId], [b.rideId]]]);
  assert.deepEqual(events.filter((e) => e.eventType === 'RIDE_RIDER_COUNTER_OFFER').map((e) => e.rideId), [a.rideId]);
  assert.equal(await gt.seatLeftBeforeBooking(deps(), b.rideId), false, 'once');
  assert.equal((await prisma.ride.findUnique({ where: { id: tripId } })).status, 'CANCELLED');
});

test('a counter over +10% for one rider (never over +25%): only that rider is asked; their yes books every seat at the counter', async () => {
  const { tripId, seats: [a, b] } = await formedGroup([{ offerNgn: 12000, seatPriceNgn: 10000 }, { offerNgn: 9000, seatPriceNgn: 6000 }]);
  const told = [];
  const d = await onlineDriver();
  const dd = deps({ tell: async (x) => { told.push(x); } });
  await prisma.driverBid.create({ data: { rideId: tripId, riderId: a.riderId, driverId: d.driverId, driverUserId: d.driverUserId, amountNgn: 17500, status: 'PENDING', etaSeconds: 300 } });
  assert.equal(await gt.onTripBid(dd, { tripId, driverId: d.driverId, driverUserId: d.driverUserId, priceNgn: 17500 }), 'asking');
  assert.deepEqual(told.map((x) => [x.kind, x.seats.map((m) => m.rideId)]), [['counter_ask', [b.rideId]]]);
  assert.deepEqual(told[0].ask.prices, { [a.rideId]: 10850, [b.rideId]: 6650 });
  const view = await gt.counterAskFor(redis, b.rideId);
  assert.deepEqual([view.seatPriceNgn, view.askNgn, view.answer], [6000, 6650, null]);
  assert.equal(await gt.counterAskFor(redis, a.rideId), null, 'within +10%: not asked');
  await assert.rejects(gt.answerCounter(dd, a.riderId, a.rideId, 'yes'), (e) => e.code === 'ASK_OVER');
  await assert.rejects(gt.answerCounter(dd, a.riderId, b.rideId, 'yes'), (e) => e.code === 'ASK_OVER', 'not their seat');
  const other = await onlineDriver();
  assert.equal(await gt.onTripBid(dd, { tripId, driverId: other.driverId, driverUserId: other.driverUserId, priceNgn: 17600 }), 'not_taken', 'one ask at a time: another price meanwhile is declined (the driver hears it)');
  assert.equal(await gt.answerCounter(dd, b.riderId, b.rideId, 'yes'), 'done');
  assert.deepEqual([(await wallet(a.riderId)).locked, (await wallet(b.riderId)).locked], [10850, 6650], 'each held at the counter');
  const accepted = events.find((e) => e.eventType === 'RIDE_OFFER_ACCEPTED');
  assert.deepEqual([accepted.rideId, accepted.driverId, accepted.agreedFareNgn], [tripId, d.driverId, 17500]);
  assert.equal(told.at(-1).kind, 'counter_closed');
  assert.equal(await gt.counterAskFor(redis, b.rideId), null);
});

test('an asked rider says No, or says nothing in 20 s: nothing booked, the driver hears their price was declined', async () => {
  for (const how of ['no', 'silence']) {
    const { tripId, seats: [a, b] } = await formedGroup([{ offerNgn: 12000, seatPriceNgn: 10000 }, { offerNgn: 9000, seatPriceNgn: 6000 }]);
    const d = await onlineDriver();
    await prisma.driverBid.create({ data: { rideId: tripId, riderId: a.riderId, driverId: d.driverId, driverUserId: d.driverUserId, amountNgn: 17500, status: 'PENDING', etaSeconds: 300 } });
    const dd = deps();
    assert.equal(await gt.onTripBid(dd, { tripId, driverId: d.driverId, driverUserId: d.driverUserId, priceNgn: 17500 }), 'asking');
    if (how === 'no') await gt.answerCounter(dd, b.riderId, b.rideId, 'no');
    else assert.ok((await gt.runDue(dd, Date.now() + 25_000)) >= 1, 'the 20 s are kept in Redis, run by any gateway');
    assert.deepEqual(events.filter((e) => e.eventType === 'RIDE_BIDS_DECLINED').map((e) => [e.rideId, e.driverUserIds]), [[tripId, [d.driverUserId]]], how);
    assert.equal(events.some((e) => e.eventType === 'RIDE_OFFER_ACCEPTED'), false);
    assert.deepEqual(await wallet(b.riderId), { balance: 20000, locked: 0 });
    assert.equal(await gt.counterAskFor(redis, b.rideId), null);
    events.length = 0;
  }
});

test('an asked rider whose wallet does not cover the new price: the counter is not taken, nobody asked', async () => {
  const { tripId } = await formedGroup([{ offerNgn: 12000, seatPriceNgn: 10000 }, { offerNgn: 9000, seatPriceNgn: 6000, balance: 6300 }]);
  const told = [];
  const d = await onlineDriver();
  assert.equal(await gt.onTripBid(deps({ tell: async (x) => { told.push(x); } }), { tripId, driverId: d.driverId, driverUserId: d.driverUserId, priceNgn: 17500 }), 'not_taken');
  assert.equal(told.length, 0);
});

const dueScore = async (member) => { const v = await redis.send('ZSCORE', 'gt:due', member); return v === null ? null : Number(v); };

test('a booking in flight: the 2 min end and a rider leaving wait for it (never closing a trip whose seats are being booked)', async () => {
  const { tripId, seats: [a, b] } = await formedGroup([{ offerNgn: 12000, seatPriceNgn: 9000 }, { offerNgn: 9000, seatPriceNgn: 6750 }]);
  const dd = deps();
  await redis.set(`gt:booking:${tripId}`, 'some-driver', 30);
  assert.equal(await gt.endUnbookedTrip(dd, tripId), false);
  await gt.seatLeftBeforeBooking(dd, b.rideId);
  assert.ok((await dueScore(`end:${tripId}`)) <= Date.now() + 3500, 'the end tried again in 3 s');
  assert.ok((await dueScore(`regroup:${tripId}:left:${b.rideId}`)) !== null, 'the leaving tried again after the booking');
  assert.equal((await prisma.ride.findUnique({ where: { id: tripId } })).status, 'MATCHING', 'nothing closed meanwhile');
  // The booking went through: both find a booked trip and leave it alone.
  await redis.set(`gt:booked:${tripId}`, 'some-driver', 60);
  await redis.del(`gt:booking:${tripId}`);
  await gt.runDue(dd, Date.now() + 5000);
  assert.equal((await prisma.ride.findUnique({ where: { id: tripId } })).status, 'MATCHING');
  assert.equal(await gt.tripOfSeat(redis, a.rideId), tripId);
  await redis.send('ZREM', 'gt:due', `leave:${b.rideId}`);
});

test('the 2 minute end lives in Redis: a later poll (another gateway, or after a restart) ends the group once', async () => {
  const told = [];
  await redis.del('gt:due'); // earlier tests' deadlines
  const { tripId, seats: [a] } = await formedGroup([{ offerNgn: 12000, seatPriceNgn: 9000 }, { offerNgn: 9000, seatPriceNgn: 6750 }]);
  const dd = deps({ tell: async (x) => { told.push(x); } });
  assert.equal(await gt.runDue(dd, Date.now() + 60_000), 0, 'not yet');
  const [one, two] = await Promise.all([gt.runDue(dd, Date.now() + 125_000), gt.runDue(dd, Date.now() + 125_000)]);
  assert.equal(one + two, 1, 'run once');
  assert.deepEqual(told.map((x) => x.kind), ['no_driver']);
  assert.equal((await prisma.ride.findUnique({ where: { id: tripId } })).status, 'CANCELLED');
  assert.equal(await gt.tripOfSeat(redis, a.rideId), null);
});

test('a driver under the total: every rider pays a share less, held at that', async () => {
  const { tripId, seats: [a, b] } = await formedGroup([{ offerNgn: 12000, seatPriceNgn: 9000 }, { offerNgn: 9000, seatPriceNgn: 6750 }]);
  const d = await onlineDriver();
  assert.equal(await gt.onTripBid(deps(), { tripId, driverId: d.driverId, driverUserId: d.driverUserId, priceNgn: 15000 }), 'booked');
  assert.deepEqual([(await wallet(a.riderId)).locked, (await wallet(b.riderId)).locked], [8600, 6400]);
  assert.deepEqual((await gt.readTrip(redis, tripId)).seats.map((m) => m.seatPriceNgn), [8600, 6400], 'the announcements read the booked prices');
});

test('an app older than group trips: its price is declined, nothing booked', async () => {
  const { tripId } = await formedGroup([{ offerNgn: 12000, seatPriceNgn: 9000 }, { offerNgn: 9000, seatPriceNgn: 6750 }]);
  const d = await onlineDriver();
  await redis.del(`gt:driverapp:${d.driverUserId}`);
  await prisma.driverBid.create({ data: { rideId: tripId, riderId: (await gt.groupAccountId()), driverId: d.driverId, driverUserId: d.driverUserId, amountNgn: 15750, status: 'PENDING', etaSeconds: 300 } });
  assert.equal(await gt.onTripBid(deps(), { tripId, driverId: d.driverId, driverUserId: d.driverUserId, priceNgn: 15750 }), 'not_taken');
  assert.deepEqual(events.filter((e) => e.eventType === 'RIDE_BIDS_DECLINED').map((e) => e.driverUserIds[0]), [d.driverUserId]);
});

test('a rider who cancelled as the booking starts is never booked: the group goes on without them', async () => {
  const told = [];
  const { tripId, seats: [a, b, c] } = await formedGroup([{ offerNgn: 12000, seatPriceNgn: 9000 }, { offerNgn: 9000, seatPriceNgn: 6750 }, { offerNgn: 10000, seatPriceNgn: 7500 }]);
  const { markSearchEnded } = require('../apps/api-gateway/dist/rides/booking-lock.js');
  await markSearchEnded(redis, c.rideId);
  const d = await onlineDriver();
  assert.equal(await gt.onTripBid(deps({ tell: async (x) => { told.push(x); } }), { tripId, driverId: d.driverId, driverUserId: d.driverUserId, priceNgn: 23250 }), 'regrouped');
  assert.deepEqual((await wallet(c.riderId)).locked, 0);
  assert.deepEqual(told.map((x) => [x.kind, x.seats.map((m) => m.rideId).sort()]), [['regrouped', [a.rideId, b.rideId].sort()]]);
});

test('the trip closed under a booking (the 2 min end): nothing held, nothing assigned', async () => {
  const { tripId, seats: [a] } = await formedGroup([{ offerNgn: 12000, seatPriceNgn: 9000 }, { offerNgn: 9000, seatPriceNgn: 6750 }]);
  await prisma.ride.update({ where: { id: tripId }, data: { status: 'CANCELLED' } });
  const d = await onlineDriver();
  assert.equal(await gt.onTripBid(deps(), { tripId, driverId: d.driverId, driverUserId: d.driverUserId, priceNgn: 15750 }), 'seats_moved');
  assert.deepEqual(await wallet(a.riderId), { balance: 20000, locked: 0 });
  assert.equal((await prisma.ride.findUnique({ where: { id: a.rideId } })).driverId, null);
});

test('the accept cannot be sent after the seats are booked: the seats and their money are let go', async () => {
  const { tripId, seats: [a, b] } = await formedGroup([{ offerNgn: 12000, seatPriceNgn: 9000 }, { offerNgn: 9000, seatPriceNgn: 6750 }]);
  const d = await onlineDriver();
  const failing = { ...publisher, publishRideEvent: async (e) => { if (e.eventType === 'RIDE_OFFER_ACCEPTED') throw new Error('kafka down'); events.push(e); } };
  assert.equal(await gt.onTripBid({ redis, publisher: failing }, { tripId, driverId: d.driverId, driverUserId: d.driverUserId, priceNgn: 15750 }), 'driver_gone');
  assert.deepEqual([(await wallet(a.riderId)).locked, (await wallet(b.riderId)).locked], [0, 0]);
  const rows = await prisma.ride.findMany({ where: { id: { in: [a.rideId, b.rideId] } } });
  assert.ok(rows.every((r) => r.status === 'MATCHING' && r.driverId === null && r.groupTripId === tripId), 'still the group, searching');
  assert.equal(await redis.get(`gt:booked:${tripId}`), null);
});

test('a counter the driver changed during the ask is not booked; the same counter is never asked twice', async () => {
  const { tripId, seats: [a, b] } = await formedGroup([{ offerNgn: 12000, seatPriceNgn: 10000 }, { offerNgn: 9000, seatPriceNgn: 6000 }]);
  const d = await onlineDriver();
  const bid = await prisma.driverBid.create({ data: { rideId: tripId, riderId: a.riderId, driverId: d.driverId, driverUserId: d.driverUserId, amountNgn: 17500, status: 'PENDING', etaSeconds: 300 } });
  const told = [];
  const dd = deps({ tell: async (x) => { told.push(x); } });
  assert.equal(await gt.onTripBid(dd, { tripId, driverId: d.driverId, driverUserId: d.driverUserId, priceNgn: 17500 }), 'asking');
  const ask = told[0].ask;
  await prisma.driverBid.update({ where: { id: bid.id }, data: { amountNgn: 18500 } });
  await assert.rejects(gt.answerCounter(dd, b.riderId, b.rideId, 'yes', 'some-older-ask'), (e) => e.code === 'ASK_OVER', 'a stale button');
  assert.equal(await gt.answerCounter(dd, b.riderId, b.rideId, 'yes', ask.askId), 'done');
  assert.equal(events.some((e) => e.eventType === 'RIDE_OFFER_ACCEPTED'), false, 'not at a price the driver no longer offers');
  assert.equal(told.at(-1).outcome, 'other');
  await prisma.driverBid.update({ where: { id: bid.id }, data: { amountNgn: 17500, status: 'PENDING' } });
  assert.equal(await gt.onTripBid(dd, { tripId, driverId: d.driverId, driverUserId: d.driverUserId, priceNgn: 17500 }), 'not_taken', 'asked once');
});

test('the group ends: each rider\'s yes to auto-booking comes back with their own search', async () => {
  const { autoAcceptOnAtStart, autoAcceptStatus } = require('../apps/api-gateway/dist/rides/auto-accept.js');
  const riderId = await rider();
  const rideId = await search(riderId);
  await autoAcceptOnAtStart(redis, rideId, riderId, 12000);
  const other = await rider();
  const otherRide = await search(other, { riderOfferNgn: 9000 });
  const joined = [
    { rideId, riderId, offerNgn: 12000, seatPriceNgn: 9000, soloSeconds: 2000, extraSeconds: 60 },
    { rideId: otherRide, riderId: other, offerNgn: 9000, seatPriceNgn: 6750, soloSeconds: 2000, extraSeconds: 60 },
  ];
  const stops = [
    { rideId, kind: 'pickup', lat: 6.5, lng: 3.37, address: 'Yaba' }, { rideId: otherRide, kind: 'pickup', lat: 6.59, lng: 3.39, address: 'Ketu' },
    { rideId: otherRide, kind: 'dropoff', lat: 6.6, lng: 3.4, address: 'Mile 12' }, { rideId, kind: 'dropoff', lat: 6.62, lng: 3.51, address: 'Ikorodu' },
  ];
  events.length = 0;
  const tripId = await gt.startGroupTrip(deps(), { stops }, joined);
  await tripRowFrom(events.find((e) => e.eventType === 'RIDE_REQUESTED'));
  assert.equal((await autoAcceptStatus(redis, rideId)).on, false, 'off while in the group');
  await gt.endUnbookedTrip(deps(), tripId);
  assert.deepEqual(await autoAcceptStatus(redis, rideId), { on: true, priceNgn: 12000 });
});

test('names and places other riders see: a first name only, an area only', () => {
  assert.equal(gt.firstNameOf('Ada Obi'), 'Ada');
  assert.equal(gt.firstNameOf('wheelers-refund.ng'), 'Rider');
  assert.equal(gt.firstNameOf('Ọlá Ade'), 'Ọlá');
  assert.equal(gt.areaOf('Flat 3, 22 Oba Akran Avenue, Ikeja, Lagos'), 'Ikeja');
  assert.equal(gt.areaOf('12 Ikorodu Rd, Ketu, Lagos, Nigeria'), 'Ketu');
  assert.equal(gt.areaOf('7B Akinola Cole Crescent', 6.5095, 3.3711) !== '7B Akinola Cole Crescent', true, 'a street alone is never shown');
  assert.equal(gt.areaOf('Ikorodu Garage'), 'Ikorodu Garage');
  assert.equal(gt.areaOf('Plot 5 Admiralty Way, Lekki Phase 1'), 'Lekki Phase 1');
  assert.equal(gt.areaOf('15, Adeola Odeku Street, Victoria Island'), 'Victoria Island');
  assert.equal(gt.areaOf('Ikeja City Mall, Obafemi Awolowo Way, Ikeja'), 'Ikeja');
  assert.equal(gt.areaOf('House 4, Road 2, Lekki Gardens'), 'Lekki Gardens');
  assert.notEqual(gt.areaOf('Allen Avenue', 6.6, 3.35), 'Allen Avenue');
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
