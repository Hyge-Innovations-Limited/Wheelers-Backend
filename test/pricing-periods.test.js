/**
 * A premium for each part of the Lagos day: the floor is the other app plus
 * that part's own premium, or the general one where none is set.
 *
 *   node scripts/run-with-env.cjs node --test test/pricing-periods.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('@wheleers/config');

// A Wednesday, at an hour Lagos time (UTC+1).
const lagos = (hour) => new Date(Date.UTC(2026, 9, 21, hour - 1));
const price = (hour) => config.calculateSuggestedFare(10, { durationSeconds: 30 * 60, trafficRatio: 1, at: lagos(hour) });

test('the day splits into morning, afternoon, evening and night, Lagos time', () => {
  assert.equal(config.dayPeriodOf(lagos(5)), 'morning');
  assert.equal(config.dayPeriodOf(lagos(11)), 'morning');
  assert.equal(config.dayPeriodOf(lagos(12)), 'afternoon');
  assert.equal(config.dayPeriodOf(lagos(16)), 'evening');
  assert.equal(config.dayPeriodOf(lagos(21)), 'night');
  assert.equal(config.dayPeriodOf(lagos(2)), 'night');
});

test('a part of the day with its own premium uses it; the rest keep the general one', () => {
  config.setPricingSettings({ marketFloorOn: true, premiumNgn: 3000, periodPremiums: { evening: 5000, night: 4000 } });
  for (const [hour, premium] of [[8, 3000], [14, 3000], [18, 5000], [23, 4000]]) {
    const fare = price(hour);
    assert.equal(config.premiumAt(lagos(hour)), premium);
    assert.equal(fare.suggestedFareNgn, Math.max(config.MIN_FARE_NGN, Math.ceil((fare.marketFareNgn + premium) / 50) * 50), `at ${hour}:00`);
  }
});

test('nothing set by part of the day: every hour prices exactly as before', () => {
  config.setPricingSettings({ marketFloorOn: true, premiumNgn: 3000 });
  const before = [8, 14, 18, 23].map((h) => price(h).suggestedFareNgn);
  config.setPricingSettings({ marketFloorOn: true, premiumNgn: 3000, periodPremiums: {} });
  assert.deepEqual([8, 14, 18, 23].map((h) => price(h).suggestedFareNgn), before);
});

test('saved amounts are kept in range, and nonsense is dropped', () => {
  const s = config.setPricingSettings({ periodPremiums: { morning: 99999, afternoon: -5, evening: 'x', night: null, lunch: 100 } });
  assert.deepEqual(s.periodPremiums, { morning: config.PERIOD_PREMIUM_MAX_NGN, afternoon: 0 });
  config.setPricingSettings({});
});
