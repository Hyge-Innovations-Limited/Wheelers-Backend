// The recommended price is 6% under what the pricing rules give (Timi, 9 Nov: ₦17,000 → ₦16,000), on every
// trip and at every surge; the rider's minimum and the drivers' top bid stay where they were.
//
//   node scripts/run-with-env.cjs node --test test/pricing-recommended-cut.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

delete process.env.PRICING_RECOMMENDED_CUT_PERCENT;
const config = require('@wheleers/config');

const live = {
  marketFloorOn: true, liftCap: 1, extraNgn: 1400, minOfferGapNgn: 900, marginPercent: 3, marketHigh: 1.17, hourCurveOn: false,
  quiet: { baseNgn: 500, perKmNgn: 301, perMinuteNgn: 28 },
  periodPremiums: { morning: { minNgn: 0, maxNgn: 500 }, afternoon: { minNgn: 0, maxNgn: 500 }, evening: { minNgn: 0, maxNgn: 500 }, night: { minNgn: 0, maxNgn: 500 } },
  lincOn: true, linc: { baseNgn: 571, perKmNgn: 200, perMinuteNgn: 119 }, lincBonusPercent: 10, lincBonusCapNgn: 1000, lincMaxAbovePercent: 12,
  lincAbovePercent: -3.5, lincBelowPercent: 2, outerCapNgn: 17000, minOfferShare: 0.85,
};
const monday = '2026-10-26T12:00:00.000Z';
const area = (key) => { const a = config.PRICING_AREAS.find((x) => x.key === key); return { lat: a.center[0], lng: a.center[1] }; };
const YABA = { lat: 6.5095, lng: 3.3711 };
const trips = [
  ['outer area, at the ₦17,000 cap', 45, 95, { origin: area('alimosho'), destination: YABA }],
  ['across town', 20.2, 37, {}],
  ['short', 5, 14, {}],
];

/** The same trip priced in another process, with or without the cut. */
function priceIn(cutPercent, settings, km, minutes, places, extra = {}) {
  const script = `
    const c = require('@wheleers/config');
    c.setPricingSettings(${JSON.stringify(settings)});
    const p = c.calculateSuggestedFare(${km}, { durationSeconds: ${minutes * 60}, at: new Date('${monday}'), trafficRatio: 1, ...${JSON.stringify({ ...places, ...extra })} });
    process.stdout.write(JSON.stringify(p));`;
  const env = { ...process.env };
  if (cutPercent === null) delete env.PRICING_RECOMMENDED_CUT_PERCENT; else env.PRICING_RECOMMENDED_CUT_PERCENT = String(cutPercent);
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { env, cwd: path.join(__dirname, '..') }).toString());
}
const up50 = (n) => Math.ceil(n / 50) * 50;
// The server's own checks run here with the same settings the quotes were made with.
config.setPricingSettings(live);
test.after(() => config.setPricingSettings({}));

test('6% under the rules\' price on every trip; with nothing set it is on (no server change)', () => {
  assert.equal(config.RECOMMENDED_CUT_PERCENT, 6);
  for (const [name, km, minutes, places] of trips) {
    const before = priceIn(0, live, km, minutes, places);
    const now = priceIn(null, live, km, minutes, places);
    assert.equal(now.suggestedFareNgn, Math.max(config.MIN_FARE_NGN, up50(before.suggestedFareNgn * 0.94)), name);
  }
  // The trip Timi saw: the outer cap's ₦17,000 now shows ₦16,000.
  const [, km, minutes, places] = trips[0];
  assert.equal(priceIn(0, live, km, minutes, places).suggestedFareNgn, 17_000);
  assert.equal(priceIn(null, live, km, minutes, places).suggestedFareNgn, 16_000);
});

test('the minimum and the drivers\' top bid stay where they were (within one ₦50 step)', () => {
  for (const [name, km, minutes, places] of trips) {
    const before = priceIn(0, live, km, minutes, places);
    const now = priceIn(null, live, km, minutes, places);
    assert.ok(Math.abs(now.minOfferNgn - before.minOfferNgn) <= 50, `${name}: min ${before.minOfferNgn} → ${now.minOfferNgn}`);
    assert.ok(Math.abs(now.maxOfferNgn - before.maxOfferNgn) <= 50, `${name}: top bid ${before.maxOfferNgn} → ${now.maxOfferNgn}`);
    assert.ok(now.minOfferNgn <= now.suggestedFareNgn, `${name}: the minimum is never above the recommended price`);
    // What the rider is held to on the server agrees with what the quote showed.
    assert.equal(config.validateRiderOffer(now.minOfferNgn, now.suggestedFareNgn).valid, true, name);
    assert.equal(config.validateRiderOffer(now.minOfferNgn - 50, now.suggestedFareNgn).valid, false, name);
  }
});

test('it moves with the market: a surge or rain price is cut by the same 6%', () => {
  const [, km, minutes] = trips[1];
  for (const extra of [{ surgeFactor: 1.15 }, { rain: 'heavy' }]) {
    const before = priceIn(0, { ...live, surgeOn: true, rainOn: true }, km, minutes, {}, extra);
    const now = priceIn(null, { ...live, surgeOn: true, rainOn: true }, km, minutes, {}, extra);
    assert.equal(now.suggestedFareNgn, up50(before.suggestedFareNgn * 0.94), JSON.stringify(extra));
  }
});
