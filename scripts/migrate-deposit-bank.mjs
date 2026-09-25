#!/usr/bin/env node
/**
 * Move riders' deposit account numbers to another issuing bank (Wema → Titan).
 *
 * Paystack keeps ONE dedicated account per customer. Moving a rider means:
 * retire the old account at Paystack (transfers to it bounce from then on),
 * issue a new one at the target bank, save it, and — with --notify — tell the
 * rider their number changed. The wallet and its balance are untouched: money
 * lives in the ledger, the account number is only the door it comes in by.
 *
 *   node scripts/run-with-env.cjs node scripts/migrate-deposit-bank.mjs                 → dry run: who moves
 *   node scripts/run-with-env.cjs node scripts/migrate-deposit-bank.mjs --confirm       → move them
 *   … --notify         also WhatsApp each moved rider their new number
 *   … --user=<id>      one rider (do this FIRST, with your own account)
 *   … --limit=20       stop after N
 *   … --to=titan-paystack   the target bank (default: PAYSTACK_DVA_BANK from .env)
 *
 * Set PAYSTACK_DVA_BANK=titan-paystack in .env and restart BEFORE running this,
 * so riders who sign up while it runs get Titan accounts too. Safe to re-run: a
 * rider already at the target bank is skipped. Needs a built tree.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const { PaymentsClient } = require('../packages/payments/dist/index.js');

const args = Object.fromEntries(process.argv.slice(2).map((raw) => { const [key, value] = raw.replace(/^--/, '').split('='); return [key, value ?? true]; }));
const CONFIRM = args.confirm === true;
const NOTIFY = args.notify === true;
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const USER_ID = typeof args.user === 'string' ? args.user : null;
const TARGET = (typeof args.to === 'string' ? args.to : process.env.PAYSTACK_DVA_BANK || '').trim();

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL missing — run through scripts/run-with-env.cjs'); process.exit(1); }
if (!TARGET) { console.error('No target bank: set PAYSTACK_DVA_BANK in .env or pass --to=titan-paystack'); process.exit(1); }
const secretKey = process.env.PAYSTACK_SECRET_KEY ?? '';
if (CONFIRM && !/^sk_live_/.test(secretKey)) { console.error('PAYSTACK_SECRET_KEY must be a LIVE key to move real accounts'); process.exit(1); }
if (NOTIFY && !(process.env.META_ACCESS_TOKEN && process.env.META_PHONE_NUMBER_ID)) { console.error('--notify needs META_ACCESS_TOKEN and META_PHONE_NUMBER_ID in .env'); process.exit(1); }

const prisma = new PrismaClient();
const payments = new PaymentsClient({ secretKey: secretKey || 'sk_test_dry_run', baseUrl: process.env.PAYSTACK_BASE_URL || undefined, dvaBank: TARGET, emailDomain: process.env.PAYSTACK_CUSTOMER_EMAIL_DOMAIN || undefined });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "titan-paystack" → "titan": the word that must appear in the bank's name for a rider to count as moved. */
const targetWord = TARGET.split('-')[0].toLowerCase();
const atTarget = (bankName) => (bankName ?? '').toLowerCase().includes(targetWord);

const rows = await prisma.virtualAccount.findMany({
  where: {
    provider: 'paystack',
    status: 'active',
    ...(USER_ID ? { userId: USER_ID } : {}),
    user: { NOT: [{ privyDid: { startsWith: 'seed:' } }, { privyDid: { startsWith: 'parked:' } }, { privyDid: { startsWith: 'platform:' } }, { privyDid: { startsWith: 'deleted:' } }] },
  },
  include: { user: { select: { id: true, name: true, phone: true } } },
  orderBy: { createdAt: 'asc' },
});
const moving = rows.filter((row) => !atTarget(row.bankName));

console.log(`\nPaystack mode: ${payments.isTestMode ? 'TEST' : 'LIVE'} · target bank: ${TARGET}`);
console.log(`${rows.length} live deposit account(s), ${moving.length} to move${CONFIRM ? '' : ' (dry run)'}\n`);
for (const row of moving) console.log(`  ${row.userId}  ${JSON.stringify(row.user.name ?? '')}  ${row.bankName} ${row.accountNumber}${row.user.phone ? '' : '  — no phone, cannot be told'}`);
if (!CONFIRM) { console.log('\nRe-run with --confirm to move them (try --user=<your own id> first).\n'); await prisma.$disconnect(); process.exit(0); }

async function notify(phone, account) {
  const body = [
    '*Your Wheelers account number has changed*',
    '',
    `Bank: ${account.bank_name}`,
    `Account: ${account.account_number}`,
    `Name: ${account.account_name}`,
    '',
    'Use this one from now on when you add money. The old number no longer accepts transfers. Your balance is unchanged.',
  ].join('\n');
  const res = await fetch(`https://graph.facebook.com/v21.0/${process.env.META_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: phone.replace(/^\+/, ''), type: 'text', text: { body } }),
  });
  if (!res.ok) throw new Error(`WhatsApp refused: ${res.status} ${await res.text().catch(() => '')}`);
}

let moved = 0, pending = 0, failed = 0, told = 0;
for (const row of moving.slice(0, LIMIT)) {
  try {
    // Paystack keeps one account per customer: the old one goes first, then the new one is issued.
    await payments.deactivateVirtualAccount(row.providerAccountId);
    let account;
    try {
      account = await payments.createVirtualAccount(row.providerCustomerId, TARGET);
    } catch (error) {
      if (error?.code === 'ACCOUNT_PENDING') {
        // Paystack will announce it by webhook (dedicatedaccount.assign.success), which saves it then.
        pending += 1;
        console.log(`  … ${row.userId}  old account retired; new one is being assigned — the webhook will save it`);
        await prisma.virtualAccount.update({ where: { userId: row.userId }, data: { status: 'reassigning' } });
        continue;
      }
      throw error;
    }
    if (String(account.id) === String(row.providerAccountId)) throw new Error('Paystack returned the retired account again — check the customer in the dashboard');
    await prisma.virtualAccount.update({
      where: { userId: row.userId },
      data: { providerAccountId: String(account.id), bankName: account.bank_name, accountNumber: account.account_number, accountName: account.account_name, status: 'active' },
    });
    moved += 1;
    console.log(`  ✓ ${row.userId}  ${JSON.stringify(row.user.name ?? '')}  ${row.bankName} ${row.accountNumber}  →  ${account.bank_name} ${account.account_number}`);
    if (NOTIFY && row.user.phone) {
      try { await notify(row.user.phone, account); told += 1; } catch (error) { console.log(`    (not told: ${error instanceof Error ? error.message : error})`); }
    }
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${row.userId}  ${JSON.stringify(row.user.name ?? '')}  ${error instanceof Error ? error.message : error}`);
  }
  await sleep(400);
}
console.log(`\nmoved ${moved}, pending ${pending}, told ${told}, failed ${failed}\n`);
await prisma.$disconnect();
process.exit(failed ? 1 : 0);
