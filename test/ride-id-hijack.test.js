// Ride ids and who may act on a ride. A client-chosen ride id is a NEW v4 UUID: no ride and no
// group match request has it. A stranger who knows a ride id can neither start a request on it, nor
// reset it, nor bid on it as someone else, nor accept or confirm an offer on it.
// Real entry points: handleRideMessage, the ride-requested consumer, confirmRideWithOffer; local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/ride-id-hijack.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { SEARCH_TIMED_OUT_REASON, rideClient, driverBidClient } = require('../packages/db/dist/index.js');
const { handleRideMessage } = require('../apps/api-gateway/dist/websocket/handlers/ride.handler.js');
const { confirmRideWithOffer } = require('../apps/api-gateway/dist/rides/whatsapp-ride.service.js');
const bidState = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');
const { createRideRequestedConsumer } = require('../apps/ride-service/dist/consumers/ride-requested.consumer.js');

const prisma = new PrismaClient();
const made = { users: [], rides: [], drivers: [], groups: [] };
const realConsole = { ...console };
test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; });
test.afterEach(() => { Object.assign(console, realConsole); });
test.after(async () => {
  await prisma.rideHold.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.driverBid.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.groupRideMatchRequest.deleteMany({ where: { id: { in: made.groups } } });
  await prisma.rideStop.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } });
  await prisma.wallet.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

const OLD = { pickupLat: 6.6, pickupLng: 3.35, pickupAddress: 'Opebi', destLat: 6.5, destLng: 3.36, destAddress: 'Surulere' };
const NEW_PICKUP = { lat: 6.5244, lng: 3.387, address: 'Akoka' };
const NEW_DEST = { lat: 6.5095, lng: 3.3711, address: 'Yaba' };
const planner = { planRoute: async () => ({ distanceKm: 10, durationSeconds: 1500, suggestedFareNgn: 5000, minOfferNgn: 4100, ratePerKmNgn: 400, geometry: { coordinates: [{ lat: 6.6, lng: 3.35 }, { lat: 6.5, lng: 3.36 }], bounds: { northEast: { lat: 6.6, lng: 3.4 }, southWest: { lat: 6.5, lng: 3.3 } } } }) };

async function rider() {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:hijack:${id}`, role: 'RIDER', name: 'Hijack rider' } });
  made.users.push(id);
  return id;
}
async function ride(riderId, extra = {}) {
  const r = await prisma.ride.create({ data: { riderId, status: 'MATCHING', ...OLD, fareEstimateNgn: 7900, riderOfferNgn: 7900, ...extra } });
  made.rides.push(r.id);
  await prisma.rideStop.create({ data: { rideId: r.id, stopOrder: 0, type: 'FINAL', status: 'PENDING', lat: OLD.destLat, lng: OLD.destLng, address: OLD.destAddress } });
  return r;
}
async function driverRow({ plate = 'DB-PLATE-1', model = 'Camry', name = 'Real Name' } = {}) {
  const userId = await rider();
  await prisma.user.update({ where: { id: userId }, data: { role: 'DRIVER', name } });
  const d = await prisma.driver.create({ data: { userId, kycStatus: 'APPROVED', status: 'ONLINE', lastSeenAt: new Date(), lat: 6.5244, lng: 3.387, vehicleModel: model, vehiclePlate: plate } });
  made.drivers.push(d.id);
  return { id: d.id, userId };
}
function front() {
  const published = [];
  return { published, publisher: { publishRideEvent: async (e) => { published.push(e); }, publishWalletEvent: async () => {}, publishNotificationEvent: async () => {} } };
}
function memoryRedis() {
  return { store: new Map(), async get(k) { return this.store.get(k) ?? null; }, async set(k, v) { this.store.set(k, v); }, async del(k) { this.store.delete(k); }, async setIfNotExists(k, v) { if (this.store.has(k)) return false; this.store.set(k, v); return true; }, async send() { return null; } };
}
const request = (g, userId, extra) => handleRideMessage('ride:request', { pickup: NEW_PICKUP, destination: NEW_DEST, offerNgn: 5000, ...extra }, { userId, role: 'RIDER' }, g.publisher, planner, undefined);

test('ride:request: a stranger on someone else\'s ride id is refused, nothing published, ride untouched', async () => {
  const owner = await rider();
  const stranger = await rider();
  for (const status of ['IN_PROGRESS', 'DRIVER_ASSIGNED', 'COMPLETED', 'MATCHING']) {
    const r = await ride(owner, { status });
    const g = front();
    const reply = await request(g, stranger, { rideId: r.id });
    assert.equal(reply.type, 'ride:request:rejected');
    assert.equal(g.published.length, 0);
    assert.equal((await prisma.ride.findUnique({ where: { id: r.id } })).status, status);
  }
});

test('ride:request: the owner may not reuse ANY existing ride id (open, timed out, cancelled, finished)', async () => {
  const owner = await rider();
  const rows = [
    await ride(owner, { status: 'REQUESTED' }), await ride(owner, { status: 'MATCHING' }),
    await ride(owner, { status: 'CANCELLED', cancelStage: 'BEFORE_MATCH', cancelReason: SEARCH_TIMED_OUT_REASON }),
    await ride(owner, { status: 'CANCELLED', cancelStage: 'BEFORE_MATCH', cancelReason: 'Rider cancelled' }),
    await ride(owner, { status: 'IN_PROGRESS' }), await ride(owner, { status: 'COMPLETED' }),
  ];
  for (const r of rows) {
    const g = front();
    assert.equal((await request(g, owner, { rideId: r.id })).type, 'ride:request:rejected');
    assert.equal(g.published.length, 0);
  }
});

test('ride:request: a ride id that is not a v4 UUID, or is a group match request, is refused', async () => {
  const owner = await rider();
  for (const bad of ['not-a-uuid', '11111111-1111-1111-1111-111111111111', 'x'.repeat(200), randomUUID().replace('-4', '-1')]) {
    const g = front();
    assert.equal((await request(g, owner, { rideId: bad })).type, 'ride:request:rejected', bad);
    assert.equal(g.published.length, 0);
  }
  const group = await prisma.groupRideMatchRequest.create({ data: { userId: owner, pickupLat: 6.5, pickupLng: 3.3, pickupAddress: 'A', destLat: 6.5, destLng: 3.4, destAddress: 'B' } });
  made.groups.push(group.id);
  const g = front();
  assert.equal((await request(g, owner, { rideId: group.id })).type, 'ride:request:rejected', 'a group match request id');
  assert.equal(g.published.length, 0);
});

test('ride:request: a fresh client UUID works, and so does no id at all', async () => {
  const owner = await rider();
  const fresh = randomUUID();
  const g1 = front();
  const reply1 = await request(g1, owner, { rideId: fresh });
  assert.equal(reply1.type, 'ride:request:accepted');
  assert.equal(reply1.payload.rideId, fresh);
  assert.equal(g1.published.length, 1);
  const g2 = front();
  const reply2 = await request(g2, owner, {});
  assert.equal(reply2.type, 'ride:request:accepted');
  assert.equal(g2.published.length, 1);
});

function consumerWorld() {
  const state = { onlineDrivers: new Map(), assignedDriversByRideId: new Map(), rideParticipantsByRideId: new Map(), gpsByRideId: new Map(), routeByRideId: new Map(), pendingMatchesByRideId: new Map() };
  const produced = [];
  const producer = new Proxy({}, { get: (_t, name) => async (payload) => { produced.push({ name: String(name), payload }); } });
  const consumer = createRideRequestedConsumer({ state, rideEnv: { MATCH_RADIUS_KM: '5', MAX_MATCH_ATTEMPTS: '200' }, rideEventsProducer: producer });
  const send = (rideId, riderId) => consumer.handle(JSON.stringify({
    eventType: 'RIDE_REQUESTED', rideId, riderId, pickup: NEW_PICKUP, destination: NEW_DEST,
    stops: [{ lat: 6.52, lng: 3.38, address: 'Stop A' }], fareEstimateNgn: 5000, paymentMethod: 'CASH', riderOfferNgn: 5100,
    suggestedFareNgn: 5000, minOfferNgn: 4100, ratePerKmNgn: 400, timestamp: new Date().toISOString(),
  }), { topic: 'ride.events' });
  const clear = () => { for (const p of state.pendingMatchesByRideId.values()) if (p.timeout) clearTimeout(p.timeout); };
  return { state, produced, send, clear, consumer };
}

test('ride-service: a request for an id that exists under another rider leaves the ride alone and goes no further', async () => {
  const owner = await rider();
  const stranger = await rider();
  for (const status of ['IN_PROGRESS', 'DRIVER_ASSIGNED', 'COMPLETED', 'MATCHING']) {
    const r = await ride(owner, { status });
    const w = consumerWorld();
    await w.send(r.id, stranger);
    const after = await prisma.ride.findUnique({ where: { id: r.id }, include: { routeStops: true } });
    assert.equal(after.status, status);
    assert.equal(after.pickupAddress, OLD.pickupAddress);
    assert.equal(after.paymentMethod, 'WALLET');
    assert.equal(after.routeStops.length, 1);
    assert.equal(w.state.pendingMatchesByRideId.has(r.id), false, 'no search started');
    assert.equal(w.produced.filter((p) => /broadcast|Offer/i.test(p.name)).length, 0);
    w.clear();
  }
});

test('ride-service: the owner\'s id on a ride already under way is left alone too', async () => {
  const owner = await rider();
  const r = await ride(owner, { status: 'IN_PROGRESS' });
  const w = consumerWorld();
  await w.send(r.id, owner);
  assert.equal((await prisma.ride.findUnique({ where: { id: r.id } })).status, 'IN_PROGRESS');
  assert.equal(w.state.pendingMatchesByRideId.has(r.id), false);
  w.clear();
});

test('ride-service: the same request again (a redelivery) continues; a different route for the same id stops, row untouched', async () => {
  const owner = await rider();
  const mine = await ride(owner, { status: 'MATCHING', pickupLat: NEW_PICKUP.lat, pickupLng: NEW_PICKUP.lng, pickupAddress: 'Akoka', destLat: NEW_DEST.lat, destLng: NEW_DEST.lng, destAddress: 'Yaba' });
  await prisma.rideStop.deleteMany({ where: { rideId: mine.id } });
  await prisma.rideStop.createMany({ data: [
    { rideId: mine.id, stopOrder: 0, type: 'INTERMEDIATE', status: 'PENDING', lat: 6.52, lng: 3.38, address: 'Stop A' },
    { rideId: mine.id, stopOrder: 1, type: 'FINAL', status: 'PENDING', lat: NEW_DEST.lat, lng: NEW_DEST.lng, address: 'Yaba' },
  ] });
  const same = consumerWorld();
  await same.send(mine.id, owner);
  assert.equal(same.state.pendingMatchesByRideId.has(mine.id), true, 'same route: the search goes on');
  same.clear();

  // A different route under the same id: the bids on the ride are for the old one.
  const other = await ride(owner, { status: 'MATCHING' });
  const diff = consumerWorld();
  await diff.send(other.id, owner);
  assert.equal(diff.state.pendingMatchesByRideId.has(other.id), false);
  const after = await prisma.ride.findUnique({ where: { id: other.id }, include: { routeStops: true } });
  assert.equal(after.pickupAddress, 'Opebi');
  assert.equal(after.paymentMethod, 'WALLET');
  assert.equal(Number(after.riderOfferNgn), 7900);
  assert.equal(after.routeStops.length, 1);
  diff.clear();
});

test('ride-service: a timed-out or cancelled ride is not revived by a request on its id', async () => {
  const owner = await rider();
  for (const extra of [{ cancelReason: SEARCH_TIMED_OUT_REASON }, { cancelReason: 'Rider cancelled' }]) {
    const r = await ride(owner, { status: 'CANCELLED', cancelStage: 'BEFORE_MATCH', ...extra });
    const w = consumerWorld();
    await w.send(r.id, owner);
    assert.equal((await prisma.ride.findUnique({ where: { id: r.id } })).status, 'CANCELLED');
    assert.equal(w.state.pendingMatchesByRideId.has(r.id), false);
    w.clear();
  }
});

test('ride-service: if the guarded update throws, nothing is broadcast', async () => {
  const owner = await rider();
  const r = await ride(owner, { status: 'MATCHING' });
  const real = rideClient.restartSearch;
  rideClient.restartSearch = async () => { throw new Error('db down'); };
  try {
    const w = consumerWorld();
    await w.send(r.id, owner);
    assert.equal(w.state.pendingMatchesByRideId.has(r.id), false);
    w.clear();
  } finally { rideClient.restartSearch = real; }
});

test('ride-service: a brand-new ride is created as before', async () => {
  const owner = await rider();
  const id = randomUUID();
  made.rides.push(id);
  const w = consumerWorld();
  await w.send(id, owner);
  const row = await prisma.ride.findUnique({ where: { id } });
  assert.equal(row.status, 'MATCHING');
  assert.equal(row.riderId, owner);
  w.clear();
});

// ── The other doors ──

test('ride:counter_offer is refused and publishes nothing', async () => {
  const owner = await rider();
  const r = await ride(owner, { status: 'MATCHING' });
  const g = front();
  const reply = await handleRideMessage('ride:counter_offer', { rideId: r.id, riderId: owner, driverId: randomUUID(), counterOfferNgn: 100, driverName: 'x', driverRating: 5, vehiclePlate: 'FAKE', vehicleModel: 'x', etaSeconds: 60 }, { userId: randomUUID(), role: 'DRIVER' }, g.publisher, planner, undefined);
  assert.match(reply.payload.error, /driver:accept/);
  assert.equal(g.published.length, 0);
});

test('driver:accept: the rider and the driver come from the database, not the payload', async () => {
  const owner = await rider();
  const stranger = await rider();
  const d = await driverRow();
  const r = await ride(owner, { status: 'MATCHING' });
  const g = front();
  const base = { rideId: r.id, agreedFareNgn: 7900, etaSeconds: 300, driverName: 'Spoof', vehiclePlate: 'SPOOF-1', vehicleModel: 'Spoof', driverRating: 1, driverId: randomUUID() };
  const auth = { userId: d.userId, role: 'DRIVER', driverId: d.id };
  await assert.rejects(() => handleRideMessage('driver:accept', { ...base, riderId: stranger }, auth, g.publisher, planner, undefined), /no longer exists/);
  assert.equal(g.published.length, 0);
  await handleRideMessage('driver:accept', { ...base, riderId: owner }, auth, g.publisher, planner, undefined);
  const event = g.published.find((e) => e.eventType === 'RIDE_COUNTER_OFFER');
  assert.ok(event, 'the bid went out');
  assert.equal(event.riderId, owner);
  assert.equal(event.driverId, d.id);
  assert.equal(event.vehiclePlate, 'DB-PLATE-1');
  assert.equal(event.vehicleModel, 'Camry');
  assert.equal(event.driverName, 'Real Name');
  // A user with no driver profile cannot bid at all.
  const notADriver = await rider();
  await assert.rejects(() => handleRideMessage('driver:accept', { ...base, riderId: owner }, { userId: notADriver, role: 'DRIVER' }, g.publisher, planner, undefined));
});

test('WhatsApp confirm: refused without a pending bid row, and on another rider\'s ride', async () => {
  const owner = await rider();
  const stranger = await rider();
  const d = await driverRow();
  const r = await ride(owner, { status: 'MATCHING' });
  const redis = memoryRedis();
  const g = front();
  const deps = { registry: { sendToUser: async () => {}, isUserConnected: async () => false, hasUser: () => false }, redisClient: redis, publisher: g.publisher };
  const meta = (riderId) => ({ riderId, phone: '+2348030000088', pickupAddress: 'Opebi', destinationAddress: 'Surulere', offerNgn: 7900, suggestedFareNgn: 7900, paymentMethod: 'WALLET', createdAt: new Date().toISOString() });
  const bidId = randomUUID();
  const offer = { bidId, driverId: d.id, driverUserId: d.userId, counterOfferNgn: 7000, driverName: 'x', driverRating: 5, vehiclePlate: 'x', vehicleModel: 'x', etaSeconds: 60, distanceKm: 1, receivedAt: new Date().toISOString() };
  for (const id of [owner, stranger]) await prisma.wallet.upsert({ where: { userId: id }, update: { balanceNgn: 50000 }, create: { userId: id, balanceNgn: 50000 } });

  // In the chat's memory only: no bid row in the database.
  await bidState.storeWhatsappRide(redis, r.id, meta(owner));
  await bidState.addBid(redis, r.id, offer);
  assert.equal((await confirmRideWithOffer(deps, owner, r.id, bidId)).ok, false, 'no bid row');
  assert.equal(g.published.filter((e) => e.eventType === 'RIDE_OFFER_ACCEPTED').length, 0);

  // The stranger's chat holds a copy of the owner's ride; the database says whose it is.
  await driverBidClient.record({ rideId: r.id, driverId: d.id, driverUserId: d.userId, riderId: owner, amountNgn: 7000, etaSeconds: 60 });
  await bidState.storeWhatsappRide(redis, r.id, meta(stranger));
  await bidState.addBid(redis, r.id, offer);
  const theft = await confirmRideWithOffer(deps, stranger, r.id, bidId);
  assert.equal(theft.ok, false);
  assert.equal(theft.code, 'RIDE_GONE');
  assert.equal(g.published.filter((e) => e.eventType === 'RIDE_OFFER_ACCEPTED').length, 0);
});

test('ride:accept_offer: a lookup error is "busy", and an unknown ride is refused', async () => {
  const owner = await rider();
  const d = await driverRow();
  const r = await ride(owner, { status: 'MATCHING' });
  const g = front();
  const redis = memoryRedis();
  const ask = (rideId) => handleRideMessage('ride:accept_offer', { rideId, driverId: d.id, driverUserId: d.userId, agreedFareNgn: 7000, paymentMethod: 'wallet_balance' }, { userId: owner, role: 'RIDER' }, g.publisher, {}, redis);
  const real = rideClient.findStanding;
  rideClient.findStanding = async () => { throw new Error('db down'); };
  try {
    const busy = await ask(r.id);
    assert.equal(busy.type, 'ride:accept_offer:rejected');
    assert.equal(busy.payload.reason, 'busy');
  } finally { rideClient.findStanding = real; }
  await assert.rejects(() => ask(randomUUID()), /not yours/);
  assert.equal(g.published.length, 0);
});

test('ride-service: an offer accepted by a rider who does not own the ride assigns nobody; the owner is assigned with the database\'s driver details', async () => {
  const owner = await rider();
  const stranger = await rider();
  const d = await driverRow();
  const r = await ride(owner, { status: 'MATCHING' });
  const w = consumerWorld();
  const accept = (riderId) => w.consumer.handle(JSON.stringify({ eventType: 'RIDE_OFFER_ACCEPTED', rideId: r.id, riderId, driverId: d.id, driverUserId: d.userId, agreedFareNgn: 7000, paymentMethod: 'WALLET', timestamp: new Date().toISOString() }), { topic: 'ride.events' });
  await accept(stranger);
  assert.equal(w.produced.filter((p) => p.name === 'rideDriverAssigned').length, 0);
  // The database write itself is guarded by the rider too.
  assert.equal((await rideClient.assignDriver(r.id, d.id, { riderId: stranger })).count, 0);
  assert.equal((await prisma.ride.findUnique({ where: { id: r.id } })).status, 'MATCHING');
  await accept(owner);
  const assigned = w.produced.find((p) => p.name === 'rideDriverAssigned');
  assert.equal(assigned.payload.vehiclePlate, 'DB-PLATE-1');
  assert.equal(assigned.payload.driverName, 'Real Name');
  w.clear();
});
