// The "My referral code" row in every Quick Actions menu: View code once created, never Create again,
// Try again on a read error, a second create returns the existing code, and the code shows with the flag off.
//
//   npm run build && node scripts/run-with-env.cjs node --test --test-force-exit --test-concurrency=1 test/quick-actions-referral-row.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { prisma, referralClient } = require('@wheleers/db');
const { handleQuickActionsFlow } = require('../apps/api-gateway/dist/whatsapp-flows/quick-actions-flow.js');

function memoryRedis() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v) { store.set(k, v); },
    async del(k) { store.delete(k); },
    async setIfNotExists(k, v) { if (store.has(k)) return false; store.set(k, v); return true; },
    async send() { return null; },
  };
}
const made = [];
const flowFor = (redis) => (userId, body) => handleQuickActionsFlow({ version: '3.0', flow_token: 'x', ...body }, userId, { redisClient: redis, publisher: { publishRideEvent: async () => {} } });
const row = (screen) => screen.data.choices.find((c) => c.id === 'my_code');
const newUser = async (n) => {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:refrow:${id}`, role: 'RIDER', name: 'Row Test', phone: `+23480${n}${Math.floor(1000000 + Math.random() * 8999999)}` } });
  made.push(id);
  return id;
};
const uniq = () => `RW${Math.floor(1000 + Math.random() * 9000)}`;
const menuTap = (flow, userId, choice) => flow(userId, { action: 'data_exchange', screen: 'MENU', data: { choice } });

test.after(async () => {
  await prisma.referralCode.deleteMany({ where: { userId: { in: made } } });
  await prisma.user.deleteMany({ where: { id: { in: made } } });
  await prisma.$disconnect();
});

test('INIT -> Create -> save -> INIT shows View code, never Create; View opens the QR + link', async () => {
  process.env.WHATSAPP_QUICK_ACTIONS_SHARE = 'on';
  const flow = flowFor(memoryRedis());
  const userId = await newUser(31);
  const first = await flow(userId, { action: 'INIT' });
  assert.deepEqual([row(first).title, row(first).description], ['My referral code', 'Create yours']);
  const form = await menuTap(flow, userId, 'my_code');
  assert.equal(form.data.action, 'save_my_code');
  const code = uniq();
  const saved = await flow(userId, { action: 'data_exchange', screen: 'REFERRAL', data: { action: 'save_my_code', code } });
  assert.equal(saved.screen, 'NOTE');
  const again = await flow(userId, { action: 'INIT' });
  assert.equal(row(again).description, `View code · ${code}`);
  assert.ok(!JSON.stringify(again.data.choices).match(/create/i));
  const view = await menuTap(flow, userId, 'my_code');
  assert.equal(view.screen, 'NOTE');
  assert.equal(view.data.has_share, true);
  assert.match(view.data.note, new RegExp(`wa\\.me/\\d+\\?text=REF-${code}`));
});

test('a read error never shows Create: Try again, then a short error; saving during it creates nothing', async () => {
  const flow = flowFor(memoryRedis());
  const userId = await newUser(32);
  const real = referralClient.findOwnCode;
  referralClient.findOwnCode = async () => { throw new Error(`db down for ${userId}`); };
  const logged = [];
  const realErr = console.error;
  console.error = (...a) => logged.push(a);
  try {
    const menu = await flow(userId, { action: 'INIT' });
    assert.deepEqual([row(menu).title, row(menu).description], ['My referral code', 'Try again']);
    const tap = await menuTap(flow, userId, 'my_code');
    assert.equal(tap.screen, 'MENU');
    assert.equal(tap.data.has_error, true);
    assert.ok(tap.data.error.length < 60);
    assert.equal(tap.data.choices.find((c) => c.id === 'my_code').description, 'Try again');
    assert.ok(logged.length > 0);
    assert.ok(!JSON.stringify(logged).includes(userId), 'no user id in the log');
    const saved = await flow(userId, { action: 'data_exchange', screen: 'REFERRAL', data: { action: 'save_my_code', code: uniq() } });
    assert.equal(saved.screen, 'REFERRAL');
    assert.equal(await prisma.referralCode.count({ where: { userId } }), 0, 'nothing was created');
  } finally {
    referralClient.findOwnCode = real;
    console.error = realErr;
  }
  const ok = await menuTap(flow, userId, 'my_code');
  assert.equal(ok.screen, 'REFERRAL', 'read works again: Create form');
});

test('the idle menu has the row; the mid-booking and mid-ride menus do not', async () => {
  const redis = memoryRedis();
  const flow = flowFor(redis);
  const userId = await newUser(33);
  const code = uniq();
  await referralClient.setCustomCode(userId, code);
  assert.equal(row(await flow(userId, { action: 'INIT' })).description, `View code · ${code}`);
  const { setActiveRide, setBookingStage, clearActiveRide } = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');
  await setActiveRide(redis, userId, randomUUID());
  const active = await flow(userId, { action: 'INIT' });
  assert.deepEqual(active.data.choices.map((c) => c.id), ['current', 'deposit']);
  await clearActiveRide(redis, userId);
  await setBookingStage(redis, userId, 'awaiting_destination');
  const mid = await flow(userId, { action: 'INIT' });
  assert.match(mid.data.greeting_line, /booking a ride/);
  assert.equal(row(mid), undefined);
});

test('two saves at the same moment with different codes: both get the same code, one row', async () => {
  const flow = flowFor(memoryRedis());
  const userId = await newUser(36);
  const [a, b] = await Promise.all([uniq(), `${uniq()}Z`].map((code) => flow(userId, { action: 'data_exchange', screen: 'REFERRAL', data: { action: 'save_my_code', code } })));
  assert.equal(a.screen, 'NOTE');
  assert.equal(b.screen, 'NOTE');
  assert.equal(a.data.headline, b.data.headline);
  assert.equal(await prisma.referralCode.count({ where: { userId } }), 1);
});

test('a second create returns the existing code, not a new one', async () => {
  const flow = flowFor(memoryRedis());
  const userId = await newUser(34);
  const code = uniq();
  await referralClient.setCustomCode(userId, code);
  const stale = await flow(userId, { action: 'data_exchange', screen: 'REFERRAL', data: { action: 'save_my_code', code: `${uniq()}X` } });
  assert.equal(stale.screen, 'NOTE');
  assert.equal(stale.data.headline, `Your code is ${code}`);
  assert.equal(await referralClient.findOwnCode(userId), code);
  assert.equal(await prisma.referralCode.count({ where: { userId } }), 1);
});

test('flag off: the row still says View code and the code is shown, without the QR', async () => {
  const before = process.env.WHATSAPP_QUICK_ACTIONS_SHARE;
  delete process.env.WHATSAPP_QUICK_ACTIONS_SHARE;
  try {
    const flow = flowFor(memoryRedis());
    const userId = await newUser(35);
    const code = uniq();
    await referralClient.setCustomCode(userId, code);
    const menu = await flow(userId, { action: 'INIT' });
    assert.equal(row(menu).description, `View code · ${code}`);
    const view = await menuTap(flow, userId, 'my_code');
    assert.equal(view.screen, 'NOTE');
    assert.equal(view.data.headline, `Your code is ${code}`);
    assert.equal(view.data.qr_image, undefined);
  } finally {
    if (before !== undefined) process.env.WHATSAPP_QUICK_ACTIONS_SHARE = before;
  }
});
