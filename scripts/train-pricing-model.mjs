#!/usr/bin/env node
// Train the pricing model from Wheelers' own trips.
//
// Each completed ride is matched to the price it was quoted (same pickup and
// drop-off, at most 30 minutes before the request), and a small linear model
// is fitted to the rate per km the trip was AGREED at:
//
//   ln(rate) = intercept + lnKm·ln(km) + minPerKm·(minutes ÷ km) + lnDemand·ln(busyness)
//              + rush + night + weekend
//
// It is six numbers. The gateway scores it in a few multiplications; there is
// no model server. The model is saved into the pricing settings but stays
// OFF: an owner switches it on from the admin's Pricing page once the check
// below reads well.
//
// --seed starts it before there are enough real trips: made-up trips stand in
// for the missing ones. They are drawn around the two real prices we have
// from the other app (15.6 km on a clear road, ₦5,800; 16 km in traffic,
// ₦7,200) plus assumptions about nights, rush hours and busy areas, so a
// seeded model says what we assumed, not what riders did. The made-up trips
// weigh as much as (300 − real trips) real ones: every real trip pushes them
// out, and at 300 they are gone.
//
//   node scripts/run-with-env.cjs node scripts/train-pricing-model.mjs                  # dry run: fit, report, save nothing
//   node scripts/run-with-env.cjs node scripts/train-pricing-model.mjs --save           # save a model fitted on real trips (still switched off)
//   node scripts/run-with-env.cjs node scripts/train-pricing-model.mjs --seed --save    # save one now, seeded (still switched off)
//   ... --days 60        how far back to read (default 90)
//   ... --min-rows 300   without --seed, refuse to save a model fitted on fewer trips (default 300)
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { prisma, pricingClient } = require('@wheleers/db');
const { tripFareNgn } = require('../packages/config/dist/index.js');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : fallback; };
const DAYS = value('days', 90);
const MIN_ROWS = value('min-rows', 300);
const RIDGE = 1e-3;

/** Solve (XᵀWX + ridge·I) w = XᵀWy by Gaussian elimination. The intercept (column 0) is not shrunk. `weights`: how much each row counts (1 each when left out). */
export function fitLinear(X, y, ridge = RIDGE, weights = null) {
  const k = X[0].length;
  const A = Array.from({ length: k }, () => new Array(k + 1).fill(0));
  let mass = 0;
  for (let r = 0; r < X.length; r++) {
    const w = weights ? weights[r] : 1;
    mass += w;
    for (let i = 0; i < k; i++) {
      A[i][k] += w * X[r][i] * y[r];
      for (let j = 0; j < k; j++) A[i][j] += w * X[r][i] * X[r][j];
    }
  }
  for (let i = 1; i < k; i++) A[i][i] += ridge * mass;
  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    if (Math.abs(A[col][col]) < 1e-12) continue;
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let c = col; c <= k; c++) A[r][c] -= f * A[col][c];
    }
  }
  return A.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[k] / row[i]));
}

/** How many real trips it takes for the made-up ones to count for nothing. */
const SEED_FADES_AT = 300;

/**
 * Made-up agreed trips. The rate a trip clears at is taken to rise with the
 * minutes each km takes, through the two real prices we have from the other
 * app turned into our own rate per km (₦325 on a clear road, ₦398 in
 * traffic) and set 8% above them, with more per km on short trips, 10% more
 * at night, 3% more in rush hours, and in step with how busy the area is.
 */
export function seedTrips(n = 4000, seed = 20261011) {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const normal = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
  const X = []; const y = [];
  for (let i = 0; i < n; i++) {
    const km = Math.max(1.5, 9 * Math.exp(0.6 * normal()));
    const weekend = rnd() < 2 / 7;
    const hourDraw = rnd();
    const night = hourDraw < 0.08;
    const rush = !weekend && !night && hourDraw < 0.48;
    const minPerKm = Math.max(1.4, (night ? 1.6 : weekend ? 2.1 : rush ? 3.8 : 2.3) * Math.exp(0.22 * normal()));
    const demand = rnd() < 0.8 ? 1 : 1 + 0.6 * rnd();
    const rate = 1.08 * (225 + 66.4 * minPerKm + 300 / km) * (night ? 1.1 : 1) * (rush ? 1.03 : 1) * demand * Math.exp(0.08 * normal());
    X.push([1, Math.log(km), minPerKm, Math.log(demand), rush ? 1 : 0, night ? 1 : 0, weekend ? 1 : 0]);
    y.push(Math.log(rate));
  }
  return { X, y };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000);
  // The quote a ride was requested from: same two points (to about 10 m), the latest one before the request.
  const rows = await prisma.$queryRaw`
    SELECT r.id, r."createdAt" AS at, r."agreedFareNgn"::float AS fare, r."pricingVersion" AS version,
           q."distanceKm" AS km, q."durationSeconds" AS secs, q."demandFactor" AS demand, q.rush,
           q."suggestedFareNgn"::float AS quoted
    FROM "Ride" r
    JOIN LATERAL (
      SELECT * FROM "PricingQuote" q
      WHERE abs(q."originLat" - r."pickupLat") < 0.0001 AND abs(q."originLng" - r."pickupLng") < 0.0001
        AND abs(q."destLat" - r."destLat") < 0.0001 AND abs(q."destLng" - r."destLng") < 0.0001
        AND q."createdAt" <= r."createdAt" AND q."createdAt" >= r."createdAt" - interval '30 minutes'
      ORDER BY q."createdAt" DESC LIMIT 1
    ) q ON true
    WHERE r.status = 'COMPLETED' AND r."agreedFareNgn" IS NOT NULL AND r."createdAt" >= ${since} AND q."distanceKm" > 0.5`;

  console.log(`Completed rides with a matching quote in the last ${DAYS} days: ${rows.length}`);
  const seeding = flag('seed');
  if (rows.length < 20 && !seeding) {
    console.log('Too few to fit anything. The quote log fills as riders ask for prices; run this again later,');
    console.log('or add --seed to start from made-up trips until real ones take over.');
    return;
  }

  const X = []; const y = []; const quotedRate = [];
  for (const r of rows) {
    const rate = tripFareNgn(r.fare, r.version === 1 ? 1 : 2) / r.km;
    if (!(rate > 50 && rate < 5000)) continue;
    const lagos = new Date(new Date(r.at).getTime() + 3600_000);
    const hour = lagos.getUTCHours(); const day = lagos.getUTCDay();
    X.push([1, Math.log(r.km), r.secs / 60 / r.km, Math.log(Math.max(1, r.demand)), r.rush ? 1 : 0, hour >= 22 || hour < 5 ? 1 : 0, day === 0 || day === 6 ? 1 : 0]);
    y.push(Math.log(rate));
    quotedRate.push(tripFareNgn(r.quoted, 2) / r.km);
  }

  // Made-up trips, when asked for and still needed: together they weigh as
  // much as the real trips that are missing, and nothing at 300.
  const seedMass = seeding ? Math.max(0, SEED_FADES_AT - X.length) : 0;
  const made = seedMass > 0 ? seedTrips() : { X: [], y: [] };
  const fit = (realX, realY) => fitLinear(
    [...realX, ...made.X], [...realY, ...made.y], RIDGE,
    [...realX.map(() => 1), ...made.X.map(() => seedMass / made.X.length)],
  );

  // Fit on the older four fifths, check on the newest fifth: a model must price trips it has not seen.
  let errModel = NaN; let errQuote = NaN; let held = 0;
  if (X.length >= 20) {
    const cut = Math.floor(X.length * 0.8);
    const w = fit(X.slice(0, cut), y.slice(0, cut));
    const predict = (x) => Math.exp(x.reduce((sum, v, i) => sum + v * w[i], 0));
    const test = X.slice(cut).map((x, i) => ({ model: predict(x), agreed: Math.exp(y[cut + i]), quoted: quotedRate[cut + i] }));
    errModel = median(test.map((t) => Math.abs(t.model - t.agreed)));
    errQuote = median(test.map((t) => Math.abs(t.quoted - t.agreed)));
    held = test.length;
  }

  const final = fit(X, y);
  const model = {
    trainedAt: new Date().toISOString(),
    rows: X.length,
    seeded: seedMass > 0,
    intercept: final[0],
    coef: { lnKm: final[1], minPerKm: final[2], lnDemand: final[3], rush: final[4], night: final[5], weekend: final[6] },
  };

  console.log(`\nFitted on ${X.length} real trips${seedMass > 0 ? `, with made-up trips standing in for the ${seedMass} still missing` : ''}.`);
  if (held > 0) {
    console.log(`On the newest ${held} real trips (held back):`);
    console.log(`  the model misses the agreed rate by   ₦${errModel.toFixed(0)} a km (median)`);
    console.log(`  the price actually quoted missed by   ₦${errQuote.toFixed(0)} a km (median)`);
    console.log(`  ${errModel < errQuote ? 'The model is closer than what was quoted.' : 'The model is NOT closer than what was quoted: leave it off.'}`);
  } else {
    console.log('There are no real trips to check it against yet: it says what was assumed, nothing more.');
  }
  const at = (km, minPerKm, extra = {}) => Math.round(Math.exp(final[0] + final[1] * Math.log(km) + final[2] * minPerKm + final[4] * (extra.rush ? 1 : 0) + final[5] * (extra.night ? 1 : 0)));
  console.log(`\nWhat it would say, as a rate per km: 16 km on a clear road ₦${at(16, 1.5)} · in traffic ₦${at(16, 2.6)} · at rush hour ₦${at(16, 4.5, { rush: true })} · 5 km in traffic ₦${at(5, 2.6)}`);
  console.log('\nModel:', JSON.stringify(model, null, 2));

  if (!flag('save')) {
    console.log('\nDry run: nothing saved. Add --save to store it (it stays switched off until an owner turns it on).');
    return;
  }
  if (X.length < MIN_ROWS && !seeding) {
    console.log(`\nNot saved: ${X.length} trips is under the ${MIN_ROWS} needed (--min-rows to change, or --seed to start from made-up trips).`);
    return;
  }
  const { settings } = await pricingClient.loadSettings();
  await pricingClient.saveSettings({ ...settings, model }, 'train-pricing-model');
  console.log(`\nSaved. The model is ${settings.modelOn ? 'ON' : 'off: it is recorded beside every quote until an owner switches it on'}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
}
