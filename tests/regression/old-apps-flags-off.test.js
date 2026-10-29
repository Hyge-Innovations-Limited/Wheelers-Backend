// Regression (plan 2026-10-28, Phase 1): what an OLD app sees (no app:state, no androidChannel, no ride:pay_sheet,
// ignores ride:rider_paying_ended). Real Postgres + Redis db 15. Same answers as main, flags off; and with the flags
// ON an old app's requests still get the same shapes.
//
// golden/old-apps.json was captured from main:  REGRESSION_CAPTURE=1 REGRESSION_ROOT=<built checkout of main> ...
//   node scripts/run-with-env.cjs node --test --test-force-exit tests/regression/old-apps-flags-off.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

const REPO = path.resolve(__dirname, '../..');
const ROOT = process.env.REGRESSION_ROOT || REPO;
const GOLDEN = path.resolve(__dirname, 'golden/old-apps.json');
const at = (p) => require(path.join(ROOT, p));
const { PrismaClient } = require(path.join(REPO, 'node_modules/@prisma/client'));
const WebSocket = require(path.join(REPO, 'apps/api-gateway/node_modules/ws'));
const { RedisClient } = at('apps/api-gateway/dist/redis/client.js');
const { SocketRegistry } = at('apps/api-gateway/dist/websocket/registry.js');
const { createGatewayWebSocketServer } = at('apps/api-gateway/dist/websocket/server.js');
const { handleRidePageRoute } = at('apps/api-gateway/dist/http/ride-page.route.js');
const { handleGetDriverBidsRoute } = at('apps/api-gateway/dist/http/driver.route.js');
const { handleRegisterPushTokenRoute } = at('apps/api-gateway/dist/http/notification.route.js');
const bidState = at('apps/api-gateway/dist/whatsapp-flows/bid-state.js');
const local = at('apps/api-gateway/dist/auth/local.js');
let payingMod = null; try { payingMod = at('apps/api-gateway/dist/rides/paying-status.js'); } catch { /* main has none */ }

const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15';
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const prisma = new PrismaClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clients = []; const servers = []; const made = { users: [], rides: [], drivers: [], tokens: [] };
const realConsole = { ...console };
test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; });
test.afterEach(() => { Object.assign(console, realConsole); payingMod?.setPayingStatusEnabled(false); });

const published = [];
const publisher = { publishRideEvent: async (e) => { published.push(e); }, publishDriverEvent: async () => {}, publishNotificationEvent: async () => {} };
async function redis() { const c = new RedisClient(REDIS_URL); await c.connect(); clients.push(c); return c; }
async function user(role) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:reg:${id}`, role, name: 'Reg Test', phone: `+23480${Math.floor(10000000 + Math.random() * 89999999)}` } });
  made.users.push(id); return id;
}
async function search() {
  const riderId = await user('RIDER'); const driverUserId = await user('DRIVER');
  const driver = await prisma.driver.create({ data: { userId: driverUserId, kycStatus: 'APPROVED', status: 'ONLINE', vehicleModel: 'Corolla', vehiclePlate: 'KJA-123AB' } });
  made.drivers.push(driver.id);
  const ride = await prisma.ride.create({ data: { riderId, status: 'MATCHING', pickupLat: 6.5, pickupLng: 3.37, pickupAddress: 'Yaba', destLat: 6.45, destLng: 3.43, destAddress: 'Lekki', riderOfferNgn: 6000 } });
  made.rides.push(ride.id);
  const bid = await prisma.driverBid.create({ data: { rideId: ride.id, driverId: driver.id, driverUserId, riderId, amountNgn: 6000, etaSeconds: 120, status: 'PENDING' } });
  return { riderId, driverUserId, driverId: driver.id, rideId: ride.id, bidId: bid.id };
}
const shape = (v) => (Array.isArray(v) ? v.map(shape) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape(v[k])])) : v === null ? 'null' : typeof v);

async function bidsList(s, r) {
  const server = http.createServer((req, res) => { void handleGetDriverBidsRoute(req, res, { jwtSecret: JWT_SECRET, redisClient: r }, new URL(req.url, 'http://x')); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const resp = await fetch(`http://127.0.0.1:${server.address().port}/drivers/me/bids`, { headers: { authorization: `Bearer ${local.createLocalAccessToken(s.driverUserId, JWT_SECRET)}` } });
    return { status: resp.status, shape: shape(await resp.json()) };
  } finally { await new Promise((resolve) => server.close(resolve)); }
}
async function register(userId) {
  const token = local.createLocalAccessToken(userId, JWT_SECRET);
  const expoPushToken = `ExponentPushToken[${randomUUID()}]`; made.tokens.push(expoPushToken);
  const server = http.createServer((req, res) => { handleRegisterPushTokenRoute(req, res, { jwtSecret: JWT_SECRET }); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const resp = await fetch(`http://127.0.0.1:${server.address().port}/`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ expoPushToken, platform: 'android', deviceName: 'Old phone', appOwnership: 'standalone' }) });
    const body = await resp.json();
    const row = await prisma.notificationDevice.findUnique({ where: { expoPushToken } });
    return { status: resp.status, shape: shape(body), body: { ...body.device, id: 'x', expoPushToken: 'x', lastRegisteredAt: 'x' }, enabled: row?.enabled };
  } finally { await new Promise((resolve) => server.close(resolve)); }
}
async function ridePage(path_, riderId, body, r) {
  const bearer = local.createWalletPageToken(riderId, 'ride', JWT_SECRET, local.RIDE_PAGE_TOKEN_TTL_SECONDS);
  const req = { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
  const res = { statusCode: 200, body: null, setHeader() {}, writeHead(c) { this.statusCode = c; return this; }, end(t) { try { this.body = t ? JSON.parse(t) : null; } catch { this.body = String(t).slice(0, 60); } } };
  await handleRidePageRoute(req, res, { jwtSecret: JWT_SECRET, redisClient: r, publisher, paymentsClient: {} }, new URL(`http://x${path_}`));
  return { status: res.statusCode, body: res.body };
}
async function walletShort() {
  const s = await search(); const r = await redis();
  const bid = { bidId: s.bidId, driverId: s.driverId, driverUserId: s.driverUserId, counterOfferNgn: 6000, driverName: 'T', driverRating: 5, vehiclePlate: 'X', vehicleModel: 'Y', etaSeconds: 100, distanceKm: 1, receivedAt: new Date().toISOString() };
  await bidState.storeWhatsappRide(r, s.rideId, { riderId: s.riderId, phone: '+2348030000000', pickupAddress: 'Yaba', destAddress: 'Lekki', pickupLat: 6.5, pickupLng: 3.37, destLat: 6.45, destLng: 3.43, fareNgn: 6000, distanceKm: 5 });
  await bidState.setActiveRide(r, s.riderId, s.rideId);
  await bidState.addBid(r, s.rideId, bid);
  published.length = 0;
  const accept = await ridePage('/ride-page/accept', s.riderId, { key: s.bidId }, r);
  const keepLooking = await ridePage('/ride-page/keep-looking', s.riderId, {}, r);
  const decline = await ridePage('/ride-page/decline', s.riderId, { key: s.bidId }, r);
  const ev = published.filter((e) => e.rideId === s.rideId).map((e) => ({ type: e.eventType, keys: Object.keys(e).filter((k) => !['timestamp', 'rideId', 'riderId', 'driverUserId'].includes(k)).sort() }));
  const paying404 = await ridePage('/ride-page/paying', s.riderId, { offerKey: s.bidId, open: true }, r);
  return { s, r, accept, keepLooking, decline, events: ev, paying: paying404 };
}
async function oldRiderSocket() {
  const s = await search(); const commandRedis = await redis();
  const registry = new SocketRegistry({ instanceId: `reg-${randomUUID()}`, commandRedis, subscriberRedis: await redis() });
  await registry.start();
  const server = http.createServer();
  createGatewayWebSocketServer({ server, jwtSecret: JWT_SECRET, allowedOrigins: new Set(), idleTimeoutMs: 60_000, registry, publisher, routePlanner: {}, redis: await redis(), pageOrigins: new Set() });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
  const sock = await new Promise((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws?token=${encodeURIComponent(local.createLocalAccessToken(s.riderId, JWT_SECRET))}`);
    w.inbox = []; w.on('message', (m) => w.inbox.push(JSON.parse(m.toString()))); w.once('open', () => resolve(w)); w.once('error', reject);
  });
  const ask = async (type, payload) => { const n = sock.inbox.length; sock.send(JSON.stringify({ type, payload })); for (let i = 0; i < 160 && sock.inbox.length === n; i++) await sleep(25); return sock.inbox[n]; };
  const out = {};
  for (const [name, type, payload] of [['pay_sheet', 'ride:pay_sheet', { rideId: s.rideId, driverId: s.driverId, open: true }], ['app_state_on_rider', 'app:state', { state: 'background' }], ['unknown', 'ride:nope', {}], ['decline_offer', 'ride:decline_offer', { rideId: s.rideId, driverId: s.driverId }]]) {
    const r = await ask(type, payload); out[name] = r ? { type: r.type, message: r.payload?.message ? String(r.payload.message).slice(0, 60) : undefined } : 'no reply';
  }
  sock.close();
  return out;
}

async function collect(flagOn) {
  payingMod?.setPayingStatusEnabled(flagOn);
  const s = await search(); const r = await redis();
  const out = { bids: await bidsList(s, r), register: await register(s.driverUserId) };
  const ws = await walletShort();
  out.walletShort = { accept: ws.accept, keepLooking: ws.keepLooking, decline: ws.decline, events: ws.events, payingRoute: ws.paying };
  out.rider_ws = await oldRiderSocket();
  // random ids and clocks are not behaviour
  return JSON.parse(JSON.stringify(out).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<time>'));
}

test.after(async () => {
  for (const s of servers) s.close();
  for (const c of clients) await c.close?.().catch(() => {});
  await prisma.notificationDevice.deleteMany({ where: { expoPushToken: { in: made.tokens } } }).catch(() => {});
  await prisma.driverBid.deleteMany({ where: { rideId: { in: made.rides } } }).catch(() => {});
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
  await prisma.$disconnect();
});

if (process.env.REGRESSION_CAPTURE) {
  test('capture golden', async () => { fs.writeFileSync(GOLDEN, JSON.stringify(await collect(false), null, 2) + '\n'); });
} else {
  test('flags OFF: an old driver app and an old rider app get main\'s answers', async () => {
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    const now = await collect(false);
    assert.deepEqual(now.bids, golden.bids, 'GET /drivers/me/bids');
    assert.deepEqual(now.register, golden.register, 'POST push token (no androidChannel)');
    const { payingRoute: nowPaying, ...nowWs } = now.walletShort; const { payingRoute: oldPaying, ...goldenWs } = golden.walletShort;
    assert.deepEqual(nowWs, goldenWs, 'ride page accept/decline + WALLET_SHORT events');
    // main does not know /ride-page/paying (the handler passes, the server answers 404); flag off answers 404 itself
    assert.equal(oldPaying.body, null);
    assert.equal(nowPaying.status, 404);
    assert.deepEqual(now.rider_ws, golden.rider_ws, 'rider ws messages');
  });
  test('flags ON: an old app that sends none of the new messages still gets the old shapes', async () => {
    if (!payingMod) return;
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    const now = await collect(true);
    assert.deepEqual(now.bids, golden.bids, 'bids list with no paying state is unchanged');
    assert.deepEqual(now.register, golden.register);
    assert.equal(now.walletShort.accept.status, golden.walletShort.accept.status);
    assert.equal(now.walletShort.accept.body.code, golden.walletShort.accept.body.code, 'WALLET_SHORT still answered');
    assert.deepEqual(now.walletShort.accept.body.shortNgn, golden.walletShort.accept.body.shortNgn);
    // the events: RIDE_RIDER_PAYING still published; an old consumer ignores the extra payingSince/payingUntil
    const types = now.walletShort.events.map((e) => e.type);
    assert.ok(types.includes('RIDE_RIDER_PAYING'));
  });
}
