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
  const max = config.PERIOD_PREMIUM_MAX_NGN;
  assert.deepEqual(s.periodPremiums, { morning: { minNgn: max, maxNgn: max }, afternoon: { minNgn: 0, maxNgn: 0 } });
  const r = config.setPricingSettings({ periodPremiums: { night: { minNgn: 3000, maxNgn: 1500 } } });
  assert.deepEqual(r.periodPremiums.night, { minNgn: 1500, maxNgn: 3000 }, 'a range given backwards is put the right way round');
  config.setPricingSettings({});
});

const night = { marketFloorOn: true, premiumNgn: 3000, trafficOn: true, demandOn: true, periodPremiums: { night: { minNgn: 1500, maxNgn: 3000 } } };
const trip = (extra = {}) => ({ durationSeconds: 1800, at: lagos(23), ...extra });

test('a range: the trip\'s conditions place it — heavier traffic is never cheaper, a busy area dearer, always inside', () => {
  config.setPricingSettings(night);
  const key = '6.50000,3.37000>6.44000,3.47000@1';
  let last = 0;
  for (const ratio of [1, 1.2, 1.4, 1.6, 1.8, 2.5]) {
    const p = config.premiumFor(trip({ trafficRatio: ratio, trialKey: key }));
    assert.ok(p.premiumNgn >= 1500 && p.premiumNgn <= 3000, `${p.premiumNgn} inside`);
    assert.ok(p.premiumNgn >= last, `traffic ${ratio}: ${p.premiumNgn} is not below ${last}`);
    assert.equal(p.premiumNgn % 50, 0);
    assert.equal(p.period, 'night');
    last = p.premiumNgn;
  }
  const quiet = config.premiumFor(trip({ trafficRatio: 1 })).premiumNgn;
  const busy = config.premiumFor(trip({ trafficRatio: 1, demandFactor: 1.5 })).premiumNgn;
  assert.ok(busy > quiet, `busy area ${busy} > quiet ${quiet}`);
  assert.ok(config.premiumFor(trip({ trafficRatio: 1.8, demandFactor: 1.8 }), 1.65).premiumNgn >= 2800, 'heavy traffic, busy and outer on a weekday: near the top');
  assert.equal(config.premiumFor({ durationSeconds: 1800, at: new Date(Date.UTC(2026, 9, 24, 22)), trafficRatio: 1.8, demandFactor: 1.8 }, 1.65).premiumNgn, 3000, 'and on a Saturday night: the top');
  config.setPricingSettings({});
});

test('a range: the same trip in the half hour gets the same amount; different trips are spread a little', () => {
  config.setPricingSettings(night);
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    const key = `6.5${i},3.3${i}>6.4${i},3.4${i}@7`;
    const p = config.premiumFor(trip({ trafficRatio: 1.3, trialKey: key })).premiumNgn;
    assert.equal(config.premiumFor(trip({ trafficRatio: 1.3, trialKey: key })).premiumNgn, p);
    seen.add(p);
  }
  assert.ok(seen.size > 2, 'not every trip on one number');
  // The fare carries the premium it was given.
  const fare = config.calculateSuggestedFare(10, trip({ trafficRatio: 1.3, trialKey: 'a>b@1' }));
  assert.equal(fare.premium.premiumNgn, config.premiumFor(trip({ trafficRatio: 1.3, trialKey: 'a>b@1' })).premiumNgn);
  assert.equal(fare.premium.period, 'night');
  config.setPricingSettings({});
});

test('a fixed amount or no setting for the part of the day: as before, no position', () => {
  config.setPricingSettings({ marketFloorOn: true, premiumNgn: 3000, periodPremiums: { afternoon: 4000 } });
  assert.deepEqual(config.premiumFor(trip({ at: lagos(14), trafficRatio: 1.8 })), { premiumNgn: 4000, period: 'afternoon', position: null });
  assert.deepEqual(config.premiumFor(trip({ at: lagos(18) })), { premiumNgn: 3000, period: 'evening', position: null });
  config.setPricingSettings({});
});

test('lift 1: traffic, a busy area and our own rate never take a price past the other app + the top of the premium', () => {
  const range = { minNgn: 500, maxNgn: 2000 };
  const settings = { marketFloorOn: true, trafficOn: true, demandOn: true, periodPremiums: { morning: range, afternoon: range, evening: range, night: range } };
  let worst = 0;
  config.setPricingSettings({ ...settings, liftCap: 1 });
  for (const km of [1, 5, 16.7, 25, 40]) for (const minPerKm of [1.2, 3]) for (const trafficRatio of [1, 1.8, 2.5]) for (const demandFactor of [1, 1.8]) for (const hour of [8, 14, 18, 23]) {
    const fare = config.calculateSuggestedFare(km, { durationSeconds: km * minPerKm * 60, trafficRatio, demandFactor, at: lagos(hour), trialKey: `t${km}` });
    if (fare.suggestedFareNgn > config.MIN_FARE_NGN) worst = Math.max(worst, fare.suggestedFareNgn - fare.marketFareNgn);
  }
  assert.ok(worst <= 2000 + 50, `at most ₦2,000 over the other app, rounding aside (worst ₦${Math.round(worst)})`);
  // Above 1 the rules may lift past it again, as before.
  config.setPricingSettings({ ...settings, liftCap: 1.5 });
  const lifted = config.calculateSuggestedFare(40, { durationSeconds: 40 * 1.2 * 60, trafficRatio: 2.5, at: lagos(8) });
  assert.equal(lifted.setBy, 'rules');
  assert.ok(lifted.suggestedFareNgn - lifted.marketFareNgn > 2000);
  config.setPricingSettings({});
});
