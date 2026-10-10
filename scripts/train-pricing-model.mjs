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
//   node scripts/run-with-env.cjs node scripts/train-pricing-model.mjs            # dry run: fit, report, save nothing
//   node scripts/run-with-env.cjs node scripts/train-pricing-model.mjs --save     # save the model (still switched off)
//   ... --days 60        how far back to read (default 90)
//   ... --min-rows 300   refuse to save a model fitted on fewer trips (default 300)
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

/** Solve (XᵀX + ridge·I) w = Xᵀy by Gaussian elimination. The intercept (column 0) is not shrunk. */
export function fitLinear(X, y, ridge = RIDGE) {
  const k = X[0].length;
  const A = Array.from({ length: k }, () => new Array(k + 1).fill(0));
  for (let r = 0; r < X.length; r++) {
    for (let i = 0; i < k; i++) {
      A[i][k] += X[r][i] * y[r];
      for (let j = 0; j < k; j++) A[i][j] += X[r][i] * X[r][j];
    }
  }
  for (let i = 1; i < k; i++) A[i][i] += ridge * X.length;
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
  if (rows.length < 20) {
    console.log('Too few to fit anything. The quote log fills as riders ask for prices; run this again later.');
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

  // Fit on the older four fifths, check on the newest fifth: a model must price trips it has not seen.
  const cut = Math.floor(X.length * 0.8);
  const w = fitLinear(X.slice(0, cut), y.slice(0, cut));
  const predict = (x) => Math.exp(x.reduce((sum, v, i) => sum + v * w[i], 0));
  const test = X.slice(cut).map((x, i) => ({ model: predict(x), agreed: Math.exp(y[cut + i]), quoted: quotedRate[cut + i] }));
  const errModel = median(test.map((t) => Math.abs(t.model - t.agreed)));
  const errQuote = median(test.map((t) => Math.abs(t.quoted - t.agreed)));

  const final = fitLinear(X, y);
  const model = {
    trainedAt: new Date().toISOString(),
    rows: X.length,
    intercept: final[0],
    coef: { lnKm: final[1], minPerKm: final[2], lnDemand: final[3], rush: final[4], night: final[5], weekend: final[6] },
  };

  console.log(`\nFitted on ${X.length} trips. On the newest ${test.length} (held back):`);
  console.log(`  the model misses the agreed rate by   ₦${errModel.toFixed(0)} a km (median)`);
  console.log(`  the price actually quoted missed by   ₦${errQuote.toFixed(0)} a km (median)`);
  console.log(`  ${errModel < errQuote ? 'The model is closer than what was quoted.' : 'The model is NOT closer than what was quoted: leave it off.'}`);
  console.log('\nModel:', JSON.stringify(model, null, 2));

  if (!flag('save')) {
    console.log('\nDry run: nothing saved. Add --save to store it (it stays switched off until an owner turns it on).');
    return;
  }
  if (X.length < MIN_ROWS) {
    console.log(`\nNot saved: ${X.length} trips is under the ${MIN_ROWS} needed (--min-rows to change).`);
    return;
  }
  const { settings } = await pricingClient.loadSettings();
  await pricingClient.saveSettings({ ...settings, model }, 'train-pricing-model');
  console.log(`\nSaved. The model is ${settings.modelOn ? 'ON' : 'off: it is recorded beside every quote until an owner switches it on'}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
}
