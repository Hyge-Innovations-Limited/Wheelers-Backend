/**
 * The ceiling: no price more than ceilingAboveNgn over the higher of Linc and
 * inDrive for the trip; and the area lift and inDrive's high end no longer
 * multiply. 30 km from Ikorodu at night was ₦17,850 (4 Nov) and 33.1 km
 * ₦20,800 (1 Nov) where the apps asked ₦13–15k.
 *
 *   npm run build && node --test test/pricing-ceiling.test.js
 */
// These tests check the pricing rules themselves, before the recommended cut (pricing.ts RECOMMENDED_CUT_PERCENT).
process.env.PRICING_RECOMMENDED_CUT_PERCENT = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('@wheleers/config');

const IKORODU = { lat: 6.6194, lng: 3.5105 };
const OPEBI = { lat: 6.5953, lng: 3.3599 };
const YABA = { lat: 6.5095, lng: 3.3711 };
const LEKKI = { lat: 6.4478, lng: 3.4723 };
const flat = (v) => ({ weekday: Array(24).fill(v), weekend: Array(24).fill(v) });
// The server on 4 Nov (npm run pricing): the curve said ×1.15 at 03:29.
const live = { ...config.LIVE_PRICING_BASELINE, hourCurve: flat(1.15) };
const nightOf4Nov = new Date('2026-11-04T02:29:00Z');

function price(settings, km, minutes, ends, at = nightOf4Nov) {
  config.setPricingSettings(settings);
  return config.calculateSuggestedFare(km, { durationSeconds: minutes * 60, trafficRatio: 1, at, ...ends });
}

test.after(() => config.setPricingSettings({}));

test('30 km from Ikorodu at night: ₦15,250, not ₦17,850; once Linc\'s night is learned the ceiling holds it at ₦13,700', () => {
  const now = price(live, 30, 54, { origin: IKORODU, destination: OPEBI });
  assert.equal(Math.round(now.marketFareNgn), 15238, 'the other app, as the server showed it');
  assert.equal(now.highEndNgn, 15250, 'the area lift and the high end: the larger, not both (×1.2, not ×1.2×1.17)');
  assert.equal(now.suggestedFareNgn, 15250);
  assert.equal(now.ceilingNgn, 15350, 'Linc\'s figures refitted 6 Nov: the ceiling over them is lower');

  // Two night prices read off Linc (₦12,950 for this very trip): its night lift is learned, under 1.15.
  const lincSamples = [...config.LINC_SAMPLES_SEEN, { km: 20, minutes: 35, priceNgn: 8200, at: '2026-11-03T22:30:00Z' }];
  const learned = price({ ...live, lincSamples }, 30, 54, { origin: IKORODU, destination: OPEBI });
  assert.equal(learned.setBy, 'ceiling');
  assert.equal(learned.suggestedFareNgn, 13700);
});

test('33.1 km from Ikorodu in the evening (1 Nov): ₦15,850, not ₦20,800 (₦16,550 while one Sunday-evening Alagbado trip, priced twice, counted as two and lifted Sunday evenings)', () => {
  const sunday = new Date('2026-11-01T19:11:00Z');
  const fare = price({ ...live, hourCurve: flat(1.2161) }, 33.1, 61, { origin: IKORODU, destination: OPEBI }, sunday);
  assert.equal(fare.setBy, 'ceiling');
  assert.equal(fare.suggestedFareNgn, 15850);
});

test('a slow city trip Linc prices is left alone: the ceiling sits above it', () => {
  const fare = price(live, 12.2, 36, { origin: YABA, destination: LEKKI });
  assert.equal(fare.setBy, 'linc');
  assert.ok(fare.ceilingNgn > fare.suggestedFareNgn);
});

test('every trip: never over the ceiling, never under inDrive for the trip; off, nothing is ever set by it', () => {
  const places = [[YABA, LEKKI], [IKORODU, OPEBI], [OPEBI, IKORODU], [YABA, OPEBI]];
  const hours = [8, 14, 18, 23, 3];
  for (const ceilingAboveNgn of [0, 500, 1000, null]) {
    for (const km of [3, 9.5, 20, 30, 45]) for (const minPerKm of [1.2, 2, 3.5]) for (const [origin, destination] of places) for (const hour of hours) {
      const at = new Date(Date.UTC(2026, 10, 4, (hour + 23) % 24, 10));
      const fare = price({ ...live, ceilingAboveNgn }, km, km * minPerKm, { origin, destination }, at);
      if (ceilingAboveNgn === null) {
        assert.equal(fare.ceilingNgn, null);
        assert.notEqual(fare.setBy, 'ceiling');
        continue;
      }
      assert.ok(fare.suggestedFareNgn <= fare.ceilingNgn, `${km} km ${hour}:00 ₦${fare.suggestedFareNgn} over ₦${fare.ceilingNgn}`);
      const inDrive = fare.marketFareNgn / fare.areaFactor;
      assert.ok(fare.suggestedFareNgn >= Math.min(fare.ceilingNgn, inDrive), `${km} km ${hour}:00 under inDrive`);
    }
  }
});

test('the setting: ₦1,000 unless set, null is off, whole ₦50s; a server with nothing saved starts at the live settings', () => {
  assert.equal(config.normalizePricingSettings({}).ceilingAboveNgn, 1000, 'settings saved before the ceiling get it');
  assert.equal(config.normalizePricingSettings({ ceilingAboveNgn: null }).ceilingAboveNgn, null);
  assert.equal(config.normalizePricingSettings({ ceilingAboveNgn: 1234 }).ceilingAboveNgn, 1250);
  assert.equal(config.normalizePricingSettings({ ceilingAboveNgn: 99999 }).ceilingAboveNgn, 10000);

  const fresh = config.normalizePricingSettings(config.LIVE_PRICING_BASELINE);
  assert.equal(fresh.lincOn, true);
  assert.equal(fresh.marketFloorOn, true);
  assert.equal(fresh.extraNgn, 1400);
  assert.equal(fresh.marginPercent, 3);
  assert.equal(fresh.marketHigh, 1.17);
  assert.equal(fresh.minOfferGapNgn, 900);
  assert.equal(fresh.ceilingAboveNgn, 1000);
  assert.deepEqual(fresh.areas.ikorodu, { pickup: 1.2, dropoff: 1.15 });
  assert.deepEqual(fresh.areas.alimosho, { pickup: 1.15, dropoff: 1.2 });
  assert.deepEqual(fresh.quiet, { baseNgn: 500, perKmNgn: 301, perMinuteNgn: 28 });
  assert.ok(fresh.lincSamples.some((s) => s.km === 30 && s.priceNgn === 12950), 'the Ikorodu night price is built in');
});
