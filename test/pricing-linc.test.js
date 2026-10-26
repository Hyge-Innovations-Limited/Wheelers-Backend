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
  // Saturday's Opebi to Ijeshatedo: Linc ₦9,350.
  const sat = price(on, 20.2, 37);
  assert.equal(sat.setBy, 'linc');
  assert.equal(sat.suggestedFareNgn, 9400);
  assert.equal(sat.minOfferNgn, 8500);
  // Sunday evening into Alagbado, slow: Linc ₦11,450, where inDrive + our extras said ₦8,550.
  assert.equal(price(on, 16.6, 48).suggestedFareNgn, 11450);
  // Monday's Allen Avenue to Ijeshatedo, fast: Linc ₦7,400.
  const fast = price(on, 14, 27);
  assert.ok(fast.suggestedFareNgn >= 7000 && fast.suggestedFareNgn <= 7400, String(fast.suggestedFareNgn));
  // Sitting above or under Linc.
  assert.equal(price({ ...on, lincAboveNgn: 300 }, 20.2, 37).suggestedFareNgn, 9700);
  assert.equal(price({ ...on, lincAboveNgn: -300 }, 20.2, 37).suggestedFareNgn, 9100);
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
  const samples = [...config.LINC_SAMPLES_SEEN, { km: 15.5, minutes: 25, priceNgn: 7950, at: '2026-10-26T22:03:00Z' }];
  const withNight = config.fitLincFigures(samples, 1.15);
  for (const s of samples) {
    const night = new Date(Date.parse(s.at) + 3_600_000).getUTCHours() >= 22;
    const said = config.lincFareNgn(s.km, s.minutes, withNight) * (night ? 1.15 : 1);
    assert.ok(Math.abs(said / s.priceNgn - 1) < 0.1, `${s.km} km ${s.minutes} min: ${Math.round(said)} for ${s.priceNgn}`);
  }
});

test('Linc\'s figures are fitted from its prices, none below zero; it is a price by the minute', () => {
  const fitted = config.fitLincFigures(config.LINC_SAMPLES_SEEN);
  assert.ok(fitted.perMinuteNgn > 150, JSON.stringify(fitted));
  assert.ok(fitted.perKmNgn >= 0 && fitted.baseNgn >= 0);
  assert.equal(config.fitLincFigures(config.LINC_SAMPLES_SEEN.slice(0, 2)), null, 'two are not enough');
  // Saved settings keep their shape; bad samples are dropped.
  const s = config.normalizePricingSettings({ lincOn: true, lincAboveNgn: 333, lincSamples: [{ km: 5, minutes: 10, priceNgn: 3000, at: 'x' }, { km: -1, minutes: 1, priceNgn: 1, at: 'y' }] });
  assert.equal(s.lincAboveNgn, 350);
  assert.equal(s.lincSamples.length, 1);
});
