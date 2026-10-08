#!/usr/bin/env node
/**
 * Ledger vs Paystack: every deposit Paystack received, credited exactly once.
 *
 * A Paystack virtual account holds no balance of its own: it is an account
 * number that routes a rider's transfer into Wheelers' Paystack account. What
 * must agree is the list of deposits: every successful transfer into a
 * virtual account must be one DEPOSIT in the ledger, for the right person and
 * the right amount. A webhook that never arrived (or failed every retry)
 * leaves money received but never credited; this finds it.
 *
 *   node scripts/run-with-env.cjs node scripts/reconcile-paystack-deposits.mjs                  → report only
 *   node scripts/run-with-env.cjs node scripts/reconcile-paystack-deposits.mjs --confirm        → credit what is missing
 *   … --from=2026-09-01 --to=2026-10-08   the period (Lagos dates; default the last 30 days)
 *
 * What it reports:
 *   missing      Paystack has it, the ledger does not: credited with --confirm
 *   no owner     Paystack has it, no Wheelers user matches it: listed, never credited
 *   mismatch     both have it, the amounts differ: listed for a human, never changed
 *   ledger only  a ledger deposit Paystack does not list in the period (an older
 *                provider's, a test, or a date edge): listed, never changed
 *
 * Safe to run any time and to re-run: nothing is ever set or overwritten.
 * A missing deposit is checked with Paystack again, its owner found the same
 * way the webhook finds it, and credited through the same function the wallet
 * service uses, which is keyed on Paystack's reference: it cannot be credited
 * twice. The rider is not messaged about a deposit credited here.
 * Needs a built tree (`npm run build`).
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

const lagosDay = (date) => date.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
const naira = (n) => `₦${Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every successful transfer into a virtual account in the period, from Paystack's own list. */
async function paystackDeposits({ baseUrl, secretKey, fromIso, toIso }) {
  const out = [];
  for (let page = 1; ; page++) {
    const url = new URL(`${baseUrl.replace(/\/+$/, '')}/transaction`);
    url.searchParams.set('status', 'success');
    url.searchParams.set('from', fromIso);
    url.searchParams.set('to', toIso);
    url.searchParams.set('perPage', '100');
    url.searchParams.set('page', String(page));
    const res = await fetch(url, { headers: { authorization: `Bearer ${secretKey}` } });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.status) throw new Error(`Paystack list failed (${res.status}): ${body?.message ?? 'no answer'}`);
    for (const t of body.data ?? []) {
      if (t.channel !== 'dedicated_nuban' || t.status !== 'success') continue;
      out.push({ reference: String(t.reference), amountNgn: Number(t.amount) / 100, paidAt: t.paid_at ?? t.paidAt ?? null });
    }
    const pageCount = Number(body.meta?.pageCount ?? 1);
    if (page >= pageCount || (body.data ?? []).length === 0) break;
    await sleep(250);
  }
  return out;
}

export async function reconcileDeposits({ from, to, confirm, secretKey, baseUrl, log = console.log }) {
  const { prisma, walletClient } = require('../packages/db/dist/index.js');
  const { PaymentsClient } = require('../packages/payments/dist/index.js');
  const { resolveDepositOwner } = require('../apps/api-gateway/dist/http/paystack.route.js');
  const payments = new PaymentsClient({ secretKey, baseUrl: baseUrl || undefined });

  // Lagos midnight to Lagos midnight.
  const fromIso = new Date(`${from}T00:00:00+01:00`).toISOString();
  const toIso = new Date(new Date(`${to}T00:00:00+01:00`).getTime() + 86400_000).toISOString();

  const received = await paystackDeposits({ baseUrl: baseUrl || 'https://api.paystack.co', secretKey, fromIso, toIso });
  const references = received.map((d) => d.reference);
  const ledger = references.length
    ? await prisma.transaction.findMany({ where: { type: 'DEPOSIT', referenceId: { in: references } }, select: { referenceId: true, amountNgn: true, metadata: true, walletId: true } })
    : [];
  const byRef = new Map(ledger.map((row) => [row.referenceId, row]));

  const report = { received: received.length, receivedNgn: 0, matched: 0, missing: [], noOwner: [], mismatch: [], ledgerOnly: [], credited: [] };

  for (const deposit of received) {
    report.receivedNgn += deposit.amountNgn;
    const row = byRef.get(deposit.reference);
    if (row) {
      report.matched += 1;
      const gross = Number(row.metadata?.grossAmountNgn ?? row.amountNgn);
      if (Math.abs(gross - deposit.amountNgn) > 0.009) report.mismatch.push({ ...deposit, ledgerNgn: gross });
      continue;
    }

    // Not in the ledger: ask Paystack again, the way the webhook does.
    const verified = await payments.verifyTransaction(deposit.reference);
    await sleep(150);
    if (!verified || verified.status !== 'success' || verified.channel !== 'dedicated_nuban' || !(verified.amountNgn > 0)) continue;
    const owner = await resolveDepositOwner(verified.customerId, verified.receiverAccountNumber, verified.customerEmail);
    if (!owner) {
      report.noOwner.push({ ...deposit, account: verified.receiverAccountNumber, customer: verified.customerId });
      continue;
    }
    const wallet = await walletClient.findByUserId(owner.userId);
    if (!wallet) {
      report.noOwner.push({ ...deposit, account: verified.receiverAccountNumber, customer: verified.customerId, userId: owner.userId, why: 'no wallet' });
      continue;
    }
    const missing = { ...deposit, userId: owner.userId, amountNgn: verified.amountNgn, providerFeeNgn: verified.providerFeeNgn };
    report.missing.push(missing);

    if (confirm) {
      const result = await walletClient.creditDeposit({
        walletId: wallet.id,
        amountNgn: verified.amountNgn,
        providerFeeNgn: verified.providerFeeNgn ?? 0,
        referenceId: deposit.reference,
        metadata: {
          providerAccountId: owner.providerAccountId ?? verified.receiverAccountNumber,
          bankName: verified.senderBank,
          senderAccountNumber: verified.senderAccountNumber,
          senderAccountName: verified.senderName,
          reconciledAt: new Date().toISOString(),
          reconciledBy: 'scripts/reconcile-paystack-deposits',
        },
      });
      if (result.applied) report.credited.push({ ...missing, creditedNgn: result.split.userCreditNgn });
    }
  }

  // Ledger deposits in the period that Paystack did not list.
  const ledgerInPeriod = await prisma.transaction.findMany({
    where: { type: 'DEPOSIT', createdAt: { gte: new Date(fromIso), lt: new Date(toIso) } },
    select: { referenceId: true, amountNgn: true, createdAt: true, walletId: true },
  });
  const listed = new Set(references);
  report.ledgerOnly = ledgerInPeriod.filter((row) => row.referenceId && !listed.has(row.referenceId));

  // ── the report ──
  log(`\nPaystack deposits ${from} to ${to}: ${report.received} received, ${naira(report.receivedNgn)}`);
  log(`  ✓ in the ledger:   ${report.matched}`);
  log(`  ✗ missing:         ${report.missing.length}${report.missing.length ? ` (${naira(report.missing.reduce((s, d) => s + d.amountNgn, 0))})` : ''}`);
  for (const d of report.missing) log(`      ${d.reference}  ${naira(d.amountNgn)}  user ${d.userId}  paid ${d.paidAt ?? '?'}`);
  log(`  ? no owner:        ${report.noOwner.length}`);
  for (const d of report.noOwner) log(`      ${d.reference}  ${naira(d.amountNgn)}  account ${d.account ?? '?'}  customer ${d.customer ?? '?'}${d.why ? `  (${d.why})` : ''}`);
  log(`  ≠ amount differs:  ${report.mismatch.length}`);
  for (const d of report.mismatch) log(`      ${d.reference}  Paystack ${naira(d.amountNgn)}  ledger ${naira(d.ledgerNgn)}`);
  log(`  ! ledger only:     ${report.ledgerOnly.length}${report.ledgerOnly.length ? '  (older provider, tests, or a midnight edge: check before acting)' : ''}`);
  for (const row of report.ledgerOnly.slice(0, 20)) log(`      ${row.referenceId}  ${naira(row.amountNgn)}  ${row.createdAt.toISOString()}`);
  if (confirm) {
    log(`\nCredited now: ${report.credited.length}${report.credited.length ? ` (${naira(report.credited.reduce((s, d) => s + d.creditedNgn, 0))} to wallets after the deposit fee)` : ''}`);
  } else if (report.missing.length) {
    log('\nNothing changed. Run again with --confirm to credit the missing deposits.');
  }
  return report;
}

// ── run from the command line ──
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = Object.fromEntries(process.argv.slice(2).map((raw) => {
    const [key, value] = raw.replace(/^--/, '').split('=');
    return [key, value ?? true];
  }));
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL missing — run through scripts/run-with-env.cjs');
    process.exit(1);
  }
  const secretKey = process.env.PAYSTACK_SECRET_KEY ?? '';
  if (!/^sk_(test|live)_/.test(secretKey)) {
    console.error('PAYSTACK_SECRET_KEY missing or malformed');
    process.exit(1);
  }
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const to = typeof args.to === 'string' && day.test(args.to) ? args.to : lagosDay(new Date());
  const from = typeof args.from === 'string' && day.test(args.from) ? args.from : lagosDay(new Date(Date.now() - 29 * 86400_000));
  const { prisma } = require('../packages/db/dist/index.js');
  try {
    await reconcileDeposits({ from, to, confirm: args.confirm === true, secretKey, baseUrl: process.env.PAYSTACK_BASE_URL });
  } catch (error) {
    console.error(`\nStopped: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
