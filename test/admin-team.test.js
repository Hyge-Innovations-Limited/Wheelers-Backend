// Owners and staff in the admin dashboard: staff cannot download the Excel
// export (and trying is flagged), screenshot keys are recorded and flagged
// (no emails), only owners see the team, the last owner cannot be made staff,
// and a page's hidden mark names its admin. Local Postgres; any email the
// code tried to send would be caught (there must be none).
//
//   npm -w @wheleers/db run build && npm -w @wheleers/api-gateway run build
//   node scripts/run-with-env.cjs node --test --test-force-exit test/admin-team.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { prisma } = require('../packages/db/dist/index.js');
const { RedisClient } = require('../apps/api-gateway/dist/redis/client.js');
const local = require('../apps/api-gateway/dist/auth/local.js');
const team = require('../apps/api-gateway/dist/http/admin-team.route.js');
const insights = require('../apps/api-gateway/dist/http/admin-insights.route.js');
const activity = require('../apps/api-gateway/dist/admin/activity.js');

const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15';
const made = [];
const emails = [];
const realFetch = globalThis.fetch;
let base, server, redis, deps;

async function admin(role) {
  const id = randomUUID();
  await prisma.adminUser.create({ data: { id, username: `t${id.slice(0, 8)}`, passwordHash: 'x', name: `Test ${role}`, role } });
  made.push(id);
  return { id, token: local.createLocalAccessToken(id, SECRET, 3600) };
}

async function call(method, path, token, body) {
  const res = await realFetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* a file */ }
  return { status: res.status, body: json, type: res.headers.get('content-type') };
}

const settle = () => new Promise((r) => setTimeout(r, 300));
const activityOf = (adminId) => prisma.adminActivity.findMany({ where: { adminId }, orderBy: { createdAt: 'asc' } });

test.before(async () => {
  console.warn = () => {};
  redis = new RedisClient(REDIS_URL);
  await redis.connect();
  await redis.send('FLUSHDB');
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
    if (url.includes('api.resend.com')) {
      emails.push(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    }
    return realFetch(input, init);
  };
  deps = { adminApiKey: 'k', jwtSecret: SECRET };
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (await team.handleAdminTeamRoute(req, res, deps, url)) return;
    if (await insights.handleAdminInsightsRoute(req, res, deps, url)) return;
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  globalThis.fetch = realFetch;
  server.close();
  await prisma.adminActivity.deleteMany({ where: { adminId: { in: made } } });
  await prisma.adminUser.deleteMany({ where: { id: { in: made } } });
  await redis.send('FLUSHDB');
  await redis.disconnect();
  await prisma.$disconnect();
});

test('staff cannot download the Excel export, and trying is flagged', async () => {
  emails.length = 0;
  const staff = await admin('STAFF');
  const r = await call('GET', '/admin/insights/export?scope=overview', staff.token);
  assert.equal(r.status, 403);
  await settle();
  const rows = await activityOf(staff.id);
  assert.equal(rows[0].kind, 'export-blocked');
  assert.equal(rows[0].flagged, true);
  assert.equal(emails.length, 0, 'no emails');
});

test('an owner downloads it, and the download is on the record', async () => {
  const owner = await admin('OWNER');
  const r = await call('GET', '/admin/insights/export?scope=fees', owner.token);
  assert.equal(r.status, 200);
  assert.match(r.type, /spreadsheetml/);
  await settle();
  const rows = await activityOf(owner.id);
  assert.equal(rows[0].kind, 'export');
  assert.equal(rows[0].flagged, false);
});

test('screenshot keys are recorded and flagged, every time, with no email', async () => {
  emails.length = 0;
  const staff = await admin('STAFF');
  for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/admin/activity', staff.token, { kind: 'capture', page: '/admin/dashboard/users', key: 'Meta+Shift+4' })).status, 200);
  await settle();
  const shots = (await activityOf(staff.id)).filter((r) => r.kind === 'screenshot');
  assert.equal(shots.length, 3);
  assert.ok(shots.every((s) => s.flagged));
  assert.equal(emails.length, 0);
});

test('only owners see the team, its timeline and flags', async () => {
  const staff = await admin('STAFF');
  const owner = await admin('OWNER');
  assert.equal((await call('GET', '/admin/team', staff.token)).status, 404, 'to staff the team does not exist');
  assert.equal((await call('GET', '/admin/team/activity', staff.token)).status, 404);
  const list = await call('GET', '/admin/team', owner.token);
  assert.equal(list.status, 200);
  const me = list.body.admins.find((a) => a.id === owner.id);
  assert.equal(me.isYou, true);
  assert.match(me.markCode, /^[0-9A-F]{6}$/);
  const flags = await call('GET', '/admin/team/flags', owner.token);
  assert.ok(flags.body.last24h >= 1);
  const timeline = await call('GET', '/admin/team/activity?flagged=1&limit=5', owner.token);
  assert.ok(timeline.body.rows.every((r) => r.flagged));
});

test('who am I says the role; a mark traces back to its admin', async () => {
  const staff = await admin('STAFF');
  const owner = await admin('OWNER');
  const me = await call('GET', '/admin/me', staff.token);
  assert.equal(me.body.role, 'STAFF');
  const trace = await call('GET', `/admin/team/trace?code=${me.body.markCode.toLowerCase()}`, owner.token);
  assert.equal(trace.body.admin.id, staff.id);
});

test('roles change, but the dashboard always keeps an owner', async () => {
  const owner = await admin('OWNER');
  const staff = await admin('STAFF');
  assert.equal((await call('PATCH', `/admin/team/${staff.id}`, owner.token, { role: 'OWNER' })).status, 200);
  assert.equal((await prisma.adminUser.findUnique({ where: { id: staff.id } })).role, 'OWNER');
  // Every other owner made staff for a moment (and put back after): the last one cannot be.
  const others = await prisma.adminUser.findMany({ where: { role: 'OWNER', id: { not: owner.id } }, select: { id: true } });
  await prisma.adminUser.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { role: 'STAFF' } });
  try {
    const r = await call('PATCH', `/admin/team/${owner.id}`, owner.token, { role: 'STAFF' });
    assert.equal(r.status, 409);
  } finally {
    await prisma.adminUser.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { role: 'OWNER' } });
  }
});

test('the timeline keeps searches, records opened and changes, not every list load', () => {
  const d = (m, p, s = 200) => activity.describeAdminRequest(m, new URL(`http://x${p}`), s);
  assert.deepEqual(d('GET', '/admin/users?q=tayo'), { kind: 'search', page: '/admin/users', detail: { q: 'tayo' } });
  assert.equal(d('GET', '/admin/users/abc').kind, 'view');
  assert.equal(d('POST', '/admin/drivers/abc/approve').kind, 'action');
  assert.equal(d('GET', '/admin/users'), null);
  assert.equal(d('GET', '/admin/health?range=1h'), null);
  assert.equal(d('POST', '/admin/activity'), null);
});
