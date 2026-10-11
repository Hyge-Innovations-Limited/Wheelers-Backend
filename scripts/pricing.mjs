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
//   npm run pricing trials 0.1               the share of trips shown a trial price (0 to switch off)
//
// The other app's figures, from prices read off it by hand:
//   npm run pricing sample 15.5 23 5800       a trip of 15.5 km and 23 minutes cost ₦5,800 just now
//   npm run pricing sample 16 33 7200 rush    ...taken in rush hours (or "quiet"), when adding it later
//   npm run pricing samples                   every price collected
//   npm run pricing fit                       what figures they give, and how far off today's are (saves nothing)
//   npm run pricing fit save                  use them
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { prisma, pricingClient } = require('@wheleers/db');
const config = require('../packages/config/dist/index.js');
const { fitMarket } = await import('./fit-market.mjs');

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
  if (ml?.realRows) console.log(`  corrected on ${ml.realRows.toLocaleString('en-NG')} real Wheelers quotes`);
  console.log(`  may take off at most ${naira(settings.maxDiscountNgn)} (and a tenth of the fare), and stays ${naira(settings.modelPremiumNgn)} above the other app`);
  console.log(`  ${settings.trialShare > 0 ? `${Math.round(settings.trialShare * 100)} trips in 100 are shown a trial price (never above today's), so it has something to learn from` : 'no trial prices'}`);
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

async function sample() {
  const [km, minutes, price, hours] = rest;
  if (hours && hours !== 'rush' && hours !== 'quiet') throw new Error('The hours are "rush" or "quiet" (or leave them out for now): npm run pricing sample 16 33 7200 rush');
  const now = new Date();
  const row = await prisma.marketSample.create({ data: {
    km: number(km, 'km'), minutes: number(minutes, 'minutes'), priceNgn: number(price, 'the price'),
    rush: hours ? hours === 'rush' : config.isRushHour(now), takenAt: now, addedBy: 'server',
  } });
  const { settings } = await pricingClient.loadSettings();
  const f = row.rush ? settings.rush : settings.quiet;
  const ours = f.baseNgn + f.perKmNgn * row.km + f.perMinuteNgn * row.minutes;
  console.log(`Saved: ${row.km} km in ${row.minutes} minutes cost ${naira(row.priceNgn)} (${row.rush ? 'rush' : 'quiet'} hours).`);
  console.log(`Our figures would have said ${naira(ours)}: ${naira(Math.abs(ours - Number(row.priceNgn)))} ${ours > Number(row.priceNgn) ? 'too high' : 'too low'}. Run "npm run pricing fit" to see what the prices collected so far give.`);
}

async function samples() {
  const rows = await prisma.marketSample.findMany({ orderBy: { takenAt: 'desc' }, take: 60 });
  if (rows.length === 0) { console.log('No prices collected yet. Add one: npm run pricing sample 15.5 23 5800'); return; }
  console.table(rows.map((r) => ({
    taken: r.takenAt.toLocaleString('en-NG', { timeZone: 'Africa/Lagos', hour12: false, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
    hours: r.rush ? 'rush' : 'quiet', km: r.km, min: r.minutes, price: naira(r.priceNgn), perKm: naira(Number(r.priceNgn) / r.km),
  })));
}

async function fit() {
  // Prices go stale: only the last 60 days count.
  const rows = await prisma.marketSample.findMany({ where: { takenAt: { gte: new Date(Date.now() - 60 * 86400_000) } } });
  const { settings } = await pricingClient.loadSettings();
  const change = {};
  for (const hours of ['quiet', 'rush']) {
    const mine = rows.filter((r) => r.rush === (hours === 'rush')).map((r) => ({ km: r.km, minutes: r.minutes, priceNgn: Number(r.priceNgn) }));
    const result = fitMarket(mine, settings[hours]);
    const f = result.figures;
    console.log(`${hours} hours: ${mine.length} price${mine.length === 1 ? '' : 's'} in the last 60 days`);
    if (result.fitted === 'nothing') { console.log(`  nothing to fit from: figures stay base ${naira(f.baseNgn)}, ${naira(f.perKmNgn)} a km, ${naira(f.perMinuteNgn)} a minute\n`); continue; }
    console.log(`  fitted ${result.fitted}: base ${naira(f.baseNgn)}, ${naira(f.perKmNgn)} a km, ${naira(f.perMinuteNgn)} a minute`);
    console.log(`  typically off by ${naira(result.missBefore)} now, ${naira(result.missAfter)} with these\n`);
    change[hours] = f;
  }
  if (rest[0] !== 'save') { console.log('Nothing saved. "npm run pricing fit save" to use these figures.'); return; }
  if (Object.keys(change).length === 0) { console.log('Nothing to save.'); return; }
  await pricingClient.saveSettings({ ...settings, ...change }, 'server');
  console.log('Saved. New prices follow within a minute.');
}

const commands = {
  sample,
  samples,
  fit,
  trials: () => save(() => ({ trialShare: number(rest[0], 'the share') }), (s) => (s.trialShare > 0 ? `${Math.round(s.trialShare * 100)} trips in 100 are now shown a trial price.` : 'No more trial prices.')),
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
  console.log('Use: npm run pricing [status | model-on | model-off | quotes | try KM MINUTES | discount N | closest N | premium N | trials SHARE | sample KM MINUTES PRICE [rush|quiet] | samples | fit [save] | indrive quiet|rush BASE KM MINUTE]');
} else {
  await run().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
await prisma.$disconnect();
