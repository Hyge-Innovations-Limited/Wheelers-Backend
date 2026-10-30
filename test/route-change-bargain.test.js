// Route change at the ride's NEGOTIATED rate (flag on): bargain rate, stale re-price, hold race, driven km, caps.
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
const { setStopFixedPriceEnabled } = require('../apps/api-gateway/dist/rides/trip-route-quote.js');
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
      if (cmd === 'INCR') { const n = Number(store.get(`n:${key}`) ?? 0) + 1; store.set(`n:${key}`, String(n)); return n; }
      if (cmd === 'TTL') return -1;
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
    agreedFareNgn: opts.agreed ?? 5200, fareEstimateNgn: opts.agreed ?? 5200, riderOfferNgn: opts.agreed ?? 5200, bookingSuggestedFareNgn: opts.suggested ?? null, pricedPlannedKm: opts.plannedKm === undefined ? P : opts.plannedKm, bargainRate: opts.suggested ? (opts.agreed ?? 5200) / opts.suggested : null, paymentMethod: opts.method ?? 'WALLET',
    plannedDistanceKm: opts.plannedKm === undefined ? P : opts.plannedKm,
    pickupLat: YABA.lat, pickupLng: YABA.lng, pickupAddress: YABA.address, destLat: (opts.destAt ?? VI).lat, destLng: (opts.destAt ?? VI).lng, destAddress: (opts.destAt ?? VI).address,
  } });
  made.rides.push(ride.id);
  const mid = opts.middleStop ? along(0.3) : null;
  await prisma.rideStop.createMany({ data: [
    ...(mid ? [{ rideId: ride.id, stopOrder: 0, type: 'INTERMEDIATE', status: 'PENDING', lat: mid.lat, lng: mid.lng, address: mid.address }] : []),
    { rideId: ride.id, stopOrder: mid ? 1 : 0, type: 'FINAL', status: 'PENDING', lat: (opts.destAt ?? VI).lat, lng: (opts.destAt ?? VI).lng, address: (opts.destAt ?? VI).address },
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
    await db.walletClient.createRideHold({ rideId: ride.id, walletId: wallet.id, riderId: rider, driverUserId: driverUser, amountNgn: calculateRideFees(opts.agreed ?? 5200).totalNgn });
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


const cut = (s) => s;
const near = (p, m = 1) => ({ ...p, lat: p.lat + m * 0.000009 }); // ~m metres north

test('the negotiated rate survives a 1 m move: before pickup a counter-offer ride keeps its discount', async () => {
  const S = farePerKm(P);
  const A = Math.round(S * 0.8); // the driver's counter, 20% under our suggestion
  const t = await trip({ status: 'DRIVER_EN_ROUTE', agreed: A, suggested: S, plannedKm: P });
  const r = rig();
  const q = await quote(r, t, near(VI, 1), []);
  assert.ok(Math.abs(q.payload.fareNgn - A) <= 2, `1 m move: ${q.payload.fareNgn} vs ${A}`);
  const withStop = await quote(r, t, VI, [SURULERE]);
  assert.equal(withStop.payload.fareNgn, Math.round(farePerKm(pathKm([YABA, SURULERE, VI])) * (A / S)), 'a stop is priced at the ride\'s own rate');
  assert.ok(withStop.payload.fareNgn < farePerKm(pathKm([YABA, SURULERE, VI])), 'not at our full price');
});

test('in progress, a counter-offer ride: driven share of the agreed fare + the rest at the rate', async () => {
  const S = farePerKm(P);
  const A = Math.round(S * 0.8);
  const t = await trip({ drivenFraction: 0.5, agreed: A, suggested: S, plannedKm: P });
  const r = rig();
  const driven = P - pathKm([t.car, VI]);
  const expected = Math.round(A * driven / P) + Math.round(farePerKm(pathKm([t.car, SURULERE, VI])) * (A / S));
  assert.equal((await quote(r, t, VI, [SURULERE])).payload.fareNgn, expected);
});

test('drivenKm is plannedKm minus the road left: GPS jitter does not inflate it', async () => {
  const S = farePerKm(P);
  const t = await trip({ drivenFraction: 0.5, agreed: 5200, suggested: 5200, plannedKm: P });
  // A wild GPS trail (a ping 20 km away between every real one) since the trip started.
  const T0 = Date.now() - 590_000;
  const wild = [0, 0.1, 0.2, 0.3, 0.4, 0.5].flatMap((f, i) => [{ lat: along(f).lat, lng: along(f).lng }, { lat: 6.7, lng: 3.6 }].map((q, j) => ({ rideId: t.ride.id, lat: q.lat, lng: q.lng, timestamp: new Date(T0 + (i * 2 + j) * 1000) })));
  await prisma.gpsLog.createMany({ data: wild });
  const r = rig();
  const expected = Math.round(5200 * (P - pathKm([t.car, VI])) / P) + farePerKm(pathKm([t.car, SURULERE, VI]));
  assert.equal((await quote(r, t, VI, [SURULERE])).payload.fareNgn, expected);
});

test('a stale waiting change is priced again on the deposit: a new price is not published, the rider is told PRICE_CHANGED', async () => {
  for (const how of ['car', 'time']) {
    const t = await trip({ drivenFraction: 0.5, afterHold: 100, plannedKm: P });
    const r = rig();
    const fare = (await quote(r, t, VI, [SURULERE])).payload.fareNgn;
    assert.equal((await update(r, t, VI, [SURULERE], fare)).payload.reason, 'WALLET_SHORT');
    const key = `ride:${t.ride.id}:route-pending`;
    if (how === 'car') await prisma.driver.update({ where: { id: t.driver.id }, data: { lat: along(0.6).lat, lng: along(0.6).lng } }); // ~1 km on
    else r.redis.store.set(key, JSON.stringify({ ...JSON.parse(r.redis.store.get(key)), pricedAt: new Date(Date.now() - 3 * 60_000).toISOString() }));
    await prisma.wallet.update({ where: { userId: t.rider }, data: { balanceNgn: { increment: 9000 } } });
    const sent = [];
    const applied = await applyPendingRouteOnDeposit({ redisClient: r.redis, registry: { sendToUser: async (u, type, p) => { sent.push({ type, p }); } }, publisher: r.publisher, routePlanner: planner }, t.rider);
    if (how === 'car') {
      assert.equal(applied, false, how);
      assert.equal(r.events.length, 0, 'nothing published');
      const msg = sent.find((m) => m.type === 'ride:route:update:rejected');
      assert.equal(msg.p.reason, 'PRICE_CHANGED');
      assert.notEqual(msg.p.fareNgn, fare);
    } else {
      // Same car, same price: re-priced, equal, so it goes ahead.
      assert.equal(applied, true, how);
      assert.equal(r.events.length, 1);
      assert.equal(r.events[0].acceptedFareNgn, fare);
    }
  }
});

test('a retry of a waiting change older than 2 minutes is priced again', async () => {
  const t = await trip({ drivenFraction: 0.5, afterHold: 100, plannedKm: P });
  const r = rig();
  const fare = (await quote(r, t, VI, [SURULERE])).payload.fareNgn;
  await update(r, t, VI, [SURULERE], fare);
  await prisma.driver.update({ where: { id: t.driver.id }, data: { lat: along(0.6).lat, lng: along(0.6).lng } });
  await prisma.wallet.update({ where: { userId: t.rider }, data: { balanceNgn: { increment: 9000 } } });
  const again = await update(r, t, VI, [SURULERE], fare);
  assert.equal(again.type, 'ride:route:update:rejected');
  assert.equal(again.payload.reason, 'PRICE_CHANGED');
  assert.equal(r.events.length, 0);
});

test('a retry that loses to a deposit says inProgress, not alreadyApplied, unless the ride has moved', async () => {
  const t = await trip({ drivenFraction: 0.5, afterHold: 100, plannedKm: P });
  const r = rig();
  const fare = (await quote(r, t, VI, [SURULERE])).payload.fareNgn;
  await update(r, t, VI, [SURULERE], fare);
  await prisma.wallet.update({ where: { userId: t.rider }, data: { balanceNgn: { increment: 9000 } } });
  const realSend = r.redis.send.bind(r.redis);
  r.redis.send = async (cmd, ...a) => { if (cmd === 'GETDEL') { await realSend(cmd, ...a); return null; } return realSend(cmd, ...a); }; // the deposit took it
  const lost = await update(r, t, VI, [SURULERE], fare);
  assert.equal(lost.type, 'ride:route:update:accepted');
  assert.equal(lost.payload.inProgress, true);
  assert.equal(lost.payload.alreadyApplied, undefined);
});

test('hold race: a raise and a withdrawal at the same moment never make a negative balance or a charged-hold write', async () => {
  for (let i = 0; i < 6; i += 1) {
    const t = await trip({ afterHold: 0 });
    const hold0 = calculateRideFees(5200).totalNgn;
    const extra = 1000;
    await prisma.wallet.update({ where: { userId: t.rider }, data: { balanceNgn: extra } }); // exactly enough for ONE of them
    const raise = db.walletClient.adjustRideHold({ rideId: t.ride.id, targetAmountNgn: hold0 + extra });
    const withdraw = prisma.$transaction((tx) => db.takeFromBalance(tx, t.walletId, extra));
    const [a, b] = await Promise.allSettled([raise, withdraw]);
    const w = await prisma.wallet.findUniqueOrThrow({ where: { userId: t.rider } });
    assert.ok(Number(w.balanceNgn) >= 0, 'balance never negative');
    const hold = Number((await prisma.rideHold.findUniqueOrThrow({ where: { rideId: t.ride.id } })).amountNgn);
    assert.equal(Number(w.lockedNgn), hold, 'locked money equals the hold');
    const raised = a.status === 'fulfilled' && a.value?.applied;
    const took = b.status === 'fulfilled' && b.value;
    assert.ok(!(raised && took), 'both cannot win');
    if (raised) assert.equal(hold, hold0 + extra); else assert.equal(hold, hold0);
  }
});

test('adjustRideHold writes nothing to a charged hold', async () => {
  const t = await trip();
  await prisma.rideHold.update({ where: { rideId: t.ride.id }, data: { status: 'CHARGED' } });
  const before = await prisma.wallet.findUniqueOrThrow({ where: { userId: t.rider } });
  const res = await db.walletClient.adjustRideHold({ rideId: t.ride.id, targetAmountNgn: 9999 });
  assert.equal(res.applied, false);
  const after = await prisma.wallet.findUniqueOrThrow({ where: { userId: t.rider } });
  assert.equal(Number(after.balanceNgn), Number(before.balanceNgn));
  assert.equal(Number(after.lockedNgn), Number(before.lockedNgn));
});

test('caps: more than 5 stops, or an address over 200 characters, is refused (quote and update)', async () => {
  const t = await trip({ drivenFraction: 0.5, plannedKm: P });
  const r = rig();
  const six = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6].map((f) => along(f));
  await assert.rejects(() => quote(r, t, VI, six), /at most 5 stops/);
  await assert.rejects(() => update(r, t, VI, six, 1000), /at most 5 stops/);
  const long = { ...SURULERE, address: 'x'.repeat(201) };
  await assert.rejects(() => quote(r, t, VI, [long]), /address is too long/);
  await assert.rejects(() => update(r, t, VI, [long], 1000), /address is too long/);
  assert.equal(r.events.length, 0);
});

test('a redelivered change that is already made is done: no reverted snapshot', async () => {
  const t = await trip({ drivenFraction: 0.5, plannedKm: P });
  const r = rig();
  const fare = (await quote(r, t, VI, [SURULERE])).payload.fareNgn;
  await update(r, t, VI, [SURULERE], fare);
  await deliver(r, t);
  const n = r.out.length;
  const requested = r.events.filter((e) => e.eventType === 'RIDE_ROUTE_UPDATE_REQUESTED').pop();
  await r.rideService.handleRideEvent(requested, ctx);
  assert.equal(r.out.slice(n).filter((o) => o.e.reverted).length, 0);
  const again = r.out.slice(n).filter((o) => o.n === 'rideRouteUpdated');
  assert.equal(again.length, 1, 'the update is sent again, in case the first delivery died before publishing');
  assert.equal(again[0].e.agreedFareNgn, fare);
  assert.equal(Number((await rideRow(t)).agreedFareNgn), fare);
});

/** Same geometry, our price scaled: a way to make the re-price differ by a known amount. */
const scaled = (f) => ({ async planRoute(a) { const r = await planner.planRoute(a); return { ...r, suggestedFareNgn: r.distanceKm * 420 * f }; } });

test('tolerance: a stale price re-priced within max(50, 2%) of the accepted one stands; beyond it is PRICE_CHANGED', async () => {
  for (const [offset, passes] of [[-12, true], [12, true], [-1, false], [1, false]]) {
    const t = await trip({ drivenFraction: 0.5, plannedKm: P });
    const r = rig();
    const shown = (await quote(r, t, VI, [SURULERE])).payload.fareNgn;
    const tol = Math.max(50, 0.02 * shown);
    const rest = farePerKm(pathKm([t.car, SURULERE, VI]));
    const diff = Math.sign(offset) === 1 ? Math.round(tol) + (passes ? -offset : offset) : -(Math.round(tol) + (passes ? offset : -offset)); // just inside / just outside
    const f = 1 + diff / rest;
    // The price the rider saw goes old (3 minutes), and our price has since moved by `diff`.
    const key = `ride:${t.ride.id}:route-quote`;
    const kept = JSON.parse(r.redis.store.get(key));
    r.redis.store.set(key, JSON.stringify({ ...kept, base: { ...kept.base, pricedAt: new Date(Date.now() - 3 * 60_000).toISOString() } }));
    const reply = await handleRideMessage('ride:route:update', { rideId: t.ride.id, destination: VI, stops: [SURULERE], acceptedFareNgn: shown }, riderAuth(t), r.publisher, scaled(f), r.redis);
    if (passes) {
      assert.equal(reply.type, 'ride:route:update:accepted', `diff ${diff}`);
      assert.equal(r.events[0].acceptedFareNgn, shown, 'proceeds at the ACCEPTED price');
    } else {
      assert.equal(reply.type, 'ride:route:update:rejected', `diff ${diff}`);
      assert.equal(reply.payload.reason, 'PRICE_CHANGED');
      assert.equal(r.events.length, 0);
    }
  }
});

test('tolerance on a forged price: a fare the rider was never shown gets no tolerance', async () => {
  const t = await trip({ drivenFraction: 0.5, plannedKm: P });
  const r = rig();
  const shown = (await quote(r, t, VI, [SURULERE])).payload.fareNgn;
  const reply = await update(r, t, VI, [SURULERE], shown - 20);
  assert.equal(reply.type, 'ride:route:update:rejected');
});

// ── Round 5: the rate is fixed at the match, unpriced changes keep the driven km, caps on who may change what ──
const counterTrip = (o = {}) => { const S = farePerKm(P); return trip({ agreed: Math.round(S * 0.8), suggested: S, plannedKm: P, ...o }); };
const rateOf = () => Math.round(farePerKm(P) * 0.8) / farePerKm(P);

test('N1: a change to a place near the pickup and back returns the original fare (the rate does not drift)', async () => {
  const t = await counterTrip({ status: 'DRIVER_EN_ROUTE' });
  const A = Number((await rideRow(t)).agreedFareNgn);
  const r = rig();
  const x = along(0.1);
  const q1 = (await quote(r, t, x, [])).payload.fareNgn;
  assert.ok(q1 < A);
  assert.equal((await update(r, t, x, [], q1)).type, 'ride:route:update:accepted');
  await deliver(r, t);
  assert.equal(Number((await rideRow(t)).agreedFareNgn), q1);
  const back = (await quote(r, t, VI, [])).payload.fareNgn;
  assert.equal(back, A, 'back to B: the original fare');
});

test('N1: an added stop then removed returns the original fare; two changes in a row keep the 0.80 rate', async () => {
  const t = await counterTrip({ status: 'DRIVER_EN_ROUTE' });
  const A = Number((await rideRow(t)).agreedFareNgn);
  const r = rig();
  const mid = along(0.5);
  const f1 = (await quote(r, t, VI, [SURULERE])).payload.fareNgn;
  assert.equal(f1, Math.round(farePerKm(pathKm([YABA, SURULERE, VI])) * rateOf()));
  await update(r, t, VI, [SURULERE], f1); await deliver(r, t);
  const f2 = (await quote(r, t, VI, [SURULERE, mid])).payload.fareNgn;
  assert.equal(f2, Math.round(farePerKm(pathKm([YABA, SURULERE, mid, VI])) * rateOf()), 'the second change is still at 0.80');
  await update(r, t, VI, [SURULERE, mid], f2); await deliver(r, t);
  const f3 = (await quote(r, t, VI, [])).payload.fareNgn;
  assert.equal(f3, A, 'both stops removed: the original fare');
});

test('B1/R4: the rate is written when the driver is matched and kept by a re-match; null when there is no booking fare', async () => {
  const t = await trip({ status: 'MATCHING', agreed: 4000, suggested: 5000 });
  await prisma.ride.update({ where: { id: t.ride.id }, data: { driverId: null, bargainRate: null } });
  await db.rideClient.assignDriver(t.ride.id, t.driver.id, { agreedFareNgn: 4000 });
  assert.equal((await rideRow(t)).bargainRate, 0.8);
  await prisma.ride.update({ where: { id: t.ride.id }, data: { status: 'MATCHING', driverId: null } });
  await db.rideClient.assignDriver(t.ride.id, t.driver.id, { agreedFareNgn: 4500 });
  assert.equal((await rideRow(t)).bargainRate, 0.8, 're-match (a driver bailed): the ride keeps its first rate');
  await prisma.ride.update({ where: { id: t.ride.id }, data: { status: 'MATCHING', driverId: null, bookingSuggestedFareNgn: null } });
  await db.rideClient.assignDriver(t.ride.id, t.driver.id, { agreedFareNgn: 4500 });
  assert.equal((await rideRow(t)).bargainRate, 0.8, 'a missing booking fare never writes null over a rate');
  const none = await trip({ status: 'MATCHING' });
  await prisma.ride.update({ where: { id: none.ride.id }, data: { driverId: null } });
  await db.rideClient.assignDriver(none.ride.id, none.driver.id, { agreedFareNgn: 4000 });
  assert.equal((await rideRow(none)).bargainRate, null);
});

test('N2: an unpriced change keeps the driven km; a priced change back to B then charges the driven share', async () => {
  const t = await trip({ drivenFraction: 0.5, plannedKm: P });
  const r = rig();
  const c = along(0.7); // nearer than B: not longer, so an old app may do it
  const remOld = pathKm([t.car, VI]);
  const remNew = pathKm([t.car, c]);
  const reply = await handleRideMessage('ride:route:update', { rideId: t.ride.id, destination: c, stops: [] }, riderAuth(t), r.publisher, planner, r.redis);
  assert.equal(reply.type, 'ride:route:update:accepted');
  await deliver(r, t);
  const row = await rideRow(t);
  assert.equal(Number(row.agreedFareNgn), 5200, 'the fare and the hold stay');
  assert.ok(Math.abs(row.plannedDistanceKm - (P + remNew - remOld)) < 1e-6, 'the planned km moved with the road, so the driven km is kept');
  const back = (await quote(r, t, VI, [])).payload.fareNgn;
  const expected = Math.round(5200 * (row.plannedDistanceKm - remNew) / row.plannedDistanceKm) + farePerKm(pathKm([t.car, VI]));
  assert.equal(back, expected);
  assert.ok(back > farePerKm(pathKm([t.car, VI])) + 1000, 'the driven share is still in the fare');
});

test('N3: an unpriced rider change that makes the road longer is refused; one that does not is allowed', async () => {
  const t = await trip({ drivenFraction: 0.5, plannedKm: P });
  const r = rig();
  const go = (dest, stops) => handleRideMessage('ride:route:update', { rideId: t.ride.id, destination: dest, stops }, riderAuth(t), r.publisher, planner, r.redis);
  await assert.rejects(go(VI, [SURULERE]), /Update the app to add stops/);
  assert.equal(r.events.length, 0);
  assert.equal((await go(VI, [])).type, 'ride:route:update:accepted'); // same road: allowed
  assert.equal((await go(along(0.8), [])).type, 'ride:route:update:accepted'); // shorter: allowed
});

test('M-a: updates share the quotes\' 10-a-minute limit', async () => {
  const t = await trip({ drivenFraction: 0.5, plannedKm: P });
  const r = rig();
  let refused = 0;
  for (let i = 0; i < 6; i += 1) await quote(r, t, VI, [SURULERE]).catch(() => {});
  for (let i = 0; i < 6; i += 1) await handleRideMessage('ride:route:update', { rideId: t.ride.id, destination: along(0.8), stops: [] }, riderAuth(t), r.publisher, planner, r.redis).catch((e) => { if (/Too many/.test(e.message)) refused += 1; });
  assert.equal(refused, 2);
});

test('M-b: no price is made from a car not seen for a minute, or one far from its last GPS point', async () => {
  const t = await trip({ drivenFraction: 0.5, plannedKm: P });
  const r = rig();
  await prisma.driver.update({ where: { id: t.driver.id }, data: { lastSeenAt: new Date(Date.now() - 2 * 60_000) } });
  await assert.rejects(() => quote(r, t, VI, [SURULERE]), /cannot see the car/);
  await prisma.driver.update({ where: { id: t.driver.id }, data: { lastSeenAt: new Date() } });
  await prisma.gpsLog.create({ data: { rideId: t.ride.id, lat: 6.6018, lng: 3.3515, timestamp: new Date() } }); // 11 km away, just now
  await assert.rejects(() => quote(r, t, VI, [SURULERE]), /cannot place the car/);
});

test('M-c: a retry that is put back respects the cancel marker and never deletes it', async () => {
  const t = await trip({ drivenFraction: 0.5, afterHold: 100, plannedKm: P });
  const r = rig();
  const fare = (await quote(r, t, VI, [SURULERE])).payload.fareNgn;
  assert.equal((await update(r, t, VI, [SURULERE], fare)).payload.reason, 'WALLET_SHORT');
  const pk = `ride:${t.ride.id}:route-pending`;
  r.redis.store.set(pk, JSON.stringify({ ...JSON.parse(r.redis.store.get(pk)), pricedAt: new Date(Date.now() - 3 * 60_000).toISOString() })); // stale: priced again
  const marker = `ride:${t.ride.id}:route-cancelled`;
  r.redis.store.set(marker, '1'); // the rider backed out in the meantime
  const again = await update(r, t, VI, [SURULERE], fare);
  assert.equal(again.payload.reason, 'CANCELLED');
  assert.equal(r.redis.store.get(marker), '1', 'the marker is still there');
  assert.equal(r.redis.store.has(pk), false, 'nothing is waiting');
});

test('LOW: a wallet ride with no active hold does not get its route changed unfunded', async () => {
  const t = await trip({ drivenFraction: 0.5, plannedKm: P });
  const r = rig();
  const fare = (await quote(r, t, VI, [SURULERE])).payload.fareNgn;
  await prisma.rideHold.update({ where: { rideId: t.ride.id }, data: { status: 'RELEASED' } });
  await assert.rejects(() => update(r, t, VI, [SURULERE], fare), /No money is held/);
  assert.equal(r.events.length, 0);
});

test('N4: no priced route change on an XLM ride', async () => {
  const t = await trip({ drivenFraction: 0.5, plannedKm: P, method: 'XLM' });
  const r = rig();
  await assert.rejects(() => update(r, t, VI, [SURULERE], 5000), /not available for this payment/);
  assert.equal(r.events.length, 0);
});

test('N1: an undo of a hold only happens if the hold is still what it was set to', async () => {
  const t = await trip();
  const hold0 = calculateRideFees(5200).totalNgn;
  const res = await db.walletClient.adjustRideHold({ rideId: t.ride.id, targetAmountNgn: hold0 - 100, expectedAmountNgn: hold0 + 500 });
  assert.equal(res.applied, false);
  assert.equal(Number((await prisma.rideHold.findUniqueOrThrow({ where: { rideId: t.ride.id } })).amountNgn), hold0);
  const ok = await db.walletClient.adjustRideHold({ rideId: t.ride.id, targetAmountNgn: hold0 - 100, expectedAmountNgn: hold0 });
  assert.equal(ok.applied, true);
});

test('R1: a priced change and an unpriced one racing: the unpriced one is refused, the fare stays at the priced change\'s', async () => {
  const t = await counterTrip({ status: 'DRIVER_EN_ROUTE' });
  const r = rig();
  const C = along(0.5);
  const fareC = (await quote(r, t, C, [])).payload.fareNgn;
  assert.equal((await update(r, t, C, [], fareC)).type, 'ride:route:update:accepted'); // priced C, published
  // The old app, still looking at the route as it was, sends "back to B" in the same tick.
  const old = await handleRideMessage('ride:route:update', { rideId: t.ride.id, destination: VI, stops: [] }, riderAuth(t), r.publisher, planner, r.redis);
  assert.equal(old.type, 'ride:route:update:accepted');
  const [priced, unpriced] = r.events.filter((e) => e.eventType === 'RIDE_ROUTE_UPDATE_REQUESTED');
  assert.equal(priced.acceptedFareNgn, fareC);
  assert.equal(unpriced.acceptedFareNgn, undefined);
  await r.rideService.handleRideEvent(priced, ctx);
  await r.rideService.handleRideEvent(unpriced, ctx);
  const row = await rideRow(t);
  assert.equal(Number(row.agreedFareNgn), fareC, 'the fare stays at C\'s');
  const finalStop = await prisma.rideStop.findFirst({ where: { rideId: t.ride.id, type: 'FINAL' } });
  assert.equal(finalStop.lat, C.lat, 'the route stays at C');
  assert.ok(r.out.some((o) => o.n === 'rideRouteUpdated' && o.e.reverted), 'the rider is shown the real route');
});

test('R2: small unpriced stretches cannot stack: the second +0.45 km change is refused', async () => {
  const dest0 = along(0.2);
  const t = await counterTrip({ status: 'DRIVER_EN_ROUTE', destAt: dest0, plannedKm: pathKm([YABA, dest0]) });
  const r = rig();
  let accepted = 0;
  for (let k = 1; k <= 4; k += 1) {
    const dest = along(0.2 + (k * 0.45) / P);
    const go = await handleRideMessage('ride:route:update', { rideId: t.ride.id, destination: dest, stops: [] }, riderAuth(t), r.publisher, planner, r.redis).catch((e) => { assert.match(e.message, /Update the app to add stops/); return null; });
    if (!go) continue;
    accepted += 1;
    await r.rideService.handleRideEvent(r.events.filter((e) => e.eventType === 'RIDE_ROUTE_UPDATE_REQUESTED').pop(), ctx);
  }
  assert.equal(accepted, 1, 'only the first small stretch gets through');
  const row = await rideRow(t);
  assert.ok(row.plannedDistanceKm <= row.pricedPlannedKm + 0.5 + 1e-6);
});

// ── The ride page answers refusals with their own words ──
function pageCall(t, r) {
  const deps = { jwtSecret: JWT_SECRET, redisClient: r.redis, paymentsClient: {}, googleMapsApiKey: 'k', routePlanner: planner, publisher: r.publisher, notifyChat: async () => {} };
  return async (path, body) => {
    const bearer = local.createWalletPageToken(t.rider, 'ride', JWT_SECRET, local.RIDE_PAGE_TOKEN_TTL_SECONDS);
    const raw = [Buffer.from(JSON.stringify(body))];
    const req = { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { for (const c of raw) yield c; } };
    const res = { statusCode: 200, body: null, setHeader() {}, writeHead(c) { this.statusCode = c; return this; }, end(x) { this.body = x ? JSON.parse(x) : null; } };
    await handleRidePageRoute(req, res, deps, new URL(`http://x${path}`));
    return res;
  };
}

test('S-a: the page answers a refused quote or change with 409 and the refusal\'s own words, 429 for the rate limit', async () => {
  const t = await trip({ drivenFraction: 0.5, plannedKm: P });
  const r = rig();
  const call = pageCall(t, r);
  // A car not seen for 2 minutes.
  await prisma.driver.update({ where: { id: t.driver.id }, data: { lastSeenAt: new Date(Date.now() - 2 * 60_000) } });
  const q = await call('/ride-page/trip-route/quote', { stops: [SURULERE] });
  assert.equal(q.statusCode, 409);
  assert.equal(q.body.code, 'ROUTE_CHANGE_REFUSED');
  assert.match(q.body.error ?? q.body.message, /cannot see the car/);
  const u = await call('/ride-page/trip-route', { stops: [SURULERE], acceptedFareNgn: 1000 });
  assert.equal(u.statusCode, 409);
  assert.match(u.body.error ?? u.body.message, /cannot see the car/);
  await prisma.driver.update({ where: { id: t.driver.id }, data: { lastSeenAt: new Date() } });
  // The route the trip already has.
  const same = await call('/ride-page/trip-route', { stops: [], acceptedFareNgn: 1000 });
  assert.equal(same.statusCode, 409);
  assert.match(same.body.error ?? same.body.message, /route you already have/);
  // No money held.
  await prisma.rideHold.update({ where: { rideId: t.ride.id }, data: { status: 'RELEASED' } });
  const fare = (await call('/ride-page/trip-route/quote', { stops: [SURULERE] })).body.fareNgn;
  const nohold = await call('/ride-page/trip-route', { stops: [SURULERE], acceptedFareNgn: fare });
  assert.equal(nohold.statusCode, 409);
  assert.match(nohold.body.error ?? nohold.body.message, /No money is held/);
  // The rate limit (shared 10 a minute): 429.
  let last;
  for (let i = 0; i < 12; i += 1) last = await call('/ride-page/trip-route', { stops: [SURULERE], acceptedFareNgn: 1000 });
  assert.equal(last.statusCode, 429, 'never a 500 (the page\'s own limiter or the shared one)');
});

test('S-b: a new save does not undo a cancel made in the last 5 seconds; an older cancel does not block it', async () => {
  const t = await trip({ drivenFraction: 0.5, afterHold: 100, plannedKm: P });
  const r = rig();
  const fare = (await quote(r, t, VI, [SURULERE])).payload.fareNgn;
  assert.equal((await update(r, t, VI, [SURULERE], fare)).payload.reason, 'WALLET_SHORT');
  await handleRideMessage('ride:route:pending:cancel', { rideId: t.ride.id }, riderAuth(t), r.publisher, planner, r.redis);
  const again = await update(r, t, VI, [SURULERE], fare); // the second tap of a double tap, right after the cancel
  assert.equal(again.payload.reason, 'CANCELLED');
  r.redis.store.set(`ride:${t.ride.id}:route-cancelled`, String(Date.now() - 10_000)); // a cancel from 10 s ago
  const later = await update(r, t, VI, [SURULERE], fare);
  assert.equal(later.payload.reason, 'WALLET_SHORT');
});

test('S-c: a deposit that cannot fund the taken change tells the rider it was dropped', async () => {
  const t = await trip({ drivenFraction: 0.5, afterHold: 100, plannedKm: P });
  const r = rig();
  const fare = (await quote(r, t, VI, [SURULERE])).payload.fareNgn;
  assert.equal((await update(r, t, VI, [SURULERE], fare)).payload.reason, 'WALLET_SHORT');
  await prisma.rideHold.update({ where: { rideId: t.ride.id }, data: { status: 'RELEASED' } });
  await prisma.wallet.update({ where: { userId: t.rider }, data: { balanceNgn: { increment: 9000 } } });
  const sent = [];
  await assert.rejects(applyPendingRouteOnDeposit({ redisClient: r.redis, registry: { sendToUser: async (u, type, p) => { sent.push({ type, p }); } }, publisher: r.publisher, routePlanner: planner }, t.rider), /No money is held/);
  assert.ok(sent.some((m) => m.type === 'ride:route:update:dropped' && m.p.reason === 'TRIP_CHANGED'));
  assert.equal(r.events.length, 0);
});

test('L1: an unpriced change cannot add a stop even if the road is no longer', async () => {
  const t = await trip({ drivenFraction: 0.5, plannedKm: P });
  const r = rig();
  await assert.rejects(handleRideMessage('ride:route:update', { rideId: t.ride.id, destination: VI, stops: [along(0.7)] }, riderAuth(t), r.publisher, planner, r.redis), /Update the app to add stops/);
  assert.equal(r.events.length, 0);
});

test('L2: during the trip an unpriced change is refused when the car\'s position is unknown', async () => {
  const t = await trip({ drivenFraction: 0.5, plannedKm: P });
  const r = rig();
  await prisma.driver.update({ where: { id: t.driver.id }, data: { lat: null, lng: null } });
  await assert.rejects(handleRideMessage('ride:route:update', { rideId: t.ride.id, destination: along(0.8), stops: [] }, riderAuth(t), r.publisher, planner, r.redis), /cannot see the car/);
  assert.equal(r.events.length, 0);
});

test('L3: an unpriced change delivered again after it was made is done: no reverted snapshot', async () => {
  const t = await trip({ drivenFraction: 0.5, plannedKm: P });
  const r = rig();
  await handleRideMessage('ride:route:update', { rideId: t.ride.id, destination: along(0.8), stops: [] }, riderAuth(t), r.publisher, planner, r.redis);
  const requested = r.events.filter((e) => e.eventType === 'RIDE_ROUTE_UPDATE_REQUESTED').pop();
  await r.rideService.handleRideEvent(requested, ctx);
  const n = r.out.length;
  await r.rideService.handleRideEvent(requested, ctx);
  const again = r.out.slice(n).filter((o) => o.n === 'rideRouteUpdated');
  assert.equal(again.length, 1);
  assert.ok(!again[0].e.reverted);
  assert.equal(Number((await rideRow(t)).agreedFareNgn), 5200);
});
