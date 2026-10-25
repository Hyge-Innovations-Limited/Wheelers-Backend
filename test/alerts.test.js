// Telegram alerts (packages/config, alerts.ts): what leaves the server is
// masked, the same problem is one alert however often it happens, a storm is
// capped, and nothing is sent without the settings or outside pm2.
//
//   node --test test/alerts.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('@wheleers/config');

test('phone numbers, keys, tokens, PINs and one-time codes are hidden; an error code stays', () => {
  const masked = config.maskSecrets([
    'rider +2348031234567 and 08031234567',
    'paystack sk_live_abc123def456 Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
    'meta EAAWVRx1234567890abcdefghijk termii tlv_KOArb0jK9tcXN4TMH',
    'pin: 1234 password="hunter2" codeHash=abcd',
    'Your Wheelers verification code is 613349.',
    '{"code": 131042, "title": "Business eligibility payment issue"}',
  ].join('\n'));
  assert.doesNotMatch(masked, /8031234567|sk_live_abc|eyJhbG|EAAWVR|tlv_KO|1234\b|hunter2|613349/);
  assert.match(masked, /\+234803•••••67/);
  assert.match(masked, /"code": 131042/, "Meta's reason code is what the alert is for");
});

test('the same problem has the same fingerprint, whatever its numbers, ids and quoted values', () => {
  const a = config.fingerprint('[otp] termii_sms failed for ride 3f2b8c1e-1111-4a2b-9c3d-123456789abc after 1200 ms "x"');
  const b = config.fingerprint('[otp] termii_sms failed for ride 9a9a9a9a-2222-4b2b-8c3d-abcdefabcdef after 87 ms "y"');
  assert.equal(a, b);
  assert.notEqual(a, config.fingerprint('[otp] meta_whatsapp failed'));
});

test('without a token and chat, or outside pm2, nothing is sent and console is untouched', async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  const before = console.error;
  config.startAlerts('test');
  assert.equal(console.error, before);
  assert.equal(await config.sendAlert('nothing'), false);
});

test('under pm2: an error is sent once, its repeats counted, warnings only when watched, masked on the way', async () => {
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).includes('api.telegram.org')) { sent.push(JSON.parse(init.body)); return new Response('{"ok":true}', { status: 200 }); }
    return realFetch(url, init);
  };
  const realError = console.error; const realWarn = console.warn;
  console.error = () => {}; console.warn = () => {};
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = '12345';
  process.env.pm_id = '0';
  try {
    config.startAlerts('api-gateway');
    console.error('[payments] webhook failed for +2348031234567', new Error('boom'));
    console.error('[payments] webhook failed for +2348039999999', new Error('boom'));
    console.warn('[ride] nothing to see');
    console.warn('[whatsapp] Meta could not deliver a message', { errors: [{ code: 131042 }] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(sent.length, 2, JSON.stringify(sent.map((m) => m.text.split('\n')[0])));
    assert.equal(sent[0].chat_id, '12345');
    assert.match(sent[0].text, /🔴 api-gateway: \[payments\] webhook failed/);
    assert.doesNotMatch(sent[0].text, /8031234567/);
    assert.match(sent[1].text, /🟠 api-gateway: \[whatsapp\] Meta could not deliver/);
    assert.match(sent[1].text, /131042/);
  } finally {
    global.fetch = realFetch;
    console.error = realError; console.warn = realWarn;
    delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_CHAT_ID; delete process.env.pm_id;
  }
});
