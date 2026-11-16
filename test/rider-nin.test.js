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

test('the Welcome form: full name and email, then the NIN checked there and then; a wrong one stays with a proper message', async () => {
  const id = await user(null);
  const checked = [];
  // Prembly's answer for each NIN (faked).
  const ANSWERS = { '12345678909': 'NOT_FOUND', '22345678901': 'NO_MATCH', '12345678901': 'VERIFIED' };
  const deps = { redisClient: memoryRedis(), checkNin: async (...args) => { checked.push(args.slice(0, 3)); return ANSWERS[args[1]]; } };

  const noName = await handleWelcomeFlow(flowBody('EMAIL', { name: 'Ada', email: 'ada@example.com' }), id, deps);
  assert.deepEqual([noName.screen, noName.data.error], ['EMAIL', 'Enter your first and last name.']);
  const toNin = await handleWelcomeFlow(flowBody('EMAIL', { name: ' Ada  Obi ', email: 'Ada@Example.com', marketing: true }), id, deps);
  assert.equal(toNin.screen, 'NIN');
  assert.deepEqual([toNin.data.name, toNin.data.email, toNin.data.marketing], ['Ada Obi', 'ada@example.com', true]);

  const at = (nin) => handleWelcomeFlow(flowBody('NIN', { name: 'Ada Obi', email: 'ada@example.com', nin }), id, deps);
  const short = await at('1234');
  assert.deepEqual([short.screen, short.data.error, short.data.nin], ['NIN', 'NIN is 11 digits.', '1234'], 'the typed number stays in the box');
  assert.equal(checked.length, 0, 'not 11 digits: never sent to Prembly');
  const unknown = await at('12345678909');
  assert.deepEqual([unknown.screen, unknown.data.error], ['NIN', "We couldn't find this NIN. Check the 11 digits and try again."]);
  const other = await at('22345678901');
  assert.deepEqual([other.screen, other.data.error], ['NIN', "This NIN isn't in the name Ada Obi. Check your NIN, or go back and fix your name."]);
  const empty = await at('');
  assert.deepEqual([empty.screen, empty.data.nin], ['TERMS', ''], 'Next with the box empty goes on');
  const right = await at('12345678901');
  assert.deepEqual([right.screen, right.data.nin, right.data.name], ['TERMS', '12345678901', 'Ada Obi']);
  assert.deepEqual(checked.map((c) => c[1]), ['12345678909', '22345678901', '12345678901']);
  assert.deepEqual(checked[0], [id, '12345678909', 'Ada Obi'], 'held against the name typed on the first screen');

  const done = await handleWelcomeFlow(flowBody('TERMS', { name: 'Ada Obi', email: 'ada@example.com', nin: '12345678901', agree: true }), id, deps);
  assert.equal(done.screen, 'SUCCESS');
  assert.equal(checked.length, 3, 'not looked up (or paid for) again at the terms');
  const row = await prisma.user.findUnique({ where: { id } });
  assert.deepEqual([row.name, row.privacyConsent], ['Ada Obi', 'AGREED']);
});

test('live check: Prembly slow or down lets the rider on (the slow one finishes behind); 3 tries a day, then "Too many tries"', async () => {
  const id = await user('Ada Obi');
  const redis = memoryRedis();
  let finished = false;
  const slow = async () => { await new Promise((r) => setTimeout(r, 150)); finished = true; return 'NOT_FOUND'; };
  assert.deepEqual(await nin.checkRiderNinLive(id, '12345678901', 'Ada Obi', { redis, check: slow, waitMs: 30 }), { ok: true, status: 'PENDING' });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(finished, true);
  assert.deepEqual(await nin.checkRiderNinLive(id, '12345678901', 'Ada Obi', { redis, check: async () => 'UNCHECKED' }), { ok: true, status: 'UNCHECKED' });
  await redis.set(`rider-nin:${id}:${new Date().toISOString().slice(0, 10)}`, '3');
  const tooMany = await nin.checkRiderNinLive(id, '12345678901', 'Ada Obi', { redis, check: async () => 'VERIFIED' });
  assert.deepEqual(tooMany, { ok: false, code: 'NIN_TOO_MANY', error: 'Too many tries. Leave it empty for now.' });
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

test('the app: POST /auth/nin checks while the rider waits; a wrong NIN answers 422 with the words to show', async () => {
  const id = await user('Ada Obi');
  const checked = [];
  const ANSWERS = { '12345678909': 'NOT_FOUND', '22345678901': 'NO_MATCH', '12345678901': 'VERIFIED' };
  const server = http.createServer((req, res) => void handleRiderNinRoute(req, res, { jwtSecret: JWT_SECRET, redisClient: memoryRedis(), check: async (...a) => { checked.push(a.slice(0, 3)); return ANSWERS[a[1]]; } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const post = (token, body) => fetch(`http://127.0.0.1:${server.address().port}/auth/nin`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const token = local.createLocalAccessToken(id, JWT_SECRET);
  try {
    assert.equal((await post(null, { nin: '12345678901' })).status, 401);
    const answers = [];
    for (const n of ['12345', '12345678909', '22345678901']) {
      const r = await post(token, { nin: n, fullName: 'Ada  Obi' });
      answers.push([r.status, (await r.json()).error]);
    }
    assert.deepEqual(answers, [
      [422, 'NIN is 11 digits.'],
      [422, "We couldn't find this NIN. Check the 11 digits and try again."],
      [422, "This NIN isn't in the name Ada Obi. Check your NIN, or go back and fix your name."],
    ]);
    const ok = await post(token, { nin: '1234 5678 901' });
    assert.deepEqual([ok.status, await ok.json()], [200, { ok: true, status: 'VERIFIED' }]);
    assert.deepEqual(checked.at(-1), [id, '12345678901', 'Ada Obi']);
    // No name sent: the account's own.
    await post(token, { nin: '12345678901' });
    assert.equal(checked.at(-1)[2], 'Ada Obi');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test.after(async () => {
  await prisma.userConsent.deleteMany({ where: { userId: { in: made } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made } } });
  await prisma.$disconnect();
});
