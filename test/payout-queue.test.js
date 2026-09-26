// A withdrawal the float cannot cover is QUEUED, not refused: the money is set aside,
// the sweep sends it when the float allows, an admin can pay it by hand or give it back.
//
//   DATABASE_URL=… node --test --test-force-exit test/payout-queue.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { submitWithdrawal, runPayoutQueueOnce, markQueuedPaid, cancelQueued, configurePayouts } = require('../apps/api-gateway/dist/payments/withdrawal.js');

const prisma = new PrismaClient();
test.beforeEach(() => { if (!process.env.LOUD) console.log = console.info = console.warn = console.error = () => {}; configurePayouts({ mode: 'auto' }); });

async function riderWithWallet(balanceNgn) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:${id}`, role: 'RIDER', name: 'Queue Rider', phone: `+23480${String(Date.now()).slice(-8)}` } });
  const wallet = await prisma.wallet.create({ data: { userId: id, balanceNgn } });
  return { id, wallet };
}

function paystack(balanceNgn) {
  const created = [];
  return {
    created,
    balance: balanceNgn,
    getBalanceNgn: async function () { return this.balance; },
    createPayout: async (p) => { created.push(p); return { id: `TRF_${randomUUID()}`, reference: p.reference, status: 'pending' }; },
  };
}
const publisher = { publishPaymentEvent: async () => {} };
const bank = { bankCode: '058', accountNumber: '0123456789', accountName: 'Queue Rider' };

test('float short: the withdrawal is QUEUED with the money set aside, and the page is told so — no refusal', async () => {
  const rider = await riderWithWallet(5000);
  const provider = paystack(0);
  const result = await submitWithdrawal({ paymentsClient: provider, publisher }, { userId: rider.id, walletId: rider.wallet.id, amountNgn: 1200, ...bank, pinPolicy: 'if_set' });
  assert.equal(result.queued, true);
  const request = await prisma.withdrawalRequest.findUnique({ where: { id: result.requestId } });
  assert.equal(request.status, 'QUEUED');
  const wallet = await prisma.wallet.findUnique({ where: { id: rider.wallet.id } });
  assert.deepEqual([Number(wallet.balanceNgn), Number(wallet.lockedNgn)], [3800, 1200], 'set aside, not gone');
  assert.equal(provider.created.length, 0, 'no transfer was attempted');

  // The sweep with an empty float: still waiting. With a float: sent, oldest first, in order.
  const dry = await runPayoutQueueOnce({ paymentsClient: provider, publisher });
  assert.equal(dry.sent, 0, 'an empty float sends nothing');
  assert.ok(dry.waiting >= 1, 'ours is waiting (with whatever earlier runs left behind)');
  provider.balance = 100_000;
  const swept = await runPayoutQueueOnce({ paymentsClient: provider, publisher });
  assert.ok(swept.sent >= 1);
  assert.ok(provider.created.some((p) => p.reference === result.requestId && p.amountNgn === 1200), 'the transfer carries our request id as its reference');
  assert.equal((await prisma.withdrawalRequest.findUnique({ where: { id: result.requestId } })).status, 'PAYOUT_CREATED');
});

test('manual mode queues every withdrawal and the sweep leaves them alone; an admin marks one paid, another is given back', async () => {
  configurePayouts({ mode: 'manual' });
  const rider = await riderWithWallet(10_000);
  const provider = paystack(1_000_000);
  const first = await submitWithdrawal({ paymentsClient: provider, publisher }, { userId: rider.id, walletId: rider.wallet.id, amountNgn: 2000, ...bank, pinPolicy: 'if_set' });
  const second = await submitWithdrawal({ paymentsClient: provider, publisher }, { userId: rider.id, walletId: rider.wallet.id, amountNgn: 3000, ...bank, pinPolicy: 'if_set' });
  assert.equal(first.queued && second.queued, true);
  assert.equal((await runPayoutQueueOnce({ paymentsClient: provider, publisher })).sent, 0, 'manual: nothing goes out by itself, whatever the float');
  assert.equal(provider.created.length, 0);

  const reference = `bank-app-${randomUUID()}`;
  const settled = await markQueuedPaid(first.requestId, reference);
  assert.equal(settled.status, 'SETTLED');
  assert.equal(settled.providerReference, reference);
  let wallet = await prisma.wallet.findUnique({ where: { id: rider.wallet.id } });
  assert.deepEqual([Number(wallet.balanceNgn), Number(wallet.lockedNgn)], [5000, 3000], 'the paid one left the wallet for good; the other is still set aside');

  await cancelQueued(second.requestId, 'Rider asked for it back');
  assert.equal((await prisma.withdrawalRequest.findUnique({ where: { id: second.requestId } })).status, 'CANCELLED');
  wallet = await prisma.wallet.findUnique({ where: { id: rider.wallet.id } });
  assert.deepEqual([Number(wallet.balanceNgn), Number(wallet.lockedNgn)], [8000, 0], 'given back');

  await assert.rejects(markQueuedPaid(second.requestId), /CANCELLED, not queued/);
});
