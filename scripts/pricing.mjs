#!/usr/bin/env node
// Pricing from the server, in one word. No restart: every service reloads the
// settings within a minute.
//
//   npm run pricing              what is switched on, and the last prices shown
//   npm run pricing model-on     let the model lift fares
//   npm run pricing model-off    back to floor + rules (the model still records its number)
//   npm run pricing quotes       the last 10 prices shown, with what set each
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { prisma, pricingClient } = require('@wheleers/db');

const command = process.argv[2] ?? 'status';
const naira = (v) => (v == null ? '—' : `₦${Math.round(Number(v)).toLocaleString('en-NG')}`);

async function quotes(take) {
  const rows = await prisma.pricingQuote.findMany({ orderBy: { createdAt: 'desc' }, take });
  if (rows.length === 0) { console.log('No prices have been shown yet.'); return; }
  console.table(rows.map((q) => ({
    when: q.createdAt.toLocaleString('en-NG', { timeZone: 'Africa/Lagos', hour12: false, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
    km: Number(q.distanceKm.toFixed(1)),
    min: Math.round(q.durationSeconds / 60),
    otherApp: naira(q.marketFareNgn),
    rules: naira(q.rulesFareNgn),
    model: naira(q.modelFareNgn),
    shown: naira(q.suggestedFareNgn),
    setBy: q.setBy,
  })));
}

async function status() {
  const { settings, updatedAt, updatedBy } = await pricingClient.loadSettings();
  const on = (v) => (v ? 'ON' : 'off');
  console.log(`Floor (other app + ₦${settings.premiumNgn}): ${on(settings.marketFloorOn)}`);
  console.log(`Traffic: ${on(settings.trafficOn)}   Busy area: ${on(settings.demandOn)}`);
  console.log(`Model: ${on(settings.modelOn)}${settings.model ? ` (trained on ${settings.model.rows} real trips${settings.model.seeded ? ', seeded' : ''})` : ' (none saved)'}`);
  console.log(`Last saved: ${updatedAt ? updatedAt.toLocaleString('en-NG', { timeZone: 'Africa/Lagos', hour12: false }) : 'never'}${updatedBy ? ` by ${updatedBy}` : ''}\n`);
  await quotes(5);
}

async function model(turnOn) {
  const { settings } = await pricingClient.loadSettings();
  if (turnOn && !settings.model) {
    console.log('There is no model saved. Run: node scripts/run-with-env.cjs node scripts/train-pricing-model.mjs --seed --save');
    return;
  }
  const saved = await pricingClient.saveSettings({ ...settings, modelOn: turnOn }, 'server');
  console.log(`Model is now ${saved.modelOn ? 'ON' : 'off'}. New prices follow within a minute.`);
}

const run = { status, quotes: () => quotes(10), 'model-on': () => model(true), 'model-off': () => model(false) }[command];
if (!run) {
  console.log('Use: npm run pricing [status | model-on | model-off | quotes]');
} else {
  await run().catch((error) => { console.error(error); process.exitCode = 1; });
}
await prisma.$disconnect();
