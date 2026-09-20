#!/usr/bin/env node
/**
 * How fast is the backend, and how much traffic can it take?
 *
 *   node scripts/load-test.mjs                                   # speed check only — gentle
 *   node scripts/load-test.mjs --ramp                            # + ramp to 50 concurrent
 *   node scripts/load-test.mjs --ramp --max=400 --i-own-this-server
 *   node scripts/load-test.mjs --token=<login JWT>               # include signed-in endpoints
 *   node scripts/load-test.mjs --page-token=<wallet page token>  # include the wallet page API
 *   node scripts/load-test.mjs --base=http://localhost:3000
 *
 * SAFE BY DESIGN against a live server:
 *   • GET only. It never posts, so it cannot book a ride, move money, send a
 *     WhatsApp message, or fire a webhook.
 *   • The ramp climbs in steps and STOPS ITSELF the moment errors pass 2% or
 *     p95 latency passes 3 seconds — it finds the limit without pushing past it.
 *   • More than 50 concurrent requests needs --i-own-this-server.
 *
 * Two phases:
 *   1. SPEED   every endpoint alone, one request at a time → what a single user feels.
 *   2. RAMP    a realistic mix at rising concurrency → where it starts to hurt.
 *
 * Run it from a machine near your users for honest latency. Run it ON the
 * server (against localhost) to measure the server without the network.
 */
import { performance } from 'node:perf_hooks';

const args = Object.fromEntries(process.argv.slice(2).map((raw) => {
  const [k, ...v] = raw.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
}));
const BASE = String(args.base ?? 'https://app.wheelersng.com').replace(/\/+$/, '');
const TOKEN = typeof args.token === 'string' ? args.token : null;
const PAGE_TOKEN = typeof args['page-token'] === 'string' ? args['page-token'] : null;
const RAMP = args.ramp === true;
const OWNED = args['i-own-this-server'] === true;
const MAX = Math.min(Number(args.max ?? 50), 1000);
const STEP_SECONDS = Number(args['step-seconds'] ?? 10);
const SAMPLES = Number(args.samples ?? 15);
const TIMEOUT_MS = Number(args.timeout ?? 10_000);
const ERROR_LIMIT = 0.02;
const P95_LIMIT_MS = 3_000;
/** The unluckiest 1% matter: a server can queue politely, fail nothing, and still be unusable. */
const P99_LIMIT_MS = 3_000;

if (MAX > 50 && !OWNED && !/localhost|127\.0\.0\.1/.test(BASE)) {
  console.error(`Refusing to send ${MAX} concurrent requests to ${BASE} without --i-own-this-server.`);
  process.exit(1);
}

/** weight = share of the ramp mix. `expect` = statuses that mean "the server handled it properly". */
const ENDPOINTS = [
  { name: 'health',                path: '/health',                                  weight: 2, expect: [200] },
  { name: 'wallet page (html)',    path: '/widget/wallet/deposit.html',              weight: 1, expect: [200] },
  { name: 'wallet page (css)',     path: '/widget/wallet/wallet.css',                weight: 1, expect: [200] },
  { name: 'auth reject (no token)', path: '/wallet/overview',                        weight: 1, expect: [401], auth: 'none' },
  { name: 'wallet overview',       path: '/wallet/overview',                         weight: 4, expect: [200], auth: 'login' },
  { name: 'wallet transactions',   path: '/wallet/transactions?limit=20',            weight: 3, expect: [200], auth: 'login' },
  { name: 'deposit info',          path: '/wallet/deposit-info',                     weight: 2, expect: [200, 404], auth: 'login' },
  { name: 'withdrawals list',      path: '/wallet/withdrawals',                      weight: 1, expect: [200], auth: 'login' },
  { name: 'bank list (cached)',    path: '/wallet/withdrawals/bank-networks',        weight: 1, expect: [200], auth: 'login' },
  { name: 'page: session',         path: '/wallet-page/session',                     weight: 3, expect: [200], auth: 'page' },
  { name: 'page: deposit preview', path: '/wallet-page/deposit-preview?mode=send&amount=5000', weight: 3, expect: [200, 403], auth: 'page' },
].filter((e) => (e.auth === 'login' ? TOKEN : e.auth === 'page' ? PAGE_TOKEN : true));

const headersFor = (e) => (e.auth === 'login' ? { Authorization: `Bearer ${TOKEN}` } : e.auth === 'page' ? { Authorization: `Bearer ${PAGE_TOKEN}` } : {});

async function hit(endpoint) {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BASE + endpoint.path, { headers: headersFor(endpoint), signal: controller.signal });
    await res.arrayBuffer(); // the request is not over until the body is read
    const ms = performance.now() - started;
    return { ms, status: res.status, ok: endpoint.expect.includes(res.status) };
  } catch (error) {
    return { ms: performance.now() - started, status: 0, ok: false, error: error.name === 'AbortError' ? 'timeout' : (error.cause?.code ?? error.message) };
  } finally {
    clearTimeout(timer);
  }
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);
const ms = (v) => `${v < 10 ? v.toFixed(1) : Math.round(v)}ms`.padStart(8);
const verdict = (p95) => (p95 < 200 ? 'fast' : p95 < 600 ? 'ok' : p95 < 1500 ? 'SLOW' : 'VERY SLOW');

/* ── phase 1: speed ───────────────────────────────────────────────────── */

console.log(`\nWheelers load test → ${BASE}`);
console.log(`signed-in endpoints: ${TOKEN ? 'yes' : 'no (pass --token=…)'} · wallet page API: ${PAGE_TOKEN ? 'yes' : 'no (pass --page-token=…)'}\n`);
console.log('PHASE 1 — speed, one request at a time');
console.log(`${'endpoint'.padEnd(28)} ${'p50'.padStart(8)} ${'p95'.padStart(8)} ${'max'.padStart(8)}   status  verdict`);

const warm = await hit(ENDPOINTS[0]);
if (warm.status === 0) {
  console.error(`\nCannot reach ${BASE} (${warm.error}). Nothing was tested.`);
  process.exit(1);
}

const unavailable = new Set();
for (const endpoint of ENDPOINTS) {
  const results = [];
  for (let i = 0; i < SAMPLES; i += 1) results.push(await hit(endpoint));
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const statuses = [...new Set(results.map((r) => r.status || r.error))].join(',');
  const bad = results.filter((r) => !r.ok).length;
  // Wrong every single time, and not a server error: the endpoint is not
  // deployed (404) or the token is wrong (401/403). That is not a capacity
  // problem, so it must not be allowed to end the ramp.
  if (bad === results.length && results.every((r) => r.status >= 400 && r.status < 500)) unavailable.add(endpoint.name);
  console.log(`${endpoint.name.padEnd(28)} ${ms(pct(times, 50))} ${ms(pct(times, 95))} ${ms(times.at(-1))}   ${String(statuses).padEnd(6)}  ${bad ? `${bad}/${SAMPLES} UNEXPECTED` : verdict(pct(times, 95))}`);
}

if (!RAMP) {
  console.log('\nSpeed check only. Add --ramp to find how much traffic it can take.\n');
  process.exit(0);
}

/* ── phase 2: ramp ────────────────────────────────────────────────────── */

const rampEndpoints = ENDPOINTS.filter((e) => !unavailable.has(e.name));
if (unavailable.size) console.log(`\nLeft out of the ramp (not deployed, or the token is wrong): ${[...unavailable].join(', ')}`);
if (rampEndpoints.length === 0) {
  console.error('Nothing answered as expected — nothing to ramp.');
  process.exit(1);
}
const bag = rampEndpoints.flatMap((e) => Array(e.weight).fill(e));
const pick = () => bag[Math.floor(Math.random() * bag.length)];
const stages = [5, 10, 25, 50, 100, 200, 400, 700, 1000].filter((c) => c <= MAX);

console.log(`\nPHASE 2 — ramp (${STEP_SECONDS}s per step, stops at >${ERROR_LIMIT * 100}% errors or p95 >${P95_LIMIT_MS}ms)`);
console.log(`${'concurrent'.padStart(10)} ${'req/s'.padStart(8)} ${'p50'.padStart(8)} ${'p95'.padStart(8)} ${'p99'.padStart(8)} ${'errors'.padStart(8)}`);

let lastHealthy = null;
let stoppedBecause = null;
const measured = [];
for (const concurrency of stages) {
  const results = [];
  const deadline = performance.now() + STEP_SECONDS * 1000;
  const worker = async () => { while (performance.now() < deadline) results.push(await hit(pick())); };
  const began = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const seconds = (performance.now() - began) / 1000;

  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const errors = results.filter((r) => !r.ok);
  const errorRate = errors.length / Math.max(1, results.length);
  const rps = results.length / seconds;
  const p95 = pct(times, 95);
  console.log(`${String(concurrency).padStart(10)} ${rps.toFixed(1).padStart(8)} ${ms(pct(times, 50))} ${ms(p95)} ${ms(pct(times, 99))} ${`${(errorRate * 100).toFixed(1)}%`.padStart(8)}`);

  const p99 = pct(times, 99);
  measured.push({ concurrency, rps, p50: pct(times, 50), p95, p99 });
  if (errorRate > ERROR_LIMIT || p95 > P95_LIMIT_MS || p99 > P99_LIMIT_MS) {
    const kinds = {};
    for (const e of errors) kinds[e.status || e.error] = (kinds[e.status || e.error] ?? 0) + 1;
    stoppedBecause = errorRate > ERROR_LIMIT
      ? `errors reached ${(errorRate * 100).toFixed(1)}% ${JSON.stringify(kinds)}`
      : p95 > P95_LIMIT_MS ? `p95 reached ${Math.round(p95)}ms` : `the slowest 1% waited ${Math.round(p99)}ms`;
    break;
  }
  lastHealthy = { concurrency, rps, p95 };
  await new Promise((r) => setTimeout(r, 1500)); // let it breathe between steps
}

console.log('');
if (stoppedBecause) console.log(`Stopped: ${stoppedBecause}.`);

if (measured.length === 0 || (!lastHealthy && measured.length === 1)) {
  console.log('It struggled at the very first step — check the server before adding traffic.');
} else {
  // THROUGHPUT is the ceiling, not concurrency. Once requests/sec stops
  // climbing, every extra user only makes everyone wait longer — so the
  // honest capacity is where throughput first reaches (90% of) its peak.
  const peak = Math.max(...measured.map((m) => m.rps));
  const knee = measured.find((m) => m.rps >= peak * 0.9);
  const last = measured.at(-1);
  console.log(`Throughput tops out at about ${Math.round(peak)} req/s, first reached at ${knee.concurrency} concurrent (typical response ${Math.round(knee.p50)}ms).`);
  if (last.concurrency > knee.concurrency) {
    console.log(`Beyond that it only queues: at ${last.concurrency} concurrent the typical response is ${Math.round(last.p50)}ms and the slowest 1% wait ${Math.round(last.p99)}ms — with no more work getting done.`);
  } else {
    console.log(`It was still climbing at ${last.concurrency}. Raise --max to find the ceiling.`);
  }

  const dbWork = rampEndpoints.some((e) => e.auth === 'login' || e.name === 'page: session');
  // A booking rider makes a request every few seconds; an online driver pings
  // about every 30s. Planning figures, not promises.
  const usable = dbWork ? peak * 0.7 : peak * 0.7 / 3;
  console.log('');
  if (!dbWork) {
    console.log('⚠ NO DATABASE WORK WAS MEASURED (no --token). Real requests run queries and cost roughly 3× more,');
    console.log('  so the planning figures below already divide by three. Pass --token=… to measure instead of guess.');
  }
  console.log(`Plan on ~${Math.round(usable)} req/s (70% of the ceiling${dbWork ? '' : ', ÷3 for database work'}) so there is headroom for spikes:`);
  console.log(`  ≈ ${Math.floor(usable / 0.25).toLocaleString()} riders actively booking at the same moment, or`);
  console.log(`  ≈ ${Math.floor(usable / 0.05).toLocaleString()} drivers online at the same moment.`);
}
console.log('Now run  node scripts/run-with-env.cjs node scripts/db-capacity.mjs  ON the server: the database is usually the first thing to run out.\n');
