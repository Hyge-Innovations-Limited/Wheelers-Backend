// The admin Health page: counts per minute, live checks, uptime and incidents
// from the minute checks, spikes, and every database query timed. Real Redis
// (database 15, emptied first) and the local Postgres.
//
//   npm -w @wheleers/db run build && npm -w @wheleers/api-gateway run build
//   node scripts/run-with-env.cjs node --test --test-force-exit test/health.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { prisma, onPrismaQuery } = require('../packages/db/dist/index.js');
const { RedisClient } = require('../apps/api-gateway/dist/redis/client.js');
const stats = require('../apps/api-gateway/dist/health/stats.js');
const checks = require('../apps/api-gateway/dist/health/checks.js');
const { SAMPLES_KEY } = require('../apps/api-gateway/dist/health/jobs.js');
const report = require('../apps/api-gateway/dist/health/report.js');

const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15';
let redis;

test.before(async () => {
  console.warn = () => {};
  redis = new RedisClient(REDIS_URL);
  await redis.connect();
  await redis.send('FLUSHDB');
});
test.after(async () => {
  await redis.send('FLUSHDB');
  await redis.disconnect();
  await prisma.$disconnect();
});

test('requests and queries are counted per minute and add up across processes', async () => {
  let clock = Date.UTC(2026, 9, 4, 10, 0, 5);
  const a = stats.createStatsRecorder(() => clock);
  const b = stats.createStatsRecorder(() => clock);
  a.http(40, 200); a.http(900, 200); a.http(30, 503);
  b.http(60, 200);
  a.db('Ride.findMany', 12, false); a.db('Ride.findMany', 700, false); b.db('User.update', 5, true);

  await a.flush(redis);
  assert.equal(await redis.get(stats.totalsKey('http', stats.MINUTE, Math.floor(clock / stats.MINUTE))), null, 'the current minute keeps counting');

  clock += 60_000;
  await a.flush(redis);
  await b.flush(redis);
  const minute = Math.floor((clock - 60_000) / stats.MINUTE);
  const http = stats.totalsFromHash(await stats.hgetall(redis, stats.totalsKey('http', stats.MINUTE, minute)));
  assert.equal(http.count, 4);
  assert.equal(http.errors, 1);
  assert.equal(stats.percentileMs(http), 1000, 'p95 falls in the 1 s bucket');
  const hour = stats.totalsFromHash(await stats.hgetall(redis, stats.totalsKey('db', stats.HOUR, Math.floor((clock - 60_000) / stats.HOUR))));
  assert.equal(hour.count, 3);
  assert.equal(hour.slow, 1);
  assert.equal(hour.errors, 1);
  const ops = await stats.hgetall(redis, stats.opsKey(Math.floor((clock - 60_000) / stats.HOUR)));
  assert.equal(ops['Ride.findMany\tcount'], '2');
  assert.equal(ops['Ride.findMany\tslow'], '1');
});

test('every database query is timed by name', async () => {
  const seen = [];
  const off = onPrismaQuery((name, ms, failed) => seen.push({ name, ms, failed }));
  await prisma.ride.count();
  off();
  const hit = seen.find((q) => q.name === 'Ride.count');
  assert.ok(hit, 'Ride.count was reported');
  assert.equal(hit.failed, false);
  assert.ok(hit.ms >= 0);
});

test('the live checks: database and Redis answer; no API server reporting is an outage', async () => {
  await redis.send('DEL', checks.INSTANCES_KEY);
  let live = await checks.runHealthChecks({ redis });
  const byKey = Object.fromEntries(live.map((c) => [c.key, c]));
  assert.equal(byKey.postgres.status, 'up');
  assert.equal(byKey.redis.status, 'up');
  assert.ok(['up', 'degraded', 'down'].includes(byKey.kafka.status));
  assert.equal(byKey.gateway.status, 'down');
  assert.equal(checks.overallStatus(live), 'down');

  await redis.send('HSET', checks.INSTANCES_KEY, 'gw-1', JSON.stringify({ instanceId: 'gw-1', pid: 1, startedAt: Date.now() - 3600_000, at: Date.now(), rssMb: 120, heapMb: 60, loopP99Ms: 12, sockets: 7 }));
  live = await checks.runHealthChecks({ redis });
  const gateway = live.find((c) => c.key === 'gateway');
  assert.equal(gateway.status, 'up');
  assert.match(gateway.detail, /1 running · 7 live connections/);
});

test('uptime, the status bar and incidents come from the minute checks', async () => {
  await redis.send('DEL', SAMPLES_KEY);
  const now = Date.now();
  // 60 minutes: the database down for 3 of them, 20 minutes ago.
  for (let m = 59; m >= 0; m--) {
    const at = now - m * 60_000;
    const down = m >= 20 && m < 23;
    await redis.send('ZADD', SAMPLES_KEY, String(at), JSON.stringify({ at, overall: down ? 'down' : 'up', c: { postgres: [down ? 'down' : 'up', down ? null : 4], redis: ['up', 1] } }));
  }
  const live = [
    { key: 'postgres', label: 'Database (Postgres)', status: 'up', latencyMs: 4, detail: '', core: true },
    { key: 'redis', label: 'Redis', status: 'up', latencyMs: 1, detail: '', core: true },
  ];
  const r = await report.buildHealthReport(redis, '1h', live, now);
  const pg = r.components.find((c) => c.key === 'postgres');
  assert.equal(pg.uptimePct, 95);
  assert.equal(pg.bars.filter((b) => b === 'down').length, 3);
  assert.equal(r.components.find((c) => c.key === 'redis').uptimePct, 100);
  assert.equal(r.incidents.length, 1);
  assert.equal(r.incidents[0].key, 'postgres');
  assert.equal(r.incidents[0].minutes, 3);
  assert.equal(r.incidents[0].ongoing, false);
});

test('a spike is a stretch far above the usual for the period', () => {
  const size = 60_000;
  const points = Array.from({ length: 30 }, (_, i) => ({
    at: i * size, requests: 50, errors: 0, httpP95: i === 12 || i === 13 ? 2500 : 100,
    queries: 200, dbErrors: 0, dbP95: 25, slowQueries: 0, dbPingMs: 3, redisPingMs: 1,
  }));
  const spikes = report.findSpikes(points, size);
  assert.equal(spikes.length, 1);
  assert.equal(spikes[0].metric, 'httpP95');
  assert.equal(spikes[0].from, 12 * size);
  assert.equal(spikes[0].to, 14 * size);
  assert.equal(spikes[0].peak, 2500);
  assert.equal(spikes[0].usual, 100);
});

/* ── where a request's time goes ─────────────────────────────────────── */

const timing = require('../apps/api-gateway/dist/health/request-timing.js');

test('an endpoint is one row whatever the ids in its path', () => {
  assert.equal(timing.routeKey('GET', '/admin/drivers/9edaeacd-0fff-4d79-9936-ff8ac8058eb2/papers'), 'GET /admin/drivers/:id/papers');
  assert.equal(timing.routeKey('POST', '/rides/123456/cancel'), 'POST /rides/:id/cancel');
  assert.equal(timing.routeKey('GET', '/admin/trips/WH-00216'), 'GET /admin/trips/:id');
  assert.equal(timing.routeKey('GET', '/widget/ride/ride.js'), 'GET /widget/*');
  assert.equal(timing.routeKey('GET', '/ride-page/state'), 'GET /ride-page/state');
});

test('database and outside time are added to the request they happen in, and to no other', async () => {
  const seen = [];
  await Promise.all([
    timing.runWithTiming(async () => {
      timing.addDbTime(40);
      await new Promise((r) => setTimeout(r, 5));
      timing.addExternalTime(300);
      seen.push(['a', { ...timing.currentTiming() }]);
    }),
    timing.runWithTiming(async () => {
      timing.addDbTime(10);
      await new Promise((r) => setTimeout(r, 1));
      timing.addDbTime(15);
      seen.push(['b', { ...timing.currentTiming() }]);
    }),
  ]);
  timing.addDbTime(999); // outside any request: a job's query counts nowhere
  const a = seen.find(([k]) => k === 'a')[1];
  const b = seen.find(([k]) => k === 'b')[1];
  assert.deepEqual(a, { dbMs: 40, dbQueries: 1, externalMs: 300, externalCalls: 1 });
  assert.deepEqual(b, { dbMs: 25, dbQueries: 2, externalMs: 0, externalCalls: 0 });
});

test('the Health report lists the slowest endpoints with their time split, and the wait for a connection', async () => {
  await redis.send('FLUSHDB');
  let clock = Date.now() - 2 * 60_000;
  const rec = stats.createStatsRecorder(() => clock);
  for (let i = 0; i < 10; i++) rec.route('POST /rides/estimate', 900, 200, { dbMs: 100, dbQueries: 4, externalMs: 700, externalCalls: 2 });
  rec.route('POST /rides/estimate', 3000, 500, { dbMs: 100, dbQueries: 4, externalMs: 2700, externalCalls: 2 });
  for (let i = 0; i < 50; i++) rec.route('GET /ride-page/state', 40, 200, { dbMs: 30, dbQueries: 5, externalMs: 0, externalCalls: 0 });
  rec.db('Ride.findMany', 60, false);
  rec.db('Ride.findMany', 20, false);
  rec.dbExec(10);
  rec.dbExec(12);
  clock += 2 * 60_000;
  await rec.flush(redis);

  const r = await report.buildHealthReport(redis, '24h', [], clock);
  const estimate = r.endpoints.find((e) => e.route === 'POST /rides/estimate');
  assert.equal(r.endpoints[0].route, 'POST /rides/estimate', 'the most total time first');
  assert.equal(estimate.count, 11);
  assert.equal(estimate.errors, 1);
  assert.equal(estimate.slow, 1, 'over a second');
  assert.equal(estimate.avgMs, 1091);
  assert.equal(estimate.externalMs, 882, 'most of it is waiting on outside services');
  assert.equal(estimate.queriesPerRequest, 4);
  assert.equal(estimate.ownMs, 109);
  assert.equal(r.summary.dbRunAvgMs, 11);
  assert.equal(r.summary.dbWaitAvgMs, 29, 'queries took 40 ms on average, 11 of it in Postgres: 29 waiting');
});

test('the database\'s own figures: tables always, the SQL list or how to switch it on', async () => {
  const http = require('node:http');
  const local = require('../apps/api-gateway/dist/auth/local.js');
  const { handleAdminHealthSqlRoute } = require('../apps/api-gateway/dist/http/admin-health.route.js');
  const SECRET = 'test-secret-that-is-at-least-32-characters-long';
  const admin = await prisma.adminUser.create({ data: { username: `health-${Date.now()}`, passwordHash: 'x', name: 'Health Owner', role: 'OWNER' } });
  const server = http.createServer((req, res) => {
    void handleAdminHealthSqlRoute(req, res, { adminApiKey: 'unused', jwtSecret: SECRET, redis }, new URL(req.url, 'http://x')).then((handled) => { if (!handled) { res.statusCode = 404; res.end('{}'); } });
  });
  await new Promise((r) => server.listen(0, r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/health/sql`, { headers: { authorization: `Bearer ${local.createLocalAccessToken(admin.id, SECRET, 3600)}` } });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(body.tables.some((t) => t.table === 'Ride' && typeof t.fullScans === 'number'));
    if (body.statements.available) assert.ok(Array.isArray(body.statements.rows));
    else assert.match(body.statements.reason, /shared_preload_libraries/);
  } finally {
    server.close();
    await prisma.adminUser.delete({ where: { id: admin.id } });
  }
});
