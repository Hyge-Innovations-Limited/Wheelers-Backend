#!/usr/bin/env node
/**
 * Pre-launch wallet reset — start the Paystack era with clean books.
 *
 * The ledger carries balances from the testing period that no cash backs
 * (double-credited deposits, manual repairs, rows removed with the demo
 * seed). This script makes every wallet's history replay cleanly and brings
 * every balance to zero, WITHOUT deleting or hiding anything:
 *
 *   1. REBASE   recompute each transaction's running total from its amounts.
 *               Amounts, types and dates are never touched — only the derived
 *               "balance after" column, which old bugs left inconsistent.
 *   2. CORRECT  if the wallet's real balance differs from what its history
 *               adds up to, that difference becomes one explicit ADJUSTMENT
 *               row. The unexplained money is now a visible, labelled line.
 *   3. RESET    one ADJUSTMENT row takes the balance to zero.
 *
 *   node scripts/run-with-env.cjs node scripts/reset-wallets.mjs                  → dry run
 *   node scripts/run-with-env.cjs node scripts/reset-wallets.mjs --confirm        → do it
 *   … --keep=<userId>,<userId>   rebase + correct these wallets but do NOT zero
 *                                them (someone whose money you are carrying over)
 *
 * Refuses to run while any money is in flight (ride holds, withdrawal
 * reservations, locked funds). Writes a JSON snapshot of every wallet first.
 * One database transaction: it all happens or none of it does. Re-running
 * after success changes nothing.
 *
 * Needs migration 20260919060000 (adds the ADJUSTMENT row type).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');

const args = Object.fromEntries(
  process.argv.slice(2).map((raw) => {
    const [key, value] = raw.replace(/^--/, '').split('=');
    return [key, value ?? true];
  }),
);
const CONFIRM = args.confirm === true;
const KEEP = new Set(typeof args.keep === 'string' ? args.keep.split(',').map((s) => s.trim()).filter(Boolean) : []);
const REFERENCE = 'cutover-2026-09';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL missing — run through scripts/run-with-env.cjs');
  process.exit(1);
}

const prisma = new PrismaClient();
const n = (d) => (d === null || d === undefined ? 0 : Number(d));
const round2 = (v) => Math.round(v * 100) / 100;
const fmt = (v) => `₦${v.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;

const wallets = await prisma.wallet.findMany({
  include: {
    user: { select: { id: true, name: true, phone: true, email: true, privyDid: true } },
    transactions: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    rideHolds: { where: { status: 'ACTIVE' } },
    reservations: { where: { status: 'ACTIVE' } },
  },
});

for (const id of KEEP) {
  if (!wallets.some((w) => w.userId === id)) {
    console.error(`--keep: no wallet belongs to user ${id}`);
    process.exit(1);
  }
}

// ── Nothing may be in flight ────────────────────────────────────────
const inFlight = wallets.filter((w) => n(w.lockedNgn) !== 0 || w.rideHolds.length > 0 || w.reservations.length > 0);
const pendingWithdrawals = await prisma.withdrawalRequest.count({
  where: { status: { in: ['PENDING', 'FUNDS_RESERVED', 'PAYOUT_CREATED', 'PROCESSING'] } },
});
if (inFlight.length > 0 || pendingWithdrawals > 0) {
  console.error('\n✗ Money is in flight — finish or cancel these first, then re-run:');
  for (const w of inFlight) {
    console.error(`   ${w.user.name ?? w.userId}  locked ${fmt(n(w.lockedNgn))}  holds ${w.rideHolds.length}  reservations ${w.reservations.length}`);
  }
  if (pendingWithdrawals > 0) console.error(`   ${pendingWithdrawals} withdrawal(s) not yet settled or failed`);
  await prisma.$disconnect();
  process.exit(1);
}

// ── Plan ────────────────────────────────────────────────────────────
const plan = wallets.map((w) => {
  let running = 0;
  const rebased = [];
  for (const t of w.transactions) {
    running = round2(running + n(t.amountNgn) * (t.direction === 'CREDIT' ? 1 : -1));
    if (Math.abs(running - n(t.balanceAfterNgn)) > 0.005) rebased.push({ id: t.id, after: running });
  }
  const balance = round2(n(w.balanceNgn));
  const correction = round2(balance - running); // what history cannot explain
  const keep = KEEP.has(w.userId);
  return {
    wallet: w,
    who: `${w.user.name ?? w.user.phone ?? w.user.email ?? w.userId} (${w.userId.slice(0, 8)})`,
    balance,
    historySum: running,
    rebased,
    correction,
    reset: keep ? 0 : balance,
    keep,
  };
});

const touched = plan.filter((p) => p.rebased.length > 0 || p.correction !== 0 || p.reset !== 0);
console.log(`\n${wallets.length} wallets · ${touched.length} need changes${CONFIRM ? '' : ' (dry run)'}\n`);
for (const p of touched.sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance))) {
  const parts = [];
  if (p.rebased.length) parts.push(`${p.rebased.length} running total(s) rebuilt`);
  if (p.correction !== 0) parts.push(`history adds up to ${fmt(p.historySum)} → correction ${p.correction > 0 ? '+' : '−'}${fmt(Math.abs(p.correction))}`);
  parts.push(p.keep ? `KEPT at ${fmt(p.balance)}` : p.reset !== 0 ? `${fmt(p.balance)} → ₦0` : 'already ₦0');
  console.log(`  ${p.who}\n      ${parts.join(' · ')}`);
}
const totalReset = round2(plan.reduce((a, p) => a + p.reset, 0));
const totalKept = round2(plan.filter((p) => p.keep).reduce((a, p) => a + p.balance, 0));
const totalUnexplained = round2(plan.reduce((a, p) => a + p.correction, 0));
console.log(`\n  written off:            ${fmt(totalReset)}`);
console.log(`  unexplained by history: ${fmt(totalUnexplained)}   (now recorded as explicit rows)`);
console.log(`  carried over (--keep):  ${fmt(totalKept)}   ← the Paystack balance must hold at least this`);

if (!CONFIRM) {
  console.log('\nDry run — nothing changed. Re-run with --confirm.\n');
  await prisma.$disconnect();
  process.exit(0);
}
if (touched.length === 0) {
  console.log('\nNothing to do.\n');
  await prisma.$disconnect();
  process.exit(0);
}

// ── Snapshot, then one transaction ──────────────────────────────────
mkdirSync(new URL('../logs/', import.meta.url), { recursive: true });
const snapshotPath = new URL(`../logs/wallet-reset-snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url);
writeFileSync(snapshotPath, JSON.stringify(wallets.map((w) => ({
  walletId: w.id, userId: w.userId, name: w.user.name, balanceNgn: n(w.balanceNgn), lockedNgn: n(w.lockedNgn),
  transactions: w.transactions.map((t) => ({ id: t.id, type: t.type, direction: t.direction, amountNgn: n(t.amountNgn), balanceAfterNgn: n(t.balanceAfterNgn), referenceId: t.referenceId, createdAt: t.createdAt })),
})), null, 1));
console.log(`\nsnapshot → ${snapshotPath.pathname}`);

const startedAt = Date.now();
await prisma.$transaction(async (tx) => {
  for (const p of touched) {
    for (const row of p.rebased) {
      await tx.transaction.update({ where: { id: row.id }, data: { balanceAfterNgn: row.after } });
    }
    let at = startedAt;
    if (p.correction !== 0) {
      await tx.transaction.create({
        data: {
          walletId: p.wallet.id,
          type: 'ADJUSTMENT',
          direction: p.correction > 0 ? 'CREDIT' : 'DEBIT',
          amountNgn: Math.abs(p.correction),
          balanceAfterNgn: p.balance,
          referenceId: `${REFERENCE}:history-correction`,
          createdAt: new Date(at += 1),
          metadata: {
            reason: 'Balance not explained by the recorded transactions (pre-launch ledger bugs, manual repairs, or rows removed with the demo seed). Recorded so the history replays.',
            historySumNgn: p.historySum,
            balanceNgn: p.balance,
          },
        },
      });
    }
    if (p.reset !== 0) {
      await tx.transaction.create({
        data: {
          walletId: p.wallet.id,
          type: 'ADJUSTMENT',
          direction: p.reset > 0 ? 'DEBIT' : 'CREDIT',
          amountNgn: Math.abs(p.reset),
          balanceAfterNgn: 0,
          referenceId: `${REFERENCE}:reset`,
          createdAt: new Date(at += 1),
          metadata: { reason: 'Pre-launch reset: payments moved from Pouch to Paystack with a clean ledger.', previousBalanceNgn: p.balance },
        },
      });
      await tx.wallet.update({ where: { id: p.wallet.id }, data: { balanceNgn: 0 } });
    }
  }
}, { timeout: 10 * 60_000, maxWait: 60_000 });

console.log(`done — ${touched.length} wallet(s) updated. Now run the audit:\n  node scripts/run-with-env.cjs node scripts/audit-money.mjs\n`);
await prisma.$disconnect();
