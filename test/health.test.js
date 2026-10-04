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
