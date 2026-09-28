#!/usr/bin/env node
/**
 * Recompute every rating from the stored reviews.
 *
 * Until 28 Sep 2026 two bugs kept ratings wrong: WhatsApp ratings were never
 * stored at all, and a rider's rating of a driver (from the app or Claude) was
 * written to the driver's RIDER rating instead of their driver rating. The
 * reviews themselves were stored correctly, so both numbers can be rebuilt
 * from them:
 *
 *   driver rating  = average of what riders gave them    (5.0 with none)
 *   rider rating   = average of what drivers gave them   (5.0 with none)
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

const byRole = async (role) => {
  const rows = await prisma.$queryRaw`
    SELECT "revieweeId" AS id, avg(rating)::float8 AS avg, count(*)::int AS n
    FROM "Feedback" WHERE lower("reviewerRole") = ${role} GROUP BY 1`;
  return new Map(rows.map((r) => [r.id, { avg: round(r.avg), n: r.n }]));
};

const fromRiders = await byRole('rider');
const fromDrivers = await byRole('driver');

const drivers = await prisma.driver.findMany({ select: { id: true, userId: true, rating: true, ratingCount: true } });
const driverChanges = drivers
  .map((d) => ({ d, want: fromRiders.get(d.userId) ?? { avg: 5, n: 0 } }))
  .filter(({ d, want }) => round(d.rating) !== want.avg || d.ratingCount !== want.n);

const reviewed = [...new Set([...fromDrivers.keys(), ...fromRiders.keys()])];
const users = reviewed.length
  ? await prisma.user.findMany({ where: { id: { in: reviewed } }, select: { id: true, riderRating: true, riderRatingCount: true } })
  : [];
const riderChanges = users
  .map((u) => ({ u, want: fromDrivers.get(u.id) ?? { avg: 5, n: 0 } }))
  .filter(({ u, want }) => round(u.riderRating) !== want.avg || u.riderRatingCount !== want.n);

console.log(`reviews: ${[...fromRiders.values()].reduce((a, r) => a + r.n, 0)} by riders, ${[...fromDrivers.values()].reduce((a, r) => a + r.n, 0)} by drivers`);
console.log(`driver ratings to correct: ${driverChanges.length}`);
for (const { d, want } of driverChanges.slice(0, 20)) console.log(`  driver ${d.id}: ${d.rating} (${d.ratingCount}) -> ${want.avg} (${want.n})`);
console.log(`rider ratings to correct: ${riderChanges.length}`);
for (const { u, want } of riderChanges.slice(0, 20)) console.log(`  user ${u.id}: ${u.riderRating} (${u.riderRatingCount}) -> ${want.avg} (${want.n})`);

if (!confirm) {
  console.log('\nDry run: nothing changed. Run again with --confirm to apply.');
} else {
  for (const { d, want } of driverChanges) await prisma.driver.update({ where: { id: d.id }, data: { rating: want.avg, ratingCount: want.n } });
  for (const { u, want } of riderChanges) await prisma.user.update({ where: { id: u.id }, data: { riderRating: want.avg, riderRatingCount: want.n } });
  console.log(`\nApplied: ${driverChanges.length} driver ratings, ${riderChanges.length} rider ratings.`);
}
await prisma.$disconnect();
