#!/usr/bin/env node
/**
 * Give every real user a Paystack deposit account.
 *
 * This is the account half of the Pouch → Paystack move, and the repair tool
 * afterwards: anyone without a LIVE account (never had one, or only has a
 * retired Rubies row from Pouch) gets a Paystack customer and a dedicated
 * account number. Bank-facing names are the letters-only version of the
 * display name, so "Olá🌸" is issued as "Ola User" — never mangled again.
 *
 *   node scripts/run-with-env.cjs node scripts/provision-deposit-accounts.mjs            → dry run
 *   node scripts/run-with-env.cjs node scripts/provision-deposit-accounts.mjs --confirm  → provision
 *   … --user=<id>      one user
 *   … --limit=50       stop after N
 *
 * Safe to re-run at any point: Paystack returns the same customer for the same
 * user and the same account for the same customer, and a user who already has
 * a live account is skipped. Needs a built tree (`npm run build`). It uses the
 * gateway's own provisioning function — there is one code path to the bank.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const { PaymentsClient, bankNameParts } = require('../packages/payments/dist/index.js');
const { provisionDepositAccount } = require('../apps/api-gateway/dist/onboarding/user-onboarding.js');

const args = Object.fromEntries(
  process.argv.slice(2).map((raw) => {
    const [key, value] = raw.replace(/^--/, '').split('=');
    return [key, value ?? true];
  }),
);
const CONFIRM = args.confirm === true;
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const USER_ID = typeof args.user === 'string' ? args.user : null;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL missing — run through scripts/run-with-env.cjs');
  process.exit(1);
}
const secretKey = process.env.PAYSTACK_SECRET_KEY ?? '';
if (CONFIRM && !/^sk_(test|live)_/.test(secretKey)) {
  console.error('PAYSTACK_SECRET_KEY missing or malformed — cannot provision');
  process.exit(1);
}

const prisma = new PrismaClient();
const payments = new PaymentsClient({
  secretKey: secretKey || 'sk_test_dry_run',
  baseUrl: process.env.PAYSTACK_BASE_URL || undefined,
  dvaBank: process.env.PAYSTACK_DVA_BANK || undefined,
  emailDomain: process.env.PAYSTACK_CUSTOMER_EMAIL_DOMAIN || undefined,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const users = await prisma.user.findMany({
  where: {
    ...(USER_ID ? { id: USER_ID } : {}),
    // No account at all, or only a retired one.
    OR: [{ virtualAccount: null }, { virtualAccount: { provider: { not: 'paystack' } } }],
    NOT: [
      { privyDid: { startsWith: 'seed:' } },
      { privyDid: { startsWith: 'parked:' } },
      { privyDid: { startsWith: 'platform:' } },
      { privyDid: { startsWith: 'deleted:' } },
    ],
  },
  select: { id: true, name: true, phone: true, privyDid: true, virtualAccount: { select: { bankName: true, accountNumber: true, provider: true } } },
  orderBy: { createdAt: 'asc' },
});

console.log(`\nPaystack mode: ${payments.isTestMode ? 'TEST' : 'LIVE'}`);
console.log(`${users.length} real user(s) need a deposit account${CONFIRM ? '' : ' (dry run)'}\n`);
for (const u of users) {
  const { firstName, lastName } = bankNameParts(u.name);
  const old = u.virtualAccount ? `  (replaces retired ${u.virtualAccount.bankName} ${u.virtualAccount.accountNumber})` : '';
  const wait = u.phone ? '' : '  — NO PHONE: gets an account when they verify one';
  console.log(`  ${u.id}  ${JSON.stringify(u.name ?? '')}  →  ${firstName} ${lastName}${old}${wait}`);
}

if (!CONFIRM) {
  console.log('\nRe-run with --confirm to provision.\n');
  await prisma.$disconnect();
  process.exit(0);
}

let ok = 0;
let pending = 0;
let waiting = 0;
let failed = 0;
for (const u of users.slice(0, LIMIT)) {
  try {
    const status = await provisionDepositAccount(payments, u.id, u.name ?? undefined, u.phone ?? undefined);
    const va = await prisma.virtualAccount.findFirst({ where: { userId: u.id, provider: 'paystack' } });
    if (status === 'needs_phone') {
      // Not a failure: the bank will not open an account without a phone, and
      // the gateway provisions automatically the moment one is verified.
      waiting += 1;
      continue;
    } else if (va) {
      ok += 1;
      console.log(`  ✓ ${u.id}  ${JSON.stringify(u.name ?? '')}  ${va.bankName} ${va.accountNumber}  "${va.accountName}"`);
    } else {
      pending += 1;
      console.log(`  … ${u.id}  ${JSON.stringify(u.name ?? '')}  assignment pending — Paystack will confirm by webhook`);
    }
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${u.id}  ${JSON.stringify(u.name ?? '')}  ${error instanceof Error ? error.message : error}`);
  }
  await sleep(350);
}

console.log(`\nprovisioned ${ok}, pending ${pending}, waiting for a phone number ${waiting}, failed ${failed}\n`);
await prisma.$disconnect();
process.exit(failed ? 1 : 0);
