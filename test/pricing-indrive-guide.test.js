// Pricing to Timi's 8 Nov target, each part a setting and all off until set:
// the suggestion is inDrive's one-click price (± indriveOffsetNgn), never
// above a share of Linc's (lincBelowPercent), a trip touching an outer area
// (not Epe) never above outerCapNgn, and the lowest offer a share of the
// suggested price (minOfferShare) in place of the fixed gap.
//
//   node --test test/pricing-indrive-guide.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('@wheleers/config');

const range = { minNgn: 0, maxNgn: 500 };
// As the live server prices (Linc as the guide, the floor on), with the hour curve off for steady numbers.
const live = {
  marketFloorOn: true, liftCap: 1, extraNgn: 1400, minOfferGapNgn: 900, marginPercent: 3, marketHigh: 1.17, hourCurveOn: false,
  quiet: { baseNgn: 500, perKmNgn: 301, perMinuteNgn: 28 },
  periodPremiums: { morning: range, afternoon: range, evening: range, night: range },
  lincOn: true, linc: { baseNgn: 571, perKmNgn: 200, perMinuteNgn: 119 }, lincBonusPercent: 10, lincBonusCapNgn: 1000, lincMaxAbovePercent: 12,
};
const monday = new Date(Date.UTC(2026, 9, 26, 12)); // 13:00 Lagos
const area = (key) => { const a = config.PRICING_AREAS.find((x) => x.key === key); return { lat: a.center[0], lng: a.center[1] }; };
const YABA = { lat: 6.5095, lng: 3.3711 };
const price = (settings, km, minutes, places = {}) => {
  config.setPricingSettings(settings);
  return config.calculateSuggestedFare(km, { durationSeconds: minutes * 60, at: monday, trafficRatio: 1, ...places });
};
test.after(() => config.setPricingSettings({}));

test('all off (the default): every price is exactly as before', () => {
  config.setPricingSettings({});
  const s = config.getPricingSettings();
  assert.deepEqual([s.indriveGuideOn, s.indriveOffsetNgn, s.lincBelowPercent, s.outerCapNgn, s.minOfferShare], [false, 0, null, null, null]);
  assert.deepEqual(s.outerCapAreas, ['alimosho', 'ikorodu', 'ajah', 'ibeju-lekki', 'badagry']);
  assert.deepEqual(s.outerCapExceptAreas, ['epe']);
  for (const [km, min, places] of [[5, 14, {}], [20.2, 37, {}], [45, 95, { origin: area('ikorodu'), destination: YABA }]]) {
    const before = price(live, km, min, places);
    const withKeys = price({ ...live, indriveGuideOn: false, lincBelowPercent: null, outerCapNgn: null, minOfferShare: null }, km, min, places);
    assert.deepEqual([withKeys.suggestedFareNgn, withKeys.minOfferNgn, withKeys.setBy], [before.suggestedFareNgn, before.minOfferNgn, before.setBy], `${km} km`);
  }
});

test('inDrive as the guide: its one-click price for the trip ± the offset, never lifted to its high end, no extra on top', () => {
  const plain = price({ ...live, indriveGuideOn: true }, 20.2, 37);
  assert.equal(plain.setBy, 'indrive');
  const roundUp50 = (n) => Math.ceil(n / 50) * 50;
  assert.equal(plain.suggestedFareNgn, roundUp50(plain.marketFareNgn), 'inDrive\'s price, rounded to ₦50');
  assert.ok(plain.suggestedFareNgn < plain.highEndNgn, 'not lifted to inDrive\'s high end');
  const up = price({ ...live, indriveGuideOn: true, indriveOffsetNgn: 200 }, 20.2, 37);
  const down = price({ ...live, indriveGuideOn: true, indriveOffsetNgn: -200 }, 20.2, 37);
  assert.equal(up.suggestedFareNgn, roundUp50(plain.marketFareNgn + 200));
  assert.equal(down.suggestedFareNgn, roundUp50(plain.marketFareNgn - 200));
  // Saved out of range: held to ±₦1,000, in ₦50s.
  config.setPricingSettings({ indriveOffsetNgn: 5000 });
  assert.equal(config.getPricingSettings().indriveOffsetNgn, 1000);
});

test('never above Linc: at most (100 − N)% of Linc\'s price for the trip, rounded down', () => {
  // Linc's price for these trips, as the guide reads it (before its bonus).
  for (const [km, min] of [[8, 25], [20.2, 37], [30, 54]]) {
    const linc = price(live, km, min).lincNgn;
    const capped = price({ ...live, lincAbovePercent: 10, lincBelowPercent: 3 }, km, min);
    assert.ok(capped.suggestedFareNgn <= Math.floor(linc * 0.97 / 50) * 50, `${km} km: ${capped.suggestedFareNgn} vs Linc ${linc}`);
    assert.equal(capped.setBy, 'under-linc');
  }
  // With inDrive as the guide, a trip where inDrive is already under it is left alone.
  const cheap = price({ ...live, indriveGuideOn: true, lincBelowPercent: 3 }, 20.2, 37);
  if (cheap.marketFareNgn < cheap.lincNgn * 0.97) assert.equal(cheap.setBy, 'indrive');
});

test('outer areas (not Epe): never suggested above the cap; other areas and Epe untouched', () => {
  const settings = { ...live, outerCapNgn: 17000 };
  const ikorodu = price(settings, 45, 95, { origin: area('ikorodu'), destination: YABA });
  assert.ok(price(live, 45, 95, { origin: area('ikorodu'), destination: YABA }).suggestedFareNgn > 17000, 'the long Ikorodu trip is over ₦17,000 without the cap');
  assert.deepEqual([ikorodu.suggestedFareNgn, ikorodu.setBy], [17000, 'outer-cap']);
  const intoAlimosho = price(settings, 45, 95, { origin: YABA, destination: area('alimosho') });
  assert.equal(intoAlimosho.suggestedFareNgn, 17000, 'dropped off in an outer area counts too');
  const epe = price(settings, 60, 110, { origin: area('epe'), destination: YABA });
  assert.ok(epe.suggestedFareNgn > 17000, 'Epe is kept out of the cap');
  const central = price(settings, 45, 95, { origin: YABA, destination: { lat: 6.4281, lng: 3.4219 } });
  assert.notEqual(central.setBy, 'outer-cap');
  // A list saved with unknown areas keeps only the known ones.
  config.setPricingSettings({ outerCapAreas: ['ikorodu', 'nowhere'] });
  assert.deepEqual(config.getPricingSettings().outerCapAreas, ['ikorodu']);
});

// The share, never under the minimum fare (₦3,300) nor above the suggested price: as the gap rule.
const byShare = (suggested, share) => Math.min(Math.max(Math.ceil(suggested * share / 50) * 50, config.MIN_FARE_NGN), Math.max(suggested, config.MIN_FARE_NGN));

test('the lowest offer as a share of the suggested price: the room grows with the trip; off: the fixed gap', () => {
  for (const [km, min] of [[4, 12], [20.2, 37], [40, 80]]) {
    const p = price({ ...live, minOfferShare: 0.85 }, km, min);
    assert.equal(p.minOfferNgn, byShare(p.suggestedFareNgn, 0.85), `${km} km`);
    assert.ok(p.minOfferNgn <= p.suggestedFareNgn);
  }
  // A long trip: ₦900 off a ₦17,000 trip is 5%; 85% leaves ₦2,550 of room.
  const long = price({ ...live, minOfferShare: 0.85 }, 40, 80);
  assert.ok(long.suggestedFareNgn - long.minOfferNgn > 900, 'more room than the fixed ₦900 on a long trip');
  const gap = price(live, 20.2, 37);
  assert.equal(gap.minOfferNgn, Math.ceil((gap.suggestedFareNgn - 900) / 50) * 50, 'off: the suggested price less ₦900');
  // A rider under the share is refused, at it accepted.
  const p = price({ ...live, minOfferShare: 0.85 }, 20.2, 37);
  assert.equal(config.validateRiderOffer(p.minOfferNgn - 50, p.suggestedFareNgn).valid, false);
  assert.equal(config.validateRiderOffer(p.minOfferNgn, p.suggestedFareNgn).valid, true);
});

test('all together, in order: inDrive ± offset, then under Linc, then the outer cap, then the minimum', () => {
  const settings = { ...live, indriveGuideOn: true, indriveOffsetNgn: 100, lincBelowPercent: 3, outerCapNgn: 17000, minOfferShare: 0.85 };
  for (const [km, min, places] of [[5, 14, {}], [20.2, 37, {}], [45, 95, { origin: area('ikorodu'), destination: YABA }]]) {
    const p = price(settings, km, min, places);
    const linc = price(live, km, min, places).lincNgn;
    assert.ok(p.suggestedFareNgn <= Math.floor(linc * 0.97 / 50) * 50, `${km} km under Linc`);
    if (places.origin) assert.ok(p.suggestedFareNgn <= 17000);
    assert.equal(p.minOfferNgn, byShare(p.suggestedFareNgn, 0.85));
  }
});
