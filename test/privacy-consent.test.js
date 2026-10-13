/**
 * The terms and privacy policy are agreed once for the account, in the app or
 * on WhatsApp, and each side asks only when the other has not.
 *
 *   node scripts/run-with-env.cjs node --test --test-force-exit test/privacy-consent.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { prisma, userClient } = require('@wheleers/db');
const { createLocalAccessToken } = require('../apps/api-gateway/dist/auth/local.js');
const { handlePrivacyConsentRoute } = require('../apps/api-gateway/dist/http/account.route.js');
const { handleProvisionVirtualAccountRoute } = require('../apps/api-gateway/dist/http/wallet.route.js');

const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const made = [];
test.after(async () => {
  await prisma.userActivityEvent.deleteMany({ where: { userId: { in: made } } }).catch(() => {});
  await prisma.wallet.deleteMany({ where: { userId: { in: made } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made } } }).catch(() => {});
  await prisma.$disconnect();
});

async function person() {
  const user = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'RIDER', name: 'Consent Rider' } });
  made.push(user.id);
  return { user, token: createLocalAccessToken(user.id, SECRET) };
}
async function call(handler, { token, method = 'GET', body }, deps) {
  let sent;
  const res = { statusCode: 0, setHeader() {}, end(text) { sent = JSON.parse(text); } };
  const req = {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); },
  };
  await handler(req, res, deps);
  return { status: res.statusCode, body: sent };
}
const deps = { jwtSecret: SECRET, redisClient: { get: async () => null } };

test('accepting in the app is the same agreement the bot reads, so the bot does not ask', async () => {
  const { user, token } = await person();
  assert.equal((await call(handlePrivacyConsentRoute, { token }, deps)).body.privacyConsent, 'PENDING');

  const agreed = await call(handlePrivacyConsentRoute, { token, method: 'POST', body: { consent: 'AGREED' } }, deps);
  assert.equal(agreed.status, 200);
  assert.equal(agreed.body.privacyConsent, 'AGREED');
  // What the bot asks before it shows its privacy message.
  assert.equal(await userClient.getPrivacyConsent(user.id), 'AGREED');
  assert.ok((await prisma.user.findUnique({ where: { id: user.id } })).privacyConsentAt);
});

test('agreeing on WhatsApp is what the app is told, and a later decline never undoes an agreement', async () => {
  const { user, token } = await person();
  await userClient.setPrivacyConsent(user.id, 'AGREED'); // tapped Continue on WhatsApp
  assert.equal((await call(handlePrivacyConsentRoute, { token }, deps)).body.privacyConsent, 'AGREED');

  const declined = await call(handlePrivacyConsentRoute, { token, method: 'POST', body: { consent: 'DECLINED' } }, deps);
  assert.equal(declined.body.privacyConsent, 'AGREED');
  assert.equal(await userClient.getPrivacyConsent(user.id), 'AGREED');
});

test('declining is recorded, lets them be asked again, and they can agree later', async () => {
  const { user, token } = await person();
  assert.equal((await call(handlePrivacyConsentRoute, { token, method: 'POST', body: { consent: 'DECLINED' } }, deps)).body.privacyConsent, 'DECLINED');
  assert.equal(await userClient.getPrivacyConsent(user.id), 'DECLINED', 'the bot will still ask');
  assert.equal((await call(handlePrivacyConsentRoute, { token, method: 'POST', body: { consent: 'AGREED' } }, deps)).body.privacyConsent, 'AGREED');
});

test('nobody answers without being signed in, and only the two answers are taken', async () => {
  assert.equal((await call(handlePrivacyConsentRoute, { method: 'POST', body: { consent: 'AGREED' } }, deps)).status, 401);
  const { token } = await person();
  assert.equal((await call(handlePrivacyConsentRoute, { token, method: 'POST', body: { consent: 'MAYBE' } }, deps)).status, 400);
});

test('someone who declined cannot have a bank account opened; they are told how to change that', async () => {
  const { user, token } = await person();
  await userClient.setPrivacyConsent(user.id, 'DECLINED');
  const refused = await call(handleProvisionVirtualAccountRoute, { token, method: 'POST' }, { jwtSecret: SECRET, paymentsClient: { never: true } });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'CONSENT_REQUIRED');
  assert.match(refused.body.error, /Accept the Terms and Privacy Policy/);
});

test('a rider\'s deposit account opens by itself once they have agreed, given a name and have a number, and not before', async () => {
  const { openDepositAccountWhenReady } = require('../apps/api-gateway/dist/onboarding/user-onboarding.js');
  const calls = [];
  const payments = {
    createCustomer: async (input) => { calls.push(['customer', input.firstName, input.lastName, input.phoneNumber]); return { id: `cus_${randomUUID()}` }; },
    updateCustomer: async () => {},
    createVirtualAccount: async () => { calls.push(['account']); return { id: `acc_${randomUUID()}`, bank_name: 'Test Bank', account_number: String(Math.floor(1e9 + Math.random() * 8e9)), account_name: 'Ada Obi', currency: 'NGN', country: 'NG' }; },
  };
  const user = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'RIDER', phone: `+23480${Math.floor(10000000 + Math.random() * 89999999)}` } });
  made.push(user.id);

  await openDepositAccountWhenReady(payments, user.id);
  assert.equal(calls.length, 0, 'not agreed, no name: nothing is sent to the bank');

  await userClient.setPrivacyConsent(user.id, 'AGREED');
  await openDepositAccountWhenReady(payments, user.id);
  assert.equal(calls.length, 0, 'agreed but nameless: the bank would call them "Wheelers User"');

  await prisma.user.update({ where: { id: user.id }, data: { name: 'Ada Obi' } });
  await openDepositAccountWhenReady(payments, user.id);
  assert.deepEqual(calls.map((c) => c[0]), ['customer', 'account']);
  assert.deepEqual(calls[0].slice(1, 3), ['Ada', 'Obi']);
  assert.ok(await prisma.virtualAccount.findFirst({ where: { userId: user.id } }), 'the account number is theirs');

  await openDepositAccountWhenReady(payments, user.id);
  assert.equal(calls.length, 2, 'asked again, nothing more is opened');
  await prisma.virtualAccount.deleteMany({ where: { userId: user.id } });

  const declined = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'RIDER', name: 'No Thanks', phone: `+23480${Math.floor(10000000 + Math.random() * 89999999)}`, privacyConsent: 'DECLINED' } });
  made.push(declined.id);
  await openDepositAccountWhenReady(payments, declined.id);
  assert.equal(calls.length, 2, 'declined: nothing is opened');
});
