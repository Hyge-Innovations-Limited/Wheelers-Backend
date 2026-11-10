// The lowest any ride costs is ₦2,600 (was ₦3,300, which pinned every trip under ~4.5 km to one price), and the
// rider's lowest offer is 10% under what the rule gave before, never under ₦2,600 (Timi, 10 Nov 2026).
//
//   node scripts/run-with-env.cjs node --test test/pricing-minimum.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

for (const k of ['PRICING_MIN_FARE_NGN', 'PRICING_MIN_OFFER_CUT_PERCENT', 'PRICING_RECOMMENDED_CUT_PERCENT']) delete process.env[k];
const config = require('@wheleers/config');

const live = {
  marketFloorOn: true, liftCap: 1, extraNgn: 1400, minOfferGapNgn: 900, marginPercent: 3, marketHigh: 1.17, hourCurveOn: false,
  quiet: { baseNgn: 500, perKmNgn: 301, perMinuteNgn: 28 },
  lincOn: true, linc: { baseNgn: 571, perKmNgn: 200, perMinuteNgn: 119 }, lincBonusPercent: 10, lincBonusCapNgn: 1000, lincMaxAbovePercent: 12,
  lincAbovePercent: -3.5, lincBelowPercent: 2, outerCapNgn: 17000, minOfferShare: 0.85,
};
const noon = '2026-11-10T12:00:00.000Z';

/** The same trip priced in another process with the old floor and minimum (₦3,300, no 10%). */
function before(km, minutes) {
  const script = `const c=require('@wheleers/config');c.setPricingSettings(${JSON.stringify(live)});
    const p=c.calculateSuggestedFare(${km},{durationSeconds:${minutes * 60},at:new Date('${noon}'),trafficRatio:1});
    process.stdout.write(JSON.stringify(p));`;
  const env = { ...process.env, PRICING_MIN_FARE_NGN: '3300', PRICING_MIN_OFFER_CUT_PERCENT: '0' };
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { env, cwd: path.join(__dirname, '..') }).toString());
}
const now = (km, minutes) => {
  config.setPricingSettings(live);
  return config.calculateSuggestedFare(km, { durationSeconds: minutes * 60, at: new Date(noon), trafficRatio: 1 });
};
test.after(() => config.setPricingSettings({}));

test('the lowest any ride costs is ₦2,600; short trips are no longer all ₦3,300', () => {
  assert.equal(config.MIN_FARE_NGN, 2600);
  for (const [km, min] of [[0.8, 4], [1.2, 6], [2, 8], [3, 10]]) {
    assert.equal(before(km, min).suggestedFareNgn, 3300, `${km} km was pinned at ₦3,300`);
    assert.equal(now(km, min).suggestedFareNgn, 2600, `${km} km: the new floor`);
  }
  // Just over the floor, a trip has its own price, under the old ₦3,300.
  const four = now(4, 13).suggestedFareNgn;
  assert.ok(four > 2600 && four < 3300, `4 km: ${four}`);
});

test('longer trips: the recommended price does not change', () => {
  for (const [km, min] of [[6.1, 18], [20.2, 37], [30, 54]]) {
    assert.equal(now(km, min).suggestedFareNgn, before(km, min).suggestedFareNgn, `${km} km`);
  }
});

test('the rider\'s lowest offer: 10% under the old rule\'s figure, never under ₦2,600', () => {
  const up50 = (n) => Math.ceil(n / 50) * 50;
  for (const [km, min] of [[6.1, 18], [20.2, 37], [30, 54]]) {
    const old = before(km, min).minOfferNgn;
    const p = now(km, min);
    assert.equal(p.minOfferNgn, Math.max(2600, up50(old * 0.9)), `${km} km: was ${old}`);
    assert.ok(p.minOfferNgn <= p.suggestedFareNgn);
    // The server holds riders to the same number the quote showed.
    assert.equal(config.validateRiderOffer(p.minOfferNgn, p.suggestedFareNgn).valid, true);
    assert.equal(config.validateRiderOffer(p.minOfferNgn - 50, p.suggestedFareNgn).valid, false);
  }
  for (const [km, min] of [[0.8, 4], [2, 8]]) assert.equal(now(km, min).minOfferNgn, 2600, `${km} km: never under the floor`);
  const why = config.validateRiderOffer(2000, 2600);
  assert.equal(why.valid, false);
  assert.match(why.reason, /2600/, 'the message names the new floor');
});
