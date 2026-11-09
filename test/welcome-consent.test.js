// The Welcome form and the consent question, message in -> replies out.
//   node scripts/run-with-env.cjs node --test --test-force-exit --test-concurrency=1 test/welcome-consent.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');
const { handleMetaWhatsappWebhookRoute, createQuickActionsChatHooks } = require('../apps/api-gateway/dist/http/whatsapp.route.js');
const { handleFlowAction } = require('../apps/api-gateway/dist/whatsapp-flows/flow-endpoint.js');
const { signFlowToken } = require('../apps/api-gateway/dist/whatsapp-flows/encryption.js');
const { cleanEmail, WELCOME_SUBMITS_PER_MINUTE } = require('../apps/api-gateway/dist/whatsapp-flows/welcome-flow.js');

const prisma = new PrismaClient();
const realFetch = global.fetch;
const realConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const FLOW_ID = '999000111';
const ENV_KEYS = ['WHATSAPP_WELCOME_FORM', 'WHATSAPP_WELCOME_FLOW_ID', 'WHATSAPP_WELCOME_FORM_PHONES'];
const realEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const setEnv = (mode, phones = '') => {
  process.env.WHATSAPP_WELCOME_FORM = mode;
  process.env.WHATSAPP_WELCOME_FLOW_ID = FLOW_ID;
  process.env.WHATSAPP_WELCOME_FORM_PHONES = phones;
};

function memoryRedis() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v) { store.set(k, v); },
    async del(k) { store.delete(k); },
    async setIfNotExists(k, v) { if (store.has(k)) return false; store.set(k, v); return true; },
    async send() { return null; },
  };
}
function world({ refuseFlow = false } = {}) {
  const sent = [];
  global.fetch = async (url, init) => {
    const href = String(url);
    if (!href.includes('graph.facebook.com')) throw new Error(`unexpected fetch ${href}`);
    const body = JSON.parse(init.body);
    if (refuseFlow && body.interactive?.type === 'flow') return { ok: false, status: 400, json: async () => ({}), text: async () => 'flow refused' };
    if (body.type === 'text' || body.type === 'interactive') sent.push(body);
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.${sent.length}` }] }), text: async () => '' };
  };
  return sent;
}
function makeDeps(redisClient) {
  return {
    jwtSecret: SECRET, redisClient, metaAccessToken: 'meta-token', metaPhoneNumberId: '1234567890',
    publisher: new Proxy({}, { get: () => async () => {} }),
    paymentsClient: { createCustomer: async () => ({ id: 'c' }), findCustomerByReference: async () => null, updateCustomer: async () => ({}), createVirtualAccount: async () => ({ id: 'v', bank_name: 'B', account_number: '1', account_name: 'T', currency: 'NGN', country: 'NG' }) },
  };
}
let n = 0;
const rider = () => ({ phone: `23481${String(Date.now()).slice(-5)}${String(Math.floor(Math.random() * 900) + 100)}`, name: 'Welcome Rider' });
async function say(deps, who, text, reply) {
  n += 1;
  const message = reply
    ? { id: `wamid.w.${Date.now()}.${n}`, from: who.phone, type: 'interactive', interactive: { type: 'button_reply', button_reply: reply } }
    : { id: `wamid.w.${Date.now()}.${n}`, from: who.phone, type: 'text', text: { body: text } };
  const payload = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { contacts: [{ profile: { name: who.name }, wa_id: who.phone }], messages: [message] } }] }] };
  const raw = Buffer.from(JSON.stringify(payload));
  await handleMetaWhatsappWebhookRoute({ method: 'POST', headers: {}, async *[Symbol.asyncIterator]() { yield raw; } }, { statusCode: 0, setHeader() {}, writeHead() { return this; }, end() {} }, deps);
}
const find = (who) => prisma.user.findFirstOrThrow({ where: { phone: { contains: who.phone.slice(-10) } } });
const textOf = (m) => m?.text?.body ?? m?.interactive?.body?.text ?? '';
const flowMsgs = (sent) => sent.filter((m) => m.interactive?.type === 'flow');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const body = (flow_token, screen, data) => ({ action: 'data_exchange', flow_token, screen, data });

test.beforeEach(() => { if (!process.env.LOUD) console.log = console.info = console.warn = console.error = () => {}; });
test.afterEach(() => { Object.assign(console, realConsole); global.fetch = realFetch; });
test.after(async () => {
  for (const k of ENV_KEYS) { if (realEnv[k] === undefined) delete process.env[k]; else process.env[k] = realEnv[k]; }
  await prisma.$disconnect();
});

/** A form-ready rider: said hi once with the form on, so the user exists and is PENDING. */
async function newcomer(mode = 'on', opts = {}) {
  setEnv(mode, opts.phones ?? '');
  const redis = memoryRedis();
  const deps = makeDeps(redis);
  const sent = world(opts);
  const who = rider();
  if (opts.phones === 'self') process.env.WHATSAPP_WELCOME_FORM_PHONES = `+${who.phone}`;
  await say(deps, who, 'hi');
  return { redis, deps, sent, who, user: await find(who) };
}
const flowDeps = (deps) => ({ redisClient: deps.redisClient, tokenSecret: SECRET, publisher: deps.publisher, privateKeyPem: '', googleMapsApiKey: '', routePlanner: {}, ...createQuickActionsChatHooks(deps) });

test('switch off: the old text prompt, no form', async () => {
  const { sent, user } = await newcomer('off');
  assert.deepEqual(sent.at(-1).interactive.action.buttons.map((b) => b.reply.title), ['Continue', 'Not now']);
  assert.equal(flowMsgs(sent).length, 0);
  assert.equal(await prisma.user.findUnique({ where: { id: user.id } }).then((u) => u.privacyConsent), 'PENDING');
});

test('switch off, form id set: still the old prompt, and typed Continue agrees as before', async () => {
  const { deps, sent, who } = await newcomer('off');
  await say(deps, who, 'Continue');
  assert.equal((await find(who)).privacyConsent, 'AGREED');
  assert.ok(!sent.some((m) => /all set/.test(textOf(m))), 'no separate "You\'re all set."');
  assert.match(textOf(sent.find((m) => /where are you headed/.test(textOf(m)))), /^Hi Welcome, where are you headed\?/, 'one greeting, by name, with the menu');
});

test('test mode: only listed phones get the form', async () => {
  const listed = await newcomer('test', { phones: 'self' });
  const f = flowMsgs(listed.sent);
  assert.equal(f.length, 1);
  assert.equal(textOf(f[0]), '*Welcome to Wheelers*');
  assert.equal(f[0].interactive.action.parameters.flow_cta, 'Get started');
  assert.equal(f[0].interactive.action.parameters.flow_id, FLOW_ID);
  assert.match(f[0].interactive.action.parameters.flow_token, /^welcome:.+\.[0-9a-f]{16}$/);
  const other = await newcomer('test', { phones: '2348000000000' });
  assert.equal(flowMsgs(other.sent).length, 0);
  assert.deepEqual(other.sent.at(-1).interactive.action.buttons.map((b) => b.reply.title), ['Continue', 'Not now']);
});

test('the form screens: bad email stays, good email goes on with the news tick, Get started agrees (no forced tick), once with one follow-up', async () => {
  const { deps, sent, redis, user } = await newcomer('on');
  const fd = flowDeps(deps);
  const token = signFlowToken(`welcome:${user.id}`, SECRET);
  await redis.set(`whatsapp:user:${user.id}:pre_consent_message`, JSON.stringify({ at: Date.now() - 60_000, msg: { messageId: '', phone: '1', messageBody: 'FREEZE', isLocation: false } }));

  assert.equal((await handleFlowAction({ action: 'INIT', flow_token: token }, fd)).screen, 'EMAIL');
  const bad = await handleFlowAction(body(token, 'EMAIL', { email: 'nope@x' }), fd);
  assert.equal(bad.screen, 'EMAIL');
  assert.equal(bad.data.error, 'Enter a valid email.');
  const good = await handleFlowAction(body(token, 'EMAIL', { email: '  Ada@Example.COM ' }), fd);
  assert.equal(good.screen, 'TERMS');
  assert.equal(good.data.privacy_url, 'https://wheelersng.com/privacy');
  assert.equal(good.data.terms_url, 'https://wheelersng.com/terms');
  assert.equal(good.data.email, 'ada@example.com');
  assert.equal(good.data.marketing, false, 'the news tick, left empty on the email screen');
  const ticked = await handleFlowAction(body(token, 'EMAIL', { email: 'ada@example.com', marketing: true }), fd);
  assert.equal(ticked.data.marketing, true, 'carried to the terms screen');
  assert.equal((await prisma.user.findUnique({ where: { id: user.id } })).privacyConsent, 'PENDING', 'nothing agreed before Get started');

  const before = sent.length;
  const [a, b] = await Promise.all([
    handleFlowAction(body(token, 'TERMS', { email: 'ada@example.com', agree: true }), fd),
    handleFlowAction(body(token, 'TERMS', { email: 'ada@example.com', agree: true }), fd),
  ]);
  assert.equal(a.screen, 'SUCCESS');
  assert.equal(b.screen, 'SUCCESS');
  await wait(300);
  const row = await prisma.user.findUnique({ where: { id: user.id } });
  assert.equal(row.privacyConsent, 'AGREED');
  assert.equal(row.contactEmail, 'ada@example.com');
  assert.equal(row.email, null, 'never the sign-in email');
  const after = sent.slice(before).map(textOf);
  assert.equal(after.filter((t) => /all set/.test(t)).length, 0, 'no separate "You\'re all set."');
  assert.equal(after.filter((t) => /paused/i.test(t)).length, 1, 'their first message, under 2 hours old, is answered once: that is the one message');

  // Submitted again later: closes, nothing said, nothing saved.
  const count = sent.length;
  await handleFlowAction(body(token, 'TERMS', { email: 'other@example.com', agree: true }), fd);
  await wait(100);
  assert.equal(sent.length, count);
  assert.equal((await prisma.user.findUnique({ where: { id: user.id } })).contactEmail, 'ada@example.com');
});

test('the news-and-offers tick is optional and kept apart: ticked is yes, left empty is no, both agree', async () => {
  for (const [marketing, want] of [[true, true], [undefined, false], [false, false]]) {
    const { deps, user } = await newcomer('on');
    const token = signFlowToken(`welcome:${user.id}`, SECRET);
    await handleFlowAction(body(token, 'TERMS', { email: 'a@b.co', ...(marketing === undefined ? {} : { marketing }) }), flowDeps(deps));
    await wait(200);
    const row = await prisma.user.findUnique({ where: { id: user.id } });
    assert.equal(row.privacyConsent, 'AGREED', `agreed (tick ${marketing})`);
    assert.equal(row.marketingEmailOptIn, want, `tick ${marketing}`);
    assert.ok(row.marketingEmailOptInAt, 'when it was answered');
  }
});

test('a first message over 2 hours old is not replayed: the menu comes instead', async () => {
  const { deps, sent, redis, user } = await newcomer('on');
  await redis.set(`whatsapp:user:${user.id}:pre_consent_message`, JSON.stringify({ at: Date.now() - 3 * 3600_000, msg: { messageId: '', phone: '1', messageBody: 'FREEZE', isLocation: false } }));
  const token = signFlowToken(`welcome:${user.id}`, SECRET);
  const before = sent.length;
  await handleFlowAction(body(token, 'TERMS', { email: 'a@b.co', agree: true }), flowDeps(deps));
  await wait(300);
  const after = sent.slice(before);
  assert.ok(!after.some((m) => /all set/.test(textOf(m))), 'no separate "You\'re all set."');
  assert.ok(!after.some((m) => /paused/i.test(textOf(m))));
  assert.equal(after.length, 1, 'one message');
  assert.equal(after[0].interactive?.type, 'list', 'with the menu under it');
  assert.match(textOf(after[0]), /^Hi Welcome, where are you headed\?/);
});

test('a forged or other-user token is refused; the user comes only from the token', async () => {
  const { deps, user } = await newcomer('on');
  const fd = flowDeps(deps);
  const forged = await handleFlowAction(body(`welcome:${user.id}.0000000000000000`, 'TERMS', { email: 'a@b.co', agree: true }), fd);
  assert.match(forged.data.message, /Invalid session/);
  const tampered = signFlowToken(`welcome:${user.id}`, SECRET).replace(`welcome:${user.id}`, 'welcome:someone-else');
  assert.match((await handleFlowAction(body(tampered, 'TERMS', { email: 'a@b.co', agree: true }), fd)).data.message, /Invalid session/);
  assert.equal((await prisma.user.findUnique({ where: { id: user.id } })).privacyConsent, 'PENDING');
});

test('form send fails: today\'s text prompt, and typed Continue then agrees', async () => {
  const { deps, sent, who } = await newcomer('on', { refuseFlow: true });
  assert.deepEqual(sent.at(-1).interactive.action.buttons.map((b) => b.reply.title), ['Continue', 'Not now']);
  await say(deps, who, 'continue');
  assert.equal((await find(who)).privacyConsent, 'AGREED');
});

test('typed Continue while the form is the question sends the form again; an old Continue button still agrees', async () => {
  const { deps, sent, who } = await newcomer('on');
  assert.equal(flowMsgs(sent).length, 1);
  await say(deps, who, 'continue');
  assert.equal((await find(who)).privacyConsent, 'PENDING');
  assert.equal(flowMsgs(sent).length, 2);
  await say(deps, who, 'Continue', { id: 'way_out_0', title: 'Continue' });
  assert.equal((await find(who)).privacyConsent, 'AGREED');
});

test('two forms never opened: the third question is the text prompt, and typing Continue then agrees', async () => {
  const { deps, sent, who } = await newcomer('on');
  await say(deps, who, 'hello');
  assert.equal(flowMsgs(sent).length, 2);
  await say(deps, who, 'hello again');
  assert.equal(flowMsgs(sent).length, 2);
  assert.deepEqual(sent.at(-1).interactive.action.buttons.map((b) => b.reply.title), ['Continue', 'Not now']);
  await say(deps, who, 'yes');
  assert.equal((await find(who)).privacyConsent, 'AGREED');
});

test('Not now typed still declines', async () => {
  const { deps, who } = await newcomer('on');
  await say(deps, who, 'Not now');
  assert.equal((await find(who)).privacyConsent, 'DECLINED');
});

test('spam: over 10 submits a minute shows "Try again in a minute."', async () => {
  const { deps, user } = await newcomer('on');
  const fd = flowDeps(deps);
  const token = signFlowToken(`welcome:${user.id}`, SECRET);
  let last;
  for (let i = 0; i <= WELCOME_SUBMITS_PER_MINUTE; i += 1) last = await handleFlowAction(body(token, 'EMAIL', { email: 'x@y.co' }), fd);
  assert.equal(last.data.error, 'Try again in a minute.');
});

test('email rule', () => {
  assert.equal(cleanEmail(' A@B.Co '), 'a@b.co');
  for (const bad of ['', 'a', 'a@b', 'a b@c.co', 'a@@b.co', 'a@b..co', '@b.co', 'a@.co', `${'a'.repeat(250)}@b.co`, 5]) assert.equal(cleanEmail(bad), null, String(bad));
});

test('the form as Meta shows it: news tick on the email screen; on the terms screen an I agree tick that is not forced', () => {
  const def = require('../apps/api-gateway/src/whatsapp-flows/welcome-flow-definition.json');
  const kids = (id) => def.screens.find((s) => s.id === id).layout.children[0].children;
  const optIn = (id, name) => kids(id).find((k) => k.type === 'OptIn' && k.name === name);
  assert.equal(optIn('EMAIL', 'marketing').required, false);
  assert.equal(optIn('TERMS', 'agree').required, false, 'Get started works with or without the tick');
  assert.equal(optIn('TERMS', 'marketing'), undefined);
  assert.ok(kids('TERMS').some((k) => k.text === 'By tapping Get started, you agree to both.'));
});
