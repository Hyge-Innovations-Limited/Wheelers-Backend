// A push that goes nowhere must say so in the logs: no phone registered, or
// Expo accepted it but Google / Apple did not deliver it (the receipt).
//
//   npm -w @wheleers/notification-worker run build && node --test test/push-receipts.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { sendPush } = require('../apps/notification-worker/dist/expo-push.js');

function fakeExpo({ ticket, receipt }) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const data = url.endsWith('/getReceipts') ? { 'ticket-1': receipt } : [ticket];
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  return { calls, fetch };
}
function deps(fetch) {
  const said = { log: [], warn: [], delivered: [], disabled: [] };
  return {
    said,
    deps: {
      fetch,
      markDelivered: async (t) => said.delivered.push(t),
      disable: async (t) => said.disabled.push(t),
      log: (m) => said.log.push(m),
      warn: (m) => said.warn.push(m),
      later: (fn) => fn(),
    },
  };
}
const msg = { title: 'Ride near you', body: 'Akoka → Yaba', priority: 'high' };
const phone = [{ expoPushToken: 'ExponentPushToken[abc123def456ghi789jkl]' }];

test('no phone registered: nothing sent, and the log says why', async () => {
  const expo = fakeExpo({});
  const { said, deps: d } = deps(expo.fetch);
  assert.equal(await sendPush(d, 'user-1', [], msg), 0);
  assert.equal(expo.calls.length, 0);
  assert.match(said.log[0], /no phone registered/);
});

test('Expo took it but Android credentials are missing: the receipt is read and the log says what to fix', async () => {
  const expo = fakeExpo({ ticket: { status: 'ok', id: 'ticket-1' }, receipt: { status: 'error', message: 'Unable to retrieve the FCM server key', details: { error: 'InvalidCredentials' } } });
  const { said, deps: d } = deps(expo.fetch);
  await sendPush(d, 'user-1', phone, msg);
  await new Promise((r) => setImmediate(r));
  assert.equal(expo.calls[1].url.endsWith('/getReceipts'), true);
  assert.deepEqual(expo.calls[1].body, { ids: ['ticket-1'] });
  assert.match(said.warn.join('\n'), /NOT delivered \(receipt\).*InvalidCredentials.*FCM V1/);
  assert.equal(said.delivered.length, 0);
});

test('delivered: noted on the device; an uninstalled app: its token switched off', async () => {
  const ok = fakeExpo({ ticket: { status: 'ok', id: 'ticket-1' }, receipt: { status: 'ok' } });
  const a = deps(ok.fetch);
  await sendPush(a.deps, 'user-1', phone, msg);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(a.said.delivered, [phone[0].expoPushToken]);
  assert.equal(a.said.warn.length, 0);

  const gone = fakeExpo({ ticket: { status: 'ok', id: 'ticket-1' }, receipt: { status: 'error', details: { error: 'DeviceNotRegistered' } } });
  const b = deps(gone.fetch);
  await sendPush(b.deps, 'user-1', phone, msg);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(b.said.disabled, [phone[0].expoPushToken]);
});
