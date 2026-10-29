// S2 through the real entry points: the ws server (ride:pay_sheet), POST /ride-page/paying,
// GET /drivers/me/bids and the cancel event. Real Postgres + Redis (db 15).
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/driver-paying-status-entry.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const WebSocket = require('../apps/api-gateway/node_modules/ws');

const { RedisClient } = require('../apps/api-gateway/dist/redis/client.js');
const { SocketRegistry } = require('../apps/api-gateway/dist/websocket/registry.js');
const { createGatewayWebSocketServer } = require('../apps/api-gateway/dist/websocket/server.js');
const { handleRidePageRoute } = require('../apps/api-gateway/dist/http/ride-page.route.js');
const { handleGetDriverBidsRoute } = require('../apps/api-gateway/dist/http/driver.route.js');
const { handleRideEvent } = require('../apps/api-gateway/dist/kafka/consumer.js');
const paying = require('../apps/api-gateway/dist/rides/paying-status.js');
const bidState = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');
const local = require('../apps/api-gateway/dist/auth/local.js');

const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15';
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const prisma = new PrismaClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clients = []; const servers = []; const made = { users: [], rides: [], drivers: [] };
const realConsole = { ...console };
test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; });
test.afterEach(() => { Object.assign(console, realConsole); paying.setPayingStatusEnabled(false); });

async function redis() { const c = new RedisClient(REDIS_URL); await c.connect(); clients.push(c); return c; }
async function user(role) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:s2:${id}`, role, name: 'S2 Test', phone: `+23480${Math.floor(10000000 + Math.random() * 89999999)}` } });
  made.users.push(id);
  return id;
}
async function search({ bidStatus = 'PENDING', rideStatus = 'MATCHING' } = {}) {
  const riderId = await user('RIDER');
  const driverUserId = await user('DRIVER');
  const driver = await prisma.driver.create({ data: { userId: driverUserId, kycStatus: 'APPROVED', status: 'ONLINE', vehicleModel: 'Corolla', vehiclePlate: 'KJA-123AB' } });
  made.drivers.push(driver.id);
  const ride = await prisma.ride.create({ data: { riderId, status: rideStatus, pickupLat: 6.5, pickupLng: 3.37, pickupAddress: 'Yaba', destLat: 6.45, destLng: 3.43, destAddress: 'Lekki', riderOfferNgn: 6000 } });
  made.rides.push(ride.id);
  const bid = await prisma.driverBid.create({ data: { rideId: ride.id, driverId: driver.id, driverUserId, riderId, amountNgn: 6000, etaSeconds: 120, status: bidStatus } });
  return { riderId, driverUserId, driverId: driver.id, rideId: ride.id, bidId: bid.id };
}
async function until(check, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await sleep(25); } return false; }

const published = [];
const publisher = {
  publishRideEvent: async (e) => { published.push(e); },
  publishDriverEvent: async () => {}, publishNotificationEvent: async () => {},
};
const only = (rideId, type) => published.filter((e) => e.rideId === rideId && e.eventType === type);

async function gateway() {
  const commandRedis = await redis();
  const registry = new SocketRegistry({ instanceId: `s2-${randomUUID()}`, commandRedis, subscriberRedis: await redis() });
  await registry.start();
  const server = http.createServer();
  const r = await redis();
  createGatewayWebSocketServer({ server, jwtSecret: JWT_SECRET, allowedOrigins: new Set(), idleTimeoutMs: 60_000, registry, publisher, routePlanner: {}, redis: r, pageOrigins: new Set() });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { registry, redis: r, port: server.address().port };
}
function open(url) {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(url); s.inbox = [];
    s.on('message', (raw) => s.inbox.push(JSON.parse(raw.toString())));
    s.once('open', () => resolve(s)); s.once('error', reject);
  });
}
async function connect(g, userId) {
  const s = await open(`ws://127.0.0.1:${g.port}/ws?token=${encodeURIComponent(local.createLocalAccessToken(userId, JWT_SECRET))}`);
  await until(() => g.registry.isUserConnected(userId));
  return s;
}
async function reply(socket, type, payload) {
  const before = socket.inbox.length;
  socket.send(JSON.stringify({ type, payload }));
  await until(() => socket.inbox.length > before);
  return socket.inbox[before];
}

test.after(async () => {
  for (const s of servers) s.close();
  for (const c of clients) await c.close?.().catch(() => {});
  await prisma.driverBid.deleteMany({ where: { rideId: { in: made.rides } } }).catch(() => {});
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
  await prisma.$disconnect();
});

/* ── ws ride:pay_sheet ── */

test('ws: flag off, ride:pay_sheet is an unknown message and nothing is stored', async () => {
  const g = await gateway(); const s = await search();
  const sock = await connect(g, s.riderId);
  const r = await reply(sock, 'ride:pay_sheet', { rideId: s.rideId, driverId: s.driverId, open: true });
  assert.equal(r.type, 'error'); assert.match(r.payload.message, /Unknown event type/);
  assert.equal(await g.redis.get(`ride:${s.rideId}:paying`), null);
  sock.close();
});

test('ws: open, open again, close, close again, and the events and replies for each', async () => {
  paying.setPayingStatusEnabled(true);
  const g = await gateway(); const s = await search();
  const sock = await connect(g, s.riderId);
  const msg = (open) => ({ rideId: s.rideId, driverId: s.driverId, open });
  assert.equal((await reply(sock, 'ride:pay_sheet', msg(true))).type, 'ride:pay_sheet:ok');
  assert.equal((await reply(sock, 'ride:pay_sheet', msg(true))).type, 'ride:pay_sheet:ok');
  assert.equal(only(s.rideId, 'RIDE_RIDER_PAYING').length, 1, 'idempotent open');
  const ev = only(s.rideId, 'RIDE_RIDER_PAYING')[0];
  assert.equal(ev.driverUserId, s.driverUserId); assert.ok(ev.payingUntil);
  assert.ok(await g.redis.get(`ride:${s.rideId}:paying`));
  await reply(sock, 'ride:pay_sheet', msg(false));
  await reply(sock, 'ride:pay_sheet', msg(false));
  assert.equal(only(s.rideId, 'RIDE_RIDER_PAYING_ENDED').length, 1, 'closing when not open gives nothing');
  assert.equal(only(s.rideId, 'RIDE_RIDER_PAYING_ENDED')[0].reason, 'closed');
  sock.close();
});

test("ws: a stranger's rideId is refused, a dead offer is refused, an ended search is refused", async () => {
  paying.setPayingStatusEnabled(true);
  const g = await gateway();
  const mine = await search(); const theirs = await search();
  const sock = await connect(g, mine.riderId);
  const stranger = await reply(sock, 'ride:pay_sheet', { rideId: theirs.rideId, driverId: theirs.driverId, open: true });
  assert.equal(stranger.type, 'error'); assert.match(stranger.payload.message, /not yours/);
  assert.equal(only(theirs.rideId, 'RIDE_RIDER_PAYING').length, 0);

  const declined = await search({ bidStatus: 'DECLINED' });
  const s2 = await connect(g, declined.riderId);
  assert.equal((await reply(s2, 'ride:pay_sheet', { rideId: declined.rideId, driverId: declined.driverId, open: true })).type, 'error');
  const noBid = await reply(sock, 'ride:pay_sheet', { rideId: mine.rideId, driverId: randomUUID(), open: true });
  assert.equal(noBid.type, 'error');
  const over = await search({ rideStatus: 'CANCELLED' });
  const s3 = await connect(g, over.riderId);
  assert.equal((await reply(s3, 'ride:pay_sheet', { rideId: over.rideId, driverId: over.driverId, open: true })).type, 'error');
  assert.equal(only(declined.rideId, 'RIDE_RIDER_PAYING').length + only(over.rideId, 'RIDE_RIDER_PAYING').length, 0);
  sock.close(); s2.close(); s3.close();
});

test('ws: the rate limit is 20 opens and closes a minute per rider', async () => {
  paying.setPayingStatusEnabled(true);
  const g = await gateway(); const s = await search();
  await g.redis.del(`ratelimit:paying:${s.riderId}`);
  const sock = await connect(g, s.riderId);
  let last;
  for (let i = 0; i < 21; i += 1) last = await reply(sock, 'ride:pay_sheet', { rideId: s.rideId, driverId: s.driverId, open: true });
  assert.equal(last.type, 'error'); assert.match(last.payload.message, /Too many/);
  sock.close();
});

/* ── cancel ends it ── */

test('a cancelled ride ends the paying state (RIDE_CANCELLED through the consumer)', async () => {
  paying.setPayingStatusEnabled(true);
  const r = await redis(); const s = await search();
  const toApp = [];
  const deps = {
    registry: { sendToUser: async (userId, type, payload) => { toApp.push({ userId, type, payload }); }, isUserConnected: async () => true, hasUser: () => true },
    redisClient: r, publisher,
  };
  await paying.openPaying({ redisClient: r, publisher }, s.rideId, s.riderId, s.driverUserId);
  await handleRideEvent({ eventType: 'RIDE_CANCELLED', rideId: s.rideId, riderId: s.riderId, cancelledBy: 'rider', timestamp: new Date().toISOString() }, deps, new Map()).catch(() => {});
  const ended = only(s.rideId, 'RIDE_RIDER_PAYING_ENDED');
  assert.equal(ended.length, 1); assert.equal(ended[0].reason, 'cancelled');
});

/* ── HTTP: POST /ride-page/paying ── */

async function pageCall(deps, userId, body) {
  const bearer = local.createWalletPageToken(userId, 'ride', JWT_SECRET, local.RIDE_PAGE_TOKEN_TTL_SECONDS);
  const req = { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
  const res = { statusCode: 200, body: null, setHeader() {}, writeHead(c) { this.statusCode = c; return this; }, end(t) { this.body = t ? JSON.parse(t) : null; } };
  await handleRidePageRoute(req, res, deps, new URL('http://x/ride-page/paying'));
  return res;
}
async function pageSearch() {
  const s = await search();
  const r = await redis();
  const bid = { bidId: s.bidId, driverId: s.driverId, driverUserId: s.driverUserId, counterOfferNgn: 6000, driverName: 'T', driverRating: 5, vehiclePlate: 'X', vehicleModel: 'Y', etaSeconds: 100, distanceKm: 1, receivedAt: new Date().toISOString() };
  await bidState.storeWhatsappRide(r, s.rideId, { riderId: s.riderId, phone: '+2348030000000', pickupAddress: 'Yaba', destAddress: 'Lekki', pickupLat: 6.5, pickupLng: 3.37, destLat: 6.45, destLng: 3.43, fareNgn: 6000, distanceKm: 5 });
  await bidState.setActiveRide(r, s.riderId, s.rideId);
  await bidState.addBid(r, s.rideId, bid);
  return { ...s, r, bid };
}

test('page route: flag off is a 404 and stores nothing', async () => {
  const s = await pageSearch();
  const res = await pageCall({ jwtSecret: JWT_SECRET, redisClient: s.r, publisher, paymentsClient: {} }, s.riderId, { offerKey: s.bidId, open: true });
  assert.equal(res.statusCode, 404);
  assert.equal(await s.r.get(`ride:${s.rideId}:paying`), null);
});

test('page route: open, open again, close; a stranger and a gone offer are refused; the rate limit holds', async () => {
  paying.setPayingStatusEnabled(true);
  const s = await pageSearch();
  const deps = { jwtSecret: JWT_SECRET, redisClient: s.r, publisher, paymentsClient: {} };
  await s.r.del(`ratelimit:paying:${s.riderId}`);
  assert.equal((await pageCall(deps, s.riderId, { offerKey: s.bidId, open: true })).statusCode, 200);
  assert.equal((await pageCall(deps, s.riderId, { offerKey: s.bidId, open: true })).statusCode, 200);
  assert.equal(only(s.rideId, 'RIDE_RIDER_PAYING').length, 1);
  assert.equal((await pageCall(deps, s.riderId, { offerKey: 'nope', open: true })).statusCode, 409, 'offer gone');
  assert.equal((await pageCall(deps, s.riderId, { offerKey: s.bidId })).statusCode, 400, 'open is required');
  assert.equal((await pageCall(deps, s.riderId, { offerKey: s.bidId, open: false })).statusCode, 200);
  assert.equal(only(s.rideId, 'RIDE_RIDER_PAYING_ENDED').length, 1);
  assert.equal((await pageCall(deps, s.riderId, { offerKey: s.bidId, open: false })).statusCode, 200);
  assert.equal(only(s.rideId, 'RIDE_RIDER_PAYING_ENDED').length, 1, 'closing when not open gives nothing');
  // a stranger has no active search of their own, so nothing of this ride is reachable
  const stranger = await user('RIDER');
  assert.equal((await pageCall(deps, stranger, { offerKey: s.bidId, open: true })).statusCode, 409);
  assert.equal(only(s.rideId, 'RIDE_RIDER_PAYING').length, 1);
  let last;
  await s.r.del(`ratelimit:paying:${s.riderId}`);
  for (let i = 0; i < 21; i += 1) last = await pageCall(deps, s.riderId, { offerKey: s.bidId, open: true });
  assert.equal(last.statusCode, 429);
});

/* ── GET /drivers/me/bids ── */

async function bidsFor(userId, r) {
  const server = http.createServer((req, res) => { void handleGetDriverBidsRoute(req, res, { jwtSecret: JWT_SECRET, redisClient: r }, new URL(req.url, 'http://localhost')); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/drivers/me/bids`, { headers: { authorization: `Bearer ${local.createLocalAccessToken(userId, JWT_SECRET)}` } });
    return response.json();
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('bids list: payingSince/payingUntil only for the driver being paid, only with the flag; unchanged when off', async () => {
  const r = await redis(); const s = await search();
  const other = await user('DRIVER');
  await prisma.driver.create({ data: { userId: other, kycStatus: 'APPROVED', status: 'ONLINE', vehicleModel: 'C', vehiclePlate: `P${Date.now()}` } }).then((d) => made.drivers.push(d.id));
  await paying.openPaying({ redisClient: r, publisher }, s.rideId, s.riderId, s.driverUserId);

  const off = await bidsFor(s.driverUserId, r);
  assert.equal('payingSince' in off.items[0], false, 'flag off: response unchanged');

  paying.setPayingStatusEnabled(true);
  const on = await bidsFor(s.driverUserId, r);
  assert.ok(on.items[0].payingSince); assert.equal(Date.parse(on.items[0].payingUntil) - Date.parse(on.items[0].payingSince), 600_000);
  assert.ok(on.items[0].payingRemainingMs > 590_000 && on.items[0].payingRemainingMs <= 600_000, 'server-clock time left');
  assert.equal('payingRemainingMs' in off.items[0], false);
  assert.equal(on.items[0].id, s.bidId);

  // another driver's list does not show it
  await prisma.driverBid.create({ data: { rideId: s.rideId, driverId: (await prisma.driver.findFirst({ where: { userId: other } })).id, driverUserId: other, riderId: s.riderId, amountNgn: 6100, etaSeconds: 100 } });
  const theirs = await bidsFor(other, r);
  assert.equal('payingSince' in theirs.items[0], false);
});

/* ── WALLET_SHORT counts as open ── */

async function acceptShort(flag, before) {
  paying.setPayingStatusEnabled(flag);
  const s = await pageSearch();
  if (before) await before(s);
  const deps = { jwtSecret: JWT_SECRET, redisClient: s.r, publisher, paymentsClient: {} };
  const bearer = local.createWalletPageToken(s.riderId, 'ride', JWT_SECRET, local.RIDE_PAGE_TOKEN_TTL_SECONDS);
  const req = { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ key: s.bidId })); } };
  const res = { statusCode: 200, body: null, setHeader() {}, writeHead(c) { this.statusCode = c; return this; }, end(t) { this.body = t ? JSON.parse(t) : null; } };
  await handleRidePageRoute(req, res, deps, new URL('http://x/ride-page/accept'));
  return { res, s };
}

test('add money for a driver (WALLET_SHORT): flag on keeps the state and the event carries payingUntil; flag off is the plain event', async () => {
  const on = await acceptShort(true);
  assert.equal(on.res.body.code, 'WALLET_SHORT');
  assert.ok(await on.s.r.get(`ride:${on.s.rideId}:paying`));
  assert.ok(only(on.s.rideId, 'RIDE_RIDER_PAYING')[0].payingUntil);
  const off = await acceptShort(false);
  assert.equal(off.res.body.code, 'WALLET_SHORT');
  assert.equal(await off.s.r.get(`ride:${off.s.rideId}:paying`), null);
  const plain = only(off.s.rideId, 'RIDE_RIDER_PAYING')[0];
  assert.equal(plain.payingUntil, undefined);
});

/* ── the real Lua scripts, against a real Redis ── */

async function moveCase(withUntil) {
  const r = await redis(); const rideId = randomUUID(); const A = randomUUID(); const key = `ride:${rideId}:paying`;
  const events = [];
  const deps = { redisClient: r, publisher: { publishRideEvent: async (e) => { events.push(e); } } };
  await paying.openPaying(deps, rideId, randomUUID(), A);
  const first = JSON.parse(await r.get(key));
  const old = { driverUserId: A, since: first.since };
  if (withUntil) old.untilMs = first.untilMs - 3 * 60 * 1000; // else: no untilMs, so since + TTL is the told end
  else old.since = first.since - 3 * 60 * 1000;
  await r.set(key, JSON.stringify(old), 600);
  events.length = 0;
  await paying.openPaying(deps, rideId, randomUUID(), A);
  const stored = JSON.parse(await r.get(key));
  const now = Date.now();
  assert.ok(Math.abs(stored.untilMs - (now + 600_000)) < 5000, 'the stored end moved to about now + 600 s');
  assert.equal(stored.since, old.since, 'the card keeps its start');
  const again = events.filter((e) => e.eventType === 'RIDE_RIDER_PAYING');
  assert.equal(again.length, 1, 'exactly one more RIDE_RIDER_PAYING');
  assert.equal(again[0].payingSince, new Date(old.since).toISOString());
  assert.equal(again[0].payingUntil, new Date(stored.untilMs).toISOString());
  assert.equal(events.filter((e) => e.eventType === 'RIDE_RIDER_PAYING_ENDED').length, 0);
  const ttl = await r.send('TTL', key);
  assert.ok(ttl > 590 && ttl <= 600, `ttl ${ttl}`);
  await r.del(key);
}
test('real Redis: a repeat open whose told end is over 2 minutes behind moves it and tells the driver once (stored untilMs)', () => moveCase(true));
test('real Redis: same, when the stored value has no untilMs (the since + TTL fallback)', () => moveCase(false));

function payWorld(r) {
  const events = [];
  const deps = { redisClient: r, publisher: { publishRideEvent: async (e) => { events.push(e); } } };
  return { deps, events, ended: () => events.filter((e) => e.eventType === 'RIDE_RIDER_PAYING_ENDED') };
}

test('real Redis: close(A) and open(B) at once, in both orders, leave B holding and end only A', async () => {
  const r = await redis();
  const A = randomUUID(); const B = randomUUID();
  for (let i = 0; i < 40; i += 1) {
    const rideId = randomUUID(); const w = payWorld(r);
    await paying.openPaying(w.deps, rideId, randomUUID(), A);
    w.events.length = 0;
    if (i % 2 === 0) await Promise.all([paying.closePaying(w.deps, rideId, 'closed', A), paying.openPaying(w.deps, rideId, randomUUID(), B)]);
    else await Promise.all([paying.openPaying(w.deps, rideId, randomUUID(), B), paying.closePaying(w.deps, rideId, 'closed', A)]);
    assert.equal((await paying.readPaying(r, rideId)).driverUserId, B, `round ${i}`);
    assert.deepEqual(w.ended().map((e) => e.driverUserId), [A], `round ${i}: only A is ended`);
    await r.del(`ride:${rideId}:paying`);
  }
});

test('real Redis: two opens at once for different drivers leave exactly one holder and end the other', async () => {
  const r = await redis();
  const A = randomUUID(); const B = randomUUID();
  for (let i = 0; i < 40; i += 1) {
    const rideId = randomUUID(); const w = payWorld(r);
    await Promise.all([paying.openPaying(w.deps, rideId, randomUUID(), A), paying.openPaying(w.deps, rideId, randomUUID(), B)]);
    const holder = (await paying.readPaying(r, rideId)).driverUserId;
    const loser = holder === A ? B : A;
    assert.deepEqual(w.ended().map((e) => e.driverUserId), [loser], `round ${i}`);
    await r.del(`ride:${rideId}:paying`);
  }
});

test('real Redis: the same driver again changes nothing the driver was told; the rate counter gets its expiry', async () => {
  const r = await redis(); const rideId = randomUUID(); const w = payWorld(r); const A = randomUUID();
  await paying.openPaying(w.deps, rideId, randomUUID(), A);
  const first = await paying.readPaying(r, rideId);
  await sleep(20);
  const again = await paying.openPaying(w.deps, rideId, randomUUID(), A);
  const second = await paying.readPaying(r, rideId);
  assert.equal(again.result, 'unchanged');
  assert.equal(second.since, first.since);
  assert.equal(second.untilMs, first.untilMs, 'a small move keeps the end the driver was told');
  assert.equal(w.events.filter((e) => e.eventType === 'RIDE_RIDER_PAYING').length, 1);
  const rider = randomUUID();
  assert.equal(await paying.withinPayingRate(r, rider), true);
  const ttl = await r.send('TTL', `ratelimit:paying:${rider}`);
  assert.ok(ttl > 0 && ttl <= 60, `ttl ${ttl}`);
  await r.del(`ride:${rideId}:paying`); await r.del(`ratelimit:paying:${rider}`);
});

/* ── a close racing a booking ── */

const lockLib = require('../apps/api-gateway/dist/rides/booking-lock.js');

async function raceCases(label, openAndClose) {
  // each case: set up the opposing state, open, close, report whether an ENDED went out
  for (const [name, setup, expectEnded] of [
    ['accept already sent', (r, s) => lockLib.noteAcceptSent(r, s.rideId, s.driverUserId), 0],
    ['accept sent for ANOTHER driver', (r, s) => lockLib.noteAcceptSent(r, s.rideId, randomUUID()), 1],
    ['ride confirmed', (r, s) => bidState.setRideState(r, s.rideId, 'confirmed'), 0],
    ['normal close', async () => {}, 1],
  ]) {
    test(`${label}: ${name} -> ${expectEnded ? 'ends it' : 'no close'}`, async () => {
      paying.setPayingStatusEnabled(true);
      const s = await pageSearch();
      await s.r.del(`ratelimit:paying:${s.riderId}`);
      await openAndClose(s, async () => setup(s.r, s), expectEnded, async () => {});
    });
  }
  test(`${label}: a booking lock held and an accept sent -> the close publishes nothing`, async () => {
    paying.setPayingStatusEnabled(true);
    const s = await pageSearch();
    await s.r.del(`ratelimit:paying:${s.riderId}`);
    await openAndClose(s, async () => { await lockLib.noteAcceptSent(s.r, s.rideId, s.driverUserId); await s.r.set(lockLib.bookingLockKey(s.rideId), 'someone', 20); setTimeout(() => s.r.del(lockLib.bookingLockKey(s.rideId)), 300); }, 0, async () => {});
  });
  test(`${label}: the lock never frees in time -> OK, no close, the lock is not stolen`, async () => {
    paying.setPayingStatusEnabled(true);
    const s = await pageSearch();
    await s.r.del(`ratelimit:paying:${s.riderId}`);
    await openAndClose(s, async () => { await s.r.set(lockLib.bookingLockKey(s.rideId), 'someone', 20); }, 0, async () => {
      assert.equal(await s.r.get(lockLib.bookingLockKey(s.rideId)), 'someone', 'the other holder keeps its lock');
    });
  });
}

raceCases('page route close', async (s, arrange, expectEnded, after) => {
  const deps = { jwtSecret: JWT_SECRET, redisClient: s.r, publisher, paymentsClient: {} };
  assert.equal((await pageCall(deps, s.riderId, { offerKey: s.bidId, open: true })).statusCode, 200);
  await arrange();
  const res = await pageCall(deps, s.riderId, { offerKey: s.bidId, open: false });
  assert.equal(res.statusCode, 200);
  assert.equal(only(s.rideId, 'RIDE_RIDER_PAYING_ENDED').length, expectEnded);
  await after?.();
  await s.r.del(lockLib.bookingLockKey(s.rideId));
});

raceCases('ws close', async (s, arrange, expectEnded, after) => {
  const g = await gateway();
  const sock = await connect(g, s.riderId);
  const msg = (open) => ({ rideId: s.rideId, driverId: s.driverId, open });
  assert.equal((await reply(sock, 'ride:pay_sheet', msg(true))).type, 'ride:pay_sheet:ok');
  await arrange();
  assert.equal((await reply(sock, 'ride:pay_sheet', msg(false))).type, 'ride:pay_sheet:ok');
  assert.equal(only(s.rideId, 'RIDE_RIDER_PAYING_ENDED').length, expectEnded);
  await s.r.del(lockLib.bookingLockKey(s.rideId));
  sock.close();
});


/* ── adversary fixes (M1, L1, L2, L5) ── */

test('real Redis: a spell is capped at 20 minutes from its start, and the key life never runs past it', async () => {
  const r = await redis(); const A = randomUUID(); const rideId = randomUUID(); const key = `ride:${rideId}:paying`; const w = payWorld(r);
  const now = Date.now();
  // 19.5 minutes into a spell whose told end is 10 minutes after its start
  const since = now - 19.5 * 60_000;
  await r.set(key, JSON.stringify({ driverUserId: A, since, untilMs: since + 600_000 }), 600);
  await paying.openPaying(w.deps, rideId, randomUUID(), A);
  const stored = JSON.parse(await r.get(key));
  assert.equal(stored.untilMs, since + paying.PAYING_MAX_SPELL_MS, 'the end is capped at start + 20 min');
  const ttl = await r.send('TTL', key);
  assert.ok(ttl > 0 && ttl <= 31, `key life ${ttl}s stops at the cap`);
  // past the cap: nothing is extended
  const old = now - 21 * 60_000;
  await r.set(key, JSON.stringify({ driverUserId: A, since: old, untilMs: old + paying.PAYING_MAX_SPELL_MS }), 100);
  await paying.openPaying(w.deps, rideId, randomUUID(), A);
  assert.ok((await r.send('TTL', key)) <= 100, 'the key is not renewed past the cap');
  await r.del(key);
});

test('real Redis: opening and closing many times inside one spell is never refused, and the spell keeps its start and cap', async () => {
  const r = await redis(); const A = randomUUID(); const rideId = randomUUID(); const w = payWorld(r);
  const first = await paying.openPaying(w.deps, rideId, randomUUID(), A);
  const since = (await paying.readPaying(r, rideId)).since;
  for (let i = 0; i < 12; i += 1) {
    assert.equal((await paying.closePaying(w.deps, rideId, 'closed', A)), true, `close ${i}`);
    const again = await paying.openPaying(w.deps, rideId, randomUUID(), A);
    assert.notEqual(again.result, 'refused', `open ${i}`);
    assert.equal((await paying.readPaying(r, rideId)).since, since, 'resumed, same start');
  }
  assert.equal(await r.get(paying.payingSpellsKey(rideId, A)), '1', 'one spell counted');
  // the cap holds at start + 20 min: a spell closed 19.5 minutes in comes back with 30 seconds left
  await paying.closePaying(w.deps, rideId, 'closed', A);
  const old = Date.now() - 19.5 * 60_000;
  await r.set(paying.payingLastKey(rideId, A), String(old), 30);
  await paying.openPaying(w.deps, rideId, randomUUID(), A);
  const st = await paying.readPaying(r, rideId);
  assert.equal(st.since, old); assert.equal(st.untilMs, old + paying.PAYING_MAX_SPELL_MS);
  assert.ok((await r.send('TTL', `ride:${rideId}:paying`)) <= 31);
  assert.ok(first.payingUntil);
  await r.del(`ride:${rideId}:paying`); await r.del(paying.payingSpellsKey(rideId, A)); await r.del(paying.payingLastKey(rideId, A));
});

test('real Redis: a third spell, started after two caps have passed, is refused with no event and no state', async () => {
  const r = await redis(); const A = randomUUID(); const rideId = randomUUID(); const w = payWorld(r);
  for (let i = 0; i < 2; i += 1) {
    assert.equal((await paying.openPaying(w.deps, rideId, randomUUID(), A)).result, 'opened');
    await paying.closePaying(w.deps, rideId, 'closed', A);
    await r.del(paying.payingLastKey(rideId, A)); // the 20 minutes passed
  }
  w.events.length = 0;
  const third = await paying.openPaying(w.deps, rideId, randomUUID(), A);
  assert.equal(third.result, 'refused');
  assert.equal(w.events.length, 0);
  assert.equal(await r.get(`ride:${rideId}:paying`), null);
  const ttl = await r.send('TTL', paying.payingSpellsKey(rideId, A));
  assert.ok(ttl > 0 && ttl <= 7200, `counter life ${ttl}`);
  await paying.openPaying(w.deps, rideId, randomUUID(), A); // a refused try does not renew the counter
  assert.ok((await r.send('TTL', paying.payingSpellsKey(rideId, A))) <= ttl);
  assert.equal((await paying.openPaying(w.deps, rideId, randomUUID(), randomUUID())).result, 'opened', 'another driver has their own count');
  await r.del(paying.payingSpellsKey(rideId, A));
});

test('real Redis: A then B then A inside the window resumes A\'s spell (same start, no new spell, one push name)', async () => {
  const r = await redis(); const A = randomUUID(); const B = randomUUID(); const rideId = randomUUID(); const w = payWorld(r);
  await paying.openPaying(w.deps, rideId, randomUUID(), A);
  const sinceA = (await paying.readPaying(r, rideId)).since;
  await paying.openPaying(w.deps, rideId, randomUUID(), B);
  assert.equal((await paying.openPaying(w.deps, rideId, randomUUID(), A)).result, 'switched');
  assert.equal((await paying.readPaying(r, rideId)).since, sinceA);
  const aEvents = w.events.filter((e) => e.eventType === 'RIDE_RIDER_PAYING' && e.driverUserId === A);
  assert.equal(aEvents.length, 2);
  assert.equal(aEvents[0].payingSince, aEvents[1].payingSince, 'the push generation (the start) is the same');
  assert.equal(await r.get(paying.payingSpellsKey(rideId, A)), '1');
  await r.del(`ride:${rideId}:paying`);
});

test('page route: an open after the search ended, on a cancelled ride, or for a non-PENDING bid is refused', async () => {
  paying.setPayingStatusEnabled(true);
  const cases = [
    ['search ended', async (s) => { await lockLib.markSearchEnded(s.r, s.rideId); }],
    ['ride cancelled', async (s) => { await prisma.ride.update({ where: { id: s.rideId }, data: { status: 'CANCELLED' } }); }],
    ['bid declined', async (s) => { await prisma.driverBid.update({ where: { id: s.bidId }, data: { status: 'DECLINED' } }); }],
  ];
  for (const [name, arrange] of cases) {
    const s = await pageSearch();
    await s.r.del(`ratelimit:paying:${s.riderId}`);
    await arrange(s);
    const res = await pageCall({ jwtSecret: JWT_SECRET, redisClient: s.r, publisher, paymentsClient: {} }, s.riderId, { offerKey: s.bidId, open: true });
    assert.equal(res.statusCode, 409, name);
    assert.equal(only(s.rideId, 'RIDE_RIDER_PAYING').length, 0, name);
    assert.equal(await s.r.get(`ride:${s.rideId}:paying`), null, name);
  }
});

test('a close with nothing open never takes the booking lock and does NOT count toward the rate limit; closes of an open state do', async () => {
  paying.setPayingStatusEnabled(true);
  const s = await pageSearch(); const w = payWorld(s.r);
  await s.r.set(lockLib.bookingLockKey(s.rideId), 'someone', 20);
  const t0 = Date.now();
  assert.equal(await paying.closePayingUnlessBooking(w.deps, s.rideId, s.driverUserId), 'nothing');
  assert.ok(Date.now() - t0 < 500, 'did not wait for the lock');
  // someone else's state: also nothing, also no lock
  await paying.openPaying(w.deps, s.rideId, s.riderId, randomUUID());
  assert.equal(await paying.closePayingUnlessBooking(w.deps, s.rideId, s.driverUserId), 'nothing');
  assert.equal(await s.r.get(lockLib.bookingLockKey(s.rideId)), 'someone');
  // closes of an open state count: open+close pairs, 20 in a minute, and the next one is refused on the page route
  const deps = { jwtSecret: JWT_SECRET, redisClient: s.r, publisher, paymentsClient: {} };
  await s.r.del(`ride:${s.rideId}:paying`);
  await s.r.del(lockLib.bookingLockKey(s.rideId));
  await s.r.del(`ratelimit:paying:${s.riderId}`);
  let last;
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await pageCall(deps, s.riderId, { offerKey: s.bidId, open: true })).statusCode, 200, `open ${i}`);
    assert.equal((await pageCall(deps, s.riderId, { offerKey: s.bidId, open: false })).statusCode, 200, `close ${i}`);
  }
  last = await pageCall(deps, s.riderId, { offerKey: s.bidId, open: true });
  assert.equal(last.statusCode, 429);
  // a close with nothing open does not count
  await s.r.del(`ratelimit:paying:${s.riderId}`);
  for (let i = 0; i < 25; i += 1) assert.equal((await pageCall(deps, s.riderId, { offerKey: s.bidId, open: false })).statusCode, 200);
  await s.r.del(lockLib.bookingLockKey(s.rideId));
});

test('ws close: a bid that is no longer PENDING and not being paid for is ignored; a held one is closed', async () => {
  paying.setPayingStatusEnabled(true);
  const g = await gateway(); const s = await search();
  const sock = await connect(g, s.riderId);
  const msg = (open) => ({ rideId: s.rideId, driverId: s.driverId, open });
  await reply(sock, 'ride:pay_sheet', msg(true));
  await prisma.driverBid.update({ where: { id: s.bidId }, data: { status: 'DECLINED' } });
  // declined, but still the one being paid for: the close ends it
  assert.equal((await reply(sock, 'ride:pay_sheet', msg(false))).type, 'ride:pay_sheet:ok');
  assert.equal(only(s.rideId, 'RIDE_RIDER_PAYING_ENDED').length, 1);
  // declined and nothing held: ignored (no lock, no event)
  await reply(sock, 'ride:pay_sheet', msg(false));
  assert.equal(only(s.rideId, 'RIDE_RIDER_PAYING_ENDED').length, 1);
  sock.close();
});

test('WALLET_SHORT over the paying rate limit: the answer is the same, only the signal is skipped', async () => {
  const over = await acceptShort(true, async (s) => { await s.r.set(`ratelimit:paying:${s.riderId}`, '20', 60); });
  assert.equal(over.res.body.code, 'WALLET_SHORT');
  assert.equal(await over.s.r.get(`ride:${over.s.rideId}:paying`), null);
  assert.equal(only(over.s.rideId, 'RIDE_RIDER_PAYING').length, 0);
  const normal = await acceptShort(true);
  assert.equal(normal.res.body.code, 'WALLET_SHORT');
  assert.ok(await normal.s.r.get(`ride:${normal.s.rideId}:paying`));
});

async function keepLooking(s, deps) {
  const bearer = local.createWalletPageToken(s.riderId, 'ride', JWT_SECRET, local.RIDE_PAGE_TOKEN_TTL_SECONDS);
  const req = { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield Buffer.from('{}'); } };
  const res = { statusCode: 200, body: null, setHeader() {}, writeHead(c) { this.statusCode = c; return this; }, end(t) { this.body = t ? JSON.parse(t) : null; } };
  await handleRidePageRoute(req, res, deps, new URL('http://x/ride-page/keep-looking'));
  return res;
}

test('keep-looking: ends the paying card; under a held booking lock it neither deadlocks nor closes', async () => {
  paying.setPayingStatusEnabled(true);
  const pend = async () => {
    const s = await pageSearch();
    await bidState.storePendingAccept(s.r, s.riderId, { bidId: s.bidId, rideId: s.rideId, driverId: s.driverId, driverUserId: s.driverUserId, driverName: 'T', driverPhone: '', driverRating: 5, totalRides: 0, vehicleModel: '', vehiclePlate: '', counterOfferNgn: 6000, fareNgn: 6000, etaSeconds: 100 });
    await paying.openPaying({ redisClient: s.r, publisher }, s.rideId, s.riderId, s.driverUserId);
    return s;
  };
  const free = await pend();
  const done = await keepLooking(free, { jwtSecret: JWT_SECRET, redisClient: free.r, publisher, paymentsClient: {} });
  assert.equal(done.statusCode, 200);
  assert.equal(only(free.rideId, 'RIDE_RIDER_PAYING_ENDED').length, 1);
  assert.equal(await free.r.get(lockLib.bookingLockKey(free.rideId)), null, 'the lock is released');

  const held = await pend();
  await held.r.set(lockLib.bookingLockKey(held.rideId), 'someone', 20);
  const t0 = Date.now();
  const blocked = await keepLooking(held, { jwtSecret: JWT_SECRET, redisClient: held.r, publisher, paymentsClient: {} });
  assert.ok(Date.now() - t0 < 8000, 'returns, no deadlock');
  assert.equal(blocked.statusCode, 409, 'as before: a driver is being confirmed');
  assert.equal(only(held.rideId, 'RIDE_RIDER_PAYING_ENDED').length, 0);
  assert.equal(await held.r.get(lockLib.bookingLockKey(held.rideId)), 'someone');
  await held.r.del(lockLib.bookingLockKey(held.rideId));
});

test('real Redis: a close for a decline deletes the resume marker, a rider Back keeps it', async () => {
  const r = await redis(); const A = randomUUID(); const rideId = randomUUID(); const w = payWorld(r);
  await paying.openPaying(w.deps, rideId, randomUUID(), A);
  await paying.closePaying(w.deps, rideId, 'closed', A);
  assert.ok(await r.get(paying.payingLastKey(rideId, A)));
  await paying.openPaying(w.deps, rideId, randomUUID(), A);
  await paying.closePaying(w.deps, rideId, 'declined', A);
  assert.equal(await r.get(paying.payingLastKey(rideId, A)), null);
  await paying.openPaying(w.deps, rideId, randomUUID(), A);
  assert.equal(await r.get(paying.payingSpellsKey(rideId, A)), '2', 'a fresh spell is counted');
  await r.del(`ride:${rideId}:paying`); await r.del(paying.payingSpellsKey(rideId, A));
});
