// Regression (route-update ownership hotfix): what stays the same for LIVE traffic.
//  1. An OLD rider app (ride:route:update with no acceptedFareNgn, no priced) on its own live ride still moves the
//     route (navigation) and the hold stays at agreed.
//  2. A RAISED, priced change (app and /ride-page/trip-route path = same ride:route:update) raises the hold to the
//     accepted fare; the ride's agreed fare (what settlement charges) is untouched, as before.
//  3. Mixed deploy: events from the OLD gateway (no `priced`) parse in the new schemas, and events from the NEW
//     gateway (with `priced`) parse with the previous schema shape (zod objects strip unknown keys).
//  4. The driver's own stop confirmation (the old app sends only rideId/riderId/driverId) still goes through.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit --test-concurrency=1 tests/regression/route-update-hotfix.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const REPO = path.resolve(__dirname, '../..');
const ROOT = process.env.REGRESSION_ROOT || REPO;
const at = (p) => require(path.join(ROOT, p));
const { PrismaClient } = require(path.join(REPO, 'node_modules/@prisma/client'));
const { TOPICS, parseKafkaEvent, RideRouteUpdateRequestedEvent, RideRouteUpdatedEvent } = at('packages/kafka-schemas/dist/index.js');
const { calculateRideFees } = at('packages/config/dist/index.js');
const { walletClient } = at('packages/db/dist/index.js');
const { handleRideMessage } = at('apps/api-gateway/dist/websocket/handlers/ride.handler.js');
const { createTripLifecycleHandler } = at('apps/ride-service/dist/handlers/trip-lifecycle.handler.js');
const { createRideEventsConsumer } = at('apps/wallet-service/dist/consumers/ride-events.consumer.js');

const __quote = require(path.join(ROOT, 'apps/api-gateway/dist/rides/trip-route-quote.js'));
// On a root without the flag (REGRESSION_ROOT = production HEAD) "flag off" is simply how that build runs.
async function withFlag(on, fn) {
  if (typeof __quote.setStopFixedPriceEnabled !== 'function') { if (on) throw new Error('this build has no STOP_FIXED_PRICE_ENABLED'); return fn(); }
  const prev = __quote.stopFixedPriceEnabled(); __quote.setStopFixedPriceEnabled(on); try { return await fn(); } finally { __quote.setStopFixedPriceEnabled(prev); }
}

const prisma = new PrismaClient();
const made = { users: [], rides: [], drivers: [] };
const real = { log: console.log, info: console.info, warn: console.warn };
console.info = () => {}; console.log = () => {}; console.warn = () => {};

const YABA = { lat: 6.5095, lng: 3.3711, address: '12 Herbert Macaulay Way, Yaba, Lagos' };
const VI = { lat: 6.4281, lng: 3.4219, address: 'Adeola Odeku Street, Victoria Island, Lagos' };
const IKEJA = { lat: 6.6018, lng: 3.3515, address: 'Ikeja City Mall, Obafemi Awolowo Way, Ikeja' };
const LINE = [{ lat: YABA.lat, lng: YABA.lng }, { lat: VI.lat, lng: VI.lng }];
const AGREED = 5200;
const HOLD = calculateRideFees(AGREED).totalNgn;
const CTX = { topic: TOPICS.RIDE_EVENTS, partition: 0, offset: '0', timestamp: new Date().toISOString(), headers: {} };

function memoryRedis() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v) { store.set(k, v); },
    async del(k) { store.delete(k); },
    async setIfNotExists(k, v) { if (store.has(k)) return false; store.set(k, v); return true; },
    async send(cmd, key) {
      if (cmd === 'INCR') { const n = Number(store.get(`n:${key}`) ?? 0) + 1; store.set(`n:${key}`, String(n)); return n; }
      if (cmd === 'TTL') return -1;
      if (cmd === 'GETDEL') { const v = store.has(key) ? store.get(key) : null; store.delete(key); return v; }
      return null;
    },
  };
}
const planner = (fareNgn) => ({ planRoute: async () => ({ distanceKm: 2, durationSeconds: 300, suggestedFareNgn: fareNgn, minOfferNgn: 1000, ratePerKmNgn: 420, priceReason: null, geometry: { coordinates: LINE, bounds: { northEast: VI, southWest: YABA } } }) });

async function makeUser(role, balanceNgn = 0) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `local:${id}`, role, name: 'Reg Test', phone: `+23480${Math.floor(1e8 + Math.random() * 9e8)}` } });
  await prisma.wallet.create({ data: { userId: id, balanceNgn } });
  made.users.push(id);
  return id;
}
async function trip(spareNgn = 0) {
  const rider = await makeUser('RIDER', HOLD + spareNgn);
  const du = await makeUser('DRIVER');
  const driver = await prisma.driver.create({ data: { userId: du, status: 'ON_RIDE', kycStatus: 'APPROVED', lat: 6.5, lng: 3.37, lastSeenAt: new Date(), vehicleModel: 'Toyota Corolla', vehiclePlate: `LND-${Math.floor(100 + Math.random() * 900)}XA` } });
  made.drivers.push(driver.id);
  const ride = await prisma.ride.create({ data: { riderId: rider, driverId: driver.id, status: 'IN_PROGRESS', paymentMethod: 'WALLET', pickupLat: YABA.lat, pickupLng: YABA.lng, pickupAddress: YABA.address, destLat: VI.lat, destLng: VI.lng, destAddress: VI.address, agreedFareNgn: AGREED, fareEstimateNgn: AGREED, distanceKm: 11.4, durationSeconds: 1680 } });
  made.rides.push(ride.id);
  await prisma.rideStop.create({ data: { rideId: ride.id, stopOrder: 0, type: 'FINAL', status: 'PENDING', lat: VI.lat, lng: VI.lng, address: VI.address } });
  const wallet = await walletClient.findByUserId(rider);
  await walletClient.createRideHold({ rideId: ride.id, walletId: wallet.id, riderId: rider, driverUserId: du, amountNgn: HOLD });
  return { rider, driverUserId: du, driverId: driver.id, ride };
}
const gateway = () => { const events = []; return { events, publisher: { publishRideEvent: async (e) => { events.push(e); } }, redis: memoryRedis() }; };
async function runServices(event, routePlanner) {
  const updated = [];
  await createTripLifecycleHandler({ routePlanner, rideEventsProducer: { rideRouteUpdated: async (e) => { updated.push(e); } } }).handleRideEvent(JSON.parse(JSON.stringify(event)), CTX);
  const consumer = createRideEventsConsumer({ walletRepository: walletClient, walletEventsProducer: new Proxy({}, { get: () => async () => {} }) });
  for (const u of updated) await consumer.handle(JSON.parse(JSON.stringify(u)), CTX);
  return updated;
}
const holdOf = async (id) => Number((await prisma.rideHold.findUnique({ where: { rideId: id } })).amountNgn);

test.after(async () => {
  Object.assign(console, real);
  await prisma.rideHold.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.rideStop.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } }).catch(() => {});
  const wallets = (await prisma.wallet.findMany({ where: { userId: { in: made.users } }, select: { id: true } })).map((x) => x.id);
  await prisma.transaction.deleteMany({ where: { OR: [{ walletId: { in: wallets } }, { referenceId: { in: made.rides } }] } }).catch(() => {});
  await prisma.wallet.deleteMany({ where: { id: { in: wallets } } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
  await prisma.$disconnect();
});

// ride-service's own planner prices the new route ABOVE the agreed fare (9000 against 5200).
const dearRoutePlanner = { planRoute: async () => ({ distanceKm: 2, durationSeconds: 300, fareEstimateNgn: 9000, suggestedFareNgn: 9000, geometry: { coordinates: LINE, bounds: { northEast: VI, southWest: YABA } } }) };

for (const flagOn of [false, true]) {
  test(`OLD rider app (flag ${flagOn ? 'ON' : 'OFF'}), the real payload with NO origin: the route moves${flagOn ? '; fare AND hold stay at agreed' : ' (HEAD: the hold follows the dearer plan)'}`, () => withFlag(flagOn, async () => {
    const t = await trip(6000);
    const w = gateway();
    // Exactly the old payload: riderId/driverId from the client, no acceptedFareNgn, and no origin.
    const answer = await handleRideMessage('ride:route:update', { rideId: t.ride.id, riderId: t.rider, driverId: t.driverId, destination: IKEJA, stops: [] }, { userId: t.rider, role: 'RIDER' }, w.publisher, planner(1500), w.redis);
    assert.equal(answer.type, 'ride:route:update:accepted');
    assert.equal(w.events[0].eventType, 'RIDE_ROUTE_UPDATE_REQUESTED');
    assert.equal(w.events[0].destination.lat, IKEJA.lat);
    await runServices(w.events[0], dearRoutePlanner);
    const stop = await prisma.rideStop.findFirst({ where: { rideId: t.ride.id, type: 'FINAL' } });
    assert.equal(stop.lat, IKEJA.lat, 'the destination moved');
    const row = await prisma.ride.findUnique({ where: { id: t.ride.id } });
    assert.equal(Number(row.agreedFareNgn), AGREED, 'settlement still charges the agreed fare');
    if (flagOn) {
      assert.equal(await holdOf(t.ride.id), HOLD, 'hold at agreed');
      assert.equal(Number(row.fareEstimateNgn), AGREED);
    } else {
      assert.equal(await holdOf(t.ride.id), calculateRideFees(9000).totalNgn, 'HEAD: a dearer plan still raises the hold');
    }
  }));
}

test('RAISED priced change (app / ride-page trip-route path): hold goes up to the accepted fare; agreed fare (settlement) unchanged', () => withFlag(false, async () => {
  const t = await trip(4000);
  const w = gateway();
  const auth = { userId: t.rider, role: 'RIDER' };
  const plan = planner(7000);
  const q = await handleRideMessage('ride:route:quote', { rideId: t.ride.id, destination: IKEJA, stops: [] }, auth, w.publisher, plan, w.redis);
  assert.equal(q.payload.fareNgn, 7000);
  // /ride-page/trip-route sends this exact message (driverId from the ride, riderAuth(userId)).
  const a = await handleRideMessage('ride:route:update', { rideId: t.ride.id, driverId: t.driverId, destination: IKEJA, stops: [], acceptedFareNgn: 7000 }, auth, w.publisher, plan, w.redis);
  assert.equal(a.type, 'ride:route:update:accepted');
  await runServices(w.events[0]);
  assert.equal(await holdOf(t.ride.id), calculateRideFees(7000).totalNgn);
  const row = await prisma.ride.findUnique({ where: { id: t.ride.id } });
  assert.equal(Number(row.agreedFareNgn), AGREED, 'settlement still charges the agreed fare');
}));

test('mixed deploy: old-gateway events (no priced) parse in new schemas; new events parse with the old shape', () => {
  const base = { rideId: randomUUID(), riderId: randomUUID(), driverId: randomUUID(), destination: { lat: 6.5, lng: 3.4, address: 'Yaba, Lagos' }, stops: [], fareEstimateNgn: 1200, updatedBy: 'rider', timestamp: new Date().toISOString() };
  const req = RideRouteUpdateRequestedEvent.parse({ eventType: 'RIDE_ROUTE_UPDATE_REQUESTED', ...base });
  assert.equal(req.priced, undefined);
  const upd = RideRouteUpdatedEvent.parse({ eventType: 'RIDE_ROUTE_UPDATED', ...base });
  assert.equal(upd.priced, undefined);
  // Through the real topic parser, as the consumers do it.
  const viaTopic = parseKafkaEvent(TOPICS.RIDE_EVENTS, JSON.stringify({ eventType: 'RIDE_ROUTE_UPDATED', ...base, priced: true }));
  assert.equal(viaTopic.priced, true);
  // Old consumers: neither schema is strict, so an extra `priced` is dropped, never rejected.
  const OldShape = RideRouteUpdatedEvent.omit({ priced: true });
  assert.doesNotThrow(() => OldShape.parse({ eventType: 'RIDE_ROUTE_UPDATED', ...base, priced: true }));
});

test('old-gateway RIDE_ROUTE_UPDATE_REQUESTED (no priced) through the NEW ride-service and wallet-service: hold never below agreed', async () => {
  const t = await trip();
  const oldEvent = { eventType: 'RIDE_ROUTE_UPDATE_REQUESTED', rideId: t.ride.id, riderId: t.rider, driverId: t.driverId, destination: IKEJA, stops: [], plannedDistanceKm: 1, plannedDurationSeconds: 200, fareEstimateNgn: 900, updatedBy: 'rider', timestamp: new Date().toISOString() };
  await runServices(oldEvent);
  assert.equal(await holdOf(t.ride.id), HOLD);
});

test('stop confirm: the driver (old app payload: rideId only) and the rider both still publish', () => withFlag(false, async () => {
  const t = await trip();
  const w = gateway();
  await handleRideMessage('ride:stop:confirm', { rideId: t.ride.id, riderId: t.rider, driverId: t.driverId }, { userId: t.driverUserId, driverId: t.driverId, role: 'DRIVER' }, w.publisher, {}, w.redis);
  await handleRideMessage('ride:stop:confirm', { rideId: t.ride.id, riderId: t.rider }, { userId: t.rider, role: 'RIDER' }, w.publisher, {}, w.redis);
  assert.deepEqual(w.events.map((e) => e.confirmedBy), ['driver', 'rider']);
}));

test('flag ON: a RAISED priced change takes the formula price; it becomes the agreed fare and the hold follows', () => withFlag(true, async () => {
  const t = await trip(6000);
  const w = gateway();
  const auth = { userId: t.rider, role: 'RIDER' };
  const plan = planner(7000);
  // Stub: 2 km planned, 2 km driven, 2 km left -> 5200 x 2/4 + 7000.
  const FORMULA = 2600 + 7000;
  const q = await handleRideMessage('ride:route:quote', { rideId: t.ride.id, destination: IKEJA, stops: [] }, auth, w.publisher, plan, w.redis);
  assert.equal(q.payload.fareNgn, FORMULA);
  const a = await handleRideMessage('ride:route:update', { rideId: t.ride.id, driverId: t.driverId, destination: IKEJA, stops: [], acceptedFareNgn: FORMULA }, auth, w.publisher, plan, w.redis);
  assert.equal(a.type, 'ride:route:update:accepted');
  await runServices(w.events[0]);
  assert.equal(await holdOf(t.ride.id), calculateRideFees(FORMULA).totalNgn);
  assert.equal(Number((await prisma.ride.findUnique({ where: { id: t.ride.id } })).agreedFareNgn), FORMULA);
}));
