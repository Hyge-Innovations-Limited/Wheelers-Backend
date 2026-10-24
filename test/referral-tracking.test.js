// Referrals, recorded and followed with nothing paid: a friend who joins with a
// code is counted, and marked when they ride, but no cashback is given (for a
// ride, for no ride, or by unfreezing old cashback) unless REFERRAL_REWARDS=on.
// The friend who rode is found however many others are still waiting.
// Against the local Postgres, with a built tree.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/referral-tracking.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { prisma, referralClient } = require('@wheleers/db');

const users = [];
const rides = [];

async function person(name = 'Ada Okafor') {
  const user = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'RIDER', name } });
  users.push(user.id);
  return user;
}

const code = () => `T${randomUUID().replace(/-/g, '').slice(0, 9).toUpperCase()}`;

async function completedRide(riderId, at) {
  const ride = await prisma.ride.create({
    data: {
      riderId, status: 'COMPLETED', channel: 'APP',
      pickupLat: 6.5, pickupLng: 3.38, pickupAddress: 'Yaba', destLat: 6.45, destLng: 3.43, destAddress: 'Ikoyi',
      fareEstimateNgn: 5000, riderOfferNgn: 5000, agreedFareNgn: 5000, fareFinalNgn: 5000,
      createdAt: at, completedAt: at,
    },
  });
  rides.push(ride.id);
  return ride;
}

/** A referrer with a code, and a friend who joined with it at `at`. */
async function referred(at = new Date()) {
  const owner = await person();
  const friend = await person('Bola');
  const own = await referralClient.setCustomCode(owner.id, code());
  const { referral } = await referralClient.applyCode({ referredUserId: friend.id, code: own.code, now: at });
  return { owner, friend, referral, code: own.code };
}

const cashbackOf = (userId) => prisma.referralCashback.findMany({ where: { userId } });

test.afterEach(() => { delete process.env.REFERRAL_REWARDS; });

test.after(async () => {
  await prisma.referralCashbackUnlock.deleteMany({ where: { referral: { referredUserId: { in: users } } } });
  await prisma.referralCashback.deleteMany({ where: { userId: { in: users } } });
  await prisma.referral.deleteMany({ where: { OR: [{ referrerId: { in: users } }, { referredUserId: { in: users } }] } });
  await prisma.ride.deleteMany({ where: { id: { in: rides } } });
  await prisma.referralCode.deleteMany({ where: { userId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
});

test('a friend who rides is marked as having ridden, and nobody is paid', async () => {
  const at = new Date(Date.now() - 2 * 86_400_000);
  const { owner, friend, referral } = await referred(at);
  const ride = await completedRide(friend.id, new Date(Date.now() - 86_400_000));
  await referralClient.settleQualifiedRideRewards(new Date());
  const after = await prisma.referral.findUnique({ where: { id: referral.id } });
  assert.equal(after.status, 'QUALIFIED_RIDE');
  assert.equal(after.firstRideId, ride.id);
  assert.deepEqual(await cashbackOf(owner.id), [], 'no cashback for the ride');
  const summary = await referralClient.findSummary(owner.id);
  assert.equal(summary.qualifiedReferrals, 1);
  assert.equal(summary.availableCashbackNgn, 0);
});

test('a friend who never rides is marked so after 30 days, and nobody is paid the ₦500', async () => {
  const { owner, referral } = await referred(new Date(Date.now() - 31 * 86_400_000));
  await referralClient.settleExpiredNoRideRewards(new Date());
  assert.equal((await prisma.referral.findUnique({ where: { id: referral.id } })).status, 'EXPIRED_NO_RIDE');
  assert.deepEqual(await cashbackOf(owner.id), []);
});

test('a new friend no longer unfreezes old cashback, which stays the person\'s, frozen as it was', async () => {
  const owner = await person();
  const own = await referralClient.setCustomCode(owner.id, code());
  const frozen = await prisma.referralCashback.create({
    data: { userId: owner.id, type: 'RIDE_QUALIFIED', amountNgn: 1000, remainingAmountNgn: 1000, status: 'FROZEN', frozenAt: new Date(), freezesAt: new Date() },
  });
  const friend = await person('Chidi');
  const result = await referralClient.applyCode({ referredUserId: friend.id, code: own.code });
  assert.equal(result.unlockedCashback, null);
  const still = await prisma.referralCashback.findUnique({ where: { id: frozen.id } });
  assert.equal(still.status, 'FROZEN');
  assert.equal(Number(still.remainingAmountNgn), 1000);
});

test('REFERRAL_REWARDS=on brings the ₦1,000 back', async () => {
  process.env.REFERRAL_REWARDS = 'on';
  const { owner, friend } = await referred(new Date(Date.now() - 2 * 86_400_000));
  await completedRide(friend.id, new Date(Date.now() - 86_400_000));
  await referralClient.settleQualifiedRideRewards(new Date());
  const given = await cashbackOf(owner.id);
  assert.equal(given.length, 1);
  assert.equal(Number(given[0].amountNgn), 1000);
});

test('a friend who rode is found however many others are still waiting (it read only the oldest)', async () => {
  // Five friends yet to ride, all older than the one who rode, and room for five.
  for (let i = 0; i < 5; i += 1) await referred(new Date(Date.UTC(2001, 0, 1 + i)));
  const { friend, referral } = await referred(new Date(Date.UTC(2002, 0, 1)));
  await completedRide(friend.id, new Date(Date.UTC(2002, 0, 3)));
  await referralClient.settleQualifiedRideRewards(new Date(), 5);
  assert.equal((await prisma.referral.findUnique({ where: { id: referral.id } })).status, 'QUALIFIED_RIDE');
});
