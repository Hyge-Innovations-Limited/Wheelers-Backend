// Money, end to end, against a real Postgres ledger:
//
//   signed Paystack webhook → gateway handler → payment event
//     → wallet-service consumer → ledger rows
//
// The provider itself is stubbed (test/paystack.live.test.js covers the real
// API), but the signature check, the handlers, the consumer and every ledger
// write are the production code. One invariant is asserted throughout:
//
//     sum of all wallet balances  ===  cash the provider would be holding
//
//   DATABASE_URL=… node --test --test-force-exit test/paystack-webhook.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const { handlePaystackWebhookRoute } = require('../apps/api-gateway/dist/http/paystack.route.js');
const { submitWithdrawal, WithdrawalError } = require('../apps/api-gateway/dist/payments/withdrawal.js');
const { createPaymentEventsConsumer } = require('../apps/wallet-service/dist/consumers/payment-events.consumer.js');
const { resolvePayout } = require('../apps/payment-service/dist/handlers/payout-reconciliation.js');
const { walletClient, PLATFORM_USER_ID } = require('../packages/db/dist/index.js');
const { PaymentsClient } = require('../packages/payments/dist/index.js');

const prisma = new PrismaClient();
const SECRET = 'sk_test_unit_0000000000000000000000000000000000';
const CTX = { topic: 'payment.events', partition: 0, offset: '0', timestamp: new Date().toISOString(), headers: {} };

const userId = randomUUID();
const accountNumber = String(Math.floor(1e9 + Math.random() * 9e9));
let walletId;
let cash = 0; // what the provider balance would hold
let baseline = 0; // everything already in the ledger before this test

/** A real client (real signature maths) with the network calls replaced. */
function makePayments(overrides = {}) {
  const client = new PaymentsClient({ secretKey: SECRET });
  return Object.assign(client, {
    verifyTransaction: async () => null,
    getPayout: async () => null,
    getBalanceNgn: async () => 1_000_000,
    createPayout: async () => { throw new Error('createPayout not stubbed'); },
  }, overrides);
}

function makePublisher() {
  const events = [];
  return { events, publishPaymentEvent: async (event) => { events.push(event); } };
}

const consumer = createPaymentEventsConsumer({
  walletRepository: walletClient,
  walletEventsProducer: { publishCredited: async () => {} },
});

async function postWebhook(deps, body, { sign = true } = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  const req = {
    method: 'POST',
    headers: sign ? { 'x-paystack-signature': createHmac('sha512', SECRET).update(raw).digest('hex') } : {},
    async *[Symbol.asyncIterator]() { yield raw; },
  };
  const res = { statusCode: 0, body: null, setHeader() {}, end(text) { this.body = JSON.parse(text); } };
  await handlePaystackWebhookRoute(req, res, deps);
  return res;
}

const ledgerTotal = async () =>
  Number((await prisma.wallet.aggregate({ _sum: { balanceNgn: true, lockedNgn: true } }))._sum.balanceNgn ?? 0) +
  Number((await prisma.wallet.aggregate({ _sum: { lockedNgn: true } }))._sum.lockedNgn ?? 0);

async function assertBooksMatchCash(label) {
  const total = await ledgerTotal();
  assert.equal(Math.round((total - baseline) * 100), Math.round(cash * 100), `${label}: ledger ${total - baseline} vs cash ${cash}`);
}

const userWallet = () => prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
const platformWallet = () => prisma.wallet.findUnique({ where: { userId: PLATFORM_USER_ID } });

function depositBody(reference) {
  return { event: 'charge.success', data: { reference, channel: 'dedicated_nuban', amount: 1, status: 'success' } };
}
function verifiedDeposit(reference, amountNgn, providerFeeNgn, extra = {}) {
  return {
    reference, status: 'success', amountNgn, providerFeeNgn, channel: 'dedicated_nuban',
    customerId: null, customerEmail: null, receiverAccountNumber: accountNumber,
    senderName: 'ADA OBI', senderBank: 'GTBank', senderAccountNumber: '0123456789', paidAt: null, ...extra,
  };
}

test.before(async () => {
  await prisma.user.create({ data: { id: userId, privyDid: `whatsapp:+234${accountNumber}`, role: 'RIDER', name: 'Olá🌸' } });
  walletId = (await prisma.wallet.create({ data: { userId } })).id;
  await prisma.virtualAccount.create({
    data: {
      userId, provider: 'paystack', providerCustomerId: `CUS_${accountNumber}`, providerAccountId: `acct_${accountNumber}`,
      bankName: 'Wema Bank', accountNumber, accountName: 'WHEELERS/OLA USER',
    },
  });
  baseline = await ledgerTotal();
});

test.after(async () => { await prisma.$disconnect(); });

test('an unsigned or wrongly signed webhook is refused and moves nothing', async () => {
  const publisher = makePublisher();
  const deps = { publisher, paymentsClient: makePayments() };
  assert.equal((await postWebhook(deps, depositBody('ref-unsigned'), { sign: false })).statusCode, 401);

  const raw = Buffer.from(JSON.stringify(depositBody('ref-forged')));
  const req = { method: 'POST', headers: { 'x-paystack-signature': 'deadbeef' }, async *[Symbol.asyncIterator]() { yield raw; } };
  const res = { statusCode: 0, setHeader() {}, end() {} };
  await handlePaystackWebhookRoute(req, res, deps);
  assert.equal(res.statusCode, 401);
  assert.equal(publisher.events.length, 0);
});

test('a ₦10,000 deposit: the depositor carries both fees, Wheelers nets exactly ₦20', async () => {
  const platformBefore = Number((await platformWallet())?.balanceNgn ?? 0);
  const publisher = makePublisher();
  // The webhook body lies about the amount (₦0.01). Only the verified figure counts.
  const deps = { publisher, paymentsClient: makePayments({ verifyTransaction: async (ref) => verifiedDeposit(ref, 10_000, 100) }) };

  const res = await postWebhook(deps, depositBody('dep-10000'));
  assert.equal(res.statusCode, 200);
  assert.equal(publisher.events.length, 1);
  assert.equal(publisher.events[0].amountNgn, 10_000);
  assert.equal(publisher.events[0].providerFeeNgn, 100);
  assert.equal(publisher.events[0].userId, userId);

  await consumer.handle(publisher.events[0], CTX);
  cash += 10_000 - 100;

  assert.equal(Number((await userWallet()).balanceNgn), 9_880);
  assert.equal(Number((await platformWallet()).balanceNgn) - platformBefore, 20);
  const rows = await prisma.transaction.findMany({ where: { referenceId: 'dep-10000' }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(rows.map((r) => `${r.type}:${r.direction}:${Number(r.amountNgn)}`).sort(), [
    'DEPOSIT:CREDIT:9880', 'PLATFORM_FEE:CREDIT:20',
  ]);
  const deposit = rows.find((r) => r.type === 'DEPOSIT');
  assert.equal(deposit.metadata.grossAmountNgn, 10_000);
  assert.equal(deposit.metadata.wheelersFeeNgn, 20);
  assert.equal(deposit.metadata.providerFeeNgn, 100);
  await assertBooksMatchCash('after deposit');
});

test('the same deposit delivered again — by webhook retry or Kafka redelivery — credits nothing', async () => {
  const publisher = makePublisher();
  const deps = { publisher, paymentsClient: makePayments({ verifyTransaction: async (ref) => verifiedDeposit(ref, 10_000, 100) }) };
  await postWebhook(deps, depositBody('dep-10000'));
  for (const event of publisher.events) await consumer.handle(event, CTX);
  await consumer.handle(publisher.events[0], CTX);

  assert.equal(Number((await userWallet()).balanceNgn), 9_880);
  assert.equal(await prisma.transaction.count({ where: { referenceId: 'dep-10000' } }), 2);
  await assertBooksMatchCash('after replay');
});

test('charges that are not bank deposits, or that the provider does not confirm, are ignored', async () => {
  const card = makePublisher();
  await postWebhook({ publisher: card, paymentsClient: makePayments({ verifyTransaction: async (ref) => verifiedDeposit(ref, 5_000, 75, { channel: 'card' }) }) }, depositBody('card-1'));
  const failed = makePublisher();
  await postWebhook({ publisher: failed, paymentsClient: makePayments({ verifyTransaction: async (ref) => verifiedDeposit(ref, 5_000, 50, { status: 'failed' }) }) }, depositBody('failed-1'));
  const unknown = makePublisher();
  await postWebhook({ publisher: unknown, paymentsClient: makePayments() }, depositBody('never-happened'));
  assert.equal(card.events.length + failed.events.length + unknown.events.length, 0);
});

test('a withdrawal reserves, settles on transfer.success, and books the transfer fee', async () => {
  const platformBefore = Number((await platformWallet()).balanceNgn);
  const publisher = makePublisher();
  let createdWith;
  const payments = makePayments({
    createPayout: async (params) => { createdWith = params; return { id: 'TRF_1', reference: params.reference, amountNgn: params.amountNgn, feeNgn: null, status: 'pending', failureReason: null }; },
    getPayout: async (reference) => ({ id: 'TRF_1', reference, amountNgn: 1_500, feeNgn: 10, status: 'success', failureReason: null }),
  });

  const { requestId } = await submitWithdrawal({ paymentsClient: payments, publisher }, {
    userId, walletId, amountNgn: 1_500, bankCode: '057', accountNumber: '0000000000', accountName: 'Ola User', pinPolicy: 'if_set',
  });
  assert.equal(createdWith.reference, requestId, 'the transfer reference must be the withdrawal id');
  let wallet = await userWallet();
  assert.equal(Number(wallet.balanceNgn), 8_380);
  assert.equal(Number(wallet.lockedNgn), 1_500);
  await assertBooksMatchCash('while reserved');

  const res = await postWebhook({ publisher, paymentsClient: payments }, { event: 'transfer.success', data: { reference: requestId } });
  assert.equal(res.statusCode, 200);
  cash -= 1_500 + 10;

  wallet = await userWallet();
  assert.equal(Number(wallet.balanceNgn), 8_380);
  assert.equal(Number(wallet.lockedNgn), 0);
  assert.equal(Number((await platformWallet()).balanceNgn) - platformBefore, -10);
  const request = await prisma.withdrawalRequest.findUniqueOrThrow({ where: { id: requestId } });
  assert.equal(request.status, 'SETTLED');
  assert.equal(Number(request.providerFeeNgn), 10);
  await assertBooksMatchCash('after settle');

  // A retried transfer.success must not debit twice.
  await postWebhook({ publisher, paymentsClient: payments }, { event: 'transfer.success', data: { reference: requestId } });
  assert.equal(Number((await platformWallet()).balanceNgn) - platformBefore, -10);
  await assertBooksMatchCash('after settle replay');
});

test('a settled withdrawal the bank later reverses is refunded exactly once', async () => {
  const settled = await prisma.withdrawalRequest.findFirstOrThrow({ where: { userId, status: 'SETTLED' } });
  const deps = { publisher: makePublisher(), paymentsClient: makePayments() };
  await postWebhook(deps, { event: 'transfer.reversed', data: { reference: settled.id } });
  await postWebhook(deps, { event: 'transfer.reversed', data: { reference: settled.id } });
  cash += 1_500;
  assert.equal(Number((await userWallet()).balanceNgn), 9_880);
  await assertBooksMatchCash('after reversal');
});

test('an OTP-gated Paystack account fails loudly and gives the money back', async () => {
  const payments = makePayments({
    createPayout: async (params) => ({ id: 'TRF_OTP', reference: params.reference, amountNgn: params.amountNgn, feeNgn: null, status: 'otp', failureReason: null }),
  });
  await assert.rejects(
    submitWithdrawal({ paymentsClient: payments, publisher: makePublisher() }, { userId, walletId, amountNgn: 2_000, bankCode: '057', accountNumber: '0000000000', accountName: 'Ola User', pinPolicy: 'if_set' }),
    (error) => error instanceof WithdrawalError && error.code === 'PAYOUTS_NOT_ENABLED' && !error.fundsStillReserved,
  );
  const wallet = await userWallet();
  assert.equal(Number(wallet.balanceNgn), 9_880);
  assert.equal(Number(wallet.lockedNgn), 0);
});

test('a timeout keeps the money reserved; the reconciler releases it once the provider denies the transfer', async () => {
  const payments = makePayments({ createPayout: async () => { throw new Error('socket hang up'); } });
  await assert.rejects(
    submitWithdrawal({ paymentsClient: payments, publisher: makePublisher() }, { userId, walletId, amountNgn: 3_000, bankCode: '057', accountNumber: '0000000000', accountName: 'Ola User', pinPolicy: 'if_set' }),
    (error) => error instanceof WithdrawalError && error.code === 'PENDING_CONFIRMATION' && error.fundsStillReserved,
  );
  let wallet = await userWallet();
  assert.equal(Number(wallet.lockedNgn), 3_000, 'must stay reserved while the outcome is unknown');

  const stuck = await prisma.withdrawalRequest.findFirstOrThrow({ where: { userId, status: 'FUNDS_RESERVED' } });
  const resolution = await resolvePayout(payments, { id: stuck.id, amountNgn: 3_000, neverRecorded: true }, 'test');
  assert.equal(resolution, 'released');
  wallet = await userWallet();
  assert.equal(Number(wallet.balanceNgn), 9_880);
  assert.equal(Number(wallet.lockedNgn), 0);
  await assertBooksMatchCash('after reconciliation');
});

test('a float that cannot cover the payout refuses before touching the ledger', async () => {
  const payments = makePayments({ getBalanceNgn: async () => 100 });
  await assert.rejects(
    submitWithdrawal({ paymentsClient: payments, publisher: makePublisher() }, { userId, walletId, amountNgn: 5_000, bankCode: '057', accountNumber: '0000000000', accountName: 'Ola User', pinPolicy: 'if_set' }),
    (error) => error instanceof WithdrawalError && error.code === 'FLOAT_SHORT',
  );
  assert.equal(await prisma.withdrawalRequest.count({ where: { userId, requestedAmountNgn: 5_000 } }), 0);
});
