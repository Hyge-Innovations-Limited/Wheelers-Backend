#!/usr/bin/env node
/**
 * Recompute every rating from the stored reviews.
 *
 * Until 28 Sep 2026 three bugs kept ratings wrong:
 *   1. WhatsApp ratings were never stored at all (nothing to repair: they are gone).
 *   2. A rider's rating of a driver was written to the driver's RIDER rating.
 *   3. A driver's rating of a rider was labelled as a rider's review: the driver
 *      app sends 'DRIVER' and the server only knew 'driver'.
 *
 * So the label on a review cannot be trusted. Who reviewed whom is read from
 * the ride instead: the ride's rider reviewing is a rider's review of the
 * driver; the ride's driver reviewing is a driver's review of the rider. Then:
 *
 *   driver rating  = average of what riders gave them    (5.0 with none)
 *   rider rating   = average of what drivers gave them   (5.0 with none)
 *
 * and each review's label is corrected to match.
 *
 *   node scripts/run-with-env.cjs node scripts/recompute-ratings.mjs            # shows what would change
 *   node scripts/run-with-env.cjs node scripts/recompute-ratings.mjs --confirm  # changes it
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');

const confirm = process.argv.includes('--confirm');
const prisma = new PrismaClient();
const round = (n) => Math.round(n * 100) / 100;

// Every review, with who it really came from according to its ride.
const reviews = await prisma.$queryRaw`
  SELECT f.id, f."reviewerId" AS reviewer, f."revieweeId" AS reviewee, f."reviewerRole" AS label, f.rating,
         CASE WHEN f."reviewerId" = r."riderId" THEN 'rider'
              WHEN f."reviewerId" = d."userId" THEN 'driver'
              ELSE NULL END AS actual
  FROM "Feedback" f
  LEFT JOIN "Ride" r ON r.id = f."rideId"
  LEFT JOIN "Driver" d ON d.id = r."driverId"`;

const unknown = reviews.filter((r) => !r.actual);
const relabel = reviews.filter((r) => r.actual && String(r.label).toLowerCase() !== r.actual);

const averages = (role) => {
  const sums = new Map();
  for (const r of reviews.filter((x) => x.actual === role)) {
    const s = sums.get(r.reviewee) ?? { total: 0, n: 0 };
    s.total += Number(r.rating);
    s.n += 1;
    sums.set(r.reviewee, s);
  }
  return new Map([...sums].map(([id, s]) => [id, { avg: round(s.total / s.n), n: s.n }]));
};
const fromRiders = averages('rider');
const fromDrivers = averages('driver');

const drivers = await prisma.driver.findMany({ select: { id: true, userId: true, rating: true, ratingCount: true } });
const driverChanges = drivers
  .map((d) => ({ d, want: fromRiders.get(d.userId) ?? { avg: 5, n: 0 } }))
  .filter(({ d, want }) => round(d.rating) !== want.avg || d.ratingCount !== want.n);

const reviewed = [...new Set(reviews.map((r) => r.reviewee))];
const users = reviewed.length
  ? await prisma.user.findMany({ where: { id: { in: reviewed } }, select: { id: true, riderRating: true, riderRatingCount: true } })
  : [];
const riderChanges = users
  .map((u) => ({ u, want: fromDrivers.get(u.id) ?? { avg: 5, n: 0 } }))
  .filter(({ u, want }) => round(u.riderRating) !== want.avg || u.riderRatingCount !== want.n);

const count = (role) => reviews.filter((r) => r.actual === role).length;
console.log(`reviews: ${reviews.length} — ${count('rider')} by riders of their driver, ${count('driver')} by drivers of their rider${unknown.length ? `, ${unknown.length} whose ride cannot say (left alone)` : ''}`);
console.log(`reviews with the wrong label: ${relabel.length}`);
console.log(`driver ratings to correct: ${driverChanges.length}`);
for (const { d, want } of driverChanges.slice(0, 20)) console.log(`  driver ${d.id}: ${d.rating} (${d.ratingCount}) -> ${want.avg} (${want.n})`);
console.log(`rider ratings to correct: ${riderChanges.length}`);
for (const { u, want } of riderChanges.slice(0, 20)) console.log(`  user ${u.id}: ${u.riderRating} (${u.riderRatingCount}) -> ${want.avg} (${want.n})`);

if (!confirm) {
  console.log('\nDry run: nothing changed. Run again with --confirm to apply.');
} else {
  for (const r of relabel) await prisma.feedback.update({ where: { id: r.id }, data: { reviewerRole: r.actual } });
  for (const { d, want } of driverChanges) await prisma.driver.update({ where: { id: d.id }, data: { rating: want.avg, ratingCount: want.n } });
  for (const { u, want } of riderChanges) await prisma.user.update({ where: { id: u.id }, data: { riderRating: want.avg, riderRatingCount: want.n } });
  console.log(`\nApplied: ${relabel.length} labels, ${driverChanges.length} driver ratings, ${riderChanges.length} rider ratings.`);
}
await prisma.$disconnect();
