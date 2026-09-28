// A rider's rating reaches their driver's rating; the repair script rebuilds
// ratings stored wrongly before the fix.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/ratings.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');
const { complianceClient } = require('../packages/db/dist/index.js');

const prisma = new PrismaClient();
const made = { users: [], rides: [] };

async function person(role) {
  const u = await prisma.user.create({ data: { privyDid: `test:ratings:${randomUUID()}`, name: 'Rating Test', role } });
  made.users.push(u.id);
  if (role === 'DRIVER') await prisma.driver.create({ data: { userId: u.id, kycStatus: 'APPROVED' } });
  return u;
}
async function ride(riderId) {
  const r = await prisma.ride.create({ data: { riderId, status: 'COMPLETED', pickupLat: 6.5, pickupLng: 3.37, pickupAddress: 'A', destLat: 6.45, destLng: 3.43, destAddress: 'B' } });
  made.rides.push(r.id);
  return r;
}

test.after(async () => {
  await prisma.feedback.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.driver.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

test("a rider's rating moves the driver's rating, not the driver's rider rating", async () => {
  const rider = await person('RIDER');
  const driverUser = await person('DRIVER');
  const r1 = await ride(rider.id);
  const r2 = await ride(rider.id);
  await complianceClient.recordFeedbackAndAggregate({ id: randomUUID(), rideId: r1.id, reviewerId: rider.id, reviewerRole: 'rider', revieweeId: driverUser.id, rating: 3 });
  await complianceClient.recordFeedbackAndAggregate({ id: randomUUID(), rideId: r2.id, reviewerId: rider.id, reviewerRole: 'rider', revieweeId: driverUser.id, rating: 4 });
  const driver = await prisma.driver.findUnique({ where: { userId: driverUser.id } });
  assert.deepEqual([driver.rating, driver.ratingCount], [3.5, 2]);
  const user = await prisma.user.findUnique({ where: { id: driverUser.id } });
  assert.deepEqual([user.riderRating, user.riderRatingCount], [5, 0], 'their rider rating is untouched');

  // A driver rating their rider goes to the rider's rating.
  await complianceClient.recordFeedbackAndAggregate({ id: randomUUID(), rideId: r1.id, reviewerId: driverUser.id, reviewerRole: 'driver', revieweeId: rider.id, rating: 2 });
  const riderAfter = await prisma.user.findUnique({ where: { id: rider.id } });
  assert.deepEqual([riderAfter.riderRating, riderAfter.riderRatingCount], [2, 1]);
});

test('the repair script rebuilds a rating stored in the wrong place, and only with --confirm', async () => {
  const rider = await person('RIDER');
  const driverUser = await person('DRIVER');
  const r = await ride(rider.id);
  // What the bug did: the review is stored, but it landed on the rider rating.
  await prisma.feedback.create({ data: { id: randomUUID(), rideId: r.id, reviewerId: rider.id, reviewerRole: 'rider', revieweeId: driverUser.id, rating: 2 } });
  await prisma.user.update({ where: { id: driverUser.id }, data: { riderRating: 2, riderRatingCount: 1 } });

  const run = (...args) => execFileSync('node', ['scripts/run-with-env.cjs', 'node', 'scripts/recompute-ratings.mjs', ...args], { encoding: 'utf8' });
  assert.match(run(), /Dry run: nothing changed/);
  assert.equal((await prisma.driver.findUnique({ where: { userId: driverUser.id } })).rating, 5, 'a dry run changes nothing');

  assert.match(run('--confirm'), /Applied/);
  const driver = await prisma.driver.findUnique({ where: { userId: driverUser.id } });
  const user = await prisma.user.findUnique({ where: { id: driverUser.id } });
  assert.deepEqual([driver.rating, driver.ratingCount, user.riderRating, user.riderRatingCount], [2, 1, 5, 0]);
  assert.match(run(), /driver ratings to correct: 0/, 'running it again finds nothing');
});
