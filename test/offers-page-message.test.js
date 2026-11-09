// "Your bid is in": no amount on it, it says what to tap, its button opens the
// offers page, and the number of offers waiting shows as a reaction on it —
// changing in place, never a new message.
//
//   node --test test/offers-page-message.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../apps/api-gateway/dist/whatsapp-flows/offers-page-message.js');

function memoryRedis() {
  const store = new Map();
  return { store, async get(k) { return store.has(k) ? store.get(k) : null; }, async set(k, v) { store.set(k, v); }, async del(k) { store.delete(k); } };
}
function fakeMeta() {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return { ok: true, status: 200, text: async () => '', json: async () => ({ messages: [{ id: 'wamid.BID' }] }) };
  };
  return { calls, restore: () => { global.fetch = realFetch; } };
}
const deps = (redis) => ({ redis, meta: { metaAccessToken: 't', metaPhoneNumberId: '1' } });

test('the message: no amount, what to tap, and a button to the offers page', async () => {
  const text = m.bidPlacedText({ pickupAddress: '9 Tayo Joseph St, Idimu', destAddress: 'Megida bus stop, Ipaja' });
  assert.match(text, /^\*Your bid is in\*/);
  assert.doesNotMatch(text, /₦/);
  assert.match(text, /Tap \*See driver offers\* to pick a driver, change your price or cancel/);

  const redis = memoryRedis();
  const meta = fakeMeta();
  try {
    assert.equal(await m.sendOffersPageMessage(deps(redis), '+2348000000000', 'ride-1', 'https://w.example/widget/ride/ride.html#t=x', { pickupAddress: 'A', destAddress: 'B' }), true);
  } finally { meta.restore(); }
  assert.equal(meta.calls[0].interactive.type, 'cta_url');
  assert.equal(meta.calls[0].interactive.action.parameters.display_text, 'See driver offers');
  assert.equal(await m.hasOffersPageMessage(redis, 'ride-1'), true);
});

test('the count: 1️⃣ 2️⃣ … 🔟, only when it changes, gone when the search ends', async () => {
  assert.deepEqual([0, 1, 2, 9, 10, 14].map(m.offerCountEmoji), ['', '1️⃣', '2️⃣', '9️⃣', '🔟', '🔟']);
  const redis = memoryRedis();
  const sending = fakeMeta();
  try { await m.sendOffersPageMessage(deps(redis), '+2348000000000', 'ride-2', 'https://w.example/x', { pickupAddress: 'A', destAddress: 'B' }); } finally { sending.restore(); }

  const meta = fakeMeta();
  try {
    await m.showOfferCount(deps(redis), 'ride-2', 1);
    await m.showOfferCount(deps(redis), 'ride-2', 1);
    await m.showOfferCount(deps(redis), 'ride-2', 3);
    await m.showOfferCount(deps(redis), 'ride-2', 0);
    await m.showOfferCount(deps(redis), 'ride-2', 2);
    await m.clearOfferCount(deps(redis), 'ride-2');
  } finally { meta.restore(); }
  assert.deepEqual(meta.calls.map((c) => [c.type, c.reaction.message_id, c.reaction.emoji]), [
    ['reaction', 'wamid.BID', '1️⃣'],
    ['reaction', 'wamid.BID', '3️⃣'],
    ['reaction', 'wamid.BID', ''],
    ['reaction', 'wamid.BID', '2️⃣'],
    ['reaction', 'wamid.BID', ''],
  ], 'one reaction per change; none for a repeat');
  assert.equal(await m.hasOffersPageMessage(redis, 'ride-2'), false, 'forgotten when the search ends');
  assert.equal(await m.showOfferCount(deps(redis), 'ride-3', 2), false, 'no message, nothing to show it on');
});
