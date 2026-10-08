// Ledger vs Paystack deposits: a deposit Paystack received but the ledger
// never credited is found, credited only with --confirm, and only once; one
// with no owner, or a different amount, is listed and never touched. A fake
// Paystack, the local Postgres, a throwaway rider.
//
//   npm run build
//   node scripts/run-with-env.cjs node --test --test-force-exit test/reconcile-deposits.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { reconcileDeposits } from '../scripts/reconcile-paystack-deposits.mjs';

const require = createRequire(import.meta.url);
const { prisma, walletClient } = require('../packages/db/dist/index.js');

const userId = randomUUID();
const accountNumber = `99${Date.now().toString().slice(-8)}`;
const ref = (name) => `test-recon-${userId.slice(0, 8)}-${name}`;
const DAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
let server, baseUrl, walletId;

// What Paystack says it received.
const deposits = {
  [ref('seen')]: { amount: 500000, account: accountNumber },     // ₦5,000, already credited
  [ref('lost')]: { amount: 300000, account: accountNumber },     // ₦3,000, webhook never arrived
  [ref('stray')]: { amount: 100000, account: '0000000001' },     // ₦1,000, nobody's account
  [ref('odd')]: { amount: 250000, account: accountNumber },      // ₦2,500, ledger says otherwise
};

test.before(async () => {
  await prisma.user.create({ data: { id: userId, privyDid: `test:recon:${userId}`, role: 'RIDER', name: 'Recon Test' } });
  walletId = (await prisma.wallet.create({ data: { userId } })).id;
  await prisma.virtualAccount.create({ data: { userId, providerCustomerId: `CUS_${userId.slice(0, 8)}`, providerAccountId: `acct-${userId}`, bankName: 'Test Bank', accountNumber, accountName: 'Recon Test' } });
  await walletClient.creditDeposit({ walletId, amountNgn: 5000, providerFeeNgn: 50, referenceId: ref('seen') });
  await walletClient.creditDeposit({ walletId, amountNgn: 2000, providerFeeNgn: 20, referenceId: ref('odd') });

  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (body) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    if (url.pathname === '/transaction') {
      return send({ status: true, meta: { page: 1, pageCount: 1 }, data: [
        ...Object.entries(deposits).map(([reference, d]) => ({ reference, amount: d.amount, status: 'success', channel: 'dedicated_nuban', paid_at: new Date().toISOString() })),
        { reference: ref('card'), amount: 999900, status: 'success', channel: 'card' },
      ] });
    }
    const verify = url.pathname.match(/^\/transaction\/verify\/(.+)$/);
    if (verify) {
      const d = deposits[decodeURIComponent(verify[1])];
      if (!d) { res.statusCode = 404; return send({ status: false, message: 'Transaction not found' }); }
      return send({ status: true, data: { reference: verify[1], status: 'success', channel: 'dedicated_nuban', amount: d.amount, fees: 3000, customer: { customer_code: 'CUS_nobody', email: 'nobody@example.com' }, authorization: { receiver_bank_account_number: d.account, sender_name: 'A Sender', sender_bank: 'GTBank' } } });
    }
    res.statusCode = 404;
    send({ status: false });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  const refs = [...Object.keys(deposits), ref('card')];
  // Undo only what these deposits did to the platform wallet (other tests may be using it right now).
  const platform = await prisma.wallet.findFirst({ where: { userId: '00000000-0000-0000-0000-000000000001' } });
  if (platform) {
    const rows = await prisma.transaction.findMany({ where: { walletId: platform.id, referenceId: { in: refs } } });
    const net = rows.reduce((sum, r) => sum + (r.direction === 'CREDIT' ? 1 : -1) * Number(r.amountNgn), 0);
    if (net !== 0) await prisma.wallet.update({ where: { id: platform.id }, data: { balanceNgn: { decrement: net } } });
  }
  await prisma.transaction.deleteMany({ where: { referenceId: { in: refs } } });
  await prisma.virtualAccount.deleteMany({ where: { userId } });
  await prisma.wallet.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

const run = (confirm) => reconcileDeposits({ from: DAY, to: DAY, confirm, secretKey: 'sk_test_recon', baseUrl, log: () => {} });
const balance = async () => Number((await prisma.wallet.findUnique({ where: { id: walletId } })).balanceNgn);

test('a report changes nothing; it names what is missing, ownerless and different', async () => {
  const before = await balance();
  const r = await run(false);
  assert.equal(r.received, 4, 'card payments are not deposits');
  assert.equal(r.matched, 2);
  assert.deepEqual(r.missing.map((d) => d.reference), [ref('lost')]);
  assert.equal(r.missing[0].userId, userId);
  assert.deepEqual(r.noOwner.map((d) => d.reference), [ref('stray')]);
  assert.deepEqual(r.mismatch.map((d) => [d.reference, d.amountNgn, d.ledgerNgn]), [[ref('odd'), 2500, 2000]]);
  assert.equal(r.credited.length, 0);
  assert.equal(await balance(), before);
});

test('--confirm credits the missing deposit once, the way the wallet service does', async () => {
  const before = await balance();
  const r = await run(true);
  assert.equal(r.credited.length, 1);
  const row = await prisma.transaction.findFirst({ where: { type: 'DEPOSIT', referenceId: ref('lost') } });
  assert.ok(row, 'a DEPOSIT row keyed on the Paystack reference');
  assert.equal(Number(row.metadata.grossAmountNgn), 3000);
  assert.equal(await balance(), before + r.credited[0].creditedNgn);

  const again = await run(true);
  assert.equal(again.missing.length, 0, 'nothing missing any more');
  assert.equal(again.credited.length, 0);
  assert.equal(await balance(), before + r.credited[0].creditedNgn, 'never twice');
  assert.equal((await prisma.transaction.count({ where: { referenceId: ref('stray') } })), 0, 'the ownerless deposit is never credited');
  const odd = await prisma.transaction.findFirst({ where: { type: 'DEPOSIT', referenceId: ref('odd') } });
  assert.equal(Number(odd.metadata.grossAmountNgn), 2000, 'a differing amount is left for a human');
});
