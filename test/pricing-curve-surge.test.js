/**
 * The price by the clock and the live surge. The curve multiplies the other
 * app's quiet-hour figures hour by hour, learned from every price we have
 * (inDrive samples, agreed fares, drivers' bids); the surge lifts a price from
 * our own riders, drivers and bids. Neither ever makes a price cheaper.
 * The evidence test runs against the local Postgres.
 *
 *   node scripts/run-with-env.cjs node --test --test-force-exit test/pricing-curve-surge.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const config = require('@wheleers/config');
const { prisma, pricingClient } = require('@wheleers/db');
const { surgeTarget, stepSurge } = require('../apps/api-gateway/dist/pricing/surge.js');

// A Wednesday, at an hour Lagos time (UTC+1); and a Saturday.
const lagos = (hour, day = 21) => new Date(Date.UTC(2026, 9, day, hour - 1));
const range = { minNgn: 800, maxNgn: 1500 };
const floorOn = { marketFloorOn: true, liftCap: 1, periodPremiums: { morning: range, afternoon: range, evening: range, night: range } };
const flat = () => ({ weekday: Array(24).fill(1), weekend: Array(24).fill(1) });

test.after(() => { config.setPricingSettings({}); return prisma.$disconnect(); });

test('curve off: every price is exactly as before', () => {
  config.setPricingSettings(floorOn);
  const before = [8, 14, 18, 23].map((h) => config.calculateSuggestedFare(15.5, { durationSeconds: 47 * 60, at: lagos(h), trialKey: 'k' }).suggestedFareNgn);
  config.setPricingSettings({ ...floorOn, hourCurve: { weekday: Array(24).fill(1.5), weekend: Array(24).fill(1.5) }, hourCurveOn: false, surgeOn: false });
  const after = [8, 14, 18, 23].map((h) => config.calculateSuggestedFare(15.5, { durationSeconds: 47 * 60, at: lagos(h), trialKey: 'k' }));
  assert.deepEqual(after.map((f) => f.suggestedFareNgn), before);
  assert.equal(after[0].hourFactor, null);
  assert.equal(after[0].surgeFactor, 1);
});

test('curve on: the other app is its quiet-hour figures times the hour; switching on the seed changes nothing', () => {
  config.setPricingSettings(floorOn);
  const s = config.getPricingSettings();
  const seed = config.seedHourCurve(s);
  assert.equal(seed.weekday[12], 1, 'a quiet hour');
  assert.ok(seed.weekday[18] > 1 && seed.weekday[8] > 1, 'rush hours carry what rush charges over quiet');
  assert.equal(seed.weekend[18], 1);
  const off = config.calculateSuggestedFare(15, { durationSeconds: 40 * 60, at: lagos(18) });
  config.setPricingSettings({ ...floorOn, hourCurveOn: true, hourCurve: seed });
  const on = config.calculateSuggestedFare(15, { durationSeconds: 40 * 60, at: lagos(18) });
  assert.ok(Math.abs(on.marketFareNgn - off.marketFareNgn) / off.marketFareNgn < 0.01, `the seed prices the typical trip as rush did, to the rounding of its multiplier (${on.marketFareNgn} vs ${off.marketFareNgn})`);
  assert.equal(on.hourFactor, seed.weekday[18]);

  const curve = flat(); curve.weekday[18] = 1.1;
  config.setPricingSettings({ ...floorOn, hourCurveOn: true, hourCurve: curve });
  const six = config.calculateSuggestedFare(15, { durationSeconds: 40 * 60, at: lagos(18) });
  const noon = config.calculateSuggestedFare(15, { durationSeconds: 40 * 60, at: lagos(12) });
  assert.equal(Math.round(six.marketFareNgn), Math.round(config.quietMarketFareNgn(15, 40) * 1.1));
  assert.equal(Math.round(noon.marketFareNgn), Math.round(config.quietMarketFareNgn(15, 40)));
});

test('a saved curve is made safe: 24 hours each, never under 1 or over 1.15', () => {
  const s = config.setPricingSettings({ hourCurve: { weekday: Array(24).fill(0.7), weekend: Array(24).fill(9) } });
  assert.equal(s.hourCurve.weekday[0], 1);
  assert.equal(s.hourCurve.weekend[0], 1.15, 'an hour that ran away is held at +15% the moment it is read');
  assert.equal(config.setPricingSettings({ hourCurve: { weekday: [1, 2], weekend: Array(24).fill(1) } }).hourCurve, null);
  assert.equal(config.setPricingSettings({ surgeMax: 50 }).surgeMax, 2);
  config.setPricingSettings({});
});

test('the curve learns: inDrive dearer at 6pm lifts 6pm (15% a fit at most), not 3am; nothing pulls it under 1; wild prices are ignored', () => {
  const now = lagos(23);
  // Twelve evening prices, all around 6pm on weekdays: enough for that hour to move.
  const at6 = Array.from({ length: 12 }, (_, i) => ({ at: new Date(lagos(18).getTime() - i * 5 * 60_000), ratio: 1.3, weight: 3, kind: 'sample' }));
  const fit = config.fitHourCurve(at6, flat(), now);
  assert.equal(fit.curve.weekday[18], 1.15, 'a step of 15% toward 1.3');
  assert.ok(fit.curve.weekday[17] > 1 && fit.curve.weekday[17] <= fit.curve.weekday[18], 'its neighbours a little');
  assert.equal(fit.curve.weekday[3], 1, 'a far hour untouched');
  assert.equal(fit.used.sample, 12);
  const again = config.fitHourCurve(at6, fit.curve, now);
  assert.equal(again.curve.weekday[18], 1.15, 'fitted again, never past +15% however the prices lean');

  const cheap = Array.from({ length: 10 }, () => ({ at: lagos(14), ratio: 0.8, weight: 3, kind: 'sample' }));
  assert.equal(config.fitHourCurve(cheap, flat(), now).curve.weekday[14], 1, 'never cheaper than the quiet-hour figures');
  const wild = [{ at: lagos(10), ratio: 9, weight: 3, kind: 'sample' }];
  assert.equal(config.fitHourCurve(wild, flat(), now).curve.weekday[10], 1);
  assert.equal(config.fitHourCurve(wild, flat(), now).used.sample, 0);
});

test('one price is pulled toward the curve it has; many move it', () => {
  const now = lagos(23);
  const one = config.fitHourCurve([{ at: lagos(9), ratio: 1.3, weight: 1, kind: 'agreed' }], flat(), now);
  const many = config.fitHourCurve(Array.from({ length: 20 }, () => ({ at: lagos(9), ratio: 1.12, weight: 1, kind: 'agreed' })), flat(), now, { maxStep: 1 });
  assert.equal(one.curve.weekday[9], 1, 'one agreed fare is not enough to move an hour');
  assert.ok(many.curve.weekday[9] >= 1.09, `twenty move it most of the way (${many.curve.weekday[9]})`);
});

test('three evening prices cannot lift every evening; an hour that ran ahead on too few goes back to the rush and quiet figures', () => {
  const now = lagos(23);
  const ranAhead = flat(); ranAhead.weekday[17] = 1.3; ranAhead.weekday[18] = 1.32; ranAhead.weekday[19] = 1.3;
  const baseline = flat(); baseline.weekday[18] = 1.12;
  const three = [7500, 8700, 9800].map((price, i) => ({ at: new Date(lagos(18).getTime() + i * 60_000), ratio: price / 6500, weight: 3, kind: 'sample' }));
  const fit = config.fitHourCurve(three, ranAhead, now, { baseline });
  assert.equal(fit.curve.weekday[18], 1.12, 'back to what the rush figures charge');
  assert.equal(fit.curve.weekday[17], 1);
  assert.equal(fit.counts.weekday[18], 3);
  assert.equal(config.MIN_PRICES_FOR_AN_HOUR, 8);
});

test('surge: only with the switch on, only ever up, never past the most', () => {
  config.setPricingSettings({ ...floorOn });
  const plain = config.calculateSuggestedFare(15, { durationSeconds: 40 * 60, at: lagos(12), surgeFactor: 1.3 });
  assert.equal(plain.surgeFactor, 1, 'off: no surge');
  config.setPricingSettings({ ...floorOn, surgeOn: true, surgeMax: 1.4 });
  const surged = config.calculateSuggestedFare(15, { durationSeconds: 40 * 60, at: lagos(12), surgeFactor: 1.3 });
  assert.equal(surged.surgeFactor, 1.3);
  assert.equal(Math.round(surged.marketFareNgn), Math.round(plain.marketFareNgn * 1.3));
  assert.ok(surged.suggestedFareNgn > plain.suggestedFareNgn);
  assert.equal(config.calculateSuggestedFare(15, { durationSeconds: 2400, at: lagos(12), surgeFactor: 0.6 }).suggestedFareNgn, plain.suggestedFareNgn, 'never a discount');
  assert.equal(config.calculateSuggestedFare(15, { durationSeconds: 2400, at: lagos(12), surgeFactor: 3 }).surgeFactor, 1.4);
  config.setPricingSettings({});
});

test('surge reads our market: drivers asking more, nobody bidding, more riders than drivers; too little to read is no surge', () => {
  assert.equal(surgeTarget({ rides: 1, drivers: 0, counter: 1.5, noBidShare: 1 }, 1.4), 1, 'one ride is no signal');
  assert.equal(surgeTarget({ rides: 4, drivers: 6, counter: 1, noBidShare: 0 }, 1.4), 1, 'a calm market');
  assert.equal(surgeTarget({ rides: 4, drivers: 6, counter: 1.2, noBidShare: 0 }, 1.4), 1.16, 'drivers ask 20% more: +16%');
  assert.equal(surgeTarget({ rides: 4, drivers: 6, counter: null, noBidShare: 1 }, 1.4), 1.1, 'drivers online, nobody bids: +10%');
  assert.equal(surgeTarget({ rides: 4, drivers: 0, counter: null, noBidShare: 1 }, 1.4) > 1, true, 'no drivers at all: riders outnumber them');
  assert.equal(surgeTarget({ rides: 9, drivers: 1, counter: 2, noBidShare: 1 }, 1.4), 1.4, 'never past the most');
  assert.equal(surgeTarget({ rides: 4, drivers: 6, counter: 0.8, noBidShare: 0 }, 1.4), 1, 'drivers bidding under the offer never cuts the price');
  assert.equal(stepSurge(1, 1.3), 1.05, 'up 0.05 a pass');
  assert.equal(stepSurge(1.3, 1), 1.27, 'down 0.03 a pass');
  assert.equal(stepSurge(1.02, 1), 1, 'never under 1');
});

test('evidence: inDrive samples, a bargained fare, a fare taken as shown and an unanswered bid each say what trips cost', async () => {
  const at = new Date('2032-02-11T17:00:00Z'); // 18:00 Lagos; a time no other test writes at
  config.setPricingSettings(floorOn);
  const settings = config.getPricingSettings();
  const rider = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'RIDER', name: 'Curve Rider' } });
  const driverUser = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'DRIVER', name: 'Curve Driver' } });
  const driver = await prisma.driver.create({ data: { userId: driverUser.id, kycStatus: 'APPROVED' } });
  const made = { quotes: [], rides: [], samples: [] };
  const base = config.quietMarketFareNgn(10, 25, settings);
  const point = (lat) => ({ lat, lng: 3.38 });
  const key = (lat) => `${lat.toFixed(5)},3.38000>6.45000,3.42000@${Math.floor(at.getTime() / (30 * 60_000))}`;
  const quote = async (lat, market, shown, surge = 1) => made.quotes.push((await prisma.pricingQuote.create({ data: {
    createdAt: at, originLat: lat, originLng: 3.38, destLat: 6.45, destLng: 3.42, pickupZone: 'Yaba', distanceKm: 10, durationSeconds: 1500,
    demandFactor: 1, rush: true, marketFareNgn: market, floorFareNgn: shown, rulesFareNgn: 4000, suggestedFareNgn: shown, minOfferNgn: shown - 850, setBy: 'floor',
    tripKey: key(lat), surgeFactor: surge,
  } })).id);
  const ride = async (lat, agreed) => {
    const r = await prisma.ride.create({ data: {
      riderId: rider.id, status: agreed ? 'DRIVER_ASSIGNED' : 'CANCELLED', pickupLat: lat, pickupLng: 3.38, pickupAddress: 'A', destLat: 6.45, destLng: 3.42, destAddress: 'B',
      distanceKm: 10, durationSeconds: 1500, createdAt: new Date(at.getTime() + 60_000), ...(agreed ? { agreedFareNgn: agreed } : {}),
    } });
    made.rides.push(r.id);
    return r;
  };
  try {
    made.samples.push((await prisma.marketSample.create({ data: { km: 10, minutes: 25, priceNgn: Math.round(base * 1.25), rush: true, takenAt: at } })).id);
    // Bargained up: shown ₦6,000 on a market of ₦5,000; a driver's counter agreed at ₦6,600.
    await quote(6.5101, 5000, 6000); await ride(6.5101, 6600);
    // Taken as shown.
    await quote(6.5202, 5000, 6000); await ride(6.5202, 6000);
    // Under a 1.2 surge: the surge is taken out.
    await quote(6.5303, 6000, 7000, 1.2); await ride(6.5303, 7000);
    // Nobody agreed; a driver asked ₦6,500.
    await quote(6.5404, 5000, 6000);
    const unanswered = await ride(6.5404, null);
    await prisma.driverBid.create({ data: { rideId: unanswered.id, driverId: driver.id, driverUserId: driverUser.id, riderId: rider.id, amountNgn: 6500, etaSeconds: 200 } });
    // Asked about, never booked: no evidence.
    await quote(6.5505, 5000, 6000);

    const ev = await pricingClient.curveEvidence(new Date('2032-02-11T00:00:00Z'), settings);
    const of = (kind) => ev.filter((e) => e.kind === kind);
    assert.equal(of('sample').length, 1);
    assert.ok(Math.abs(of('sample')[0].ratio - 1.25) < 0.01);
    assert.equal(of('sample')[0].weight, 3);
    const agreed = of('agreed').sort((a, b) => b.ratio - a.ratio);
    assert.equal(agreed.length, 3);
    assert.ok(Math.abs(agreed[0].ratio - 5600 / base) < 0.001, 'bargained up ₦600 over the shown price: the market part plus ₦600');
    assert.equal(agreed[0].weight, 1);
    const asShown = agreed.filter((e) => e.weight === 0.5);
    assert.equal(asShown.length, 2, 'taken as shown counts half');
    assert.ok(asShown.every((e) => Math.abs(e.ratio - 5000 / base) < 0.001), 'and the surged one says the usual ₦5,000, not the surge');
    assert.equal(of('bid').length, 1);
    assert.ok(Math.abs(of('bid')[0].ratio - 5500 / base) < 0.001);
    assert.equal(of('bid')[0].weight, 0.5);
  } finally {
    await prisma.driverBid.deleteMany({ where: { rideId: { in: made.rides } } });
    await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
    await prisma.pricingQuote.deleteMany({ where: { id: { in: made.quotes } } });
    await prisma.marketSample.deleteMany({ where: { id: { in: made.samples } } });
    await prisma.driver.delete({ where: { id: driver.id } });
    await prisma.user.deleteMany({ where: { id: { in: [rider.id, driverUser.id] } } });
  }
});
