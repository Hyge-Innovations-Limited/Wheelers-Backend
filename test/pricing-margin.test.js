/**
 * Staying ahead of a moving market: a margin that is a share of the other
 * app's fare, added with the flat extra (so it grows as the fare grows), and
 * the other app read at its high end, learned from its real prices, so a trip
 * is not priced under it whenever it sits high. The learning test runs
 * against the local Postgres.
 *
 *   node --env-file=.env --test --test-force-exit test/pricing-margin.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const config = require('@wheleers/config');
const { prisma, pricingClient } = require('@wheleers/db');
const { curveUpdate } = require('../apps/api-gateway/dist/pricing/hour-curve-job.js');

const range = { minNgn: 0, maxNgn: 500 };
// The live setup on 24 Oct 2026.
const live = {
  marketFloorOn: true, liftCap: 1, extraNgn: 1400, minOfferGapNgn: 900, hourCurveOn: false,
  quiet: { baseNgn: 500, perKmNgn: 301, perMinuteNgn: 28 },
  periodPremiums: { morning: range, afternoon: range, evening: range, night: range },
};
// Saturday 24 Oct, 13:00 Lagos.
const at = new Date(Date.UTC(2026, 9, 24, 12));
const price = (km, minutes, extra = {}) => config.calculateSuggestedFare(km, { durationSeconds: minutes * 60, at, trafficRatio: 1, ...extra });

test.after(() => { config.setPricingSettings({}); return prisma.$disconnect(); });

test('the margin is added with the flat extra, and grows with the fare', () => {
  config.setPricingSettings(live);
  const flat = price(20.2, 37);
  assert.deepEqual([flat.suggestedFareNgn, flat.minOfferNgn, flat.marginFactor], [9150, 8250, 1], 'today: the flat ₦1,400 alone');
  config.setPricingSettings({ ...live, marginPercent: 3 });
  const three = price(20.2, 37);
  assert.deepEqual([three.suggestedFareNgn, three.minOfferNgn], [9350, 8450], '3% on top of the flat extra (Linc showed ₦9,350 and ₦8,415)');
  assert.equal(three.marginFactor, 1.03);
  // A longer trip: the same 3% is more naira.
  const longFlat = (config.setPricingSettings(live), price(40, 70).suggestedFareNgn);
  const longThree = (config.setPricingSettings({ ...live, marginPercent: 3 }), price(40, 70).suggestedFareNgn);
  assert.ok(longThree - longFlat > three.suggestedFareNgn - flat.suggestedFareNgn, `the margin grows with the fare (${longThree - longFlat} > ${three.suggestedFareNgn - flat.suggestedFareNgn})`);
  // In heavy traffic the fare rises, and the margin with it.
  const jam = price(20.2, 60);
  assert.ok(jam.suggestedFareNgn > three.suggestedFareNgn);
  assert.equal(config.normalizePricingSettings({ marginPercent: 400 }).marginPercent, 50, 'never more than 50%');
  assert.equal(config.normalizePricingSettings({ marginPercent: -5 }).marginPercent, 0);
});

test('the other app\'s high end: the top tenth of how far its prices sat from our guess, from five of them, between 1 and 1.3', () => {
  assert.equal(config.marketHighFrom([1.155, 0.985, 1.077, 1.02]), null, 'four are not enough');
  assert.equal(config.marketHighFrom([1.155, 0.985, 1.077, 0.998, 1.02]), 1.16);
  const many = Array.from({ length: 20 }, (_, i) => 0.95 + i * 0.01); // 0.95 … 1.14
  assert.equal(config.marketHighFrom(many), 1.12, 'the 18th of 20 (0.95 + 0.17)');
  assert.equal(config.marketHighFrom([0.8, 0.85, 0.9, 0.9, 0.95]), 1, 'never under our guess');
  assert.equal(config.marketHighFrom([1.5, 1.6, 1.7, 1.8, 1.9]), 1.3, 'never past 1.3');
  assert.equal(config.marketHighFrom([9, 9, 9, 9, 9, 1, 1]), null, 'typos are left out');
});

test('never under the other app\'s high end: a floor, not a lift; it moves at most 15% a night', () => {
  // With the margin and the extra already above it, nothing changes.
  config.setPricingSettings({ ...live, marginPercent: 3, marketHigh: 1.16 });
  assert.equal(price(20.2, 37).suggestedFareNgn, 9350, 'still ₦9,350: already over ₦8,850 (1.16 × the guess)');
  // With no extra and no margin, it holds the price up to the high end.
  config.setPricingSettings({ ...live, extraNgn: 0, marketHigh: 1.16 });
  const bare = price(20.2, 37);
  assert.equal(bare.highEndNgn, 8850);
  assert.equal(bare.suggestedFareNgn, 8850, 'raised to the high end, over the highest inDrive price seen (₦8,800)');
  assert.ok(bare.marketFareNgn < 7700, 'the guess itself is unchanged (the curve learns from it)');
  config.setPricingSettings(live);
  const s = config.getPricingSettings();
  const fit = { curve: { weekday: Array(24).fill(1), weekend: Array(24).fill(1) }, rainLift: null, marketHigh: 1.3 };
  assert.equal(curveUpdate(s, fit, at).marketHigh, 1.15, 'from 1, at most 15% in one night');
  assert.equal(curveUpdate(s, { ...fit, marketHigh: null }, at).marketHigh, undefined, 'too few prices: left where it is');
});

test('the nightly learning reads the high end from the other app\'s real prices against our guess', async () => {
  const now = new Date();
  const ids = [];
  // Five recent prices for one 20.2 km, 37 min trip: our guess for it is ₦7,616.
  for (const [i, p] of [8800, 7500, 8200, 7700, 7900].entries()) {
    const id = randomUUID();
    ids.push(id);
    await prisma.marketSample.create({ data: { id, km: 20.2, minutes: 37, priceNgn: p, rush: false, takenAt: new Date(now.getTime() - (i + 1) * 3_600_000), addedBy: 'test' } });
  }
  try {
    const settings = config.normalizePricingSettings({ ...live, hourCurveOn: true });
    const fit = await pricingClient.learnHourCurve(settings, now);
    assert.ok(fit.marketHighPrices >= 5);
    assert.ok(fit.marketHigh !== null && fit.marketHigh >= 1.05, `the high end sits over the guess (${fit.marketHigh})`);
  } finally {
    await prisma.marketSample.deleteMany({ where: { id: { in: ids } } });
  }
});
