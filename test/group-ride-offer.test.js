// Group ride on live searches, the offer (Timi, 16-17 Nov 2026): the gateway holds each search in one offer at a
// time, asks the riders, takes each rider's first answer, and decides once: formed (2 or more said yes and are still
// searching) or dropped (every search goes on as before). No money, no driver. Real Redis (database 15) and Postgres,
// the race cases run at the same moment.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/group-ride-offer.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

process.env.GROUP_RIDE_LIVE = 'on';
const { RedisClient } = require('../apps/api-gateway/dist/redis/client.js');
const live = require('../apps/api-gateway/dist/rides/group-live.js');

const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15';
const prisma = new PrismaClient();
let redis;
const made = { users: [], rides: [] };
const changes = [];
const scheduled = [];

async function searching(extra = {}) {
  const riderId = randomUUID();
  const { balanceNgn = 20000, phone = null, selfie = true, ...rideExtra } = extra;
  await prisma.user.create({ data: { id: riderId, privyDid: `test:group-offer:${riderId}`, role: 'RIDER', name: 'Ada Obi', phone, ...(selfie ? { groupSelfieKey: `live-${riderId}/selfie.jpg`, groupSelfieAt: new Date() } : {}) } });
  await prisma.wallet.create({ data: { userId: riderId, balanceNgn } });
  made.users.push(riderId);
  const ride = await prisma.ride.create({ data: {
    riderId, status: 'MATCHING', paymentMethod: 'WALLET', riderOfferNgn: 12000,
    pickupLat: 6.5095, pickupLng: 3.3711, pickupAddress: 'Yaba, Lagos', destLat: 6.619, destLng: 3.51, destAddress: 'Ikorodu Garage', ...rideExtra,
  } });
  made.rides.push(ride.id);
  return { rideId: ride.id, riderId };
}
function offered(members) {
  return {
    eventType: 'GROUP_RIDE_LIVE_OFFERED', groupId: randomUUID(), timestamp: new Date().toISOString(),
    rideIds: members.map((m) => m.rideId),
    members: members.map((m, i) => ({ rideId: m.rideId, riderId: m.riderId, offerNgn: 12000 - i * 3000, seatPriceNgn: 9000 - i * 2250, soloSeconds: 3000, extraSeconds: 60 })),
    stops: [...members.map((m) => ({ rideId: m.rideId, kind: 'pickup', lat: 6.5, lng: 3.37, address: 'Ketu, Lagos' })), ...members.map((m) => ({ rideId: m.rideId, kind: 'dropoff', lat: 6.62, lng: 3.51, address: 'Ikorodu' }))],
    totalSeconds: 3200, savedSeconds: 2800,
  };
}
const opts = () => ({ schedule: (fn, ms) => scheduled.push({ fn, ms }) });

test.before(async () => {
  console.warn = () => {};
  redis = new RedisClient(REDIS_URL);
  await redis.connect();
  await redis.send('FLUSHDB');
  live.setGroupLiveHook(async (change) => { changes.push(change); });
});

test('offered: every member held and asked; their view shows the seat, the others\' pickups, the 20 s', async () => {
  const a = await searching();
  const b = await searching();
  changes.length = 0;
  const offer = await live.receiveGroupOffer(redis, offered([a, b]), opts());
  assert.ok(offer);
  assert.ok(Date.parse(offer.expiresAt) - Date.parse(offer.createdAt) === 20_000);
  assert.equal((await live.offerForRide(redis, a.rideId)).offerId, offer.offerId);
  assert.equal(changes.at(-1).kind, 'offered');
  const view = await live.offerViewFor(redis, offer, a.rideId, new Map([[b.riderId, 'Chika']]));
  assert.deepEqual([view.ownPriceNgn, view.seatPriceNgn, view.savedNgn, view.answer], [12000, 9000, 3000, null]);
  assert.deepEqual(view.riders.map((r) => [r.name, r.pickup]), [['You', 'Ketu'], ['Chika', 'Ketu']]);
  assert.deepEqual(scheduled.slice(-2).map((x) => x.ms), [21_500, 81_500], 'decided when the 20 s are up, and when the selfie time is');
});

test('a search in one offer is never in another at the same moment; all or none are held', async () => {
  const a = await searching();
  const b = await searching();
  const c = await searching();
  const [one, two] = await Promise.all([live.receiveGroupOffer(redis, offered([a, b]), opts()), live.receiveGroupOffer(redis, offered([a, c]), opts())]);
  assert.equal([one, two].filter(Boolean).length, 1, 'one offer wins the shared search');
  const loser = one ? c : b;
  assert.equal(await live.offerForRide(redis, loser.rideId), null, 'the losing offer let its other search go');
  // A booked search is never offered.
  const booked = await searching({ status: 'DRIVER_ASSIGNED' });
  const d = await searching();
  assert.equal(await live.receiveGroupOffer(redis, offered([booked, d]), opts()), null);
  assert.equal(await live.offerForRide(redis, d.rideId), null);
});

test('both say Ride together: formed once, even with two gateways deciding at the same moment', async () => {
  const a = await searching();
  const b = await searching();
  const offer = await live.receiveGroupOffer(redis, offered([a, b]), opts());
  changes.length = 0;
  await Promise.all([live.answerGroupOffer(redis, a.rideId, a.riderId, 'join'), live.answerGroupOffer(redis, b.rideId, b.riderId, 'join')]);
  const extra = await Promise.all([live.resolveGroupOffer(redis, offer.offerId), live.resolveGroupOffer(redis, offer.offerId)]);
  assert.deepEqual(extra, [null, null], 'already decided');
  const formed = changes.filter((c) => c.kind === 'formed');
  assert.equal(formed.length, 1);
  assert.deepEqual(new Set(formed[0].joined.map((m) => m.rideId)), new Set([a.rideId, b.rideId]));
  assert.equal(await redis.get(`gl:hold:${a.rideId}`), `group:${offer.offerId}`, 'the seats stay held for the booking');
  await assert.rejects(live.answerGroupOffer(redis, a.rideId, a.riderId, 'decline'), (e) => e.code === 'NO_OFFER');
});

test('one No in a pair: dropped at once, both searches free; the first answer counts, a change is refused', async () => {
  const a = await searching();
  const b = await searching();
  const offer = await live.receiveGroupOffer(redis, offered([a, b]), opts());
  await live.answerGroupOffer(redis, a.rideId, a.riderId, 'join');
  await live.answerGroupOffer(redis, a.rideId, a.riderId, 'join');
  await assert.rejects(live.answerGroupOffer(redis, a.rideId, a.riderId, 'decline'), (e) => e.code === 'ANSWERED');
  changes.length = 0;
  await live.answerGroupOffer(redis, b.rideId, b.riderId, 'decline');
  assert.deepEqual(changes.map((c) => [c.kind, c.reason]), [['answered', undefined], ['dropped', 'declined']]);
  assert.equal(await redis.get(`gl:hold:${a.rideId}`), null);
  assert.equal(await redis.get(`gl:hold:${b.rideId}`), null);
  await assert.rejects(live.answerGroupOffer(redis, b.rideId, a.riderId, 'join'), (e) => e.code === 'NO_OFFER' || e.code === 'NOT_YOURS');
  assert.ok(offer);
});

test('three asked, two say yes, one says nothing: formed with the two when the 20 s are up', async () => {
  const [a, b, c] = [await searching(), await searching(), await searching()];
  let t = Date.now();
  const offer = await live.receiveGroupOffer(redis, offered([a, b, c]), { ...opts(), now: () => t });
  await live.answerGroupOffer(redis, a.rideId, a.riderId, 'join', { now: () => t });
  await live.answerGroupOffer(redis, b.rideId, b.riderId, 'join', { now: () => t });
  assert.equal(await live.resolveGroupOffer(redis, offer.offerId, { now: () => t }), null, 'still time for the third');
  t += 21_000;
  await assert.rejects(live.answerGroupOffer(redis, c.rideId, c.riderId, 'join', { now: () => t }), (e) => e.code === 'EXPIRED');
  const done = await live.resolveGroupOffer(redis, offer.offerId, { now: () => t });
  assert.equal(done.kind, 'formed');
  assert.deepEqual(new Set(done.joined.map((m) => m.rideId)), new Set([a.rideId, b.rideId]));
  assert.equal(await redis.get(`gl:hold:${c.rideId}`), null, 'the one who said nothing is free');
});

test('a rider who books a driver alone during the offer is left out; with only one left it is dropped', async () => {
  const a = await searching();
  const b = await searching();
  const offer = await live.receiveGroupOffer(redis, offered([a, b]), opts());
  await live.answerGroupOffer(redis, a.rideId, a.riderId, 'join');
  await prisma.ride.update({ where: { id: b.rideId }, data: { status: 'DRIVER_ASSIGNED' } });
  changes.length = 0;
  await live.answerGroupOffer(redis, b.rideId, b.riderId, 'join');
  assert.equal(changes.at(-1).kind, 'dropped');
  assert.equal(changes.at(-1).reason, 'search_moved_on');
  assert.equal(await redis.get(`gl:hold:${a.rideId}`), null);
  assert.ok(offer);
});

test('a rider who said No thanks is not asked again this search; nobody is asked more than twice', async () => {
  const a = await searching();
  const b = await searching();
  const c = await searching();
  await live.receiveGroupOffer(redis, offered([a, b]), opts());
  await live.answerGroupOffer(redis, b.rideId, b.riderId, 'decline');
  assert.equal(await live.receiveGroupOffer(redis, offered([b, c]), opts()), null, 'b said No');
  // a: asked once already; one more, then never.
  const second = await live.receiveGroupOffer(redis, offered([a, c]), opts());
  assert.ok(second);
  await live.resolveGroupOffer(redis, second.offerId, { now: () => Date.now() + 30_000 });
  const d = await searching();
  assert.equal(await live.receiveGroupOffer(redis, offered([a, d]), opts()), null, 'a has been asked twice');
});

test('only riders whose wallet covers their seat, and only listed test phones while the list is set', async () => {
  const short = await searching({ balanceNgn: 5000 });
  const b = await searching();
  assert.equal(await live.receiveGroupOffer(redis, offered([short, b]), opts()), null, 'a ₦9,000 seat, ₦5,000 in the wallet');
  assert.equal(await live.offerForRide(redis, b.rideId), null);

  const listed = await searching({ phone: '+2348012345678' });
  const other = await searching({ phone: '+2348099999999' });
  process.env.GROUP_RIDE_LIVE_PHONES = '08012345678, +2348099999998';
  try {
    assert.equal(await live.receiveGroupOffer(redis, offered([listed, other]), opts()), null, 'one is not on the list');
    assert.equal(live.onTestList('+2348012345678'), true);
    assert.equal(live.onTestList('+2348099999999'), false);
    assert.equal(live.onTestList(null), false);
  } finally {
    delete process.env.GROUP_RIDE_LIVE_PHONES;
  }
  assert.equal(live.onTestList('+2348099999999'), true, 'no list: everyone');
});

test('a yes with no selfie: 60 s to take one; taken, the group forms at once; never taken, it does not', async () => {
  const a = await searching();
  const b = await searching({ selfie: false });
  let t = Date.now();
  const offer = await live.receiveGroupOffer(redis, offered([a, b]), { ...opts(), now: () => t });
  assert.deepEqual(scheduled.slice(-2).map((x) => x.ms), [21_500, 81_500], 'decided at the 20 s, and again when the selfie time is up');
  await live.answerGroupOffer(redis, a.rideId, a.riderId, 'join', { now: () => t });
  const answered = await live.answerGroupOffer(redis, b.rideId, b.riderId, 'join', { now: () => t });
  assert.equal(answered.selfieNeeded, true);
  const view = await live.offerViewFor(redis, offer, b.rideId);
  assert.equal(view.selfieNeeded, true);
  t += 25_000;
  assert.equal(await live.resolveGroupOffer(redis, offer.offerId, { now: () => t }), null, 'waiting on the selfie');
  changes.length = 0;
  await prisma.user.update({ where: { id: b.riderId }, data: { groupSelfieKey: 'k', groupSelfieAt: new Date() } });
  await live.selfieTaken(redis, b.riderId, { now: () => t });
  assert.equal(changes.at(-1).kind, 'formed');

  const c = await searching();
  const d = await searching({ selfie: false });
  t = Date.now();
  const second = await live.receiveGroupOffer(redis, offered([c, d]), { ...opts(), now: () => t });
  await live.answerGroupOffer(redis, c.rideId, c.riderId, 'join', { now: () => t });
  await live.answerGroupOffer(redis, d.rideId, d.riderId, 'join', { now: () => t });
  t += 82_000;
  const done = await live.resolveGroupOffer(redis, second.offerId, { now: () => t });
  assert.deepEqual([done.kind, done.reason], ['dropped', 'no_selfie']);
  assert.equal(await redis.get(`gl:hold:${c.rideId}`), null);
});

test('switched off: an offer is never held or asked', async () => {
  const a = await searching();
  const b = await searching();
  process.env.GROUP_RIDE_LIVE = 'dryrun';
  try {
    assert.equal(await live.receiveGroupOffer(redis, offered([a, b]), opts()), null);
    assert.equal(await redis.get(`gl:hold:${a.rideId}`), null);
  } finally {
    process.env.GROUP_RIDE_LIVE = 'on';
  }
});

test.after(async () => {
  live.setGroupLiveHook(undefined);
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.wallet.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
  await redis.disconnect().catch(() => {});
});
