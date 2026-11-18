// The NIN popup (Timi, 18 Nov 2026): a rider with no NIN, or one that did not check out, is asked in the app, on the
// ride page and once a week at most on WhatsApp. Never required. At most every 3 days, never after 5 closes; never a
// verified, suspended or still-checking NIN, never a driver, never with today's tries used up. Real Postgres, Redis 15.
//
//   npm -w @wheleers/api-gateway run build
//   node scripts/run-with-env.cjs node --test --test-force-exit test/nin-prompt.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { RedisClient } = require('../apps/api-gateway/dist/redis/client.js');
const np = require('../apps/api-gateway/dist/verification/nin-prompt.js');

const prisma = new PrismaClient();
let redis;
const made = [];
test.before(async () => {
  redis = new RedisClient(process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15');
  await redis.connect();
});
test.after(async () => {
  for (const id of made) await redis.del(`nin-prompt:${id}`).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made } } });
  await prisma.$disconnect();
  await redis.disconnect().catch(() => {});
});
async function person(extra = {}) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:nin-prompt:${id}`, role: 'RIDER', name: 'Ada Obi', ...extra } });
  made.push(id);
  return id;
}

test('who is asked: no NIN or one that did not check out; never verified, suspended, unchecked, or a driver', async () => {
  assert.deepEqual(await np.ninPromptFor(redis, await person()), { ask: true, retry: false });
  assert.deepEqual(await np.ninPromptFor(redis, await person({ ninStatus: 'NO_MATCH' })), { ask: true, retry: true });
  assert.deepEqual(await np.ninPromptFor(redis, await person({ ninStatus: 'NOT_FOUND' })), { ask: true, retry: true });
  for (const status of ['VERIFIED', 'SUSPENDED', 'UNCHECKED']) {
    assert.equal((await np.ninPromptFor(redis, await person({ ninStatus: status }))).ask, false, status);
  }
  assert.equal((await np.ninPromptFor(redis, await person({ role: 'DRIVER' }))).ask, false, 'drivers do KYC');
});

test('how often: shown, then not again for 3 days; 5 closes and never again; today\'s tries used up: not now', async () => {
  const id = await person();
  const t0 = Date.parse('2026-11-18T10:00:00Z');
  await np.noteNinPrompt(redis, id, 'shown', t0);
  assert.equal((await np.ninPromptFor(redis, id, t0 + 2 * 86_400_000)).ask, false, 'two days later');
  assert.equal((await np.ninPromptFor(redis, id, t0 + 3 * 86_400_000)).ask, true, 'three days later');
  for (let i = 0; i < 5; i++) await np.noteNinPrompt(redis, id, 'closed', t0);
  assert.equal((await np.ninPromptFor(redis, id, t0 + 30 * 86_400_000)).ask, false, 'closed 5 times: never again');

  const tried = await person();
  await redis.set(`rider-nin:${tried}:${new Date().toISOString().slice(0, 10)}`, '3', 3600);
  assert.equal((await np.ninPromptFor(redis, tried)).ask, false, 'out of today\'s Prembly tries');
  await redis.del(`rider-nin:${tried}:${new Date().toISOString().slice(0, 10)}`);
});

test('WhatsApp: once a week at most, even if two trips end at the same moment', async () => {
  const id = await person();
  const claims = await Promise.all([np.claimNinWhatsapp(redis, id), np.claimNinWhatsapp(redis, id)]);
  assert.deepEqual(claims.sort(), [false, true]);
  await redis.del(`nin-prompt:wa:${id}`);
});

test('GET / POST /nin/prompt over HTTP: the app asks, then says shown or closed', async () => {
  const http = require('node:http');
  const local = require('../apps/api-gateway/dist/auth/local.js');
  const { handleNinPromptRoute } = require('../apps/api-gateway/dist/http/rider-nin.route.js');
  const jwtSecret = 'test-secret-that-is-at-least-32-characters-long';
  const server = http.createServer((req, res) => { void handleNinPromptRoute(req, res, { jwtSecret, redisClient: redis }); });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/nin/prompt`;
  try {
    const id = await person();
    const auth = { authorization: `Bearer ${local.createLocalAccessToken(id, jwtSecret, 3600)}`, 'content-type': 'application/json' };
    const get = async () => (await fetch(base, { headers: auth })).json();
    const post = (event) => fetch(base, { method: 'POST', headers: auth, body: JSON.stringify({ event }) });
    assert.deepEqual(await get(), { ask: true, retry: false });
    assert.equal((await post('shown')).status, 200);
    assert.equal((await get()).ask, false, 'shown just now: not again for 3 days');
    assert.equal((await post('nope')).status, 400);
    assert.equal((await fetch(base)).status, 401, 'signed in only');
  } finally {
    server.close();
  }
});
