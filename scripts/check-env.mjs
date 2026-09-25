#!/usr/bin/env node
/**
 * Is `.env` fit to restart production on? Runs BEFORE `npm run pm2:restart`.
 *
 *   node scripts/check-env.mjs
 *
 * A service that finds a bad setting exits at boot, pm2 restarts it, it exits
 * again — and production is down because of a typo. This runs the SAME
 * validation every service runs, in a throwaway process, so the mistake is
 * caught while the old processes are still serving traffic.
 *
 * It also prints what production will actually run with (secrets masked), so
 * "which value is live?" is answered by reading, not guessing. Exits non-zero
 * on anything that would stop a service booting. Changes nothing.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const envPath = new URL('../.env', import.meta.url);
if (!existsSync(envPath)) {
  console.error('✗ .env not found at the repo root.');
  process.exit(1);
}
const configDist = new URL('../packages/config/dist/index.js', import.meta.url).pathname;
if (!existsSync(configDist)) {
  console.error('✗ packages/config is not built. Run `npm run build` first.');
  process.exit(1);
}

const file = Object.fromEntries(
  readFileSync(envPath, 'utf8').split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('#') && l.indexOf('=') > 0)
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '')]),
);

const problems = [];
const warnings = [];

/* ── 1. the services' own validation, exactly as they run it ─────────────── */
// Each validator calls process.exit(1) on failure, so each service is checked
// in a child started the way pm2 starts it: a bare environment, NODE_ENV, and
// the one default every service gives itself before validating
// (KAFKA_CLIENT_ID ??= its own name). A check stricter than the services
// would block a healthy restart — as dangerous as one that is too lax.
const SERVICES = [
  ['api-gateway', ['validateSharedEnv', 'validateGatewayEnv']],
  ['ride-service', ['validateSharedEnv', 'validateRideEnv']],
  ['group-ride', ['validateSharedEnv', 'validateGroupRideEnv']],
  ['payment-service', ['validateSharedEnv', 'validatePaymentEnv']],
  ['wallet-service', ['validateSharedEnv']],
  ['notification-worker', ['validateSharedEnv', 'validateNotificationEnv']],
  ['analytics-worker', ['validateSharedEnv']],
  ['mcp-server', ['validateMcpEnv']],
];
for (const [label, fns] of SERVICES) {
  const program = `const c=require(${JSON.stringify(configDist)});c.loadWorkspaceEnv();process.env.KAFKA_CLIENT_ID??=${JSON.stringify(label)};${fns.map((fn) => `c.${fn}();`).join('')}`;
  const child = spawnSync(process.execPath, ['-e', program], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production' },
    encoding: 'utf8',
  });
  if (child.status !== 0) {
    problems.push(`${label}: settings rejected\n${(child.stderr || child.stdout).trim().split('\n').slice(0, 12).map((l) => `      ${l}`).join('\n')}`);
  }
}

/* ── 2. things that validate fine and are still wrong for production ─────── */
const { resolvePublicBaseUrl, PUBLIC_BASE_URL_DEFAULT } = require(configDist);
const silence = console.error;
console.error = () => {};
const publicUrl = resolvePublicBaseUrl(file.APP_BASE_URL || PUBLIC_BASE_URL_DEFAULT, 'production');
console.error = silence;
if (file.APP_BASE_URL && publicUrl !== file.APP_BASE_URL.replace(/\/+$/, '')) {
  warnings.push(`APP_BASE_URL is a tunnel/local address (${new URL(file.APP_BASE_URL).hostname}). Production will ignore it and use ${publicUrl} — fix the file so it says what it means.`);
}
if (file.NODE_ENV && file.NODE_ENV !== 'production') {
  warnings.push(`NODE_ENV=${file.NODE_ENV} in .env is ignored under pm2 (which sets production). Remove the line or set it to production.`);
}
const paystackMode = /^sk_live_/.test(file.PAYSTACK_SECRET_KEY ?? '') ? 'LIVE' : /^sk_test_/.test(file.PAYSTACK_SECRET_KEY ?? '') ? 'TEST' : 'MISSING';
if (paystackMode === 'TEST') warnings.push('PAYSTACK_SECRET_KEY is a TEST key: no real money will move.');

let services = 8;
try { services = require('../ecosystem.config.cjs').apps.length; } catch { /* keep the default */ }
const poolSize = Number(/[?&]connection_limit=(\d+)/.exec(file.DATABASE_URL ?? '')?.[1] ?? NaN);
if (Number.isFinite(poolSize) && services * poolSize > 97) {
  warnings.push(`DATABASE_URL connection_limit=${poolSize} × ${services} services = ${services * poolSize} connections; Postgres accepts ~97 by default. Run scripts/db-capacity.mjs for the exact figure.`);
}
if (file.EXPO_ACCESS_TOKEN === 'dev') {
  warnings.push('EXPO_ACCESS_TOKEN=dev is a placeholder; it is ignored (a fake token makes Expo reject every push). Remove the line, or set a real token from expo.dev → Access tokens.');
}
for (const key of ['META_ACCESS_TOKEN', 'META_PHONE_NUMBER_ID', 'GROQ_API_KEY', 'GOOGLE_MAPS_API_KEY', 'JWT_SECRET', 'RESEND_API_KEY']) {
  if (!file[key]) warnings.push(`${key} is empty — ${key === 'RESEND_API_KEY' ? 'PIN recovery emails cannot be sent' : 'a feature that depends on it will be off'}.`);
}

/* ── 3. what production will run with ───────────────────────────────────── */
const mask = (v) => (v ? `${v.slice(0, 7)}…(${v.length} chars)` : '— not set');
const host = (v) => { try { return new URL(v).host; } catch { return v ? 'unparseable' : '— not set'; } };
console.log('\nEffective production settings (from .env — the only source):');
for (const [label, value] of [
  ['public URL riders are sent to', publicUrl],
  ['gateway port', file.PORT || '3000 (default)'],
  ['database', `${host(file.DATABASE_URL)} · pool ${Number.isFinite(poolSize) ? poolSize : 'default'} × ${services} services`],
  ['redis', host(file.REDIS_URL)],
  ['kafka', file.KAFKA_BROKERS || '— not set'],
  ['paystack', `${paystackMode}  ${mask(file.PAYSTACK_SECRET_KEY)}`],
  ['paystack account bank', file.PAYSTACK_DVA_BANK || 'wema-bank (default)'],
  // Defaults here MUST match the code's (packages/config constants/deposit.ts,
  // apps/api-gateway LLM/llm.ts) — this printed "₦20" for a server charging ₦30.
  ['deposit fee', `₦${file.DEPOSIT_FEE_NGN || 30}${file.DEPOSIT_FEE_NGN ? '' : ' (default)'}, bank charge paid by ${file.DEPOSIT_PROVIDER_FEE_PAID_BY || 'user'}`],
  ['AI model', file.GEMINI_API_KEY
    ? `Gemini ${file.GEMINI_MODEL || 'gemini-3.8-flash'} · intent ${file.GEMINI_INTENT_MODEL || 'gemini-3.5-flash-lite'} — backup: ${file.GROQ_API_KEY ? `Groq ${file.GROQ_MODEL || 'openai/gpt-oss-120b'}` : 'NONE'}`
    : `Groq only: ${file.GROQ_MODEL || 'openai/gpt-oss-120b'} · intent ${file.GROQ_INTENT_MODEL ?? 'openai/gpt-oss-20b'}GEMINI_API_KEY is not set — the free Groq tier allows ~8 intent reads a minute`],
]) console.log(`  ${label.padEnd(32)} ${value}`);

console.log('');
for (const w of warnings) console.log(`${w}`);
if (problems.length) {
  console.log('');
  for (const p of problems) console.log(`  ✗ ${p}`);
  console.log(`\n✗ ${problems.length} problem(s) would stop a service booting. Production was NOT restarted.\n`);
  process.exit(1);
}
console.log(`${warnings.length ? '\n' : ''}✓ Every service accepts these settings. Safe to restart.\n`);
