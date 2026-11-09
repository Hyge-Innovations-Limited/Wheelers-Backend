// Repro: "I created my referral code in the Quick Actions Flow; next time I open it, it offers Create again."
// Real entry point: handleQuickActionsFlow (what the flow endpoint calls for token menu:<userId>):
// INIT, then tap Create, then save_my_code, then INIT again for the same user.
//
//   npm run build && node scripts/run-with-env.cjs node --test --test-force-exit --test-concurrency=1 test/repro/quick-actions-referral-saved.repro.test.js

const test = require('node:test');
process.env.WHATSAPP_QUICK_ACTIONS_SHARE = 'on';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { prisma, referralClient } = require('@wheleers/db');
const { handleQuickActionsFlow } = require('../../apps/api-gateway/dist/whatsapp-flows/quick-actions-flow.js');

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
const redis = memoryRedis();
const deps = () => ({ redisClient: redis, publisher: { publishRideEvent: async () => {} } });
const flow = (userId, body) => handleQuickActionsFlow({ version: '3.0', flow_token: 'x', ...body }, userId, deps());
const made = [];
test.after(async () => {
  await prisma.referralCode.deleteMany({ where: { userId: { in: made } } });
  await prisma.user.deleteMany({ where: { id: { in: made } } });
  await prisma.$disconnect();
});

test('after creating the code in the Flow, the next INIT shows the saved code and never offers Create', async () => {
  const userId = randomUUID();
  await prisma.user.create({ data: { id: userId, privyDid: `test:refsaved:${userId}`, role: 'RIDER', name: 'Timi Saved', phone: '+2348030000077' } });
  made.push(userId);

  const first = await flow(userId, { action: 'INIT' });
  assert.ok(first.data.choices.some((c) => c.title === 'My referral code' && c.description === 'Create yours'), 'control: first open offers Create');

  const form = await flow(userId, { action: 'data_exchange', screen: 'MENU', data: { choice: 'my_code' } });
  assert.equal(form.data.action, 'save_my_code');
  const code = `SV${Math.floor(1000 + Math.random() * 9000)}`;
  const saved = await flow(userId, { action: 'data_exchange', screen: 'REFERRAL', data: { action: 'save_my_code', code } });
  assert.equal(saved.screen, 'NOTE');
  assert.equal(await referralClient.findOwnCode(userId), code, 'control: the code is stored');

  const again = await flow(userId, { action: 'INIT' });
  assert.ok(!again.data.choices.some((c) => /create/i.test(c.description)), 'Create is not offered again');
  assert.equal(again.data.choices.find((c) => c.id === 'my_code').description, `View code · ${code}`);
  // Meta: INIT must open the entry screen (MENU). The row is View code; one tap and Continue lands on the QR + link.
  const view = await flow(userId, { action: 'data_exchange', screen: 'MENU', data: { choice: 'my_code' } });
  assert.equal(view.screen, 'NOTE');
  assert.equal(view.data.has_share, true, 'the saved code (QR + share link) is shown');
  assert.ok(view.data.note.includes(code));
});
