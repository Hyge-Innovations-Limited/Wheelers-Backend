// Fewer database trips from the admin and the background jobs (Health showed
// the dashboard's bursts waiting for connections riders needed): dashboard
// numbers kept a minute and worked out at most 3 at once, the admin behind a
// token kept 15 seconds, and the Stellar job looking for account-less users
// every two minutes when there are none. Needs a built tree; the admin test
// needs the local Postgres.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');
const cache = require('../apps/api-gateway/dist/admin/dashboard-cache.js');
const { startStellarJob } = require('../apps/api-gateway/dist/stellar/service.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('dashboard numbers: the same question within a minute is answered from memory, and asked together it is worked out once', async () => {
  cache.forgetDashboard();
  let runs = 0;
  const compute = async () => { runs += 1; await sleep(20); return { requests: 42 }; };
  const together = await Promise.all([1, 2, 3, 4, 5].map(() => cache.kept60s('/admin/insights/summary?from=a', compute)));
  assert.equal(runs, 1);
  assert.deepEqual(together.map((r) => r.requests), [42, 42, 42, 42, 42]);
  await cache.kept60s('/admin/insights/summary?from=a', compute);
  assert.equal(runs, 1, 'again a moment later: from memory');
  await cache.kept60s('/admin/insights/summary?from=b', compute);
  assert.equal(runs, 2, 'other filters: worked out');
});

test('at most 3 are worked out at once; the rest wait their turn, and each still gets its answer', async () => {
  cache.forgetDashboard();
  let now = 0;
  let most = 0;
  const work = (i) => async () => { now += 1; most = Math.max(most, now); await sleep(15); now -= 1; return i; };
  const answers = await Promise.all(Array.from({ length: 10 }, (_, i) => cache.kept60s(`/k/${i}`, work(i))));
  assert.deepEqual(answers, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(most, 3);
  assert.deepEqual(cache.dashboardCacheState().running, 0);
});

test('a failure is never kept: the next ask tries again', async () => {
  cache.forgetDashboard();
  let runs = 0;
  await assert.rejects(cache.kept60s('/fails', async () => { runs += 1; throw new Error('db down'); }));
  assert.equal(await cache.kept60s('/fails', async () => { runs += 1; return 'ok'; }), 'ok');
  assert.equal(runs, 2);
});

test('the key is the path and its filters in a fixed order', () => {
  assert.equal(cache.dashboardKey(new URL('http://x/admin/insights/summary?to=2&from=1')), cache.dashboardKey(new URL('http://x/admin/insights/summary?from=1&to=2')));
  assert.notEqual(cache.dashboardKey(new URL('http://x/a?from=1')), cache.dashboardKey(new URL('http://x/a?from=2')));
});

test('the admin behind a token is kept 15 seconds; a role change made here is seen at once', async () => {
  const prisma = new PrismaClient();
  const local = require('../apps/api-gateway/dist/auth/local.js');
  const auth = require('../apps/api-gateway/dist/http/admin-auth.route.js');
  const SECRET = 'test-secret-that-is-at-least-32-characters-long';
  const admin = await prisma.adminUser.create({ data: { username: `speed-${Date.now()}`, passwordHash: 'x', name: 'Speed Staff', role: 'STAFF' } });
  try {
    const req = { method: 'GET', url: '/admin/insights/summary', headers: { authorization: `Bearer ${local.createLocalAccessToken(admin.id, SECRET, 3600)}` } };
    const deps = { adminApiKey: '', jwtSecret: SECRET };
    assert.equal((await auth.verifyAdminAuth(req, deps)).role, 'STAFF');
    await prisma.adminUser.update({ where: { id: admin.id }, data: { role: 'OWNER' } });
    assert.equal((await auth.verifyAdminAuth(req, deps)).role, 'STAFF', 'from memory, without a database trip');
    auth.forgetAdmin(admin.id);
    assert.equal((await auth.verifyAdminAuth(req, deps)).role, 'OWNER');
    await prisma.adminUser.update({ where: { id: admin.id }, data: { active: false } });
    auth.forgetAdmin(admin.id);
    assert.equal(await auth.verifyAdminAuth(req, deps), null, 'switched off: refused');
  } finally {
    await prisma.adminUser.delete({ where: { id: admin.id } });
    await prisma.$disconnect();
  }
});

test('the Stellar job: payments every round; looking for people without an account only every two minutes when there are none, every round while some are found or the queue is full', async () => {
  const run = async (opens) => {
    const calls = { opens: 0, due: 0 };
    let i = 0;
    const service = {
      openForEveryone: async (options) => { calls.opens += 1; return opens(i++, options); },
      processDue: async () => { calls.due += 1; },
    };
    const stop = startStellarJob(service, async () => true, 10, 10_000);
    await sleep(160);
    stop();
    return calls;
  };
  const idle = await run(() => 0);
  assert.equal(idle.opens, 1, 'nobody found: not again for two minutes');
  assert.ok(idle.due >= 8, `payments still every round (${idle.due})`);
  const found = await run((n) => (n < 3 ? 2 : 0));
  assert.equal(found.opens, 4, 'three rounds finding people, then one finding none');
  const full = await run((n, options) => { if (n < 5) options.onQueueFull(); return 0; });
  assert.equal(full.opens, 6, 'a full queue is not "nobody waiting"');
});
