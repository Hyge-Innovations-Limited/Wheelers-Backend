#!/usr/bin/env node
/**
 * Configure the WhatsApp Business number from the command line.
 *
 * Reads META_ACCESS_TOKEN + META_PHONE_NUMBER_ID from .env and:
 *   1. prints the number's current display-name status
 *   2. updates the business profile (about, description, website, vertical)
 *   3. requests the display name "Wheelers" (Meta reviews it)
 *   4. uploads a profile photo when a path is passed:  node scripts/whatsapp-profile.mjs ./logo.png
 *
 * NOT scriptable: business verification and Official Business Account
 * approval — those live in Business Manager → Security Centre.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(resolve(root, '.env'), 'utf8')
    .split('\n')
    .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
    .map((line) => {
      const idx = line.indexOf('=');
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
    }),
);

const TOKEN = env.META_ACCESS_TOKEN;
const PHONE_ID = env.META_PHONE_NUMBER_ID;
if (!TOKEN || !PHONE_ID) {
  console.error('META_ACCESS_TOKEN / META_PHONE_NUMBER_ID missing from .env');
  process.exit(1);
}

const BASE = 'https://graph.facebook.com/v21.0';
const auth = { authorization: `Bearer ${TOKEN}` };

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...auth, ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

// ── 1. Current status ──────────────────────────────────────────────
const status = await api(`/${PHONE_ID}?fields=verified_name,name_status,display_phone_number,code_verification_status,quality_rating`);
console.log('── Number status ──');
console.log(JSON.stringify(status.body, null, 2));

// ── 2. Business profile ────────────────────────────────────────────
const profile = await api(`/${PHONE_ID}/whatsapp_business_profile`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    messaging_product: 'whatsapp',
    about: 'Your ride, your price.',
    description:
      'Wheelers — ride-hailing on WhatsApp. Book solo or group rides, set your own fare, and pay your way. Type "hi" to start.',
    website: ['https://wheelersng.com'],
    vertical: 'TRAVEL',
  }),
});
console.log('\n── Business profile update ──');
console.log(profile.ok ? 'profile updated' : `${JSON.stringify(profile.body)}`);

// ── 3. Display name request ────────────────────────────────────────
const name = await api(`/${PHONE_ID}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ new_display_name: 'Wheelers' }),
});
console.log('\n── Display name request ("Wheelers") ──');
console.log(name.ok ? 'submitted — Meta will review (check name_status)' : `${JSON.stringify(name.body)}`);

// ── 4. Profile photo (optional arg) ────────────────────────────────
const photoPath = process.argv[2];
if (photoPath) {
  // The uploads API needs the app id — the token knows its own app.
  const app = await api('/app?fields=id');
  const appId = app.body?.id;
  if (!appId) {
    console.log('\n could not resolve app id for photo upload:', JSON.stringify(app.body));
  } else {
    const bytes = readFileSync(resolve(photoPath));
    const sessionRes = await api(
      `/${appId}/uploads?file_length=${bytes.length}&file_type=image/png&access_token=${encodeURIComponent(TOKEN)}`,
      { method: 'POST' },
    );
    const sessionId = sessionRes.body?.id;
    if (!sessionId) {
      console.log('\n upload session failed:', JSON.stringify(sessionRes.body));
    } else {
      const uploadRes = await fetch(`${BASE}/${sessionId}`, {
        method: 'POST',
        headers: { authorization: `OAuth ${TOKEN}`, file_offset: '0' },
        body: bytes,
      });
      const uploaded = await uploadRes.json().catch(() => ({}));
      const handle = uploaded?.h;
      if (!handle) {
        console.log('\n photo upload failed:', JSON.stringify(uploaded));
      } else {
        const setPhoto = await api(`/${PHONE_ID}/whatsapp_business_profile`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', profile_picture_handle: handle }),
        });
        console.log('\n── Profile photo ──');
        console.log(setPhoto.ok ? 'photo set' : `${JSON.stringify(setPhoto.body)}`);
      }
    }
  }
}
