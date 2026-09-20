// The admin live map, off-shift "nearby ride alerts", and the dispatch panel,
// against a real Postgres. Push delivery is stubbed; everything else is the
// production code, reached the way production reaches it.
//
//   DATABASE_URL=… node --test --test-force-exit test/live-map.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const local = require('../apps/api-gateway/dist/auth/local.js');
const liveMap = require('../apps/api-gateway/dist/http/live-map.route.js');
const driverRoutes = require('../apps/api-gateway/dist/http/driver.route.js');
const { driverClient, driverLocationClient, shouldRecordPoint } = require('../packages/db/dist/index.js');

const prisma = new PrismaClient();
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const ADMIN_KEY = 'test-admin-key';
const realError = console.error;
const realWarn = console.warn;
const realInfo = console.info;

// Lagos, and a spot ~1.1 km north of it.
const LAGOS = { lat: 6.5244, lng: 3.3792 };
const NEARBY = { lat: 6.5344, lng: 3.3792 };
const ABUJA = { lat: 9.0765, lng: 7.3986 };

async function makeDriver({ status = 'OFFLINE', name = 'Test Driver', phone = '+2348030000000' } = {}) {
  const userId = randomUUID();
  await prisma.user.create({
    data: { id: userId, privyDid: `local:${userId}`, role: 'DRIVER', name, phone },
  });
  const driver = await prisma.driver.create({ data: { userId, status, kycStatus: 'APPROVED' } });
  return { userId, driverId: driver.id, token: local.createLocalAccessToken(userId, JWT_SECRET) };
}

async function makeRide(pickup = LAGOS) {
  const riderId = randomUUID();
  await prisma.user.create({ data: { id: riderId, privyDid: `local:${riderId}`, role: 'RIDER', name: 'Rider' } });
  return prisma.ride.create({
    data: {
      riderId, status: 'MATCHING',
      pickupLat: pickup.lat, pickupLng: pickup.lng, pickupAddress: 'Pickup',
      destLat: pickup.lat + 0.05, destLng: pickup.lng, destAddress: 'Destination',
    },
  });
}

function fakeHttp(method, { token, adminKey, body } = {}) {
  const raw = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(adminKey ? { 'x-admin-key': adminKey } : {}),
    },
    async *[Symbol.asyncIterator]() { for (const chunk of raw) yield chunk; },
  };
  const res = {
    statusCode: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    writeHead(code) { this.statusCode = code; },
    end(text) { this.body = text ? JSON.parse(text) : null; },
  };
  return { req, res };
}

function adminDeps() {
  const pushes = [];
  return {
    pushes,
    deps: {
      adminApiKey: ADMIN_KEY,
      jwtSecret: JWT_SECRET,
      publisher: { publishNotificationEvent: async (event) => { pushes.push(event); } },
    },
  };
}

async function admin(handler, method, { body, args = [], deps = adminDeps().deps, key = ADMIN_KEY } = {}) {
  const { req, res } = fakeHttp(method, { adminKey: key, body });
  await handler(req, res, deps, ...args);
  return { status: res.statusCode, body: res.body };
}

async function asDriver(handler, method, token, body) {
  const { req, res } = fakeHttp(method, { token, body });
  await handler(req, res, { jwtSecret: JWT_SECRET });
  return { status: res.statusCode, body: res.body };
}

test.beforeEach(() => {
  console.error = console.warn = console.info = () => {};
  driverLocationClient.resetThrottle();
});
test.afterEach(() => { console.error = realError; console.warn = realWarn; console.info = realInfo; });
test.after(async () => { await prisma.$disconnect(); });

/* ── history throttle ─────────────────────────────────────────────────── */

test('a trail point needs time AND movement, or a long enough wait', () => {
  const last = { ...LAGOS, at: 1_000_000 };
  assert.equal(shouldRecordPoint(undefined, LAGOS.lat, LAGOS.lng, 0), true, 'first point is always kept');
  assert.equal(shouldRecordPoint(last, NEARBY.lat, NEARBY.lng, last.at + 10_000), false, 'too soon, even after moving');
  assert.equal(shouldRecordPoint(last, LAGOS.lat, LAGOS.lng, last.at + 60_000), false, 'parked: nothing new to say');
  assert.equal(shouldRecordPoint(last, NEARBY.lat, NEARBY.lng, last.at + 31_000), true, 'moved and enough time passed');
  assert.equal(shouldRecordPoint(last, LAGOS.lat, LAGOS.lng, last.at + 5 * 60_000), true, 'parked drivers still get an occasional point');
});

test('heartbeats feed the trail once, not once per ping', async () => {
  const { driverId } = await makeDriver({ status: 'ONLINE' });
  await driverClient.updateLocation(driverId, LAGOS.lat, LAGOS.lng);
  await driverClient.updateLocation(driverId, LAGOS.lat, LAGOS.lng);
  await driverClient.updateLocation(driverId, NEARBY.lat, NEARBY.lng);

  const points = await prisma.driverLocationPoint.findMany({ where: { driverId } });
  assert.equal(points.length, 1, 'three pings inside 30s are one trail point');
  assert.equal(points[0].source, 'online');

  const driver = await prisma.driver.findUnique({ where: { id: driverId } });
  assert.equal(driver.lat, NEARBY.lat, 'the live position still follows every ping');
});

/* ── nearby ride alerts (standby) ─────────────────────────────────────── */

test('an off-shift position is refused until the driver switches alerts on', async () => {
  const { driverId, token } = await makeDriver();

  const refused = await asDriver(driverRoutes.handlePostDriverStandbyLocationRoute, 'POST', token, LAGOS);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'STANDBY_OFF');
  const untouched = await prisma.driver.findUnique({ where: { id: driverId } });
  assert.equal(untouched.standbyLat, null, 'nothing is stored without consent');

  const on = await asDriver(driverRoutes.handleDriverStandbyRoute, 'PUT', token, { enabled: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.enabled, true);
  assert.ok(on.body.consentAt, 'the moment of consent is recorded');

  const accepted = await asDriver(driverRoutes.handlePostDriverStandbyLocationRoute, 'POST', token, LAGOS);
  assert.equal(accepted.status, 200);
});

test('a standby ping never makes an offline driver look available to matching', async () => {
  const { driverId, token } = await makeDriver();
  await asDriver(driverRoutes.handleDriverStandbyRoute, 'PUT', token, { enabled: true });
  await asDriver(driverRoutes.handlePostDriverStandbyLocationRoute, 'POST', token, LAGOS);

  const driver = await prisma.driver.findUnique({ where: { id: driverId } });
  assert.equal(driver.standbyLat, LAGOS.lat);
  assert.equal(driver.lastSeenAt, null, 'lastSeenAt is what matching reads — it must stay untouched');
  assert.equal(driver.lat, null);
  assert.equal(driver.status, 'OFFLINE');

  const [point] = await prisma.driverLocationPoint.findMany({ where: { driverId } });
  assert.equal(point.source, 'standby');
});

test('switching alerts off erases the stored off-shift position', async () => {
  const { driverId, token } = await makeDriver();
  await asDriver(driverRoutes.handleDriverStandbyRoute, 'PUT', token, { enabled: true });
  await asDriver(driverRoutes.handlePostDriverStandbyLocationRoute, 'POST', token, LAGOS);

  const off = await asDriver(driverRoutes.handleDriverStandbyRoute, 'PUT', token, { enabled: false });
  assert.equal(off.body.enabled, false);
  const driver = await prisma.driver.findUnique({ where: { id: driverId } });
  assert.equal(driver.standbyLat, null);
  assert.equal(driver.standbySeenAt, null);

  const state = await asDriver(driverRoutes.handleDriverStandbyRoute, 'GET', token);
  assert.equal(state.body.enabled, false);

  const bad = await asDriver(driverRoutes.handleDriverStandbyRoute, 'PUT', token, { enabled: 'yes' });
  assert.equal(bad.status, 400);
});

/* ── presence ─────────────────────────────────────────────────────────── */

test('one driver, one pin: presence follows shift state and signal age', () => {
  const now = Date.now();
  const ago = (ms) => new Date(now - ms);
  const base = { lat: null, lng: null, lastSeenAt: null, standbyEnabled: false, standbyLat: null, standbyLng: null, standbySeenAt: null };
  const at = (seen) => ({ lat: LAGOS.lat, lng: LAGOS.lng, lastSeenAt: seen });
  const standbyAt = (seen) => ({ standbyEnabled: true, standbyLat: ABUJA.lat, standbyLng: ABUJA.lng, standbySeenAt: seen });
  const presence = (d) => liveMap.resolvePosition({ ...base, ...d }, now)?.presence ?? null;

  assert.equal(presence({ status: 'OFFLINE' }), null, 'never reported a position: no pin');
  assert.equal(presence({ status: 'ONLINE', ...at(ago(20_000)) }), 'online');
  assert.equal(presence({ status: 'ON_RIDE', ...at(ago(20_000)) }), 'on_trip');
  assert.equal(presence({ status: 'ONLINE', ...at(ago(10 * 60_000)) }), 'stale', 'online but silent is a dead signal');
  assert.equal(presence({ status: 'OFFLINE', ...at(ago(3 * 3_600_000)) }), 'offline', 'last known position');
  assert.equal(presence({ status: 'OFFLINE', ...standbyAt(ago(10 * 60_000)) }), 'standby');
  assert.equal(presence({ status: 'OFFLINE', ...standbyAt(ago(2 * 3_600_000)) }), 'offline', 'standby gone quiet');

  const onShift = liveMap.resolvePosition({ ...base, status: 'ONLINE', ...at(ago(5_000)), ...standbyAt(ago(1_000)) }, now);
  assert.equal(onShift.source, 'online', 'on shift, the precise position wins');
  const offShift = liveMap.resolvePosition({ ...base, status: 'OFFLINE', ...at(ago(3_600_000)), ...standbyAt(ago(60_000)) }, now);
  assert.equal(offShift.source, 'standby', 'off shift, the newer fix wins');
  assert.equal(offShift.lat, ABUJA.lat);
});

/* ── admin endpoints ──────────────────────────────────────────────────── */

test('the live map is admin-only and lists each driver once', async () => {
  const online = await makeDriver({ status: 'ONLINE', name: 'Map Online' });
  await driverClient.updateLocation(online.driverId, LAGOS.lat, LAGOS.lng);
  const silent = await makeDriver({ name: 'Never Reported' });

  const denied = await admin(liveMap.handleLiveDriversRoute, 'GET', { key: 'wrong' });
  assert.equal(denied.status, 401);
  const asDriverToken = fakeHttp('GET', { token: online.token });
  await liveMap.handleLiveDriversRoute(asDriverToken.req, asDriverToken.res, adminDeps().deps);
  assert.equal(asDriverToken.res.statusCode, 401, 'a driver login is not an admin login');

  const ok = await admin(liveMap.handleLiveDriversRoute, 'GET');
  assert.equal(ok.status, 200);
  const mine = ok.body.drivers.filter((d) => d.id === online.driverId);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].presence, 'online');
  assert.equal(mine[0].phone, '+2348030000000');
  assert.ok(!ok.body.drivers.some((d) => d.id === silent.driverId), 'no position, no pin');
  assert.equal(ok.body.summary.total, ok.body.drivers.length);
});

test('a trail comes back oldest first and only for the window asked', async () => {
  const { driverId } = await makeDriver({ status: 'ONLINE' });
  const minutesAgo = (m) => new Date(Date.now() - m * 60_000);
  await prisma.driverLocationPoint.createMany({
    data: [
      { driverId, ...LAGOS, recordedAt: minutesAgo(180) },
      { driverId, ...NEARBY, recordedAt: minutesAgo(20) },
      { driverId, ...LAGOS, recordedAt: minutesAgo(40) },
    ],
  });
  const hour = await admin(liveMap.handleLiveDriverTrailRoute, 'GET', { args: [driverId, new URL('http://x/?minutes=60')] });
  assert.equal(hour.body.points.length, 2);
  assert.ok(hour.body.points[0].at < hour.body.points[1].at);
  const day = await admin(liveMap.handleLiveDriverTrailRoute, 'GET', { args: [driverId, new URL('http://x/?minutes=1440')] });
  assert.equal(day.body.points.length, 3);
});

test('old history is pruned, recent history is kept', async () => {
  const { driverId } = await makeDriver();
  await prisma.driverLocationPoint.createMany({
    data: [
      { driverId, ...LAGOS, recordedAt: new Date(Date.now() - 15 * 86_400_000) },
      { driverId, ...LAGOS, recordedAt: new Date(Date.now() - 13 * 86_400_000) },
    ],
  });
  await driverLocationClient.pruneOlderThan(new Date(Date.now() - 14 * 86_400_000));
  assert.equal(await prisma.driverLocationPoint.count({ where: { driverId } }), 1);
});

/* ── dispatch ─────────────────────────────────────────────────────────── */

test('dispatch ranks who to ring: on shift first, then nearest; never someone on a trip', async () => {
  const ride = await makeRide(LAGOS);
  const far = await makeDriver({ status: 'ONLINE', name: 'Dispatch Far Online' });
  await driverClient.updateLocation(far.driverId, LAGOS.lat + 0.03, LAGOS.lng);
  const close = await makeDriver({ name: 'Dispatch Close Standby' });
  await driverLocationClient.setStandby(close.driverId, true);
  await driverLocationClient.updateStandbyLocation(close.driverId, NEARBY.lat, NEARBY.lng);
  const busy = await makeDriver({ status: 'ON_RIDE', name: 'Dispatch Busy' });
  await driverClient.updateLocation(busy.driverId, LAGOS.lat, LAGOS.lng);

  const result = await admin(liveMap.handleLiveDispatchRoute, 'GET');
  assert.equal(result.status, 200);
  const row = result.body.rides.find((r) => r.id === ride.id);
  assert.ok(row, 'the unmatched ride is in the queue');
  const ids = row.nearest.map((d) => d.id);
  assert.ok(!ids.includes(busy.driverId), 'a driver on a trip is not offered');
  assert.ok(ids.indexOf(far.driverId) < ids.indexOf(close.driverId), 'already online beats closer-but-off-shift');
  const closeRow = row.nearest.find((d) => d.id === close.driverId);
  assert.equal(closeRow.presence, 'standby');
  assert.ok(closeRow.distanceKm > 0.9 && closeRow.distanceKm < 1.4);
});

test('a nudge pushes the driver, is logged, and cannot be spammed', async () => {
  const ride = await makeRide();
  const { driverId, userId } = await makeDriver();
  const { deps, pushes } = adminDeps();

  const sent = await admin(liveMap.handleLiveNudgeRoute, 'POST', { deps, args: [driverId], body: { rideId: ride.id } });
  assert.equal(sent.status, 200);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].userId, userId);
  assert.equal(pushes[0].data.type, 'dispatch_nudge');
  assert.equal(pushes[0].data.rideId, ride.id);
  assert.match(pushes[0].body, /Go online/);

  const again = await admin(liveMap.handleLiveNudgeRoute, 'POST', { deps, args: [driverId], body: {} });
  assert.equal(again.status, 429);
  assert.equal(pushes.length, 1, 'the second push never left');

  const log = await prisma.dispatchContact.findMany({ where: { driverId } });
  assert.equal(log.length, 1);
  assert.equal(log[0].kind, 'nudge');
  assert.equal(log[0].adminName, 'api-key');

  const onTrip = await makeDriver({ status: 'ON_RIDE' });
  const busy = await admin(liveMap.handleLiveNudgeRoute, 'POST', { deps, args: [onTrip.driverId], body: {} });
  assert.equal(busy.status, 409);
});

test('a call is logged with its outcome and shows up on the driver', async () => {
  const { driverId } = await makeDriver();
  const bad = await admin(liveMap.handleLiveContactRoute, 'POST', { args: [driverId], body: { outcome: 'maybe' } });
  assert.equal(bad.status, 400);

  const ok = await admin(liveMap.handleLiveContactRoute, 'POST', { args: [driverId], body: { outcome: 'no_answer', note: '  rang out  ' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.contact.note, 'rang out');

  const detail = await admin(liveMap.handleLiveDriverDetailRoute, 'GET', { args: [driverId] });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.driver, null, 'no position yet, but the profile still loads');
  assert.equal(detail.body.contacts[0].outcome, 'no_answer');

  const missing = await admin(liveMap.handleLiveContactRoute, 'POST', { args: [randomUUID()], body: { outcome: 'accepted' } });
  assert.equal(missing.status, 404);
});
