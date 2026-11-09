// The Health page's longer memory and its alarms: vitals and Kafka backlog kept by the minute, location pings
// counted, alert lines (each sent once an hour at most), yesterday's permanent row, the Monday summary.
// Real local Redis (db 15) and Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/health-monitor.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { RedisClient } = require('../apps/api-gateway/dist/redis/client.js');
const monitor = require('../apps/api-gateway/dist/health/monitor.js');
const { createStatsRecorder } = require('../apps/api-gateway/dist/health/stats.js');
const { buildHealthReport } = require('../apps/api-gateway/dist/health/report.js');
const { meterLocation, setLocationSink } = require('../apps/api-gateway/dist/health/location-meter.js');
const { createVitalsSampler, VITALS_KEY } = require('@wheleers/config');

const prisma = new PrismaClient();
const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15';
let redis;
const DAY = '2021-04-05'; // a Monday far from other tests' rows
const dayStart = Date.parse(`${DAY}T00:00:00+01:00`);

test.before(async () => {
  redis = new RedisClient(REDIS_URL);
  await redis.connect();
  await redis.send('FLUSHDB');
});
test.after(async () => {
  await redis.send('FLUSHDB').catch(() => {});
  await redis.disconnect().catch(() => {});
  await prisma.healthDay.deleteMany({ where: { day: { in: [DAY, '2021-04-06'] } } }).catch(() => {});
  await prisma.$disconnect();
});

test('vitals: CPU, memory and event-loop delay, kept by the minute for every process', async () => {
  const sampler = createVitalsSampler('api-gateway', 'test-1');
  const v = sampler.sample(dayStart + 5 * 60_000);
  sampler.stop();
  assert.equal(v.svc, 'api-gateway');
  for (const k of ['cpuPct', 'rssMb', 'heapMb', 'loopP99Ms']) assert.equal(typeof v[k], 'number', k);
  await monitor.pushVitals(redis, v);
  const kept = await monitor.zrange(redis, VITALS_KEY, dayStart);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, 'test-1');
});

test('location pings are counted and timed, failures too', async () => {
  let now = dayStart + 10 * 60_000;
  const recorder = createStatsRecorder(() => now);
  setLocationSink(recorder.loc);
  await meterLocation(async () => 'stored');
  await assert.rejects(meterLocation(async () => { throw new Error('db down'); }));
  setLocationSink(null);
  now += 60_000;
  await recorder.flush(redis);
  const minute = Math.floor((dayStart + 10 * 60_000) / 60_000);
  const raw = await redis.send('HGETALL', `health:loc:1m:${minute}`);
  const fields = Object.fromEntries(raw.reduce((acc, x, i) => (i % 2 ? acc : [...acc, [x, raw[i + 1]]]), []));
  assert.equal(fields.count, '2');
  assert.equal(fields.errors, '1');
});

test('alert lines: crossed lines are found, and each is sent once an hour at most', async () => {
  const now = dayStart + 3 * 3600_000;
  const minute = Math.floor(now / 60_000);
  // 10 slow minutes: 20 requests each, all in the 2.5 s bucket, 1 error each (5%).
  for (let m = minute - 10; m < minute; m++) {
    await redis.send('HSET', `health:http:1m:${m}`, 'count', '20', 'errors', '1', 'sumMs', '40000', 'b6', '20');
  }
  // A process held up two minutes running; Kafka 300 behind for 5 minutes.
  for (const back of [1, 2]) await monitor.pushVitals(redis, { at: now - back * 60_000, svc: 'ride-service', id: 'p1', cpuPct: 95, rssMb: 400, heapMb: 200, loopP99Ms: 180 });
  for (const back of [1, 2, 3, 4, 5]) await redis.send('ZADD', monitor.KAFKA_KEY, String(now - back * 60_000), JSON.stringify({ at: now - back * 60_000, lag: { 'ride-service': 300 } }));

  const found = await monitor.findAlerts(redis, now);
  const keys = found.map((f) => f.key).sort();
  assert.deepEqual(keys, ['api-errors', 'api-slow', 'kafka-lag', 'loop-ride-service']);
  assert.match(found.find((f) => f.key === 'api-slow').body, /2500 ms/);

  const sent = [];
  await monitor.sendAlerts(redis, found, async (title, body) => { sent.push(title); return true; });
  assert.equal(sent.length, 4);
  await monitor.sendAlerts(redis, found, async (title) => { sent.push(title); return true; });
  assert.equal(sent.length, 4, 'not again within the hour');

  // Quiet traffic (under 100 requests) is never judged.
  await redis.send('FLUSHDB');
  await redis.send('HSET', `health:http:1m:${minute - 1}`, 'count', '10', 'errors', '5', 'sumMs', '30000', 'b6', '10');
  assert.deepEqual(await monitor.findAlerts(redis, now), []);
});

test('the daily row: counts, speeds and peaks for one Lagos day, kept in the database; then the Monday summary', async () => {
  await redis.send('FLUSHDB');
  const hour = Math.floor(dayStart / 3600_000) + 9;
  await redis.send('HSET', `health:http:60m:${hour}`, 'count', '1000', 'errors', '4', 'sumMs', '80000', 'b2', '960', 'b4', '40');
  await redis.send('HSET', `health:db:60m:${hour}`, 'count', '3000', 'sumMs', '9000', 'b0', '3000');
  await redis.send('HSET', `health:loc:60m:${hour}`, 'count', '600', 'sumMs', '6000', 'b0', '600');
  await redis.send('HSET', `health:routes:${hour}`, 'GET /rides/active 200\tcount', '50', 'GET /rides/active 200\tsumMs', '15000', 'GET /fast 200\tcount', '500', 'GET /fast 200\tsumMs', '5000');
  await monitor.pushVitals(redis, { at: dayStart + 9.5 * 3600_000, svc: 'api-gateway', id: 'p1', cpuPct: 40, rssMb: 300, heapMb: 150, loopP99Ms: 30 });
  await redis.send('ZADD', monitor.KAFKA_KEY, String(dayStart + 9.5 * 3600_000), JSON.stringify({ at: 0, lag: { 'ride-service': 12, gw: 3 } }));

  const row = await monitor.saveDay(redis, DAY);
  assert.equal(row.apiRequests, 1000);
  assert.equal(row.apiErrors, 4);
  assert.equal(row.apiP95Ms, 100);
  assert.equal(row.dbP95Ms, 25);
  assert.equal(row.locPings, 600);
  assert.equal(row.maxLoopP99Ms, 30);
  assert.equal(row.maxKafkaLag, 15);
  assert.deepEqual(row.slowRoutes[0], { route: 'GET /rides/active 200', count: 50, avgMs: 300 });
  const stored = await prisma.healthDay.findUnique({ where: { day: DAY } });
  assert.equal(stored.apiRequests, 1000);

  // Only just after midnight Lagos, and once.
  assert.equal(await monitor.saveYesterdayOnce(redis, Date.parse('2021-04-06T12:00:00+01:00')), null);
  assert.equal(await monitor.saveYesterdayOnce(redis, Date.parse('2021-04-06T00:15:00+01:00')), DAY);
  assert.equal(await monitor.saveYesterdayOnce(redis, Date.parse('2021-04-06T00:16:00+01:00')), null, 'once');

  // Monday 09:00 Lagos: the week before, once.
  const sent = [];
  const mondayAfter = Date.parse('2021-04-12T09:05:00+01:00');
  assert.equal(await monitor.weeklySummaryOnce(redis, Date.parse('2021-04-12T08:00:00+01:00'), async () => true), false, 'not before 09:00');
  assert.equal(await monitor.weeklySummaryOnce(redis, mondayAfter, async (title, body) => { sent.push({ title, body }); return true; }), true);
  assert.equal(await monitor.weeklySummaryOnce(redis, mondayAfter + 60_000, async (title) => { sent.push({ title }); return true; }), false, 'once');
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /2021-04-05 to 2021-04-11/);
  assert.match(sent[0].body, /API requests: 1,000/);
});

test('the Health report carries location pings, vitals and the Kafka backlog at its points', async () => {
  await redis.send('FLUSHDB');
  const now = Date.now();
  await monitor.pushVitals(redis, { at: now - 120_000, svc: 'ride-service', id: 'p1', cpuPct: 12, rssMb: 210, heapMb: 90, loopP99Ms: 9 });
  await redis.send('ZADD', monitor.KAFKA_KEY, String(now - 120_000), JSON.stringify({ at: now - 120_000, lag: { 'ride-service': 7 } }));
  const report = await buildHealthReport(redis, '1h', [], now);
  assert.equal(report.vitals[0].svc, 'ride-service');
  assert.ok(report.vitals[0].points.some((p) => p.loopP99Ms === 9));
  assert.ok(report.kafka.points.some((p) => p.lag === 7));
  assert.ok('locPings' in report.points[0]);
  assert.equal(typeof report.summary.locPings, 'number');
});

void randomUUID;
