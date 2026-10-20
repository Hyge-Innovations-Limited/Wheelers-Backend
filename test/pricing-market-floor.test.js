// The suggested fare is the highest of three numbers: the market floor (what
// the other app charges for the trip, + the premium), the rules (the base
// rate lifted by traffic and a busy area) and, once an owner switches it on,
// the model. Nothing is ever suggested under the floor, a rider can bargain
// away no more than the premium, and with nothing saved pricing is the plain
// rate per km. Settings live in the database and are edited by owners only.
// Against the local Postgres and Redis.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/pricing-market-floor.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { prisma, pricingClient } = require('@wheleers/db');
const config = require('../packages/config/dist/index.js');
const { calculateSuggestedFare, setPricingSettings, DEFAULT_PRICING_SETTINGS, validateRiderOffer, marketFareNgn, isRushHour, calculateRideFees, getPricingMlModel, setPricingMlModel, scoreForest } = config;
const { measureBusyness, demandFactorAt } = require('../apps/api-gateway/dist/pricing/busyness.js');

const QUIET = new Date('2026-10-14T12:00:00Z'); // Wednesday 13:00 in Lagos
const RUSH = new Date('2026-10-14T17:00:00Z');  // Wednesday 18:00 in Lagos
// Round figures for the other app, so the sums below can be done by hand.
// minOfferGapNgn 0: these tests are about the older minimum (a tenth off, no more than the premium).
const FLOOR_ON = { ...DEFAULT_PRICING_SETTINGS, minOfferGapNgn: 0, marketFloorOn: true, trafficOn: true, demandOn: true, quiet: { baseNgn: 500, perKmNgn: 290, perMinuteNgn: 50 }, rush: { baseNgn: 600, perKmNgn: 350, perMinuteNgn: 60 } };
const made = { admins: [], rides: [], users: [] };
let savedBefore;

test.before(async () => {
  savedBefore = await prisma.pricingSettings.findUnique({ where: { id: 'current' } });
});

test.afterEach(() => { setPricingSettings(DEFAULT_PRICING_SETTINGS); setPricingMlModel(undefined); });

test('with nothing saved, pricing is the plain rate per km', () => {
  setPricingSettings(null);
  const p = calculateSuggestedFare(16, { durationSeconds: 41 * 60, at: QUIET, trafficRatio: 2, demandFactor: 1.5 });
  assert.equal(p.suggestedFareNgn, 6800, '375 × 16 + 7.5% + 350');
  assert.equal(p.setBy, 'rules');
  assert.equal(p.floorFareNgn, null);
});

test('16 km, 41 minutes, a quiet hour: the other app is ₦7,190, so the fare is ₦7,500 and no offer goes under ₦7,200', () => {
  setPricingSettings(FLOOR_ON);
  assert.equal(marketFareNgn(16, 41 * 60, QUIET), 7190, '500 + 290 × 16 + 50 × 41');
  const p = calculateSuggestedFare(16, { durationSeconds: 41 * 60, at: QUIET });
  assert.equal(p.suggestedFareNgn, 7500, '7,190 + 300, rounded up to ₦50');
  assert.equal(p.setBy, 'floor');
  assert.equal(p.rulesFareNgn, 6800, 'the plain rate would have been cheaper than the other app');
  assert.equal(p.minOfferNgn, 7200, 'a rider can bargain away the premium, no more');
  assert.equal(validateRiderOffer(7200, p.suggestedFareNgn).valid, true);
  assert.equal(validateRiderOffer(7150, p.suggestedFareNgn).valid, false);
  assert.ok(p.minOfferNgn >= p.marketFareNgn, 'never under the other app');
  assert.equal(p.ratePerKmNgn, 416, 'what drivers see as the recommended rate');
});

test('rush hour uses the rush figures, on the live trip time', () => {
  setPricingSettings(FLOOR_ON);
  assert.equal(isRushHour(RUSH), true);
  assert.equal(isRushHour(QUIET), false);
  assert.equal(isRushHour(new Date('2026-10-17T17:00:00Z')), false, 'a Saturday is not rush hour');
  const p = calculateSuggestedFare(16, { durationSeconds: 72 * 60, at: RUSH, trafficRatio: 2.4 });
  assert.equal(p.marketFareNgn, 10520, '600 + 350 × 16 + 60 × 72');
  assert.equal(p.suggestedFareNgn, 10850);
});

test('the rules may lift the fare above the floor, never pull it under', () => {
  setPricingSettings(FLOOR_ON);
  const lifted = calculateSuggestedFare(16, { durationSeconds: 41 * 60, at: QUIET, trafficRatio: 1.3 });
  assert.equal(lifted.setBy, 'rules');
  assert.equal(lifted.suggestedFareNgn, 7600);
  assert.ok(lifted.suggestedFareNgn > lifted.floorFareNgn);
  const clear = calculateSuggestedFare(16, { durationSeconds: 41 * 60, at: QUIET, trafficRatio: 1 });
  assert.equal(clear.suggestedFareNgn, clear.floorFareNgn, 'a clear road: the floor stands');
});

test('however far the other app is undercut, our own rate per km still stands', () => {
  setPricingSettings({ ...FLOOR_ON, quiet: { baseNgn: 0, perKmNgn: 100, perMinuteNgn: 0 } });
  const p = calculateSuggestedFare(16, { durationSeconds: 41 * 60, at: QUIET });
  assert.equal(p.suggestedFareNgn, 6800);
  assert.equal(p.setBy, 'rules');
});

test('in a build with no trained model, the small fitted one only watches until it is switched on; then it may lift the fare, up to the cap', () => {
  setPricingMlModel(null);
  const model = { trainedAt: '2026-10-11T00:00:00Z', rows: 500, intercept: Math.log(520), coef: { lnKm: 0, minPerKm: 0, lnDemand: 0, rush: 0, night: 0, weekend: 0 } };
  setPricingSettings({ ...FLOOR_ON, model, modelOn: false });
  const watching = calculateSuggestedFare(16, { durationSeconds: 41 * 60, at: QUIET });
  assert.equal(watching.modelFareNgn, 9300, '520 × 16 + 7.5% + 350, rounded up: recorded');
  assert.equal(watching.suggestedFareNgn, 7500, 'but the price is still the floor');
  setPricingSettings({ ...FLOOR_ON, model, modelOn: true });
  const on = calculateSuggestedFare(16, { durationSeconds: 41 * 60, at: QUIET });
  assert.equal(on.suggestedFareNgn, 9300);
  assert.equal(on.setBy, 'model');
  setPricingSettings({ ...FLOOR_ON, model: { ...model, intercept: Math.log(5000) }, modelOn: true });
  const wild = calculateSuggestedFare(16, { durationSeconds: 41 * 60, at: QUIET });
  assert.equal(wild.suggestedFareNgn, 11250, 'a wild model is held at 1.5 × the floor');
  setPricingSettings({ ...FLOOR_ON, model: { ...model, intercept: Math.log(200) }, modelOn: true });
  assert.equal(calculateSuggestedFare(16, { durationSeconds: 41 * 60, at: QUIET }).suggestedFareNgn, 7500, 'a low model cannot pull the fare under the floor');
});

test('the books still add up at a floor fare, and the service charge is ₦350', () => {
  const f = calculateRideFees(7500);
  assert.equal(f.bookingFeeNgn, 350);
  assert.equal(Math.round((f.driverPayoutNgn + f.bookingFeeNgn + f.commissionNgn + f.vatNgn + f.stateLevyNgn) * 100), 750000);
  assert.equal(f.driverPayoutNgn, 5956.04);
});

test('bad settings are made safe: numbers in range, a missing model stays off', () => {
  const s = setPricingSettings({ marketFloorOn: 'yes', premiumNgn: -50, quiet: { baseNgn: 'x', perKmNgn: 1e9 }, liftCap: 99, model: { intercept: 'no' }, modelOn: true });
  assert.equal(s.marketFloorOn, false, 'only true switches it on');
  assert.equal(s.premiumNgn, 0);
  assert.equal(s.quiet.baseNgn, 500);
  assert.equal(s.quiet.perKmNgn, 5000);
  assert.equal(s.liftCap, 3);
  assert.equal(s.model, null);
  assert.equal(calculateSuggestedFare(10).suggestedFareNgn, 4400, 'and pricing still works');
});

test('a seeded model says what was assumed: dearer per km on a slow road, at night and on a short trip, and fades as real trips arrive', async () => {
  const { seedTrips, fitLinear } = await import('../scripts/train-pricing-model.mjs');
  const made = seedTrips();
  const w = fitLinear(made.X, made.y);
  const rate = (km, minPerKm, night = 0) => Math.exp(w[0] + w[1] * Math.log(km) + w[2] * minPerKm + w[5] * night);
  assert.ok(rate(16, 1.5) > 340 && rate(16, 1.5) < 420, `a clear road is near the base rate (${Math.round(rate(16, 1.5))})`);
  assert.ok(rate(16, 4.5) > rate(16, 2.6) && rate(16, 2.6) > rate(16, 1.5), 'slower is dearer');
  assert.ok(rate(5, 2.6) > rate(16, 2.6), 'a short trip is dearer per km');
  assert.ok(rate(16, 2.6, 1) > rate(16, 2.6), 'so is the night');

  // 300 real trips all agreed at exactly N500 a km: the made-up ones count for nothing beside them.
  const realX = Array.from({ length: 300 }, (_, i) => [1, Math.log(5 + (i % 20)), 1.5 + (i % 7) * 0.5, 0, i % 2, 0, i % 3 === 0 ? 1 : 0]);
  const realY = realX.map(() => Math.log(500));
  const blended = fitLinear([...realX, ...made.X], [...realY, ...made.y], 1e-3, [...realX.map(() => 1), ...made.X.map(() => 0)]);
  assert.ok(Math.abs(Math.exp(blended[0] + blended[1] * Math.log(10) + blended[2] * 2.5) - 500) < 5);

  setPricingMlModel(null);
  const s = setPricingSettings({ ...FLOOR_ON, model: { trainedAt: 'x', rows: 0, seeded: true, intercept: w[0], coef: { lnKm: w[1], minPerKm: w[2], lnDemand: w[3], rush: w[4], night: w[5], weekend: w[6] } } });
  assert.equal(s.model.seeded, true, 'and the settings remember it was seeded');
  assert.equal(calculateSuggestedFare(16, { durationSeconds: 41 * 60, at: QUIET }).suggestedFareNgn, 7500, 'saved but off: prices are untouched');
});

// ── the trained model (packages/config/models/pricing-ml.json) ─────────────

// The other app's figures as the model was trained with them: the two real quotes we have.
const SAMPLED = { ...FLOOR_ON, quiet: { baseNgn: 500, perKmNgn: 268, perMinuteNgn: 50 }, rush: { baseNgn: 575, perKmNgn: 308, perMinuteNgn: 58 } };
const SUNDAY = new Date('2026-10-11T12:00:00Z');

test('the trained model is in this build and the gateway scores it exactly as the trainer did', () => {
  const ml = getPricingMlModel();
  assert.ok(ml, 'packages/config/models/pricing-ml.json is there and readable');
  assert.ok(ml.rows >= 1_000_000, `trained on ${ml.rows} quotes`);
  assert.ok(ml.checks.length >= 20);
  for (const check of ml.checks) {
    for (const name of ['requested', 'answered', 'agreed', 'paid']) {
      assert.ok(Math.abs(scoreForest(ml.models[name], check.x) - check[name]) < 1e-9, `${name} matches the trainer`);
    }
  }
});

test('the real trip (15.5 km, 23 min, a Sunday, the other app at N5,800): off, the model only watches; on, N6,650 becomes N6,000', () => {
  setPricingSettings({ ...SAMPLED, modelOn: false });
  const watching = calculateSuggestedFare(15.511, { durationSeconds: 23 * 60, at: SUNDAY, trafficRatio: 1 });
  assert.equal(watching.suggestedFareNgn, 6650, 'the price shown is today\'s');
  assert.equal(watching.setBy, 'rules');
  assert.equal(watching.modelFareNgn, 6000, 'what the model would show is recorded beside it');
  assert.equal(watching.minOfferNgn, 6350, 'and a rider may still bargain the whole premium away');

  setPricingSettings({ ...SAMPLED, modelOn: true });
  const on = calculateSuggestedFare(15.511, { durationSeconds: 23 * 60, at: SUNDAY, trafficRatio: 1 });
  assert.equal(on.suggestedFareNgn, 6000, 'N650 less');
  assert.equal(on.setBy, 'model');
  assert.ok(on.suggestedFareNgn >= Math.round(on.marketFareNgn) + 150, 'still at least N150 above the other app');
  assert.equal(on.minOfferNgn, 5850, 'a rider can bargain N150 off, no more');
  assert.ok(on.minOfferNgn >= on.marketFareNgn, 'so no offer goes under the other app');
  assert.equal(validateRiderOffer(5800, on.suggestedFareNgn).valid, false);
  assert.equal(on.ratePerKmNgn, 339, 'the rate drivers are shown follows the fare');
});

test('a cut is a few hundred naira, never one fixed amount, and always inside its limits', () => {
  const cuts = new Map();
  let seen = 0;
  for (const at of [SUNDAY, QUIET, RUSH, new Date('2026-10-14T23:30:00Z')]) {
    for (let km = 2; km <= 45; km += 1.7) {
      for (const minPerKm of [1.5, 2.2, 3.0, 4.2]) {
        const factors = { durationSeconds: km * minPerKm * 60, at, trafficRatio: Math.max(1, minPerKm / 1.6) };
        setPricingSettings({ ...SAMPLED, modelOn: false });
        const today = calculateSuggestedFare(km, factors);
        setPricingSettings({ ...SAMPLED, modelOn: true });
        const model = calculateSuggestedFare(km, factors);
        const cut = today.suggestedFareNgn - model.suggestedFareNgn;
        seen += 1;
        cuts.set(cut, (cuts.get(cut) ?? 0) + 1);
        const where = `${km.toFixed(1)} km at ${minPerKm} min/km`;
        assert.ok(cut <= 700, `${where}: never more than N700 off (${cut})`);
        assert.ok(cut <= 0.1 * today.suggestedFareNgn + 50, `${where}: never more than a tenth of the fare`);
        assert.ok(model.suggestedFareNgn >= 2500, `${where}: never under the minimum fare`);
        assert.ok(model.suggestedFareNgn % 50 === 0);
        if (cut > 0) assert.ok(model.suggestedFareNgn >= model.marketFareNgn + 150, `${where}: a cut stops N150 above the other app`);
        assert.ok(model.suggestedFareNgn <= Math.ceil((Math.max(today.floorFareNgn, 375 * km * 1.075 + 350) * 1.5) / 50) * 50 + 50, `${where}: never above the lift limit`);
        assert.ok(model.minOfferNgn >= Math.min(model.marketFareNgn, model.suggestedFareNgn), `${where}: no offer under the other app`);
      }
    }
  }
  const sizes = [...cuts.keys()].filter((c) => c > 0);
  assert.ok(sizes.length >= 8, `cuts come in many sizes (${sizes.sort((a, b) => a - b).join(', ')})`);
  const most = Math.max(...[...cuts.entries()].filter(([c]) => c > 0).map(([, n]) => n));
  assert.ok(most < 0.5 * seen, 'no single amount is taken off most trips');
});

test('owners set how far the model may go: no room means no cut, and a damaged model file never stops a quote', () => {
  setPricingSettings({ ...SAMPLED, modelOn: true, maxDiscountNgn: 0 });
  assert.equal(calculateSuggestedFare(15.511, { durationSeconds: 23 * 60, at: SUNDAY, trafficRatio: 1 }).suggestedFareNgn, 6650);
  setPricingSettings({ ...SAMPLED, modelOn: true, maxDiscountNgn: 300 });
  assert.equal(calculateSuggestedFare(15.511, { durationSeconds: 23 * 60, at: SUNDAY, trafficRatio: 1 }).suggestedFareNgn, 6350);
  setPricingSettings({ ...SAMPLED, modelOn: true, modelPremiumNgn: 500 });
  assert.equal(calculateSuggestedFare(15.511, { durationSeconds: 23 * 60, at: SUNDAY, trafficRatio: 1 }).suggestedFareNgn, 6350, 'never closer to the other app than asked');

  setPricingMlModel({ version: 1, features: ['nonsense'], models: {} });
  assert.equal(getPricingMlModel(), null);
  setPricingSettings({ ...SAMPLED, modelOn: true });
  const p = calculateSuggestedFare(15.511, { durationSeconds: 23 * 60, at: SUNDAY, trafficRatio: 1 });
  assert.equal(p.suggestedFareNgn, 6650, 'priced by the floor and the rules, as if there were no model');
  assert.equal(p.minOfferNgn, 6350);
});

test('trial prices: about one trip in ten sees another price from the same range, never above today\'s, and always the same one for the same trip', () => {
  const trip = { durationSeconds: 30 * 60, at: QUIET, trafficRatio: 1.2 };
  setPricingSettings({ ...SAMPLED, modelOn: false });
  const today = calculateSuggestedFare(15.5, trip).suggestedFareNgn;
  setPricingSettings({ ...SAMPLED, modelOn: true });
  const picked = calculateSuggestedFare(15.5, trip);
  assert.equal(picked.setBy, 'model', 'without a key for the trip there is no trial');

  let trials = 0; const seen = new Set();
  for (let i = 0; i < 3000; i++) {
    const p = calculateSuggestedFare(15.5, { ...trip, trialKey: `trip-${i}` });
    if (p.setBy !== 'trial') { assert.equal(p.suggestedFareNgn, picked.suggestedFareNgn); continue; }
    trials += 1; seen.add(p.suggestedFareNgn);
    assert.ok(p.suggestedFareNgn <= today, 'a trial never costs more than the price without the model');
    assert.ok(p.suggestedFareNgn >= p.marketFareNgn + 150, 'and never goes closer to the other app than the model may');
    assert.notEqual(p.suggestedFareNgn, picked.suggestedFareNgn);
    assert.equal(p.modelFareNgn, picked.suggestedFareNgn, 'what the model would have shown is still recorded');
    assert.ok(p.minOfferNgn >= p.marketFareNgn);
  }
  assert.ok(trials > 240 && trials < 360, `about a tenth of trips (${trials} of 3000)`);
  assert.ok(seen.size >= 5, 'spread over the range, not one other price');
  const again = (key) => calculateSuggestedFare(15.5, { ...trip, trialKey: key }).suggestedFareNgn;
  for (let i = 0; i < 50; i++) assert.equal(again(`trip-${i}`), again(`trip-${i}`), 'asked again, the same trip gets the same price');

  setPricingSettings({ ...SAMPLED, modelOn: true, trialShare: 0 });
  for (let i = 0; i < 200; i++) assert.equal(calculateSuggestedFare(15.5, { ...trip, trialKey: `trip-${i}` }).setBy, 'model', 'switched off: none');
  setPricingSettings({ ...SAMPLED, modelOn: false });
  for (let i = 0; i < 200; i++) assert.equal(calculateSuggestedFare(15.5, { ...trip, trialKey: `trip-${i}` }).suggestedFareNgn, today, 'and none while the model is off');
});

test('a model corrected on real quotes is scored with its correction: sigmoid(a + b x trees + c x ln(price / the other app))', () => {
  const ml = JSON.parse(JSON.stringify(getPricingMlModel()));
  const x = ml.checks[0].x;
  const logit = (p) => Math.log(p / (1 - p));
  const trees = logit(scoreForest(ml.models.requested, x));
  ml.models.requested.adjust = { a: -0.4, b: 1.1, c: -0.5 };
  const expected = 1 / (1 + Math.exp(-(-0.4 + 1.1 * trees - 0.5 * Math.log(x[9]))));
  assert.ok(Math.abs(scoreForest(ml.models.requested, x) - expected) < 1e-12);
  const share = scoreForest(ml.models.paid, x);
  ml.models.paid.adjust = { a: -0.02, b: 1.05 };
  assert.ok(Math.abs(scoreForest(ml.models.paid, x) - (-0.02 + 1.05 * share)) < 1e-12);
  setPricingMlModel(ml);
  setPricingSettings({ ...SAMPLED, modelOn: true });
  assert.ok(calculateSuggestedFare(15.511, { durationSeconds: 23 * 60, at: SUNDAY, trafficRatio: 1 }).suggestedFareNgn >= 5950, 'and it still prices inside its limits');
});

test('the other app\'s figures are fitted from prices read off it: more prices, more of the figures', async () => {
  const { fitMarket, typicalMiss } = await import('../scripts/fit-market.mjs');
  const current = { baseNgn: 500, perKmNgn: 290, perMinuteNgn: 50 };
  const truth = (km, minutes) => ({ km, minutes, priceNgn: 400 + 250 * km + 62 * minutes });

  assert.equal(fitMarket([], current).fitted, 'nothing');
  const one = fitMarket([{ km: 15.511, minutes: 23, priceNgn: 5800 }], current);
  assert.equal(one.fitted, 'per km');
  assert.deepEqual(one.figures, { baseNgn: 500, perKmNgn: 268, perMinuteNgn: 50 }, 'the one real quote we have gives 268 a km');

  // Four trips of one length range: per km and per minute; the base is not guessed.
  const four = fitMarket([truth(14, 30), truth(16, 45), truth(18, 40), truth(25, 50)], current);
  assert.equal(four.fitted, 'per km and per minute');
  assert.equal(four.figures.baseNgn, 500, 'the base is not guessed from four trips of a length');
  assert.ok(four.missAfter < four.missBefore);
  // Short and long among them: a short trip tells the base apart; the minute stays.
  const mixed = fitMarket([truth(3.2, 12), truth(15.5, 47), truth(16.7, 51), truth(25, 50)], current);
  assert.equal(mixed.fitted, 'base and per km');
  assert.equal(mixed.figures.perMinuteNgn, 50);
  assert.notEqual(mixed.figures.baseNgn, 500);
  assert.ok(mixed.missAfter < mixed.missBefore);

  const many = fitMarket([truth(4, 9), truth(6, 20), truth(9, 18), truth(12, 40), truth(16, 33), truth(20, 70), truth(26, 52), truth(33, 95)], current);
  assert.equal(many.fitted, 'all three');
  assert.deepEqual(many.figures, { baseNgn: 400, perKmNgn: 250, perMinuteNgn: 62 }, 'eight trips recover all three exactly');
  assert.equal(many.missAfter, 0);
  assert.ok(typicalMiss(current, [truth(16, 33)]) > 0);

  // Trips all of one length cannot tell a km from a minute: the fit steps down rather than invent figures.
  const alike = fitMarket([{ km: 16, minutes: 33, priceNgn: 7200 }, { km: 16, minutes: 33, priceNgn: 7300 }, { km: 16, minutes: 33, priceNgn: 7100 }], current);
  assert.equal(alike.fitted, 'per km');
});

test('the export gives one row for each asking of a price, with how it ended, and leaves out what is too fresh to know', async () => {
  const { realQuoteRows } = await import('../scripts/export-pricing-quotes.mjs');
  const now = new Date('2031-03-05T12:00:00Z');   // a time no other test writes quotes at
  const minutesAgo = (m) => new Date(now.getTime() - m * 60_000);
  const rider = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'RIDER', name: 'Export Rider' } });
  const driverUser = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'DRIVER', name: 'Export Driver' } });
  made.users.push(rider.id, driverUser.id);
  const quote = (lat, at, fare, setBy = 'model') => prisma.pricingQuote.create({ data: {
    createdAt: at, originLat: lat, originLng: 3.38, destLat: 6.45, destLng: 3.42, pickupZone: 'Yaba', distanceKm: 10, durationSeconds: 1500,
    demandFactor: 1, rush: false, marketFareNgn: 4000, floorFareNgn: 4300, rulesFareNgn: 4400, modelFareNgn: 4200, suggestedFareNgn: fare, minOfferNgn: fare - 150, setBy,
  } });
  const ride = async (lat, at, agreed) => {
    const r = await prisma.ride.create({ data: { riderId: rider.id, status: agreed ? 'DRIVER_ASSIGNED' : 'CANCELLED', pickupLat: lat, pickupLng: 3.38, pickupAddress: 'A', destLat: 6.45, destLng: 3.42, destAddress: 'B', createdAt: at, ...(agreed ? { agreedFareNgn: agreed } : {}) } });
    made.rides.push(r.id);
    return r;
  };
  const quotes = [];
  // 1. asked three times in a row, then requested and agreed at N4,150: one row, at the LAST price seen
  quotes.push(await quote(6.5101, minutesAgo(300), 4400), await quote(6.5101, minutesAgo(296), 4300), await quote(6.5101, minutesAgo(293), 4200));
  await ride(6.5101, minutesAgo(291), 4150);
  // 2. saw a trial price and walked away
  quotes.push(await quote(6.5202, minutesAgo(200), 4350, 'trial'));
  // 3. requested, no driver ever answered
  quotes.push(await quote(6.5303, minutesAgo(150), 4200));
  await ride(6.5303, minutesAgo(149), null);
  // 4. asked ten minutes ago: too fresh, its ending is not known
  quotes.push(await quote(6.5404, minutesAgo(10), 4200));

  try {
    const rows = (await realQuoteRows({ days: 2, now })).filter((r) => r.at >= minutesAgo(400).toISOString());
    assert.equal(rows.length, 3, 'three askings, not five quotes; the fresh one left out');
    const [agreed, walked, unanswered] = rows;
    assert.deepEqual([agreed.fare, agreed.requested, agreed.answered, agreed.ride, agreed.paid], [4200, 1, 1, 1, 4150]);
    assert.deepEqual([walked.fare, walked.requested, walked.answered, walked.ride, walked.paid, walked.setBy], [4350, 0, 0, 0, '', 'trial']);
    assert.deepEqual([unanswered.requested, unanswered.answered, unanswered.ride], [1, 0, 0]);
    assert.equal(agreed.km, 10);
    assert.equal(agreed.minPerKm, 2.5);
    assert.equal(agreed.fareOverMarket, 1.05);
    assert.equal(agreed.hour, 8, 'Lagos time');
  } finally {
    await prisma.pricingQuote.deleteMany({ where: { id: { in: quotes.map((q) => q.id) } } });
  }
});

test.after(async () => {
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.adminActivity.deleteMany({ where: { adminId: { in: made.admins } } });
  await prisma.adminUser.deleteMany({ where: { id: { in: made.admins } } });
  // Put the saved settings back exactly as they were.
  if (savedBefore) await prisma.pricingSettings.update({ where: { id: 'current' }, data: { data: savedBefore.data, updatedBy: savedBefore.updatedBy } });
  else await prisma.pricingSettings.deleteMany({ where: { id: 'current' } });
  await prisma.$disconnect();
});

test('the minimum offer sits a set amount under the suggested price: N850 unless an owner changes it', () => {
  const { offerLimitsNgn } = config;
  setPricingSettings({ ...DEFAULT_PRICING_SETTINGS });
  assert.equal(DEFAULT_PRICING_SETTINGS.minOfferGapNgn, 850);
  assert.equal(offerLimitsNgn(6000).minOfferNgn, 5150);
  assert.equal(offerLimitsNgn(7500).minOfferNgn, 6650);
  assert.equal(offerLimitsNgn(12000).minOfferNgn, 11150, 'the same room on a long trip as on a short one');
  assert.equal(validateRiderOffer(5150, 6000).valid, true);
  assert.equal(validateRiderOffer(5100, 6000).valid, false);
  assert.match(validateRiderOffer(5100, 6000).reason, /5,150/);

  // With the floor and the model on it is still the gap, not the premium.
  setPricingSettings({ ...SAMPLED, minOfferGapNgn: 850, modelOn: true });
  assert.equal(offerLimitsNgn(6000).minOfferNgn, 5150);

  setPricingSettings({ ...DEFAULT_PRICING_SETTINGS, minOfferGapNgn: 900 });
  assert.equal(offerLimitsNgn(6000).minOfferNgn, 5100);
  setPricingSettings({ ...DEFAULT_PRICING_SETTINGS, minOfferGapNgn: 825 });
  assert.equal(offerLimitsNgn(6000).minOfferNgn, 5200, 'rounded up to the next N50');
});

test('a short trip never goes under the minimum fare, and the driver ceiling does not move with the gap', () => {
  const { offerLimitsNgn } = config;
  setPricingSettings({ ...DEFAULT_PRICING_SETTINGS });
  assert.equal(offerLimitsNgn(3000).minOfferNgn, 3000, 'already at the minimum fare: nothing to bargain away');
  assert.equal(offerLimitsNgn(3500).minOfferNgn, 3000);
  assert.equal(offerLimitsNgn(3900).minOfferNgn, 3050);
  const withGap = offerLimitsNgn(6000).maxOfferNgn;
  setPricingSettings({ ...DEFAULT_PRICING_SETTINGS, minOfferGapNgn: 0 });
  assert.equal(offerLimitsNgn(6000).maxOfferNgn, withGap);
  assert.equal(offerLimitsNgn(6000).minOfferNgn, 5450, 'gap 0 is the older rule: a tenth off the trip fare');
});
