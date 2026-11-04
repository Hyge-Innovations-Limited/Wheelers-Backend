#!/usr/bin/env node
/**
 * Experiment (branch flow-booking-experiment): does a WhatsApp Flow's Dropdown
 * let the rider type and see the list shrink, like an app's search? One screen,
 * one Dropdown of up to 200 real places (the most used pickups and
 * destinations in our trips, read-only), Flow JSON 7.3. The form is created as
 * a DRAFT (never published) and sent in draft mode to one person only.
 *
 *   node scripts/run-with-env.cjs node scripts/flow-search-test.mjs send olowutimilehin20@gmail.com
 *   node scripts/run-with-env.cjs node scripts/flow-search-test.mjs delete <flow id it printed>
 *
 * `send` takes the email of a Wheelers user with a phone on file (who messaged
 * the bot in the last 24 hours, or WhatsApp refuses the message). Finishing the
 * form sends nothing back: the bot ignores a finished form.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');

const TOKEN = process.env.META_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const WABA_ID = process.env.META_WABA_ID || '2408321253328724';
const BASE = 'https://graph.facebook.com/v21.0';
const MAX_PLACES = 200;
const SCREEN = 'SEARCH_TEST';

const [command, arg] = process.argv.slice(2);
if (!TOKEN) { console.error('META_ACCESS_TOKEN missing — run through scripts/run-with-env.cjs'); process.exit(1); }

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
}

/** "Ikeja City Mall, Obafemi Awolowo Way, Ikeja, Lagos, Nigeria" → title "Ikeja City Mall", the rest as the description. */
function placeItem(address, index) {
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  const title = (parts[0] || address).slice(0, 30);
  const rest = parts.slice(1).filter((p) => !/^(lagos|nigeria|lagos state)$/i.test(p)).join(', ');
  return { id: `p${index}`, title, ...(rest ? { description: rest.slice(0, 300) } : {}) };
}

/** The most used places in our own trips, pickups and destinations together, busiest first. */
async function realPlaces(prisma) {
  const [drops, picks] = await Promise.all([
    prisma.ride.groupBy({ by: ['destAddress'], _count: { _all: true } }),
    prisma.ride.groupBy({ by: ['pickupAddress'], _count: { _all: true } }),
  ]);
  const uses = new Map();
  const add = (address, n) => {
    const clean = (address || '').trim();
    if (!clean || /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(clean)) return; // a bare pin is not a place name
    const key = clean.toLowerCase();
    const known = uses.get(key);
    uses.set(key, { address: known?.address ?? clean, n: (known?.n ?? 0) + n });
  };
  for (const row of drops) add(row.destAddress, row._count._all);
  for (const row of picks) add(row.pickupAddress, row._count._all);
  return [...uses.values()].sort((a, b) => b.n - a.n).slice(0, MAX_PLACES).map((p) => p.address);
}

function flowJson(places) {
  return JSON.stringify({
    version: '7.3',
    screens: [{
      id: SCREEN,
      title: 'Where to?',
      terminal: true,
      data: {},
      layout: {
        type: 'SingleColumnLayout',
        children: [{
          type: 'Form',
          name: 'form',
          children: [
            { type: 'Dropdown', name: 'place', label: 'Destination', required: true, 'data-source': places.map(placeItem) },
            { type: 'Footer', label: 'Done', 'on-click-action': { name: 'complete', payload: { flow: 'search_test', rearm: 'false', place: '${form.place}' } } },
          ],
        }],
      },
    }],
  });
}

async function send(email) {
  if (!PHONE_NUMBER_ID) { console.error('META_PHONE_NUMBER_ID missing'); process.exit(1); }
  if (!email) { console.error('usage: send <email of a Wheelers user>'); process.exit(1); }
  const prisma = new PrismaClient();
  try {
    const person = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { phone: true } });
    if (!person?.phone) { console.error(`no user with a phone for ${email}`); process.exit(1); }
    const places = await realPlaces(prisma);
    if (places.length === 0) { console.error('no trips with place names in this database'); process.exit(1); }
    console.log(`${places.length} real places, busiest first: ${places.slice(0, 5).join(' | ')} …`);

    const created = await api(`/${WABA_ID}/flows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `Search test ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, categories: ['OTHER'] }),
    });
    if (!created.ok) { console.error('flow creation failed:', JSON.stringify(created.body)); process.exit(1); }
    const flowId = created.body.id;

    const form = new FormData();
    form.append('name', 'flow.json');
    form.append('asset_type', 'FLOW_JSON');
    form.append('file', new Blob([flowJson(places)], { type: 'application/json' }), 'flow.json');
    const uploaded = await api(`/${flowId}/assets`, { method: 'POST', body: form });
    const errors = uploaded.body?.validation_errors ?? [];
    if (!uploaded.ok || errors.length) {
      for (const e of errors) console.error(`  validation ${e.error_type ?? ''}: ${e.message}`);
      console.error('upload refused:', uploaded.ok ? '' : JSON.stringify(uploaded.body));
      await api(`/${flowId}`, { method: 'DELETE' });
      process.exit(1);
    }

    const sent = await api(`/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: person.phone.replace(/^\+/, ''),
        type: 'interactive',
        interactive: {
          type: 'flow',
          body: { text: 'Search test: open it, tap Destination, and type.' },
          action: {
            name: 'flow',
            parameters: {
              flow_message_version: '3', mode: 'draft', flow_id: flowId, flow_cta: 'Open test',
              flow_token: 'search_test', flow_action: 'navigate', flow_action_payload: { screen: SCREEN },
            },
          },
        },
      }),
    });
    if (!sent.ok) {
      console.error('send failed:', JSON.stringify(sent.body), '\n(has this number messaged the bot in the last 24 hours?)');
      console.error(`the draft form stays: delete it with  node scripts/run-with-env.cjs node scripts/flow-search-test.mjs delete ${flowId}`);
      process.exit(1);
    }
    console.log(`sent. Draft form ${flowId}. When done:  node scripts/run-with-env.cjs node scripts/flow-search-test.mjs delete ${flowId}`);
  } finally {
    await prisma.$disconnect();
  }
}

async function remove(flowId) {
  if (!flowId) { console.error('usage: delete <flow id>'); process.exit(1); }
  const res = await api(`/${flowId}`, { method: 'DELETE' });
  console.log(res.ok ? `draft form ${flowId} deleted` : `delete failed: ${JSON.stringify(res.body)}`);
}

if (command === 'send') await send(arg);
else if (command === 'delete') await remove(arg);
else { console.error('usage: send <email> | delete <flow id>'); process.exit(1); }
