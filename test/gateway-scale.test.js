// What lets the gateway hold thousands of sockets: presence in Redis, a Redis
// client that comes back, the offline grace shared between processes, one
// process running the background jobs, and the guards on every socket.
// Against a real Redis (database 15, emptied first) and a real Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/gateway-scale.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const WebSocket = require('../apps/api-gateway/node_modules/ws');

const { RedisClient } = require('../apps/api-gateway/dist/redis/client.js');
const { SocketRegistry } = require('../apps/api-gateway/dist/websocket/registry.js');
const { createRateLimiter } = require('../apps/api-gateway/dist/websocket/rate-limit.js');
const { createDriverOfflineGrace, DRIVER_OFFLINE_GRACE_MS } = require('../apps/api-gateway/dist/websocket/driver-offline-grace.js');
const { createLeaderLock } = require('../apps/api-gateway/dist/cluster/leader.js');
const { createGatewayWebSocketServer } = require('../apps/api-gateway/dist/websocket/server.js');
const local = require('../apps/api-gateway/dist/auth/local.js');
const { driverClient, driverPresence, PRESENCE_FRESH_MS } = require('../packages/db/dist/index.js');

const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15';
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const YABA = { lat: 6.5095, lng: 3.3711 };
const prisma = new PrismaClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { info: console.info, warn: console.warn };

const clients = [];
async function redis() {
  const client = new RedisClient(REDIS_URL);
  await client.connect();
  clients.push(client);
  return client;
}

async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(50);
  }
  return false;
}

const madeUsers = [];
async function makeDriver(status = 'ONLINE') {
  const userId = randomUUID();
  await prisma.user.create({ data: { id: userId, privyDid: `local:${userId}`, role: 'DRIVER', name: 'Scale Test', phone: `+23480${Math.floor(10000000 + Math.random() * 89999999)}` } });
  const driver = await prisma.driver.create({ data: { userId, status, kycStatus: 'APPROVED' } });
  madeUsers.push(userId);
  return { userId, driverId: driver.id, token: local.createLocalAccessToken(userId, JWT_SECRET) };
}

let main;
test.before(async () => {
  console.info = () => {};
  console.warn = () => {};
  main = await redis();
  await main.send('FLUSHDB');
  driverPresence.configure((...args) => main.send(...args));
});

test.after(async () => {
  console.info = quiet.info;
  console.warn = quiet.warn;
  driverPresence.configure(null);
  await prisma.driverLocationPoint.deleteMany({ where: { driver: { userId: { in: madeUsers } } } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { userId: { in: madeUsers } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: madeUsers } } }).catch(() => {});
  await main.send('FLUSHDB').catch(() => {});
  for (const client of clients) await client.disconnect().catch(() => {});
  await prisma.$disconnect();
});

// ── Rate limit ──────────────────────────────────────────────────────────────

test('a socket may burst, then is held to its rate, then earns it back', () => {
  let now = 0;
  const limiter = createRateLimiter(10, 40, () => now);
  let passed = 0;
  for (let i = 0; i < 100; i += 1) if (limiter.take()) passed += 1;
  assert.equal(passed, 40, 'the burst, and no more');
  now += 1000;
  passed = 0;
  for (let i = 0; i < 100; i += 1) if (limiter.take()) passed += 1;
  assert.equal(passed, 10, 'one second earns ten');
  now += 60_000;
  passed = 0;
  for (let i = 0; i < 100; i += 1) if (limiter.take()) passed += 1;
  assert.equal(passed, 40, 'a long quiet spell never earns more than the burst');
});

// ── Redis client ────────────────────────────────────────────────────────────

test('the Redis client comes back after its connection is cut, and so do its subscriptions', async () => {
  const commands = await redis();
  const subscriber = await redis();
  const killer = await redis();
  const heard = [];
  subscriber.onMessage((channel, payload) => heard.push(`${channel}:${payload}`));
  await subscriber.subscribe('scale-test:channel');

  await commands.set('scale-test:key', 'before');
  const id = await commands.send('CLIENT', 'ID');
  await killer.send('CLIENT', 'KILL', 'ID', String(id));
  // Every subscriber on this test channel is cut too.
  const list = String(await killer.send('CLIENT', 'LIST', 'TYPE', 'pubsub'));
  for (const line of list.split('\n')) {
    const match = /(?:^|\s)id=(\d+)/.exec(line);
    if (match && /\bsub=1\b/.test(line)) await killer.send('CLIENT', 'KILL', 'ID', match[1]).catch(() => {});
  }

  // A command sent while it is down waits for the reconnect instead of failing.
  assert.equal(await commands.get('scale-test:key'), 'before');
  assert.equal(commands.isConnected, true);

  assert.ok(await until(() => subscriber.isConnected), 'the subscriber reconnected');
  assert.ok(
    await until(async () => (await killer.publish('scale-test:channel', 'hello')) > 0),
    'and is listening on its channel again',
  );
  assert.ok(await until(() => heard.includes('scale-test:channel:hello')));
});

test('a client that was closed on purpose does not reconnect, and says so at once', async () => {
  const client = new RedisClient(REDIS_URL);
  await client.connect();
  await client.disconnect();
  const started = Date.now();
  await assert.rejects(() => client.get('anything'), /not connected/);
  assert.ok(Date.now() - started < 500, 'no three-second wait for a client nobody will reopen');
});

// ── Presence ────────────────────────────────────────────────────────────────

test('a heartbeat goes to Redis every time and to Postgres once per window', async () => {
  const d = await makeDriver('ONLINE');
  const first = await driverPresence.noteLocation(d.driverId, YABA.lat, YABA.lng);
  const second = await driverPresence.noteLocation(d.driverId, YABA.lat + 0.001, YABA.lng);
  assert.equal(first.flushDb, true);
  assert.equal(second.flushDb, false);
  const record = await driverPresence.get(d.driverId);
  assert.ok(Math.abs(record.lat - (YABA.lat + 0.001)) < 1e-6, 'Redis has the newer position');

  // A pong shares the same window: one write per driver per window, whatever the heartbeat.
  assert.equal((await driverPresence.noteAlive(d.driverId)).flushDb, false);

  // When the pong is the one that opens a new window, it carries the latest position.
  await main.send('DEL', `driver:dbflush:${d.driverId}`);
  const pong = await driverPresence.noteAlive(d.driverId);
  assert.equal(pong.flushDb, true);
  assert.ok(Math.abs(pong.lat - (YABA.lat + 0.001)) < 1e-6);
  await prisma.driver.update({ where: { id: d.driverId }, data: { lat: null, lng: null } });
  await main.send('DEL', `driver:dbflush:${d.driverId}`);
  await driverClient.noteAlive(d.userId, d.driverId);
  const row = await prisma.driver.findUnique({ where: { id: d.driverId } });
  assert.ok(Math.abs(row.lat - (YABA.lat + 0.001)) < 1e-6, 'and the row gets it');

  await driverPresence.remove(d.driverId);
  assert.equal(await driverPresence.get(d.driverId), null);
});

test('the driver row is written on the first heartbeat and left alone on the next', async () => {
  const d = await makeDriver('ONLINE');
  await driverClient.updateLocation(d.driverId, YABA.lat, YABA.lng);
  const after1 = await prisma.driver.findUnique({ where: { id: d.driverId } });
  assert.ok(Math.abs(after1.lat - YABA.lat) < 1e-6);
  await sleep(20);
  await driverClient.updateLocation(d.driverId, YABA.lat + 0.002, YABA.lng);
  const after2 = await prisma.driver.findUnique({ where: { id: d.driverId } });
  assert.equal(after2.lastSeenAt.getTime(), after1.lastSeenAt.getTime(), 'no second write inside the window');
  assert.ok(Math.abs(after2.lat - YABA.lat) < 1e-6);

  // Whoever reads the driver still sees the newest position and time.
  const seen = await driverClient.findById(d.driverId);
  assert.ok(Math.abs(seen.lat - (YABA.lat + 0.002)) < 1e-6);
  assert.ok(seen.lastSeenAt.getTime() > after2.lastSeenAt.getTime());
  await driverClient.markOffline(d.driverId);
  assert.equal(await driverPresence.get(d.driverId), null, 'going off shift forgets them');
});

test('matching finds live drivers near the pickup from Redis, nearest first', async () => {
  await main.send('FLUSHDB');
  const near = await makeDriver('ONLINE');
  const nearer = await makeDriver('ONLINE');
  const far = await makeDriver('ONLINE');
  const silent = await makeDriver('ONLINE');
  const onTrip = await makeDriver('ON_RIDE');
  const offShift = await makeDriver('OFFLINE');
  const now = Date.now();
  await driverPresence.noteLocation(near.driverId, YABA.lat + 0.009, YABA.lng, now);
  await driverPresence.noteLocation(nearer.driverId, YABA.lat + 0.002, YABA.lng, now);
  await driverPresence.noteLocation(far.driverId, YABA.lat + 0.2, YABA.lng, now);
  await driverPresence.noteLocation(silent.driverId, YABA.lat, YABA.lng, now - PRESENCE_FRESH_MS - 1000);
  await driverPresence.noteLocation(onTrip.driverId, YABA.lat, YABA.lng, now);
  await driverPresence.noteLocation(offShift.driverId, YABA.lat, YABA.lng, now);

  const found = await driverClient.findNearby(YABA.lat, YABA.lng, 5, 10);
  assert.deepEqual(found.map((f) => f.id), [nearer.driverId, near.driverId]);
  assert.ok(found[0].distanceKm < found[1].distanceKm);
  assert.equal(found[0].userId, nearer.userId);

  // Nobody near: Redis answered, so Postgres is not asked and the answer is "none".
  assert.deepEqual(await driverClient.findNearby(9.0765, 7.3986, 5, 10), []);
});

test('with Redis empty or unreachable, matching asks Postgres as it always did', async () => {
  await main.send('FLUSHDB');
  const d = await makeDriver('ONLINE');
  await prisma.driver.update({ where: { id: d.driverId }, data: { lat: YABA.lat, lng: YABA.lng, lastSeenAt: new Date() } });
  const found = await driverClient.findNearby(YABA.lat, YABA.lng, 5, 50);
  assert.ok(found.some((f) => f.id === d.driverId), 'an empty index falls back to the table');

  driverPresence.configure(() => Promise.reject(new Error('Redis is down')));
  try {
    const stillFound = await driverClient.findNearby(YABA.lat, YABA.lng, 5, 50);
    assert.ok(stillFound.some((f) => f.id === d.driverId));
    assert.deepEqual(await driverPresence.noteLocation(d.driverId, YABA.lat, YABA.lng), { flushDb: true });
  } finally {
    driverPresence.configure((...args) => main.send(...args));
  }
});

// ── Two gateway processes ───────────────────────────────────────────────────

async function twoRegistries() {
  const a = new SocketRegistry({ instanceId: `a-${randomUUID()}`, commandRedis: await redis(), subscriberRedis: await redis() });
  const b = new SocketRegistry({ instanceId: `b-${randomUUID()}`, commandRedis: await redis(), subscriberRedis: await redis() });
  await a.start();
  await b.start();
  return { a, b };
}

function fakeSocket() {
  const sent = [];
  return { OPEN: 1, readyState: 1, sent, send: (m) => sent.push(JSON.parse(m)), close() { this.readyState = 3; } };
}

test('a user connected to one process is reachable and visible from the other', async () => {
  const { a, b } = await twoRegistries();
  const userId = randomUUID();
  const socket = fakeSocket();
  await a.register(socket, { userId, role: 'DRIVER' });

  assert.equal(await b.isUserConnected(userId), true);
  await b.sendToUser(userId, 'ride:new_request', { rideId: 'r1' });
  assert.ok(await until(() => socket.sent.some((m) => m.type === 'ride:new_request')));

  await a.unregister(socket);
  assert.equal(await b.isUserConnected(userId), false);
  await a.shutdown();
  await b.shutdown();
});

test('a process that died is not mistaken for a live one', async () => {
  const { a, b } = await twoRegistries();
  const userId = randomUUID();
  // A process that crashed: its name is still in the user's set, but it no longer says it is alive.
  await main.sadd(`gateway:user:${userId}:instances`, 'crashed-instance');
  assert.equal(await b.isUserConnected(userId), false);
  assert.ok(
    await until(async () => (await main.smembers(`gateway:user:${userId}:instances`)).length === 0),
    'and its name is struck off',
  );

  // A clean stop closes every socket with "service restart" and removes the process from Redis.
  const socket = fakeSocket();
  let closedWith = null;
  socket.close = (code) => { closedWith = code; };
  await a.register(socket, { userId, role: 'DRIVER' });
  await a.shutdown();
  assert.equal(closedWith, 1012);
  assert.equal(await b.isUserConnected(userId), false);
  await b.shutdown();
});

test('only one process runs the background jobs, and the other takes over when it stops', async () => {
  const name = `t${Date.now()}`;
  const first = createLeaderLock(await redis(), 'instance-one', name);
  const second = createLeaderLock(await redis(), 'instance-two', name);
  assert.equal(await first.isLeader(), true);
  assert.equal(await second.isLeader(), false);
  assert.equal(await first.isLeader(), true, 'and keeps it');
  await second.release();
  assert.equal(await first.isLeader(), true, 'a release by someone who does not hold it changes nothing');
  await first.release();
  assert.equal(await second.isLeader(), true);
  assert.equal(await first.isLeader(), false);
});

// ── Offline grace ───────────────────────────────────────────────────────────

function graceWith({ connected }) {
  const published = [];
  const registry = { isUserConnected: async () => connected.value, sendToUser: async () => {} };
  const publisher = { publishDriverEvent: async (event) => { published.push(event); } };
  return { published, registry, publisher };
}

test('a driver whose socket died and never came back goes offline once, whichever process notices', async () => {
  await main.send('FLUSHDB');
  const connected = { value: false };
  const { published, registry, publisher } = graceWith({ connected });
  const processA = createDriverOfflineGrace({ redis: await redis(), registry, publisher });
  const processB = createDriverOfflineGrace({ redis: await redis(), registry, publisher });
  const driverId = randomUUID();
  const userId = randomUUID();
  const closedAt = Date.now() - DRIVER_OFFLINE_GRACE_MS - 1000;

  await processA.schedule({ userId, driverId }, closedAt);
  assert.equal(await processA.sweep(closedAt + 1000), 0, 'not due yet');

  const handled = await Promise.all([processA.sweep(), processB.sweep(), processA.sweep(), processB.sweep()]);
  assert.equal(handled.reduce((x, y) => x + y, 0), 1, 'claimed by exactly one');
  await sleep(50);
  assert.equal(published.length, 1);
  assert.equal(published[0].eventType, 'DRIVER_OFFLINE');
  assert.equal(published[0].driverId, driverId);
  assert.equal(await processB.sweep(), 0, 'and nothing is left to do');
});

test('a driver who reconnected, even to another process, stays online', async () => {
  const connected = { value: true };
  const { published, registry, publisher } = graceWith({ connected });
  const grace = createDriverOfflineGrace({ redis: await redis(), registry, publisher });
  const driverId = randomUUID();
  await grace.schedule({ userId: randomUUID(), driverId }, Date.now() - DRIVER_OFFLINE_GRACE_MS - 1000);
  assert.equal(await grace.sweep(), 1);
  await sleep(50);
  assert.equal(published.length, 0);

  // Reconnecting cancels the grace outright.
  await grace.schedule({ userId: randomUUID(), driverId }, Date.now() - DRIVER_OFFLINE_GRACE_MS - 1000);
  await grace.cancel(driverId);
  assert.equal(await grace.sweep(), 0);
});

test('a driver still heard from over HTTP is given another grace, then goes offline when that stops', async () => {
  const connected = { value: false };
  const { published, registry, publisher } = graceWith({ connected });
  const grace = createDriverOfflineGrace({ redis: await redis(), registry, publisher });
  const driverId = randomUUID();
  const t0 = Date.now();
  await driverPresence.noteLocation(driverId, YABA.lat, YABA.lng, t0);
  await grace.schedule({ userId: randomUUID(), driverId }, t0 - DRIVER_OFFLINE_GRACE_MS);

  assert.equal(await grace.sweep(t0 + 1), 1);
  await sleep(50);
  assert.equal(published.length, 0, 'kept online');
  assert.equal(await grace.sweep(t0 + 2), 0, 'and not looked at again until the new grace ends');

  const later = t0 + PRESENCE_FRESH_MS + DRIVER_OFFLINE_GRACE_MS;
  assert.equal(await grace.sweep(later), 1);
  await sleep(50);
  assert.equal(published.length, 1, 'silence everywhere: offline');
  assert.equal(await driverPresence.get(driverId), null);
});

// ── The socket server's guards ──────────────────────────────────────────────

async function gateway(options = {}) {
  const server = http.createServer((_req, res) => res.end('ok'));
  const commandRedis = await redis();
  if (options.slowRedisMs) {
    // Redis under load: every write the registry makes takes this long.
    const sadd = commandRedis.sadd.bind(commandRedis);
    const slowRedisMs = options.slowRedisMs;
    commandRedis.sadd = async (...a) => { await sleep(slowRedisMs); return sadd(...a); };
    delete options.slowRedisMs;
  }
  const registry = new SocketRegistry({ instanceId: `ws-${randomUUID()}`, commandRedis, subscriberRedis: await redis() });
  await registry.start();
  const ws = createGatewayWebSocketServer({
    server,
    jwtSecret: JWT_SECRET,
    allowedOrigins: new Set(),
    idleTimeoutMs: 60_000,
    registry,
    publisher: { publishDriverEvent: async () => {}, publishRideEvent: async () => {} },
    routePlanner: {},
    redis: await redis(),
    ...options,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, registry, ws, url: (token) => `ws://127.0.0.1:${port}/ws?token=${token}` };
}

function open(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.inbox = [];
    socket.on('message', (raw) => socket.inbox.push(JSON.parse(raw.toString())));
    socket.once('open', () => resolve(socket));
    socket.once('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    socket.once('error', reject);
  });
}

const closed = (socket) => new Promise((resolve) => socket.once('close', (code) => resolve(code)));

test('a message larger than the limit closes the socket', async () => {
  const g = await gateway({ maxPayloadBytes: 1024 });
  const d = await makeDriver('OFFLINE');
  const socket = await open(g.url(d.token));
  const end = closed(socket);
  socket.send(JSON.stringify({ type: 'ping', payload: { junk: 'x'.repeat(5000) } }));
  assert.equal(await end, 1009);
  await g.registry.shutdown();
  g.server.close();
});

test('a socket that floods is told to slow down, then closed; a normal one is untouched', async () => {
  const g = await gateway({ rateLimitPerSecond: 5, rateLimitBurst: 10 });
  const flooder = await makeDriver('OFFLINE');
  const normal = await makeDriver('OFFLINE');
  const loud = await open(g.url(flooder.token));
  const calm = await open(g.url(normal.token));
  const end = closed(loud);
  for (let i = 0; i < 400; i += 1) loud.send(JSON.stringify({ type: 'not:a:real:event', payload: {} }));
  assert.equal(await end, 1008);
  assert.ok(loud.inbox.some((m) => m.payload && m.payload.code === 'RATE_LIMITED'));
  assert.ok(loud.inbox.filter((m) => m.type === 'error').length < 30, 'it is not answered once per dropped message');

  calm.send(JSON.stringify({ type: 'not:a:real:event', payload: {} }));
  assert.ok(await until(() => calm.inbox.length === 1));
  assert.equal(calm.readyState, WebSocket.OPEN);
  assert.ok(g.ws.stats().rateLimited >= 200);
  calm.close();
  await g.registry.shutdown();
  g.server.close();
});

test('a bad token hears 401; when sign-ins are backed up a good one hears 503 and may retry', async () => {
  const g = await gateway({ maxPendingUpgrades: 0 });
  const d = await makeDriver('OFFLINE');
  await assert.rejects(() => open(g.url('not-a-token')), (error) => error.status === 401);
  await assert.rejects(() => open(g.url(d.token)), (error) => error.status === 503);
  assert.equal(g.ws.stats().refusedBusy, 1);
  await g.registry.shutdown();
  g.server.close();
});

test('a driver who drops and reconnects inside the grace is never taken offline', async () => {
  const g = await gateway();
  const d = await makeDriver('ONLINE');
  const first = await open(g.url(d.token));
  const gone = closed(first);
  first.close();
  await gone;
  assert.ok(await until(async () => (await main.send('ZSCORE', 'gateway:driver-offline:due', d.driverId)) !== null), 'the grace began');
  const second = await open(g.url(d.token));
  assert.ok(await until(async () => (await main.send('ZSCORE', 'gateway:driver-offline:due', d.driverId)) === null), 'and ended on reconnect');
  second.close();
  await g.registry.shutdown();
  g.server.close();
});

test('what the app says the instant its socket opens is heard, however slow Redis is', async () => {
  const g = await gateway({ slowRedisMs: 300 });
  const d = await makeDriver('OFFLINE');
  const socket = new WebSocket(g.url(d.token));
  const inbox = [];
  socket.on('message', (raw) => inbox.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('open', () => {
      socket.send(JSON.stringify({ type: 'first:words', payload: {} }));
      resolve();
    });
  });
  assert.ok(await until(() => inbox.some((m) => m.type === 'error' && /first:words/.test(m.payload.message)), 2000), 'the first message was answered');
  socket.close();
  await g.registry.shutdown();
  g.server.close();
});

test('after a restart, thousands of graces falling due together are all worked through', async () => {
  await main.send('FLUSHDB');
  const connected = { value: false };
  const { published, registry, publisher } = graceWith({ connected });
  const grace = createDriverOfflineGrace({ redis: await redis(), registry, publisher });
  const closedAt = Date.now() - DRIVER_OFFLINE_GRACE_MS - 1000;
  const drivers = Array.from({ length: 350 }, () => ({ userId: randomUUID(), driverId: randomUUID() }));
  await Promise.all(drivers.map((d) => grace.schedule(d, closedAt)));

  const [first, second] = await Promise.all([grace.sweep(), grace.sweep()]);
  assert.equal(first + second, 350, 'one pass takes the whole list, not the first hundred');
  assert.equal(Math.min(first, second), 0, 'and a second pass does not run alongside it');
  await sleep(100);
  assert.equal(published.length, 350);
  assert.equal(new Set(published.map((e) => e.driverId)).size, 350, 'each driver once');
});
