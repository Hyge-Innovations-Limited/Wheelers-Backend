// Waiting price (Timi, 16 Nov 2026): when the free 5 minutes are over the rider is asked to cancel or keep the
// driver waiting at a price a minute (₦40–100). The driver accepts or counters; the rider accepts the counter,
// offers again or cancels. Nothing is charged until they agree; then each full minute from that moment costs
// the agreed price. Through the real HTTP route, the real ride:start socket, a real Redis (database 15) and a
// real Postgres; the chat's messages and taps with Meta faked.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/waiting-deal.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const WebSocket = require('../apps/api-gateway/node_modules/ws');

const { RedisClient } = require('../apps/api-gateway/dist/redis/client.js');
const { SocketRegistry } = require('../apps/api-gateway/dist/websocket/registry.js');
const { createGatewayWebSocketServer } = require('../apps/api-gateway/dist/websocket/server.js');
const { handleWaitingDealRoute } = require('../apps/api-gateway/dist/http/ride.route.js');
const { setWaitingDealHook, readWaitingAction } = require('../apps/api-gateway/dist/rides/waiting-deal.js');
const chat = require('../apps/api-gateway/dist/whatsapp/waiting-deal-chat.js');
const { sendDriverArrivedNotification } = require('../apps/api-gateway/dist/whatsapp-flows/whatsapp-notifier.js');
const local = require('../apps/api-gateway/dist/auth/local.js');
const { waitingClient } = require('../packages/db/dist/index.js');
const { WAITING_RATES_NGN, waitingDealTerms } = require('../packages/config/dist/index.js');

const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15';
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const prisma = new PrismaClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const minutesAgo = (m, s = 0) => new Date(Date.now() - (m * 60 + s) * 1000);

const clients = [];
async function redis() {
  const client = new RedisClient(REDIS_URL);
  await client.connect();
  clients.push(client);
  return client;
}

const made = { users: [], rides: [] };
async function user(role, name, balanceNgn) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:waiting-deal:${id}`, role, name } });
  if (balanceNgn !== undefined) await prisma.wallet.create({ data: { userId: id, balanceNgn } });
  made.users.push(id);
  return id;
}
async function waitingTrip({ arrivedAt, balanceNgn = 0 }) {
  const riderId = await user('RIDER', 'Ada Obi', balanceNgn);
  const driverUserId = await user('DRIVER', 'Tunde Bakare', 0);
  const driver = await prisma.driver.create({ data: { userId: driverUserId, kycStatus: 'APPROVED' } });
  const ride = await prisma.ride.create({ data: {
    riderId, driverId: driver.id, status: 'ARRIVED', arrivedAt, paymentMethod: 'WALLET',
    pickupLat: 6.5, pickupLng: 3.37, pickupAddress: 'Yaba', destLat: 6.62, destLng: 3.5, destAddress: 'Ikorodu',
  } });
  made.rides.push(ride.id);
  return { rideId: ride.id, riderId, driverUserId };
}

const told = [];
let g;
test.before(async () => {
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};
  const commandRedis = await redis();
  await commandRedis.send('FLUSHDB');
  const registry = new SocketRegistry({ instanceId: `waiting-deal-${randomUUID()}`, commandRedis, subscriberRedis: await redis() });
  await registry.start();
  const server = http.createServer((req, res) => {
    const m = /^\/rides\/([^/]+)\/waiting$/.exec(new URL(req.url, 'http://x').pathname);
    if (m && req.method === 'POST') return void handleWaitingDealRoute(req, res, { jwtSecret: JWT_SECRET, redisClient: commandRedis }, m[1]);
    res.statusCode = 404; res.end();
  });
  createGatewayWebSocketServer({
    server, jwtSecret: JWT_SECRET, allowedOrigins: new Set(), idleTimeoutMs: 60_000, registry,
    publisher: { publishRideEvent: async () => {}, publishDriverEvent: async () => {} },
    routePlanner: {}, redis: commandRedis,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  setWaitingDealHook(async (change) => { told.push(change); });
  g = { server, registry, port: server.address().port };
});

async function act(userId, rideId, body) {
  const res = await fetch(`http://127.0.0.1:${g.port}/rides/${rideId}/waiting`, {
    method: 'POST',
    headers: { authorization: `Bearer ${local.createLocalAccessToken(userId, JWT_SECRET)}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const sockets = [];
function open(userId) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${g.port}/ws?token=${local.createLocalAccessToken(userId, JWT_SECRET)}`);
    socket.inbox = [];
    socket.on('message', (raw) => socket.inbox.push(JSON.parse(raw.toString())));
    socket.once('open', () => { sockets.push(socket); resolve(socket); });
    socket.once('error', reject);
  });
}
async function start(socket, trip) {
  socket.inbox.length = 0;
  socket.send(JSON.stringify({ type: 'ride:start', payload: { rideId: trip.rideId, riderId: trip.riderId, lockedFareNgn: 5000, paymentMethod: 'WALLET', canConfirmWaiting: true } }));
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    const hit = socket.inbox.find((m) => m.type === 'ride:start:accepted' || m.type === 'error');
    if (hit) return hit.type === 'error' ? hit.payload.code ?? hit.payload.message : 'STARTED';
    await sleep(20);
  }
  throw new Error('no answer to ride:start');
}

test('the prices: ₦40 to ₦100 a minute in tens; anything else is refused', () => {
  assert.deepEqual([...WAITING_RATES_NGN], [40, 50, 60, 70, 80, 90, 100]);
  assert.deepEqual(readWaitingAction({ action: 'offer', ngn: 60 }), { action: 'offer', ngn: 60 });
  for (const bad of [{ action: 'offer', ngn: 65 }, { action: 'offer', ngn: 30 }, { action: 'offer', ngn: 110 }, { action: 'take', ngn: 60 }, null]) {
    assert.throws(() => readWaitingAction(bad), (e) => e.status === 400);
  }
  // The meter: free until they agree, then the agreed price; ₦0 a minute before.
  const arrivedAt = new Date('2026-11-16T10:00:00Z');
  assert.deepEqual(waitingDealTerms({ arrivedAt }), { freeSeconds: 300, ngnPerMinute: 0 });
  assert.deepEqual(waitingDealTerms({ arrivedAt, waitingRateNgn: 60, waitingAgreedAt: new Date('2026-11-16T10:07:00Z') }), { freeSeconds: 420, ngnPerMinute: 60 });
});

test('rider offers, driver counters, rider takes the counter: agreed at that price, from that moment', async () => {
  const trip = await waitingTrip({ arrivedAt: minutesAgo(6) });
  told.length = 0;

  let r = await act(trip.riderId, trip.rideId, { action: 'offer', ngn: 60 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.waiting.deal.offer && [r.body.waiting.deal.offer.by, r.body.waiting.deal.offer.ngn], ['rider', 60]);
  assert.equal(r.body.waiting.ngnPerMinute, 0, 'nothing charged yet');

  // The driver can only take exactly the price on the table.
  r = await act(trip.driverUserId, trip.rideId, { action: 'accept', ngn: 70 });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'OFFER_CHANGED');

  r = await act(trip.driverUserId, trip.rideId, { action: 'offer', ngn: 80 });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.waiting.deal.offer.by, r.body.waiting.deal.offer.ngn], ['driver', 80]);

  // Offering the driver's own price is taking it.
  r = await act(trip.riderId, trip.rideId, { action: 'offer', ngn: 80 });
  assert.equal(r.status, 200);
  assert.equal(r.body.waiting.deal.rateNgn, 80);
  assert.equal(r.body.waiting.deal.offer, null);
  assert.equal(r.body.waiting.ngnPerMinute, 80);
  const row = await waitingClient.state(trip.rideId);
  assert.ok(Math.abs(row.waitingAgreedAt.getTime() - Date.now()) < 5000);

  // Once agreed, nothing more.
  r = await act(trip.driverUserId, trip.rideId, { action: 'offer', ngn: 100 });
  assert.equal(r.body.code, 'AGREED');

  await sleep(50);
  assert.deepEqual(told.map((c) => [c.by, c.kind, c.ngn]), [['rider', 'offer', 60], ['driver', 'offer', 80], ['rider', 'agreed', 80]]);
  assert.equal(told[0].driverUserId, trip.driverUserId);
});

test('who may do what: still free, a driver opening, a stranger, a trip that moved on', async () => {
  const early = await waitingTrip({ arrivedAt: minutesAgo(3) });
  assert.equal((await act(early.riderId, early.rideId, { action: 'offer', ngn: 50 })).body.code, 'STILL_FREE');

  const trip = await waitingTrip({ arrivedAt: minutesAgo(7) });
  assert.equal((await act(trip.driverUserId, trip.rideId, { action: 'offer', ngn: 90 })).body.code, 'NO_OFFER', 'the driver answers, never opens');
  const stranger = await user('RIDER', 'Someone Else');
  assert.equal((await act(stranger, trip.rideId, { action: 'offer', ngn: 50 })).status, 403);
  assert.equal((await act(trip.riderId, randomUUID(), { action: 'offer', ngn: 50 })).status, 404);

  await prisma.ride.update({ where: { id: trip.rideId }, data: { status: 'IN_PROGRESS' } });
  assert.equal((await act(trip.riderId, trip.rideId, { action: 'offer', ngn: 50 })).body.code, 'NOT_WAITING');
});

test('the rider may change an offer; the same offer again sends nothing new; offers stop at the cap', async () => {
  const trip = await waitingTrip({ arrivedAt: minutesAgo(8) });
  told.length = 0;
  await act(trip.riderId, trip.rideId, { action: 'offer', ngn: 40 });
  await act(trip.riderId, trip.rideId, { action: 'offer', ngn: 40 });
  await act(trip.riderId, trip.rideId, { action: 'offer', ngn: 50 });
  await sleep(50);
  assert.deepEqual(told.map((c) => c.ngn), [40, 50], 'the repeat was not sent');
  const codes = [];
  for (let i = 0; i < 10; i += 1) codes.push((await act(i % 2 ? trip.riderId : trip.driverUserId, trip.rideId, { action: 'offer', ngn: i % 2 ? 60 : 90 })).body.code);
  // 2 offers above + 8 here reach the cap: the driver's next counter is refused. The rider's ₦60 after it
  // is the offer still on the table (nothing new), so it is not refused, and nothing is sent.
  assert.deepEqual(codes, [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'TOO_MANY', undefined]);
  assert.equal((await waitingClient.state(trip.rideId)).waitingOfferCount, 10);
});

test('the start: nothing agreed is nothing charged; agreed is charged only from the agreement', async () => {
  const none = await waitingTrip({ arrivedAt: minutesAgo(15), balanceNgn: 1000 });
  assert.equal(await start(await open(none.driverUserId), none), 'STARTED');
  const noneRow = await waitingClient.state(none.rideId);
  assert.deepEqual([noneRow.waitingFeeNgn, noneRow.waitingStoppedAt], [null, null], 'no fee, nothing asked');

  const deal = await waitingTrip({ arrivedAt: minutesAgo(15), balanceNgn: 1000 });
  // Agreed ₦60 three and a half minutes ago (ten minutes after arriving): 3 full minutes.
  await prisma.ride.update({ where: { id: deal.rideId }, data: { waitingRateNgn: 60, waitingAgreedAt: minutesAgo(3, 30) } });
  assert.equal(await start(await open(deal.driverUserId), deal), 'STARTED');
  const row = await waitingClient.state(deal.rideId);
  assert.deepEqual([row.waitingMinutes, Number(row.waitingFeeNgn), row.waitingPaid], [3, 180, true]);
});

test('the chat: the question, the prices, the counter; taps offer and accept; Cancel ride is the usual cancel', async () => {
  const ask = chat.waitingAskMessage(5);
  assert.match(ask.body.text, /^Your driver has waited 5 min\./);
  assert.deepEqual(ask.action.buttons.map((b) => [b.reply.id, b.reply.title]), [['wait_keep', 'Keep driver waiting'], ['wait_cancel', 'Cancel ride']]);
  const list = chat.waitingRatesMessage();
  assert.deepEqual(list.action.sections[0].rows.map((r) => r.id), WAITING_RATES_NGN.map((n) => `wait_rate:${n}`));
  for (const row of list.action.sections[0].rows) assert.ok(row.title.length <= 24, row.title);
  const counter = chat.driverCounterMessage(100);
  for (const b of counter.action.buttons) assert.ok(b.reply.title.length <= 20, b.reply.title);
  assert.equal(counter.action.buttons[0].reply.id, 'wait_ok:100');
  assert.ok(['wait_keep', 'wait_cancel', 'wait_rate:60', 'wait_ok:80'].every(chat.isWaitingDealReply));
  assert.ok(!chat.isWaitingDealReply('trip_cancel') && !chat.isWaitingDealReply(undefined));

  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).startsWith('https://graph.facebook.com/')) { sent.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); }
    return realFetch(url, init);
  };
  try {
    const meta = { metaAccessToken: 't', metaPhoneNumberId: 'p' };
    const trip = await waitingTrip({ arrivedAt: minutesAgo(6) });
    await prisma.ride.update({ where: { id: trip.rideId }, data: { status: 'ARRIVED' } });
    let cancelled = 0;
    await chat.handleWaitingDealTap(meta, trip.riderId, '+2348000000000', 'wait_keep', async () => { cancelled += 1; });
    assert.equal(sent.at(-1).interactive.type, 'list');
    await chat.handleWaitingDealTap(meta, trip.riderId, '+2348000000000', 'wait_rate:50', async () => {});
    assert.equal(sent.at(-1).text.body, 'Sent ₦50/min. Waiting for your driver.');
    await act(trip.driverUserId, trip.rideId, { action: 'offer', ngn: 70 });
    await chat.handleWaitingDealTap(meta, trip.riderId, '+2348000000000', 'wait_ok:70', async () => {});
    assert.equal(sent.at(-1).text.body, 'Agreed: ₦70/min. Waiting time counts from now.');
    assert.equal((await waitingClient.state(trip.rideId)).waitingRateNgn, 70);
    await chat.handleWaitingDealTap(meta, trip.riderId, '+2348000000000', 'wait_cancel', async () => { cancelled += 1; });
    assert.equal(cancelled, 1);

    // "Your driver is here": the free minutes, no fixed price any more.
    sent.length = 0;
    await sendDriverArrivedNotification(meta, '+2348000000000', { driverName: 'Tunde', waiting: { freeSeconds: 300, ngnPerMinute: 70 } });
    const words = JSON.stringify(sent);
    assert.match(words, /Free waiting: 5 min\./);
    assert.doesNotMatch(words, /₦70\/min/);
  } finally {
    global.fetch = realFetch;
  }
});

test.after(async () => {
  setWaitingDealHook(undefined);
  for (const s of sockets) { try { s.terminate(); } catch { /* closed */ } }
  await g.registry.shutdown().catch(() => {});
  await new Promise((resolve) => g.server.close(resolve));
  await prisma.userActivityEvent.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.walletReservation.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.transaction.deleteMany({ where: { referenceId: { in: made.rides } } });
  await prisma.wallet.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.driver.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
  for (const c of clients) await c.disconnect().catch(() => {});
});
