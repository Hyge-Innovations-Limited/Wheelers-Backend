// The dashboard's locked areas (Chats, Trip recordings, Fees, Stellar, Usage):
// the admin's password again, five minutes at a time, enforced by the server.
// Against a real Redis (database 15) and Postgres, through an HTTP server that
// puts the gate in front of the routes as the gateway does.
//
//   npm run build && node scripts/run-with-env.cjs node --test --test-force-exit test/admin-area-lock.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const { RedisClient } = require('../apps/api-gateway/dist/redis/client.js');
const local = require('../apps/api-gateway/dist/auth/local.js');
const lock = require('../apps/api-gateway/dist/admin/area-lock.js');
const { ADMIN_SESSION_SECONDS } = require('../apps/api-gateway/dist/http/admin-auth.route.js');
const { supportDeskAllows } = require('../apps/api-gateway/dist/admin/support-desk.js');

const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15';
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const PASSWORD = 'correct horse battery';
const prisma = new PrismaClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let redis;
let server;
let base;
const admins = [];

test.before(async () => {
  redis = new RedisClient(REDIS_URL);
  await redis.connect();
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    if (await lock.handleAdminAreaLockRoute(req, res, { jwtSecret: JWT_SECRET, redis }, url)) return;
    if (lock.isLockedAdminPath(url) && await lock.adminAreaLocked(req, JWT_SECRET, redis)) return send(423, lock.ADMIN_LOCKED_BODY);
    send(200, { route: url.pathname });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await prisma.adminActivity.deleteMany({ where: { adminId: { in: admins } } });
  await prisma.adminUser.deleteMany({ where: { id: { in: admins } } });
  await prisma.$disconnect();
  await redis.disconnect?.();
});

async function admin() {
  const a = await prisma.adminUser.create({ data: { username: `lock-${randomUUID()}`, name: 'Ikeoluwa', role: 'OWNER', passwordHash: await local.hashPassword(PASSWORD) } });
  admins.push(a.id);
  return { id: a.id, token: local.createLocalAccessToken(a.id, JWT_SECRET, ADMIN_SESSION_SECONDS) };
}
async function call(token, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const unlock = (token, password = PASSWORD) => call(token, 'POST', '/admin/unlock', { password });

const LOCKED_PATHS = ['/admin/chats/people', '/admin/chats/trips/r1', '/admin/trip-recordings', '/admin/rides/r1/recordings', '/admin/fees/summary', '/admin/stellar', '/admin/usage/services', '/admin/insights/export?scope=fees'];

test('every locked area is refused with 423 until unlocked; the rest of the dashboard is not touched', async () => {
  const a = await admin();
  for (const path of LOCKED_PATHS) assert.equal((await call(a.token, 'GET', path)).status, 423, path);
  assert.equal((await call(a.token, 'GET', '/admin/chats/people')).body.code, 'ADMIN_LOCKED');
  for (const path of ['/admin/rides', '/admin/users', '/admin/metrics/overview', '/admin/insights/export?scope=overview', '/admin/desk/people/u1']) {
    assert.equal((await call(a.token, 'GET', path)).status, 200, path);
  }
});

test('the right password opens every locked area for this login; a wrong one says how many tries are left', async () => {
  const a = await admin();
  const wrong = await unlock(a.token, 'nope');
  assert.equal(wrong.status, 403, 'not 401: that would sign the dashboard out');
  assert.deepEqual([wrong.body.code, wrong.body.triesLeft], ['WRONG_PASSWORD', 4]);
  const right = await unlock(a.token);
  assert.equal(right.status, 200);
  assert.equal(right.body.unlockedForSeconds, 300);
  for (const path of LOCKED_PATHS) assert.equal((await call(a.token, 'GET', path)).status, 200, path);
});

test('the unlock belongs to one login: the same admin in another browser is still locked', async () => {
  const a = await admin();
  await sleep(1100); // another login is another second, so another token
  const otherBrowser = local.createLocalAccessToken(a.id, JWT_SECRET, ADMIN_SESSION_SECONDS);
  assert.notEqual(otherBrowser, a.token);
  assert.equal((await unlock(a.token)).status, 200);
  assert.equal((await call(otherBrowser, 'GET', '/admin/chats/people')).status, 423);
});

test('Lock closes it at once', async () => {
  const a = await admin();
  await unlock(a.token);
  assert.equal((await call(a.token, 'POST', '/admin/lock')).status, 200);
  assert.equal((await call(a.token, 'GET', '/admin/fees/summary')).status, 423);
  assert.deepEqual((await call(a.token, 'POST', '/admin/unlock/ping')).body, { unlocked: false });
});

test('five minutes with no use and it locks; any use or a ping starts the five minutes again', async () => {
  const a = await admin();
  await unlock(a.token);
  const key = (await redis.send('KEYS', `admin:unlock:${a.id}:*`))[0];
  await redis.send('EXPIRE', key, '100');
  assert.deepEqual((await call(a.token, 'POST', '/admin/unlock/ping')).body, { unlocked: true });
  assert.equal(await redis.send('TTL', key), 300, 'a ping restarts it');
  await redis.send('EXPIRE', key, '100');
  await call(a.token, 'GET', '/admin/chats/people');
  assert.equal(await redis.send('TTL', key), 300, 'using a locked page restarts it');
  await redis.send('EXPIRE', key, '1');
  await sleep(1300);
  assert.equal((await call(a.token, 'GET', '/admin/chats/people')).status, 423, 'the five minutes ran out');
});

test('five wrong passwords: no more tries for 15 minutes, even with the right one; activity records each', async () => {
  const a = await admin();
  const answers = [];
  for (let i = 0; i < 5; i++) answers.push((await unlock(a.token, `wrong-${i}`)).status);
  assert.deepEqual(answers, [403, 403, 403, 403, 429]);
  const blocked = await unlock(a.token);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, 'TOO_MANY_TRIES');
  assert.equal(await redis.send('TTL', `admin:unlock-tries:${a.id}`) > 890, true, '15 minutes');
  assert.equal((await call(a.token, 'GET', '/admin/chats/people')).status, 423);
  await sleep(300);
  const kinds = (await prisma.adminActivity.findMany({ where: { adminId: a.id }, select: { kind: true } })).map((r) => r.kind);
  assert.equal(kinds.filter((k) => k === 'unlock-failed').length, 5);
});

test('a good unlock clears the wrong tries; unlock, lock and failures are on Team → Activity', async () => {
  const a = await admin();
  await unlock(a.token, 'wrong');
  await unlock(a.token);
  assert.equal(await redis.get(`admin:unlock-tries:${a.id}`), null);
  await call(a.token, 'POST', '/admin/lock');
  await sleep(300);
  const kinds = (await prisma.adminActivity.findMany({ where: { adminId: a.id }, orderBy: { createdAt: 'asc' }, select: { kind: true } })).map((r) => r.kind);
  assert.deepEqual(kinds, ['unlock-failed', 'unlocked', 'locked']);
});

test('no login, a bad token or a deactivated admin cannot unlock; the gate leaves a request without a login to the route (401 there)', async () => {
  assert.equal((await unlock(null)).status, 401);
  assert.equal((await unlock('not-a-token')).status, 401);
  const a = await admin();
  await prisma.adminUser.update({ where: { id: a.id }, data: { active: false } });
  assert.equal((await unlock(a.token)).status, 401);
  assert.equal((await call(null, 'GET', '/admin/chats/people')).status, 200, 'passed on: the chats route itself refuses with 401');
});

test('a support login may unlock, ping and lock (it reads Chats and recordings)', () => {
  for (const path of ['/admin/unlock', '/admin/unlock/ping', '/admin/lock']) assert.equal(supportDeskAllows('POST', path), true, path);
  assert.equal(supportDeskAllows('GET', '/admin/unlock'), false);
});
