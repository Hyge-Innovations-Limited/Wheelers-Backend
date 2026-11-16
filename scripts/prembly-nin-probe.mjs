#!/usr/bin/env node
/**
 * One Prembly NIN Basic lookup, to see the real reply's SHAPE (Timi, 16 Nov 2026): Prembly's page for it was
 * down, so this confirms what the rider NIN check (apps/api-gateway/src/verification/rider-nin.ts) reads.
 * Prints the HTTP status, Prembly's own status words, every key with its type and NEVER a value about the
 * person (names, dates, photo, phone, address stay hidden), then how our code reads it.
 *
 *   node scripts/run-with-env.cjs node scripts/prembly-nin-probe.mjs 12345678901
 *
 * Use your own NIN. Costs one lookup on the Prembly balance. Run ON THE SERVER after `npm run build`.
 * Reads PREMBLY_API_KEY (and PREMBLY_APP_ID, PREMBLY_BASE_URL when set) from .env.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { premblyConfigFromEnv, prembly, NIN_BASIC_PATH, ninBasicBody } = require('../apps/api-gateway/dist/verification/prembly.js');
const { ninRecordNames, sameNin } = require('../apps/api-gateway/dist/verification/rider-nin.js');

const nin = String(process.argv[2] ?? '').replace(/[\s-]/g, '');
if (!/^\d{11}$/.test(nin)) {
  console.error('Give your NIN (11 digits): node scripts/run-with-env.cjs node scripts/prembly-nin-probe.mjs 12345678901');
  process.exit(1);
}
const config = premblyConfigFromEnv();
if (!config) {
  console.error('PREMBLY_API_KEY is not set in .env.');
  process.exit(1);
}

/** Prembly's own words about the call: safe to show. */
const SAFE = new Set(['status', 'response_code', 'detail', 'message', 'was_charged', 'amount', 'note', 'reference']);

/** Every key with its type, nested; values only for Prembly's own status words. */
function shape(value, key = '', depth = 0) {
  const pad = '  '.repeat(depth);
  const label = key ? `${key}: ` : '';
  if (Array.isArray(value)) {
    console.log(`${pad}${label}array(${value.length})`);
    if (value.length && depth < 4) shape(value[0], '[0]', depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    console.log(`${pad}${label}{`);
    if (depth < 4) for (const [k, v] of Object.entries(value)) shape(v, k, depth + 1);
    console.log(`${pad}}`);
    return;
  }
  const type = value === null ? 'null' : typeof value;
  const shown = SAFE.has(key) && (type === 'string' || type === 'boolean' || type === 'number') ? ` = ${JSON.stringify(value)}` : type === 'string' ? ` (${String(value).length} chars)` : '';
  console.log(`${pad}${label}${type}${shown}`);
}

const url = `${config.baseUrl}${NIN_BASIC_PATH}`;
console.log(`POST ${url}  body keys: ${Object.keys(ninBasicBody(nin)).join(', ')}`);
const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json', 'x-api-key': config.apiKey, ...(config.appId ? { 'app-id': config.appId } : {}) },
  body: JSON.stringify(ninBasicBody(nin)),
  signal: AbortSignal.timeout(config.timeoutMs),
}).catch((error) => {
  console.error(`No answer from Prembly: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
const text = await res.text();
console.log(`\nHTTP ${res.status}\n\nThe reply's shape:`);
let raw = null;
try { raw = JSON.parse(text); } catch { console.log(`(not JSON, ${text.length} chars)`); }
if (raw) shape(raw);

// How the rider NIN check reads this same reply (no second call: it is replayed).
const replay = async () => new Response(text, { status: res.status, headers: { 'content-type': 'application/json' } });
const answer = await prembly.ninBasic(config, nin, replay);
console.log(`\nOur code reads it as: ${answer.kind}`);
if (answer.kind === 'found') {
  const keys = ['firstname', 'first_name', 'firstName', 'middlename', 'middle_name', 'middleName', 'surname', 'last_name', 'lastname', 'lastName'].filter((k) => answer.data[k] != null && answer.data[k] !== '');
  console.log(`  name keys found on the record: ${keys.join(', ') || 'NONE (the name check would always fail)'}`);
  console.log(`  name words found: ${ninRecordNames(answer.data).length}`);
  console.log(`  record is for this NIN: ${sameNin(answer.data, nin) ? 'yes' : 'NO'}`);
} else {
  console.log(`  Prembly said: ${answer.detail}`);
}
