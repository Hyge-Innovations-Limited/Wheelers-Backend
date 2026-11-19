// The live wallet (Timi, 19 Nov 2026): the database says when a wallet changes (a trigger, pg_notify on commit), the
// gateway hears it and hands it to the person's app: the balance with what the overview shows, and each new money-
// history row as the history lists it. Every path that writes a wallet is covered, a rolled-back write says nothing.
// Real Postgres (migration 20261119090000_wallet_live applied).
//
//   npm -w @wheleers/db run build && npm -w @wheleers/api-gateway run build
//   node scripts/run-with-env.cjs node --test --test-force-exit test/wallet-live.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { walletClient } = require('../packages/db/dist/index.js');
const live = require('../apps/api-gateway/dist/wallet/live.js');

const prisma = new PrismaClient();
const made = [];
let listener;
const heard = [];
const realWarn = console.warn;

test.before(async () => {
  console.warn = () => {};
  listener = live.startWalletLive({ databaseUrl: process.env.DATABASE_URL, deliver: (userId, type, payload) => heard.push({ userId, type, payload }) });
  for (let i = 0; i < 100 && !listener.listening; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(listener.listening, 'listening');
});
test.after(async () => {
  console.warn = realWarn;
  await listener.stop();
  await prisma.transaction.deleteMany({ where: { wallet: { userId: { in: made } } } });
  await prisma.wallet.deleteMany({ where: { userId: { in: made } } });
  await prisma.user.deleteMany({ where: { id: { in: made } } });
  await prisma.$disconnect();
});

async function person(balanceNgn = 0) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:wallet-live:${id}`, role: 'RIDER', name: 'Live Wallet' } });
  made.push(id);
  const wallet = await prisma.wallet.create({ data: { userId: id, balanceNgn } });
  return { userId: id, walletId: wallet.id };
}
const mine = (userId) => heard.filter((h) => h.userId === userId);
async function until(fn, ms = 3000) {
  for (let t = 0; t < ms; t += 25) { if (fn()) return; await new Promise((r) => setTimeout(r, 25)); }
}

test('a deposit through the wallet code: the new balance and the new row, both, as the app shows them', async () => {
  const p = await person(1000);
  const ref = `dep-${randomUUID()}`;
  await walletClient.credit({ walletId: p.walletId, amountNgn: 2500, type: 'DEPOSIT', referenceId: ref, metadata: { kind: 'deposit' } });
  await until(() => mine(p.userId).length >= 2);
  const got = mine(p.userId);
  assert.ok(got.every((h) => h.type === 'wallet:live'));
  const balance = got.find((h) => 'balanceNgn' in h.payload).payload;
  assert.equal(balance.balanceNgn, 3500);
  assert.equal(balance.lockedNgn, 0);
  assert.equal(balance.owedNgn, 0);
  assert.equal(balance.driverPaused, false);
  assert.equal(typeof balance.cashRides, 'boolean');
  assert.match(balance.updatedAt, /Z$/);
  const row = got.find((h) => h.payload.transaction).payload.transaction;
  assert.deepEqual({ ...row, id: undefined, createdAt: undefined }, {
    id: undefined, type: 'DEPOSIT', direction: 'CREDIT', amountNgn: 2500, balanceAfterNgn: 3500, referenceId: ref, metadata: { kind: 'deposit' }, createdAt: undefined,
  });
  // The same as GET /wallet/transactions has it.
  const stored = await prisma.transaction.findFirst({ where: { referenceId: ref } });
  assert.equal(row.id, stored.id);
  assert.equal(row.createdAt, stored.createdAt.toISOString());
});

test('a hold (lockedNgn) and a write from anywhere (not the wallet code) are heard too; a rolled-back write is not', async () => {
  const p = await person(5000);
  await prisma.wallet.update({ where: { id: p.walletId }, data: { lockedNgn: 1200 } });
  await until(() => mine(p.userId).length >= 1);
  assert.equal(mine(p.userId)[0].payload.lockedNgn, 1200);

  const before = mine(p.userId).length;
  await prisma.$transaction(async (tx) => {
    await tx.wallet.update({ where: { id: p.walletId }, data: { balanceNgn: 1 } });
    throw new Error('rolled back');
  }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(mine(p.userId).length, before, 'never told about money that did not move');

  // A change that is not the balance or the hold (only updatedAt): nothing.
  await prisma.wallet.update({ where: { id: p.walletId }, data: { mayOwe: true } });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(mine(p.userId).length, before);
});

test('a driver who owes from cash trips: the live balance carries what they owe and whether they are paused', async () => {
  const p = await person(0);
  await prisma.wallet.update({ where: { id: p.walletId }, data: { balanceNgn: -1500, mayOwe: true } });
  await until(() => mine(p.userId).length >= 1);
  const b = mine(p.userId)[0].payload;
  assert.equal(b.balanceNgn, -1500);
  assert.equal(b.owedNgn, 1500);
  assert.equal(b.driverPaused, true);
  assert.ok(b.depositToDriveNgn >= 1500);
});

test('the notice and the connection string', () => {
  assert.equal(live.parseWalletNotice('not json'), null);
  assert.equal(live.parseWalletNotice(JSON.stringify({ k: 'w', b: 1 })), null, 'no person: nobody');
  assert.equal(live.parseWalletNotice(JSON.stringify({ k: 't', u: 'x', id: 'y', at: '2026-11-19T10:00:00.5', mx: true })).payload.incomplete, true);
  assert.equal(live.parseWalletNotice(JSON.stringify({ k: 't', u: 'x', id: 'y', at: '2026-11-19T10:00:00.5' })).payload.transaction.createdAt, '2026-11-19T10:00:00.500Z');
  assert.equal(live.pgConnectionString('postgresql://a:b@localhost:5432/w?schema=public&connection_limit=10'), 'postgresql://a:b@localhost:5432/w');
  assert.equal(live.pgConnectionString('postgresql://a:b@db:5432/w?sslmode=require&schema=public'), 'postgresql://a:b@db:5432/w?sslmode=require');
});
