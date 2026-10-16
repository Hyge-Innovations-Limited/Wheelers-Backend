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
//   npm run pricing floor on                 never under the other app + the premium (off: our own rate only)
//   npm run pricing traffic on               slow roads cost more (Google's live time against an empty road)
//   npm run pricing demand on                a busy area costs more (requests against drivers there)
//
// Outer areas, where drivers are few and come back empty:
//   npm run pricing areas                    each area's factors, and how its trips went in the last 30 days
//   npm run pricing area ikorodu 1.4 1.25    pickup factor, then drop-off factor (1 = no change, at most 2)
//   npm run pricing area-fit [save]          what the prices collected in each area say its factor should be
//   npm run pricing try 25 55 ikorodu        price a trip picked up in that area
//
// The other app's figures, from prices read off it by hand:
//   npm run pricing sample 15.5 23 5800       a trip of 15.5 km and 23 minutes cost ₦5,800 just now
//   npm run pricing sample 16 33 7200 rush    ...taken in rush hours (or "quiet"), when adding it later
//   npm run pricing sample 25 55 16000 ikorodu   ...a trip picked up in an outer area (any order after the price)
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
  console.log(`Minimum offer: ${settings.minOfferGapNgn > 0 ? `the suggested price less ${naira(settings.minOfferGapNgn)}` : 'a tenth off (older rule)'}`);
  console.log(`  other app, quiet hours: ${f(settings.quiet)}`);
  console.log(`  other app, rush hours:  ${f(settings.rush)}`);
  console.log(`Traffic: ${on(settings.trafficOn)}   Busy area: ${on(settings.demandOn)}`);
  console.log(`Outer areas (pickup / drop-off): ${config.PRICING_AREAS.map((a) => `${a.name} ×${settings.areas[a.key].pickup}/×${settings.areas[a.key].dropoff}`).join(', ')}`);
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
  const area = rest[2] ? areaNamed(rest[2]) : null;
  const { settings } = await pricingClient.loadSettings();
  const origin = area ? { lat: area.center[0], lng: area.center[1] } : undefined;
  const at = (modelOn) => {
    config.setPricingSettings({ ...settings, modelOn });
    return config.calculateSuggestedFare(km, { durationSeconds: minutes * 60, trafficRatio: 1, origin });
  };
  const off = at(false); const on = at(true);
  console.log(`${km} km in ${minutes} minutes${area ? `, picked up in ${area.name} (×${off.areaFactor})` : ''}, priced now (clear road assumed):`);
  console.table([
    { model: 'off', otherApp: naira(off.marketFareNgn), shown: naira(off.suggestedFareNgn), lowestOffer: naira(off.minOfferNgn), highestBid: naira(off.maxOfferNgn), ratePerKm: naira(off.ratePerKmNgn), setBy: off.setBy },
    { model: 'on', otherApp: naira(on.marketFareNgn), shown: naira(on.suggestedFareNgn), lowestOffer: naira(on.minOfferNgn), highestBid: naira(on.maxOfferNgn), ratePerKm: naira(on.ratePerKmNgn), setBy: on.setBy },
  ]);
  console.log(`The model would ${on.suggestedFareNgn < off.suggestedFareNgn ? `take ${naira(off.suggestedFareNgn - on.suggestedFareNgn)} off` : on.suggestedFareNgn > off.suggestedFareNgn ? `add ${naira(on.suggestedFareNgn - off.suggestedFareNgn)}` : 'leave it as it is'}. (It is ${settings.modelOn ? 'ON' : 'off'} right now.)`);
}

async function sample() {
  const [km, minutes, price, ...words] = rest;
  const hours = words.find((w) => w === 'rush' || w === 'quiet');
  const areaWord = words.find((w) => w !== 'rush' && w !== 'quiet');
  const area = areaWord ? areaNamed(areaWord) : null;
  const now = new Date();
  const row = await prisma.marketSample.create({ data: {
    km: number(km, 'km'), minutes: number(minutes, 'minutes'), priceNgn: number(price, 'the price'),
    rush: hours ? hours === 'rush' : config.isRushHour(now), takenAt: now, addedBy: 'server', area: area?.key ?? null,
  } });
  const { settings } = await pricingClient.loadSettings();
  const f = row.rush ? settings.rush : settings.quiet;
  const factor = area ? settings.areas[area.key].pickup : 1;
  const ours = (f.baseNgn + f.perKmNgn * row.km + f.perMinuteNgn * row.minutes) * factor;
  console.log(`Saved: ${row.km} km in ${row.minutes} minutes cost ${naira(row.priceNgn)} (${row.rush ? 'rush' : 'quiet'} hours${area ? `, from ${area.name}` : ''}).`);
  console.log(`Our figures would have said ${naira(ours)}: ${naira(Math.abs(ours - Number(row.priceNgn)))} ${ours > Number(row.priceNgn) ? 'too high' : 'too low'}. Run "npm run pricing ${area ? 'area-fit' : 'fit'}" to see what the prices collected so far give.`);
}

async function samples() {
  const rows = await prisma.marketSample.findMany({ orderBy: { takenAt: 'desc' }, take: 60 });
  if (rows.length === 0) { console.log('No prices collected yet. Add one: npm run pricing sample 15.5 23 5800'); return; }
  console.table(rows.map((r) => ({
    taken: r.takenAt.toLocaleString('en-NG', { timeZone: 'Africa/Lagos', hour12: false, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
    hours: r.rush ? 'rush' : 'quiet', area: r.area ?? '', km: r.km, min: r.minutes, price: naira(r.priceNgn), perKm: naira(Number(r.priceNgn) / r.km),
  })));
}

async function fit() {
  // Prices go stale: only the last 60 days count.
  // City-wide figures only: a price from an outer area carries that area's factor, and is fitted by area-fit.
  const rows = await prisma.marketSample.findMany({ where: { takenAt: { gte: new Date(Date.now() - 60 * 86400_000) }, area: null } });
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

function areaNamed(word) {
  const area = config.PRICING_AREAS.find((a) => a.key === word.toLowerCase() || a.name.toLowerCase() === word.toLowerCase());
  if (!area) throw new Error(`No area called "${word}". The areas are: ${config.PRICING_AREAS.map((a) => a.key).join(', ')}`);
  return area;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Each area's factors, and how its trips went: did drivers bid, and how far above our price did they ask? */
async function areas() {
  const { settings } = await pricingClient.loadSettings();
  const since = new Date(Date.now() - 30 * 86400_000);
  const rides = await prisma.ride.findMany({
    where: { createdAt: { gte: since } },
    select: { pickupLat: true, pickupLng: true, destLat: true, destLng: true, fareEstimateNgn: true, riderOfferNgn: true, bids: { select: { amountNgn: true } } },
  });
  const rows = [...config.PRICING_AREAS.map((a) => ({ key: a.key, name: a.name })), { key: null, name: 'Rest of Lagos' }].map(({ key, name }) => {
    const mine = rides.filter((r) => (config.pricingAreaOf(r.pickupLat, r.pickupLng)?.key ?? null) === key);
    const withBids = mine.filter((r) => r.bids.length > 0);
    // How far drivers asked above what was offered: the median of each trip's lowest bid against the rider's offer.
    const asked = withBids.map((r) => {
      const offer = Number(r.riderOfferNgn ?? r.fareEstimateNgn ?? 0);
      return offer > 0 ? Math.min(...r.bids.map((b) => Number(b.amountNgn))) / offer : null;
    }).filter((x) => x !== null);
    const f = key ? settings.areas[key] : null;
    return {
      area: name,
      pickup: f ? `×${f.pickup}` : '—',
      dropoff: f ? `×${f.dropoff}` : '—',
      trips: mine.length,
      noBids: mine.length ? `${Math.round(((mine.length - withBids.length) / mine.length) * 100)}%` : '—',
      driversAsk: asked.length ? `${Math.round((median(asked) - 1) * 100)}% above` : '—',
    };
  });
  console.log('Last 30 days, by where the trip was picked up:');
  console.table(rows);
  console.log('Many trips with no bids, or drivers asking well above the offer, mean the price there is too low: raise it with "npm run pricing area KEY PICKUP DROPOFF".');
}

async function setArea() {
  const area = areaNamed(rest[0] ?? '');
  const { settings } = await pricingClient.loadSettings();
  const pickup = number(rest[1], 'the pickup factor');
  const dropoff = rest[2] !== undefined ? number(rest[2], 'the drop-off factor') : settings.areas[area.key].dropoff;
  await save(() => ({ areas: { ...settings.areas, [area.key]: { pickup, dropoff } } }), (s) => `${area.name}: pickup ×${s.areas[area.key].pickup}, drop-off ×${s.areas[area.key].dropoff}.`);
}

/** What the other app's prices from each area say its pickup factor should be: their price against our city-wide figures. */
async function areaFit() {
  const { settings } = await pricingClient.loadSettings();
  const rows = await prisma.marketSample.findMany({ where: { takenAt: { gte: new Date(Date.now() - 60 * 86400_000) }, area: { not: null } } });
  const change = { ...settings.areas };
  let any = false;
  for (const area of config.PRICING_AREAS) {
    const mine = rows.filter((r) => r.area === area.key);
    if (mine.length === 0) { console.log(`${area.name}: no prices collected (now ×${settings.areas[area.key].pickup})`); continue; }
    const ratios = mine.map((r) => {
      const f = r.rush ? settings.rush : settings.quiet;
      return Number(r.priceNgn) / (f.baseNgn + f.perKmNgn * r.km + f.perMinuteNgn * r.minutes);
    });
    const said = Math.round(Math.min(config.AREA_FACTOR_MAX, Math.max(1, median(ratios))) * 100) / 100;
    console.log(`${area.name}: ${mine.length} price${mine.length === 1 ? '' : 's'} say ×${said} (now ×${settings.areas[area.key].pickup})${mine.length < 5 ? ' — few prices, take it as a hint' : ''}`);
    change[area.key] = { ...change[area.key], pickup: said };
    any = true;
  }
  if (rest[0] !== 'save') { console.log('\nNothing saved. "npm run pricing area-fit save" to use these pickup factors.'); return; }
  if (!any) { console.log('Nothing to save.'); return; }
  await pricingClient.saveSettings({ ...settings, areas: change }, 'server');
  console.log('Saved. New prices follow within a minute.');
}

const onOff = (key, label) => () => {
  const word = rest[0];
  if (word !== 'on' && word !== 'off') throw new Error(`Say on or off: npm run pricing ${label} on`);
  return save(() => ({ [key]: word === 'on' }), (s) => `${label[0].toUpperCase()}${label.slice(1)} is now ${s[key] ? 'ON' : 'off'}.`);
};

const commands = {
  floor: onOff('marketFloorOn', 'floor'),
  traffic: onOff('trafficOn', 'traffic'),
  demand: onOff('demandOn', 'demand'),
  areas,
  area: setArea,
  'area-fit': areaFit,
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
  gap: () => save(() => ({ minOfferGapNgn: number(rest[0], 'the gap') }), (s) => s.minOfferGapNgn > 0 ? `A rider's minimum offer is now the suggested price less ${naira(s.minOfferGapNgn)}.` : 'The minimum offer is back to the older rule: a tenth off, and no more than the premium.'),
  premium: () => save(() => ({ premiumNgn: number(rest[0], 'the premium') }), (s) => `The floor is now the other app + ${naira(s.premiumNgn)}.`),
  indrive,
  try: tryTrip,
};

const run = commands[command];
if (!run) {
  console.log('Use: npm run pricing [status | floor|traffic|demand on|off | areas | area KEY PICKUP [DROPOFF] | area-fit [save] | model-on | model-off | quotes | try KM MINUTES [AREA] | discount N | closest N | premium N | trials SHARE | sample KM MINUTES PRICE [rush|quiet] [AREA] | samples | fit [save] | indrive quiet|rush BASE KM MINUTE]');
} else {
  await run().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
await prisma.$disconnect();
