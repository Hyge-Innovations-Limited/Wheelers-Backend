// The waiting price as one WhatsApp form (Timi, 16 Nov 2026): the question at 5 minutes and the driver's counter
// are one form message each; picking a price, taking the driver's price and cancelling happen inside the form.
// Without the form published (or if Meta refuses it), the buttons as before. Through the real form endpoint
// (handleFlowAction, a signed `wait:<userId>` token), a real Redis (database 15) and a real Postgres; Meta faked.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/waiting-flow.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const { RedisClient } = require('../apps/api-gateway/dist/redis/client.js');
const { handleFlowAction } = require('../apps/api-gateway/dist/whatsapp-flows/flow-endpoint.js');
const { signFlowToken, verifyFlowToken } = require('../apps/api-gateway/dist/whatsapp-flows/encryption.js');
const { setActiveRide, getActiveRide, takeChatCancellation } = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');
const { actOnWaiting, setWaitingDealHook } = require('../apps/api-gateway/dist/rides/waiting-deal.js');
const chat = require('../apps/api-gateway/dist/whatsapp/waiting-deal-chat.js');
const { CANCELLATION_REASONS } = require('../apps/api-gateway/dist/whatsapp/parse.js');

const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15';
const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const prisma = new PrismaClient();
const minutesAgo = (m) => new Date(Date.now() - m * 60_000);
const def = require('../apps/api-gateway/src/whatsapp-flows/waiting-flow-definition.json');

let redis;
const published = [];
const made = { users: [], rides: [] };
async function user(role, name, phone = null) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:waiting-flow:${id}`, role, name, phone } });
  made.users.push(id);
  return id;
}
async function waitingTrip({ arrivedAt = minutesAgo(6), status = 'ARRIVED' } = {}) {
  const riderId = await user('RIDER', 'Ada Obi', `+23480${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`);
  const driverUserId = await user('DRIVER', 'Tunde Bakare');
  const driver = await prisma.driver.create({ data: { userId: driverUserId, kycStatus: 'APPROVED' } });
  const ride = await prisma.ride.create({ data: {
    riderId, driverId: driver.id, status, arrivedAt, paymentMethod: 'WALLET', channel: 'WHATSAPP',
    pickupLat: 6.5, pickupLng: 3.37, pickupAddress: 'Yaba', destLat: 6.62, destLng: 3.5, destAddress: 'Ikorodu',
  } });
  made.rides.push(ride.id);
  await setActiveRide(redis, riderId, ride.id);
  return { rideId: ride.id, riderId, driverUserId, driverId: driver.id };
}
const deps = () => ({ redisClient: redis, tokenSecret: SECRET, publisher: { publishRideEvent: async (e) => { published.push(e); }, publishDriverEvent: async () => {} }, privateKeyPem: '', googleMapsApiKey: '', routePlanner: {} });
const token = (userId) => signFlowToken(`wait:${userId}`, SECRET);
const open = (userId) => handleFlowAction({ action: 'INIT', flow_token: token(userId) }, deps());
const send = (userId, screen, data) => handleFlowAction({ action: 'data_exchange', flow_token: token(userId), screen, data }, deps());
const ids = (screen) => screen.data.choices.map((c) => c.id);

test.before(async () => {
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};
  redis = new RedisClient(REDIS_URL);
  await redis.connect();
  await redis.send('FLUSHDB');
  setWaitingDealHook(async () => {});
});

test('the form as Meta shows it: opens on PRICE; endings are a NOTE to swipe away; DONE only because a form needs a last screen', () => {
  assert.deepEqual(def.routing_model, { PRICE: ['CANCEL', 'NOTE', 'DONE'], CANCEL: ['NOTE', 'DONE'], NOTE: [], DONE: [] });
  assert.equal(def.screens[0].id, 'PRICE');
  const screen = (id) => def.screens.find((s) => s.id === id);
  assert.equal(screen('DONE').terminal, true);
  assert.equal(screen('NOTE').terminal, false);
  assert.doesNotMatch(JSON.stringify(screen('NOTE')), /"complete"/, 'nothing completes the form');
  const footer = (id) => screen(id).layout.children[0].children.find((c) => c.type === 'Footer');
  assert.deepEqual(footer('PRICE')['on-click-action'].payload, { action: 'wait_price', choice: '${form.choice}' });
  assert.deepEqual(footer('CANCEL')['on-click-action'].payload, { action: 'wait_cancel', reason: '${form.reason}' });
});

test('the question: the seven prices and Cancel ride; a price sent is a NOTE and the offer is on the table', async () => {
  const trip = await waitingTrip();
  const first = await open(trip.riderId);
  assert.equal(first.screen, 'PRICE');
  assert.equal(first.data.heading, 'Keep your driver waiting');
  assert.deepEqual(ids(first), ['rate:40', 'rate:50', 'rate:60', 'rate:70', 'rate:80', 'rate:90', 'rate:100', 'cancel']);
  for (const c of first.data.choices) assert.ok(c.title.length <= 30, c.title);

  const sent = await send(trip.riderId, 'PRICE', { choice: 'rate:60' });
  assert.deepEqual([sent.screen, sent.data.headline, sent.data.note], ['NOTE', 'Sent ₦60/min', "We'll message you when your driver answers."]);
  const row = await prisma.ride.findUnique({ where: { id: trip.rideId } });
  assert.deepEqual([row.waitingOfferBy, row.waitingOfferNgn, row.waitingRateNgn], ['RIDER', 60, null]);

  const again = await open(trip.riderId);
  assert.equal(again.data.heading, 'You offered ₦60/min');
  assert.equal(again.data.choices.find((c) => c.id === 'rate:60').description, 'Your offer');
});

test('the driver\'s counter: their price first as Accept; Accept agrees exactly that price; after it, only Close', async () => {
  const trip = await waitingTrip();
  await send(trip.riderId, 'PRICE', { choice: 'rate:50' });
  await actOnWaiting(trip.rideId, trip.driverUserId, { action: 'offer', ngn: 80 });

  const answer = await open(trip.riderId);
  assert.equal(answer.data.heading, 'Your driver asks ₦80/min');
  assert.deepEqual(ids(answer), ['accept:80', 'rate:40', 'rate:50', 'rate:60', 'rate:70', 'rate:90', 'rate:100', 'cancel']);
  assert.equal(answer.data.choices[0].title, 'Accept ₦80/min');

  const agreed = await send(trip.riderId, 'PRICE', { choice: 'accept:80' });
  assert.deepEqual([agreed.screen, agreed.data.headline], ['NOTE', 'Agreed: ₦80/min']);
  assert.equal((await prisma.ride.findUnique({ where: { id: trip.rideId } })).waitingRateNgn, 80);

  const after = await open(trip.riderId);
  assert.deepEqual([after.screen, after.data.heading, ids(after)], ['PRICE', 'Agreed: ₦80/min', ['close']]);
  assert.equal((await send(trip.riderId, 'PRICE', { choice: 'close' })).screen, 'NOTE');
});

test('a form left open while the price changed: Accept of the old price stays on the screen with why, showing the new one', async () => {
  const trip = await waitingTrip();
  await send(trip.riderId, 'PRICE', { choice: 'rate:40' });
  await actOnWaiting(trip.rideId, trip.driverUserId, { action: 'offer', ngn: 90 });
  const stale = await send(trip.riderId, 'PRICE', { choice: 'accept:70' });
  assert.equal(stale.screen, 'PRICE');
  assert.equal(stale.data.error, 'That price has changed.');
  assert.equal(stale.data.heading, 'Your driver asks ₦90/min');
  assert.equal((await prisma.ride.findUnique({ where: { id: trip.rideId } })).waitingRateNgn, null, 'nothing agreed');
  const junk = await send(trip.riderId, 'PRICE', { choice: 'rate:65' });
  assert.equal(junk.data.error, 'Pick a price from ₦40 to ₦100 a minute.');
});

test('Cancel ride: the chat\'s own reasons, then the chat\'s own cancel (the reason kept for the refund message)', async () => {
  const trip = await waitingTrip();
  const reasons = await send(trip.riderId, 'PRICE', { choice: 'cancel' });
  assert.equal(reasons.screen, 'CANCEL');
  assert.deepEqual(reasons.data.reasons.map((r) => r.title), Object.values(CANCELLATION_REASONS));
  assert.equal((await send(trip.riderId, 'CANCEL', { reason: '' })).data.error, 'Pick a reason.');

  published.length = 0;
  // A double tap: both at once, one cancel.
  const [done, twice] = await Promise.all([send(trip.riderId, 'CANCEL', { reason: '1' }), send(trip.riderId, 'CANCEL', { reason: '1' })]);
  assert.equal(twice.data.headline, 'Ride cancelled');
  assert.deepEqual([done.screen, done.data.headline], ['NOTE', 'Ride cancelled']);
  assert.equal(published.length, 1);
  assert.deepEqual([published[0].eventType, published[0].rideId, published[0].cancelledBy, published[0].reason, published[0].driverId], ['RIDE_CANCELLED', trip.rideId, 'rider', 'Long waiting time', trip.driverId]);
  const kept = await takeChatCancellation(redis, trip.rideId);
  assert.equal(kept.reason, 'Long waiting time');
  assert.ok(kept.phone.startsWith('+23480'));
  assert.equal(await getActiveRide(redis, trip.riderId), null, 'the chat no longer points at the ride');
});

test('nothing to decide: still free, the trip started, no ride; nothing is cancelled from an old form', async () => {
  const early = await waitingTrip({ arrivedAt: minutesAgo(2) });
  const free = await open(early.riderId);
  assert.deepEqual([free.data.heading, ids(free)], ['Waiting is still free', ['close']]);

  const started = await waitingTrip({ status: 'IN_PROGRESS' });
  assert.deepEqual(ids(await open(started.riderId)), ['close']);
  published.length = 0;
  const late = await send(started.riderId, 'CANCEL', { reason: '1' });
  assert.deepEqual([late.screen, late.data.headline], ['NOTE', 'Nothing to cancel here']);
  assert.equal(published.length, 0, 'a running trip is never cancelled from this form');
  assert.equal((await send(started.riderId, 'PRICE', { choice: 'rate:60' })).data.heading, 'Nothing to decide here');

  const nobody = await user('RIDER', 'No Ride');
  assert.deepEqual(ids(await open(nobody)), ['close']);
  // A token for one rider never reaches another's ride.
  const forged = await handleFlowAction({ action: 'INIT', flow_token: `wait:${early.riderId}.0000000000000000` }, deps());
  assert.equal(forged.screen, 'SUCCESS');
});

test('the chat messages: the form when it is published (Choose, Answer), the buttons when it is not or Meta refuses it', async () => {
  const sent = [];
  let refuseForm = false;
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (!String(url).startsWith('https://graph.facebook.com/')) return realFetch(url, init);
    const body = JSON.parse(init.body);
    sent.push(body);
    const isForm = body.interactive?.type === 'flow';
    return new Response('{}', { status: isForm && refuseForm ? 400 : 200 });
  };
  const meta = { metaAccessToken: 't', metaPhoneNumberId: 'p', flowTokenSecret: SECRET };
  const before = process.env.WHATSAPP_WAITING_FLOW_ID;
  try {
    delete process.env.WHATSAPP_WAITING_FLOW_ID;
    await chat.sendWaitingAsk(meta, '+2348000000000', 'rider-1', 5);
    assert.equal(sent.at(-1).interactive.type, 'button', 'not published: the buttons');

    process.env.WHATSAPP_WAITING_FLOW_ID = '123456';
    sent.length = 0;
    await chat.sendWaitingAsk(meta, '+2348000000000', 'rider-1', 5);
    const ask = sent.at(-1).interactive;
    assert.equal(ask.type, 'flow');
    assert.equal(ask.body.text, '*Your driver has waited 5 min*\nKeep them waiting for a price a minute, or cancel. Nothing is charged until you both agree.');
    assert.deepEqual([ask.action.parameters.flow_id, ask.action.parameters.flow_cta, ask.action.parameters.flow_action], ['123456', 'Choose', 'data_exchange']);
    assert.equal(verifyFlowToken(ask.action.parameters.flow_token, SECRET), 'wait:rider-1');
    assert.equal(sent.length, 1, 'one message');

    await chat.sendDriverCounter(meta, '+2348000000000', 'rider-1', 80);
    const counter = sent.at(-1).interactive;
    assert.deepEqual([counter.type, counter.action.parameters.flow_cta], ['flow', 'Answer']);
    assert.match(counter.body.text, /^\*Your driver asks ₦80\/min\*/);

    refuseForm = true;
    sent.length = 0;
    await chat.sendDriverCounter(meta, '+2348000000000', 'rider-1', 80);
    assert.deepEqual(sent.map((m) => m.interactive?.type), ['flow', 'button'], 'refused: the buttons right after');
    assert.equal(sent[1].interactive.action.buttons[0].reply.id, 'wait_ok:80');
  } finally {
    global.fetch = realFetch;
    if (before === undefined) delete process.env.WHATSAPP_WAITING_FLOW_ID; else process.env.WHATSAPP_WAITING_FLOW_ID = before;
  }
});

test('a forged price never lands: a chat button for ₦5/min is refused, nothing goes on the table', async () => {
  const trip = await waitingTrip();
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => { if (String(url).startsWith('https://graph.facebook.com/')) { sent.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); } return realFetch(url, init); };
  try {
    await chat.handleWaitingDealTap({ metaAccessToken: 't', metaPhoneNumberId: 'p' }, trip.riderId, '+2348000000000', 'wait_rate:5', async () => {});
    assert.equal(sent.at(-1).text.body, 'Pick a price from ₦40 to ₦100 a minute.');
  } finally {
    global.fetch = realFetch;
  }
  const row = await prisma.ride.findUnique({ where: { id: trip.rideId } });
  assert.deepEqual([row.waitingOfferNgn, row.waitingOfferCount], [null, 0]);
});

test.after(async () => {
  setWaitingDealHook(undefined);
  await prisma.userActivityEvent.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.driver.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
  await redis.disconnect().catch(() => {});
});
