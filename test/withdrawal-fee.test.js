// The ₦45 withdrawal fee, end to end against a real Postgres: what leaves the
// wallet, what Paystack is asked to send, what the ledger books and when, and
// what the admin sees. Paystack itself is faked; everything else is the code
// production runs.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/withdrawal-fee.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const { withdrawalBreakdown, WITHDRAWAL_FEE_NGN, MIN_WITHDRAWAL_REQUEST_NGN } = require('../packages/config/dist/index.js');
const { withdrawalClient, adminAnalyticsClient, lagosToday } = require('../packages/db/dist/index.js');
const { submitWithdrawal } = require('../apps/api-gateway/dist/payments/withdrawal.js');
const { handleWalletPageRoute } = require('../apps/api-gateway/dist/http/wallet-page.route.js');
const { handleWalletOverviewRoute } = require('../apps/api-gateway/dist/http/wallet.route.js');
const local = require('../apps/api-gateway/dist/auth/local.js');

const prisma = new PrismaClient();
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const PLATFORM_USER_ID = '00000000-0000-0000-0000-000000000001';
const made = [];

async function makeUser(balanceNgn) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `whatsapp:+234${Math.floor(1e9 + Math.random() * 9e9)}`, role: 'DRIVER', name: 'Fee Test' } });
  const wallet = await prisma.wallet.create({ data: { userId: id, balanceNgn } });
  made.push(id);
  return { id, walletId: wallet.id };
}

function fakePaystack(overrides = {}) {
  const sent = [];
  return {
    sent,
    client: {
      getBalanceNgn: async () => 1_000_000,
      createPayout: async (p) => { sent.push(p); return { id: `TRF_${sent.length}`, reference: p.reference, amountNgn: p.amountNgn, feeNgn: null, status: 'pending', failureReason: null }; },
      listBanks: async () => [{ uuid: '057', code: '057', name: 'Zenith Bank', country: 'NG', currency: 'NGN', provider: 'paystack' }],
      validateBankAccount: async (p) => ({ account_number: p.accountNumber, account_name: 'FEE TEST', bank_code: p.bankCode }),
      ...overrides,
    },
  };
}
const publisher = { publishPaymentEvent: async () => {} };
const withdraw = (paystack, user, amountNgn) => submitWithdrawal(
  { paymentsClient: paystack.client, publisher },
  { userId: user.id, walletId: user.walletId, amountNgn, bankCode: '057', accountNumber: '0000000000', accountName: 'FEE TEST', pinPolicy: 'if_set' },
);
const wallet = async (user) => {
  const w = await prisma.wallet.findUnique({ where: { id: user.walletId } });
  return { balance: Number(w.balanceNgn), locked: Number(w.lockedNgn) };
};
const platformRows = (referenceId) => prisma.transaction.findMany({
  where: { referenceId, wallet: { userId: PLATFORM_USER_ID } },
  orderBy: { createdAt: 'asc' },
});

test.before(() => { console.log = console.info = console.warn = console.error = () => {}; });

test.after(async () => {
  const requests = await prisma.withdrawalRequest.findMany({ where: { userId: { in: made } }, select: { id: true, reservationId: true } });
  const ids = requests.map((r) => r.id);
  await prisma.transaction.deleteMany({ where: { referenceId: { in: ids } } });
  await prisma.withdrawalRequest.deleteMany({ where: { id: { in: ids } } });
  await prisma.walletReservation.deleteMany({ where: { userId: { in: made } } });
  await prisma.transaction.deleteMany({ where: { wallet: { userId: { in: made } } } });
  await prisma.wallet.deleteMany({ where: { userId: { in: made } } });
  await prisma.user.deleteMany({ where: { id: { in: made } } });
  await prisma.$disconnect();
});

test('₦45 comes out of the amount; the least anyone can withdraw is the fee and the bank\'s ₦50', () => {
  assert.equal(WITHDRAWAL_FEE_NGN, 45);
  assert.deepEqual(withdrawalBreakdown(5_000), { amountNgn: 5_000, feeNgn: 45, payoutNgn: 4_955 });
  assert.deepEqual(withdrawalBreakdown(100_000), { amountNgn: 100_000, feeNgn: 45, payoutNgn: 99_955 }, 'flat, whatever the size');
  assert.deepEqual(withdrawalBreakdown(1_234.56), { amountNgn: 1_234.56, feeNgn: 45, payoutNgn: 1_189.56 });
  assert.equal(MIN_WITHDRAWAL_REQUEST_NGN, 95);
});

test('the wallet gives up ₦5,000, Paystack is asked to send ₦4,955, and the split is written down', async () => {
  const user = await makeUser(12_000);
  const paystack = fakePaystack();
  const { requestId, breakdown } = await withdraw(paystack, user, 5_000);

  assert.deepEqual(breakdown, { amountNgn: 5_000, feeNgn: 45, payoutNgn: 4_955 });
  assert.equal(paystack.sent.length, 1);
  assert.equal(paystack.sent[0].amountNgn, 4_955, 'the bank gets the amount less the fee');
  assert.deepEqual(await wallet(user), { balance: 7_000, locked: 5_000 });

  const request = await prisma.withdrawalRequest.findUnique({ where: { id: requestId } });
  assert.deepEqual([Number(request.requestedAmountNgn), Number(request.feeNgn), Number(request.payoutAmountNgn)], [5_000, 45, 4_955]);
  assert.deepEqual(await platformRows(requestId), [], 'nothing is earned until the money has gone');
});

test('when it settles, the fee is income and Paystack\'s ₦10 is a cost, booked once however many times it settles', async () => {
  const user = await makeUser(12_000);
  const { requestId } = await withdraw(fakePaystack(), user, 5_000);

  await withdrawalClient.settle(requestId, { providerFeeNgn: 10 });
  await withdrawalClient.settle(requestId, { providerFeeNgn: 10 });
  await Promise.all([withdrawalClient.settle(requestId, { providerFeeNgn: 10 }), withdrawalClient.settle(requestId, { providerFeeNgn: 10 })]);

  assert.deepEqual(await wallet(user), { balance: 7_000, locked: 0 });
  const userRows = await prisma.transaction.findMany({ where: { referenceId: requestId, walletId: user.walletId } });
  assert.deepEqual(userRows.map((t) => [t.type, t.direction, Number(t.amountNgn)]), [['WITHDRAWAL', 'DEBIT', 5_000]], 'the rider sees one line: ₦5,000 out');

  const platform = await platformRows(requestId);
  assert.deepEqual(
    platform.map((t) => [t.type, t.direction, Number(t.amountNgn), t.metadata?.kind]),
    [['PLATFORM_FEE', 'CREDIT', 45, 'withdrawal_fee'], ['PROVIDER_FEE', 'DEBIT', 10, 'transfer_fee']],
  );
  // Money in balance: what the wallets gave up, less what Wheelers kept, is what left Paystack.
  assert.equal(5_000 - 45 + 10, 4_955 + 10);
});

test('a transfer Paystack refuses returns the whole ₦5,000, fee included, and books nothing', async () => {
  const user = await makeUser(12_000);
  const paystack = fakePaystack({ createPayout: async () => { const e = new Error('Account is invalid'); e.status = 400; throw e; } });
  await assert.rejects(withdraw(paystack, user, 5_000), /Account is invalid/);
  assert.deepEqual(await wallet(user), { balance: 12_000, locked: 0 });
  const request = await prisma.withdrawalRequest.findFirst({ where: { userId: user.id } });
  assert.equal(request.status, 'FAILED');
  assert.deepEqual(await platformRows(request.id), []);
});

test('a transfer that fails after it was sent also returns the whole amount', async () => {
  const user = await makeUser(12_000);
  const { requestId } = await withdraw(fakePaystack(), user, 5_000);
  await withdrawalClient.releaseFailedRequest({ providerReference: requestId, failureReason: 'Bank reversed it', status: 'FAILED' });
  assert.deepEqual(await wallet(user), { balance: 12_000, locked: 0 });
  assert.deepEqual(await platformRows(requestId), []);
});

test('₦94 is refused before anything is reserved; ₦95 sends the bank its ₦50', async () => {
  const user = await makeUser(1_000);
  const paystack = fakePaystack();
  await assert.rejects(withdraw(paystack, user, 94), (e) => e.code === 'BELOW_MINIMUM' && /₦95/.test(e.message) && /₦45/.test(e.message));
  assert.equal(paystack.sent.length, 0);
  assert.deepEqual(await wallet(user), { balance: 1_000, locked: 0 });

  await withdraw(paystack, user, 95);
  assert.equal(paystack.sent[0].amountNgn, 50);
  assert.deepEqual(await wallet(user), { balance: 905, locked: 95 });
});

test('the WhatsApp page is told the fee before the PIN, and the answer says what reached the bank', async () => {
  const user = await makeUser(12_000);
  const paystack = fakePaystack();
  const store = new Map();
  const redis = {
    get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); }, del: async (k) => { store.delete(k); },
    setIfNotExists: async (k, v) => (store.has(k) ? false : (store.set(k, v), true)),
    send: async (command, key, value, ...flags) => { if (flags.includes('NX') && store.has(key)) return null; store.set(key, value); return 'OK'; },
  };
  const deps = { jwtSecret: JWT_SECRET, redisClient: redis, paymentsClient: paystack.client, publisher };
  const token = local.createWalletPageToken(user.id, 'withdraw', JWT_SECRET);
  const call = async (method, path, body, headers = {}) => {
    const raw = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, async *[Symbol.asyncIterator]() { for (const c of raw) yield c; } };
    const res = { statusCode: 0, body: null, setHeader() {}, end(t) { this.body = JSON.parse(t); } };
    await handleWalletPageRoute(req, res, deps, new URL(`http://x${path}`));
    return res;
  };

  const session = await call('GET', '/wallet-page/session');
  assert.deepEqual([session.body.withdrawalFeeNgn, session.body.minWithdrawalNgn], [45, 95]);
  assert.equal((await call('POST', '/wallet-page/pin', { pin: '7291' })).statusCode, 200);
  const paid = await call('POST', '/wallet-page/withdraw',
    { amountNgn: 2_000, bankCode: '057', accountNumber: '0000000000', accountName: 'FEE TEST', pin: '7291' },
    { 'idempotency-key': randomUUID() });
  assert.equal(paid.statusCode, 200, JSON.stringify(paid.body));
  assert.deepEqual([paid.body.amountNgn, paid.body.feeNgn, paid.body.payoutNgn], [2_000, 45, 1_955]);
  assert.equal(paystack.sent[0].amountNgn, 1_955);
});

test('the wallet overview offers the account that last paid out, so the app can withdraw in one step', async () => {
  const user = await makeUser(20_000);
  const paystack = fakePaystack();
  const store = new Map();
  const redis = { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); } };
  const deps = { jwtSecret: JWT_SECRET, redisClient: redis, paymentsClient: paystack.client, publisher };
  const overview = async () => {
    const req = { method: 'GET', headers: { authorization: `Bearer ${local.createLocalAccessToken(user.id, JWT_SECRET)}` } };
    const res = { statusCode: 0, body: null, setHeader() {}, writeHead(code) { this.statusCode = code; }, end(t) { this.body = JSON.parse(t); } };
    await handleWalletOverviewRoute(req, res, deps);
    return res.body;
  };

  const first = await overview();
  assert.equal(first.payoutAccount, null, `no withdrawal yet: nothing to offer (${JSON.stringify(first)})`);

  const { requestId } = await withdraw(paystack, user, 2_000);
  const pending = await overview();
  assert.equal(pending.payoutAccount.accountNumber, '0000000000', 'on its way counts, while nothing has paid out');

  await withdrawalClient.settle(requestId, { providerFeeNgn: 10 });
  const after = await overview();
  assert.deepEqual(
    { ...after.payoutAccount, lastUsedAt: typeof after.payoutAccount.lastUsedAt },
    { networkId: '057', bankName: 'Zenith Bank', accountNumber: '0000000000', accountName: 'FEE TEST', lastUsedAt: 'string' },
  );
});

test('the admin counts withdrawal fees as income, lists them, and the numbers check agrees with the ledger', async () => {
  const user = await makeUser(20_000);
  const today = lagosToday();
  const before = await adminAnalyticsClient.fees({ from: today, to: today }, 'day');
  const { requestId } = await withdraw(fakePaystack(), user, 10_000);
  await withdrawalClient.settle(requestId, { providerFeeNgn: 25 });

  const after = await adminAnalyticsClient.fees({ from: today, to: today }, 'day');
  assert.equal(after.totals.withdrawalFeesNgn - before.totals.withdrawalFeesNgn, 45);
  assert.equal(after.totals.incomeNgn - before.totals.incomeNgn, 45);
  assert.equal(after.totals.transferCostNgn - before.totals.transferCostNgn, 25);
  assert.equal(after.totals.feeWithdrawals - before.totals.feeWithdrawals, 1);

  const ledger = await adminAnalyticsClient.feeLedger({ from: today, to: today }, 'withdrawal_fee', { q: requestId, limit: 10 });
  assert.deepEqual(ledger.items.map((r) => [r.label, r.amountNgn, r.direction]), [['Withdrawal fee', 45, 'CREDIT']]);

  const rows = await adminAnalyticsClient.withdrawals({ from: today, to: today }, { q: requestId, limit: 10 });
  assert.deepEqual([rows.items[0].amountNgn, rows.items[0].feeNgn, rows.items[0].payoutNgn, rows.items[0].transferFeeNgn], [10_000, 45, 9_955, 25]);

  const checks = await adminAnalyticsClient.reconcile({ from: today, to: today });
  const fee = checks.find((c) => c.key === 'withdrawalFees');
  assert.ok(fee && fee.ok, JSON.stringify(fee));
});
