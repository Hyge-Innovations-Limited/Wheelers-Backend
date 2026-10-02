// An admin login lasts two hours, on the server too: an older token is
// refused, including the 30-day ones issued before sessions were short.
// Rider and driver tokens are untouched.
//
//   npm -w @wheleers/api-gateway run build && node --test test/admin-session.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const local = require('../apps/api-gateway/dist/auth/local.js');
const { extractAdminId, ADMIN_SESSION_SECONDS } = require('../apps/api-gateway/dist/http/admin-auth.route.js');

const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const req = (token) => ({ headers: { authorization: `Bearer ${token}` } });

/** A token as if issued `ageSeconds` ago with the given lifetime. */
function issuedAgo(ageSeconds, ttlSeconds) {
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const iat = Math.floor(Date.now() / 1000) - ageSeconds;
  const unsigned = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'admin-1', typ: 'wheelers.local.auth', iat, exp: iat + ttlSeconds })}`;
  return `${unsigned}.${crypto.createHmac('sha256', SECRET).update(unsigned).digest('base64url')}`;
}

test('an admin session lasts two hours', () => {
  assert.equal(ADMIN_SESSION_SECONDS, 2 * 60 * 60);
  const token = local.createLocalAccessToken('admin-1', SECRET, ADMIN_SESSION_SECONDS);
  const { exp, iat } = local.verifyLocalAccessToken(token, SECRET);
  assert.equal(exp - iat, ADMIN_SESSION_SECONDS);
  assert.equal(extractAdminId(req(token), SECRET), 'admin-1');
});

test('after two hours the admin is out, even with an old 30-day token', () => {
  assert.equal(extractAdminId(req(issuedAgo(60 * 60, 30 * 86400)), SECRET), 'admin-1', 'an hour in: still in');
  assert.equal(extractAdminId(req(issuedAgo(2 * 60 * 60 + 5, 30 * 86400)), SECRET), null, 'an old long token: out');
  assert.equal(extractAdminId(req(issuedAgo(2 * 60 * 60 + 5, 3 * 60 * 60)), SECRET), null);
});

test('rider and driver tokens still last 30 days', () => {
  const { exp, iat } = local.verifyLocalAccessToken(local.createLocalAccessToken('user-1', SECRET), SECRET);
  assert.equal(exp - iat, 30 * 86400);
});
