#!/usr/bin/env node
// Pricing from the server, in a word or two. No restart: every service
// reloads the settings within a minute.
//
//   npm run pricing                          what is switched on, and the last prices shown
//   npm run pricing model-on                 let the model set prices (a little under today's, within its limits)
//   npm run pricing model-off                back to floor + rules (the model still records its number)
//   npm run pricing quotes                   the last 15 prices shown, with what set each
//   npm run pricing discount 700             the most the model may take off a trip, in naira
//   npm run pricing closest 150              the least a model price may sit above the other app
//   npm run pricing premium 300              how far above the other app the floor sits
//   npm run pricing indrive quiet 500 268 50 the other app's figures: base, per km, per minute
//   npm run pricing indrive rush 575 308 58
//   npm run pricing try 15.5 23              price a trip (km, minutes) now, with the model off and on
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { prisma, pricingClient } = require('@wheleers/db');
const config = require('../packages/config/dist/index.js');

const [command = 'status', ...rest] = process.argv.slice(2);
const naira = (v) => (v == null ? '—' : `₦${Math.round(Number(v)).toLocaleString('en-NG')}`);
const number = (text, label) => {
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a number, e.g. 300`);
  return n;
};

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
  const ml = config.getPricingMlModel();
  const on = (v) => (v ? 'ON' : 'off');
  const f = (x) => `base ${naira(x.baseNgn)}, ${naira(x.perKmNgn)} a km, ${naira(x.perMinuteNgn)} a minute`;
  console.log(`Floor (other app + ${naira(settings.premiumNgn)}): ${on(settings.marketFloorOn)}`);
  console.log(`  other app, quiet hours: ${f(settings.quiet)}`);
  console.log(`  other app, rush hours:  ${f(settings.rush)}`);
  console.log(`Traffic: ${on(settings.trafficOn)}   Busy area: ${on(settings.demandOn)}`);
  console.log(`Model: ${on(settings.modelOn)}`);
  console.log(ml
    ? `  trained on ${ml.rows.toLocaleString('en-NG')} ${ml.source} quotes, ${ml.trainedAt.slice(0, 10)}`
    : '  this build has no trained model (packages/config/models/pricing-ml.json)');
  console.log(`  may take off at most ${naira(settings.maxDiscountNgn)} (and a tenth of the fare), and stays ${naira(settings.modelPremiumNgn)} above the other app`);
  console.log(`Last saved: ${updatedAt ? updatedAt.toLocaleString('en-NG', { timeZone: 'Africa/Lagos', hour12: false }) : 'never'}${updatedBy ? ` by ${updatedBy}` : ''}\n`);
  await quotes(5);
}

async function save(change, said) {
  const { settings } = await pricingClient.loadSettings();
  const next = await pricingClient.saveSettings({ ...settings, ...change(settings) }, 'server');
  console.log(`${said(next)} New prices follow within a minute.`);
}

async function model(turnOn) {
  if (turnOn && !config.getPricingMlModel()) {
    console.log('This build has no trained model. Pull the latest code and build, then try again.');
    return;
  }
  const { settings } = await pricingClient.loadSettings();
  if (turnOn && !settings.marketFloorOn) console.log('Note: the floor is off, and the model only prices with the floor on.');
  await save(() => ({ modelOn: turnOn }), (s) => `Model is now ${s.modelOn ? 'ON' : 'off'}.`);
}

async function indrive() {
  const [which, base, perKm, perMinute] = rest;
  if (which !== 'quiet' && which !== 'rush') throw new Error('Say which hours: npm run pricing indrive quiet 500 268 50');
  const figures = { baseNgn: number(base, 'base'), perKmNgn: number(perKm, 'per km'), perMinuteNgn: number(perMinute, 'per minute') };
  await save(() => ({ [which]: figures }), () => `The other app, ${which} hours: base ${naira(figures.baseNgn)}, ${naira(figures.perKmNgn)} a km, ${naira(figures.perMinuteNgn)} a minute.`);
}

async function tryTrip() {
  const km = number(rest[0], 'km');
  const minutes = number(rest[1], 'minutes');
  const { settings } = await pricingClient.loadSettings();
  const at = (modelOn) => {
    config.setPricingSettings({ ...settings, modelOn });
    return config.calculateSuggestedFare(km, { durationSeconds: minutes * 60, trafficRatio: 1 });
  };
  const off = at(false); const on = at(true);
  console.log(`${km} km in ${minutes} minutes, priced now (clear road assumed):`);
  console.table([
    { model: 'off', otherApp: naira(off.marketFareNgn), shown: naira(off.suggestedFareNgn), lowestOffer: naira(off.minOfferNgn), highestBid: naira(off.maxOfferNgn), ratePerKm: naira(off.ratePerKmNgn), setBy: off.setBy },
    { model: 'on', otherApp: naira(on.marketFareNgn), shown: naira(on.suggestedFareNgn), lowestOffer: naira(on.minOfferNgn), highestBid: naira(on.maxOfferNgn), ratePerKm: naira(on.ratePerKmNgn), setBy: on.setBy },
  ]);
  console.log(`The model would ${on.suggestedFareNgn < off.suggestedFareNgn ? `take ${naira(off.suggestedFareNgn - on.suggestedFareNgn)} off` : on.suggestedFareNgn > off.suggestedFareNgn ? `add ${naira(on.suggestedFareNgn - off.suggestedFareNgn)}` : 'leave it as it is'}. (It is ${settings.modelOn ? 'ON' : 'off'} right now.)`);
}

const commands = {
  status,
  quotes: () => quotes(15),
  'model-on': () => model(true),
  'model-off': () => model(false),
  discount: () => save(() => ({ maxDiscountNgn: number(rest[0], 'the discount') }), (s) => `The model may now take off at most ${naira(s.maxDiscountNgn)}.`),
  closest: () => save(() => ({ modelPremiumNgn: number(rest[0], 'the amount') }), (s) => `A model price now stays at least ${naira(s.modelPremiumNgn)} above the other app.`),
  premium: () => save(() => ({ premiumNgn: number(rest[0], 'the premium') }), (s) => `The floor is now the other app + ${naira(s.premiumNgn)}.`),
  indrive,
  try: tryTrip,
};

const run = commands[command];
if (!run) {
  console.log('Use: npm run pricing [status | model-on | model-off | quotes | discount N | closest N | premium N | indrive quiet|rush BASE KM MINUTE | try KM MINUTES]');
} else {
  await run().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
await prisma.$disconnect();
