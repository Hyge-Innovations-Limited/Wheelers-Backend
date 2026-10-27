// Your referral code in Quick Actions: the code, its QR (a PNG of the link a
// friend scans), the link, and Share — WhatsApp's own share with the forward
// message typed — all inside the form, nothing sent to the chat. The form's
// JSON is checked as Meta would: Flow JSON 6.0 (open_url), every binding
// declared, and every other ending still a plain note. Against the local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/referral-qr-flow.test.js

const test = require('node:test');
process.env.WHATSAPP_QUICK_ACTIONS_SHARE = 'on';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { prisma, referralClient } = require('@wheleers/db');
const { handleQuickActionsFlow, NO_IMAGE_PNG } = require('../apps/api-gateway/dist/whatsapp-flows/quick-actions-flow.js');
const { referralShareLink, referralShareMessage, referralShortLink } = require('../apps/api-gateway/dist/whatsapp/referral.js');

const FLOW_PATH = path.join(__dirname, '../apps/api-gateway/src/whatsapp-flows/quick-actions-flow-definition.json');
const made = [];
const realFetch = global.fetch;
const sentToChat = [];

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
const deps = () => ({ redisClient: memoryRedis(), publisher: { publishRideEvent: async () => {} } });
const choose = (userId, choice) => handleQuickActionsFlow({ action: 'data_exchange', screen: 'MENU', data: { choice } }, userId, deps());

test.before(() => {
  global.fetch = async (url, init) => {
    if (String(url).includes('graph.facebook.com')) { sentToChat.push(init?.body); return new Response('{}', { status: 200 }); }
    return realFetch(url, init);
  };
});
test.after(async () => {
  global.fetch = realFetch;
  await prisma.referralCode.deleteMany({ where: { userId: { in: made } } });
  await prisma.user.deleteMany({ where: { id: { in: made } } });
  await prisma.$disconnect();
});

test('the Flow JSON still parses, is 6.0 (open_url), declares every binding, and only NOTE gained the QR and Share', () => {
  const flow = JSON.parse(fs.readFileSync(FLOW_PATH, 'utf8'));
  assert.equal(flow.version, '6.0');
  assert.equal(flow.data_api_version, '3.0');
  for (const screen of flow.screens) {
    const bound = [...JSON.stringify(screen.layout).matchAll(/\$\{data\.([a-z0-9_]+)\}/g)].map((m) => m[1]);
    for (const name of bound) assert.ok(name in screen.data, `${screen.id} binds data.${name}, which it does not declare`);
    // 6.0: a string property may not be empty.
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (key !== '__example__' && typeof value === 'string') assert.notEqual(value.trim(), '', `${screen.id}: ${key} is empty`);
        walk(value);
      }
    };
    walk(screen.layout);
  }
  for (const [from, targets] of Object.entries(flow.routing_model)) assert.ok(targets.length <= 10, `${from} has at most ten routes`);

  const note = flow.screens.find((s) => s.id === 'NOTE');
  const block = note.layout.children[0].children.find((c) => c.type === 'If');
  assert.equal(block.condition, '${data.has_share}');
  const image = block.then.find((c) => c.type === 'Image');
  assert.equal(image.src, '${data.qr_image}');
  const link = block.then.find((c) => c.type === 'EmbeddedLink');
  assert.ok(link.text.length > 0 && link.text.length <= 25, 'EmbeddedLink text: 1–25 characters');
  assert.deepEqual(link['on-click-action'], { name: 'open_url', url: '${data.share_url}' });
  assert.equal(note.layout.children[0].children.filter((c) => c.type === 'Footer').length, 0, 'NOTE still has no button: the chat keeps its Quick Actions');
  assert.equal(JSON.stringify(flow).match(/"Image"/g).length, 1, 'one image, on NOTE');
});

test('Your referral code: the code, the QR of the link, the link, and Share with the forward message — nothing sent to the chat', async () => {
  const userId = randomUUID();
  await prisma.user.create({ data: { id: userId, privyDid: `test:qr:${userId}`, role: 'RIDER', name: 'Timi QR', phone: '+2348030000055' } });
  made.push(userId);
  const code = (await referralClient.setCustomCode(userId, `QR${Math.floor(1000 + Math.random() * 9000)}`)).code;
  const before = sentToChat.length;

  const screen = await choose(userId, 'my_code');
  assert.equal(screen.screen, 'NOTE');
  assert.equal(screen.data.headline, `Your code is ${code}`);
  // The short link, never the long wa.me one: app.wheelersng.com/r/CODE opens the bot with the code typed.
  const link = referralShortLink(code);
  assert.ok(screen.data.note.includes(link.replace(/^https?:\/\//, '')), 'the short link is shown');
  assert.ok(!screen.data.note.includes('wa.me'), 'no long wa.me link on the screen');
  assert.equal(screen.data.has_share, true);
  const png = Buffer.from(screen.data.qr_image, 'base64');
  assert.equal(png.subarray(1, 4).toString(), 'PNG', 'a PNG, base64 without a data: prefix');
  assert.ok(png.length < 100_000, `small enough for the form (${png.length} bytes)`);
  assert.equal(screen.data.share_url, `https://wa.me/?text=${encodeURIComponent(referralShareMessage(code, link))}`);
  assert.ok(decodeURIComponent(screen.data.share_url).includes(link), 'Share carries the link');
  assert.equal(sentToChat.length, before, 'no chat message');
  assert.equal('rearm' in screen.data, false);
});

test('every other note says it has nothing to share, with an image Meta accepts in the hidden part', async () => {
  const userId = randomUUID();
  await prisma.user.create({ data: { id: userId, privyDid: `test:qr:${userId}`, role: 'RIDER', name: 'Timi Plain' } });
  made.push(userId);
  const screen = await handleQuickActionsFlow({ action: 'data_exchange', screen: 'REFERRAL', data: { action: 'apply_referral', code: 'NOPE0000' } }, userId, deps());
  // A wrong code stays on REFERRAL; a support ending is a NOTE.
  const note = screen.screen === 'NOTE' ? screen : await choose(userId, 'support');
  assert.equal(note.screen, 'NOTE');
  assert.equal(note.data.has_share, false);
  assert.equal(note.data.qr_image, NO_IMAGE_PNG);
  assert.ok(note.data.share_url.startsWith('https://'));
});

test('until the new form is pushed (WHATSAPP_QUICK_ACTIONS_SHARE not on), NOTE carries none of the new fields', async () => {
  const before = process.env.WHATSAPP_QUICK_ACTIONS_SHARE;
  delete process.env.WHATSAPP_QUICK_ACTIONS_SHARE;
  try {
    const { handleQuickActionsFlow } = require('../apps/api-gateway/dist/whatsapp-flows/quick-actions-flow.js');
    const screen = await handleQuickActionsFlow({ version: '3.0', action: 'data_exchange', flow_token: 'x', screen: 'MENU', data: { choice: 'support' } }, require('node:crypto').randomUUID(), { redisClient: { get: async () => null, set: async () => undefined, del: async () => undefined }, publisher: { publish: async () => undefined }, googleMapsApiKey: '', routePlanner: {} });
    if (screen.screen === 'NOTE') {
      assert.equal(screen.data.has_share, undefined);
      assert.equal(screen.data.qr_image, undefined);
    }
  } finally {
    if (before === undefined) delete process.env.WHATSAPP_QUICK_ACTIONS_SHARE; else process.env.WHATSAPP_QUICK_ACTIONS_SHARE = before;
  }
});
