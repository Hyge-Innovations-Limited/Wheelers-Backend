#!/usr/bin/env node
/**
 * Money audit: is every naira the ledger promises backed by real cash,
 * and does every wallet's history actually add up?
 *
 *   node scripts/run-with-env.cjs node scripts/audit-money.mjs [settlementNgn]
 *
 * With PAYSTACK_SECRET_KEY set (it is, through run-with-env) the Paystack
 * balance is read live, so the solvency verdict needs no argument. Pass a
 * figure to override it, e.g. to audit against a number from the dashboard:
 *   node scripts/run-with-env.cjs node scripts/audit-money.mjs 23830
 *
 * Checks, per wallet:
 *   1. TRANSACTION CHAIN — replays every ledger row in order; each row's
 *      balanceAfter must equal the previous balanceAfter ± amount. A break
 *      means a row was edited, deleted, or a balance was set by hand.
 *   2. HEAD MATCH — wallet.balanceNgn must equal the last row's balanceAfter.
 *   3. LOCK BACKING — wallet.lockedNgn must equal ACTIVE ride holds +
 *      ACTIVE withdrawal reservations. Orphaned locks are frozen money.
 * Then globally:
 *   4. LIABILITIES vs CASH — what all wallets sum to (real users vs seed
 *      demo accounts) against the settlement balance you pass in, with
 *      cash-in/cash-out totals from the ledger for cross-checking the provider.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
let settlementNgn = process.argv[2] ? Number(process.argv[2]) : null;
let settlementSource = 'argument';
// Paystack keeps a deposit as "pending settlement" until it settles it (next
// working day). Only the TRANSFER BALANCE can pay a withdrawal. Both are real
// cash, so both count toward solvency — but they are reported apart, because
// "solvent" and "able to pay a withdrawal right now" are different questions.
let transferBalanceNgn = null;
let pendingSettlementNgn = null;
if (settlementNgn === null && /^sk_(test|live)_/.test(process.env.PAYSTACK_SECRET_KEY ?? '')) {
  try {
    const res = await fetch(`${process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co'}/balance`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
    });
    const json = await res.json();
    const ngn = (json.data ?? []).find((b) => b.currency === 'NGN');
    if (res.ok && ngn) {
      const isTest = process.env.PAYSTACK_SECRET_KEY.startsWith('sk_test_');
      transferBalanceNgn = Number(ngn.balance) / 100;
      const totals = await (await fetch(`${process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co'}/transaction/totals`, {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
      })).json().catch(() => null);
      const pending = (totals?.data?.pending_transfers_by_currency ?? []).find((b) => b.currency === 'NGN');
      // Test mode credits the balance instantly AND lists the same money as
      // pending — counting both would double it.
      pendingSettlementNgn = isTest ? 0 : Number(pending?.amount ?? 0) / 100;
      settlementNgn = transferBalanceNgn + pendingSettlementNgn;
      settlementSource = `Paystack ${isTest ? 'TEST' : 'LIVE'}, read live`;
    }
  } catch {
    // fall through: no verdict without a cash figure
  }
}
const n = (d) => (d === null || d === undefined ? 0 : Number(d));
const fmt = (v) => `₦${v.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;

const wallets = await prisma.wallet.findMany({
  include: {
    user: { select: { id: true, name: true, phone: true, email: true, privyDid: true } },
    transactions: { orderBy: { createdAt: 'asc' } },
    rideHolds: { where: { status: 'ACTIVE' } },
    reservations: { where: { status: 'ACTIVE' } },
  },
});

// seed-demo.mjs tags everything it creates with a `seed:` privyDid prefix —
// that is the authoritative marker; name heuristics stay as a fallback.
const isSeed = (u) =>
  (typeof u.privyDid === 'string' && u.privyDid.startsWith('seed:')) ||
  [u.name, u.phone, u.email].some((f) => typeof f === 'string' && /seed|demo|test/i.test(f));

let liabilitiesReal = 0, liabilitiesSeed = 0, platformNgn = 0;
let cashIn = 0, cashOutSettled = 0; // REAL users only — seed cash is fiction
const realRows = [];
const problems = [];

// The platform's own fee wallet is revenue, not a liability to anyone —
// and the demo seeder paid its fictional fees into it, so it must be
// reported separately or it masquerades as millions owed to users.
const isPlatform = (u) => /wheelers platform/i.test(u.name ?? '') || /^0{8}/.test(u.id);

for (const w of wallets) {
  const who = `${w.user.name ?? w.user.phone ?? w.user.email ?? w.userId} (${w.userId.slice(0, 8)})`;
  const seed = isSeed(w.user);
  const balance = n(w.balanceNgn), locked = n(w.lockedNgn);
  if (seed) { liabilitiesSeed += balance + locked; continue; }
  if (isPlatform(w.user)) {
    platformNgn += balance + locked;
  } else {
    liabilitiesReal += balance + locked;
  }
  let walletIn = 0, walletOut = 0;
  for (const t of w.transactions) {
    if (t.type === 'DEPOSIT' && t.direction === 'CREDIT') walletIn += n(t.amountNgn);
    if (t.type === 'WITHDRAWAL' && t.direction === 'DEBIT') walletOut += n(t.amountNgn);
  }
  realRows.push({ who, platform: isPlatform(w.user), balance, locked, tx: w.transactions.length, walletIn, walletOut });

  // 1. replay the chain
  let running = null, chainBreaks = 0;
  for (const t of w.transactions) {
    const amt = n(t.amountNgn) * (t.direction === 'CREDIT' ? 1 : -1);
    const after = n(t.balanceAfterNgn);
    if (running !== null && Math.abs(running + amt - after) > 0.01) chainBreaks += 1;
    running = after;
    if (t.type === 'DEPOSIT' && t.direction === 'CREDIT') cashIn += n(t.amountNgn);
    if (t.type === 'WITHDRAWAL' && t.direction === 'DEBIT') cashOutSettled += n(t.amountNgn);
  }
  if (chainBreaks > 0) {
    problems.push(`CHAIN BREAK  ${who}${seed ? ' [seed]' : ''}: ${chainBreaks} row(s) don't follow from the previous balance`);
  }

  // 2. head must match
  if (w.transactions.length > 0 && Math.abs(running - balance) > 0.01) {
    problems.push(`HEAD DRIFT   ${who}${seed ? ' [seed]' : ''}: ledger ends at ${fmt(running)} but wallet says ${fmt(balance)} (drift ${fmt(balance - running)})`);
  }
  if (w.transactions.length === 0 && balance !== 0) {
    problems.push(`NO HISTORY   ${who}${seed ? ' [seed]' : ''}: balance ${fmt(balance)} with zero transactions`);
  }

  // 3. locks must be backed
  const holdSum = w.rideHolds.reduce((a, h) => a + n(h.amountNgn), 0);
  const resSum = w.reservations.reduce((a, r) => a + n(r.amountNgn), 0);
  if (Math.abs(locked - holdSum - resSum) > 0.01) {
    problems.push(`ORPHAN LOCK  ${who}${seed ? ' [seed]' : ''}: locked ${fmt(locked)} vs holds ${fmt(holdSum)} + reservations ${fmt(resSum)}`);
  }
}

// settled withdrawals cross-check — real users only
const realUserIds = wallets.filter((w) => !isSeed(w.user)).map((w) => w.userId);
const settled = await prisma.withdrawalRequest.aggregate({
  where: { status: 'SETTLED', userId: { in: realUserIds } },
  _sum: { requestedAmountNgn: true }, _count: true,
});
const stuck = await prisma.withdrawalRequest.findMany({
  where: {
    status: { in: ['PENDING', 'FUNDS_RESERVED', 'PAYOUT_CREATED', 'PROCESSING'] },
    userId: { in: realUserIds },
  },
  select: { id: true, userId: true, requestedAmountNgn: true, status: true, createdAt: true },
});

console.log('══════════ WHEELERS MONEY AUDIT ══════════');
console.log(`wallets: ${wallets.length} (${realRows.length} real + platform, ${wallets.length - realRows.length} seeded demo)`);
console.log('\n── every real wallet, largest first ──');
for (const r of realRows.sort((a, b) => (b.balance + b.locked) - (a.balance + a.locked))) {
  console.log(
    `  ${r.platform ? '[PLATFORM] ' : ''}${r.who}  balance ${fmt(r.balance)}  locked ${fmt(r.locked)}  ` +
    `(${r.tx} tx, deposited ${fmt(r.walletIn)}, withdrew ${fmt(r.walletOut)})`,
  );
}
console.log(`platform wallet: ${fmt(platformNgn)} (fees earned minus provider fees absorbed — negative means Wheelers is subsidising)`);
console.log(`liabilities (REAL users):  ${fmt(liabilitiesReal)}   ← must be covered by cash`);
console.log(`liabilities (seed/demo):   ${fmt(liabilitiesSeed)}   (not real money)`);
console.log(`REAL cash-in (deposits): ${fmt(cashIn)}`);
console.log(`REAL cash-out (withdrawals debited): ${fmt(cashOutSettled)}`);
console.log(`REAL withdrawals SETTLED: ${settled._count} totalling ${fmt(n(settled._sum.requestedAmountNgn))}`);
if (stuck.length) {
  console.log(`in-flight/stuck withdrawals: ${stuck.length}`);
  for (const s of stuck) console.log(`   ${s.status} ${fmt(n(s.requestedAmountNgn))} user ${s.userId.slice(0,8)} since ${s.createdAt.toISOString()}`);
}
if (settlementNgn !== null) {
  const gap = settlementNgn - liabilitiesReal;
  // Every deposit and transfer books the provider's fee, so the WHOLE ledger
  // (users + platform) should equal the cash to the kobo. A difference here is
  // money that moved without a ledger row, or a row without money.
  const ledgerVsCash = (liabilitiesReal + platformNgn) - settlementNgn;
  console.log('──────────────────────────────────────────');
  console.log(`provider cash:             ${fmt(settlementNgn)}   (${settlementSource})`);
  if (transferBalanceNgn !== null) {
    console.log(`  ├ transfer balance:      ${fmt(transferBalanceNgn)}   ← the ONLY money that can pay a withdrawal right now`);
    console.log(`  └ pending settlement:    ${fmt(pendingSettlementNgn)}   ← deposits Paystack has received but not yet settled`);
    if (transferBalanceNgn < liabilitiesReal) {
      console.log(`WITHDRAWALS WILL BE REFUSED: users hold ${fmt(liabilitiesReal)} but only ${fmt(transferBalanceNgn)} is in the transfer balance.`);
      console.log('  Top up the Paystack balance (dashboard → Transfers → Top up), and ask Paystack to settle into your balance instead of your bank.');
    }
  }
  console.log(Math.abs(ledgerVsCash) < 0.01
    ? 'BOOKS MATCH CASH: users + platform equals the provider balance exactly'
    : `books differ from cash by ${fmt(ledgerVsCash)} (ledger − cash)`);
  console.log(gap >= 0
    ? `SOLVENT: cash covers real-user liabilities with ${fmt(gap)} platform margin`
    : `SHORTFALL: real-user liabilities exceed cash by ${fmt(-gap)} — that money is promised but not backed`);
} else {
  console.log('(pass the settlement balance as an argument for the solvency verdict)');
}
console.log('──────────────────────────────────────────');
if (problems.length === 0) {
  console.log('every wallet\'s history replays cleanly; no drift, no orphaned locks');
} else {
  console.log(`${problems.length} integrity problem(s):`);
  for (const p of problems) console.log('  ' + p);
}
await prisma.$disconnect();
