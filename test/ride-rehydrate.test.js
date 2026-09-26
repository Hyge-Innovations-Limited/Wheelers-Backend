// The auction lives in the ride service's memory. These prove it survives what
// used to kill it: a bid no longer shrinks the search to ten minutes, and a
// restart rebuilds every open search from the database — so a rider changing
// their price after a deploy is still talking to drivers.
//
//   DATABASE_URL=… node --test --test-force-exit test/ride-rehydrate.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { RIDE } = require('../packages/config/dist/index.js');
const { createRideRequestedConsumer } = require('../apps/ride-service/dist/consumers/ride-requested.consumer.js');

const prisma = new PrismaClient();
const RIDE_EVENTS = 'ride.events';
const AKOKA = { lat: 6.5244, lng: 3.3870, address: '31 Emily Akinola St, Akoka, Lagos' };
const YABA = { lat: 6.5095, lng: 3.3711, address: '7 Osaro Isokpan St, Yaba, Lagos' };

test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; });

function service() {
  const state = { onlineDrivers: new Map(), assignedDriversByRideId: new Map(), rideParticipantsByRideId: new Map(), gpsByRideId: new Map(), routeByRideId: new Map(), pendingMatchesByRideId: new Map() };
  const produced = [];
  const producer = new Proxy({}, { get: (_t, name) => async (payload) => { produced.push({ name: String(name), payload }); } });
  const consumer = createRideRequestedConsumer({ state, rideEnv: { MATCH_RADIUS_KM: '5', MAX_MATCH_ATTEMPTS: '5' }, rideEventsProducer: producer });
  const send = (event) => consumer.handle(JSON.stringify({ ...event, timestamp: new Date().toISOString() }), { topic: RIDE_EVENTS });
  return { state, produced, consumer, send };
}

async function rider() {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:${id}`, role: 'RIDER', name: 'Rehydrate Rider' } });
  return id;
}

async function openRide(riderId, { ageMs = 5 * 60_000, status = 'MATCHING', offer = 2500 } = {}) {
  const id = randomUUID();
  await prisma.ride.create({ data: { id, riderId, status, createdAt: new Date(Date.now() - ageMs), pickupLat: AKOKA.lat, pickupLng: AKOKA.lng, pickupAddress: AKOKA.address, destLat: YABA.lat, destLng: YABA.lng, destAddress: YABA.address, riderOfferNgn: offer, fareEstimateNgn: 2800, distanceKm: 3.2, paymentMethod: 'WALLET' } });
  return id;
}

test('on start, every open solo search goes back into memory with what is left of its window — a closed ride and a group seat do not', async () => {
  const riderId = await rider();
  const live = await openRide(riderId, { ageMs: 10 * 60_000 });
  const done = await openRide(riderId, { status: 'CANCELLED' });
  const seat = await openRide(riderId);
  await prisma.groupRideMatchRequest.create({ data: { userId: riderId, pickupLat: AKOKA.lat, pickupLng: AKOKA.lng, pickupAddress: AKOKA.address, destLat: YABA.lat, destLng: YABA.lng, destAddress: YABA.address, matchedRideIds: [seat] } }).catch(() => null);

  const { state, consumer } = service();
  const rebuilt = await consumer.rehydrate();
  assert.ok(rebuilt >= 1);
  const pending = state.pendingMatchesByRideId.get(live);
  assert.ok(pending, 'the live search is back');
  assert.equal(pending.rideRequested.riderOfferNgn, 2500);
  assert.equal(pending.rideRequested.riderId, riderId);
  assert.ok(pending.timeout, 'its clock is armed again');
  assert.equal(state.pendingMatchesByRideId.has(done), false, 'a cancelled ride is not a search');
  const seatRow = await prisma.groupRideMatchRequest.findFirst({ where: { userId: riderId } });
  if (seatRow) assert.equal(state.pendingMatchesByRideId.has(seat), false, 'a group seat belongs to the group dispatcher');
  clearTimeout(pending.timeout);
});

test('a rider changing their price after a restart rebuilds the auction instead of shouting into the void', async () => {
  const riderId = await rider();
  const rideId = await openRide(riderId, { offer: 2000 });
  const { state, send } = service();
  assert.equal(state.pendingMatchesByRideId.has(rideId), false, 'nothing in memory — the service just started');

  await send({ eventType: 'RIDE_RIDER_COUNTER_OFFER', rideId, riderId, counterOfferNgn: 2600 });
  const pending = state.pendingMatchesByRideId.get(rideId);
  assert.ok(pending, 'rebuilt from the ride row');
  assert.equal(pending.rideRequested.riderOfferNgn, 2600, 'and carrying the NEW price');
  clearTimeout(pending.timeout);
});

test("a driver's bid leaves the auction's clock alone — the search runs its full window", async () => {
  const riderId = await rider();
  const rideId = await openRide(riderId);
  const { state, send } = service();
  await send({ eventType: 'RIDE_RIDER_COUNTER_OFFER', rideId, riderId, counterOfferNgn: 2500 });   // puts it in memory
  const pending = state.pendingMatchesByRideId.get(rideId);
  const clock = pending.timeout;
  assert.ok(clock);

  await send({ eventType: 'RIDE_COUNTER_OFFER', rideId, riderId, driverId: randomUUID(), driverUserId: randomUUID(), counterOfferNgn: 2700, driverName: 'Chinedu', driverRating: 4.8, vehiclePlate: 'LND-1', vehicleModel: 'Corolla', etaSeconds: 300 });
  assert.equal(pending.timeout, clock, 'same timer: a bid used to replace it with a 10-minute one');
  assert.equal(pending.counterOfferDrivers.size, 1, 'the bid is on the table');
  assert.equal(RIDE.BID_TIMEOUT_SECONDS, 1800);
  clearTimeout(clock);
});
