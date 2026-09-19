// The wallet PIN and everything that guards a withdrawal, against a real
// Postgres. The payment provider is stubbed; every rule under test is the
// production code, reached the way production reaches it.
//
//   DATABASE_URL=… node --test --test-force-exit test/wallet-pin.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const local = require('../apps/api-gateway/dist/auth/local.js');
const pinService = require('../apps/api-gateway/dist/wallet-security/wallet-pin.js');
const { submitWithdrawal } = require('../apps/api-gateway/dist/payments/withdrawal.js');
const { handleWalletPageRoute } = require('../apps/api-gateway/dist/http/wallet-page.route.js');
const { walletSecurityClient } = require('../packages/db/dist/index.js');

const prisma = new PrismaClient();
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const { WalletSecurityError } = pinService;
const realError = console.error;
const realWarn = console.warn;
const realLog = console.log;

const code = (expected) => (error) => error instanceof WalletSecurityError && error.code === expected;

async function makeUser(balanceNgn = 0) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `whatsapp:+234${Math.floor(1e9 + Math.random() * 9e9)}`, role: 'RIDER', name: 'Test Rider', phone: '+2348030000000' } });
  const wallet = await prisma.wallet.create({ data: { userId: id, balanceNgn } });
  return { id, walletId: wallet.id };
}

function memoryRedis() {
  const store = new Map();
  return {
    store,
    get: async (k) => (store.has(k) ? store.get(k) : null),
    set: async (k, v) => { store.set(k, v); },
    del: async (k) => { store.delete(k); },
    setIfNotExists: async (k, v) => (store.has(k) ? false : (store.set(k, v), true)),
    // The idempotency helper takes its lock with a raw "SET key value NX EX ttl".
    send: async (command, key, value, ...flags) => {
      if (command !== 'SET') throw new Error(`memoryRedis: unsupported ${command}`);
      if (flags.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
  };
}

const payments = (overrides = {}) => ({
  getBalanceNgn: async () => 1_000_000,
  createPayout: async (p) => ({ id: 'TRF_T', reference: p.reference, amountNgn: p.amountNgn, feeNgn: null, status: 'pending', failureReason: null }),
  listBanks: async () => [{ uuid: '057', code: '057', name: 'Zenith Bank', country: 'NG', currency: 'NGN', provider: 'paystack' }],
  validateBankAccount: async (p) => ({ account_number: p.accountNumber, account_name: 'TEST RIDER', bank_code: p.bankCode }),
  ...overrides,
});
const publisher = { publishPaymentEvent: async () => {} };

async function call(deps, method, path, { token, body, headers = {} } = {}) {
  const raw = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...headers },
    async *[Symbol.asyncIterator]() { for (const c of raw) yield c; },
  };
  const res = { statusCode: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(t) { this.body = JSON.parse(t); } };
  const handled = await handleWalletPageRoute(req, res, deps, new URL(`http://x${path}`));
  return { handled, status: res.statusCode, body: res.body, headers: res.headers };
}

test.beforeEach(() => { console.error = console.warn = console.log = () => {}; });
test.afterEach(() => { console.error = realError; console.warn = realWarn; console.log = realLog; });
test.after(async () => { await prisma.$disconnect(); });

/* ── link tokens ──────────────────────────────────────────────────────── */

test('a page link names one purpose, expires, and is never a login token', () => {
  const token = local.createWalletPageToken('user-1', 'withdraw', JWT_SECRET);
  assert.deepEqual(local.verifyWalletPageToken(token, JWT_SECRET), { userId: 'user-1', scope: 'withdraw' });

  assert.throws(() => local.verifyLocalAccessToken(token, JWT_SECRET), /type is invalid/, 'a page link must not log anyone in');
  const login = local.createLocalAccessToken('user-1', JWT_SECRET);
  assert.throws(() => local.verifyWalletPageToken(login, JWT_SECRET), /type is invalid/, 'a login token must not open a wallet page');

  const expired = local.createWalletPageToken('user-1', 'deposit', JWT_SECRET, -1);
  assert.throws(() => local.verifyWalletPageToken(expired, JWT_SECRET), /expired/);
  const tampered = token.slice(0, -3) + (token.endsWith('AAA') ? 'BBB' : 'AAA');
  assert.throws(() => local.verifyWalletPageToken(tampered, JWT_SECRET), /signature/);
  assert.throws(() => local.verifyWalletPageToken(token, 'a-different-secret-of-at-least-32-chars!!'), /signature/);
});

/* ── choosing a PIN ───────────────────────────────────────────────────── */

test('a PIN is exactly four digits, not an obvious one, and stored only as a hash', async () => {
  const user = await makeUser();
  for (const bad of ['123', '12345', 'abcd', '12 4', '', null, 1234]) {
    await assert.rejects(pinService.setInitialPin(user.id, bad), code('PIN_INVALID_FORMAT'));
  }
  for (const weak of ['0000', '1234', '1111', '4321']) {
    await assert.rejects(pinService.setInitialPin(user.id, weak), code('PIN_TOO_GUESSABLE'));
  }
  await pinService.setInitialPin(user.id, '7291');
  const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.match(row.walletPinHash, /^scrypt\$/);
  assert.ok(!row.walletPinHash.includes('7291'));
  await assert.rejects(pinService.setInitialPin(user.id, '8302'), code('PIN_ALREADY_SET'), 'replacing a PIN must go through reset');
});

/* ── guessing ─────────────────────────────────────────────────────────── */

test('wrong PINs count down, a right one clears the count, five lock the account', async () => {
  const user = await makeUser();
  await pinService.setInitialPin(user.id, '7291');

  await assert.rejects(pinService.verifyPin(user.id, '0001'), (e) => code('PIN_WRONG')(e) && e.details.attemptsLeft === 4);
  await assert.rejects(pinService.verifyPin(user.id, '0002'), (e) => e.details.attemptsLeft === 3);
  await pinService.verifyPin(user.id, '7291');
  assert.equal((await walletSecurityClient.getState(user.id)).walletPinFailedAttempts, 0, 'success resets the count');

  for (let i = 0; i < 4; i += 1) await assert.rejects(pinService.verifyPin(user.id, '0009'), code('PIN_WRONG'));
  await assert.rejects(pinService.verifyPin(user.id, '0009'), (e) => code('PIN_LOCKED')(e) && e.details.justLocked === true);
  await assert.rejects(pinService.verifyPin(user.id, '7291'), code('PIN_LOCKED'), 'even the right PIN is refused while locked');
});

test('ten guesses fired at once still count as ten — no slipping under the limit together', async () => {
  const user = await makeUser();
  await pinService.setInitialPin(user.id, '7291');
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => pinService.verifyPin(user.id, `55${String(i).padStart(2, '0')}`)));
  assert.ok(results.every((r) => r.status === 'rejected'));
  assert.ok(results.some((r) => r.reason.code === 'PIN_LOCKED'), 'the burst must trip the lock');
  const state = await walletSecurityClient.getState(user.id);
  assert.ok(state.walletPinLockedUntil > new Date());
  await assert.rejects(pinService.verifyPin(user.id, '7291'), code('PIN_LOCKED'));
});

/* ── the gate inside the withdrawal executor ──────────────────────────── */

test('no PIN, no money: the executor refuses before reserving a kobo', async () => {
  const user = await makeUser(5_000);
  const input = { userId: user.id, walletId: user.walletId, amountNgn: 1_000, bankCode: '057', accountNumber: '0000000000', accountName: 'Test Rider' };
  let payoutCalls = 0;
  const deps = { paymentsClient: payments({ createPayout: async () => { payoutCalls += 1; throw new Error('must not be reached'); } }), publisher };

  await assert.rejects(submitWithdrawal(deps, input), code('PIN_NOT_SET'), 'default policy is "required"');
  await pinService.setInitialPin(user.id, '7291');
  await assert.rejects(submitWithdrawal(deps, input), code('PIN_REQUIRED'));
  await assert.rejects(submitWithdrawal(deps, { ...input, pin: '0001' }), code('PIN_WRONG'));
  await assert.rejects(submitWithdrawal(deps, { ...input, pinPolicy: 'if_set' }), code('PIN_REQUIRED'), '"if_set" still demands a PIN once one exists');

  assert.equal(payoutCalls, 0);
  assert.equal(await prisma.withdrawalRequest.count({ where: { userId: user.id } }), 0);
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: user.walletId } });
  assert.equal(Number(wallet.balanceNgn), 5_000);
  assert.equal(Number(wallet.lockedNgn), 0);

  const ok = await submitWithdrawal({ paymentsClient: payments(), publisher }, { ...input, pin: '7291' });
  assert.ok(ok.requestId);
});

test('"if_set" lets a user with no PIN through — the app\'s transitional path only', async () => {
  const user = await makeUser(5_000);
  const ok = await submitWithdrawal({ paymentsClient: payments(), publisher }, {
    userId: user.id, walletId: user.walletId, amountNgn: 1_000, bankCode: '057', accountNumber: '0000000000', accountName: 'Test Rider', pinPolicy: 'if_set',
  });
  assert.ok(ok.requestId);
});

/* ── forgetting the PIN ───────────────────────────────────────────────── */

test('an unverified reset pauses withdrawals for 24 hours', async () => {
  const user = await makeUser(5_000);
  await pinService.setInitialPin(user.id, '7291');
  const before = Date.now();
  const outcome = await pinService.resetPin(user.id, '8302', false);

  const hours = (outcome.frozenUntil.getTime() - before) / 3_600_000;
  assert.ok(hours > 23.9 && hours < 24.1, `frozen for ${hours}h`);
  assert.equal(outcome.restrictedUntil, null, 'never been paid out → no "known account" to restrict to');

  await pinService.verifyPin(user.id, '8302');
  await assert.rejects(pinService.verifyPin(user.id, '7291'), code('PIN_WRONG'), 'the old PIN is dead');
  await assert.rejects(
    submitWithdrawal({ paymentsClient: payments(), publisher }, { userId: user.id, walletId: user.walletId, amountNgn: 1_000, bankCode: '057', accountNumber: '0000000000', accountName: 'X', pin: '8302' }),
    code('WITHDRAWALS_FROZEN'),
  );
});

test('after the pause, a user with payout history can only pay accounts they have paid before', async () => {
  const user = await makeUser(20_000);
  await pinService.setInitialPin(user.id, '7291');
  const reservation = await prisma.walletReservation.create({ data: { walletId: user.walletId, userId: user.id, kind: 'WITHDRAWAL', status: 'CONSUMED', amountNgn: 1_000, referenceId: randomUUID() } });
  await prisma.withdrawalRequest.create({ data: { userId: user.id, walletId: user.walletId, reservationId: reservation.id, status: 'SETTLED', requestedAmountNgn: 1_000, reservedAmountNgn: 1_000, bankAccountNumber: '0123456789', bankAccountName: 'Test Rider', bankNetworkId: '058' } });

  const outcome = await pinService.resetPin(user.id, '8302', false);
  const days = (outcome.restrictedUntil.getTime() - outcome.frozenUntil.getTime()) / 86_400_000;
  assert.ok(days > 6.9 && days < 7.1);

  // Jump past the 24h pause; the 7-day restriction is still running.
  await prisma.user.update({ where: { id: user.id }, data: { withdrawalsFrozenUntil: null } });
  const base = { userId: user.id, walletId: user.walletId, amountNgn: 1_000, accountName: 'X', pin: '8302' };
  await assert.rejects(
    submitWithdrawal({ paymentsClient: payments(), publisher }, { ...base, bankCode: '057', accountNumber: '9999999999' }),
    code('DESTINATION_RESTRICTED'),
    'a thief\'s own account is refused',
  );
  const ok = await submitWithdrawal({ paymentsClient: payments(), publisher }, { ...base, bankCode: '058', accountNumber: '0123456789' });
  assert.ok(ok.requestId, 'the owner\'s own bank account still works');
});

test('a reset proven by the recovery email has no pause at all', async () => {
  const user = await makeUser(5_000);
  await pinService.setInitialPin(user.id, '7291');
  const outcome = await pinService.resetPin(user.id, '8302', true);
  assert.deepEqual(outcome, { frozenUntil: null, restrictedUntil: null });
  const ok = await submitWithdrawal({ paymentsClient: payments(), publisher }, { userId: user.id, walletId: user.walletId, amountNgn: 1_000, bankCode: '057', accountNumber: '0000000000', accountName: 'X', pin: '8302' });
  assert.ok(ok.requestId);
});

test('a freeze is never shortened by a later, shorter one', async () => {
  const user = await makeUser();
  const far = new Date('2099-12-31T00:00:00Z');
  await walletSecurityClient.freezeWithdrawals(user.id, far, 'user_freeze');
  await walletSecurityClient.freezeWithdrawals(user.id, new Date(Date.now() + 3_600_000), 'pin_reset');
  const state = await walletSecurityClient.getState(user.id);
  assert.equal(state.withdrawalsFrozenUntil.toISOString(), far.toISOString());
  assert.equal(state.withdrawalsFrozenReason, 'user_freeze');
});

/* ── the page API ─────────────────────────────────────────────────────── */

test('the page API: scoped links, honest previews, and a full first withdrawal', async () => {
  const user = await makeUser(12_000);
  const redis = memoryRedis();
  const deps = { jwtSecret: JWT_SECRET, redisClient: redis, paymentsClient: payments(), publisher };
  const withdrawLink = local.createWalletPageToken(user.id, 'withdraw', JWT_SECRET);
  const depositLink = local.createWalletPageToken(user.id, 'deposit', JWT_SECRET);

  assert.equal((await call(deps, 'GET', '/wallet-page/session')).status, 401, 'no link, no entry');
  assert.equal((await call(deps, 'GET', '/wallet-page/session', { token: 'garbage' })).status, 401);
  assert.equal((await call(deps, 'GET', '/wallet-page/banks', { token: depositLink })).status, 403, 'a deposit link cannot reach withdrawal endpoints');
  assert.equal((await call(deps, 'POST', '/wallet-page/withdraw', { token: depositLink, body: {} })).status, 403);
  assert.equal((await call(deps, 'GET', '/wallet-page/nope', { token: withdrawLink })).handled, false);

  const session = await call(deps, 'GET', '/wallet-page/session', { token: withdrawLink });
  assert.equal(session.status, 200);
  assert.equal(session.headers['cache-control'], 'no-store');
  assert.equal(session.body.balanceNgn, 12_000);
  assert.equal(session.body.hasPin, false);
  assert.equal(JSON.stringify(session.body).includes('walletPinHash'), false);

  // send ₦10,000 → the bank keeps 1%, Wheelers ₦20
  const send = await call(deps, 'GET', '/wallet-page/deposit-preview?mode=send&amount=10000', { token: depositLink });
  assert.deepEqual([send.body.sendNgn, send.body.bankChargeNgn, send.body.wheelersFeeNgn, send.body.walletGetsNgn], [10_000, 100, 20, 9_880]);
  // want ₦5,000 in the wallet → the quoted amount really covers it
  const want = await call(deps, 'GET', '/wallet-page/deposit-preview?mode=receive&amount=5000', { token: depositLink });
  assert.ok(want.body.walletGetsNgn >= 5_000 && want.body.sendNgn - 5_000 < 100, JSON.stringify(want.body));
  assert.equal((await call(deps, 'GET', '/wallet-page/deposit-preview?amount=-5', { token: depositLink })).status, 400);

  const resolved = await call(deps, 'POST', '/wallet-page/resolve-account', { token: withdrawLink, body: { bankCode: '057', accountNumber: '0000000000' } });
  assert.equal(resolved.body.accountName, 'TEST RIDER');
  assert.equal((await call(deps, 'POST', '/wallet-page/resolve-account', { token: withdrawLink, body: { bankCode: '057', accountNumber: '123' } })).status, 400);

  const wd = { amountNgn: 2_500, bankCode: '057', accountNumber: '0000000000', accountName: 'TEST RIDER' };
  const noPin = await call(deps, 'POST', '/wallet-page/withdraw', { token: withdrawLink, body: { ...wd, pin: '7291' }, headers: { 'idempotency-key': randomUUID() } });
  assert.equal(noPin.body.code, 'PIN_NOT_SET');

  assert.equal((await call(deps, 'POST', '/wallet-page/pin', { token: withdrawLink, body: { pin: '1234' } })).body.code, 'PIN_TOO_GUESSABLE');
  assert.equal((await call(deps, 'POST', '/wallet-page/pin', { token: withdrawLink, body: { pin: '7291' } })).status, 200);

  const key = randomUUID();
  const paid = await call(deps, 'POST', '/wallet-page/withdraw', { token: withdrawLink, body: { ...wd, pin: '7291' }, headers: { 'idempotency-key': key } });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  const again = await call(deps, 'POST', '/wallet-page/withdraw', { token: withdrawLink, body: { ...wd, pin: '7291' }, headers: { 'idempotency-key': key } });
  assert.equal(again.body.withdrawalId, paid.body.withdrawalId, 'a double tap is one withdrawal');
  assert.equal(await prisma.withdrawalRequest.count({ where: { userId: user.id } }), 1);

  for (const value of redis.store.values()) assert.ok(!String(value).includes('7291'), 'the PIN must never reach Redis');

  const over = await call(deps, 'POST', '/wallet-page/withdraw', { token: withdrawLink, body: { ...wd, amountNgn: 999_999, pin: '7291' }, headers: { 'idempotency-key': randomUUID() } });
  assert.equal(over.body.code, 'INSUFFICIENT_BALANCE');
});

test('the page API: a reset without a recovery email warns first, then pauses', async () => {
  const user = await makeUser(5_000);
  await pinService.setInitialPin(user.id, '7291');
  const alerts = [];
  const deps = { jwtSecret: JWT_SECRET, redisClient: memoryRedis(), paymentsClient: payments(), publisher, notifyUser: async (phone, message) => { alerts.push({ phone, message }); } };
  const link = local.createWalletPageToken(user.id, 'withdraw', JWT_SECRET);

  const start = await call(deps, 'POST', '/wallet-page/pin-reset/start', { token: link, body: {} });
  assert.deepEqual(start.body, { method: 'pause', pauseHours: 24 });
  const done = await call(deps, 'POST', '/wallet-page/pin-reset/complete', { token: link, body: { newPin: '8302' } });
  assert.equal(done.status, 200);
  assert.ok(done.body.frozenUntil);
  await new Promise((r) => setImmediate(r));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, /FREEZE/);

  const session = await call(deps, 'GET', '/wallet-page/session', { token: link });
  assert.equal(session.body.frozenReason, 'pin_reset');
});

test('the page API: with a recovery email, the reset demands the emailed code', async () => {
  const user = await makeUser(5_000);
  await pinService.setInitialPin(user.id, '7291');
  await walletSecurityClient.setRecoveryEmail(user.id, 'rider@example.com');
  await walletSecurityClient.markRecoveryEmailVerified(user.id, 'rider@example.com');

  const redis = memoryRedis();
  const deps = { jwtSecret: JWT_SECRET, redisClient: redis, paymentsClient: payments(), publisher };
  const link = local.createWalletPageToken(user.id, 'withdraw', JWT_SECRET);

  // No way around the email: completing with no code, or a wrong one, fails.
  assert.equal((await call(deps, 'POST', '/wallet-page/pin-reset/complete', { token: link, body: { newPin: '8302' } })).body.code, 'CODE_EXPIRED');
  redis.store.set(`wallet-page:pin-reset:${user.id}`, JSON.stringify({ email: 'rider@example.com', codeHash: require('node:crypto').createHash('sha256').update('424242').digest('hex'), tries: 0 }));
  assert.equal((await call(deps, 'POST', '/wallet-page/pin-reset/complete', { token: link, body: { newPin: '8302', code: '000000' } })).body.code, 'CODE_WRONG');
  await pinService.verifyPin(user.id, '7291'); // untouched so far

  const done = await call(deps, 'POST', '/wallet-page/pin-reset/complete', { token: link, body: { newPin: '8302', code: '424242' } });
  assert.equal(done.status, 200);
  assert.equal(done.body.frozenUntil, null, 'proven by email → no pause');
  await pinService.verifyPin(user.id, '8302');
  assert.equal((await call(deps, 'POST', '/wallet-page/pin-reset/complete', { token: link, body: { newPin: '9413', code: '424242' } })).body.code, 'CODE_EXPIRED', 'a code works once');
});
