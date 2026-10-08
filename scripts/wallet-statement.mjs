#!/usr/bin/env node
/**
 * One person's wallet, line by line: read-only, changes nothing.
 *
 *   node scripts/run-with-env.cjs node scripts/wallet-statement.mjs --user=ike
 *   … --user=<user id | phone | email | part of the name>
 *
 * Prints every ledger entry (deposits, ride payments, driver earnings,
 * refunds, withdrawals, adjustments…), totals by type, and the check that
 * matters: everything credited minus everything debited must equal what the
 * wallet holds (spendable + held). Deposits are split into Paystack ones
 * (references Paystack issued) and others (an older provider, tests,
 * corrections), so "the wallet says X but the deposits were Y" can be
 * answered from the lines themselves.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');

const args = Object.fromEntries(process.argv.slice(2).map((raw) => {
  const [key, value] = raw.replace(/^--/, '').split('=');
  return [key, value ?? true];
}));
const who = typeof args.user === 'string' ? args.user.trim() : '';
if (!who) {
  console.error('Say whose wallet: --user=<id | phone | email | name>');
  process.exit(1);
}

const prisma = new PrismaClient();
const naira = (n) => `₦${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

try {
  const users = await prisma.user.findMany({
    where: {
      OR: [
        ...(/^[0-9a-f-]{36}$/i.test(who) ? [{ id: who }] : []),
        { phone: { contains: who.replace(/\s+/g, '') } },
        { email: { equals: who, mode: 'insensitive' } },
        { name: { contains: who, mode: 'insensitive' } },
      ],
    },
    select: { id: true, name: true, phone: true, email: true, role: true },
    take: 10,
  });
  if (users.length === 0) throw new Error(`No user matches "${who}".`);
  if (users.length > 1) {
    console.log(`More than one match for "${who}"; run again with one of these ids:`);
    for (const u of users) console.log(`  ${u.id}  ${u.name ?? ''}  ${u.phone ?? ''}  ${u.email ?? ''}  ${u.role}`);
    process.exitCode = 2;
  } else {
    const user = users[0];
    const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } });
    if (!wallet) throw new Error(`${user.name ?? user.id} has no wallet.`);
    const rows = await prisma.transaction.findMany({ where: { walletId: wallet.id }, orderBy: { createdAt: 'asc' } });

    console.log(`\n${user.name ?? 'Unnamed'} (${user.role})  ${user.phone ?? ''}  ${user.email ?? ''}`);
    console.log(`Wallet now: spendable ${naira(wallet.balanceNgn)}  ·  held ${naira(wallet.lockedNgn)}  ·  total ${naira(Number(wallet.balanceNgn) + Number(wallet.lockedNgn))}\n`);

    const totals = new Map();
    let net = 0;
    for (const r of rows) {
      const signed = (r.direction === 'CREDIT' ? 1 : -1) * Number(r.amountNgn);
      net += signed;
      const isPaystack = r.type === 'DEPOSIT' && r.referenceId && !/^cm[a-z0-9]{20,}$/.test(r.referenceId);
      const label = r.type === 'DEPOSIT' ? (isPaystack ? 'DEPOSIT (Paystack)' : 'DEPOSIT (other)') : r.type;
      const t = totals.get(label) ?? { credit: 0, debit: 0, count: 0 };
      if (signed > 0) t.credit += signed; else t.debit -= signed;
      t.count += 1;
      totals.set(label, t);
      const note = r.metadata && typeof r.metadata === 'object'
        ? Object.entries(r.metadata).filter(([k]) => ['reason', 'note', 'kind', 'bankName', 'senderAccountName', 'rideId', 'reconciledBy'].includes(k)).map(([k, v]) => `${k}=${v}`).join(' ')
        : '';
      console.log(`${r.createdAt.toISOString().slice(0, 16).replace('T', ' ')}  ${label.padEnd(20)} ${(signed > 0 ? '+' : '−') + naira(Math.abs(signed)).padStart(13)}  → ${naira(r.balanceAfterNgn).padStart(13)}  ${r.referenceId ?? ''}  ${note}`.trimEnd());
    }

    console.log('\nBy type:');
    for (const [label, t] of [...totals.entries()].sort()) {
      console.log(`  ${label.padEnd(20)} ${String(t.count).padStart(3)} entries   in ${naira(t.credit).padStart(13)}   out ${naira(t.debit).padStart(13)}`);
    }
    const holds = Number(wallet.balanceNgn) + Number(wallet.lockedNgn);
    const gap = Math.round((holds - net) * 100) / 100;
    console.log(`\nIn minus out: ${naira(net)}   Wallet holds: ${naira(holds)}   ${gap === 0 ? '✓ they agree' : `✗ off by ${naira(gap)}: the balance changed without a ledger entry`}`);
  }
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
