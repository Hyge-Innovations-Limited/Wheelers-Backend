// A rider cancels in the chat and gives a reason: ONE message back, reason
// and refund together, not "Ride cancelled. Reason…" then "Your ride has
// been cancelled. Your ₦… is back…".
//
//   node --test test/cancel-message.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { sendRideCancelledNotification } = require('../apps/api-gateway/dist/whatsapp-flows/whatsapp-notifier.js');
const { rememberChatCancellation, takeChatCancellation } = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');

async function capture(fn) {
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const text = body.text?.body ?? body.interactive?.body?.text;
    if (text) sent.push(text);
    return { ok: true, json: async () => ({}), text: async () => '' };
  };
  try { await fn(); } finally { global.fetch = realFetch; }
  return sent;
}
const meta = { metaAccessToken: 't', metaPhoneNumberId: '1' };

test('cancelled in the chat with a reason: one message, the reason and the refund together', async () => {
  const sent = await capture(() => sendRideCancelledNotification(meta, '+2348000000000', {
    cancelledBy: 'rider', refundedNgn: 2500, balanceNgn: 2582.59, riderReason: 'Long waiting time',
  }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0], [
    '*Ride cancelled*',
    'Reason: Long waiting time',
    '',
    'Your ₦2,500 is back in your wallet (balance ₦2,582.59).',
    '',
    'Need another ride? Send your trip anytime.',
  ].join('\n'));
});

test('cancelled by the driver: their own opening line, and no rider reason', async () => {
  const [byDriver] = await capture(() => sendRideCancelledNotification(meta, '+2348000000000', { cancelledBy: 'driver', refundedNgn: 1000, balanceNgn: 5000 }));
  assert.match(byDriver, /^\*Your driver had to cancel\.\* Sorry about that\./);
  assert.doesNotMatch(byDriver, /Reason:/);
});

test('the reason waits for the refund message, which takes it once', async () => {
  const store = new Map();
  const redis = { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); }, del: async (k) => { store.delete(k); } };
  await rememberChatCancellation(redis, 'ride-1', '+2348000000000', 'Wrong pickup or destination point');
  assert.deepEqual(await takeChatCancellation(redis, 'ride-1'), { phone: '+2348000000000', reason: 'Wrong pickup or destination point' });
  assert.equal(await takeChatCancellation(redis, 'ride-1'), null, 'never twice');
});
