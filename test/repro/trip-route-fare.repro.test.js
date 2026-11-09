// Repro: a rider who agrees to a new price for a changed route is still settled at the OLD fare.
// Issue Hunter S6 (plan 2026-10-28-driver-status-recording-stops).
//
// Real entry points, local Postgres, Kafka recorded not called:
//   ride page POST /ride-page/trip-route/quote + /trip-route (handleRidePageRoute)
//   -> ride-service createTripLifecycleHandler (RIDE_ROUTE_UPDATE_REQUESTED, RIDE_COMPLETION_REQUESTED)
//   -> wallet-service createRideEventsConsumer (RIDE_ROUTE_UPDATED hold top-up, RIDE_COMPLETED settlement)
//   -> real walletClient / Postgres.
// All FAIL today except the CONTROL tests.
//
//   npm run build && node scripts/run-with-env.cjs node --test --test-force-exit --test-reporter=tap test/repro/trip-route-fare.repro.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const db = require('../../packages/db/dist/index.js');
const local = require('../../apps/api-gateway/dist/auth/local.js');
const { calculateRideFees } = require('../../packages/config/dist/index.js');
const { handleRidePageRoute } = require('../../apps/api-gateway/dist/http/ride-page.route.js');
const { handleRideEvent } = require('../../apps/api-gateway/dist/kafka/consumer.js');
const { setStopFixedPriceEnabled } = require('../../apps/api-gateway/dist/rides/trip-route-quote.js');
const { createTripLifecycleHandler } = require('../../apps/ride-service/dist/handlers/trip-lifecycle.handler.js');
const { createRideEventsConsumer } = require('../../apps/wallet-service/dist/consumers/ride-events.consumer.js');

const prisma = new PrismaClient();
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const realConsole = { ...console };
const made = { users: [], rides: [], drivers: [] };

const YABA = { lat: 6.5095, lng: 3.3711, address: '12 Herbert Macaulay Way, Yaba, Lagos' };
const VI = { lat: 6.4281, lng: 3.4219, address: 'Adeola Odeku Street, Victoria Island, Lagos' };
const SURULERE = { lat: 6.4995, lng: 3.3540, address: 'Adeniran Ogunsanya Street, Surulere, Lagos' };
const IKEJA = { lat: 6.6018, lng: 3.3515, address: 'Ikeja City Mall, Obafemi Awolowo Way, Ikeja' };
const place = { pickupLat: YABA.lat, pickupLng: YABA.lng, pickupAddress: YABA.address, destLat: VI.lat, destLng: VI.lng, destAddress: VI.address };
const LINE = [{ lat: YABA.lat, lng: YABA.lng }, { lat: VI.lat, lng: VI.lng }];
const ctx = { topic: 'ride.events', partition: 0, offset: '0', timestamp: '0', headers: {} };

test.beforeEach(() => { setStopFixedPriceEnabled(true); // the fix ships behind STOP_FIXED_PRICE_ENABLED
  console.log = console.info = console.warn = console.error = () => {}; });
test.afterEach(() => { Object.assign(console, realConsole); });
test.after(async () => {
  await prisma.gpsLog.deleteMany({ where: { rideId: { in: made.rides } } }).catch(() => {});
  await prisma.rideHold.deleteMany({ where: { rideId: { in: made.rides } } }).catch(() => {});
  await prisma.rideStop.deleteMany({ where: { rideId: { in: made.rides } } }).catch(() => {});
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } }).catch(() => {});
  await prisma.transaction.deleteMany({ where: { wallet: { userId: { in: made.users } } } }).catch(() => {});
  await prisma.wallet.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
  for (const id of made.users) await prisma.user.delete({ where: { id } }).catch(() => {});
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
const planner = (fareNgn) => ({ planRoute: async () => ({ distanceKm: 11.4, durationSeconds: 1680, suggestedFareNgn: fareNgn, minOfferNgn: 4700, ratePerKmNgn: 420, priceReason: null, geometry: { coordinates: LINE, bounds: { northEast: VI, southWest: YABA } } }) });

async function makeUser(role, balanceNgn = 0) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `local:${id}`, role, name: 'Repro', phone: `+23480${Math.floor(1e8 + Math.random() * 9e8)}`, privacyConsent: 'AGREED', privacyConsentAt: new Date() } });
  await prisma.wallet.create({ data: { userId: id, balanceNgn } });
  made.users.push(id);
  return id;
}

/** A trip in progress at 5200, the rider's fare held (as RIDE_DRIVER_ASSIGNED does), 20,000 in the wallet. */
async function trip(withStop = false) {
  const rider = await makeUser('RIDER', 20_000);
  const driverUser = await makeUser('DRIVER', 0);
  const driver = await prisma.driver.create({ data: { userId: driverUser, status: 'ON_RIDE', kycStatus: 'APPROVED', lat: 6.5, lng: 3.37, lastSeenAt: new Date(), vehicleModel: 'Toyota Corolla', vehiclePlate: 'LND-174XA' } });
  made.drivers.push(driver.id);
  const ride = await prisma.ride.create({ data: { riderId: rider, driverId: driver.id, status: 'IN_PROGRESS', startedAt: new Date(Date.now() - 600_000), agreedFareNgn: 5200, fareEstimateNgn: 5200, riderOfferNgn: 5200, plannedDistanceKm: 11.4, paymentMethod: 'WALLET', ...place } });
  made.rides.push(ride.id);
  await prisma.gpsLog.createMany({ data: [590_000, 580_000].map((ago) => ({ rideId: ride.id, lat: 6.5, lng: 3.37, timestamp: new Date(Date.now() - ago) })) }); // two points in the same place since the start: nothing driven yet
  await prisma.rideStop.createMany({ data: [
    ...(withStop ? [{ rideId: ride.id, stopOrder: 0, type: 'INTERMEDIATE', status: 'PENDING', lat: SURULERE.lat, lng: SURULERE.lng, address: SURULERE.address }] : []),
    { rideId: ride.id, stopOrder: withStop ? 1 : 0, type: 'FINAL', status: 'PENDING', lat: VI.lat, lng: VI.lng, address: VI.address },
  ] });
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: rider } });
  await db.walletClient.createRideHold({ rideId: ride.id, walletId: wallet.id, riderId: rider, driverUserId: driverUser, amountNgn: calculateRideFees(5200).totalNgn });
  return { rider, driverUser, driver, ride, walletId: wallet.id };
}

async function call(deps, userId, method, path, body) {
  const bearer = local.createWalletPageToken(userId, 'ride', JWT_SECRET, local.RIDE_PAGE_TOKEN_TTL_SECONDS);
  const raw = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = { method, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { for (const c of raw) yield c; } };
  const res = { statusCode: 200, body: null, headers: {}, setHeader() {}, writeHead(c) { this.statusCode = c; return this; }, end(t) { this.body = t ? JSON.parse(t) : null; } };
  await handleRidePageRoute(req, res, deps, new URL(`http://x${path}`));
  return { status: res.statusCode, body: res.body };
}

/** Run the whole chain: the rider changes the route at newFare, then the trip completes. */
async function changeRouteThenComplete(t, newFare, stops) {
  const events = [];
  const deps = {
    jwtSecret: JWT_SECRET, redisClient: memoryRedis(), paymentsClient: {}, googleMapsApiKey: 'k',
    routePlanner: planner(newFare),
    publisher: { publishRideEvent: async (e) => { events.push(e); }, publishNotificationEvent: async () => {} },
    notifyChat: async () => {},
  };
  const quote = await call(deps, t.rider, 'POST', '/ride-page/trip-route/quote', { stops });
  assert.equal(quote.body.fareNgn, newFare);
  const done = await call(deps, t.rider, 'POST', '/ride-page/trip-route', { stops, acceptedFareNgn: newFare });
  assert.equal(done.status, 200, JSON.stringify(done.body));

  const out = [];
  const producer = new Proxy({}, { get: (_t, name) => async (e) => { out.push({ name: String(name), event: e }); } });
  const rideService = createTripLifecycleHandler({ rideEventsProducer: producer });
  const walletEvents = [];
  const consumer = createRideEventsConsumer({
    walletRepository: db.walletClient,
    walletEventsProducer: new Proxy({}, { get: (_t, name) => async (e) => { walletEvents.push({ name: String(name), e }); } }),
  });

  const requested = events.find((e) => e.eventType === 'RIDE_ROUTE_UPDATE_REQUESTED');
  assert.ok(requested, 'the gateway published the route change');
  await rideService.handleRideEvent(requested, ctx);
  const routeUpdated = out.find((o) => o.name === 'rideRouteUpdated')?.event;
  assert.ok(routeUpdated, 'ride-service published RIDE_ROUTE_UPDATED');
  await consumer.handle(routeUpdated, ctx); // wallet-service tops the hold up / down

  const afterRoute = {
    hold: Number((await prisma.rideHold.findUniqueOrThrow({ where: { rideId: t.ride.id } })).amountNgn),
    wallet: await prisma.wallet.findUniqueOrThrow({ where: { userId: t.rider } }),
  };

  await rideService.handleRideEvent({ eventType: 'RIDE_COMPLETION_REQUESTED', rideId: t.ride.id, riderId: t.rider, driverId: t.driver.id, endedBy: 'both_confirmed', timestamp: new Date().toISOString() }, ctx);
  const completed = out.find((o) => o.name === 'rideCompleted')?.event;
  assert.ok(completed, 'ride-service published RIDE_COMPLETED');
  await consumer.handle(completed, ctx); // wallet-service settles
  await rideService.handleRideEvent(completed, ctx); // ride-service persists fareFinalNgn (as in production: it consumes RIDE_COMPLETED too)

  const settled = await prisma.rideHold.findUniqueOrThrow({ where: { rideId: t.ride.id } });
  const riderWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: t.rider } });
  const driverWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: t.driverUser } });
  return {
    afterRoute, completed, settled,
    riderDebited: 20_000 - Number(riderWallet.balanceNgn),
    riderLocked: Number(riderWallet.lockedNgn),
    driverPaid: Number(driverWallet.balanceNgn),
  };
}

test('a route change to a HIGHER agreed price: the hold goes up, and the rider is charged and the driver paid that price (today: the OLD 5200)', async () => {
  const t = await trip();
  const r = await changeRouteThenComplete(t, 6000, [IKEJA]);
  // CONTROL half: the hold did follow the agreed price.
  assert.equal(r.afterRoute.hold, 6000, 'the wallet held the new price');
  // BUG half: settlement ignores it.
  assert.equal(r.completed.fareNgn, 6000, 'BUG: RIDE_COMPLETED carries agreedFareNgn (5200), because syncRouteStops only wrote fareEstimateNgn');
  assert.equal(r.riderDebited, 6000, 'BUG: rider agreed to 6000');
  assert.equal(r.driverPaid, calculateRideFees(6000).driverPayoutNgn, 'BUG: driver paid for 5200, not the 6000 the rider agreed to');
  assert.equal(r.riderLocked, 0);
});

test('a route change to a LOWER agreed price (a stop removed): the rider is charged only that price (today: the OLD, higher 5200, taken from free balance)', async () => {
  const t = await trip(true);
  const r = await changeRouteThenComplete(t, 4000, []);
  assert.equal(r.afterRoute.hold, 4000, 'CONTROL: the hold was cut to the new price');
  assert.equal(Number(r.afterRoute.wallet.lockedNgn), 4000, 'CONTROL: 1200 went back to the free balance');
  assert.equal(r.completed.fareNgn, 4000, 'BUG: RIDE_COMPLETED carries the old 5200');
  assert.equal(r.riderDebited, 4000, 'BUG: rider charged 5200 after agreeing to 4000 (1200 over, beyond what was held)');
  assert.equal(r.driverPaid, calculateRideFees(4000).driverPayoutNgn);
});

test('the ride row keeps the agreed price: after a route change agreedFareNgn is the accepted fare (today only fareEstimateNgn moves)', async () => {
  const t = await trip();
  await changeRouteThenComplete(t, 6000, [IKEJA]);
  const row = await prisma.ride.findUniqueOrThrow({ where: { id: t.ride.id } });
  assert.equal(Number(row.fareEstimateNgn), 6000, 'CONTROL: the estimate moved');
  assert.equal(Number(row.agreedFareNgn), 6000, 'BUG: agreedFareNgn is still 5200');
  assert.equal(Number(row.fareFinalNgn), 6000, 'BUG: fareFinalNgn (what history shows) is 5200');
});

test('CONTROL: no route change, the rider is charged the agreed 5200 and the driver paid for it', async () => {
  const t = await trip();
  const out = [];
  const rideService = createTripLifecycleHandler({ rideEventsProducer: new Proxy({}, { get: (_t, n) => async (e) => { out.push({ n: String(n), e }); } }) });
  const consumer = createRideEventsConsumer({ walletRepository: db.walletClient, walletEventsProducer: new Proxy({}, { get: () => async () => {} }) });
  await rideService.handleRideEvent({ eventType: 'RIDE_COMPLETION_REQUESTED', rideId: t.ride.id, riderId: t.rider, driverId: t.driver.id, endedBy: 'both_confirmed', timestamp: new Date().toISOString() }, ctx);
  await consumer.handle(out.find((o) => o.n === 'rideCompleted').e, ctx);
  const w = await prisma.wallet.findUniqueOrThrow({ where: { userId: t.rider } });
  assert.equal(20_000 - Number(w.balanceNgn), 5200);
  assert.equal(Number((await prisma.wallet.findUniqueOrThrow({ where: { userId: t.driverUser } })).balanceNgn), calculateRideFees(5200).driverPayoutNgn);
});

test('after a gateway restart the driver still hears the route change (today: only rideParticipants in memory, no DB fallback)', async () => {
  const t = await trip();
  const toUser = [];
  const deps = {
    registry: { sendToUser: async (userId, type) => { toUser.push({ userId, type }); }, hasUser: () => true, isUserConnected: async () => true },
    redisClient: memoryRedis(),
    publisher: { publishRideEvent: async () => {}, publishNotificationEvent: async () => {}, publishDriverEvent: async () => {}, publishWalletEvent: async () => {} },
  };
  await handleRideEvent({
    eventType: 'RIDE_ROUTE_UPDATED', rideId: t.ride.id, riderId: t.rider, driverId: t.driver.id,
    destination: IKEJA, stops: [{ stopId: randomUUID(), stopOrder: 0, type: 'final', status: 'pending', ...IKEJA }],
    plannedDistanceKm: 10, plannedDurationSeconds: 1200, fareEstimateNgn: 6000, updatedBy: 'rider', timestamp: new Date().toISOString(),
  }, deps, new Map() /* a fresh gateway: rideParticipants is empty */);
  assert.ok(toUser.some((m) => m.userId === t.rider && m.type === 'ride:route:updated'), 'CONTROL: the rider hears it');
  assert.ok(toUser.some((m) => m.userId === t.driverUser && m.type === 'ride:route:updated'), 'BUG: the driver never hears the new route after a restart');
});
