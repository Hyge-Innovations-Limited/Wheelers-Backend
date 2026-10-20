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
//   npm run pricing period evening 4000      a premium of its own for a part of the day (morning 05–12,
//   npm run pricing period night 1500-3000   ...or a range: traffic, a busy area, an outer area and the
//                                            weekend place each trip in it (the same trip, the same
//                                            amount for half an hour)
//   npm run pricing report [DAYS]            prices shown, matched to the rides they became (default 7 days)
//                                            afternoon 12–16, evening 16–21, night 21–05, Lagos time)
//   npm run pricing period evening off       that part back to the general premium
//   npm run pricing indrive quiet 500 268 50 the other app's figures: base, per km, per minute
//   npm run pricing indrive rush 575 308 58
//   npm run pricing try 15.5 23              price a trip (km, minutes) now, with the model off and on
//
// The price by the clock, learned each night from what trips really cost:
//   npm run pricing curve                    each hour's multiplier, weekday and weekend, and what it learned from
//   npm run pricing curve fit                what the last four weeks of prices say now (saves nothing)
//   npm run pricing curve fit save           use it now instead of waiting for the night
//   npm run pricing curve on                 price by the curve (in place of rush/quiet); relearned at 03:00 each night
//   npm run pricing curve off                back to the rush and quiet figures
//
// The live surge, from our own riders, drivers and bids (only ever lifts a price):
//   npm run pricing surge                    the surge in each zone and the city now, and why
//   npm run pricing surge on|off
//   npm run pricing surge max 1.4            the most it may lift the other app's fare (at most 2)
//
//   npm run pricing extra 800                ₦800 on top of every price, after everything else (0: none);
//                                            part of the fare, so the driver keeps it
//   npm run pricing lift 1                   how far traffic and a busy area may lift a price past the floor
//                                            (1: never past it, so never more than the other app + the premium; at most 3)
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
//   npm run pricing sample 9.5 28 5200 ikeja      ...a trip from or to an area inside Lagos (maryland, ikeja,
//                                                 surulere, lekki, ajah): Yaba and the Island are the standard
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
  console.log(`  by time of day: ${config.DAY_PERIODS.map((p) => `${p} ${premiumText(settings, p)}`).join(', ')}  (now: ${config.dayPeriodOf()})`);
  console.log(`Flat extra on top of every price: ${settings.extraNgn > 0 ? naira(settings.extraNgn) : 'none'}`);
  console.log(`Minimum offer: ${settings.minOfferGapNgn > 0 ? `the suggested price less ${naira(settings.minOfferGapNgn)}` : 'a tenth off (older rule)'}`);
  console.log(`  other app, quiet hours: ${f(settings.quiet)}`);
  console.log(`  other app, rush hours:  ${f(settings.rush)}`);
  console.log(`Price by the clock (curve): ${on(settings.hourCurveOn)}${settings.hourCurve ? `  now ×${config.lagosClock(new Date()).weekend ? settings.hourCurve.weekend[config.lagosClock(new Date()).hour] : settings.hourCurve.weekday[config.lagosClock(new Date()).hour]}` : ''}${settings.hourCurveFittedAt ? `, learned ${lagosTime(new Date(settings.hourCurveFittedAt))}` : ''}`);
  console.log(`Live surge: ${on(settings.surgeOn)}, at most ×${settings.surgeMax}${settings.surgeOn ? `  (npm run pricing surge for now)` : ''}`);
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

const lagosTime = (d) => d.toLocaleString('en-NG', { timeZone: 'Africa/Lagos', hour12: false, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const hh = (h) => `${String(h).padStart(2, '0')}:00`;

/**
 * npm run pricing curve [fit [save] | on | off]: the price by the clock. Each
 * hour's multiplier on the other app's quiet-hour figures, weekday and weekend.
 */
async function curve() {
  const [word, also] = rest;
  const { settings } = await pricingClient.loadSettings();
  config.setPricingSettings(settings);
  if (word === 'on' || word === 'off') {
    // Switched on with nothing learned yet, it starts from what rush and quiet charge now: nothing moves at the switch.
    return save((s) => ({ hourCurveOn: word === 'on', ...(word === 'on' && !s.hourCurve ? { hourCurve: config.seedHourCurve(s) } : {}) }), (s) => (s.hourCurveOn
      ? 'Prices now follow the hour curve, learned again each night at 03:00.'
      : 'Prices are back on the rush and quiet figures. The curve is kept for when it is switched on again.'));
  }
  if (word === 'fit') {
    const fit = await pricingClient.learnHourCurve(settings);
    console.log(`Learned from the last 4 weeks: ${fit.used.sample} inDrive prices, ${fit.used.agreed} agreed fares, ${fit.used.bid} driver bids on rides nobody agreed.`);
    console.log('Each hour moves at most 15% in one go; run it again (or let the night do it) to go further.\n');
    console.table(Array.from({ length: 24 }, (_, h) => ({
      hour: hh(h),
      weekday: `×${fit.previous.weekday[h]} → ×${fit.curve.weekday[h]}`,
      'prices (wd)': fit.counts.weekday[h],
      weekend: `×${fit.previous.weekend[h]} → ×${fit.curve.weekend[h]}`,
      'prices (we)': fit.counts.weekend[h],
    })));
    if (also !== 'save') { console.log('Nothing saved. "npm run pricing curve fit save" to use it.'); return; }
    await save(() => ({ hourCurve: fit.curve, hourCurveFittedAt: new Date().toISOString() }), (s) => (s.hourCurveOn ? 'Saved.' : 'Saved. It prices once "npm run pricing curve on".'));
    return;
  }
  const c = settings.hourCurve ?? config.seedHourCurve(settings);
  console.log(`Price by the clock: ${settings.hourCurveOn ? 'ON' : 'off'}${settings.hourCurve ? '' : ' (nothing learned yet: this is what rush and quiet charge now)'}${settings.hourCurveFittedAt ? `, learned ${lagosTime(new Date(settings.hourCurveFittedAt))}` : ''}`);
  console.log('Each number multiplies the other app\'s quiet-hour figures (base, per km, per minute); the premium goes on top.');
  const quiet = config.quietMarketFareNgn(15, 40, settings);
  console.table(Array.from({ length: 24 }, (_, h) => ({
    hour: hh(h), weekday: `×${c.weekday[h]}`, '15 km, 40 min': naira(quiet * c.weekday[h]), weekend: `×${c.weekend[h]}`, ' 15 km, 40 min': naira(quiet * c.weekend[h]),
  })));
}

/** npm run pricing surge [on | off | max N]: the live surge, and what it reads. */
async function surge() {
  const [word, value] = rest;
  if (word === 'on' || word === 'off') {
    return save(() => ({ surgeOn: word === 'on' }), (s) => (s.surgeOn
      ? `The live surge is ON: our own riders, drivers and bids may lift the other app's fare up to ×${s.surgeMax}. It reads the market every 2 minutes.`
      : 'The live surge is off.'));
  }
  if (word === 'max') {
    return save(() => ({ surgeMax: number(value, 'the most') }), (s) => `The live surge may now lift the other app's fare up to ×${s.surgeMax}.`);
  }
  const { settings } = await pricingClient.loadSettings();
  console.log(`Live surge: ${settings.surgeOn ? 'ON' : 'off'}, at most ×${settings.surgeMax}`);
  const path = await import('node:path');
  const { RedisClient } = require(path.join(process.cwd(), 'apps/api-gateway/dist/redis/client.js'));
  const redis = new RedisClient(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
  try {
    await redis.connect();
    const raw = await redis.get('pricing:surge');
    if (!raw) { console.log('No reading yet: the gateway reads the market every 2 minutes once it is running.'); return; }
    const areas = JSON.parse(raw);
    console.log(`Read ${lagosTime(new Date(areas[0].at))}, over the last 30 minutes:`);
    console.table(areas.map((a) => ({
      area: a.area,
      surge: `×${a.factor}`,
      heading: a.target === a.factor ? '—' : `×${a.target}`,
      rides: a.rides,
      drivers: a.drivers,
      driversAsk: a.counter === null ? '—' : `${a.counter >= 1 ? '+' : ''}${Math.round((a.counter - 1) * 100)}%`,
      noBid: a.noBidShare === null ? '—' : `${Math.round(a.noBidShare * 100)}%`,
      reads: a.fromCity ? 'the city (few rides here)' : 'its own rides',
    })));
    if (!settings.surgeOn) console.log('Off: these are what it would do. "npm run pricing surge on" to use them.');
  } finally {
    await redis.disconnect().catch(() => undefined);
  }
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
  // The same trip through a weekday, with the model as it is now: what each part of the day charges.
  config.setPricingSettings(settings);
  const weekday = new Date();
  while ([0, 6].includes(weekday.getUTCDay())) weekday.setUTCDate(weekday.getUTCDate() + 1);
  const lagosHour = (h) => new Date(Date.UTC(weekday.getUTCFullYear(), weekday.getUTCMonth(), weekday.getUTCDate(), h - 1));
  console.log('Through a weekday (clear road):');
  console.table([['morning', 8], ['afternoon', 14], ['evening', 18], ['night', 23]].map(([period, h]) => {
    const fare = config.calculateSuggestedFare(km, { durationSeconds: minutes * 60, trafficRatio: 1, origin, at: lagosHour(h) });
    // A range: a clear road on a quiet day, and heavy traffic in a busy area.
    const heavy = config.calculateSuggestedFare(km, { durationSeconds: minutes * 60, trafficRatio: 1.8, demandFactor: 1.5, origin, at: lagosHour(h) });
    const shown = heavy.suggestedFareNgn > fare.suggestedFareNgn ? `${naira(fare.suggestedFareNgn)} quiet, ${naira(heavy.suggestedFareNgn)} in heavy traffic` : naira(fare.suggestedFareNgn);
    return { period, at: `${String(h).padStart(2, '0')}:00`, otherApp: naira(fare.marketFareNgn), premium: premiumText(settings, period), shown };
  }));
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
  config.setPricingSettings(settings);
  const factor = area ? settings.areas[area.key].pickup : 1;
  // As prices are made now: by the clock with the curve on, else the rush or quiet figures it was tagged with.
  const f = row.rush ? settings.rush : settings.quiet;
  const ours = (config.hourFactorAt(row.takenAt) !== null
    ? config.marketFareNgn(row.km, row.minutes * 60, row.takenAt)
    : f.baseNgn + f.perKmNgn * row.km + f.perMinuteNgn * row.minutes) * factor;
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
  const { settings } = await pricingClient.loadSettings();
  // With the curve on, every price shapes the figures, an area's divided by its factor; otherwise city-wide prices only.
  const shaped = settings.hourCurveOn && settings.hourCurve;
  const rows = await prisma.marketSample.findMany({ where: { takenAt: { gte: new Date(Date.now() - 60 * 86400_000) }, ...(shaped ? {} : { area: null }) } });
  if (shaped) return fitShape(rows, settings);
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

/**
 * With the price by the clock on, the figures are one shape for every hour:
 * fitted from all the prices at once, each first divided by its hour's
 * multiplier, so a short trip and a long one, a morning and an evening,
 * all speak to the same base, per km and per minute. The curve is then
 * learned again against the new shape, so the two agree; saved together.
 */
async function fitShape(rows, settings) {
  const hourOf = (at) => {
    const { hour, weekend } = config.lagosClock(at);
    return (weekend ? settings.hourCurve.weekend : settings.hourCurve.weekday)[hour];
  };
  const areaOf = (r) => (r.area ? settings.areas[r.area]?.pickup ?? 1 : 1);
  const mine = rows.map((r) => ({ km: r.km, minutes: r.minutes, priceNgn: Number(r.priceNgn) / hourOf(r.takenAt) / areaOf(r) }));
  const result = fitMarket(mine, settings.quiet);
  const f = result.figures;
  console.log(`Price by the clock is on: one shape for every hour, from all ${mine.length} price${mine.length === 1 ? '' : 's'} in the last 60 days, each with its hour's multiplier taken out.`);
  if (result.fitted === 'nothing') { console.log('Nothing to fit from yet. Add prices: npm run pricing sample KM MINUTES PRICE'); return; }
  console.log(`  fitted ${result.fitted}: base ${naira(f.baseNgn)}, ${naira(f.perKmNgn)} a km, ${naira(f.perMinuteNgn)} a minute (was base ${naira(settings.quiet.baseNgn)}, ${naira(settings.quiet.perKmNgn)}, ${naira(settings.quiet.perMinuteNgn)})`);
  if (mine.length < 6) console.log(`  ${6 - mine.length} more price${6 - mine.length === 1 ? '' : 's'} (short and long trips) and all three figures are fitted.`);

  // The curve again, against the new shape.
  const next = { ...settings, quiet: f };
  config.setPricingSettings(next);
  const curve = await pricingClient.learnHourCurve(next);
  const guess = (r, quiet, c) => {
    const { hour, weekend } = config.lagosClock(r.takenAt);
    return (quiet.baseNgn + quiet.perKmNgn * r.km + quiet.perMinuteNgn * r.minutes) * (weekend ? c.weekend : c.weekday)[hour] * areaOf(r);
  };
  console.log('\nEach price you collected, and what we would guess for it:');
  console.table(rows.map((r) => ({
    taken: lagosTime(r.takenAt), km: r.km, min: r.minutes, inDrive: naira(r.priceNgn),
    'guess now': naira(guess(r, settings.quiet, settings.hourCurve)), 'guess with these': naira(guess(r, f, curve.curve)),
  })));
  const moved = [];
  for (const day of ['weekday', 'weekend']) {
    for (let h = 0; h < 24; h++) if (curve.curve[day][h] !== settings.hourCurve[day][h]) moved.push(`${day} ${hh(h)} ×${settings.hourCurve[day][h]} → ×${curve.curve[day][h]}`);
  }
  console.log(moved.length ? `The curve against the new shape: ${moved.join(', ')}` : 'The curve stays as it is against the new shape.');
  if (rest[0] !== 'save') { console.log('\nNothing saved. "npm run pricing fit save" to use the shape and the curve.'); return; }
  await pricingClient.saveSettings({ ...settings, quiet: f, hourCurve: curve.curve, hourCurveFittedAt: new Date().toISOString() }, 'server');
  console.log('\nSaved the shape and the curve. New prices follow within a minute.');
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
/** Inside Lagos: dearer both ways, so a fit sets the drop-off factor too. The outer areas keep theirs. */
const INNER_AREAS = new Set(['maryland', 'ikeja', 'surulere', 'lekki', 'ajah']);

async function areaFit() {
  const { settings } = await pricingClient.loadSettings();
  // Against the guess as prices are made now: by the clock with the curve on.
  config.setPricingSettings(settings);
  const rows = await prisma.marketSample.findMany({ where: { takenAt: { gte: new Date(Date.now() - 60 * 86400_000) }, area: { not: null } } });
  const change = { ...settings.areas };
  let any = false;
  for (const area of config.PRICING_AREAS) {
    const mine = rows.filter((r) => r.area === area.key);
    if (mine.length === 0) { console.log(`${area.name}: no prices collected (now ×${settings.areas[area.key].pickup})`); continue; }
    const ratios = mine.map((r) => {
      if (config.hourFactorAt(r.takenAt) !== null) return Number(r.priceNgn) / config.marketFareNgn(r.km, r.minutes * 60, r.takenAt);
      const f = r.rush ? settings.rush : settings.quiet;
      return Number(r.priceNgn) / (f.baseNgn + f.perKmNgn * r.km + f.perMinuteNgn * r.minutes);
    });
    const said = Math.round(Math.min(config.AREA_FACTOR_MAX, Math.max(1, median(ratios))) * 100) / 100;
    const inner = INNER_AREAS.has(area.key);
    console.log(`${area.name}: ${mine.length} price${mine.length === 1 ? '' : 's'} say ×${said} (now ×${settings.areas[area.key].pickup}${inner ? `, ×${settings.areas[area.key].dropoff} into it` : ''})${mine.length < 5 ? ' — few prices, take it as a hint' : ''}`);
    change[area.key] = inner ? { pickup: said, dropoff: said } : { ...change[area.key], pickup: said };
    any = true;
  }
  if (rest[0] !== 'save') { console.log('\nNothing saved. "npm run pricing area-fit save" to use these factors (inside Lagos both ways; outer areas the pickup).'); return; }
  if (!any) { console.log('Nothing to save.'); return; }
  await pricingClient.saveSettings({ ...settings, areas: change }, 'server');
  console.log('Saved. New prices follow within a minute.');
}

/** npm run pricing period evening 4000 | period evening off */
async function setPeriod() {
  const [period, value] = rest;
  if (!config.DAY_PERIODS.includes(period)) throw new Error(`Say which part of the day: npm run pricing period ${config.DAY_PERIODS.join('|')} AMOUNT (or off)`);
  if (value === undefined) throw new Error(`Say an amount in naira, or off: npm run pricing period ${period} 4000`);
  const { settings } = await pricingClient.loadSettings();
  if (!settings.marketFloorOn) console.log('Note: the floor is off, so no premium applies until "npm run pricing floor on".');
  await save((s) => {
    const periodPremiums = { ...s.periodPremiums };
    if (value === 'off') {
      delete periodPremiums[period];
    } else {
      // 4000, or a range 1500-3000
      const [low, high = low] = String(value).split('-');
      periodPremiums[period] = { minNgn: number(low, 'the amount'), maxNgn: number(high, 'the top of the range') };
    }
    return { periodPremiums };
  }, (s) => s.periodPremiums[period] === undefined
    ? `The ${period} is back to the general premium (other app + ${naira(s.premiumNgn)}).`
    : `In the ${period} the floor is now the other app + ${premiumText(s, period)}.`);
}

/** "₦4,000", "₦1,500–₦3,000 (by traffic and demand)", or the general one. */
function premiumText(settings, period) {
  const r = settings.periodPremiums[period];
  if (!r) return `${naira(settings.premiumNgn)} (general)`;
  return r.maxNgn > r.minNgn ? `${naira(r.minNgn)}–${naira(r.maxNgn)} (by traffic and demand)` : naira(r.minNgn);
}

/**
 * The prices shown in the last DAYS, matched to the rides they became by the
 * trip's ends and half hour, by part of the day: how many became rides, found
 * a driver and finished, the premium carried, and how long a driver took.
 */
async function report() {
  const days = rest[0] ? number(rest[0], 'days') : 7;
  const since = new Date(Date.now() - days * 86_400_000);
  const [quotes, rides] = await Promise.all([
    prisma.pricingQuote.findMany({ where: { createdAt: { gte: since }, tripKey: { not: null } }, select: { tripKey: true, premiumNgn: true, premiumPosition: true, dayPeriod: true, suggestedFareNgn: true } }),
    prisma.ride.findMany({ where: { createdAt: { gte: since } }, select: { pickupLat: true, pickupLng: true, destLat: true, destLng: true, createdAt: true, matchedAt: true, status: true } }),
  ]);
  const p = (lat, lng) => `${lat.toFixed(5)},${lng.toFixed(5)}`;
  const rideByKey = new Map();
  for (const r of rides) {
    const bucket = Math.floor(r.createdAt.getTime() / (30 * 60_000));
    // A ride booked just after the half hour turned was quoted in the one before.
    for (const b of [bucket, bucket - 1]) rideByKey.set(`${p(r.pickupLat, r.pickupLng)}>${p(r.destLat, r.destLng)}@${b}`, r);
  }
  const seen = new Set();
  const rows = new Map(config.DAY_PERIODS.map((d) => [d, { quotes: 0, rides: 0, matched: 0, completed: 0, premium: [], toMatch: [] }]));
  for (const q of quotes) {
    if (seen.has(q.tripKey)) continue; // a trip asked about again in the half hour is one quote
    seen.add(q.tripKey);
    const row = rows.get(q.dayPeriod) ?? rows.get('night');
    row.quotes += 1;
    if (q.premiumNgn !== null) row.premium.push(Number(q.premiumNgn));
    const ride = rideByKey.get(q.tripKey);
    if (!ride) continue;
    row.rides += 1;
    if (ride.matchedAt) { row.matched += 1; row.toMatch.push((ride.matchedAt - ride.createdAt) / 60_000); }
    if (ride.status === 'COMPLETED') row.completed += 1;
  }
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  const mid = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  console.log(`Prices shown in the last ${days} day${days === 1 ? '' : 's'}, matched to rides:`);
  console.table([...rows].map(([period, r]) => ({
    period, quotes: r.quotes, becameRides: `${r.rides} (${pct(r.rides, r.quotes)})`, foundDriver: pct(r.matched, r.rides), finished: pct(r.completed, r.rides),
    premium: mid(r.premium) === null ? '—' : naira(mid(r.premium)), minutesToDriver: mid(r.toMatch) === null ? '—' : mid(r.toMatch).toFixed(1),
  })));
  console.log('premium and minutes are the middle value. Quotes logged before the report existed have no trip key and are left out.');
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
  curve,
  surge,
  extra: () => save(() => ({ extraNgn: number(rest[0], 'the extra') }), (s) => (s.extraNgn > 0
    ? `Every price now has ${naira(s.extraNgn)} on top, after everything else is worked out.`
    : 'No extra on top any more.')),
  lift: () => save(() => ({ liftCap: number(rest[0], 'the lift') }), (s) => (s.liftCap <= 1
    ? 'Traffic and a busy area now move a price only inside the premium: never past the other app + the premium.'
    : `Traffic and a busy area may now lift a price to ${s.liftCap}× the floor.`)),
  period: setPeriod,
  report,
  indrive,
  try: tryTrip,
};

const run = commands[command];
if (!run) {
  console.log('Use: npm run pricing [status | floor|traffic|demand on|off | areas | area KEY PICKUP [DROPOFF] | area-fit [save] | model-on | model-off | quotes | try KM MINUTES [AREA] | discount N | closest N | premium N | extra N | lift N | curve [fit [save] | on | off] | surge [on | off | max N] | period morning|afternoon|evening|night N|MIN-MAX|off | report [DAYS] | trials SHARE | sample KM MINUTES PRICE [rush|quiet] [AREA] | samples | fit [save] | indrive quiet|rush BASE KM MINUTE]');
} else {
  await run().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
await prisma.$disconnect();
