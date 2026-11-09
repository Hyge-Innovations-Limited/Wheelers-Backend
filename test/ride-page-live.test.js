// The WhatsApp booking page, live: its link opens a listen-only socket on its
// own channel; after a ride or wallet event for that rider, the page is sent
// its state at once. Against a real Redis (database 15) and Postgres.
//
//   npm run build && node scripts/run-with-env.cjs node --test --test-force-exit test/ride-page-live.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const WebSocket = require('../apps/api-gateway/node_modules/ws');

const { RedisClient } = require('../apps/api-gateway/dist/redis/client.js');
const { SocketRegistry } = require('../apps/api-gateway/dist/websocket/registry.js');
const { createGatewayWebSocketServer } = require('../apps/api-gateway/dist/websocket/server.js');
const local = require('../apps/api-gateway/dist/auth/local.js');
const live = require('../apps/api-gateway/dist/rides/ride-page-live.js');
const { startGatewayKafkaConsumer } = require('../apps/api-gateway/dist/kafka/consumer.js');

const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15';
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const prisma = new PrismaClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clients = [];
async function redis() {
  const client = new RedisClient(REDIS_URL);
  await client.connect();
  clients.push(client);
  return client;
}
const made = { users: [] };
async function rider() {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:ride-page-live:${id}`, role: 'RIDER', name: 'Ada Obi' } });
  made.users.push(id);
  return id;
}
const publisher = { publishRideEvent: async () => {}, publishNotificationEvent: async () => {}, publishDriverEvent: async () => {}, publishWalletEvent: async () => {} };

let g;
async function gateway() {
  if (g) return g;
  const registry = new SocketRegistry({ instanceId: `ride-page-${randomUUID()}`, commandRedis: await redis(), subscriberRedis: await redis() });
  await registry.start();
  const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  createGatewayWebSocketServer({
    server, jwtSecret: JWT_SECRET, allowedOrigins: new Set(), idleTimeoutMs: 60_000, registry,
    publisher, routePlanner: {}, redis: await redis(), pageOrigins: new Set(),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  g = { server, registry, url: (token) => `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}` };
  return g;
}
const sockets = [];
function open(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.inbox = [];
    socket.on('message', (raw) => socket.inbox.push(JSON.parse(raw.toString())));
    socket.once('open', () => { sockets.push(socket); resolve(socket); });
    socket.once('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    socket.once('error', reject);
  });
}
async function until(check, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(20);
  }
  return false;
}
const pageToken = (userId, scope = 'ride') => local.createWalletPageToken(userId, scope, JWT_SECRET, local.RIDE_PAGE_TOKEN_TTL_SECONDS);

test.after(async () => {
  live.setRidePageStateBuilder(undefined);
  for (const s of sockets) { try { s.terminate(); } catch { /* closed */ } }
  if (g) {
    await g.registry.shutdown().catch(() => {});
    await new Promise((resolve) => g.server.close(resolve));
  }
  for (const c of clients) await c.disconnect?.().catch?.(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

test('the booking page link opens a socket on its own channel: the rider still has no socket, so stays a WhatsApp rider', async () => {
  const { registry, url } = await gateway();
  const riderId = await rider();
  await open(url(pageToken(riderId)));
  assert.ok(await until(() => registry.isUserConnected(live.ridePageChannel(riderId))), 'listening on ride-page:<rider>');
  assert.equal(registry.hasUser(riderId), false, 'not under the rider\'s own id');
  assert.equal(await registry.isUserConnected(riderId), false);
});

test('the page socket only listens: anything it sends is refused, and nothing is done', async () => {
  const { url } = await gateway();
  const riderId = await rider();
  const socket = await open(url(pageToken(riderId)));
  for (const type of ['ride:request', 'ride:accept_offer', 'chat:send', 'driver:online', 'app:state']) {
    socket.send(JSON.stringify({ type, payload: { rideId: randomUUID(), content: 'hi', state: 'background' } }));
  }
  assert.ok(await until(() => socket.inbox.filter((m) => m.type === 'error').length === 5));
  assert.ok(socket.inbox.filter((m) => m.type === 'error').every((m) => /Unknown event type/.test(m.payload.message)));
});

test('a wallet or deposit link cannot open the socket; a bad link neither', async () => {
  const { url } = await gateway();
  const riderId = await rider();
  for (const scope of ['deposit', 'withdraw']) {
    await assert.rejects(open(url(pageToken(riderId, scope))), (e) => e.status === 401, scope);
  }
  await assert.rejects(open(url('not-a-token')), (e) => e.status === 401);
});

test('tellRidePage: nothing built when no page listens; with one, its state arrives; a failing build is quiet', async () => {
  const { registry, url } = await gateway();
  const riderId = await rider();
  const built = [];
  live.setRidePageStateBuilder(async (id) => { built.push(id); return { phase: 'offers', offers: [{ key: 'k1', priceNgn: 3000 }] }; });
  await live.tellRidePage(registry, riderId);
  assert.deepEqual(built, [], 'no page open: no work');

  const socket = await open(url(pageToken(riderId)));
  await until(() => registry.isUserConnected(live.ridePageChannel(riderId)));
  await live.tellRidePage(registry, riderId);
  assert.ok(await until(() => socket.inbox.some((m) => m.type === 'ride-page:state')));
  assert.deepEqual(socket.inbox.find((m) => m.type === 'ride-page:state').payload, { phase: 'offers', offers: [{ key: 'k1', priceNgn: 3000 }] });

  live.setRidePageStateBuilder(async () => { throw new Error('db down'); });
  await live.tellRidePage(registry, riderId);
});

test('the consumer sends the open page its state after a ride event and after a wallet event for that rider, not for another', async () => {
  const { registry, url } = await gateway();
  const riderId = await rider();
  const other = await rider();
  let n = 0;
  live.setRidePageStateBuilder(async () => ({ phase: 'offers', n: ++n }));
  const socket = await open(url(pageToken(riderId)));
  await until(() => registry.isUserConnected(live.ridePageChannel(riderId)));

  let handler;
  const memory = new Map();
  await startGatewayKafkaConsumer({
    consumer: { subscribe: async (_topics, fn) => { handler = fn; } },
    registry, publisher,
    redisClient: {
      async get(k) { return memory.get(k) ?? null; }, async set(k, v) { memory.set(k, v); }, async del(k) { memory.delete(k); },
      async setIfNotExists(k, v) { if (memory.has(k)) return false; memory.set(k, v); return true; }, async send() { return null; },
    },
  });
  const started = Date.now();
  await handler({ eventType: 'RIDE_BID_TIMEOUT', rideId: randomUUID(), riderId, timestamp: new Date().toISOString() }, { topic: 'ride.events' });
  assert.ok(await until(() => socket.inbox.some((m) => m.type === 'ride-page:state')), 'a ride event');
  assert.ok(Date.now() - started < 1000, 'within a second');
  socket.inbox.length = 0;

  await handler({ eventType: 'WALLET_CREDITED', userId: riderId, walletId: randomUUID(), amountNgn: 2000, newBalanceNgn: 5000, creditType: 'deposit', referenceId: `ref-${randomUUID()}`, timestamp: new Date().toISOString() }, { topic: 'wallet.events' });
  assert.ok(await until(() => socket.inbox.some((m) => m.type === 'ride-page:state')), 'a wallet event');
  socket.inbox.length = 0;

  await handler({ eventType: 'RIDE_BID_TIMEOUT', rideId: randomUUID(), riderId: other, timestamp: new Date().toISOString() }, { topic: 'ride.events' });
  await sleep(300);
  assert.equal(socket.inbox.filter((m) => m.type === 'ride-page:state').length, 0, 'another rider\'s event');
});
