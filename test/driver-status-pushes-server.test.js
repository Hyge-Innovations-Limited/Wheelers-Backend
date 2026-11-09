// S1 through the real ws server and the real register route (real Redis db 15, real Postgres).
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/driver-status-pushes-server.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const WebSocket = require('../apps/api-gateway/node_modules/ws');

const { RedisClient } = require('../apps/api-gateway/dist/redis/client.js');
const { SocketRegistry } = require('../apps/api-gateway/dist/websocket/registry.js');
const { createGatewayWebSocketServer } = require('../apps/api-gateway/dist/websocket/server.js');
const { appBackgroundKey } = require('../apps/api-gateway/dist/websocket/app-state.js');
const { handleRegisterPushTokenRoute } = require('../apps/api-gateway/dist/http/notification.route.js');
const local = require('../apps/api-gateway/dist/auth/local.js');

const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15';
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const prisma = new PrismaClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clients = [];
const servers = [];
const made = [];

async function redis() { const c = new RedisClient(REDIS_URL); await c.connect(); clients.push(c); return c; }
async function user() {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:s1:${id}`, role: 'DRIVER', name: 'Test Driver', phone: `+23480${Math.floor(10000000 + Math.random() * 89999999)}` } });
  made.push(id);
  return id;
}
async function until(check, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await sleep(25); }
  return false;
}
async function gateway(driverStatusPushes) {
  const commandRedis = await redis();
  const registry = new SocketRegistry({ instanceId: `s1-${randomUUID()}`, commandRedis, subscriberRedis: await redis() });
  await registry.start();
  const server = http.createServer();
  const r = await redis();
  createGatewayWebSocketServer({
    server, jwtSecret: JWT_SECRET, allowedOrigins: new Set(), idleTimeoutMs: 60_000, registry,
    publisher: { publishRideEvent: async () => {}, publishDriverEvent: async () => {}, publishNotificationEvent: async () => {} },
    routePlanner: {}, redis: r, pageOrigins: new Set(), driverStatusPushes,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { registry, redis: r, port: server.address().port };
}
function open(url) {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(url);
    s.inbox = [];
    s.on('message', (raw) => s.inbox.push(JSON.parse(raw.toString())));
    s.once('open', () => resolve(s));
    s.once('error', reject);
  });
}
const urlOf = (g, token, extra = '') => `ws://127.0.0.1:${g.port}/ws?token=${encodeURIComponent(token)}${extra}`;
async function connectApp(g, userId, extra = '') {
  const s = await open(urlOf(g, local.createLocalAccessToken(userId, JWT_SECRET), extra));
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
  await prisma.user.deleteMany({ where: { id: { in: made } } }).catch(() => {});
  await prisma.$disconnect();
});

test('ws dispatch: flag off, app:state is an unknown message and sets nothing', async () => {
  const g = await gateway(false);
  const id = await user();
  const s = await connectApp(g, id);
  const r = await reply(s, 'app:state', { state: 'background' });
  assert.equal(r.type, 'error');
  assert.match(r.payload.message, /Unknown event type/);
  assert.equal(await g.redis.get(appBackgroundKey(id)), null);
  s.close();
});

test('ws dispatch: flag on, an app socket is accepted; a Trip chat page socket and an MCP socket are refused', async () => {
  const g = await gateway(true);
  const id = await user();
  const app = await connectApp(g, id);
  const ok = await reply(app, 'app:state', { state: 'background' });
  assert.equal(ok.type, 'app:state:ok');
  assert.equal(await g.redis.get(appBackgroundKey(id)), '1');
  await reply(app, 'app:state', { state: 'active' });
  assert.equal(await g.redis.get(appBackgroundKey(id)), null);

  const other = await user();
  const mcp = await connectApp(g, other, '&client=mcp');
  const m = await reply(mcp, 'app:state', { state: 'background' });
  assert.equal(m.type, 'error');
  assert.equal(await g.redis.get(appBackgroundKey(other)), null);

  const third = await user();
  const page = await open(urlOf(g, local.createWalletPageToken(third, 'trip', JWT_SECRET, 600, randomUUID())));
  await until(() => g.registry.isUserConnected(third));
  const p = await reply(page, 'app:state', { state: 'background' });
  assert.equal(p.type, 'error');
  assert.equal(await g.redis.get(appBackgroundKey(third)), null);
  app.close(); mcp.close(); page.close();
});

// ---- register route ----
function route(token, body) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => { handleRegisterPushTokenRoute(req, res, { jwtSecret: JWT_SECRET }).catch(reject); });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const req = http.request({ port: server.address().port, method: 'POST', path: '/', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, (res) => {
        let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(data) }); });
      });
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  });
}

test('register route: channel stored; an old app re-registering keeps it; a bad channel is ignored and the token is still saved', async () => {
  const id = await user();
  const token = local.createLocalAccessToken(id, JWT_SECRET);
  const expoPushToken = `ExponentPushToken[${randomUUID()}]`;
  const stored = async () => (await prisma.notificationDevice.findUnique({ where: { expoPushToken } }))?.androidChannelId ?? null;

  assert.equal((await route(token, { expoPushToken, androidChannel: 'rides' })).status, 200);
  assert.equal(await stored(), 'rides');
  assert.equal((await route(token, { expoPushToken })).status, 200, 'old app, no channel');
  assert.equal(await stored(), 'rides');
  for (const bad of ['bad channel!', '', 'x'.repeat(65), 42]) {
    assert.equal((await route(token, { expoPushToken, androidChannel: bad })).status, 200, String(bad));
    assert.equal(await stored(), 'rides');
  }
  const fresh = `ExponentPushToken[${randomUUID()}]`;
  assert.equal((await route(token, { expoPushToken: fresh, androidChannel: 'no spaces' })).status, 200);
  const row = await prisma.notificationDevice.findUnique({ where: { expoPushToken: fresh } });
  assert.ok(row, 'token saved'); assert.equal(row.androidChannelId, null);
});
