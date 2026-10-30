// Route change priced like a new ride at that point (S6a + S6 + wallet-short), behind STOP_FIXED_PRICE_ENABLED.
// Real entry points: the app's ride:route:quote / ride:route:update (handleRideMessage), the page's
// /ride-page/trip-route, ride-service (RIDE_ROUTE_UPDATE_REQUESTED, completion), wallet-service, the deposit hook,
// and the gateway consumer. Local Postgres; Kafka recorded. The planner stub measures real distance from the
// coordinates it is given, so a wrong quote origin changes the price.

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const db = require('../packages/db/dist/index.js');
const local = require('../apps/api-gateway/dist/auth/local.js');
const { calculateRideFees, depositNeededFor } = require('../packages/config/dist/index.js');
const { handleRidePageRoute } = require('../apps/api-gateway/dist/http/ride-page.route.js');
const { handleRideMessage } = require('../apps/api-gateway/dist/websocket/handlers/ride.handler.js');
const { handleRideEvent, handleWalletEvent, applyPendingRouteOnDeposit } = require('../apps/api-gateway/dist/kafka/consumer.js');
const { setStopFixedPriceEnabled, routeChangeFare } = require('../apps/api-gateway/dist/rides/trip-route-quote.js');
const { createTripLifecycleHandler } = require('../apps/ride-service/dist/handlers/trip-lifecycle.handler.js');
const { createRideEventsConsumer } = require('../apps/wallet-service/dist/consumers/ride-events.consumer.js');

const prisma = new PrismaClient();
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const realConsole = { ...console };
const made = { users: [], rides: [], drivers: [] };

const YABA = { lat: 6.5095, lng: 3.3711, address: '12 Herbert Macaulay Way, Yaba, Lagos' };
const VI = { lat: 6.4281, lng: 3.4219, address: 'Adeola Odeku Street, Victoria Island, Lagos' };
const SURULERE = { lat: 6.4995, lng: 3.3540, address: 'Adeniran Ogunsanya Street, Surulere, Lagos' };
const ctx = { topic: 'ride.events', partition: 0, offset: '0', timestamp: '0', headers: {} };
const along = (f) => ({ lat: YABA.lat + (VI.lat - YABA.lat) * f, lng: YABA.lng + (VI.lng - YABA.lng) * f, address: `${Math.round(f * 100)}% along, Lagos` });

function km(a, b) {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const pathKm = (pts) => pts.slice(1).reduce((t, p, i) => t + km(pts[i], p), 0);
/** Price by the real distance of origin -> stops -> destination, 420/km (the stub's own rule). */
const farePerKm = (d) => Math.round(d * 420);
const planner = {
  calls: [],
  async planRoute({ origin, stops, destination }) {
    this.calls.push({ origin });
    const pts = [origin, ...stops, destination];
    const distanceKm = pathKm(pts);
    return { distanceKm, durationSeconds: Math.round(distanceKm * 150), suggestedFareNgn: distanceKm * 420, minOfferNgn: 1000, ratePerKmNgn: 420, priceReason: null,
      geometry: { coordinates: pts.map((p) => ({ lat: p.lat, lng: p.lng })), bounds: { northEast: VI, southWest: YABA } } };
  },
};

test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; setStopFixedPriceEnabled(true); planner.calls = []; });
test.afterEach(() => { Object.assign(console, realConsole); });
test.after(async () => {
  setStopFixedPriceEnabled(false);
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
    expiry: new Map(),
    async get(k) { const e = this.expiry.get(k); if (e && e < Date.now()) { store.delete(k); this.expiry.delete(k); } return store.has(k) ? store.get(k) : null; },
    async set(k, v, ttl) { store.set(k, v); if (ttl) this.expiry.set(k, Date.now() + ttl * 1000); },
    async del(k) { store.delete(k); },
    async setIfNotExists(k, v) { if (store.has(k)) return false; store.set(k, v); return true; },
    async send(cmd, ...a) {
      const key = a[0];
      if (cmd === 'EVAL') { // the save-back script: [script, 3, pendingKey, markerKey, pointerKey, json, rideId, ttl]
        const [, , pk, mk, ptk, json, rideId] = a;
        if (store.has(mk)) return 0;
        store.set(pk, json); store.set(ptk, rideId); return 1;
      }
      if (cmd === 'GETDEL') { const v = store.has(key) ? store.get(key) : null; store.delete(key); return v; } return null; },
  };
}

async function makeUser(role, balanceNgn = 0) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `local:${id}`, role, name: 'Fare', phone: `+23480${Math.floor(1e8 + Math.random() * 9e8)}`, privacyConsent: 'AGREED', privacyConsentAt: new Date() } });
  await prisma.wallet.create({ data: { userId: id, balanceNgn } });
  made.users.push(id);
  return id;
}

const P = pathKm([YABA, VI]); // the planned km the 5200 was agreed for

/**
 * A trip with 5200 agreed and held. opts: status, method, drivenFraction (GPS path + the car's position),
 * plannedKm (null = unknown), afterHold (free balance left once the hold is taken).
 */
async function trip(opts = {}) {
  const status = opts.status ?? 'IN_PROGRESS';
  const frac = opts.drivenFraction ?? 0;
  const car = along(frac);
  const T0 = Date.now() - 600_000;
  const rider = await makeUser('RIDER', 20_000);
  const driverUser = await makeUser('DRIVER', 0);
  const driver = await prisma.driver.create({ data: { userId: driverUser, status: 'ON_RIDE', kycStatus: 'APPROVED', lat: car.lat, lng: car.lng, lastSeenAt: new Date(), vehicleModel: 'Toyota Corolla', vehiclePlate: 'LND-174XA' } });
  made.drivers.push(driver.id);
  const ride = await prisma.ride.create({ data: {
    riderId: rider, driverId: driver.id, status, startedAt: status === 'IN_PROGRESS' ? new Date(T0) : null,
    agreedFareNgn: 5200, fareEstimateNgn: 5200, riderOfferNgn: 5200, paymentMethod: opts.method ?? 'WALLET',
    plannedDistanceKm: opts.plannedKm === undefined ? P : opts.plannedKm,
    pickupLat: YABA.lat, pickupLng: YABA.lng, pickupAddress: YABA.address, destLat: VI.lat, destLng: VI.lng, destAddress: VI.address,
  } });
  made.rides.push(ride.id);
  const mid = opts.middleStop ? along(0.3) : null;
  await prisma.rideStop.createMany({ data: [
    ...(mid ? [{ rideId: ride.id, stopOrder: 0, type: 'INTERMEDIATE', status: 'PENDING', lat: mid.lat, lng: mid.lng, address: mid.address }] : []),
    { rideId: ride.id, stopOrder: mid ? 1 : 0, type: 'FINAL', status: 'PENDING', lat: VI.lat, lng: VI.lng, address: VI.address },
  ] });
  if (opts.preStartGps) {
    // The drive to the pickup: recorded against the ride, before the trip started. Not the rider's km.
    const far = [{ lat: 6.6018, lng: 3.3515 }, { lat: 6.58, lng: 3.36 }, { lat: 6.55, lng: 3.365 }];
    await prisma.gpsLog.createMany({ data: far.map((q, i) => ({ rideId: ride.id, lat: q.lat, lng: q.lng, timestamp: new Date(T0 - 300_000 + i * 1000) })) });
  }
  if (frac > 0 && opts.gps !== false) {
    const fractions = [0, 0.2, 0.4, 0.6, 0.8, 0.9].filter((f) => f <= frac + 1e-9);
    await prisma.gpsLog.createMany({ data: fractions.map((f, i) => ({ rideId: ride.id, lat: along(f).lat, lng: along(f).lng, timestamp: new Date(T0 + 1000 + i * 1000) })) });
  }
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: rider } });
  if ((opts.method ?? 'WALLET') === 'WALLET') {
    await db.walletClient.createRideHold({ rideId: ride.id, walletId: wallet.id, riderId: rider, driverUserId: driverUser, amountNgn: calculateRideFees(5200).totalNgn });
    if (opts.afterHold !== undefined) await prisma.wallet.update({ where: { userId: rider }, data: { balanceNgn: opts.afterHold } });
  }
  return { rider, driverUser, driver, ride, car, walletId: wallet.id };
}

function rig() {
  const events = [];
  const redis = memoryRedis();
  const walletEvents = [];
  const publisher = { publishRideEvent: async (e) => { events.push(e); }, publishNotificationEvent: async () => {}, publishWalletEvent: async (e) => { walletEvents.push(e); } };
  const out = [];
  const rideService = createTripLifecycleHandler({ rideEventsProducer: new Proxy({}, { get: (_t, n) => async (e) => { out.push({ n: String(n), e }); } }) });
  const consumer = createRideEventsConsumer({ walletRepository: db.walletClient, walletEventsProducer: new Proxy({}, { get: () => async () => {} }) });
  return { events, walletEvents, redis, publisher, out, rideService, consumer };
}
const riderAuth = (t) => ({ userId: t.rider, privyDid: '', role: 'RIDER' });
const bal = async (userId) => Number((await prisma.wallet.findUniqueOrThrow({ where: { userId } })).balanceNgn);
const rideRow = (t) => prisma.ride.findUniqueOrThrow({ where: { id: t.ride.id } });
const holdOf = async (t) => Number((await prisma.rideHold.findUniqueOrThrow({ where: { rideId: t.ride.id } })).amountNgn);

const quote = (r, t, dest, stops) => handleRideMessage('ride:route:quote', { rideId: t.ride.id, destination: dest, stops }, riderAuth(t), r.publisher, planner, r.redis);
const update = (r, t, dest, stops, accepted, auth = riderAuth(t)) => handleRideMessage('ride:route:update', { rideId: t.ride.id, riderId: t.rider, destination: dest, stops, ...(accepted !== undefined ? { acceptedFareNgn: accepted } : {}) }, auth, r.publisher, planner, r.redis);
/** The published change reaches ride-service, then wallet-service (RIDE_ROUTE_UPDATED). */
async function deliver(r, t) {
  const requested = r.events.filter((e) => e.eventType === 'RIDE_ROUTE_UPDATE_REQUESTED').pop();
  await r.rideService.handleRideEvent(requested, ctx);
  const upd = r.out.filter((o) => o.n === 'rideRouteUpdated').pop()?.e;
  if (upd) await r.consumer.handle(upd, ctx);
  return { requested, upd };
}
async function complete(r, t) {
  await r.rideService.handleRideEvent({ eventType: 'RIDE_COMPLETION_REQUESTED', rideId: t.ride.id, riderId: t.rider, driverId: t.driver.id, endedBy: 'both_confirmed', timestamp: new Date().toISOString() }, ctx);
  const completed = r.out.filter((o) => o.n === 'rideCompleted').pop().e;
  await r.consumer.handle(completed, ctx);
  await r.rideService.handleRideEvent(completed, ctx);
  return completed;
}

test('formula: pure edge cases (no floor, no cap, rate scaling, driven clamped to the plan)', () => {
  const base = { inProgress: true, agreedFareNgn: 5000, plannedKm: 10, drivenKm: 8, restFareNgn: 1000.4, restKm: 3, rate: 1 };
  assert.deepEqual(routeChangeFare(base), { fareNgn: 4000 + 1000, plannedTotalKm: 11 });
  assert.equal(routeChangeFare({ ...base, drivenKm: 20 }).fareNgn, 5000 + 1000, 'driven cannot exceed the plan');
  assert.equal(routeChangeFare({ ...base, drivenKm: 0 }).fareNgn, 1000, 'nothing driven yet, and no floor at the current fare');
  assert.equal(routeChangeFare({ ...base, drivenKm: -3 }).fareNgn, 1000, 'never negative');
  assert.equal(routeChangeFare({ ...base, rate: 0.8 }).fareNgn, 4000 + 800, 'the rest is at the negotiated rate');
  assert.deepEqual(routeChangeFare({ ...base, inProgress: false, rate: 0.5 }), { fareNgn: 500, plannedTotalKm: 3 }, 'before pickup: our price for the new route at the rate');
});

test('in progress, 80% driven, a stop is added: the rider is charged the driven share + the rest, the driver is paid that', async () => {
  const t = await trip({ drivenFraction: 0.8 });
  const r = rig();
  const driven = pathKm([0, 0.2, 0.4, 0.6, 0.8].map(along));
  const restKm = pathKm([t.car, SURULERE, VI]);
  const expected = Math.round(5200 * driven / P) + farePerKm(restKm);

  const q = await quote(r, t, VI, [SURULERE]);
  assert.equal(q.payload.fareNgn, expected, 'the quote is the formula fare');
  assert.ok(planner.calls.every((c) => Math.abs(c.origin.lat - t.car.lat) < 1e-9), 'priced from where the car is');
  const reply = await update(r, t, VI, [SURULERE], q.payload.fareNgn);
  assert.equal(reply.type, 'ride:route:update:accepted');
  assert.equal(reply.payload.fareNgn, expected);
  const { requested, upd } = await deliver(r, t);
  assert.equal(requested.acceptedFareNgn, expected);
  assert.equal(requested.fareEstimateNgn, expected, 'fareEstimateNgn equals the accepted fare');
  assert.equal(upd.agreedFareNgn, expected);
  assert.equal(upd.change, 'stop_added');
  assert.equal(await holdOf(t), expected);

  const row = await rideRow(t);
  assert.equal(Number(row.agreedFareNgn), expected);
  assert.equal(Number(row.fareEstimateNgn), expected);
  assert.ok(Math.abs(row.plannedDistanceKm - (driven + restKm)) < 1e-6, 'plannedKm := kmDriven + restKm');
  const completed = await complete(r, t);
  assert.equal(completed.fareNgn, expected);
  assert.equal(20_000 - await bal(t.rider), expected);
  assert.equal(await bal(t.driverUser), calculateRideFees(expected).driverPayoutNgn);
  assert.equal(Number((await rideRow(t)).fareFinalNgn), expected);
  assert.ok(expected > 5200 * 0.8, 'it is more than the share driven, and not just the rest of the trip');
});

test('the same change through the ride page (/ride-page/trip-route) takes the same formula fare', async () => {
  const t = await trip({ drivenFraction: 0.8 });
  const r = rig();
  const expected = Math.round(5200 * pathKm([0, 0.2, 0.4, 0.6, 0.8].map(along)) / P) + farePerKm(pathKm([t.car, SURULERE, VI]));
  const deps = { jwtSecret: JWT_SECRET, redisClient: r.redis, paymentsClient: {}, googleMapsApiKey: 'k', routePlanner: planner, publisher: r.publisher, notifyChat: async () => {} };
  const call = async (path, body) => {
    const bearer = local.createWalletPageToken(t.rider, 'ride', JWT_SECRET, local.RIDE_PAGE_TOKEN_TTL_SECONDS);
    const raw = [Buffer.from(JSON.stringify(body))];
    const req = { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { for (const c of raw) yield c; } };
    const res = { statusCode: 200, body: null, setHeader() {}, writeHead(c) { this.statusCode = c; return this; }, end(x) { this.body = x ? JSON.parse(x) : null; } };
    await handleRidePageRoute(req, res, deps, new URL(`http://x${path}`));
    return res;
  };
  const q = await call('/ride-page/trip-route/quote', { stops: [SURULERE] });
  assert.equal(q.body.fareNgn, expected);
  const done = await call('/ride-page/trip-route', { stops: [SURULERE], acceptedFareNgn: expected });
  assert.equal(done.statusCode, 200, JSON.stringify(done.body));
  const { requested } = await deliver(r, t);
  assert.equal(requested.acceptedFareNgn, expected);
});

test('before pickup the new fare is the full fresh price of the new route (pickup -> stop -> destination)', async () => {
  const t = await trip({ status: 'DRIVER_EN_ROUTE', drivenFraction: 0 });
  const r = rig();
  const expected = farePerKm(pathKm([YABA, SURULERE, VI]));
  const q = await quote(r, t, VI, [SURULERE]);
  assert.equal(q.payload.fareNgn, expected);
  assert.equal((await update(r, t, VI, [SURULERE], expected)).type, 'ride:route:update:accepted');
  const { requested } = await deliver(r, t);
  assert.equal(requested.plannedTotalKm, pathKm([YABA, SURULERE, VI]));
  const row = await rideRow(t);
  assert.equal(Number(row.agreedFareNgn), expected, 'replaces the negotiated 5200 with the calculated price');
  assert.equal(await holdOf(t), expected);
});

test('a lower fare: the rider is charged only that, the rest of the hold goes back', async () => {
  const t = await trip({ drivenFraction: 0.8 });
  const r = rig();
  const near = along(0.9);
  const expected = Math.round(5200 * pathKm([0, 0.2, 0.4, 0.6, 0.8].map(along)) / P) + farePerKm(pathKm([t.car, near]));
  assert.ok(expected < 5200);
  const q = await quote(r, t, near, []);
  assert.equal(q.payload.fareNgn, expected);
  assert.ok(q.payload.extraNgn < 0);
  await update(r, t, near, [], expected);
  await deliver(r, t);
  assert.equal(await holdOf(t), expected);
  const completed = await complete(r, t);
  assert.equal(completed.fareNgn, expected);
  assert.equal(20_000 - await bal(t.rider), expected);
  assert.equal(Number((await prisma.wallet.findUniqueOrThrow({ where: { userId: t.rider } })).lockedNgn), 0);
});

test('wallet short: refused with the amount, nothing moves; a deposit applies it; the charge is the accepted fare', async () => {
  const t = await trip({ drivenFraction: 0.8, afterHold: 100 });
  const r = rig();
  const q = await quote(r, t, VI, [SURULERE]);
  const fare = q.payload.fareNgn;
  const refused = await update(r, t, VI, [SURULERE], fare);
  assert.equal(refused.type, 'ride:route:update:rejected');
  assert.equal(refused.payload.reason, 'WALLET_SHORT');
  assert.equal(refused.payload.fareNgn, fare);
  assert.equal(refused.payload.extraNgn, calculateRideFees(fare).totalNgn - 5200);
  assert.equal(refused.payload.neededNgn, refused.payload.extraNgn - 100);
  assert.equal(refused.payload.balanceNgn, 100);
  assert.ok(refused.payload.pendingUntil);
  assert.equal(r.events.length, 0, 'nothing was published: the route is never applied unfunded');
  assert.equal(Number((await rideRow(t)).agreedFareNgn), 5200);

  // Still short: a deposit that does not cover it applies nothing.
  const deps = { redisClient: r.redis, registry: { sendToUser: async () => {} }, publisher: r.publisher };
  await prisma.wallet.update({ where: { userId: t.rider }, data: { balanceNgn: { increment: 10 } } });
  assert.equal(await applyPendingRouteOnDeposit(deps, t.rider), false);
  assert.equal(r.events.length, 0);

  // The deposit covers it: applied once, exactly as accepted.
  await prisma.wallet.update({ where: { userId: t.rider }, data: { balanceNgn: { increment: refused.payload.neededNgn } } });
  const sent = [];
  deps.registry.sendToUser = async (u, type, p) => { sent.push({ u, type, p }); };
  assert.equal(await applyPendingRouteOnDeposit(deps, t.rider), true);
  assert.equal(await applyPendingRouteOnDeposit(deps, t.rider), false, 'applied once');
  assert.equal(sent[0].type, 'ride:route:update:accepted');
  assert.equal(r.events.length, 1);
  await deliver(r, t);
  assert.equal(await holdOf(t), fare);
  const completed = await complete(r, t);
  assert.equal(completed.fareNgn, fare);
  const paidOut = await bal(t.driverUser);
  assert.equal(paidOut, calculateRideFees(fare).driverPayoutNgn);
});

test('wallet short, then the rider tops up and tries again: the retry applies the same accepted fare', async () => {
  const t = await trip({ drivenFraction: 0.8, afterHold: 100 });
  const r = rig();
  const fare = (await quote(r, t, VI, [SURULERE])).payload.fareNgn;
  const refused = await update(r, t, VI, [SURULERE], fare);
  assert.equal(refused.payload.reason, 'WALLET_SHORT');
  await prisma.wallet.update({ where: { userId: t.rider }, data: { balanceNgn: { increment: 9000 } } });
  await prisma.driver.update({ where: { id: t.driver.id }, data: { lat: t.car.lat + 0.0005, lng: t.car.lng } }); // the car crept ~55 m: still the same price
  const again = await update(r, t, VI, [SURULERE], fare);
  assert.equal(again.type, 'ride:route:update:accepted');
  assert.equal(r.events[0].acceptedFareNgn, fare, 'priced as accepted, not again from the new position');
});

test('wallet short, rider backs out: the trip stays as it was and a later deposit does nothing', async () => {
  const t = await trip({ drivenFraction: 0.8, afterHold: 100 });
  const r = rig();
  const fare = (await quote(r, t, VI, [SURULERE])).payload.fareNgn;
  assert.equal((await update(r, t, VI, [SURULERE], fare)).payload.reason, 'WALLET_SHORT');
  const gone = await handleRideMessage('ride:route:pending:cancel', { rideId: t.ride.id }, riderAuth(t), r.publisher, planner, r.redis);
  assert.equal(gone.type, 'ride:route:pending:cancelled');
  await prisma.wallet.update({ where: { userId: t.rider }, data: { balanceNgn: { increment: 9000 } } });
  assert.equal(await applyPendingRouteOnDeposit({ redisClient: r.redis, registry: { sendToUser: async () => {} }, publisher: r.publisher }, t.rider), false);
  assert.equal(r.events.length, 0);
  const row = await rideRow(t);
  assert.equal(Number(row.agreedFareNgn), 5200);
  assert.ok(Math.abs(row.plannedDistanceKm - P) < 1e-9);
  assert.equal(await holdOf(t), 5200);
});

test('a forged acceptedFareNgn is rejected and the agreed fare is unchanged', async () => {
  const t = await trip({ drivenFraction: 0.8 });
  const r = rig();
  const real = (await quote(r, t, VI, [SURULERE])).payload.fareNgn;
  const forged = await update(r, t, VI, [SURULERE], 1);
  assert.equal(forged.type, 'ride:route:update:rejected');
  assert.equal(forged.payload.reason, 'PRICE_CHANGED');
  assert.equal(forged.payload.fareNgn, real);
  assert.equal(r.events.length, 0);
  assert.equal(Number((await rideRow(t)).agreedFareNgn), 5200);
});

test('a driver-auth update carrying acceptedFareNgn does not touch the agreed fare', async () => {
  const t = await trip({ drivenFraction: 0.8 });
  const r = rig();
  const driverAuth = { userId: t.driverUser, privyDid: '', role: 'DRIVER', driverId: t.driver.id };
  await assert.rejects(() => update(r, t, VI, [SURULERE], 1234, driverAuth), /Only the rider/);
  assert.equal(r.events.length, 0, 'the driver app never changes a route: nothing is published');
  assert.equal(Number((await rideRow(t)).agreedFareNgn), 5200);
});

test('a Kafka redelivery of the same change is idempotent', async () => {
  const t = await trip({ drivenFraction: 0.8 });
  const r = rig();
  const fare = (await quote(r, t, VI, [SURULERE])).payload.fareNgn;
  await update(r, t, VI, [SURULERE], fare);
  await deliver(r, t);
  const stopsOnce = await prisma.rideStop.count({ where: { rideId: t.ride.id } });
  await deliver(r, t); // redelivered
  assert.equal(await holdOf(t), fare);
  assert.equal(await prisma.rideStop.count({ where: { rideId: t.ride.id } }), stopsOnce);
  assert.equal(Number((await rideRow(t)).agreedFareNgn), fare);
  const completed = await complete(r, t);
  assert.equal(20_000 - await bal(t.rider), completed.fareNgn);
  assert.equal(completed.fareNgn, fare);
});

test('a completed or cancelled ride cannot have its route changed (quote, update, or a late event)', async () => {
  for (const status of ['COMPLETED', 'CANCELLED']) {
    const t = await trip({ drivenFraction: 0.8, status });
    const r = rig();
    await assert.rejects(() => quote(r, t, VI, [SURULERE]), /not running|no longer change its route/);
    await assert.rejects(() => update(r, t, VI, [SURULERE], 4000), /not running|no longer change its route/);
    assert.equal(r.events.length, 0);
    // A late event that carries a fare is ignored by ride-service: the row's fare stays.
    await r.rideService.handleRideEvent({ eventType: 'RIDE_ROUTE_UPDATE_REQUESTED', rideId: t.ride.id, riderId: t.rider, driverId: t.driver.id, destination: VI, stops: [], plannedDistanceKm: 3, plannedDurationSeconds: 60, fareEstimateNgn: 4000, acceptedFareNgn: 4000, updatedBy: 'rider', timestamp: new Date().toISOString() }, ctx);
    const row = await rideRow(t);
    assert.equal(Number(row.agreedFareNgn), 5200);
    assert.equal(Number(row.fareEstimateNgn), 5200);
  }
});

test('plannedKm missing: derived from the planner (driven = pickup to car, plan = driven + the old remaining route), never a free stop', async () => {
  const t = await trip({ drivenFraction: 0.8, plannedKm: null });
  const r = rig();
  const driven = pathKm([YABA, t.car]);
  const remaining = pathKm([t.car, VI]);
  const expected = Math.round(5200 * driven / (driven + remaining)) + farePerKm(pathKm([t.car, SURULERE, VI]));
  const q = await quote(r, t, VI, [SURULERE]);
  assert.equal(q.payload.fareNgn, expected);
  assert.ok(q.payload.fareNgn > 4000, 'the driven share is charged, the stop is not free');
  assert.equal((await update(r, t, VI, [SURULERE], expected)).type, 'ride:route:update:accepted');
  const { requested } = await deliver(r, t);
  assert.equal(requested.acceptedFareNgn, expected);
  assert.ok(Math.abs(requested.plannedTotalKm - (driven + pathKm([t.car, SURULERE, VI]))) < 1e-6);
});

test('flag OFF: exactly today (rest-of-trip quote, agreed untouched, only the live-trip check)', async () => {
  setStopFixedPriceEnabled(false);
  const t = await trip({ drivenFraction: 0.8 });
  const r = rig();
  const rest = farePerKm(pathKm([t.car, SURULERE, VI]));
  const q = await quote(r, t, VI, [SURULERE]);
  assert.equal(q.payload.fareNgn, rest);
  const reply = await update(r, t, VI, [SURULERE], rest);
  assert.equal(reply.type, 'ride:route:update:accepted');
  assert.equal(reply.payload.fareNgn, undefined);
  const { requested } = await deliver(r, t);
  assert.equal(requested.acceptedFareNgn, undefined);
  assert.equal(requested.plannedTotalKm, undefined);
  assert.equal(requested.fareEstimateNgn, rest);
  const row = await rideRow(t);
  assert.equal(Number(row.agreedFareNgn), 5200);
  assert.ok(Math.abs(row.plannedDistanceKm - P) < 1e-9);
  // The ownership / live-trip check of the security fix applies with the flag off too.
  const done = await trip({ drivenFraction: 0.8, status: 'COMPLETED' });
  await assert.rejects(() => update(rig(), done, VI, [SURULERE]), /not running/);
});

test('an old app without acceptedFareNgn (flag on): unchanged, agreed fare stays', async () => {
  const t = await trip({ drivenFraction: 0.8 });
  const r = rig();
  // The real old payload (no origin) to a nearer place: not longer, so it goes ahead and the fare stays.
  const reply = await handleRideMessage('ride:route:update', { rideId: t.ride.id, riderId: t.rider, destination: along(0.9), stops: [] }, riderAuth(t), r.publisher, planner, r.redis);
  assert.equal(reply.type, 'ride:route:update:accepted');
  const { requested } = await deliver(r, t);
  assert.equal(requested.acceptedFareNgn, undefined);
  assert.equal(Number((await rideRow(t)).agreedFareNgn), 5200);
});

test('cash ride: formula fare reaches RIDE_COMPLETED, no wallet money moves, no wallet check', async () => {
  const t = await trip({ drivenFraction: 0.8, method: 'CASH', afterHold: undefined });
  const r = rig();
  const fare = (await quote(r, t, VI, [SURULERE])).payload.fareNgn;
  assert.equal((await update(r, t, VI, [SURULERE], fare)).type, 'ride:route:update:accepted');
  await deliver(r, t);
  const completed = await complete(r, t);
  assert.equal(completed.paymentMethod, 'CASH');
  assert.equal(completed.fareNgn, fare);
  assert.equal(await bal(t.rider), 20_000);
  assert.equal(await bal(t.driverUser), 0);
});

test('the driver hears ride:route:updated with the new fare and change after a gateway restart (empty rideParticipants)', async () => {
  const t = await trip({ drivenFraction: 0.8 });
  const sent = [];
  const deps = {
    registry: { sendToUser: async (userId, type, payload) => { sent.push({ userId, type, payload }); }, hasUser: () => true, isUserConnected: async () => true },
    redisClient: memoryRedis(),
    publisher: { publishRideEvent: async () => {}, publishNotificationEvent: async () => {}, publishDriverEvent: async () => {}, publishWalletEvent: async () => {} },
  };
  await handleRideEvent({
    eventType: 'RIDE_ROUTE_UPDATED', rideId: t.ride.id, riderId: t.rider, driverId: t.driver.id,
    destination: VI, stops: [{ stopId: randomUUID(), stopOrder: 0, type: 'final', status: 'pending', ...VI }],
    plannedDistanceKm: 4, plannedDurationSeconds: 600, fareEstimateNgn: 6100, agreedFareNgn: 6100, change: 'stop_added', updatedBy: 'rider', timestamp: new Date().toISOString(),
  }, deps, new Map());
  const toDriver = sent.find((m) => m.userId === t.driverUser && m.type === 'ride:route:updated');
  assert.ok(toDriver, 'the driver is found from the database');
  assert.equal(toDriver.payload.fareNgn, 6100);
  assert.equal(toDriver.payload.change, 'stop_added');
  assert.ok(sent.some((m) => m.userId === t.rider && m.type === 'ride:route:updated'));
});

// ---- round 2: where the money moves, once-only, stale base, GPS since the start ----

const depositEvent = (t, creditType = 'deposit') => ({ eventType: 'WALLET_CREDITED', walletId: t.walletId, userId: t.rider, amountNgn: 9000, newBalanceNgn: 9000, creditType, referenceId: randomUUID(), timestamp: new Date().toISOString() });
const gwDeps = (r, sent = []) => ({ registry: { sendToUser: async (u, type, p) => { sent.push({ u, type, p }); }, hasUser: () => true, isUserConnected: async () => true }, redisClient: r.redis, publisher: r.publisher });
async function shortTrip(opts = {}) {
  const t = await trip({ drivenFraction: 0.8, afterHold: 100, ...opts });
  const r = rig();
  const stops = opts.stops ?? [SURULERE];
  const q = await quote(r, t, VI, stops);
  const refused = await update(r, t, VI, stops, q.payload.fareNgn);
  assert.equal(refused.payload.reason, 'WALLET_SHORT');
  return { t, r, fare: q.payload.fareNgn, refused, stops };
}

test('the deposit arrives as WALLET_CREDITED (handleWalletEvent): a deposit applies the waiting change, a refund does not', async () => {
  const { t, r, fare, refused } = await shortTrip();
  await prisma.wallet.update({ where: { userId: t.rider }, data: { balanceNgn: { increment: refused.payload.neededNgn } } });
  const sent = [];
  await handleWalletEvent(depositEvent(t, 'refund'), gwDeps(r, sent), new Map());
  assert.equal(r.events.length, 0, 'only a deposit applies it (the creditType gate)');
  await handleWalletEvent(depositEvent(t, 'deposit'), gwDeps(r, sent), new Map());
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].acceptedFareNgn, fare);
  assert.ok(sent.some((m) => m.type === 'ride:route:update:accepted' && m.p.appliedAfterDeposit));
  assert.equal(await holdOf(t), fare, 'the gateway raised the hold before publishing');
  assert.equal(r.walletEvents.length, 1);
  await deliver(r, t);
  assert.equal(await holdOf(t), fare);
});

test('the hold moves in the gateway before publishing: a balance of 999.60 against a 1000 extra is refused', async () => {
  const t = await trip({ drivenFraction: 0.8 });
  const r = rig();
  const q = await quote(r, t, VI, [SURULERE]);
  await prisma.wallet.update({ where: { userId: t.rider }, data: { balanceNgn: q.payload.extraNgn - 0.4 } });
  const refused = await update(r, t, VI, [SURULERE], q.payload.fareNgn);
  assert.equal(refused.payload.reason, 'WALLET_SHORT', 'compared to the kobo, not rounded');
  assert.equal(refused.payload.neededNgn, 1);
  assert.equal(r.events.length, 0);
  assert.equal(await holdOf(t), 5200, 'the hold did not move');
});

test('a withdrawal between the quote and the update: refused at the hold, nothing published', async () => {
  const t = await trip({ drivenFraction: 0.8 });
  const r = rig();
  const q = await quote(r, t, VI, [SURULERE]);
  assert.ok(q.payload.extraNgn > 0);
  await prisma.wallet.update({ where: { userId: t.rider }, data: { balanceNgn: 50 } }); // the rider withdrew
  const refused = await update(r, t, VI, [SURULERE], q.payload.fareNgn);
  assert.equal(refused.payload.reason, 'WALLET_SHORT');
  assert.equal(r.events.length, 0);
  assert.equal(await holdOf(t), 5200);
});

test('a publish that fails after the hold moved puts the hold back', async () => {
  const t = await trip({ drivenFraction: 0.8 });
  const r = rig();
  const q = await quote(r, t, VI, [SURULERE]);
  r.publisher.publishRideEvent = async () => { throw new Error('kafka down'); };
  await assert.rejects(() => update(r, t, VI, [SURULERE], q.payload.fareNgn), /kafka down/);
  assert.equal(await holdOf(t), 5200);
  assert.equal(Number((await rideRow(t)).agreedFareNgn), 5200);
});

test('a deposit and a retry at the same moment publish the change once', async () => {
  const { t, r, fare, stops } = await shortTrip();
  await prisma.wallet.update({ where: { userId: t.rider }, data: { balanceNgn: { increment: 9000 } } });
  const [a, b] = await Promise.all([
    applyPendingRouteOnDeposit(gwDeps(r), t.rider),
    update(r, t, VI, stops, fare),
  ]);
  assert.equal(r.events.length, 1, 'one publish');
  assert.equal(b.type, 'ride:route:update:accepted');
  assert.equal(await holdOf(t), fare);
  assert.ok(a === true || b.payload.alreadyApplied !== true || a === false);
});

test('a cancel racing a deposit: exactly one of them wins, and the answer says which', async () => {
  const { t, r } = await shortTrip();
  await prisma.wallet.update({ where: { userId: t.rider }, data: { balanceNgn: { increment: 9000 } } });
  const [applied, cancel] = await Promise.all([
    applyPendingRouteOnDeposit(gwDeps(r), t.rider),
    handleRideMessage('ride:route:pending:cancel', { rideId: t.ride.id }, riderAuth(t), r.publisher, planner, r.redis),
  ]);
  if (cancel.payload.cancelled) { assert.equal(applied, false); assert.equal(r.events.length, 0); assert.equal(await holdOf(t), 5200); }
  else { assert.equal(applied, true); assert.equal(r.events.length, 1); }
});

test('a short retry keeps its first expiry', async () => {
  const { t, r, fare, refused, stops } = await shortTrip();
  const again = await update(r, t, VI, stops, fare);
  assert.equal(again.payload.reason, 'WALLET_SHORT');
  assert.equal(again.payload.pendingUntil, refused.payload.pendingUntil);
});

test('GPS points from before the trip started are not driven km', async () => {
  const t = await trip({ drivenFraction: 0.8, preStartGps: true });
  const r = rig();
  const expected = Math.round(5200 * pathKm([0, 0.2, 0.4, 0.6, 0.8].map(along)) / P) + farePerKm(pathKm([t.car, SURULERE, VI]));
  assert.equal((await quote(r, t, VI, [SURULERE])).payload.fareNgn, expected);
});

test('no GPS since the start: kmDriven is the road from the pickup to the car, not 0 and not a refusal', async () => {
  const t = await trip({ drivenFraction: 0.8, gps: false, preStartGps: true });
  const r = rig();
  const expected = Math.round(5200 * pathKm([YABA, t.car]) / P) + farePerKm(pathKm([t.car, SURULERE, VI]));
  assert.equal((await quote(r, t, VI, [SURULERE])).payload.fareNgn, expected);
  assert.ok(expected > farePerKm(pathKm([t.car, SURULERE, VI])));
});

test('a pending change applied after a stop was reached is dropped (the base moved)', async () => {
  const t = await trip({ drivenFraction: 0.8, afterHold: 100, middleStop: true });
  const r = rig();
  const stops = [along(0.3), SURULERE];
  const fare = (await quote(r, t, VI, stops)).payload.fareNgn;
  assert.equal((await update(r, t, VI, stops, fare)).payload.reason, 'WALLET_SHORT');
  await r.rideService.handleRideEvent({ eventType: 'RIDE_STOP_CONFIRMED', rideId: t.ride.id, riderId: t.rider, driverId: t.driver.id, confirmedBy: 'driver', timestamp: new Date().toISOString() }, ctx);
  await prisma.wallet.update({ where: { userId: t.rider }, data: { balanceNgn: { increment: 20000 } } });
  const sent = [];
  assert.equal(await applyPendingRouteOnDeposit(gwDeps(r, sent), t.rider), false);
  assert.equal(r.events.length, 0);
  assert.ok(sent.some((m) => m.type === 'ride:route:update:dropped'));
  assert.equal(Number((await rideRow(t)).agreedFareNgn), 5200);
  assert.equal(await holdOf(t), 5200);
});

test('ride-service skips a priced change whose base no longer matches the ride', async () => {
  const t = await trip({ drivenFraction: 0.8 });
  const r = rig();
  await r.rideService.handleRideEvent({ eventType: 'RIDE_ROUTE_UPDATE_REQUESTED', rideId: t.ride.id, riderId: t.rider, driverId: t.driver.id, destination: VI, stops: [SURULERE], plannedDistanceKm: 3, plannedDurationSeconds: 60, fareEstimateNgn: 7000, acceptedFareNgn: 7000, plannedTotalKm: 9, baseAgreedFareNgn: 4800, basePlannedKm: P, baseDoneStops: 0, updatedBy: 'rider', timestamp: new Date().toISOString() }, ctx);
  const row = await rideRow(t);
  assert.equal(Number(row.agreedFareNgn), 5200);
  assert.equal(await prisma.rideStop.count({ where: { rideId: t.ride.id } }), 1, 'stops untouched');
  const snaps = r.out.filter((o) => o.n === 'rideRouteUpdated');
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].e.reverted, true, 'only a snapshot of the ride as it stands');
});

test('the same stops and destination are refused (no free reprice); flag off keeps today', async () => {
  const t = await trip({ drivenFraction: 0.8 });
  const r = rig();
  await assert.rejects(() => quote(r, t, VI, []), /route you already have/);
  await assert.rejects(() => update(r, t, VI, [], 5200), /route you already have/);
  assert.equal(r.events.length, 0);
  setStopFixedPriceEnabled(false);
  assert.equal((await quote(r, t, VI, [])).type, 'ride:route:quote:result');
});

test('an unpriced change on a trip under way (old app) keeps the hold at the agreed fare', async () => {
  const t = await trip({ drivenFraction: 0.8 });
  const r = rig();
  const reply = await handleRideMessage('ride:route:update', { rideId: t.ride.id, riderId: t.rider, destination: along(0.9), stops: [], origin: { ...t.car, address: 'Yaba' } }, riderAuth(t), r.publisher, planner, r.redis);
  assert.equal(reply.type, 'ride:route:update:accepted');
  const { upd } = await deliver(r, t);
  assert.equal(upd.fareEstimateNgn, 5200);
  assert.equal(upd.agreedFareNgn, undefined);
  assert.equal(upd.change, undefined, 'flag-off style event: no change field on an unpriced update');
  assert.equal(await holdOf(t), 5200);
  assert.equal(Number((await rideRow(t)).agreedFareNgn), 5200);
});

// ---- round 4 ----

test('a cheaper change never lowers the hold before ride-service has applied it', async () => {
  const t = await trip({ drivenFraction: 0.8 });
  const r = rig();
  const near = along(0.9);
  const q = await quote(r, t, near, []);
  assert.ok(q.payload.fareNgn < 5200);
  assert.equal((await update(r, t, near, [], q.payload.fareNgn)).type, 'ride:route:update:accepted');
  assert.equal(await holdOf(t), 5200, 'published, not yet applied: the hold stands');
  await deliver(r, t);
  assert.equal(await holdOf(t), q.payload.fareNgn, 'wallet-service lowers it after ride-service applied the change');
});

test('ride-service skips a stale change after the gateway raised the hold: the hold goes back to the agreed fare and the rider is told', async () => {
  const t = await trip({ drivenFraction: 0.8 });
  const r = rig();
  const q = await quote(r, t, VI, [SURULERE]);
  assert.equal((await update(r, t, VI, [SURULERE], q.payload.fareNgn)).type, 'ride:route:update:accepted');
  assert.equal(await holdOf(t), calculateRideFees(q.payload.fareNgn).totalNgn, 'the gateway raised it');
  await prisma.ride.update({ where: { id: t.ride.id }, data: { plannedDistanceKm: P + 1 } }); // the ride moved on before ride-service got to it
  const { upd } = await deliver(r, t);
  assert.equal(upd.reverted, true);
  assert.equal(upd.agreedFareNgn, 5200);
  assert.equal(await holdOf(t), 5200, 'back to the agreed fare');
  assert.equal(Number((await rideRow(t)).agreedFareNgn), 5200);
  assert.equal(await prisma.rideStop.count({ where: { rideId: t.ride.id } }), 1);
  const sent = [];
  await handleRideEvent(upd, gwDeps(r, sent), new Map());
  assert.ok(sent.some((m) => m.u === t.rider && m.type === 'ride:route:update:dropped' && m.p.reason === 'TRIP_CHANGED'));
  assert.ok(sent.some((m) => m.u === t.rider && m.type === 'ride:route:updated'), 'the screen goes back to the real route');
});

test('two identical updates at once publish once; the loser says in progress unless the ride visibly moved on', async () => {
  const t = await trip({ drivenFraction: 0.8 });
  const r = rig();
  const fare = (await quote(r, t, VI, [SURULERE])).payload.fareNgn;
  const [a, b] = await Promise.all([update(r, t, VI, [SURULERE], fare), update(r, t, VI, [SURULERE], fare)]);
  assert.equal(r.events.length, 1);
  const loser = [a, b].find((x) => x.payload.inProgress || x.payload.alreadyApplied);
  assert.ok(loser);
  assert.equal(loser.payload.inProgress, true, 'nothing has been applied by ride-service yet');
  assert.equal(loser.payload.alreadyApplied, undefined);
});

test('one GPS point since the start is not a path: the pickup-to-car estimate is used', async () => {
  const t = await trip({ drivenFraction: 0.8, gps: false });
  await prisma.gpsLog.create({ data: { rideId: t.ride.id, lat: t.car.lat, lng: t.car.lng, timestamp: new Date(Date.now() - 500_000) } });
  const r = rig();
  const expected = Math.round(5200 * pathKm([YABA, t.car]) / P) + farePerKm(pathKm([t.car, SURULERE, VI]));
  assert.equal((await quote(r, t, VI, [SURULERE])).payload.fareNgn, expected);
});

test('a quote priced against a ride that has since changed is priced again at accept', async () => {
  const t = await trip({ drivenFraction: 0.8 });
  const r = rig();
  const q = await quote(r, t, VI, [SURULERE]);
  await prisma.ride.update({ where: { id: t.ride.id }, data: { plannedDistanceKm: P * 2 } });
  const reply = await update(r, t, VI, [SURULERE], q.payload.fareNgn);
  assert.equal(reply.type, 'ride:route:update:rejected');
  assert.equal(reply.payload.reason, 'PRICE_CHANGED');
  assert.equal(r.events.length, 0);
});

test('an unpriced change before pickup keeps the hold at the agreed fare too', async () => {
  const t = await trip({ status: 'DRIVER_EN_ROUTE' });
  const r = rig();
  await handleRideMessage('ride:route:update', { rideId: t.ride.id, riderId: t.rider, destination: along(0.9), stops: [], origin: { ...YABA } }, riderAuth(t), r.publisher, planner, r.redis);
  const { upd } = await deliver(r, t);
  assert.equal(upd.fareEstimateNgn, 5200);
  assert.equal(await holdOf(t), 5200);
});

test('ride:stop:confirm: a stranger is refused, the ride\'s own driver and rider are allowed', async () => {
  const t = await trip({ drivenFraction: 0.8, middleStop: true });
  const other = await trip();
  const r = rig();
  const confirm = (auth) => handleRideMessage('ride:stop:confirm', { rideId: t.ride.id, riderId: t.rider }, auth, r.publisher, planner, r.redis);
  await assert.rejects(() => confirm({ userId: other.driverUser, privyDid: '', role: 'DRIVER', driverId: other.driver.id }), /not assigned to you|not yours/);
  await assert.rejects(() => confirm({ userId: other.rider, privyDid: '', role: 'RIDER' }), /not yours/);
  assert.equal(r.events.length, 0);
  const driverAuth = { userId: t.driverUser, privyDid: '', role: 'DRIVER', driverId: t.driver.id };
  await assert.rejects(() => confirm(driverAuth), /not at the stop yet/); // the car is far from the next stop
  const stop = along(0.3);
  await prisma.driver.update({ where: { id: t.driver.id }, data: { lat: stop.lat + 0.0005, lng: stop.lng, lastSeenAt: new Date() } }); // ~55 m
  assert.equal((await confirm(driverAuth)).type, 'ride:stop:confirm:accepted');
  assert.equal((await confirm(riderAuth(t))).type, 'ride:stop:confirm:accepted');
  assert.equal(r.events.length, 2);
  assert.ok(r.events.every((e) => e.riderId === t.rider));
});

test('stop:confirm takes the driver from the ride, not the payload', async () => {
  const t = await trip({ drivenFraction: 0.8, middleStop: true });
  const r = rig();
  const reply = await handleRideMessage('ride:stop:confirm', { rideId: t.ride.id, riderId: randomUUID(), driverId: randomUUID() }, riderAuth(t), r.publisher, planner, r.redis);
  assert.equal(reply.type, 'ride:stop:confirm:accepted');
  assert.equal(r.events[0].driverId, t.driver.id);
  assert.equal(r.events[0].riderId, t.rider);
});

test('a priced change snapshot carries the accepted fare even without planned distance or duration', async () => {
  const t = await trip({ drivenFraction: 0.8 });
  const r = rig();
  await r.rideService.handleRideEvent({ eventType: 'RIDE_ROUTE_UPDATE_REQUESTED', rideId: t.ride.id, riderId: t.rider, driverId: t.driver.id, destination: VI, stops: [SURULERE], acceptedFareNgn: 6100.4, baseAgreedFareNgn: 5200, basePlannedKm: P, baseDoneStops: 0, updatedBy: 'rider', timestamp: new Date().toISOString() }, ctx);
  const snap = r.out.find((o) => o.n === 'rideRouteUpdated').e;
  assert.equal(snap.fareEstimateNgn, 6100);
  assert.equal(snap.agreedFareNgn, 6100);
  const row = await rideRow(t);
  assert.equal(Number(row.fareEstimateNgn), 6100);
  assert.equal(Number(row.agreedFareNgn), 6100);
});

test('the ride page state shows routePending while a change waits, and drops it when applied, cancelled, or the flag is off', async () => {
  const { t, r, fare, refused } = await shortTrip();
  const deps = { jwtSecret: JWT_SECRET, redisClient: r.redis, paymentsClient: {}, googleMapsApiKey: 'k', routePlanner: planner, publisher: r.publisher, notifyChat: async () => {} };
  const state = async (method = 'GET', path = '/ride-page/state') => {
    const bearer = local.createWalletPageToken(t.rider, 'ride', JWT_SECRET, local.RIDE_PAGE_TOKEN_TTL_SECONDS);
    const req = { method, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() {} };
    const res = { statusCode: 200, body: null, setHeader() {}, writeHead(c) { this.statusCode = c; return this; }, end(x) { this.body = x ? JSON.parse(x) : null; } };
    await handleRidePageRoute(req, res, deps, new URL(`http://x${path}`));
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    return res.body;
  };
  const shown = await state();
  assert.equal(shown.phase, 'confirmed');
  assert.deepEqual(shown.routePending, { pendingUntil: refused.payload.pendingUntil, fareNgn: fare, neededNgn: refused.payload.neededNgn, sendNgn: depositNeededFor(refused.payload.neededNgn) });
  setStopFixedPriceEnabled(false);
  assert.equal('routePending' in (await state()), false, 'flag off: absent');
  setStopFixedPriceEnabled(true);
  await prisma.wallet.update({ where: { userId: t.rider }, data: { balanceNgn: { increment: 9000 } } });
  assert.equal(await applyPendingRouteOnDeposit(gwDeps(r), t.rider), true);
  await deliver(r, t);
  const after = await state();
  assert.equal('routePending' in after, false, 'applied: gone');
  assert.equal(after.trip.destination !== undefined, true);
});

test('the ride page state: routePending is gone after the rider cancels, and absent when nothing waits', async () => {
  const { t, r } = await shortTrip();
  const deps = { jwtSecret: JWT_SECRET, redisClient: r.redis, paymentsClient: {}, googleMapsApiKey: 'k', routePlanner: planner, publisher: r.publisher, notifyChat: async () => {} };
  const state = async () => {
    const bearer = local.createWalletPageToken(t.rider, 'ride', JWT_SECRET, local.RIDE_PAGE_TOKEN_TTL_SECONDS);
    const req = { method: 'GET', headers: { authorization: `Bearer ${bearer}` }, async *[Symbol.asyncIterator]() {} };
    const res = { statusCode: 200, body: null, setHeader() {}, writeHead(c) { this.statusCode = c; return this; }, end(x) { this.body = x ? JSON.parse(x) : null; } };
    await handleRidePageRoute(req, res, deps, new URL('http://x/ride-page/state'));
    return res.body;
  };
  assert.ok((await state()).routePending);
  await handleRideMessage('ride:route:pending:cancel', { rideId: t.ride.id }, riderAuth(t), r.publisher, planner, r.redis);
  assert.equal('routePending' in (await state()), false);
  const plain = await trip({ drivenFraction: 0.8 });
  assert.equal('routePending' in (await (async () => { const rr = rig(); deps.redisClient = rr.redis; t.rider = plain.rider; return state(); })()), false);
});


test('sendNgn: the amount to send so neededNgn lands after the deposit fee, on the ws answer and in the page state', async () => {
  const { t, r, refused } = await shortTrip();
  assert.equal(refused.payload.sendNgn, depositNeededFor(refused.payload.neededNgn));
  assert.ok(refused.payload.sendNgn > refused.payload.neededNgn);
  const deps = { jwtSecret: JWT_SECRET, redisClient: r.redis, paymentsClient: {}, googleMapsApiKey: 'k', routePlanner: planner, publisher: r.publisher, notifyChat: async () => {} };
  const bearer = local.createWalletPageToken(t.rider, 'ride', JWT_SECRET, local.RIDE_PAGE_TOKEN_TTL_SECONDS);
  const get = async () => { const req = { method: 'GET', headers: { authorization: `Bearer ${bearer}` }, async *[Symbol.asyncIterator]() {} }; const res = { statusCode: 200, body: null, setHeader() {}, writeHead(c) { this.statusCode = c; return this; }, end(x) { this.body = JSON.parse(x); } }; await handleRidePageRoute(req, res, deps, new URL('http://x/ride-page/state')); return res.body; };
  assert.equal((await get()).routePending.sendNgn, refused.payload.sendNgn);
  // The page's 402 carries it too.
  const post = async (path, body) => { const raw = [Buffer.from(JSON.stringify(body))]; const req = { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { for (const c of raw) yield c; } }; const res = { statusCode: 200, body: null, setHeader() {}, writeHead(c) { this.statusCode = c; return this; }, end(x) { this.body = JSON.parse(x); } }; await handleRidePageRoute(req, res, deps, new URL(`http://x${path}`)); return res; };
  await post('/ride-page/trip-route/cancel', {});
  r.redis.store.set(`ride:${t.ride.id}:route-cancelled`, String(Date.now() - 10_000)); // a new try more than 5 s after the cancel
  const q = await post('/ride-page/trip-route/quote', { stops: [SURULERE] });
  const short = await post('/ride-page/trip-route', { stops: [SURULERE], acceptedFareNgn: q.body.fareNgn });
  assert.equal(short.statusCode, 402);
  assert.equal(short.body.code, 'WALLET_SHORT');
  assert.equal(short.body.sendNgn, depositNeededFor(short.body.neededNgn));
});

test('a cancel landing while a deposit has the change out is not undone when the change is put back', async () => {
  const { t, r, fare, stops } = await shortTrip();
  const deps = gwDeps(r);
  // The deposit takes the change, finds the hold still short... and the rider cancels in that gap.
  const realSend = r.redis.send.bind(r.redis);
  let cancelled;
  r.redis.send = async (cmd, ...a) => {
    if (cmd === 'EVAL' && cancelled === undefined) {
      cancelled = await handleRideMessage('ride:route:pending:cancel', { rideId: t.ride.id }, riderAuth(t), r.publisher, planner, r.redis);
    }
    return realSend(cmd, ...a);
  };
  // balance stays short, so the deposit apply puts the change back
  assert.equal(await applyPendingRouteOnDeposit(deps, t.rider), false);
  assert.equal(cancelled.payload.cancelled, false, 'it was out with the deposit, so the cancel found nothing to withdraw');
  r.redis.send = realSend;
  assert.equal(await (async () => { const raw = await r.redis.get(`ride:${t.ride.id}:route-pending`); return raw; })(), null, 'not waiting again after the rider backed out');
  await prisma.wallet.update({ where: { userId: t.rider }, data: { balanceNgn: { increment: 9000 } } });
  assert.equal(await applyPendingRouteOnDeposit(deps, t.rider), false);
  assert.equal(r.events.length, 0);
  // A fresh WALLET_SHORT for a change clears the marker and waits again.
  await prisma.wallet.update({ where: { userId: t.rider }, data: { balanceNgn: 100 } });
  r.redis.store.set(`ride:${t.ride.id}:route-cancelled`, String(Date.now() - 10_000)); // more than 5 s after the cancel
  const again = await update(r, t, VI, stops, fare);
  assert.equal(again.payload.reason, 'WALLET_SHORT');
  assert.ok(await r.redis.get(`ride:${t.ride.id}:route-pending`));
});

test('page: /trip-route/cancel answers cancelled true/false, and a CANCELLED rejection is 409 ROUTE_CANCELLED', async () => {
  const { t, r, fare } = await shortTrip();
  const deps = { jwtSecret: JWT_SECRET, redisClient: r.redis, paymentsClient: {}, googleMapsApiKey: 'k', routePlanner: planner, publisher: r.publisher, notifyChat: async () => {} };
  const bearer = local.createWalletPageToken(t.rider, 'ride', JWT_SECRET, local.RIDE_PAGE_TOKEN_TTL_SECONDS);
  const post = async (path, body) => { const raw = [Buffer.from(JSON.stringify(body))]; const req = { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { for (const c of raw) yield c; } }; const res = { statusCode: 200, body: null, setHeader() {}, writeHead(c) { this.statusCode = c; return this; }, end(x) { this.body = JSON.parse(x); } }; await handleRidePageRoute(req, res, deps, new URL(`http://x${path}`)); return res; };
  const first = await post('/ride-page/trip-route/cancel', {});
  assert.deepEqual(first.body, { ok: true, cancelled: true });
  const second = await post('/ride-page/trip-route/cancel', {});
  assert.deepEqual(second.body, { ok: true, cancelled: false });
  // A short retry whose change was cancelled in the gap: 409 ROUTE_CANCELLED, not "price is now NaN".
  const q = await post('/ride-page/trip-route/quote', { stops: [SURULERE] });
  await post('/ride-page/trip-route', { stops: [SURULERE], acceptedFareNgn: q.body.fareNgn }); // short: waiting again
  const realSend = r.redis.send.bind(r.redis);
  r.redis.send = async (cmd, ...a) => { if (cmd === 'EVAL') { r.redis.store.set(`ride:${t.ride.id}:route-cancelled`, '1'); } return realSend(cmd, ...a); };
  const retry = await post('/ride-page/trip-route', { stops: [SURULERE], acceptedFareNgn: fare });
  assert.equal(retry.statusCode, 409);
  assert.equal(retry.body.code, 'ROUTE_CANCELLED');
  assert.equal(retry.body.error, 'Route not changed');
});
