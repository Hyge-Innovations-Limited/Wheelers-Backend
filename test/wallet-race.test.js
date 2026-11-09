// Two payments from one wallet in the same instant: only what the balance
// covers goes through, and no wallet ever goes below zero (the platform
// wallet excepted). Local Postgres, fresh accounts.
//
//   npm -w @wheleers/db run build
//   node scripts/run-with-env.cjs node --test --test-force-exit test/wallet-race.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { prisma, walletClient, takeFromBalance } = require('../packages/db/dist/index.js');

const made = [];

async function walletWith(balanceNgn) {
  const userId = randomUUID();
  await prisma.user.create({ data: { id: userId, privyDid: `test:wallet-race:${userId}`, role: 'RIDER', name: 'Race Test' } });
  const wallet = await prisma.wallet.create({ data: { userId, balanceNgn } });
  made.push({ userId, walletId: wallet.id });
  return wallet.id;
}

const balanceOf = async (walletId) => {
  const w = await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
  return { balance: Number(w.balanceNgn), locked: Number(w.lockedNgn) };
};

test.after(async () => {
  const walletIds = made.map((m) => m.walletId);
  await prisma.transaction.deleteMany({ where: { walletId: { in: walletIds } } });
  await prisma.wallet.deleteMany({ where: { id: { in: walletIds } } });
  await prisma.user.deleteMany({ where: { id: { in: made.map((m) => m.userId) } } });
  await prisma.$disconnect();
});

test('two ₦4,000 debits at once from ₦5,000: one goes through, one is refused', async () => {
  const walletId = await walletWith(5000);
  const results = await Promise.allSettled([1, 2].map((i) => walletClient.debit({ walletId, amountNgn: 4000, type: 'RIDE_PAYMENT', referenceId: `race-${walletId}-${i}` })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.match(String(results.find((r) => r.status === 'rejected').reason.message), /Insufficient balance/);
  assert.deepEqual(await balanceOf(walletId), { balance: 1000, locked: 0 });
});

test('ten holds at once never lock more than the wallet has', async () => {
  const walletId = await walletWith(10000);
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => walletClient.lockFunds(walletId, 3000)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
  assert.deepEqual(await balanceOf(walletId), { balance: 1000, locked: 9000 });
});

test('the take is all or nothing', async () => {
  const walletId = await walletWith(500);
  const none = await prisma.$transaction((tx) => takeFromBalance(tx, walletId, 501));
  assert.equal(none, null);
  assert.deepEqual(await balanceOf(walletId), { balance: 500, locked: 0 });
  const done = await prisma.$transaction((tx) => takeFromBalance(tx, walletId, 500, { lock: true }));
  assert.equal(Number(done.balanceNgn), 0);
  assert.equal(Number(done.lockedNgn), 500);
});

test('the database itself refuses a negative wallet', async () => {
  const walletId = await walletWith(100);
  await assert.rejects(prisma.wallet.update({ where: { id: walletId }, data: { balanceNgn: { decrement: 200 } } }), /Wallet_balance_not_negative/);
  await assert.rejects(prisma.wallet.update({ where: { id: walletId }, data: { lockedNgn: { decrement: 1 } } }), /Wallet_locked_not_negative/);
  assert.deepEqual(await balanceOf(walletId), { balance: 100, locked: 0 });
});
