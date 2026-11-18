// A group ride offer on WhatsApp (Timi, 17 Nov 2026): one form message (or two buttons until it is published),
// Ride together or No thanks inside it; a yes with no selfie sends a photo in the chat. Through the real form
// endpoint (a signed `grp:<userId>` token), a real Redis (database 15) and Postgres; Meta faked.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/group-ride-offer-chat.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

process.env.GROUP_RIDE_LIVE = 'on';
const { RedisClient } = require('../apps/api-gateway/dist/redis/client.js');
const live = require('../apps/api-gateway/dist/rides/group-live.js');
const { handleFlowAction } = require('../apps/api-gateway/dist/whatsapp-flows/flow-endpoint.js');
const { signFlowToken, verifyFlowToken } = require('../apps/api-gateway/dist/whatsapp-flows/encryption.js');
const { groupSelfieExpectedKey } = require('../apps/api-gateway/dist/whatsapp-flows/group-offer-flow.js');
const chat = require('../apps/api-gateway/dist/whatsapp/group-live-chat.js');

const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const prisma = new PrismaClient();
let redis;
const made = { users: [], rides: [] };

async function searching(name, { selfie = true } = {}) {
  const riderId = randomUUID();
  await prisma.user.create({ data: { id: riderId, privyDid: `test:group-chat:${riderId}`, role: 'RIDER', name, ...(selfie ? { groupSelfieKey: 'k', groupSelfieAt: new Date() } : {}) } });
  await prisma.wallet.create({ data: { userId: riderId, balanceNgn: 20000 } });
  made.users.push(riderId);
  const ride = await prisma.ride.create({ data: { riderId, status: 'MATCHING', paymentMethod: 'WALLET', riderOfferNgn: 12000, pickupLat: 6.5, pickupLng: 3.37, pickupAddress: 'Yaba', destLat: 6.62, destLng: 3.51, destAddress: 'Ikorodu Garage, Lagos' } });
  made.rides.push(ride.id);
  return { rideId: ride.id, riderId };
}
const offered = (a, b) => ({
  eventType: 'GROUP_RIDE_LIVE_OFFERED', groupId: randomUUID(), timestamp: new Date().toISOString(), rideIds: [a.rideId, b.rideId],
  members: [a, b].map((m) => ({ rideId: m.rideId, riderId: m.riderId, offerNgn: 12000, seatPriceNgn: 9000, soloSeconds: 3000, extraSeconds: 360 })),
  stops: [
    { rideId: a.rideId, kind: 'pickup', lat: 6.5, lng: 3.37, address: 'Yaba, Lagos' }, { rideId: b.rideId, kind: 'pickup', lat: 6.59, lng: 3.39, address: 'Ketu, Lagos' },
    { rideId: a.rideId, kind: 'dropoff', lat: 6.62, lng: 3.51, address: 'Ikorodu Garage, Lagos' }, { rideId: b.rideId, kind: 'dropoff', lat: 6.62, lng: 3.51, address: 'Ikorodu Garage, Lagos' },
  ],
  totalSeconds: 3200, savedSeconds: 2800,
});
const deps = () => ({ redisClient: redis, tokenSecret: SECRET, publisher: { publishRideEvent: async () => {} }, privateKeyPem: '', googleMapsApiKey: '', routePlanner: {} });
const form = (userId, data) => handleFlowAction(data ? { action: 'data_exchange', flow_token: signFlowToken(`grp:${userId}`, SECRET), screen: 'OFFER', data } : { action: 'INIT', flow_token: signFlowToken(`grp:${userId}`, SECRET) }, deps());

test.before(async () => {
  console.warn = () => {};
  redis = new RedisClient(process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15');
  await redis.connect();
  await redis.send('FLUSHDB');
  live.setGroupLiveHook(async () => {});
});

test('the form: who is going your way and the seat; Ride together with a selfie on file is in', async () => {
  const ada = await searching('Ada Obi');
  const chika = await searching('Chika Eze');
  await live.receiveGroupOffer(redis, offered(ada, chika), { schedule: () => {} });
  const screen = await form(ada.riderId);
  assert.equal(screen.screen, 'OFFER');
  assert.equal(screen.data.heading, '1 rider is going your way');
  assert.equal(screen.data.body, 'Chika (Ketu) is on your road to Ikorodu Garage.');
  assert.equal(screen.data.price, 'Ride together for ₦9,000 instead of ₦12,000, about 6 min more. You save ₦3,000. Faces checked.');
  assert.deepEqual(screen.data.choices.map((c) => c.id), ['join', 'decline']);
  const done = await form(ada.riderId, { choice: 'join' });
  assert.deepEqual([done.screen, done.data.headline], ['NOTE', "You're in"]);
  assert.equal(await live.answerOf(redis, (await live.offerForRide(redis, ada.rideId)).offerId, ada.rideId), 'join');
  const again = await form(ada.riderId);
  assert.deepEqual(again.data.choices.map((c) => c.id), ['close'], 'answered: nothing more to decide');
});

test('Ride together with no selfie: asked for a photo in the chat, the next photo is taken as it; No thanks keeps their search', async () => {
  const ada = await searching('Ada Obi', { selfie: false });
  const chika = await searching('Chika Eze');
  await live.receiveGroupOffer(redis, offered(ada, chika), { schedule: () => {} });
  const done = await form(ada.riderId, { choice: 'join' });
  assert.equal(done.data.headline, 'Send a selfie');
  assert.equal(await redis.get(groupSelfieExpectedKey(ada.riderId)), '1');
  const no = await form(chika.riderId, { choice: 'decline' });
  assert.equal(no.data.headline, 'No problem');
});

test('the chat message: the form when published, the two buttons when not; a button tap answers', async () => {
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => { if (String(url).startsWith('https://graph.facebook.com/')) { sent.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); } return realFetch(url, init); };
  const meta = { metaAccessToken: 't', metaPhoneNumberId: 'p', flowTokenSecret: SECRET };
  const view = { offerId: 'offer-1', riders: [{ you: true, name: 'You', pickup: 'Yaba' }, { you: false, name: 'Chika', pickup: 'Ketu' }], seatPriceNgn: 9000, ownPriceNgn: 12000, extraMinutes: 6 };
  try {
    delete process.env.WHATSAPP_GROUP_FLOW_ID;
    await chat.sendGroupOffer(meta, '+2348000000000', 'rider-1', view);
    assert.deepEqual(sent.at(-1).interactive.action.buttons.map((b) => b.reply.id), ['grp_join:offer-1', 'grp_decline:offer-1'], 'each button names its offer');
    assert.match(sent.at(-1).interactive.body.text, /^\*1 rider is going your way\*\nChika \(Ketu\) is on your road\./);
    process.env.WHATSAPP_GROUP_FLOW_ID = '777';
    await chat.sendGroupOffer(meta, '+2348000000000', 'rider-1', view);
    const f = sent.at(-1).interactive;
    assert.deepEqual([f.type, f.action.parameters.flow_cta], ['flow', 'Answer']);
    assert.equal(verifyFlowToken(f.action.parameters.flow_token, SECRET), 'grp:rider-1');

    const ada = await searching('Ada Obi');
    const chika = await searching('Chika Eze');
    await live.receiveGroupOffer(redis, offered(ada, chika), { schedule: () => {} });
    await chat.handleGroupLiveTap({ ...meta, redisClient: redis }, ada.riderId, '+2348000000000', 'grp_join:some-old-offer');
    assert.equal(sent.at(-1).text.body, 'This group ride offer has ended. Your own search goes on.', 'an old button answers nothing');
    const liveOffer = await live.offerForRide(redis, ada.rideId);
    await chat.handleGroupLiveTap({ ...meta, redisClient: redis }, ada.riderId, '+2348000000000', `grp_join:${liveOffer.offerId}`);
    assert.equal(sent.at(-1).text.body, "You're in. We'll tell you here when your group is set.");
    // A photo when no selfie is expected is not taken as one.
    assert.equal(await chat.handleGroupLivePhoto({ ...meta, redisClient: redis }, chika.riderId, '+2348000000000', 'media-1'), false);
  } finally {
    global.fetch = realFetch;
    delete process.env.WHATSAPP_GROUP_FLOW_ID;
  }
});

test.after(async () => {
  live.setGroupLiveHook(undefined);
  await prisma.userActivityEvent.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.wallet.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
  await redis.disconnect().catch(() => {});
});
