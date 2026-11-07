// Trip details (people, luggage, pet, a note): set by the rider on "Set your
// price", seen by the driver before they bid and through the trip. Through the
// real entry points: the app's ride:request, the ride service's booking, its
// offer to drivers, the gateway's ride:offer and the driver's trip snapshot.
// Against the local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit --test-concurrency=1 test/trip-details.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { readTripDetails, cleanTripNote } = require('../packages/config/dist/index.js');
const { RideRequestedEvent } = require('../packages/kafka-schemas/dist/index.js');
const { handleRideMessage } = require('../apps/api-gateway/dist/websocket/handlers/ride.handler.js');
const { handleRideEvent } = require('../apps/api-gateway/dist/kafka/consumer.js');
const { loadDriverRideSnapshot } = require('../apps/api-gateway/dist/websocket/driver-ride-sync.js');
const { createRideRequestedConsumer } = require('../apps/ride-service/dist/consumers/ride-requested.consumer.js');
const { createRideEventsProducer } = require('../apps/ride-service/dist/producers/ride-events.producer.js');

const prisma = new PrismaClient();
const made = { users: [], rides: [], drivers: [] };
const realConsole = { ...console };
test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; });
test.afterEach(() => { Object.assign(console, realConsole); });
test.after(async () => {
  await prisma.rideStop.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

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
  await prisma.user.create({ data: { id, privyDid: `test:trip-details:${id}`, role, name: `Trip ${role}`, phone: '+2348030000077' } });
  made.users.push(id);
  return id;
}
async function driver() {
  const userId = await user('DRIVER');
  const d = await prisma.driver.create({ data: { userId, kycStatus: 'APPROVED', status: 'ONLINE', lastSeenAt: new Date(), vehicleModel: 'Corolla', vehiclePlate: 'KJA7' } });
  made.drivers.push(d.id);
  return { id: d.id, userId };
}
const planner = { planRoute: async () => ({ distanceKm: 10, durationSeconds: 1500, suggestedFareNgn: 5000, minOfferNgn: 4100, ratePerKmNgn: 400, geometry: { coordinates: [{ lat: 6.6, lng: 3.35 }, { lat: 6.5, lng: 3.36 }], bounds: { northEast: { lat: 6.6, lng: 3.4 }, southWest: { lat: 6.5, lng: 3.3 } } } }) };
const trip = { pickup: { lat: 6.6018, lng: 3.3515, address: 'Opebi' }, destination: { lat: 6.4969, lng: 3.3556, address: 'Surulere' }, offerNgn: 5200 };

function world() {
  const redis = memoryRedis();
  const published = [];
  const toApp = [];
  const publisher = { publishRideEvent: async (e) => { published.push(e); }, publishWalletEvent: async () => {}, publishDriverEvent: async () => {}, publishNotificationEvent: async () => {} };
  const registry = { sendToUser: async (userId, type, payload) => { toApp.push({ userId, type, payload }); }, isUserConnected: async () => true, hasUser: () => true };
  return { redis, published, toApp, publisher, deps: { registry, redisClient: redis, publisher } };
}
function rideService() {
  const state = { onlineDrivers: new Map(), assignedDriversByRideId: new Map(), rideParticipantsByRideId: new Map(), gpsByRideId: new Map(), routeByRideId: new Map(), pendingMatchesByRideId: new Map() };
  const producer = new Proxy({}, { get: () => async () => {} });
  const consumer = createRideRequestedConsumer({ state, rideEnv: { MATCH_RADIUS_KM: '5', MAX_MATCH_ATTEMPTS: '200' }, rideEventsProducer: producer });
  return (event) => consumer.handle(JSON.stringify(event), { topic: 'ride.events' });
}
/** The ride service's offer to one driver, as it goes on Kafka. */
async function offerFor(rideRequested, d) {
  const sent = [];
  const producer = createRideEventsProducer({ send: async () => {}, sendBatch: async (batch) => { sent.push(...batch); } });
  await producer.broadcastRideOffer({ drivers: [{ driverId: d.id, userId: d.userId, lat: 6.6, lng: 3.35 }], rideRequested, expiresAt: new Date(Date.now() + 60_000) });
  return sent.map((m) => m.value).find((v) => v.eventType === 'RIDE_OFFER_SENT');
}

test('the note drivers see: one line, no phone numbers or links, at most 60 characters', () => {
  assert.equal(cleanTripNote('Call me on 0803 123 4567 at the gate'), 'Call me on at the gate');
  assert.equal(cleanTripNote('+234-803-123-4567'), undefined);
  assert.equal(cleanTripNote('see wa.me/2348031234567 or https://x.co/a'), 'see or');
  assert.equal(cleanTripNote('Gate 2,\nblock 15'), 'Gate 2, block 15');
  assert.equal(cleanTripNote('x'.repeat(80)).length, 60);
  assert.equal(cleanTripNote('   '), undefined);
  assert.equal(cleanTripNote(42), undefined);
  const started = Date.now();
  cleanTripNote('a'.repeat(200_000) + '.c');
  assert.ok(Date.now() - started < 200, 'a long note is cut before the filters run');

  assert.deepEqual(readTripDetails({ passengers: 9, luggage: true, pet: 'yes', note: 'Small dog' }), { passengers: 4, luggage: true, pet: false, note: 'Small dog' });
  assert.deepEqual(readTripDetails({ passengers: 0 }), { passengers: 1, luggage: false, pet: false });
  assert.deepEqual(readTripDetails({ passengers: 2.6 }), { passengers: 3, luggage: false, pet: false });
  assert.equal(readTripDetails(undefined), undefined);
  assert.equal(readTripDetails('3 people'), undefined);
  assert.equal(readTripDetails([1]), undefined);
});

test('app booking with people, luggage, pet and a note: saved on the ride, on the driver\'s ride:offer, and on the driver\'s trip snapshot', async () => {
  const w = world();
  const riderId = await user('RIDER');
  const d = await driver();

  const sent = await handleRideMessage('ride:request', {
    ...trip, tripDetails: { passengers: 3, luggage: true, pet: true, note: 'Small dog in a carrier, call 08031234567' },
  }, { userId: riderId, role: 'RIDER' }, w.publisher, planner, w.redis);
  assert.equal(sent.type, 'ride:request:accepted', JSON.stringify(sent.payload));
  const requested = w.published.find((e) => e.eventType === 'RIDE_REQUESTED');
  const details = { passengers: 3, luggage: true, pet: true, note: 'Small dog in a carrier, call' };
  assert.deepEqual(requested.tripDetails, details);

  // The ride service books it (through Kafka: the event as JSON).
  made.rides.push(requested.rideId);
  await rideService()(RideRequestedEvent.parse(JSON.parse(JSON.stringify(requested))));
  const row = await prisma.ride.findUnique({ where: { id: requested.rideId } });
  assert.deepEqual([row.passengers, row.hasLuggage, row.hasPet, row.riderNote], [3, true, true, 'Small dog in a carrier, call']);

  // Its offer to a driver, then the gateway's ride:offer to the driver's app.
  const offer = await offerFor(requested, d);
  assert.deepEqual(offer.tripDetails, details);
  await handleRideEvent(offer, w.deps, new Map());
  const card = w.toApp.find((m) => m.type === 'ride:offer' && m.userId === d.userId);
  assert.deepEqual(card.payload.tripDetails, details);

  // Through the trip: the driver's snapshot of the ride.
  const snapshot = await loadDriverRideSnapshot(requested.rideId);
  assert.deepEqual(snapshot.tripDetails, details);
});

test('a booking without them (older app, chat) is as before: nothing saved, nothing new on the driver\'s card', async () => {
  const w = world();
  const riderId = await user('RIDER');
  const d = await driver();

  await handleRideMessage('ride:request', trip, { userId: riderId, role: 'RIDER' }, w.publisher, planner, w.redis);
  const requested = w.published.find((e) => e.eventType === 'RIDE_REQUESTED');
  assert.equal(requested.tripDetails, undefined);

  made.rides.push(requested.rideId);
  await rideService()(RideRequestedEvent.parse(JSON.parse(JSON.stringify(requested))));
  const row = await prisma.ride.findUnique({ where: { id: requested.rideId } });
  assert.deepEqual([row.passengers, row.hasLuggage, row.hasPet, row.riderNote], [null, null, null, null]);

  const offer = await offerFor(requested, d);
  assert.equal('tripDetails' in offer, false);
  await handleRideEvent(offer, w.deps, new Map());
  const card = w.toApp.find((m) => m.type === 'ride:offer' && m.userId === d.userId);
  assert.equal('tripDetails' in card.payload, false);
  assert.equal('tripDetails' in (await loadDriverRideSnapshot(requested.rideId)), false);
});

const { handleRidePageRoute } = require('../apps/api-gateway/dist/http/ride-page.route.js');
const local = require('../apps/api-gateway/dist/auth/local.js');
const bidState = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';

test('the WhatsApp ride page: Find drivers sends the rider\'s trip details with the search', async () => {
  const w = world();
  const riderId = await user('RIDER');
  await prisma.wallet.create({ data: { userId: riderId, balanceNgn: 10_000 } });
  const deps = { jwtSecret: JWT_SECRET, redisClient: w.redis, publisher: w.publisher, paymentsClient: {}, notifyChat: async () => {} };
  const call = async (method, path, body) => {
    const bearer = local.createWalletPageToken(riderId, 'ride', JWT_SECRET, local.RIDE_PAGE_TOKEN_TTL_SECONDS);
    const raw = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = { method, headers: { authorization: `Bearer ${bearer}` }, async *[Symbol.asyncIterator]() { for (const c of raw) yield c; } };
    const res = { statusCode: 200, body: null, setHeader() {}, writeHead(code) { this.statusCode = code; return this; }, end(text) { this.body = text ? JSON.parse(text) : null; } };
    await handleRidePageRoute(req, res, deps, new URL(`http://x${path}`));
    return res;
  };
  await bidState.storePendingRoute(w.redis, riderId, {
    pickupLat: 6.6018, pickupLng: 3.3515, pickupAddress: 'Opebi', destLat: 6.4969, destLng: 3.3556, destAddress: 'Surulere',
    distanceKm: 12, durationSeconds: 1800, suggestedFareNgn: 7900, minOfferNgn: 7000, ratePerKmNgn: 400,
  });
  const found = await call('POST', '/ride-page/find', { amountNgn: 7900, tripDetails: { passengers: 2, luggage: true, pet: false, note: 'Two big boxes' } });
  assert.equal(found.statusCode, 200, JSON.stringify(found.body));
  const requested = w.published.find((e) => e.eventType === 'RIDE_REQUESTED');
  made.rides.push(requested.rideId);
  assert.equal(requested.channel, 'WHATSAPP');
  assert.deepEqual(requested.tripDetails, { passengers: 2, luggage: true, pet: false, note: 'Two big boxes' });
  await prisma.wallet.deleteMany({ where: { userId: riderId } });
});
