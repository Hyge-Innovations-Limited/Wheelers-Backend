// A driver who has not passed KYC cannot go online or bid, whatever the app
// shows them. Against a real Redis (database 15) and a real Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/driver-kyc-gate.test.js

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

const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15';
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const prisma = new PrismaClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clients = [];
const made = { users: [], rides: [] };
const published = [];
let g;

async function redis() {
  const client = new RedisClient(REDIS_URL);
  await client.connect();
  clients.push(client);
  return client;
}

async function driver(kycStatus) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:kyc-gate:${id}`, role: 'DRIVER', name: 'Test Driver' } });
  made.users.push(id);
  await prisma.driver.create({ data: { userId: id, kycStatus } });
  return id;
}

test.before(async () => {
  console.info = () => {};
  console.warn = () => {};
  const commandRedis = await redis();
  const registry = new SocketRegistry({ instanceId: `kyc-${randomUUID()}`, commandRedis, subscriberRedis: await redis() });
  await registry.start();
  const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  createGatewayWebSocketServer({
    server, jwtSecret: JWT_SECRET, allowedOrigins: new Set(), idleTimeoutMs: 60_000, registry,
    publisher: { publishRideEvent: async (e) => { published.push(e); }, publishDriverEvent: async (e) => { published.push(e); } },
    routePlanner: {}, redis: commandRedis,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  g = { server, registry, port: server.address().port };
});

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
/** Send one message; the answer is its accepted type or the error code. */
async function ask(socket, type, payload) {
  socket.inbox.length = 0;
  socket.send(JSON.stringify({ type, payload }));
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    const hit = socket.inbox.find((m) => m.type === `${type}:accepted` || m.type === 'error');
    if (hit) return hit.type === 'error' ? hit.payload.code ?? hit.payload.message : 'ACCEPTED';
    await sleep(20);
  }
  throw new Error(`no answer to ${type}`);
}

test('a driver who has not finished KYC, or is in review, or was rejected, cannot go online', async () => {
  for (const status of ['PENDING', 'SUBMITTED', 'REJECTED']) {
    const socket = await open(await driver(status));
    published.length = 0;
    assert.equal(await ask(socket, 'driver:online', { lat: 6.5, lng: 3.37 }), 'KYC_REQUIRED', status);
    assert.equal(published.length, 0, `${status}: nothing published`);
  }
});

test('an approved driver goes online as before', async () => {
  const socket = await open(await driver('APPROVED'));
  published.length = 0;
  assert.equal(await ask(socket, 'driver:online', { lat: 6.5, lng: 3.37 }), 'ACCEPTED');
  assert.equal(published.filter((e) => e.eventType === 'DRIVER_ONLINE').length, 1);
});

test('an unapproved driver cannot bid on a request', async () => {
  const socket = await open(await driver('PENDING'));
  const code = await ask(socket, 'driver:accept', { rideId: randomUUID(), riderId: randomUUID(), agreedFareNgn: 3000 });
  assert.equal(code, 'KYC_REQUIRED');
});

test('approval is picked up without a restart', async () => {
  const userId = await driver('SUBMITTED');
  const socket = await open(userId);
  assert.equal(await ask(socket, 'driver:online', { lat: 6.5, lng: 3.37 }), 'KYC_REQUIRED');
  await prisma.driver.update({ where: { userId }, data: { kycStatus: 'APPROVED' } });
  assert.equal(await ask(socket, 'driver:online', { lat: 6.5, lng: 3.37 }), 'ACCEPTED');
});

test.after(async () => {
  for (const s of sockets) { try { s.terminate(); } catch { /* closed */ } }
  await g.registry.shutdown().catch(() => {});
  await new Promise((resolve) => g.server.close(resolve));
  await prisma.driverShift?.deleteMany?.({ where: { driver: { userId: { in: made.users } } } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
  await prisma.$disconnect();
  for (const c of clients) await c.disconnect().catch(() => {});
});
