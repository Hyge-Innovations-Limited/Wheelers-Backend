// Ride reactions as notifications (3 Nov 2026): the bot reacts to the rider's last message at the
// moments they wait for. Off unless WHATSAPP_RIDE_REACTIONS=on; once per moment per ride; never throws.
//
//   node --test test/ride-reactions.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { reactForRide, rememberLastInbound, lastInboundKey, RIDE_MOMENT_EMOJI } = require('../apps/api-gateway/dist/whatsapp-flows/ride-reactions.js');

function memoryRedis() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async set(k, v) { m.set(k, v); },
    async setIfNotExists(k, v) { if (m.has(k)) return false; m.set(k, v); return true; },
  };
}
const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; delete process.env.WHATSAPP_RIDE_REACTIONS; });
const meta = (redis) => ({ redisClient: redis, metaAccessToken: 't', metaPhoneNumberId: '99' });

test('the five moments and their emoji', () => {
  assert.deepEqual(RIDE_MOMENT_EMOJI, { requested: '👍', offer: '🙋', accepted: '🚗', arrived: '📍', done: '✅' });
});

test('off by default: nothing is sent', async () => {
  const redis = memoryRedis();
  await rememberLastInbound(redis, '+2348012345678', 'wamid.A');
  let calls = 0;
  global.fetch = async () => { calls += 1; return { ok: true }; };
  assert.equal(await reactForRide(meta(redis), '2348012345678', 'ride-1', 'accepted'), false);
  assert.equal(calls, 0);
});

test('on: a reaction to their last message, once per moment per ride; the same phone however it is written', async () => {
  process.env.WHATSAPP_RIDE_REACTIONS = 'on';
  const redis = memoryRedis();
  await rememberLastInbound(redis, '+2348012345678', 'wamid.A');
  await rememberLastInbound(redis, '2348012345678', 'wamid.B');
  assert.equal(await redis.get(lastInboundKey('+234 801 234 5678')), 'wamid.B', 'the newest message, by digits');
  const sent = [];
  global.fetch = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: true }; };
  assert.equal(await reactForRide(meta(redis), '+2348012345678', 'ride-1', 'arrived'), true);
  assert.equal(await reactForRide(meta(redis), '+2348012345678', 'ride-1', 'arrived'), false, 'a redelivered event reacts no more');
  assert.equal(await reactForRide(meta(redis), '+2348012345678', 'ride-1', 'done'), true, 'the next moment does');
  assert.equal(sent.length, 2);
  assert.match(sent[0].url, /graph\.facebook\.com\/v21\.0\/99\/messages$/);
  assert.deepEqual(sent[0].body, { messaging_product: 'whatsapp', recipient_type: 'individual', to: '2348012345678', type: 'reaction', reaction: { message_id: 'wamid.B', emoji: '📍' } });
});

test('nothing to react to, or Meta refuses, or the network fails: false, never a throw', async () => {
  process.env.WHATSAPP_RIDE_REACTIONS = 'on';
  const redis = memoryRedis();
  global.fetch = async () => ({ ok: true });
  assert.equal(await reactForRide(meta(redis), '2348000000000', 'ride-2', 'offer'), false, 'no message from them');
  await rememberLastInbound(redis, '2348000000000', 'wamid.C');
  global.fetch = async () => ({ ok: false, status: 400 });
  assert.equal(await reactForRide(meta(redis), '2348000000000', 'ride-2', 'offer'), false);
  global.fetch = async () => { throw new Error('offline'); };
  assert.equal(await reactForRide(meta(redis), '2348000000000', 'ride-2', 'accepted'), false);
  await rememberLastInbound(redis, '2348000000000', '');
  assert.equal(await redis.get(lastInboundKey('2348000000000')), 'wamid.C', 'an empty id (a replayed message) is not kept');
});
