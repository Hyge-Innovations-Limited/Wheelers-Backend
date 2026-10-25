/**
 * Pricing at every point in time, without anyone typing anything in: public
 * holidays from a calendar, weekends and nights learned as a whole from a few
 * prices, rain read from the weather and learned from prices seen in it, and
 * a surge that never discounts when our own market is thin for reasons of its
 * own (weekends, holidays, nights, rain). The evidence and weather tests run
 * against the local Postgres.
 *
 *   node --env-file=.env --test --test-force-exit test/pricing-calendar-rain.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const config = require('@wheleers/config');
const { prisma, pricingClient } = require('@wheleers/db');
const weather = require('../apps/api-gateway/dist/pricing/weather.js');
const { curveUpdate } = require('../apps/api-gateway/dist/pricing/hour-curve-job.js');

// Lagos time (UTC+1).
const lagos = (date, hour, minute = 0) => new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hour - 1, minute));
const WEDNESDAY = '2026-10-21';
const SATURDAY = '2026-10-24';
const range = { minNgn: 0, maxNgn: 500 };
const live = {
  marketFloorOn: true, liftCap: 1, extraNgn: 900, surgeOn: true, surgeMin: 0.9, surgeMax: 1.15, hourCurveOn: true,
  quiet: { baseNgn: 500, perKmNgn: 301, perMinuteNgn: 28 },
  periodPremiums: { morning: range, afternoon: range, evening: range, night: range },
};
const seed = () => config.seedHourCurve(config.normalizePricingSettings(live));
const sample = (at, ratio, rain = false) => ({ at, ratio, weight: 3, kind: 'sample', rain });

test.after(() => { config.setPricingSettings({}); return prisma.$disconnect(); });

/* ── the calendar ────────────────────────────────────────────────────── */

test('holidays are worked out for any year: fixed, Easter, the Eids and Mawlid, days off in lieu, festive eves', () => {
  assert.equal(config.easterSunday(2026), '2026-04-05');
  assert.equal(config.easterSunday(2027), '2027-03-28');
  const y2025 = Object.fromEntries(config.holidaysFor(2025).map((h) => [h.date, h.name]));
  // What the government declared in 2025: Eid-el-Fitr 31 Mar and 1 Apr, Eid-el-Kabir 6 and 9 Jun.
  assert.ok(y2025['2025-03-31'] && y2025['2025-04-01'], 'Eid-el-Fitr, and the day off in lieu of its Sunday');
  assert.ok(y2025['2025-06-06'] && y2025['2025-06-09'], 'Eid-el-Kabir, and the Monday for its Saturday');
  assert.equal(y2025['2025-04-18'], 'Good Friday');
  assert.equal(y2025['2025-04-21'], 'Easter Monday');
  const y2027 = Object.fromEntries(config.holidaysFor(2027).map((h) => [h.date, h.name]));
  assert.ok(y2027['2027-12-27'] && y2027['2027-12-28'], 'Christmas on a Saturday and Boxing Day on a Sunday give Monday and Tuesday');
  assert.equal(config.holidayOn('2026-12-31'), "New Year's Eve");
  assert.equal(config.holidayOn('2026-10-21'), null, 'an ordinary Wednesday');
  assert.equal(config.holidayOn('2027-03-10', [], ['2027-03-10']), null, 'a calendar guess taken off');
  assert.equal(config.holidayOn('2027-03-11', ['2027-03-11']), 'Declared holiday', 'a day declared on the day');
});

test('a holiday is priced as a weekend: no rush hours, the weekend curve, and no surge discount', () => {
  config.setPricingSettings(live);
  const christmasEve = lagos('2026-12-24', 8);
  assert.equal(config.lagosClock(christmasEve).weekend, true);
  assert.equal(config.lagosClock(christmasEve).holiday, 'Christmas Eve');
  assert.equal(config.isRushHour(christmasEve), false);
  assert.equal(config.isRushHour(lagos('2026-12-23', 8)), true, 'the day before is an ordinary rush morning');
  config.setPricingSettings({ ...live, holidays: ['2026-11-04'] });
  assert.equal(config.lagosClock(lagos('2026-11-04', 12)).weekend, true, 'a day an owner adds');
  config.setPricingSettings({ ...live, notHolidays: ['2026-12-24'] });
  assert.equal(config.lagosClock(christmasEve).weekend, false, 'and one taken off');
});

/* ── nights ──────────────────────────────────────────────────────────── */

test('nights start lifted (×1.15), may reach ×1.6, and learn one lift from a few night prices', () => {
  const s = seed();
  assert.equal(s.weekday[23], config.NIGHT_START);
  assert.equal(s.weekday[2], config.NIGHT_START);
  assert.equal(s.weekday[12], 1);
  const now = lagos('2026-10-22', 4);
  // Three weekday night prices, all 40% over the quiet figures: 22% over where nights start.
  const nights = [22, 23, 1].map((h, i) => sample(lagos(i < 2 ? WEDNESDAY : '2026-10-22', h), 1.4));
  const fit = config.fitHourCurve(nights, s, now, { baseline: s });
  assert.equal(fit.nightLift, 1.22);
  assert.equal(fit.liftPrices.night, 3);
  assert.equal(fit.curve.weekday[3], 1.32, 'a night hour with no prices of its own: 15% a fit toward 1.15 × 1.22');
  assert.equal(fit.curve.weekday[12], 1, 'daytime untouched');
  assert.equal(config.fitHourCurve(nights.slice(0, 2), s, now, { baseline: s }).nightLift, null, 'two are not enough');
});

/* ── weekends, every hour ────────────────────────────────────────────── */

test('three Saturday prices at 11:00 lift every quiet Saturday hour, 15% a fit; rush is not lifted on top; weekdays and Sundays are untouched', () => {
  const s = seed();
  const now = lagos(SATURDAY, 23, 30);
  const late = [10, 11, 12].map((h) => sample(lagos(SATURDAY, h), 1.16));
  const fit = config.fitHourCurve(late, s, now, { baseline: s });
  assert.equal(fit.weekendLift, 1.16);
  assert.equal(fit.curve.weekend[15], 1.15, 'Saturday 15:00 moves too: 15% toward 1.16');
  assert.equal(fit.curve.weekend[21], 1.15);
  assert.equal(fit.curve.weekend[18], 1.16, 'the evening rush: the higher of ×1.15 and ×1.16, never the two multiplied (it was ×1.33)');
  assert.deepEqual(fit.curve.weekday, s.weekday, 'no weekday hour moved');
  assert.equal(fit.sundayLift, null, 'Saturday prices say nothing about Sunday');
  assert.deepEqual(fit.curve.sunday, s.sunday, 'no Sunday hour moved');
});

/* ── rain ────────────────────────────────────────────────────────────── */

test('prices seen in the rain never move the hours; three of them teach the rain lift, which moves 15% a night', () => {
  const s = seed();
  const now = lagos(WEDNESDAY, 23, 30);
  const wet = [11, 12, 14].map((h) => sample(lagos(WEDNESDAY, h), 1.38, true));
  const fit = config.fitHourCurve(wet, s, now, { baseline: s });
  assert.deepEqual(fit.curve, { weekday: s.weekday, weekend: s.weekend, sunday: s.sunday }, 'the hours stay where they were');
  assert.equal(fit.rainLift, 1.38);
  assert.equal(fit.liftPrices.rain, 3);
  config.setPricingSettings(live);
  const update = curveUpdate(config.getPricingSettings(), fit, now);
  assert.equal(update.rainLift, 1.32, 'from 1.15, at most 15% in one night');
  assert.equal(curveUpdate(config.getPricingSettings(), { ...fit, rainLift: null }, now).rainLift, undefined, 'too few: left where it is');
});

test('rain lifts the price: light by the rain lift, heavy a little more; the hour, surge and rain together never pass ×2.2', () => {
  config.setPricingSettings(live);
  const trip = { durationSeconds: 37 * 60, at: lagos(WEDNESDAY, 12), surgeFactor: 1 };
  const dry = config.calculateSuggestedFare(20.2, trip);
  const light = config.calculateSuggestedFare(20.2, { ...trip, rain: 'light' });
  const heavy = config.calculateSuggestedFare(20.2, { ...trip, rain: 'heavy' });
  assert.equal(dry.rainFactor, 1);
  assert.equal(light.rainFactor, 1.15);
  assert.equal(heavy.rainFactor, 1.26, '1.15 × 1.1');
  assert.ok(light.suggestedFareNgn > dry.suggestedFareNgn && heavy.suggestedFareNgn > light.suggestedFareNgn, `${dry.suggestedFareNgn} < ${light.suggestedFareNgn} < ${heavy.suggestedFareNgn}`);
  config.setPricingSettings({ ...live, rainOn: false });
  assert.equal(config.calculateSuggestedFare(20.2, { ...trip, rain: 'heavy' }).rainFactor, 1, 'rain switched off');

  // A Saturday night at ×1.6, a storm, a busy market: capped.
  const night = { weekday: Array(24).fill(1.6), weekend: Array(24).fill(1.6) };
  config.setPricingSettings({ ...live, rainLift: 1.6, surgeMax: 1.4, hourCurve: night });
  const storm = config.calculateSuggestedFare(10, { durationSeconds: 20 * 60, at: lagos(SATURDAY, 23), surgeFactor: 1.4, rain: 'heavy' });
  const quiet = config.quietMarketFareNgn(10, 20);
  assert.ok(storm.marketFareNgn <= quiet * config.COMBINED_LIFT_MAX + 1, `${Math.round(storm.marketFareNgn)} is at most 2.2 × ${Math.round(quiet)}`);
});

test('the surge never discounts at weekends, holidays, nights or in the rain; on a quiet weekday afternoon it still may', () => {
  config.setPricingSettings(live);
  const quiet = (at, extra = {}) => config.calculateSuggestedFare(15, { durationSeconds: 40 * 60, at, surgeFactor: 0.9, ...extra }).surgeFactor;
  assert.equal(quiet(lagos(WEDNESDAY, 14)), 0.9);
  assert.equal(quiet(lagos(SATURDAY, 14)), 1);
  assert.equal(quiet(lagos('2026-12-25', 14)), 1);
  assert.equal(quiet(lagos(WEDNESDAY, 23)), 1);
  assert.equal(quiet(lagos(WEDNESDAY, 14), { rain: 'light' }), 1);
});

/* ── the weather ─────────────────────────────────────────────────────── */

test('Google\'s weather words become rain we price on; a forecast is not rain', () => {
  const c = (type, mm) => weather.classifyWeather({ weatherCondition: type ? { type } : undefined, precipitation: mm === undefined ? undefined : { qpf: { quantity: mm, unit: 'MILLIMETERS' } } }).rain;
  assert.equal(c('LIGHT_RAIN'), 'light');
  assert.equal(c('RAIN_SHOWERS'), 'light');
  assert.equal(c('HEAVY_RAIN'), 'heavy');
  assert.equal(c('THUNDERSTORM'), 'heavy');
  assert.equal(c('CHANCE_OF_SHOWERS'), 'none');
  assert.equal(c('CLEAR', 0), 'none');
  assert.equal(c(undefined, 0.6), 'light');
  assert.equal(c(undefined, 9), 'heavy');
  assert.equal(weather.classifyWeather(null).rain, 'none');
});

test('a pickup takes its zone\'s rain, or the nearest zone\'s within 25 km; stale or far is dry', () => {
  const now = Date.now();
  const at = (minsAgo) => new Date(now - minsAgo * 60_000);
  weather.setWeatherForTest([
    { zone: 'Yaba', at: at(5), rain: 'heavy', mm: 9, condition: 'HEAVY_RAIN', lat: 6.51, lng: 3.383 },
    { zone: 'Ikeja', at: at(90), rain: 'light', mm: 1, condition: 'LIGHT_RAIN', lat: 6.6, lng: 3.35 },
  ]);
  assert.equal(weather.rainAt(6.5158, 3.3898, now), 'heavy', 'Unilag, in Yaba');
  assert.equal(weather.rainAt(6.6018, 3.3515, now), 'heavy', 'Ikeja is stale (90 min), so the nearest fresh zone, Yaba, ~10 km away');
  assert.equal(weather.rainAt(6.62, 3.51, now), 'heavy', 'Ikorodu side, about 15 km: still near enough');
  assert.equal(weather.rainAt(6.43, 3.9, now), 'none', 'Ibeju-Lekki, far from every reading');
  weather.setWeatherForTest([]);
  assert.equal(weather.rainAt(6.5158, 3.3898, now), 'none', 'no readings: dry');
});

test('a weather pass keeps what came back; a disabled API changes nothing and does not crash', async () => {
  // Recent (older than 90 days is cleaned away as it is kept), and to the millisecond its own.
  const when = new Date(Date.now() - 3_600_000 - 123);
  const denied = async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'Weather API has not been used in project' } }) });
  assert.deepEqual(await weather.measureWeather({ set: async () => undefined }, 'k', denied, when), []);
  const wet = async () => ({ ok: true, status: 200, json: async () => ({ weatherCondition: { type: 'LIGHT_RAIN' }, precipitation: { qpf: { quantity: 1.2 } } }) });
  try {
    const got = await weather.measureWeather({ set: async () => undefined }, 'k', wet, when);
    assert.equal(got.length, config.LAUNCH_ZONES.length);
    assert.ok(got.every((r) => r.rain === 'light'));
    assert.equal(await prisma.weatherReading.count({ where: { at: when } }), config.LAUNCH_ZONES.length);
  } finally {
    await prisma.weatherReading.deleteMany({ where: { at: when } });
    weather.setWeatherForTest([]);
  }
});

test('the nightly evidence marks prices seen while it rained, so they teach rain and not the hour', async () => {
  const at = new Date(Date.now() - 2 * 3_600_000);
  const id = randomUUID();
  await prisma.weatherReading.create({ data: { zone: 'Yaba', at: new Date(at.getTime() + 5 * 60_000), rain: 'light', mm: 1, condition: 'LIGHT_RAIN' } });
  await prisma.marketSample.create({ data: { id, km: 10, minutes: 25, priceNgn: 5000, rush: false, takenAt: at, addedBy: 'test' } });
  const dryId = randomUUID();
  const dryAt = new Date(Date.now() - 26 * 3_600_000);
  await prisma.marketSample.create({ data: { id: dryId, km: 10, minutes: 25, priceNgn: 4000, rush: false, takenAt: dryAt, addedBy: 'test' } });
  try {
    const evidence = await pricingClient.curveEvidence(new Date(Date.now() - 2 * 86_400_000), config.normalizePricingSettings(live));
    const wet = evidence.find((e) => e.kind === 'sample' && e.at.getTime() === at.getTime());
    const dry = evidence.find((e) => e.kind === 'sample' && e.at.getTime() === dryAt.getTime());
    assert.equal(wet.rain, true);
    assert.equal(dry.rain, false);
  } finally {
    await prisma.marketSample.deleteMany({ where: { id: { in: [id, dryId] } } });
    await prisma.weatherReading.deleteMany({ where: { at: new Date(at.getTime() + 5 * 60_000) } });
  }
});
