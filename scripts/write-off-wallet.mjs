#!/usr/bin/env node
/**
 * Write off one wallet's balance, agreed and documented.
 *
 * For money a person has agreed to give up (a founder's test balance, say):
 * their spendable balance goes to ₦0 and the same amount goes to Wheelers'
 * platform wallet, both as ADJUSTMENT rows carrying the reason. Nothing is
 * deleted or edited; the history shows exactly what happened and why, and
 * the books still add up to the cash held.
 *
 *   node scripts/run-with-env.cjs node scripts/write-off-wallet.mjs --user=oyebade --reason="…"
 *        → dry run: who, how much, and the user id to confirm with
 *   node scripts/run-with-env.cjs node scripts/write-off-wallet.mjs --user=<user id> --reason="…" --confirm
 *        → do it (only with the exact id)
 *   … --amount=1000   part of the balance instead of all of it
 *
 * Refuses while any of their money is moving (held for a ride, reserved for
 * a withdrawal, a withdrawal not finished). The balance is taken in one
 * statement only if it is still there; a snapshot is written to logs/ first.
 * Re-running after it is done finds nothing to write off.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const PLATFORM_USER_ID = '00000000-0000-0000-0000-000000000001';
const naira = (n) => `₦${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const round2 = (v) => Math.round(v * 100) / 100;

export async function writeOffWallet({ user: who, reason, amount, confirm, log = console.log, snapshotDir }) {
  const { prisma, takeFromBalance } = require('../packages/db/dist/index.js');
  if (!who) throw new Error('Say whose wallet: --user=<id | phone | email | name>');
  if (!reason || String(reason).trim().length < 10) throw new Error('Say why, in a sentence: --reason="…" (it is kept on the record)');

  const isId = /^[0-9a-f-]{36}$/i.test(who);
  const users = await prisma.user.findMany({
    where: isId ? { id: who } : {
      OR: [
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
    log(`More than one match for "${who}"; use one of these ids:`);
    for (const u of users) log(`  ${u.id}  ${u.name ?? ''}  ${u.phone ?? ''}  ${u.email ?? ''}  ${u.role}`);
    return { done: false, reason: 'ambiguous' };
  }
  const user = users[0];
  const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } });
  if (!wallet) throw new Error(`${user.name ?? user.id} has no wallet.`);

  const [holds, reservations, pending] = await Promise.all([
    prisma.rideHold.count({ where: { walletId: wallet.id, status: 'ACTIVE' } }),
    prisma.walletReservation.count({ where: { walletId: wallet.id, status: 'ACTIVE' } }),
    prisma.withdrawalRequest.count({ where: { userId: user.id, status: { in: ['PENDING', 'FUNDS_RESERVED', 'PAYOUT_CREATED', 'PROCESSING'] } } }),
  ]);
  if (Number(wallet.lockedNgn) !== 0 || holds || reservations || pending) {
    throw new Error(`Money is moving on this wallet (held ${naira(wallet.lockedNgn)}, ride holds ${holds}, reservations ${reservations}, withdrawals in progress ${pending}). Wait for it to finish.`);
  }

  const balance = round2(Number(wallet.balanceNgn));
  const take = amount === undefined ? balance : round2(Number(amount));
  if (!(take > 0)) {
    log(`${user.name ?? user.id}: nothing to write off (balance ${naira(balance)}).`);
    return { done: false, reason: 'nothing' };
  }
  if (take > balance) throw new Error(`Asked for ${naira(take)}, but the balance is ${naira(balance)}.`);

  log(`\n${user.name ?? 'Unnamed'} (${user.role})  ${user.phone ?? ''}  ${user.email ?? ''}`);
  log(`User id: ${user.id}`);
  log(`Balance ${naira(balance)} → ${naira(round2(balance - take))}   (write off ${naira(take)}, to Wheelers' platform wallet)`);
  log(`Reason on the record: "${reason}"`);

  if (!confirm) {
    log(`\nDry run: nothing changed. To do it:\n  node scripts/run-with-env.cjs node scripts/write-off-wallet.mjs --user=${user.id} --reason="${reason}"${amount !== undefined ? ` --amount=${take}` : ''} --confirm\n`);
    return { done: false, reason: 'dry-run', userId: user.id, take };
  }
  if (!isId) throw new Error('To confirm, name the wallet by its exact user id (shown above).');

  if (snapshotDir !== null) {
    const dir = snapshotDir ?? new URL('../logs/', import.meta.url);
    mkdirSync(dir, { recursive: true });
    writeFileSync(new URL(`write-off-${user.id}-${Date.now()}.json`, dir instanceof URL ? dir : pathToFileURL(`${dir}/`)),
      JSON.stringify({ at: new Date().toISOString(), user, wallet, take, reason }, null, 2));
  }

  const reference = `write-off:${wallet.id}:${Date.now()}`;
  const metadata = { reason, by: 'scripts/write-off-wallet', userId: user.id, userName: user.name };
  const result = await prisma.$transaction(async (tx) => {
    const after = await takeFromBalance(tx, wallet.id, take);
    if (!after) throw new Error('The balance changed while this ran; nothing was written off. Run it again.');
    await tx.transaction.create({ data: { walletId: wallet.id, type: 'ADJUSTMENT', direction: 'DEBIT', amountNgn: take, balanceAfterNgn: after.balanceNgn, referenceId: reference, metadata } });
    const platform = await tx.wallet.upsert({
      where: { userId: PLATFORM_USER_ID },
      create: { userId: PLATFORM_USER_ID, balanceNgn: take },
      update: { balanceNgn: { increment: take } },
    });
    await tx.transaction.create({ data: { walletId: platform.id, type: 'ADJUSTMENT', direction: 'CREDIT', amountNgn: take, balanceAfterNgn: platform.balanceNgn, referenceId: reference, metadata } });
    return after;
  });
  log(`\nDone. ${user.name ?? user.id} now holds ${naira(result.balanceNgn)}; ${naira(take)} moved to Wheelers' platform wallet. Reference ${reference}.\n`);
  return { done: true, userId: user.id, take, reference };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = Object.fromEntries(process.argv.slice(2).map((raw) => {
    const at = raw.indexOf('=');
    return at === -1 ? [raw.replace(/^--/, ''), true] : [raw.slice(0, at).replace(/^--/, ''), raw.slice(at + 1)];
  }));
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL missing — run through scripts/run-with-env.cjs');
    process.exit(1);
  }
  const { prisma } = require('../packages/db/dist/index.js');
  try {
    await writeOffWallet({
      user: typeof args.user === 'string' ? args.user.trim() : '',
      reason: typeof args.reason === 'string' ? args.reason.trim() : '',
      amount: typeof args.amount === 'string' ? args.amount : undefined,
      confirm: args.confirm === true,
    });
  } catch (error) {
    console.error(`\nStopped: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
