/**
 * An admin signs a person out of every phone: logins from before that moment
 * stop, a fresh sign-in works, and a driver is taken offline.
 *
 *   node scripts/run-with-env.cjs node --test --test-force-exit test/admin-sign-out.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { prisma, userClient } = require('@wheleers/db');
const { createLocalAccessToken } = require('../apps/api-gateway/dist/auth/local.js');
const { handleSessionCheckRoute, handleRefreshRoute } = require('../apps/api-gateway/dist/http/account.route.js');
const { handleAdminSignOutUserRoute } = require('../apps/api-gateway/dist/http/admin-metrics.route.js');

const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const redisClient = { get: async () => null, set: async () => 'OK' };
const made = [];
test.after(async () => {
  await prisma.driver.deleteMany({ where: { userId: { in: made } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made } } }).catch(() => {});
  await prisma.$disconnect();
});

async function call(handler, headers, ...rest) {
  let body;
  const res = { statusCode: 0, setHeader() {}, end(text) { body = JSON.parse(text); } };
  await handler({ headers, method: 'POST' }, res, ...rest);
  return { status: res.statusCode, body };
}
const bearer = (token) => ({ authorization: `Bearer ${token}` });

test('signed out by an admin: the old login stops everywhere, a new one works, and a driver goes offline', async () => {
  const user = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'DRIVER', name: 'Signed Out' } });
  made.push(user.id);
  const driver = await prisma.driver.create({ data: { userId: user.id, status: 'ONLINE' } });
  const deps = { jwtSecret: SECRET, redisClient };
  const old = createLocalAccessToken(user.id, SECRET);

  assert.equal((await call(handleSessionCheckRoute, bearer(old), deps)).status, 200, 'good until signed out');

  // A login's time is whole seconds: let one pass so "before" is unmistakable.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const done = await call(handleAdminSignOutUserRoute, { 'x-admin-key': 'k' }, { adminApiKey: 'k', jwtSecret: SECRET }, user.id);
  assert.equal(done.status, 200);
  assert.ok(done.body.sessionsEndedAt);

  const check = await call(handleSessionCheckRoute, bearer(old), deps);
  assert.equal(check.status, 401);
  assert.equal(check.body.code, 'SESSION_ENDED');
  assert.match(check.body.error, /signed out/i);
  assert.equal((await call(handleRefreshRoute, bearer(old), deps)).status, 401, 'and it cannot be renewed');
  assert.equal((await prisma.driver.findUnique({ where: { id: driver.id } })).status, 'OFFLINE');

  const fresh = createLocalAccessToken(user.id, SECRET);
  assert.equal((await call(handleSessionCheckRoute, bearer(fresh), deps)).status, 200, 'signing in again works');

  const nobody = await call(handleAdminSignOutUserRoute, { 'x-admin-key': 'k' }, { adminApiKey: 'k', jwtSecret: SECRET }, randomUUID());
  assert.equal(nobody.status, 404);
  assert.equal(await userClient.endSessions(randomUUID()), null);
});
