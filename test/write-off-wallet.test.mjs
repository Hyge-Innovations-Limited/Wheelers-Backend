// Writing off a wallet: a dry run changes nothing, confirming needs the exact
// id and a reason, the amount moves to the platform wallet as two documented
// ADJUSTMENT rows, a second run finds nothing, and money in motion blocks it.
// Local Postgres, throwaway accounts.
//
//   npm -w @wheleers/db run build
//   node scripts/run-with-env.cjs node --test --test-force-exit test/write-off-wallet.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { writeOffWallet } from '../scripts/write-off-wallet.mjs';

const require = createRequire(import.meta.url);
const { prisma } = require('../packages/db/dist/index.js');
const PLATFORM = '00000000-0000-0000-0000-000000000001';
const made = [];
const quiet = () => {};
const REASON = 'Founder test balance, agreed by Ike, 8 Oct';

async function person(balanceNgn, lockedNgn = 0) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:writeoff:${id}`, role: 'DRIVER', name: `Writeoff ${id.slice(0, 6)}` } });
  const wallet = await prisma.wallet.create({ data: { userId: id, balanceNgn, lockedNgn } });
  made.push({ id, walletId: wallet.id });
  return { id, walletId: wallet.id };
}
const platformBalance = async () => Number((await prisma.wallet.findUnique({ where: { userId: PLATFORM } }))?.balanceNgn ?? 0);

test.after(async () => {
  const refs = (await prisma.transaction.findMany({ where: { walletId: { in: made.map((m) => m.walletId) } }, select: { referenceId: true } })).map((r) => r.referenceId);
  const platform = await prisma.wallet.findUnique({ where: { userId: PLATFORM } });
  if (platform) {
    const rows = await prisma.transaction.findMany({ where: { walletId: platform.id, referenceId: { in: refs } } });
    const net = rows.reduce((s, r) => s + (r.direction === 'CREDIT' ? 1 : -1) * Number(r.amountNgn), 0);
    if (net) await prisma.wallet.update({ where: { id: platform.id }, data: { balanceNgn: { decrement: net } } });
  }
  await prisma.transaction.deleteMany({ where: { referenceId: { in: refs } } });
  await prisma.wallet.deleteMany({ where: { id: { in: made.map((m) => m.walletId) } } });
  await prisma.user.deleteMany({ where: { id: { in: made.map((m) => m.id) } } });
  await prisma.$disconnect();
});

test('a dry run changes nothing and gives the id to confirm with', async () => {
  const p = await person(2032.5);
  const r = await writeOffWallet({ user: p.id, reason: REASON, confirm: false, log: quiet, snapshotDir: null });
  assert.equal(r.reason, 'dry-run');
  assert.equal(r.take, 2032.5);
  assert.equal(Number((await prisma.wallet.findUnique({ where: { id: p.walletId } })).balanceNgn), 2032.5);
});

test('confirming moves the balance to the platform wallet, documented, once', async () => {
  const p = await person(2032.5);
  const before = await platformBalance();
  const r = await writeOffWallet({ user: p.id, reason: REASON, confirm: true, log: quiet, snapshotDir: null });
  assert.equal(r.done, true);
  assert.equal(Number((await prisma.wallet.findUnique({ where: { id: p.walletId } })).balanceNgn), 0);
  assert.equal(Math.round((await platformBalance() - before) * 100) / 100, 2032.5);
  const rows = await prisma.transaction.findMany({ where: { referenceId: r.reference } });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.type === 'ADJUSTMENT' && row.metadata.reason === REASON));
  const again = await writeOffWallet({ user: p.id, reason: REASON, confirm: true, log: quiet, snapshotDir: null });
  assert.equal(again.reason, 'nothing');
});

test('it needs the exact id and a reason, and waits while money is moving', async () => {
  const p = await person(500);
  await assert.rejects(writeOffWallet({ user: p.id, reason: 'x', confirm: true, log: quiet, snapshotDir: null }), /Say why/);
  await assert.rejects(writeOffWallet({ user: `Writeoff ${p.id.slice(0, 6)}`, reason: REASON, confirm: true, log: quiet, snapshotDir: null }), /exact user id/);
  const busy = await person(500, 100);
  await assert.rejects(writeOffWallet({ user: busy.id, reason: REASON, confirm: true, log: quiet, snapshotDir: null }), /Money is moving/);
  assert.equal(Number((await prisma.wallet.findUnique({ where: { id: busy.walletId } })).balanceNgn), 500);
});
