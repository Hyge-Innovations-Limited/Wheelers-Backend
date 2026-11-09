#!/usr/bin/env node
/**
 * Duplicate-account cleanup.
 *
 * History: social sign-in looked up users only by provider id and signup only
 * rejected emails that had a password — so one person could end up with an
 * apple: user, a google: user, and several local: users all sharing one email.
 * The auth fixes stop NEW twins; this script retires the existing ones so
 * sign-ins fall through to the one real account.
 *
 *   node scripts/run-with-env.cjs node scripts/dedupe-accounts.mjs            → dry run
 *   node scripts/run-with-env.cjs node scripts/dedupe-accounts.mjs --confirm  → apply
 *
 * Rules — deliberately conservative:
 *   • An account with ANY money, transactions, rides, bids, or driver KYC
 *     progress is NEVER parked.
 *   • Among a duplicate set, the keeper is the account with the most activity
 *     (money > transactions > rides > driver progress > has password > oldest).
 *   • Every other ZERO-activity twin is "parked": privyDid gets a `parked:`
 *     prefix (so provider logins stop matching it) and email is cleared (so
 *     email linking finds the keeper). Nothing is deleted; parking is
 *     reversible by hand.
 *   • If TWO accounts in a set both have activity, the set is flagged
 *     NEEDS-MANUAL-MERGE and only its zero-activity members are parked.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const confirm = process.argv.includes('--confirm');
const n = (d) => (d === null || d === undefined ? 0 : Number(d));

const dups = await prisma.user.groupBy({
  by: ['email'],
  where: { email: { not: null } },
  _count: true,
  having: { email: { _count: { gt: 1 } } },
});

let parkedCount = 0;
for (const dup of dups) {
  const users = await prisma.user.findMany({
    where: { email: dup.email },
    include: {
      wallet: { include: { _count: { select: { transactions: true } } } },
      driver: { select: { id: true, kycStatus: true, vehiclePlate: true, totalRides: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  const enriched = [];
  for (const u of users) {
    const moneyNgn = u.wallet ? n(u.wallet.balanceNgn) + n(u.wallet.lockedNgn) : 0;
    const txCount = u.wallet?._count.transactions ?? 0;
    const rides = await prisma.ride.count({ where: { riderId: u.id } });
    const bids = u.driver
      ? await prisma.driverBid.count({ where: { driverId: u.driver.id } }).catch(() => 0)
      : 0;
    const driverProgress = Boolean(
      u.driver && (u.driver.kycStatus !== 'PENDING' || u.driver.vehiclePlate || (u.driver.totalRides ?? 0) > 0),
    );
    const active = moneyNgn > 0 || txCount > 0 || rides > 0 || bids > 0 || driverProgress;
    const score =
      (moneyNgn > 0 ? 1_000_000 : 0) +
      txCount * 1_000 +
      rides * 500 +
      bids * 200 +
      (driverProgress ? 100 : 0) +
      (u.passwordHash ? 10 : 0);
    enriched.push({ u, moneyNgn, txCount, rides, bids, driverProgress, active, score });
  }

  // keeper: best score; ties go to the OLDEST (findMany is createdAt asc and
  // sort is stable, so the earliest of equals wins)
  const keeper = [...enriched].sort((a, b) => b.score - a.score)[0];
  const activeCount = enriched.filter((e) => e.active).length;

  console.log(`\n═══ ${dup.email} (${users.length} accounts)${activeCount > 1 ? 'NEEDS-MANUAL-MERGE (multiple active)' : ''}`);
  for (const e of enriched) {
    const mark = e.u.id === keeper.u.id ? 'KEEP ' : e.active ? 'HOLD ' : 'PARK ';
    console.log(
      `  ${mark} ${e.u.id.slice(0, 8)}  ${e.u.privyDid.padEnd(44)} ₦${e.moneyNgn.toLocaleString('en-NG')}  tx:${e.txCount} rides:${e.rides} bids:${e.bids} driver:${e.driverProgress ? 'yes' : 'no'} pw:${e.u.passwordHash ? 'yes' : 'no'}`,
    );
  }

  for (const e of enriched) {
    if (e.u.id === keeper.u.id || e.active) continue;
    parkedCount += 1;
    if (confirm) {
      await prisma.user.update({
        where: { id: e.u.id },
        data: { privyDid: `parked:${e.u.privyDid}`, email: null },
      });
      console.log(`  → parked ${e.u.id.slice(0, 8)}`);
    }
  }
}

console.log(
  confirm
    ? `\nDone: ${parkedCount} twin account(s) parked.`
    : `\nDry run: ${parkedCount} twin account(s) WOULD be parked. Re-run with --confirm to apply.`,
);
await prisma.$disconnect();
