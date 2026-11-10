// Linc as the guide: with it on, a trip is priced at what Linc would charge
// (its figures on the live minutes; it charges by the minute, nearly not by
// the km), plus where we choose to sit, never under inDrive's high end; the
// flat extra and the margin are not added. Its figures fit its real prices.
//
//   node --test test/pricing-linc.test.js

// These tests check the pricing rules themselves, before the recommended cut (pricing.ts RECOMMENDED_CUT_PERCENT).
process.env.PRICING_RECOMMENDED_CUT_PERCENT = '0';
process.env.PRICING_MIN_FARE_NGN = '3300';
process.env.PRICING_MIN_OFFER_CUT_PERCENT = '0';
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

test('Linc by the time of day, weekdays apart from weekends: two Tuesday-morning trips lift weekday mornings; one is not enough, however often it is priced', () => {
  const base = { ...live, lincOn: true };
  const figures = config.normalizePricingSettings(base).linc;
  // Two trips, both 1.48× Linc's figures, as Linc's ₦11,100 for 15.5 km on a Tuesday morning was.
  const morning = (minute, km, minutes) => ({ km, minutes, priceNgn: Math.round(config.lincFareNgn(km, minutes, figures) * 11100 / config.lincFareNgn(15.5, 30, figures)), at: `2026-10-27T07:${minute}:00Z` }); // 08:xx Lagos
  config.setPricingSettings({ ...base, lincSamples: [...config.LINC_SAMPLES_SEEN, morning('10', 15.5, 30)] });
  assert.equal(config.lincPeriodLifts().lifts['weekday-morning'], 1, 'one price is not enough');
  config.setPricingSettings({ ...base, lincSamples: [...config.LINC_SAMPLES_SEEN, morning('10', 15.5, 30), morning('12', 15.5, 30)] });
  assert.equal(config.lincPeriodLifts().lifts['weekday-morning'], 1, 'one trip priced twice is one trip');
  config.setPricingSettings({ ...base, lincSamples: [...config.LINC_SAMPLES_SEEN, morning('10', 15.5, 30), morning('20', 9.8, 24)] });
  const { lifts, counts } = config.lincPeriodLifts();
  assert.equal(counts['weekday-morning'], 2);
  assert.equal(counts['weekend-morning'], 2, 'Saturday 11:40 and Sunday 09:50');
  assert.ok(lifts['weekday-morning'] > 1.35, JSON.stringify(lifts));
  assert.ok(Math.abs(lifts['weekend-morning'] - 1) < 0.06, 'weekend mornings stay at its figures');
  assert.equal(lifts['weekday-afternoon'], 1, 'the afternoon is untouched');
  assert.equal(lifts['weekend-evening'], 1, 'the Sunday-evening Alagbado trip, priced twice, is one trip');
  const at = new Date(Date.UTC(2026, 9, 28, 7, 15)); // Wednesday 08:15 Lagos
  const p = config.calculateSuggestedFare(15.5, { durationSeconds: 30 * 60, at, trafficRatio: 1 });
  assert.equal(p.setBy, 'linc');
  assert.ok(Math.abs(p.suggestedFareNgn - 11100) <= 300, `a weekday morning: about Linc's ₦11,100 (${p.suggestedFareNgn})`);
});


test('a percentage over Linc: off unless set; on, Linc ×(1 + %); the band keeps the ceiling from cutting it on a long trip', () => {
  assert.equal(config.normalizePricingSettings({}).lincAbovePercent, 0);
  assert.equal(config.normalizePricingSettings({}).lincMaxAbovePercent, null, 'settings saved before it keep the ₦ ceiling alone');
  const on = { ...live, lincOn: true };
  const plain = price(on, 20.2, 37);
  const five = price({ ...on, lincAbovePercent: 5 }, 20.2, 37);
  assert.equal(five.lincNgn, plain.lincNgn, 'Linc\'s own price is the same');
  assert.ok(Math.abs(five.suggestedFareNgn - plain.lincNgn * 1.05) <= 50, `${five.suggestedFareNgn} for ${plain.lincNgn} ×1.05`);
  // A long trip: +12% over Linc is more than the ₦1,000 ceiling; with the band at 12% it stands.
  const long = { ...on, lincAbovePercent: 12, ceilingAboveNgn: 1000 };
  const cut = price(long, 45, 90);
  assert.equal(cut.setBy, 'ceiling', 'without the band, the ₦1,000 ceiling cuts +12%');
  const kept = price({ ...long, lincMaxAbovePercent: 12 }, 45, 90);
  assert.ok(kept.suggestedFareNgn > cut.suggestedFareNgn && kept.suggestedFareNgn <= Math.ceil(kept.lincNgn * 1.12 / 50) * 50 + 50, `${kept.suggestedFareNgn} for Linc ₦${kept.lincNgn}`);
});

test('Linc\'s bonus: its prices saved as shown, priced against its full price (10%, at most ₦1,000); off by default', () => {
  assert.equal(config.normalizePricingSettings({}).lincBonusPercent, 0, 'settings saved before it: the price as shown');
  // Read off Linc on 6 Nov: "₦3,420 · ₦380 bonus", "₦8,820 · ₦980 bonus", "₦13,100 · ₦1,000 bonus".
  const bonus = { lincBonusPercent: 10, lincBonusCapNgn: 1000 };
  assert.equal(Math.round(config.lincFullPriceNgn(3420, bonus)), 3800);
  assert.equal(Math.round(config.lincFullPriceNgn(8820, bonus)), 9800);
  assert.equal(config.lincFullPriceNgn(13100, bonus), 14100, 'the bonus stops at ₦1,000');
  assert.equal(config.lincFullPriceNgn(13100, { lincBonusPercent: 0, lincBonusCapNgn: 1000 }), 13100);
  const s = config.normalizePricingSettings({ lincBonusPercent: 99, lincBonusCapNgn: 1234 });
  assert.deepEqual([s.lincBonusPercent, s.lincBonusCapNgn], [50, 1250]);

  const on = { ...live, lincOn: true };
  const shown = price(on, 20.2, 37);
  const full = price({ ...on, ...bonus }, 20.2, 37);
  assert.equal(full.lincNgn, Math.round(config.lincFullPriceNgn(shown.lincNgn, bonus)), 'Linc\'s price for the trip is its full price');
  assert.ok(full.suggestedFareNgn >= full.lincNgn, `${full.suggestedFareNgn} for Linc's full ₦${full.lincNgn}`);
  assert.ok(full.ceilingNgn >= full.lincNgn + 1000 - 50, 'the ceiling stands on the full price');
});

test('Linc by zone: short under 8 km, then an outer end, then an Island end, else central; each zone learns its own lift; off by default', () => {
  const YABA = { lat: 6.5095, lng: 3.3711 }, VI = { lat: 6.4264, lng: 3.4296 }, IDIMU = { lat: 6.5887, lng: 3.2430 }, IKEJA = { lat: 6.5940, lng: 3.3364 };
  assert.equal(config.lincZoneOf(6.4, YABA, VI), 'short');
  assert.equal(config.lincZoneOf(16.9, IDIMU, IKEJA), 'outer');
  assert.equal(config.lincZoneOf(22.1, YABA, VI), 'island');
  assert.equal(config.lincZoneOf(15, YABA, IKEJA), 'central');
  assert.equal(config.lincSampleZone({ km: 5, minutes: 20, priceNgn: 6000, at: 'x' }), 'short', 'untagged: by its km');
  assert.equal(config.lincSampleZone({ km: 15, minutes: 30, priceNgn: 9000, at: 'x' }), 'central');
  assert.equal(config.normalizePricingSettings({}).lincZonesOn, false);
  // Linc charges the Island 20% over its figures and central at them (two prices each, the same
  // hour). The hour's lift takes the middle of all four; each zone's lift is learned against it,
  // so together an Island trip comes out ×1.2 and a central one ×1.0 of the figures.
  const figures = { baseNgn: 2000, perKmNgn: 300, perMinuteNgn: 0 };
  const at = '2026-11-05T13:00:00Z';
  const price = (km, lift) => Math.round(config.lincFareNgn(km, 40, figures) * lift);
  const settings = config.normalizePricingSettings({ linc: figures, lincSamples: [
    { km: 20, minutes: 40, priceNgn: price(20, 1.2), at, zone: 'island' },
    { km: 25, minutes: 40, priceNgn: price(25, 1.2), at, zone: 'island' },
    { km: 18, minutes: 40, priceNgn: price(18, 1), at, zone: 'central' },
    { km: 22, minutes: 40, priceNgn: price(22, 1), at, zone: 'central' },
  ] });
  assert.equal(config.lincZoneLifts(settings).lifts.outer, 1, 'no prices: ×1');
  const trip = (origin, destination) => ({ durationSeconds: 40 * 60, trafficRatio: 1, at: new Date(at), origin, destination });
  config.setPricingSettings({ ...settings, lincOn: true, lincZonesOn: true });
  const island = config.calculateSuggestedFare(22, trip(YABA, VI));
  const central = config.calculateSuggestedFare(22, trip(YABA, IKEJA));
  assert.equal(island.lincZone, 'island');
  assert.ok(Math.abs(island.lincNgn / config.lincFareNgn(22, 40, figures) - 1.2) < 0.03, `island ${island.lincNgn}`);
  assert.ok(Math.abs(central.lincNgn / config.lincFareNgn(22, 40, figures) - 1) < 0.03, `central ${central.lincNgn}`);
  // Off: the zone is not looked at.
  config.setPricingSettings({ ...settings, lincOn: true, lincZonesOn: false });
  assert.equal(config.calculateSuggestedFare(22, trip(YABA, VI)).lincNgn, config.calculateSuggestedFare(22, trip(YABA, IKEJA)).lincNgn);
});

test('a short trip does not move the figures for the rest (its base is its own zone); by km only, no minutes', () => {
  const rest = config.LINC_SAMPLES_SEEN.filter((s) => config.lincSampleZone(s) !== 'short');
  const withShort = [...rest, { km: 6.4, minutes: 26, priceNgn: 7290, at: '2026-11-06T18:50:00Z', zone: 'short' }];
  assert.deepEqual(config.fitLincFigures(withShort), config.fitLincFigures(rest));
  assert.equal(config.fitLincFigures(rest, 1, { minutes: false }).perMinuteNgn, 0);
});
