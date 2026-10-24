// The admin Referrals page: who brought whom, whether the friend rode, and the
// cashback it earned. Seeds referrals in a past week nobody else writes to and
// checks the numbers against ones worked out by hand. Needs the local Postgres
// (docker) with migrations applied, and a built tree.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const local = require('../apps/api-gateway/dist/auth/local.js');
const { handleAdminReferralsRoute } = require('../apps/api-gateway/dist/http/admin-referrals.route.js');

const prisma = new PrismaClient();
const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const DEPS = { adminApiKey: 'unused', jwtSecret: SECRET };
// 2 to 8 June 2024, Lagos days.
const FROM = '2024-06-02';
const TO = '2024-06-08';
const lagos = (day, hh = 12) => new Date(`${day}T${String(hh).padStart(2, '0')}:00:00+01:00`);

const seeded = { users: [], rides: [], admins: [] };
let server, base, owner, support, ids = {};

async function person(name, phone) {
  const u = await prisma.user.create({ data: { privyDid: `test:referrals:${randomUUID()}`, name, role: 'RIDER', phone } });
  seeded.users.push(u.id);
  return u;
}

async function completedRide(riderId, at, fare) {
  const r = await prisma.ride.create({
    data: {
      riderId, status: 'COMPLETED', channel: 'APP',
      pickupLat: 6.5, pickupLng: 3.38, pickupAddress: 'Yaba', destLat: 6.45, destLng: 3.43, destAddress: 'Ikoyi',
      fareEstimateNgn: fare, riderOfferNgn: fare, agreedFareNgn: fare, fareFinalNgn: fare,
      createdAt: at, completedAt: at,
    },
  });
  seeded.rides.push(r.id);
  return r;
}

async function referral(referrer, referred, code, appliedDay, extra = {}) {
  const appliedAt = lagos(appliedDay, extra.hour ?? 12);
  return prisma.referral.create({
    data: {
      referrerId: referrer.id, referredUserId: referred.id, code, appliedAt,
      expiresAt: new Date(appliedAt.getTime() + 30 * 86_400_000), closesAt: new Date(appliedAt.getTime() + 60 * 86_400_000),
      status: extra.status ?? 'PENDING', firstRideId: extra.firstRideId ?? null, qualifiedAt: extra.qualifiedAt ?? null,
    },
  });
}

async function get(path, admin = owner) {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${local.createLocalAccessToken(admin.id, SECRET, 3600)}` } });
  return { status: res.status, body: await res.json() };
}

test.before(async () => {
  owner = await prisma.adminUser.create({ data: { username: `referrals-owner-${Date.now()}`, passwordHash: 'x', name: 'Owner', role: 'OWNER' } });
  support = await prisma.adminUser.create({ data: { username: `referrals-support-${Date.now()}`, passwordHash: 'x', name: 'Desk', role: 'SUPPORT' } });
  seeded.admins.push(owner.id, support.id);

  // Ada brought three friends in the week, Bayo one; one more of Ada's is the week before.
  const ada = await person('Ada Referrer', '+2348031110001');
  const bayo = await person('Bayo Referrer', '+2348031110002');
  await prisma.referralCode.create({ data: { userId: ada.id, code: 'ADA2024' } });
  await prisma.referralCode.create({ data: { userId: bayo.id, code: 'BAYO24' } });
  // Chidi has a code and nobody has used it yet: still listed.
  const chidi = await person('Chidi Nocode', '+2348031110003');
  await prisma.referralCode.create({ data: { userId: chidi.id, code: 'CHIDI24' } });
  const f1 = await person('Friend One', '+2348039990001');
  const f2 = await person('Friend Two', '+2348039990002');
  const f3 = await person('Friend Three', '+2348039990003');
  const f4 = await person('Friend Four', '+2348039990004');
  const early = await person('Friend Early', '+2348039990005');
  ids = { ada: ada.id, bayo: bayo.id, chidi: chidi.id, f1: f1.id };

  // Friend One rode on day 2 (₦3,000), so Ada earned ₦1,000; Friend Two never rode (₦500); Three is waiting.
  const ride1 = await completedRide(f1.id, lagos('2024-06-04', 15), 3000);
  await completedRide(f1.id, lagos('2024-06-06', 9), 2500);
  const r1 = await referral(ada, f1, 'ADA2024', '2024-06-02', { status: 'QUALIFIED_RIDE', firstRideId: ride1.id, qualifiedAt: lagos('2024-06-04', 16) });
  const r2 = await referral(ada, f2, 'ADA2024', '2024-06-03', { status: 'EXPIRED_NO_RIDE' });
  await referral(ada, f3, 'ADA2024', '2024-06-08', { hour: 23 });
  await referral(bayo, f4, 'BAYO24', '2024-06-05');
  // 1 June 23:30 Lagos is 22:30 UTC: the day before the period, not inside it.
  await prisma.referral.create({
    data: { referrerId: ada.id, referredUserId: early.id, code: 'ADA2024', appliedAt: new Date('2024-06-01T22:30:00Z'), expiresAt: lagos('2024-07-01'), closesAt: lagos('2024-07-31') },
  });
  await prisma.referralCashback.create({ data: { userId: ada.id, sourceReferralId: r1.id, type: 'RIDE_QUALIFIED', amountNgn: 1000, remainingAmountNgn: 1000, freezesAt: lagos('2024-07-04'), createdAt: lagos('2024-06-04', 16) } });
  await prisma.referralCashback.create({ data: { userId: ada.id, sourceReferralId: r2.id, type: 'NO_RIDE_EXPIRED', amountNgn: 500, remainingAmountNgn: 500, freezesAt: lagos('2024-07-05'), createdAt: lagos('2024-06-05', 10) } });

  server = http.createServer((req, res) => {
    void handleAdminReferralsRoute(req, res, DEPS, new URL(req.url, 'http://x')).then((handled) => { if (!handled) { res.statusCode = 404; res.end('{}'); } });
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server?.close();
  await prisma.referralCashback.deleteMany({ where: { userId: { in: seeded.users } } });
  await prisma.referral.deleteMany({ where: { referrerId: { in: seeded.users } } });
  await prisma.referralCode.deleteMany({ where: { userId: { in: seeded.users } } });
  await prisma.ride.deleteMany({ where: { id: { in: seeded.rides } } });
  await prisma.user.deleteMany({ where: { id: { in: seeded.users } } });
  await prisma.adminUser.deleteMany({ where: { id: { in: seeded.admins } } });
  await prisma.$disconnect();
});

test('a week of referrals counted by hand: friends, who rode, the cashback, the top referrers and each day', async () => {
  const { status, body } = await get(`/admin/referrals?from=${FROM}&to=${TO}`);
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(
    { referred: body.summary.referred, referrers: body.summary.referrers, rode: body.summary.rode, noRide: body.summary.noRide, waiting: body.summary.waiting },
    { referred: 4, referrers: 2, rode: 1, noRide: 1, waiting: 2 },
    'the friend from 1 June 23:30 Lagos is not in the week; the one from 8 June 23:00 is',
  );
  assert.equal(body.summary.rodeRate, 0.5, 'of the two whose 30 days are settled, one rode');
  assert.equal(body.summary.avgDaysToFirstRide, 2.1);
  assert.equal(body.cashback.earnedNgn, 1500);
  assert.equal(body.cashback.earnedForRidesNgn, 1000);
  assert.equal(body.cashback.earnedNoRideNgn, 500);
  assert.equal(body.rules.rideRewardNgn, 1000);

  assert.equal(body.topReferrers[0].name, 'Ada Referrer');
  assert.equal(body.topReferrers[0].code, 'ADA2024');
  assert.deepEqual([body.topReferrers[0].referred, body.topReferrers[0].rode, body.topReferrers[0].earnedNgn], [3, 1, 1500]);
  assert.equal(body.topReferrers[1].name, 'Bayo Referrer');

  assert.equal(body.byDay.length, 7);
  assert.deepEqual(body.byDay.map((d) => d.referred), [1, 1, 0, 1, 0, 0, 1]);
  assert.equal(body.byDay.find((d) => d.day === '2024-06-04').rode, 1);

  assert.equal(body.referrals.total, 4);
  const first = body.referrals.rows.find((r) => r.referred.name === 'Friend One');
  assert.equal(first.status, 'QUALIFIED_RIDE');
  assert.equal(first.firstRide.fareNgn, 3000);
  assert.equal(first.friendTrips, 2);
  assert.deepEqual(first.cashback, { amountNgn: 1000, status: 'AVAILABLE' });
  assert.equal(body.referrals.rows[0].referred.name, 'Friend Three', 'newest first');
});

test('search by name, code or phone (0803… finds +234803…), filter by status, and page', async () => {
  const q = (params) => get(`/admin/referrals?${new URLSearchParams({ from: FROM, to: TO, ...params })}`);
  assert.equal((await q({ q: 'bayo' })).body.referrals.total, 1);
  assert.equal((await q({ q: 'BAYO24' })).body.referrals.total, 1);
  assert.equal((await q({ q: '08039990002' })).body.referrals.rows[0].referred.name, 'Friend Two');
  assert.equal((await q({ q: '100%' })).body.referrals.total, 0, 'a % in the search is a character, not a wildcard');
  assert.equal((await q({ status: 'PENDING' })).body.referrals.total, 2);
  const page = (await q({ limit: '3', offset: '3' })).body.referrals;
  assert.deepEqual([page.total, page.rows.length], [4, 1]);
});

test('bad input is refused, and the support desk cannot see it', async () => {
  assert.equal((await get(`/admin/referrals?from=${TO}&to=${FROM}`)).status, 400);
  assert.equal((await get(`/admin/referrals?from=${FROM}&to=${TO}&status=WON`)).status, 400);
  assert.notEqual((await get(`/admin/referrals?from=${FROM}&to=${TO}`, support)).status, 200);
});

test('every code, used or not: with each person\'s friends and cashback of all time; search and sort', async () => {
  const q = (params) => get(`/admin/referrals/codes?${new URLSearchParams(params)}`);
  const ours = (await q({ q: 'Referrer' })).body;
  assert.deepEqual(ours.rows.map((r) => [r.name, r.referred, r.rode, r.earnedNgn]), [['Ada Referrer', 4, 1, 1500], ['Bayo Referrer', 1, 0, 0]]);
  const chidi = (await q({ q: 'CHIDI24' })).body.rows;
  assert.deepEqual(chidi.map((r) => [r.name, r.referred, r.lastReferredAt]), [['Chidi Nocode', 0, null]], 'a code nobody used is listed too');
  assert.equal((await q({ q: '08031110002' })).body.rows[0].code, 'BAYO24');
  const newest = (await q({ q: 'nocode', sort: 'newest' })).body;
  assert.equal(newest.total, 1);
});

test('one person: their code, who brought them, every friend and how far they got, and every naira of cashback', async () => {
  const { status, body } = await get(`/admin/referrals/people/${ids.ada}`);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.code.code, 'ADA2024');
  assert.equal(body.broughtBy, null);
  assert.deepEqual(
    [body.summary.referred, body.summary.rode, body.summary.waiting, body.summary.noRide, body.summary.earnedNgn, body.summary.friendTrips],
    [4, 1, 2, 1, 1500, 2],
    'all time: the friend from before the week counts here',
  );
  assert.deepEqual(body.friends.map((f) => f.friend.name), ['Friend Three', 'Friend Two', 'Friend One', 'Friend Early'], 'newest first');
  const one = body.friends.find((f) => f.friend.name === 'Friend One');
  assert.deepEqual([one.status, one.firstRide.fareNgn, one.friendTrips, one.cashback.amountNgn], ['QUALIFIED_RIDE', 3000, 2, 1000]);
  assert.deepEqual(body.cashback.map((c) => [c.type, c.amountNgn, c.forFriend.name]).sort(), [['NO_RIDE_EXPIRED', 500, 'Friend Two'], ['RIDE_QUALIFIED', 1000, 'Friend One']]);
  assert.equal(body.rules.rideRewardNgn, 1000);

  const friend = (await get(`/admin/referrals/people/${ids.f1}`)).body;
  assert.deepEqual([friend.broughtBy.referrer.name, friend.broughtBy.code, friend.code], ['Ada Referrer', 'ADA2024', null]);
  const empty = (await get(`/admin/referrals/people/${ids.chidi}`)).body;
  assert.deepEqual([empty.summary.referred, empty.friends.length, empty.code.code], [0, 0, 'CHIDI24']);
  assert.equal((await get('/admin/referrals/people/00000000-0000-4000-8000-000000000000')).status, 404);
  assert.notEqual((await get(`/admin/referrals/people/${ids.ada}`, support)).status, 200);
});
