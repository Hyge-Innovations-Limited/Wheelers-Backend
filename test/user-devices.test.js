// Each person's devices (collected for their admin profile) and the link that follows a WhatsApp form that
// is never opened (WhatsApp Desktop, a second device). Real local Redis (db 15) and Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/user-devices.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { RedisClient } = require('../apps/api-gateway/dist/redis/client.js');
const { parseUserAgent, webReport, appReport, phoneNetworkOf } = require('../apps/api-gateway/dist/devices/device-report.js');
const { handleDeviceRoute } = require('../apps/api-gateway/dist/http/device.route.js');
const local = require('../apps/api-gateway/dist/auth/local.js');
const fallback = require('../apps/api-gateway/dist/whatsapp/form-fallback.js');
const { signFlowToken } = require('../apps/api-gateway/dist/whatsapp-flows/encryption.js');
const { extractMetaStatuses } = require('../apps/api-gateway/dist/whatsapp/parse.js');
const { userDeviceClient } = require('../packages/db/dist/index.js');

const prisma = new PrismaClient();
const JWT = 'test-secret-that-is-at-least-32-characters-long';
const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15';
let redis;
const users = [];

test.before(async () => { redis = new RedisClient(REDIS_URL); await redis.connect(); await redis.send('FLUSHDB'); });
test.after(async () => {
  await redis.send('FLUSHDB').catch(() => {});
  await redis.disconnect().catch(() => {});
  await prisma.userDevice.deleteMany({ where: { userId: { in: users } } });
  await prisma.wallet.deleteMany({ where: { userId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
});
async function person() {
  const id = randomUUID();
  users.push(id);
  await prisma.user.create({ data: { id, privyDid: `local:${id}`, role: 'RIDER', phone: `+23480${Math.floor(1e8 + Math.random() * 9e8)}` } });
  return id;
}

test('a browser describes itself: system, version, phone or computer, browser, and an older Android\'s model', () => {
  assert.deepEqual(parseUserAgent('Mozilla/5.0 (Linux; Android 10; SM-A107F Build/QP1A.190711.020) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.6045.163 Mobile Safari/537.36'),
    { platform: 'android', osVersion: '10', formFactor: 'phone', model: 'SM-A107F', browser: 'Chrome', browserVersion: '119' });
  const reduced = parseUserAgent('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36');
  assert.equal(reduced.model, null, '"K" is not a model');
  const iphone = parseUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1');
  assert.deepEqual([iphone.platform, iphone.osVersion, iphone.formFactor, iphone.browser], ['ios', '17.5.1', 'phone', 'Safari']);
  const pc = parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0');
  assert.deepEqual([pc.platform, pc.formFactor, pc.browser], ['windows', 'computer', 'Edge']);
  assert.equal(parseUserAgent('Mozilla/5.0 (Linux; Android 13; TECNO KI5k Build/TP1A; wv) AppleWebKit Chrome/120 Mobile').browser, 'Chrome (in-app)');
});

test('a page\'s report is cleaned: Chrome\'s exact model and version win, junk is dropped', () => {
  const r = webReport({ model: 'SM-A155F', platformVersion: '14.0.0', ramGb: 4, cores: 8, network: '3g', saveData: true, fromWhatsapp: true, screenW: 393, screenH: 873, dpr: 2.75, language: 'en-NG', timeZone: 'Africa/Lagos', evil: '<script>' },
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36');
  assert.deepEqual(r, { source: 'web', platform: 'android', osVersion: '14.0.0', model: 'SM-A155F', formFactor: 'phone', browser: 'Chrome', browserVersion: '130', ramGb: 4, cpuCores: 8, network: '3g', saveData: true, fromWhatsapp: true, language: 'en-NG', timeZone: 'Africa/Lagos', screen: '393x873@2.75' });
  const bad = webReport({ ramGb: 9999, cores: -1, network: '5g-turbo', model: '<img src=x onerror=alert(1)>'.repeat(5) }, '');
  assert.equal(bad.ramGb, null);
  assert.equal(bad.cpuCores, null);
  assert.equal(bad.network, null);
  assert.ok(!/[<>=]/.test(bad.model ?? ''), 'no markup kept');
  assert.equal(appReport({ platform: 'ANDROID', osVersion: '13', maker: 'Samsung', model: 'SM-A146B', appVersion: '1.4.2', appBuild: '88' }).platform, 'android');
});

test('the network from a Nigerian number (approximate), nothing for others', () => {
  assert.equal(phoneNetworkOf('+2348031234567'), 'MTN');
  assert.equal(phoneNetworkOf('2347081234567'), 'Airtel');
  assert.equal(phoneNetworkOf('08051234567'), 'Glo');
  assert.equal(phoneNetworkOf('+2349091234567'), '9mobile');
  assert.equal(phoneNetworkOf('+447700900123'), null);
});

test('POST /device/web and /device/app land on the person; a Trip chat link records nothing; one row per device', async () => {
  const userId = await person();
  const call = async (path, token, body, ua) => {
    const raw = [Buffer.from(JSON.stringify(body))];
    const req = { method: 'POST', headers: { authorization: `Bearer ${token}`, 'user-agent': ua }, async *[Symbol.asyncIterator]() { for (const c of raw) yield c; } };
    const res = { statusCode: 200, body: null, setHeader() {}, writeHead(c) { this.statusCode = c; return this; }, end(t) { this.body = t ?? null; } };
    await handleDeviceRoute(req, res, { jwtSecret: JWT }, new URL(`http://x${path}`));
    return res.statusCode;
  };
  const ua = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36';
  const ride = local.createWalletPageToken(userId, 'ride', JWT, 3600);
  assert.equal(await call('/device/web', ride, { model: 'SM-A155F', ramGb: 4 }, ua), 204);
  assert.equal(await call('/device/web', local.createWalletPageToken(userId, 'trip', JWT, 3600, randomUUID()), { model: 'OTHER' }, ua), 204);
  assert.equal(await call('/device/web', 'nonsense', {}, ua), 401);
  let rows = await userDeviceClient.listByUser(userId);
  assert.equal(rows.length, 1, 'the Trip chat link (shared with others) recorded nothing');
  assert.equal(rows[0].model, 'SM-A155F');
  // The same device again within 10 minutes is the same visit: not written twice.
  await call('/device/web', ride, { model: 'SM-A155F', ramGb: 4 }, ua);
  rows = await userDeviceClient.listByUser(userId);
  assert.equal(rows[0].timesSeen, 1);
  // A later report without a field never blanks it.
  await userDeviceClient.record(userId, { source: 'web', platform: 'android', model: 'SM-A155F', formFactor: 'phone', browser: 'Chrome' });
  rows = await userDeviceClient.listByUser(userId);
  assert.equal(rows[0].timesSeen, 2);
  assert.equal(rows[0].ramGb, 4);
});

test('a form never opened: read → 40 s → one link; twice → "forms do not open" and the link follows forms at once', async () => {
  await redis.send('FLUSHDB');
  const userId = await person();
  const phone = '2348031234567';
  const body = (token) => JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'interactive', interactive: { type: 'flow', action: { name: 'flow', parameters: { flow_token: token } } } });
  assert.deepEqual(fallback.formInMessage(body(signFlowToken(`menu:${userId}`, JWT)), JWT), { userId, phone, kind: 'menu' });
  assert.deepEqual(fallback.formInMessage(body(signFlowToken(userId, JWT)), JWT), { userId, phone, kind: 'search' });
  assert.equal(fallback.formInMessage(body(`menu:${userId}.forged0000000000`), JWT), null, 'a forged token is nobody');
  assert.equal(fallback.formInMessage(JSON.stringify({ to: phone, type: 'text', text: { body: 'hi' } }), JWT), null);

  const sent = [];
  const sendLink = async (u, p) => { sent.push([u, p]); return true; };
  const t0 = Date.parse('2026-11-10T10:00:00Z');
  await fallback.noteFormSent(redis, { userId, phone, kind: 'menu' }, t0);
  await fallback.noteStatus(redis, userId, 'delivered', t0 + 1000);
  await fallback.noteStatus(redis, userId, 'read', t0 + 5000);
  assert.deepEqual(await fallback.sweepFormChecks(redis, sendLink, t0 + 30_000), [], 'not yet');
  assert.deepEqual(await fallback.sweepFormChecks(redis, sendLink, t0 + 46_000), [{ userId, sent: true, closed: false }]);
  assert.deepEqual(sent, [[userId, phone]]);
  assert.deepEqual(await fallback.sweepFormChecks(redis, sendLink, t0 + 200_000), [], 'once');

  // Opened in time: nothing.
  await fallback.noteFormSent(redis, { userId, phone, kind: 'offers' }, t0 + 300_000);
  await fallback.noteStatus(redis, userId, 'read', t0 + 301_000);
  await fallback.noteFormOpened(redis, userId);
  assert.deepEqual(await fallback.sweepFormChecks(redis, sendLink, t0 + 400_000), []);
  assert.equal((await userDeviceClient.listByUser(userId)).find((d) => d.source === 'whatsapp').formsOpen, true);

  // Wrote in the chat: nothing.
  await fallback.noteFormSent(redis, { userId, phone, kind: 'menu' }, t0 + 500_000);
  await fallback.noteStatus(redis, userId, 'read', t0 + 501_000);
  await fallback.noteUserWrote(redis, userId);
  assert.deepEqual(await fallback.sweepFormChecks(redis, sendLink, t0 + 600_000), []);

  // Twice unopened (read receipts off: delivered + 90 s) → forms do not open.
  for (const at of [t0 + 700_000, t0 + 900_000]) {
    await fallback.noteFormSent(redis, { userId, phone, kind: 'menu' }, at);
    await fallback.noteStatus(redis, userId, 'delivered', at + 1000);
    assert.deepEqual(await fallback.sweepFormChecks(redis, sendLink, at + 60_000), [], 'delivered waits 90 s');
    await fallback.sweepFormChecks(redis, sendLink, at + 95_000);
  }
  assert.equal((await userDeviceClient.listByUser(userId)).find((d) => d.source === 'whatsapp').formsOpen, false);
  // From now on the link follows each form within seconds, no status needed.
  const before = sent.length;
  await fallback.noteFormSent(redis, { userId, phone, kind: 'offers' }, t0 + 2_000_000);
  await fallback.sweepFormChecks(redis, sendLink, t0 + 2_004_000);
  assert.equal(sent.length, before + 1);
  // The welcome form has no web page: counted, no link.
  await fallback.noteFormSent(redis, { userId, phone, kind: 'welcome' }, t0 + 3_000_000);
  const r = await fallback.sweepFormChecks(redis, sendLink, t0 + 3_004_000);
  assert.equal(r[0].sent, false);
});

test('WhatsApp status news is read: read and delivered, with their time', () => {
  const statuses = extractMetaStatuses({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { statuses: [
    { id: 'wamid.1', status: 'read', timestamp: '1762768800', recipient_id: '2348031234567' },
    { id: 'wamid.2', status: 'failed', recipient_id: '2348031234567' },
    { id: 'wamid.3', status: 'delivered', timestamp: '1762768790', recipient_id: '2348031234567' },
  ] } }] }] });
  assert.deepEqual(statuses, [{ to: '2348031234567', status: 'read', at: 1762768800000 }, { to: '2348031234567', status: 'delivered', at: 1762768790000 }]);
});
