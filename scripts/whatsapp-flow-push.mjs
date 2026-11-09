#!/usr/bin/env node
/**
 * Push apps/api-gateway/src/whatsapp-flows/flow-definition.json to Meta and
 * publish it, so the screens users see match what the repo holds. The screen
 * layout LIVES ON META — deploying the server never changes it; this does.
 *
 *   node scripts/whatsapp-flow-push.mjs
 *
 * Reads META_ACCESS_TOKEN, WHATSAPP_FLOW_ID (and optionally META_WABA_ID)
 * from .env. If Meta refuses to update the current flow because it is
 * already published, the script clones it: creates a fresh flow, uploads
 * the JSON, points it at the endpoint, publishes, and rewrites
 * WHATSAPP_FLOW_ID in .env — then you MUST restart:
 *   pm2 restart ecosystem.config.cjs --update-env
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = resolve(root, '.env');
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
    .map((line) => {
      const idx = line.indexOf('=');
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
    }),
);

const TOKEN = env.META_ACCESS_TOKEN;
const FLOW_ID = env.WHATSAPP_FLOW_ID;
const WABA_ID = env.META_WABA_ID || '2408321253328724';
const ENDPOINT_URI = 'https://app.wheelersng.com/webhooks/whatsapp-flow';
if (!TOKEN || !FLOW_ID) {
  console.error('META_ACCESS_TOKEN / WHATSAPP_FLOW_ID missing from .env');
  process.exit(1);
}

const BASE = 'https://graph.facebook.com/v21.0';
const jsonPath = resolve(root, 'apps/api-gateway/src/whatsapp-flows/flow-definition.json');
const flowJson = readFileSync(jsonPath, 'utf8');
JSON.parse(flowJson); // fail fast on malformed JSON
const offersJsonPath = resolve(root, 'apps/api-gateway/src/whatsapp-flows/offers-flow-definition.json');
const offersJson = readFileSync(offersJsonPath, 'utf8');
JSON.parse(offersJson);

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

function uploadAsset(flowId, content = flowJson) {
  const form = new FormData();
  form.append('name', 'flow.json');
  form.append('asset_type', 'FLOW_JSON');
  form.append('file', new Blob([content], { type: 'application/json' }), 'flow.json');
  return api(`/${flowId}/assets`, { method: 'POST', body: form });
}

function reportValidation(body) {
  const errors = body?.validation_errors ?? [];
  for (const e of errors) {
    console.error(`  validation ${e.error_type ?? ''}: ${e.message} (${e.pointers?.map((p) => p.path).join(', ') ?? ''})`);
  }
  return errors.length;
}

const current = await api(`/${FLOW_ID}?fields=id,name,status`);
console.log('current flow:', current.body);

// 1) Try to update the existing flow in place.
let upload = await uploadAsset(FLOW_ID);
let targetId = FLOW_ID;

if (!upload.ok) {
  console.log('in-place update refused:', upload.body?.error?.message ?? upload.body);
  console.log('cloning to a new flow…');

  const created = await api(`/${WABA_ID}/flows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `Wheelers Ride Book ${new Date().toISOString().slice(0, 10)}`, categories: ['OTHER'] }),
  });
  if (!created.ok) {
    console.error('flow creation failed:', JSON.stringify(created.body));
    process.exit(1);
  }
  targetId = created.body.id;
  console.log('new flow id:', targetId);

  upload = await uploadAsset(targetId);
}

if (!upload.ok) {
  console.error('asset upload failed:', JSON.stringify(upload.body));
  process.exit(1);
}
if (reportValidation(upload.body) > 0) {
  console.error('flow JSON has validation errors — fix before publishing');
  process.exit(1);
}
console.log('flow.json uploaded');

// 2) Make sure the endpoint is attached (required before publish).
const meta = await api(`/${targetId}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ endpoint_uri: ENDPOINT_URI }),
});
if (!meta.ok) {
  console.log('endpoint_uri set skipped:', meta.body?.error?.message ?? meta.body);
} else {
  console.log('endpoint_uri set');
}

// 3) Wait for the endpoint to answer (a pm2 restart right before this
// script leaves the gateway booting; Meta's health check then fails).
// A garbage POST getting 421 proves the flow endpoint is alive.
process.stdout.write('waiting for endpoint');
let ready = false;
for (let i = 0; i < 24 && !ready; i++) {
  try {
    const probe = await fetch(ENDPOINT_URI, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    ready = probe.status === 421 || probe.status === 200;
  } catch { /* not up yet */ }
  if (!ready) {
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 5000));
  }
}
console.log(ready ? ' alive' : ' still down after 2 min — publishing anyway');

// 4) Publish — retry, Meta sometimes needs a couple of health probes.
let published;
for (let attempt = 1; attempt <= 4; attempt++) {
  published = await api(`/${targetId}/publish`, { method: 'POST' });
  if (published.ok) break;
  console.log(`publish attempt ${attempt} failed: ${published.body?.error?.error_user_title ?? published.body?.error?.message ?? 'unknown'}${attempt < 4 ? ' — retrying in 15s…' : ''}`);
  if (attempt < 4) await new Promise((r) => setTimeout(r, 15000));
}
if (!published.ok) {
  console.error('publish failed:', JSON.stringify(published.body));
  console.error('(is https://app.wheelersng.com/webhooks/whatsapp-flow reachable from outside?)');
  process.exit(1);
}
console.log('published');

// 4) If we cloned, rewire .env so the button opens the new flow.
if (targetId !== FLOW_ID) {
  const envRaw = readFileSync(envPath, 'utf8');
  writeFileSync(envPath, envRaw.replace(/^WHATSAPP_FLOW_ID=.*$/m, `WHATSAPP_FLOW_ID=${targetId}`));
  console.log(`\n.env updated: WHATSAPP_FLOW_ID=${targetId}`);
  console.log('NOW RUN:  pm2 restart ecosystem.config.cjs --update-env');
} else {
  console.log('\nSame flow id — no restart needed. Send "hi" and open the form.');
}

// ── OFFERS flow: entry screen IS the bid list ('View offers' opens it) ──
let offersId = env.WHATSAPP_OFFERS_FLOW_ID;
if (!offersId) {
  const created = await api(`/${WABA_ID}/flows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Wheelers Driver Offers', categories: ['OTHER'] }),
  });
  if (!created.ok) {
    console.error('offers flow creation failed:', JSON.stringify(created.body));
    process.exit(1);
  }
  offersId = created.body.id;
  const envRaw = readFileSync(envPath, 'utf8');
  writeFileSync(envPath, envRaw.trimEnd() + `\nWHATSAPP_OFFERS_FLOW_ID=${offersId}\n`);
  console.log(`\noffers flow created: ${offersId} (written to .env)`);
  console.log('NOW RUN:  pm2 restart ecosystem.config.cjs --update-env');
}

const offersUpload = await uploadAsset(offersId, offersJson);
if (!offersUpload.ok) {
  console.error('offers flow upload failed:', JSON.stringify(offersUpload.body));
  process.exit(1);
}
if (reportValidation(offersUpload.body) > 0) {
  console.error('offers flow JSON has validation errors');
  process.exit(1);
}
console.log('offers flow.json uploaded');

const offersMeta = await api(`/${offersId}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ endpoint_uri: ENDPOINT_URI }),
});
if (offersMeta.ok) console.log('offers endpoint_uri set');

let offersPublished;
for (let attempt = 1; attempt <= 4; attempt++) {
  offersPublished = await api(`/${offersId}/publish`, { method: 'POST' });
  if (offersPublished.ok) break;
  console.log(`offers publish attempt ${attempt} failed: ${offersPublished.body?.error?.error_user_title ?? offersPublished.body?.error?.message ?? 'unknown'}${attempt < 4 ? ' — retrying in 15s…' : ''}`);
  if (attempt < 4) await new Promise((r) => setTimeout(r, 15000));
}
if (!offersPublished.ok) {
  console.error('offers publish failed:', JSON.stringify(offersPublished.body));
  process.exit(1);
}
console.log('offers flow published');
