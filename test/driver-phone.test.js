// A driver proves their phone number: a code goes to it by SMS and they type
// it back. A code lasts 30 minutes; a minute between sends; five codes in a
// session, and asking for a sixth stops them for 30 minutes; five wrong tries
// kill a code. SMS goes through the provider named in .env (Twilio until
// SMS_PROVIDER=termii), the other behind it, WhatsApp last.
// Against the local Postgres; Redis and the SMS providers are stood in for.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/driver-phone.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { prisma } = require('@wheleers/db');
const local = require('../apps/api-gateway/dist/auth/local.js');
const { handleDriverPhoneRoute, nigerianMobile, maskPhone } = require('../apps/api-gateway/dist/http/driver-phone.route.js');
const { availableChannels, smsChannels, deliverOtp } = require('../apps/api-gateway/dist/otp/channels.js');

const SECRET = 'test-secret-for-driver-phone-verification';
const TWILIO = { twilioAccountSid: 'ACtest', twilioAuthToken: 'tok', twilioFromNumber: '+18315550199' };
const TERMII = { termiiApiKey: 'tkey', termiiSenderId: 'Wheelers', termiiBaseUrl: 'https://termii.test' };
const META = { metaAccessToken: 'm', metaPhoneNumberId: '1' };

// Redis, with a clock the test moves.
let now = 1_800_000_000_000;
const store = new Map();
const live = (k) => { const e = store.get(k); if (e && e.until !== null && e.until <= now) store.delete(k); return store.get(k); };
const redis = {
  get: async (k) => live(k)?.value ?? null,
  set: async (k, v, ttl) => { store.set(k, { value: String(v), until: ttl ? now + ttl * 1000 : null }); },
  del: async (k) => { store.delete(k); },
  send: async (cmd, k, arg) => {
    const e = live(k);
    if (cmd === 'INCR' || cmd === 'DECR') { const v = Number(e?.value ?? 0) + (cmd === 'INCR' ? 1 : -1); store.set(k, { value: String(v), until: e?.until ?? null }); return v; }
    if (cmd === 'EXPIRE') { if (e) e.until = now + Number(arg) * 1000; return 1; }
    if (cmd === 'TTL') return !e ? -2 : e.until === null ? -1 : Math.ceil((e.until - now) / 1000);
    throw new Error(`fake redis: ${cmd}`);
  },
};
const forward = (seconds) => { now += seconds * 1000; };

// The SMS providers: every message "sent" is kept here.
const sms = [];
let failing = new Set();
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
  const provider = url.includes('twilio.com') ? 'twilio' : url.includes('termii.test') ? 'termii' : url.includes('facebook.com') ? 'meta' : 'other';
  if (failing.has(provider)) return { ok: false, status: 500, text: async () => '{"message":"down"}', json: async () => ({}) };
  if (provider === 'twilio') { const p = new URLSearchParams(init.body); sms.push({ provider, to: p.get('To'), from: p.get('From'), body: p.get('Body') }); }
  else if (provider === 'termii') { const p = JSON.parse(init.body); sms.push({ provider, to: p.to, from: p.from, body: p.sms, channel: p.channel }); }
  else if (provider === 'meta') { const p = JSON.parse(init.body); sms.push({ provider, to: p.to, body: p.text?.body }); }
  return { ok: true, status: 200, text: async () => '{"message_id":"1","message":"Successfully Sent"}', json: async () => ({}) };
};
const lastCode = () => /code is (\d{6})/.exec(sms.at(-1).body)[1];

const made = { users: [] };
let otp = { ...TWILIO };
let server; let base;

async function driver() {
  const user = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'DRIVER', name: 'Phone Driver' } });
  made.users.push(user.id);
  const row = await prisma.driver.create({ data: { userId: user.id } });
  return { id: row.id, userId: user.id, token: local.createLocalAccessToken(user.id, SECRET, 3600) };
}
// Each driver gets a number of their own, so tests do not collide on "already verified".
let serial = 0;
const freshNumber = () => `0803${String(1_000_000 + (Date.now() % 800_000) + serial++).slice(-7)}`;
const call = async (d, method, path, body) => {
  const res = await realFetch(base + path, { method, headers: { ...(d ? { authorization: `Bearer ${d.token}` } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() };
};
const send = (d, phone) => call(d, 'POST', '/drivers/phone/send-code', { phone });
const verify = (d, code) => call(d, 'POST', '/drivers/phone/verify-code', { code });

test.before(async () => {
  server = http.createServer((req, res) => {
    void handleDriverPhoneRoute(req, res, { jwtSecret: SECRET, redisClient: redis, otp }, new URL(req.url, 'http://x')).then((handled) => {
      if (!handled) { res.statusCode = 404; res.end('{}'); }
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(() => { sms.length = 0; failing = new Set(); otp = Object.assign(otp, { ...TWILIO, termiiApiKey: undefined, termiiSenderId: undefined, smsProvider: undefined, metaAccessToken: undefined, metaPhoneNumberId: undefined }); });

test('numbers: typed any usual way, a Nigerian mobile becomes +234…; anything else is refused', () => {
  for (const typed of ['08031234567', '8031234567', '2348031234567', '+2348031234567', '0803 123 4567', '(0803) 123-4567']) {
    assert.equal(nigerianMobile(typed), '+2348031234567', typed);
  }
  for (const typed of ['', '0803123456', '080312345678', '01234567890', '+14155550100', 'abc']) assert.equal(nigerianMobile(typed), null, typed);
  assert.equal(maskPhone('+2348031234567'), '0803 ••• 4567');
});

test('SMS goes through Twilio until .env says Termii; the other one stays behind it', async () => {
  assert.deepEqual(smsChannels({}), ['twilio_sms', 'termii_sms']);
  assert.deepEqual(smsChannels({ smsProvider: 'termii' }), ['termii_sms', 'twilio_sms']);
  assert.deepEqual(availableChannels({ ...TWILIO, ...TERMII }), ['twilio_sms', 'termii_sms']);
  assert.deepEqual(availableChannels({ ...TWILIO, ...TERMII, smsProvider: 'termii' }), ['termii_sms', 'twilio_sms']);
  assert.deepEqual(availableChannels({ ...TWILIO, smsProvider: 'termii' }), ['twilio_sms'], 'Termii chosen but not set up: Twilio carries on');
  assert.deepEqual(availableChannels({ ...TWILIO, termiiApiKey: 'k' }), ['twilio_sms'], 'a key without an approved sender name is not Termii yet');
  assert.deepEqual(availableChannels({ ...META, ...TWILIO, ...TERMII }), ['meta_whatsapp', 'twilio_sms', 'termii_sms'], 'the riders\' chain gets Termii too');

  const viaTermii = await deliverOtp({ ...TWILIO, ...TERMII, smsProvider: 'termii' }, { phone: '+2348031234567', code: '123456', body: 'hello' });
  assert.deepEqual([viaTermii.channel, viaTermii.medium], ['termii_sms', 'sms']);
  assert.deepEqual(sms.at(-1), { provider: 'termii', to: '2348031234567', from: 'Wheelers', body: 'hello', channel: 'dnd' }, 'no plus, the approved sender, the route that reaches DND numbers');

  failing = new Set(['termii']);
  const fellBack = await deliverOtp({ ...TWILIO, ...TERMII, smsProvider: 'termii' }, { phone: '+2348031234567', code: '123456', body: 'hello' });
  assert.equal(fellBack.channel, 'twilio_sms', 'Termii down: Twilio sends it');
  assert.equal(sms.at(-1).from, '+18315550199');
});

test('a driver sends a code to their number, types it back, and the number is saved as verified', async () => {
  const d = await driver();
  const number = freshNumber();
  assert.equal((await call(null, 'GET', '/drivers/phone')).status, 401);
  assert.deepEqual((await call(d, 'GET', '/drivers/phone')).body, { phone: null, verified: false, verifiedAt: null, codeSentTo: null, resendInSeconds: 0, lockedForSeconds: 0 });

  assert.equal((await send(d, '12345')).body.code, 'BAD_PHONE');
  const sent = await send(d, number);
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.body, { sentTo: maskPhone(nigerianMobile(number)), by: 'sms', expiresInMinutes: 30, resendInSeconds: 60, codesLeft: 4 });
  assert.equal(sms.length, 1);
  assert.equal(sms[0].to, nigerianMobile(number));
  assert.match(sms[0].body, /^Your Wheelers verification code is \d{6}\. This code expires in 30 minutes\. Do not share with anyone\.$/, 'the wording the networks approved');

  const wrong = await verify(d, '000000' === lastCode() ? '111111' : '000000');
  assert.deepEqual([wrong.status, wrong.body.code, wrong.body.triesLeft], [400, 'WRONG_CODE', 4]);
  assert.match(wrong.body.error, /not right.*4 tries left/);

  const right = await verify(d, lastCode());
  assert.deepEqual(right.body, { verified: true, phone: nigerianMobile(number) });
  const row = await prisma.driver.findUnique({ where: { id: d.id }, include: { user: true } });
  assert.equal(row.verifiedPhone, nigerianMobile(number));
  assert.ok(row.phoneVerifiedAt);
  assert.equal(row.user.phone, nigerianMobile(number), 'and it is the number on the account');
  const after = (await call(d, 'GET', '/drivers/phone')).body;
  assert.deepEqual([after.verified, after.phone, after.codeSentTo], [true, nigerianMobile(number), null]);
  assert.equal((await verify(d, lastCode())).body.code, 'CODE_EXPIRED', 'a code works once');

  // One number, one driver.
  const other = await driver();
  const taken = await send(other, number);
  assert.deepEqual([taken.status, taken.body.code], [409, 'PHONE_TAKEN']);
  assert.equal(sms.length, 1, 'no SMS is spent on a number that cannot be used');
});

test('a minute between sends; a code lasts 30 minutes; five wrong tries kill it', async () => {
  const d = await driver();
  const number = freshNumber();
  await send(d, number);
  const tooSoon = await send(d, number);
  assert.deepEqual([tooSoon.status, tooSoon.body.code], [429, 'WAIT_TO_RESEND']);
  assert.match(tooSoon.body.error, /another in 60 seconds/);
  assert.equal(tooSoon.body.retryAfterSeconds, 60);
  assert.equal((await call(d, 'GET', '/drivers/phone')).body.resendInSeconds, 60);

  forward(61);
  const first = lastCode();
  assert.equal((await send(d, number)).body.codesLeft, 3);
  if (first !== lastCode()) assert.equal((await verify(d, first)).body.code, 'WRONG_CODE', 'the new code replaces the old one');

  // Wrong five times (one may be used above): the code is dead.
  const bad = lastCode() === '999999' ? '888888' : '999999';
  let answer;
  for (let i = 0; i < 5; i++) { answer = await verify(d, bad); if (answer.body.code === 'CODE_DEAD') break; }
  assert.equal(answer.body.code, 'CODE_DEAD');
  assert.match(answer.body.error, /Too many wrong tries\. Ask for a new code\./);
  assert.equal((await verify(d, lastCode())).body.code, 'CODE_EXPIRED', 'even the right code is no use now');

  // A fresh code, left for half an hour: expired.
  forward(61);
  await send(d, number);
  const stale = lastCode();
  forward(30 * 60 + 1);
  const late = await verify(d, stale);
  assert.deepEqual([late.status, late.body.code], [400, 'CODE_EXPIRED']);
  assert.equal(late.body.error, 'That code has expired. Ask for a new one.');
});

test('five codes in a session; asking for a sixth stops the driver for 30 minutes, with the time left in the message', async () => {
  const d = await driver();
  const number = freshNumber();
  for (let i = 1; i <= 5; i++) {
    const ok = await send(d, number);
    assert.deepEqual([ok.status, ok.body.codesLeft], [200, 5 - i], `code ${i}`);
    forward(61);
  }
  assert.equal(sms.length, 5);

  const sixth = await send(d, number);
  assert.deepEqual([sixth.status, sixth.body.code, sixth.body.retryAfterSeconds], [429, 'TOO_MANY_CODES', 1800]);
  assert.equal(sixth.body.error, 'You have asked for 5 codes. For your security, wait 30 minutes before asking for another.');
  assert.equal(sms.length, 5, 'the sixth is not sent');

  // While stopped: no new code, and the last code no longer works either.
  forward(10 * 60);
  const still = await send(d, number);
  assert.deepEqual([still.status, still.body.code], [429, 'TOO_MANY_CODES']);
  assert.equal(still.body.error, 'You have asked for too many codes. For your security, wait 20 minutes and try again.');
  assert.equal(still.body.retryAfterSeconds, 1200);
  assert.equal((await verify(d, lastCode())).body.code, 'TOO_MANY_CODES');
  assert.equal((await call(d, 'GET', '/drivers/phone')).body.lockedForSeconds, 1200, 'the app can show the countdown');
  assert.equal(sms.length, 5);

  // Half an hour on, they start again with a full session.
  forward(20 * 60 + 1);
  const again = await send(d, number);
  assert.deepEqual([again.status, again.body.codesLeft], [200, 4]);
  assert.equal((await verify(d, lastCode())).body.verified, true);
});

test('a session is 30 minutes from the first code: after it, the count starts over without a timeout', async () => {
  const d = await driver();
  const number = freshNumber();
  for (let i = 0; i < 4; i++) { await send(d, number); forward(61); }
  forward(30 * 60);
  assert.equal((await send(d, number)).body.codesLeft, 4, 'four old asks have aged out');
});

test('when SMS cannot be sent the driver is told so, it does not count against them, and WhatsApp is the last resort', async () => {
  const d = await driver();
  const number = freshNumber();
  failing = new Set(['twilio']);
  const failed = await send(d, number);
  assert.deepEqual([failed.status, failed.body.code], [502, 'SEND_FAILED']);
  assert.equal(failed.body.error, 'We could not send a code to that number. Check the number, then try again in a moment.');
  assert.doesNotMatch(failed.body.error, /twilio|http|500/i, 'no provider names or status codes');
  failing = new Set();
  assert.equal((await send(d, number)).body.codesLeft, 4, 'the failed ask was not counted, and there is no minute to wait');

  // SMS down, WhatsApp set up: the code still arrives, and the app is told how.
  const e = await driver();
  Object.assign(otp, META);
  failing = new Set(['twilio']);
  const byWhatsapp = await send(e, freshNumber());
  assert.deepEqual([byWhatsapp.status, byWhatsapp.body.by], [200, 'whatsapp']);
  assert.equal(sms.at(-1).provider, 'meta');

  // Nothing set up at all.
  const f = await driver();
  Object.assign(otp, { twilioAccountSid: undefined, twilioAuthToken: undefined, twilioFromNumber: undefined, metaAccessToken: undefined, metaPhoneNumberId: undefined });
  const none = await send(f, freshNumber());
  assert.deepEqual([none.status, none.body.code], [503, 'SEND_UNAVAILABLE']);
});

test('with SMS_PROVIDER=termii a driver\'s code goes out through Termii, from the approved sender name', async () => {
  const d = await driver();
  Object.assign(otp, TERMII, { smsProvider: 'termii' });
  const number = freshNumber();
  assert.equal((await send(d, number)).status, 200);
  assert.deepEqual([sms.at(-1).provider, sms.at(-1).from, sms.at(-1).to], ['termii', 'Wheelers', nigerianMobile(number).slice(1)]);
  assert.equal((await verify(d, lastCode())).body.verified, true);
});

test.after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
  await prisma.userActivityEvent.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});
