// The trip code: the rider gives the driver 4 digits, and the trip cannot
// start without them. Checked on the server; support can unlock a trip when
// the rider cannot give the code, and who did is kept.
// Against a real Redis (database 15) and a real Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/trip-code.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const WebSocket = require('../apps/api-gateway/node_modules/ws');

const { RedisClient } = require('../apps/api-gateway/dist/redis/client.js');
const { SocketRegistry } = require('../apps/api-gateway/dist/websocket/registry.js');
const { createGatewayWebSocketServer } = require('../apps/api-gateway/dist/websocket/server.js');
const { handleAdminTripRoute } = require('../apps/api-gateway/dist/http/admin-trip.route.js');
const { tripCodeStillNeeded } = require('../apps/api-gateway/dist/rides/trip-code.js');
const local = require('../apps/api-gateway/dist/auth/local.js');
const { tripCodeClient } = require('../packages/db/dist/index.js');

const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15';
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const ADMIN_KEY = 'admin-key-for-trip-code-tests';
const prisma = new PrismaClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clients = [];
async function redis() {
  const client = new RedisClient(REDIS_URL);
  await client.connect();
  clients.push(client);
  return client;
}

const made = { users: [], rides: [] };
async function user(role, name) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:trip-code:${id}`, role, name } });
  made.users.push(id);
  return id;
}
async function trip(status = 'ARRIVED') {
  const riderId = await user('RIDER', 'Ada Obi');
  const driverUserId = await user('DRIVER', 'Tunde Bakare');
  const driver = await prisma.driver.create({ data: { userId: driverUserId, kycStatus: 'APPROVED' } });
  const ride = await prisma.ride.create({ data: {
    riderId, driverId: driver.id, status,
    pickupLat: 6.5, pickupLng: 3.37, pickupAddress: 'Yaba', destLat: 6.45, destLng: 3.43, destAddress: 'Lekki',
  } });
  made.rides.push(ride.id);
  return { rideId: ride.id, riderId, driverUserId };
}

const published = [];
let g;
let commandRedis;
test.before(async () => {
  console.info = () => {};
  console.warn = () => {};
  commandRedis = await redis();
  await commandRedis.send('FLUSHDB');
  const registry = new SocketRegistry({ instanceId: `code-${randomUUID()}`, commandRedis, subscriberRedis: await redis() });
  await registry.start();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    handleAdminTripRoute(req, res, { jwtSecret: JWT_SECRET, adminApiKey: ADMIN_KEY, redis: commandRedis, sockets: registry }, url)
      .then((handled) => { if (!handled) { res.statusCode = 404; res.end(); } });
  });
  createGatewayWebSocketServer({
    server, jwtSecret: JWT_SECRET, allowedOrigins: new Set(), idleTimeoutMs: 60_000, registry,
    publisher: { publishRideEvent: async (e) => { published.push(e); }, publishDriverEvent: async () => {} },
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
async function next(socket, type, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const index = socket.inbox.findIndex((m) => m.type === type);
    if (index !== -1) return socket.inbox.splice(index, 1)[0].payload;
    await sleep(20);
  }
  throw new Error(`no ${type}; inbox ${JSON.stringify(socket.inbox.map((m) => [m.type, m.payload?.code]))}`);
}
/** Start the trip; the answer is either ride:start:accepted or an error with its code. */
async function start(socket, rideId, riderId, tripCode) {
  socket.inbox.length = 0;
  socket.send(JSON.stringify({ type: 'ride:start', payload: { rideId, riderId, lockedFareNgn: 3000, paymentMethod: 'WALLET', ...(tripCode !== undefined ? { tripCode } : {}) } }));
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    const hit = socket.inbox.find((m) => m.type === 'ride:start:accepted' || m.type === 'error');
    if (hit) return hit.type === 'error' ? hit.payload.code ?? hit.payload.message : 'STARTED';
    await sleep(20);
  }
  throw new Error('no answer to ride:start');
}
const admin = (method, path) => fetch(`http://127.0.0.1:${g.port}${path}`, { method, headers: { 'x-admin-key': ADMIN_KEY } });

test('the switch off: a trip starts as before, and a right code sent anyway is recorded', async () => {
  delete process.env.TRIP_CODE_REQUIRED;
  const { rideId, riderId, driverUserId } = await trip();
  const code = await tripCodeClient.ensure(rideId);
  assert.match(code, /^\d{4}$/);
  const driver = await open(driverUserId);
  assert.equal(await start(driver, rideId, riderId, '0000' === code ? '1111' : '0000'), 'STARTED', 'a wrong code never blocks while it is off');
  assert.equal(await start(driver, rideId, riderId, code), 'STARTED');
  assert.ok((await tripCodeClient.state(rideId)).tripCodeVerifiedAt);
});

test('the switch on: no code, a wrong code, then the right one; after that it is not asked again', async () => {
  process.env.TRIP_CODE_REQUIRED = 'true';
  const { rideId, riderId, driverUserId } = await trip();
  const code = await tripCodeClient.ensure(rideId);
  assert.equal(await tripCodeClient.ensure(rideId), code, 'issued once');
  assert.equal(await tripCodeStillNeeded(rideId), true);
  const driver = await open(driverUserId);
  published.length = 0;

  assert.equal(await start(driver, rideId, riderId), 'TRIP_CODE_REQUIRED');
  const wrong = code === '1234' ? '4321' : '1234';
  assert.equal(await start(driver, rideId, riderId, wrong), 'TRIP_CODE_WRONG');
  assert.equal(published.length, 0, 'nothing started');
  assert.equal(await start(driver, rideId, riderId, ` ${code.slice(0, 2)} ${code.slice(2)} `), 'STARTED', 'spaces are ignored');
  assert.equal(published.filter((e) => e.eventType === 'RIDE_STARTED').length, 1);
  const state = await tripCodeClient.state(rideId);
  assert.ok(state.tripCodeVerifiedAt);
  assert.equal(state.tripCodeWrongTries, 1);
  assert.equal(await tripCodeStillNeeded(rideId), false);
  assert.equal(await start(driver, rideId, riderId), 'STARTED', 'not asked again');
});

test('five wrong codes lock it: even the right code waits', async () => {
  process.env.TRIP_CODE_REQUIRED = 'true';
  const { rideId, riderId, driverUserId } = await trip();
  const code = await tripCodeClient.ensure(rideId);
  const wrong = code === '9999' ? '8888' : '9999';
  const driver = await open(driverUserId);
  const answers = [];
  for (let i = 0; i < 5; i += 1) answers.push(await start(driver, rideId, riderId, wrong));
  assert.deepEqual(answers, ['TRIP_CODE_WRONG', 'TRIP_CODE_WRONG', 'TRIP_CODE_WRONG', 'TRIP_CODE_WRONG', 'TRIP_CODE_LOCKED']);
  assert.equal(await start(driver, rideId, riderId, code), 'TRIP_CODE_LOCKED');
  assert.equal((await tripCodeClient.state(rideId)).tripCodeWrongTries, 5);
});

test("support unlocks a trip whose rider cannot give the code: recorded, the driver is told, and it starts", async () => {
  process.env.TRIP_CODE_REQUIRED = 'true';
  const { rideId, riderId, driverUserId } = await trip();
  const code = await tripCodeClient.ensure(rideId);
  const driver = await open(driverUserId);
  await sleep(100);

  const view = await admin('GET', `/admin/rides/${rideId}/trip`).then((r) => r.json());
  assert.equal(view.tripCode.status, 'waiting');
  assert.ok(!JSON.stringify(view).includes(`"${code}"`), 'the code itself is never shown to support');

  const unlocked = await admin('POST', `/admin/rides/${rideId}/trip-code/unlock`);
  assert.equal(unlocked.status, 200);
  const body = await unlocked.json();
  assert.equal(body.tripCode.status, 'unlocked');
  assert.equal(body.tripCode.unlockedBy, 'api-key');
  assert.ok(body.tripCode.unlockedAt);
  assert.deepEqual(await next(driver, 'trip:code:unlocked'), { rideId });
  assert.equal(await start(driver, rideId, riderId), 'STARTED');

  assert.equal((await admin('POST', `/admin/rides/${rideId}/trip-code/unlock`)).status, 409, 'once only');
  const noKey = await fetch(`http://127.0.0.1:${g.port}/admin/rides/${rideId}/trip-code/unlock`, { method: 'POST' });
  assert.equal(noKey.status, 401, 'not without an admin');
});

test('a trip that has started cannot be unlocked, and a ride with no code (a group ride) is never asked', async () => {
  process.env.TRIP_CODE_REQUIRED = 'true';
  const started = await trip('IN_PROGRESS');
  await tripCodeClient.ensure(started.rideId);
  assert.equal((await admin('POST', `/admin/rides/${started.rideId}/trip-code/unlock`)).status, 409);

  const group = await trip();
  const driver = await open(group.driverUserId);
  assert.equal(await tripCodeStillNeeded(group.rideId), false);
  assert.equal(await start(driver, group.rideId, group.riderId), 'STARTED');
  const view = await admin('GET', `/admin/rides/${group.rideId}/trip`).then((r) => r.json());
  assert.equal(view.tripCode.status, 'none');
});

test.after(async () => {
  delete process.env.TRIP_CODE_REQUIRED;
  for (const s of sockets) { try { s.terminate(); } catch { /* closed */ } }
  await g.registry.shutdown().catch(() => {});
  await new Promise((resolve) => g.server.close(resolve));
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.driver.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
  for (const c of clients) await c.disconnect().catch(() => {});
});
