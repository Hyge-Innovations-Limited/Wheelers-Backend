// Linc as the guide: with it on, a trip is priced at what Linc would charge
// (its figures on the live minutes; it charges by the minute, nearly not by
// the km), plus where we choose to sit, never under inDrive's high end; the
// flat extra and the margin are not added. Its figures fit its real prices.
//
//   node --test test/pricing-linc.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('@wheleers/config');

const range = { minNgn: 0, maxNgn: 500 };
const live = {
  marketFloorOn: true, liftCap: 1, extraNgn: 1400, minOfferGapNgn: 900, marginPercent: 3, marketHigh: 1.17, hourCurveOn: false,
  quiet: { baseNgn: 500, perKmNgn: 301, perMinuteNgn: 28 },
  periodPremiums: { morning: range, afternoon: range, evening: range, night: range },
};
const monday = new Date(Date.UTC(2026, 9, 26, 12)); // 13:00 Lagos
const price = (settings, km, minutes) => {
  config.setPricingSettings(settings);
  return config.calculateSuggestedFare(km, { durationSeconds: minutes * 60, at: monday, trafficRatio: 1 });
};

test.after(() => config.setPricingSettings({}));

test('off by default: nothing changes', () => {
  config.setPricingSettings({});
  assert.equal(config.getPricingSettings().lincOn, false);
  const p = price(live, 20.2, 37);
  assert.notEqual(p.setBy, 'linc');
  assert.equal(p.lincNgn, null);
});

test('on: the trip is priced at Linc\'s price, fast and slow trips alike, never under inDrive\'s high end', () => {
  const on = { ...live, lincOn: true };
  // Saturday's Opebi to Ijeshatedo: Linc ₦9,350. (Figures refitted 6 Nov with Friday evening's
  // prices: ₦2,088 + ₦81/km + ₦147/min, was ₦1,150 + ₦36/km + ₦202/min.)
  const sat = price(on, 20.2, 37);
  assert.equal(sat.setBy, 'linc');
  assert.equal(sat.suggestedFareNgn, 9200);
  assert.equal(sat.minOfferNgn, 8300);
  // Sunday evening into Alagbado, slow: Linc ₦11,450 then; a like trip (16.9 km, 44 min) was ₦8,145 on a Friday evening.
  assert.equal(price(on, 16.6, 48).suggestedFareNgn, 10500);
  // Monday's Allen Avenue to Ijeshatedo, fast: Linc ₦7,400.
  const fast = price(on, 14, 27);
  assert.ok(fast.suggestedFareNgn >= 7000 && fast.suggestedFareNgn <= 7400, String(fast.suggestedFareNgn));
  // Sitting above or under Linc.
  assert.equal(price({ ...on, lincAboveNgn: 300 }, 20.2, 37).suggestedFareNgn, 9500);
  assert.equal(price({ ...on, lincAboveNgn: -300 }, 20.2, 37).suggestedFareNgn, 8950);
  // A short, quick trip where Linc's figures fall under inDrive's high end: the floor holds.
  const quick = price({ ...on, lincAboveNgn: -3000 }, 20.2, 37);
  assert.equal(quick.setBy, 'floor');
  assert.equal(quick.suggestedFareNgn, quick.highEndNgn);
});

test('at night Linc charges more: ×1.15 by default (Opebi to Ijeshatedo at 23:03, 15.5 km 25 min: Linc ₦7,950)', () => {
  config.setPricingSettings({ ...live, lincOn: true });
  const night = config.calculateSuggestedFare(15.5, { durationSeconds: 25 * 60, at: new Date(Date.UTC(2026, 9, 26, 22, 3)), trafficRatio: 1 });
  assert.equal(night.setBy, 'linc');
  assert.ok(Math.abs(night.suggestedFareNgn - 7950) <= 250, String(night.suggestedFareNgn));
  // A night price is taken back to daytime before fitting: it does not bend the daytime figures.
  // (Linc's own prices are not one formula: the same trip was ₦8,145 on a Friday evening and
  // ₦11,450 on a Saturday evening. So the fit is compared with itself, not with each price.)
  const samples = [...config.LINC_SAMPLES_SEEN, { km: 15.5, minutes: 25, priceNgn: 7950, at: '2026-10-26T22:03:00Z' }];
  const withNight = config.fitLincFigures(samples, 1.15);
  const without = config.fitLincFigures(config.LINC_SAMPLES_SEEN, 1.15);
  for (const [km, minutes] of [[5, 15], [16.9, 44], [20.2, 37], [29.8, 64]]) {
    const a = config.lincFareNgn(km, minutes, withNight);
    const b = config.lincFareNgn(km, minutes, without);
    assert.ok(Math.abs(a / b - 1) < 0.05, `${km} km ${minutes} min: ${Math.round(a)} with the night price, ${Math.round(b)} without`);
  }
});

test('Linc\'s figures are fitted from its prices, none below zero; distance counts, not only the minutes', () => {
  const fitted = config.fitLincFigures(config.LINC_SAMPLES_SEEN);
  // Until 6 Nov the fit was nearly all minutes (₦0/km, ₦220/min) and priced a slow 17 km trip 30%
  // over Linc; Linc's own prices that evening showed distance matters.
  assert.ok(fitted.perKmNgn > 50, JSON.stringify(fitted));
  assert.ok(fitted.perMinuteNgn < 200, JSON.stringify(fitted));
  assert.ok(fitted.perKmNgn >= 0 && fitted.baseNgn >= 0);
  assert.equal(config.fitLincFigures(config.LINC_SAMPLES_SEEN.slice(0, 2)), null, 'two are not enough');
  // Saved settings keep their shape; bad samples are dropped.
  const s = config.normalizePricingSettings({ lincOn: true, lincAboveNgn: 333, lincSamples: [{ km: 5, minutes: 10, priceNgn: 3000, at: 'x' }, { km: -1, minutes: 1, priceNgn: 1, at: 'y' }] });
  assert.equal(s.lincAboveNgn, 350);
  assert.equal(s.lincSamples.length, 1);
});

test('Linc by the time of day, weekdays apart from weekends: two Tuesday-morning prices lift weekday mornings; one is not enough', () => {
  const morning = (minute) => ({ km: 15.5, minutes: 30, priceNgn: 11100, at: `2026-10-27T07:${minute}:00Z` }); // 08:xx Lagos
  const base = { ...live, lincOn: true };
  config.setPricingSettings({ ...base, lincSamples: [...config.LINC_SAMPLES_SEEN, morning('10')] });
  assert.equal(config.lincPeriodLifts().lifts['weekday-morning'], 1, 'one price is not enough');
  config.setPricingSettings({ ...base, lincSamples: [...config.LINC_SAMPLES_SEEN, morning('10'), morning('20')] });
  const { lifts, counts } = config.lincPeriodLifts();
  assert.equal(counts['weekday-morning'], 2);
  assert.equal(counts['weekend-morning'], 2, 'Saturday 11:40 and Sunday 09:50');
  assert.ok(lifts['weekday-morning'] > 1.35, JSON.stringify(lifts));
  assert.ok(Math.abs(lifts['weekend-morning'] - 1) < 0.06, 'weekend mornings stay at its figures');
  assert.equal(lifts['weekday-afternoon'], 1, 'the afternoon is untouched');
  const at = new Date(Date.UTC(2026, 9, 28, 7, 15)); // Wednesday 08:15 Lagos
  const p = config.calculateSuggestedFare(15.5, { durationSeconds: 30 * 60, at, trafficRatio: 1 });
  assert.equal(p.setBy, 'linc');
  assert.ok(Math.abs(p.suggestedFareNgn - 11100) <= 300, `a weekday morning: about Linc's ₦11,100 (${p.suggestedFareNgn})`);
});

