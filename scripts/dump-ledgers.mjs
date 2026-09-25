#!/usr/bin/env node
/**
 * Full forensic ledger dump for the real wallets that hold money — every
 * transaction with a chain check, so fabricated credits (hand edits,
 * duplicate refunds) can be identified row by row and clawed back.
 *
 *   node scripts/run-with-env.cjs node scripts/dump-ledgers.mjs
 */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const n = (d) => (d === null || d === undefined ? 0 : Number(d));
const fmt = (v) => `₦${v.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;

// The six real wallets holding balances (from audit v3), by user-id prefix.
const PREFIXES = ['2a2517ea', '816cc8df', '1b59fc04', '980f6068', '15d7f4c9', '31b74f18'];

const wallets = await prisma.wallet.findMany({
  include: {
    user: { select: { id: true, name: true } },
    transactions: { orderBy: { createdAt: 'asc' } },
  },
});

for (const w of wallets) {
  if (!PREFIXES.some((p) => w.userId.startsWith(p))) continue;
  console.log(`\n════ ${w.user.name ?? w.userId} (${w.userId.slice(0, 8)}) — balance ${fmt(n(w.balanceNgn))}, locked ${fmt(n(w.lockedNgn))} ════`);
  let running = null;
  const refCounts = {};
  for (const t of w.transactions) refCounts[`${t.type}:${t.direction}:${t.referenceId}`] = (refCounts[`${t.type}:${t.direction}:${t.referenceId}`] ?? 0) + 1;
  for (const t of w.transactions) {
    const amt = n(t.amountNgn) * (t.direction === 'CREDIT' ? 1 : -1);
    const after = n(t.balanceAfterNgn);
    const chainOk = running === null || Math.abs(running + amt - after) <= 0.01;
    const dupe = refCounts[`${t.type}:${t.direction}:${t.referenceId}`] > 1;
    console.log(
      `  ${t.createdAt.toISOString().slice(0, 16)}  ${t.type.padEnd(18)} ${t.direction.padEnd(6)} ` +
      `${fmt(Math.abs(amt)).padStart(12)} → after ${fmt(after).padStart(12)}  ` +
      `ref=${String(t.referenceId).slice(0, 24)}${chainOk ? '' : '  CHAIN-BREAK'}${dupe ? '  DUPE-REF' : ''}`,
    );
    running = after;
  }
  if (running !== null && Math.abs(running - n(w.balanceNgn)) > 0.01) {
    console.log(`HEAD: history ends at ${fmt(running)} but wallet says ${fmt(n(w.balanceNgn))}`);
  }
}
await prisma.$disconnect();
