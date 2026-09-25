#!/usr/bin/env node
/**
 * Create / update / publish ONE of the forms that are switched on — and only it.
 * The old booking and "Driver Offers" flows are off; this script never touches them.
 *
 *   npm run flow:push:edit-trip     the "Confirm or edit trip" form
 *   npm run flow:push:offers        the offers form (accept / change price / decline / cancel)
 *   npm run flow:push:forms         both, one after the other
 *                                   (run ON THE SERVER, from the repo root)
 *
 * Reads META_ACCESS_TOKEN (and optionally META_WABA_ID, APP_BASE_URL) from .env.
 * First run: creates the flow on Meta and writes its id to .env
 * (WHATSAPP_EDIT_TRIP_FLOW_ID / WHATSAPP_OFFERS_FORM_FLOW_ID). Later runs: uploads the JSON to that flow; if Meta refuses because it is
 * already published, clones it to a new flow and rewrites the id.
 * Whenever the id in .env changes you MUST restart so the bot sends the new one:
 *   npm run pm2:reload            (or: pm2 restart ecosystem.config.cjs --update-env)
 *
 * The screens LIVE ON META: `git pull` changes what the form DOES (the server),
 * this script changes how it LOOKS. The gateway must be up when this runs —
 * publishing makes Meta health-check the endpoint.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = resolve(root, '.env');
const readEnv = () => Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
    .map((line) => { const at = line.indexOf('='); return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^["']|["']$/g, '')]; }),
);
const env = readEnv();

const FORMS = {
  'edit-trip': { envKey: 'WHATSAPP_EDIT_TRIP_FLOW_ID', name: 'Wheelers Edit Trip', json: 'edit-trip-flow-definition.json' },
  offers: { envKey: 'WHATSAPP_OFFERS_FORM_FLOW_ID', name: 'Wheelers Offers Form', json: 'offers-form-flow-definition.json' },
};
const which = process.argv[2];
const chosen = FORMS[which];
if (!chosen) { console.error(`usage: node scripts/whatsapp-form-push.mjs <${Object.keys(FORMS).join('|')}>`); process.exit(1); }
console.log(`\n── ${chosen.name} ──`);
const ENV_KEY = chosen.envKey;
const TOKEN = env.META_ACCESS_TOKEN;
const WABA_ID = env.META_WABA_ID || '2408321253328724';
const ENDPOINT_URI = `${(env.APP_BASE_URL || 'https://app.wheelersng.com').replace(/\/+$/, '')}/webhooks/whatsapp-flow`;
if (!TOKEN) { console.error('META_ACCESS_TOKEN missing from .env'); process.exit(1); }

const flowJson = readFileSync(resolve(root, 'apps/api-gateway/src/whatsapp-flows', chosen.json), 'utf8');
JSON.parse(flowJson); // fail fast on malformed JSON

const BASE = 'https://graph.facebook.com/v21.0';
async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
}
function upload(flowId) {
  const form = new FormData();
  form.append('name', 'flow.json');
  form.append('asset_type', 'FLOW_JSON');
  form.append('file', new Blob([flowJson], { type: 'application/json' }), 'flow.json');
  return api(`/${flowId}/assets`, { method: 'POST', body: form });
}
async function create() {
  const created = await api(`/${WABA_ID}/flows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `${chosen.name} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, categories: ['OTHER'] }),
  });
  if (!created.ok) { console.error('flow creation failed:', JSON.stringify(created.body)); process.exit(1); }
  console.log('created flow', created.body.id);
  return created.body.id;
}

const before = env[ENV_KEY] || null;
let flowId = before ?? await create();
let uploaded = await upload(flowId);
if (!uploaded.ok && before) {
  console.log('in-place update refused (a published flow cannot be edited):', uploaded.body?.error?.message ?? uploaded.body);
  flowId = await create();
  uploaded = await upload(flowId);
}
if (!uploaded.ok) { console.error('flow.json upload failed:', JSON.stringify(uploaded.body)); process.exit(1); }
const problems = uploaded.body?.validation_errors ?? [];
for (const problem of problems) console.error(`  validation ${problem.error_type ?? ''}: ${problem.message} (${problem.pointers?.map((p) => p.path).join(', ') ?? ''})`);
if (problems.length > 0) { console.error('the flow JSON has validation errors — nothing was published'); process.exit(1); }
console.log('flow.json uploaded');

const attached = await api(`/${flowId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint_uri: ENDPOINT_URI }) });
console.log(attached.ok ? `endpoint set${ENDPOINT_URI}` : `endpoint not set: ${attached.body?.error?.message ?? JSON.stringify(attached.body)}`);

// Meta health-checks the endpoint on publish. A garbage POST answered 421 proves it is alive.
process.stdout.write('waiting for the endpoint');
let alive = false;
for (let i = 0; i < 24 && !alive; i++) {
  try { const probe = await fetch(ENDPOINT_URI, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); alive = probe.status === 421 || probe.status === 200; } catch { /* not up yet */ }
  if (!alive) { process.stdout.write('.'); await new Promise((r) => setTimeout(r, 5000)); }
}
console.log(alive ? ' alive' : ' still down after 2 min — trying to publish anyway');

let published;
for (let attempt = 1; attempt <= 4; attempt++) {
  published = await api(`/${flowId}/publish`, { method: 'POST' });
  if (published.ok) break;
  console.log(`publish attempt ${attempt} failed: ${published.body?.error?.error_user_title ?? published.body?.error?.message ?? 'unknown'}${attempt < 4 ? ' — retrying in 15s…' : ''}`);
  if (attempt < 4) await new Promise((r) => setTimeout(r, 15000));
}
if (!published.ok) {
  console.error('publish failed:', JSON.stringify(published.body));
  console.error(`(is ${ENDPOINT_URI} reachable from outside, and is WHATSAPP_FLOW_PRIVATE_KEY set on the server?)`);
  process.exit(1);
}
console.log('published');

if (flowId !== before) {
  const raw = readFileSync(envPath, 'utf8');
  const line = `${ENV_KEY}=${flowId}`;
  writeFileSync(envPath, new RegExp(`^${ENV_KEY}=.*$`, 'm').test(raw) ? raw.replace(new RegExp(`^${ENV_KEY}=.*$`, 'm'), line) : `${raw.trimEnd()}\n${line}\n`);
  console.log(`\n.env updated: ${line}`);
  console.log('NOW RUN:  npm run pm2:reload     ← the bot only sends the form after this');
} else {
  console.log('\nSame flow id — no restart needed.');
}
