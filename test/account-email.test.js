/**
 * Every account's email is proved with a code: sent to it, typed back,
 * single use, and one confirmed email per account.
 *
 *   node scripts/run-with-env.cjs node --test --test-force-exit test/account-email.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { prisma, userClient } = require('@wheleers/db');
const { createLocalAccessToken } = require('../apps/api-gateway/dist/auth/local.js');
const { handleAccountEmailRoute } = require('../apps/api-gateway/dist/http/email.route.js');

const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const made = [];
const sentEmails = [];
const realFetch = global.fetch;

/** Redis, in memory. */
function memoryRedis() {
  const store = new Map();
  return { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); }, del: async (k) => { store.delete(k); } };
}
const deps = () => ({ jwtSecret: SECRET, redisClient: memoryRedis(), resendApiKey: 'test-resend-key' });

test.before(() => {
  global.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com')) {
      sentEmails.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: 'email-1' }), { status: 200 });
    }
    return realFetch(url, init);
  };
});
test.after(async () => {
  global.fetch = realFetch;
  await prisma.userActivityEvent.deleteMany({ where: { userId: { in: made } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made } } }).catch(() => {});
  await prisma.$disconnect();
});

async function person() {
  const user = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'RIDER', name: 'Email Rider' } });
  made.push(user.id);
  return { user, token: createLocalAccessToken(user.id, SECRET) };
}
async function call(path, token, body, d) {
  let sent;
  const res = { statusCode: 0, setHeader() {}, end(text) { sent = JSON.parse(text); } };
  const req = { method: 'POST', headers: { authorization: `Bearer ${token}` }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
  const handled = await handleAccountEmailRoute(req, res, d, new URL(`http://x${path}`));
  assert.equal(handled, true);
  return { status: res.statusCode, body: sent };
}
const lastCode = () => JSON.stringify(sentEmails[sentEmails.length - 1]).match(/(\d{6}) is your Wheelers code/)[1];
const address = () => `rider-${randomUUID().slice(0, 8)}@example.com`;

test('a code goes to the email; typed back, the email is the account\'s, confirmed, and where PIN codes go', async () => {
  const { user, token } = await person();
  const d = deps();
  const email = address();
  const sent = await call('/auth/email/code', token, { email: ` ${email.toUpperCase()} ` }, d);
  assert.equal(sent.status, 200);
  assert.match(sent.body.sentTo, /^r•+@example\.com$/);
  assert.deepEqual([].concat(sentEmails[sentEmails.length - 1].to), [email]);
  assert.doesNotMatch(JSON.stringify(sentEmails[sentEmails.length - 1]), /PIN/, 'the account email says nothing about a PIN');

  const wrong = await call('/auth/email/verify', token, { code: '000000' === lastCode() ? '111111' : '000000' }, d);
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.code, 'CODE_WRONG');

  const ok = await call('/auth/email/verify', token, { code: lastCode() }, d);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { email, emailVerified: true });
  const saved = await prisma.user.findUnique({ where: { id: user.id } });
  assert.ok(saved.emailVerifiedAt);
  assert.equal(saved.recoveryEmail, email);

  const again = await call('/auth/email/verify', token, { code: lastCode() }, d);
  assert.equal(again.body.code, 'CODE_EXPIRED', 'a code works once');
});

test('one confirmed email per account; a bad address, and asking again at once, are refused in words', async () => {
  const first = await person();
  const second = await person();
  const email = address();
  const d1 = deps();
  await call('/auth/email/code', first.token, { email }, d1);
  await call('/auth/email/verify', first.token, { code: lastCode() }, d1);

  const d2 = deps();
  const taken = await call('/auth/email/code', second.token, { email }, d2);
  assert.equal(taken.status, 409);
  assert.match(taken.body.error, /already on another Wheelers account/);

  assert.equal((await call('/auth/email/code', second.token, { email: 'not-an-email' }, d2)).body.code, 'EMAIL_INVALID');
  assert.equal((await call('/auth/email/code', second.token, { email: address() }, d2)).status, 200);
  const soon = await call('/auth/email/code', second.token, { email: address() }, d2);
  assert.equal(soon.status, 429);
  assert.match(soon.body.error, /on its way/);
});

test('changing the email in the profile means proving it again', async () => {
  const { user, token } = await person();
  const d = deps();
  const email = address();
  await call('/auth/email/code', token, { email }, d);
  await call('/auth/email/verify', token, { code: lastCode() }, d);
  await userClient.updateProfile(user.id, { name: 'Same Email' });
  assert.ok((await prisma.user.findUnique({ where: { id: user.id } })).emailVerifiedAt, 'other changes leave it confirmed');
  await userClient.updateProfile(user.id, { email: address() });
  assert.equal((await prisma.user.findUnique({ where: { id: user.id } })).emailVerifiedAt, null);
});
