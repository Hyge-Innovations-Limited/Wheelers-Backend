// Rolling logins: a valid login is swapped for a fresh 30-day one; an expired,
// signed-out or deleted one is refused (401, SESSION_ENDED), so the app sends
// that person to sign in. Local Postgres, Redis database 15.
//
//   npm -w @wheleers/api-gateway run build
//   node scripts/run-with-env.cjs node --test --test-force-exit test/auth-refresh.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { randomUUID } = crypto;
const { prisma } = require('../packages/db/dist/index.js');
const { RedisClient } = require('../apps/api-gateway/dist/redis/client.js');
const local = require('../apps/api-gateway/dist/auth/local.js');
const account = require('../apps/api-gateway/dist/http/account.route.js');

const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const made = [];
let redis, server, base;

test.before(async () => {
  redis = new RedisClient(process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15');
  await redis.connect();
  const deps = { jwtSecret: SECRET, redisClient: redis };
  server = http.createServer(async (req, res) => {
    if (req.url === '/auth/refresh') return account.handleRefreshRoute(req, res, deps);
    if (req.url === '/auth/logout') return account.handleLogoutRoute(req, res, deps);
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close();
  await prisma.user.deleteMany({ where: { id: { in: made } } });
  await redis.disconnect();
  await prisma.$disconnect();
});

async function user(privyDid) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: privyDid ?? `test:refresh:${id}`, role: 'RIDER', name: 'Refresh Test' } });
  made.push(id);
  return id;
}
const post = async (path, token) => {
  const res = await fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json() };
};
function issuedAgo(userId, ageSeconds, ttlSeconds) {
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const iat = Math.floor(Date.now() / 1000) - ageSeconds;
  const unsigned = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: userId, typ: 'wheelers.local.auth', iat, exp: iat + ttlSeconds })}`;
  return `${unsigned}.${crypto.createHmac('sha256', SECRET).update(unsigned).digest('base64url')}`;
}

test('a valid login comes back as a fresh 30-day one for the same person', async () => {
  const id = await user();
  const old = issuedAgo(id, 20 * 86400, 30 * 86400); // 20 days in, 10 left
  const r = await post('/auth/refresh', old);
  assert.equal(r.status, 200);
  const fresh = local.verifyLocalAccessToken(r.body.accessToken, SECRET);
  assert.equal(fresh.sub, id);
  assert.equal(fresh.exp - fresh.iat, 30 * 86400);
  assert.ok(Date.parse(r.body.expiresAt) > Date.now() + 29 * 86400e3);
  assert.equal(local.verifyLocalAccessToken(old, SECRET).sub, id, 'the old one still works until it expires');
});

test('an expired login is not renewed', async () => {
  const id = await user();
  const r = await post('/auth/refresh', issuedAgo(id, 31 * 86400, 30 * 86400));
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'SESSION_ENDED');
});

test('a signed-out login is not renewed', async () => {
  const id = await user();
  const token = local.createLocalAccessToken(id, SECRET);
  assert.equal((await post('/auth/logout', token)).status, 200);
  const r = await post('/auth/refresh', token);
  assert.equal(r.status, 401);
});

test("a deleted account's login is not renewed", async () => {
  const id = await user(`deleted:${randomUUID()}:1`);
  const r = await post('/auth/refresh', local.createLocalAccessToken(id, SECRET));
  assert.equal(r.status, 401);
});
