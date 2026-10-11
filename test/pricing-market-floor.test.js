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
const local = require('../apps/api-gateway/dist/auth/local.js');
const { prisma, pricingClient } = require('@wheleers/db');
const config = require('../packages/config/dist/index.js');
const { calculateSuggestedFare, setPricingSettings, DEFAULT_PRICING_SETTINGS, validateRiderOffer, marketFareNgn, isRushHour, calculateRideFees, getPricingMlModel, setPricingMlModel, scoreForest } = config;
const { handleAdminPricingRoute } = require('../apps/api-gateway/dist/http/admin-pricing.route.js');
const { measureBusyness, demandFactorAt } = require('../apps/api-gateway/dist/pricing/busyness.js');

const QUIET = new Date('2026-10-14T12:00:00Z'); // Wednesday 13:00 in Lagos
const RUSH = new Date('2026-10-14T17:00:00Z');  // Wednesday 18:00 in Lagos
// Round figures for the other app, so the sums below can be done by hand.
const FLOOR_ON = { ...DEFAULT_PRICING_SETTINGS, marketFloorOn: true, trafficOn: true, demandOn: true, quiet: { baseNgn: 500, perKmNgn: 290, perMinuteNgn: 50 }, rush: { baseNgn: 600, perKmNgn: 350, perMinuteNgn: 60 } };
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

// ── the owners' endpoint ────────────────────────────────────────────────────

const SECRET = 'test-secret-for-the-pricing-settings-page';
let server; let base;

async function admin(role) {
  const row = await prisma.adminUser.create({ data: { username: `price-${role.toLowerCase()}-${randomUUID().slice(0, 8)}`, passwordHash: 'x', name: `Price ${role}`, role } });
  made.admins.push(row.id);
  return local.createLocalAccessToken(row.id, SECRET, 3600);
}

const call = async (token, method = 'GET', body) => {
  const res = await fetch(`${base}/admin/pricing`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() };
};

test('owners read and save the settings; staff are told there is nothing there; the model cannot be switched on before it exists', async () => {
  server = http.createServer((req, res) => {
    void handleAdminPricingRoute(req, res, { adminApiKey: 'unused-key', jwtSecret: SECRET }, new URL(req.url, 'http://x')).then((handled) => {
      if (!handled) { res.statusCode = 404; res.end('{}'); }
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const owner = await admin('OWNER'); const staff = await admin('STAFF');

  assert.equal((await call(staff)).status, 404);
  assert.equal((await call(staff, 'PUT', { premiumNgn: 0 })).status, 404);

  const saved = await call(owner, 'PUT', { ...FLOOR_ON, premiumNgn: 450, quiet: { baseNgn: 550, perKmNgn: 300, perMinuteNgn: 48 } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.settings.premiumNgn, 450);
  assert.equal(saved.body.fixed.serviceChargeNgn, 350);
  const sixteen = saved.body.examples.find((e) => e.distanceKm === 16);
  assert.equal(sixteen.quiet.marketFareNgn, 550 + 300 * 16 + 48 * 41);
  assert.equal(sixteen.quiet.suggestedFareNgn, Math.ceil((sixteen.quiet.marketFareNgn + 450) / 50) * 50);
  assert.ok(sixteen.rush.suggestedFareNgn > sixteen.quiet.suggestedFareNgn);

  assert.equal((await pricingClient.loadSettings()).settings.premiumNgn, 450, 'in the database');
  assert.equal(config.getPricingSettings().premiumNgn, 450, 'and in this process at once');

  assert.ok(saved.body.trainedModel.rows >= 1_000_000, 'the page is told which model this build prices with');
  const on = await call(owner, 'PUT', { ...FLOOR_ON, modelOn: true });
  assert.equal(on.status, 200, 'there is a trained model, so it can be switched on');
  assert.equal(on.body.settings.modelOn, true);
  setPricingMlModel(null);
  const refused = await call(owner, 'PUT', { ...FLOOR_ON, modelOn: true });
  assert.equal(refused.status, 400, 'with no model of any kind there is nothing to switch on');
  const log = await prisma.adminActivity.findFirst({ where: { adminId: made.admins[0], kind: 'pricing' } });
  assert.ok(log, 'the change is on the owners\' activity timeline');
});

// ── how busy a zone is ──────────────────────────────────────────────────────

const fakeRedis = () => {
  const store = new Map();
  return { store, get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); } };
};

test('a zone gets dearer only with a real signal, and only a step at a time', async () => {
  const redis = fakeRedis();
  const now = new Date('2026-10-14T12:00:00Z');
  const rider = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'RIDER', name: 'Busy Rider' } });
  made.users.push(rider.id);
  const request = async (n, at) => {
    for (let i = 0; i < n; i++) {
      const r = await prisma.ride.create({ data: { riderId: rider.id, status: 'REQUESTED', pickupLat: 6.51, pickupLng: 3.38, pickupAddress: 'Yaba', destLat: 6.45, destLng: 3.42, destAddress: 'VI', pickupZone: 'Yaba', createdAt: new Date(at.getTime() - 60_000) } });
      made.rides.push(r.id);
    }
  };
  // Other tests' rides in the zone must not count: this test owns the last ten minutes of a fixed moment.
  const yaba = (zones) => zones.find((z) => z.zone === 'Yaba');

  // No history for this hour: whatever happens, the price does not move.
  await request(4, now);
  let z = yaba(await measureBusyness(redis, now));
  assert.equal(z.requests, 4);
  assert.equal(z.ratio, null, 'nothing usual to compare with yet');
  assert.equal(z.factor, 1);

  // A usual level of one request per pass at this hour, learned over many passes.
  redis.store.set('pricing:busyness:usual', JSON.stringify({ 'Yaba:13:wd': { level: 1, n: 40 } }));
  z = yaba(await measureBusyness(redis, now));
  assert.equal(z.ratio, 4, 'four times the usual');
  assert.equal(z.factor, 1.1, 'one step, not the whole way');
  z = yaba(await measureBusyness(redis, now));
  assert.equal(z.factor, 1.2);

  // Quiet again (a later window with no requests): it comes back down a step at a time.
  const later = new Date(now.getTime() + 30 * 60_000);
  z = yaba(await measureBusyness(redis, later));
  assert.equal(z.requests, 0);
  assert.equal(z.factor, 1.1);
  assert.equal(demandFactorAt(6.51, 3.38), 1.1, 'what a quote from Yaba now uses');
  assert.equal(demandFactorAt(6.6, 3.3), 1, 'outside the launch zones nothing is added');
});

test.after(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.adminActivity.deleteMany({ where: { adminId: { in: made.admins } } });
  await prisma.adminUser.deleteMany({ where: { id: { in: made.admins } } });
  // Put the saved settings back exactly as they were.
  if (savedBefore) await prisma.pricingSettings.update({ where: { id: 'current' }, data: { data: savedBefore.data, updatedBy: savedBefore.updatedBy } });
  else await prisma.pricingSettings.deleteMany({ where: { id: 'current' } });
  await prisma.$disconnect();
});
