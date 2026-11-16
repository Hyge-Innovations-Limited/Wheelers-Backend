// A rider's NIN at sign-up (Timi, 16 Nov 2026): asked in the WhatsApp Welcome form (after full name and email)
// and the app's Create account, never required, never labelled optional. Prembly (NIN Basic) looks it up once
// the rider agreed, and the name on it is held against theirs. Only the last 4 digits are kept. Through the
// real form handler, the real HTTP route and a real Postgres; Prembly faked.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/rider-nin.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const nin = require('../apps/api-gateway/dist/verification/rider-nin.js');
const { handleWelcomeFlow, cleanFullName } = require('../apps/api-gateway/dist/whatsapp-flows/welcome-flow.js');
const { handleRiderNinRoute } = require('../apps/api-gateway/dist/http/rider-nin.route.js');
const local = require('../apps/api-gateway/dist/auth/local.js');

const prisma = new PrismaClient();
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const CONFIG = { apiKey: 'k', appId: null, baseUrl: 'https://prembly.test', timeoutMs: 5000 };

function memoryRedis() {
  const store = new Map();
  return {
    get: async (k) => (store.has(k) ? store.get(k) : null),
    set: async (k, v) => { store.set(k, v); return 'OK'; },
    del: async (k) => { store.delete(k); return 1; },
    setIfNotExists: async (k, v) => { if (store.has(k)) return false; store.set(k, v); return true; },
  };
}
const made = [];
async function user(name = 'Ada Obi') {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:nin:${id}`, role: 'RIDER', name } });
  made.push(id);
  return id;
}
/** Prembly answering `body` with `status`; every call remembered. */
function premblyAnswers(status, body) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify(body), { status }); };
  return { calls, fetchImpl };
}
const FOUND = { status: true, detail: 'Verification Successful', nin_data: { firstname: 'ADA', middlename: 'CHIOMA', surname: 'OBI' }, verification: { status: 'VERIFIED', reference: 'ref-1' } };

test.before(() => { console.warn = () => {}; });

test('the rules: 11 digits; the name matches when two of the rider\'s words are on the record, any order', () => {
  assert.equal(nin.cleanNin(' 123 4567-8901 '), '12345678901');
  for (const bad of ['', '1234567890', '123456789012', '1234567890a', null, undefined]) assert.equal(nin.cleanNin(bad), null, String(bad));
  const record = { firstname: 'ADA', middlename: 'Chioma', surname: 'OBI' };
  assert.deepEqual(nin.ninRecordNames(record), ['ada', 'chioma', 'obi']);
  assert.equal(nin.ninNameMatches('Ada Obi', record), true);
  assert.equal(nin.ninNameMatches('obi ada', record), true, 'any order');
  assert.equal(nin.ninNameMatches('Chioma Obi', record), true, 'a middle name counts');
  assert.equal(nin.ninNameMatches('Ada Bakare', record), false, 'one word is not enough');
  assert.equal(nin.ninNameMatches('Tunde Bakare', record), false);
  assert.equal(nin.ninNameMatches('Ada Obi', { first_name: 'Ada', last_name: 'Obi' }), true, 'other key spellings');
  assert.equal(nin.ninNameMatches('', record), false);
  assert.equal(cleanFullName('  Ada   Obi '), 'Ada Obi');
  assert.equal(cleanFullName('Ada'), null);
});

test('the check: found and matching is VERIFIED; only the last 4 digits are kept', async () => {
  const id = await user('Ada Obi');
  const prembly = premblyAnswers(200, FOUND);
  assert.equal(await nin.checkRiderNin(id, '12345678901', 'Ada Obi', { redis: memoryRedis(), config: CONFIG, fetchImpl: prembly.fetchImpl }), 'VERIFIED');
  assert.equal(prembly.calls[0].url, 'https://prembly.test/verification/vnin-basic');
  assert.deepEqual(prembly.calls[0].body, { number: '12345678901' });
  const row = await prisma.user.findUnique({ where: { id } });
  assert.deepEqual([row.ninLast4, row.ninStatus], ['8901', 'VERIFIED']);
  assert.ok(row.ninCheckedAt);
  assert.doesNotMatch(JSON.stringify(row), /12345678901/, 'the number itself is nowhere on the rider');
  // Verified: never looked up (or paid for) again.
  assert.equal(await nin.checkRiderNin(id, '12345678901', 'Ada Obi', { redis: memoryRedis(), config: CONFIG, fetchImpl: prembly.fetchImpl }), null);
  assert.equal(prembly.calls.length, 1);
});

test('the check: another person\'s name, no such NIN, Prembly down; at most 3 a day; nothing without Prembly', async () => {
  const id = await user('Tunde Bakare');
  const redis = memoryRedis();
  assert.equal(await nin.checkRiderNin(id, '12345678901', 'Tunde Bakare', { redis, config: CONFIG, fetchImpl: premblyAnswers(200, FOUND).fetchImpl }), 'NO_MATCH');
  assert.equal(await nin.checkRiderNin(id, '12345678902', 'Tunde Bakare', { redis, config: CONFIG, fetchImpl: premblyAnswers(404, { status: false, detail: 'NIN not found' }).fetchImpl }), 'NOT_FOUND');
  assert.equal(await nin.checkRiderNin(id, '12345678903', 'Tunde Bakare', { redis, config: CONFIG, fetchImpl: premblyAnswers(503, { detail: 'Source unavailable' }).fetchImpl }), 'UNCHECKED');
  const fourth = premblyAnswers(200, FOUND);
  assert.equal(await nin.checkRiderNin(id, '12345678904', 'Tunde Bakare', { redis, config: CONFIG, fetchImpl: fourth.fetchImpl }), null, 'over today\'s limit');
  assert.equal(fourth.calls.length, 0);
  assert.equal((await prisma.user.findUnique({ where: { id } })).ninLast4, '8903');
  assert.equal(await nin.checkRiderNin(id, '12345678901', 'Tunde Bakare', { redis: memoryRedis(), config: null }), null, 'Prembly not set up');
  assert.equal(await nin.checkRiderNin(id, '123', 'Tunde Bakare', { redis: memoryRedis(), config: CONFIG }), null, 'not 11 digits');
});

const flowBody = (screen, data) => ({ action: 'data_exchange', flow_token: 't', screen, data });

test('the Welcome form: full name and email, then the NIN (Next with it empty goes on), then the terms; checked only once agreed', async () => {
  const id = await user(null);
  const checked = [];
  const deps = { redisClient: memoryRedis(), checkNin: async (...args) => { checked.push(args.slice(0, 3)); return 'VERIFIED'; } };

  const noName = await handleWelcomeFlow(flowBody('EMAIL', { name: 'Ada', email: 'ada@example.com' }), id, deps);
  assert.deepEqual([noName.screen, noName.data.error], ['EMAIL', 'Enter your first and last name.']);
  const toNin = await handleWelcomeFlow(flowBody('EMAIL', { name: ' Ada  Obi ', email: 'Ada@Example.com', marketing: true }), id, deps);
  assert.equal(toNin.screen, 'NIN');
  assert.deepEqual([toNin.data.name, toNin.data.email, toNin.data.marketing], ['Ada Obi', 'ada@example.com', true]);

  const badNin = await handleWelcomeFlow(flowBody('NIN', { name: 'Ada Obi', email: 'ada@example.com', nin: '1234' }), id, deps);
  assert.deepEqual([badNin.screen, badNin.data.error], ['NIN', 'NIN is 11 digits.']);
  const empty = await handleWelcomeFlow(flowBody('NIN', { name: 'Ada Obi', email: 'ada@example.com', nin: '' }), id, deps);
  assert.deepEqual([empty.screen, empty.data.nin], ['TERMS', ''], 'Next with the box empty goes on');
  const typed = await handleWelcomeFlow(flowBody('NIN', { name: 'Ada Obi', email: 'ada@example.com', nin: '12345678901' }), id, deps);
  assert.deepEqual([typed.screen, typed.data.nin, typed.data.name], ['TERMS', '12345678901', 'Ada Obi']);
  assert.equal(checked.length, 0, 'nothing goes to Prembly before they agree');

  const done = await handleWelcomeFlow(flowBody('TERMS', { name: 'Ada Obi', email: 'ada@example.com', nin: '12345678901', agree: true }), id, deps);
  assert.equal(done.screen, 'SUCCESS');
  assert.deepEqual(checked, [[id, '12345678901', 'Ada Obi']]);
  const row = await prisma.user.findUnique({ where: { id } });
  assert.deepEqual([row.name, row.privacyConsent], ['Ada Obi', 'AGREED']);

  // No NIN typed: agreed, nothing looked up.
  const other = await user(null);
  const none = [];
  await handleWelcomeFlow(flowBody('TERMS', { name: 'Tunde Bakare', email: 't@example.com', nin: '', agree: true }), other, { redisClient: memoryRedis(), checkNin: async (...a) => { none.push(a); } });
  assert.equal(none.length, 0);
  assert.equal((await prisma.user.findUnique({ where: { id: other } })).privacyConsent, 'AGREED');
});

test('the form as Meta shows it: name, then a NIN box that is not required and never says optional', () => {
  delete require.cache[require.resolve('../apps/api-gateway/src/whatsapp-flows/welcome-flow-definition.json')];
  const def = require('../apps/api-gateway/src/whatsapp-flows/welcome-flow-definition.json');
  assert.deepEqual(def.routing_model, { EMAIL: ['NIN'], NIN: ['TERMS'], TERMS: ['DONE'], DONE: [] });
  const kids = (id) => def.screens.find((s) => s.id === id).layout.children[0].children;
  const input = (id, name) => kids(id).find((k) => k.type === 'TextInput' && k.name === name);
  assert.equal(input('EMAIL', 'name').required, true);
  assert.equal(input('NIN', 'nin').required, false);
  assert.doesNotMatch(JSON.stringify(def.screens.find((s) => s.id === 'NIN')), /optional/i);
  const payload = kids('TERMS').find((k) => k.type === 'Footer')['on-click-action'].payload;
  assert.equal(payload.nin, '${data.nin}');
  assert.equal(payload.name, '${data.name}');
});

test('the app: POST /auth/nin takes 11 digits and answers at once; the check runs behind', async () => {
  const id = await user('Ada Obi');
  const checked = [];
  const server = http.createServer((req, res) => void handleRiderNinRoute(req, res, { jwtSecret: JWT_SECRET, redisClient: memoryRedis(), check: async (...a) => { checked.push(a.slice(0, 3)); return 'VERIFIED'; } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const post = (token, body) => fetch(`http://127.0.0.1:${server.address().port}/auth/nin`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const token = local.createLocalAccessToken(id, JWT_SECRET);
  try {
    assert.equal((await post(null, { nin: '12345678901' })).status, 401);
    const bad = await post(token, { nin: '12345' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'NIN is 11 digits.');
    assert.equal((await post(token, { nin: '1234 5678 901' })).status, 202);
    assert.deepEqual(checked, [[id, '12345678901', 'Ada Obi']]);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test.after(async () => {
  await prisma.userConsent.deleteMany({ where: { userId: { in: made } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made } } });
  await prisma.$disconnect();
});
