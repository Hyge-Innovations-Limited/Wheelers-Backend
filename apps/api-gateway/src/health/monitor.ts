import { prisma } from '@wheleers/db';
import { VITALS_KEY, VITALS_KEEP_MS, sendAlert, type VitalsSample } from '@wheleers/config';
import type { RedisClient } from '../redis/client';
import { HOUR, MINUTE, emptyTotals, hgetall, mergeTotals, percentileMs, routesKey, totalsFromHash, totalsKey, type StatTotals } from './stats';

/**
 * The Health page's longer memory and its alarms (on top of jobs.ts):
 *   every process, every minute: its vitals (CPU, memory, event-loop delay) into health:vitals, 8 days;
 *   the leader, every minute: how far behind Kafka consumers are into health:kafka, 8 days, and the alert lines;
 *   the leader, just after midnight Lagos: yesterday's row in HealthDay, kept for good;
 *   the leader, Monday 09:00 Lagos: the week on Telegram.
 */

export const KAFKA_KEY = 'health:kafka';
const LAGOS_MS = 3600_000;
const lagosDay = (at: number) => new Date(at + LAGOS_MS).toISOString().slice(0, 10);
const lagosHour = (at: number) => new Date(at + LAGOS_MS).getUTCHours();
const lagosMinute = (at: number) => new Date(at + LAGOS_MS).getUTCMinutes();
const lagosWeekday = (at: number) => new Date(at + LAGOS_MS).getUTCDay(); // 1 = Monday

export interface KafkaSample { at: number; lag: Record<string, number> }

/** The alert lines. A line crossed sends one Telegram message, then waits an hour before saying it again. */
export const ALERT_LINES = {
  apiP95Ms: 1000,        // 95% of API requests slower than this bucket (over 500 ms) for 10 minutes
  apiErrorPct: 2,        // more than 2% of API requests failing for 10 minutes
  minRequests: 100,      // only with at least this many requests in those 10 minutes
  loopP99Ms: 100,        // a process's event loop held up over 100 ms, two minutes running
  kafkaLag: 200,         // over 200 messages behind for 5 minutes
  locP95Ms: 1000,        // location pings taking over 500 ms (the 1 s bucket) for 10 minutes
  minPings: 50,
} as const;
const ALERT_REPEAT_SECONDS = 3600;

export async function zrange<T>(redis: RedisClient, key: string, from: number, to = Infinity): Promise<T[]> {
  const raw = await redis.send('ZRANGEBYSCORE', key, String(from), to === Infinity ? '+inf' : String(to)).catch(() => null);
  const out: T[] = [];
  if (Array.isArray(raw)) for (const item of raw) { try { out.push(JSON.parse(String(item)) as T); } catch { /* skipped */ } }
  return out;
}

export async function pushVitals(redis: RedisClient, sample: VitalsSample): Promise<void> {
  await redis.send('ZADD', VITALS_KEY, String(sample.at), JSON.stringify(sample));
  await redis.send('ZREMRANGEBYSCORE', VITALS_KEY, '-inf', String(sample.at - VITALS_KEEP_MS));
}

export async function sampleKafka(redis: RedisClient, lag: () => Promise<Record<string, number>>, now = Date.now()): Promise<KafkaSample> {
  const sample: KafkaSample = { at: now, lag: await lag() };
  await redis.send('ZADD', KAFKA_KEY, String(now), JSON.stringify(sample));
  await redis.send('ZREMRANGEBYSCORE', KAFKA_KEY, '-inf', String(now - VITALS_KEEP_MS));
  return sample;
}

async function totalsOver(redis: RedisClient, kind: 'http' | 'db' | 'loc', size: number, slots: number[]): Promise<StatTotals> {
  const out = emptyTotals();
  for (const slot of slots) mergeTotals(out, totalsFromHash(await hgetall(redis, totalsKey(kind, size, slot)).catch(() => ({}))));
  return out;
}

/** The finished minutes before now: the current one is still counting. */
const lastMinutes = (now: number, count: number) => Array.from({ length: count }, (_, i) => Math.floor(now / MINUTE) - count + i);

export type AlertFinding = { key: string; title: string; body: string };

/** Which lines are crossed right now (pure reading; nothing is sent). */
export async function findAlerts(redis: RedisClient, now = Date.now()): Promise<AlertFinding[]> {
  const out: AlertFinding[] = [];
  const minutes10 = lastMinutes(now, 10);
  const http = await totalsOver(redis, 'http', MINUTE, minutes10);
  if (http.count >= ALERT_LINES.minRequests) {
    const p95 = percentileMs(http);
    if (p95 !== null && p95 >= ALERT_LINES.apiP95Ms) {
      out.push({ key: 'api-slow', title: '🐢 API slow', body: `95% of the last 10 minutes' ${http.count} requests took up to ${p95} ms (normal is under 500).` });
    }
    const errorPct = (http.errors / http.count) * 100;
    if (errorPct > ALERT_LINES.apiErrorPct) {
      out.push({ key: 'api-errors', title: '❗ API errors', body: `${errorPct.toFixed(1)}% of the last 10 minutes' ${http.count} requests failed (${http.errors}).` });
    }
  }
  const loc = await totalsOver(redis, 'loc', MINUTE, minutes10);
  if (loc.count >= ALERT_LINES.minPings) {
    const p95 = percentileMs(loc);
    if (p95 !== null && p95 >= ALERT_LINES.locP95Ms) {
      out.push({ key: 'loc-slow', title: '📍 Driver locations slow', body: `95% of ${loc.count} location pings in 10 minutes took up to ${p95} ms to store.` });
    }
  }
  const vitals = await zrange<VitalsSample>(redis, VITALS_KEY, now - 3 * MINUTE);
  const byProcess = new Map<string, VitalsSample[]>();
  for (const v of vitals) byProcess.set(`${v.svc} ${v.id}`, [...(byProcess.get(`${v.svc} ${v.id}`) ?? []), v]);
  for (const [name, list] of byProcess) {
    const held = list.filter((v) => v.loopP99Ms > ALERT_LINES.loopP99Ms);
    if (held.length >= 2) {
      out.push({ key: `loop-${list[0]!.svc}`, title: '🧱 Node held up', body: `${name}: event loop delay ${Math.max(...held.map((v) => v.loopP99Ms))} ms (99th percentile), CPU ${Math.max(...list.map((v) => v.cpuPct))}%, memory ${Math.max(...list.map((v) => v.rssMb))} MB.` });
    }
  }
  const kafka = await zrange<KafkaSample>(redis, KAFKA_KEY, now - 5 * MINUTE - 30_000);
  if (kafka.length >= 5) {
    const behind = kafka.map((k) => Object.values(k.lag).reduce((a, b) => a + b, 0));
    if (behind.every((n) => n > ALERT_LINES.kafkaLag)) {
      const last = kafka[kafka.length - 1]!.lag;
      out.push({ key: 'kafka-lag', title: '📬 Ride events backing up', body: `Kafka consumers have been over ${ALERT_LINES.kafkaLag} messages behind for 5 minutes: ${Object.entries(last).map(([g, n]) => `${g} ${n}`).join(', ')}.` });
    }
  }
  return out;
}

/** Sends each crossed line once an hour at most. */
export async function sendAlerts(redis: RedisClient, findings: AlertFinding[], send = sendAlert): Promise<string[]> {
  const sent: string[] = [];
  for (const f of findings) {
    const first = await redis.send('SET', `health:alert:${f.key}`, '1', 'NX', 'EX', String(ALERT_REPEAT_SECONDS)).catch(() => null);
    if (first !== 'OK') continue;
    await send(f.title, f.body);
    sent.push(f.key);
  }
  return sent;
}

/** One Lagos day, from the hour counts in Redis (kept 8 days) and the database. */
export async function computeDay(redis: RedisClient, day: string) {
  const start = Date.parse(`${day}T00:00:00+01:00`);
  const end = start + 24 * HOUR;
  const hours = Array.from({ length: 24 }, (_, i) => Math.floor(start / HOUR) + i);
  const [http, db, loc] = await Promise.all([totalsOver(redis, 'http', HOUR, hours), totalsOver(redis, 'db', HOUR, hours), totalsOver(redis, 'loc', HOUR, hours)]);

  const routes = new Map<string, { count: number; sumMs: number }>();
  for (const slot of hours) {
    const raw = await hgetall(redis, routesKey(slot)).catch(() => ({} as Record<string, string>));
    for (const [field, value] of Object.entries(raw)) {
      const [route, metric] = field.split('\t');
      if (!route || (metric !== 'count' && metric !== 'sumMs')) continue;
      const r = routes.get(route) ?? { count: 0, sumMs: 0 };
      r[metric] += Number(value) || 0;
      routes.set(route, r);
    }
  }
  const slowRoutes = [...routes.entries()]
    .filter(([, r]) => r.count >= 20)
    .map(([route, r]) => ({ route, count: r.count, avgMs: Math.round(r.sumMs / r.count) }))
    .sort((a, b) => b.avgMs - a.avgMs)
    .slice(0, 5);

  const vitals = await zrange<VitalsSample>(redis, VITALS_KEY, start, end - 1);
  const kafka = await zrange<KafkaSample>(redis, KAFKA_KEY, start, end - 1);
  const max = (xs: number[]) => (xs.length ? Math.max(...xs) : null);

  const [searches, trips, riders, matchedDrivers, shiftDrivers] = await Promise.all([
    prisma.ride.count({ where: { createdAt: { gte: new Date(start), lt: new Date(end) } } }),
    prisma.ride.count({ where: { status: 'COMPLETED', completedAt: { gte: new Date(start), lt: new Date(end) } } }),
    prisma.ride.groupBy({ by: ['riderId'], where: { createdAt: { gte: new Date(start), lt: new Date(end) } } }),
    prisma.ride.groupBy({ by: ['driverId'], where: { matchedAt: { gte: new Date(start), lt: new Date(end) }, driverId: { not: null } } }),
    prisma.driverShift.groupBy({ by: ['driverId'], where: { startedAt: { lt: new Date(end) }, OR: [{ endedAt: null }, { endedAt: { gte: new Date(start) } }] } }),
  ]);
  const drivers = new Set([...matchedDrivers.map((d) => d.driverId), ...shiftDrivers.map((d) => d.driverId)].filter(Boolean));

  return {
    day,
    apiRequests: http.count, apiErrors: http.errors, apiP95Ms: percentileMs(http),
    dbQueries: db.count, dbP95Ms: percentileMs(db),
    locPings: loc.count, locP95Ms: percentileMs(loc),
    maxLoopP99Ms: max(vitals.map((v) => v.loopP99Ms)), maxCpuPct: max(vitals.map((v) => v.cpuPct)), maxRssMb: max(vitals.map((v) => v.rssMb)),
    maxKafkaLag: max(kafka.map((k) => Object.values(k.lag).reduce((a, b) => a + b, 0))),
    searches, trips, activeRiders: riders.length, activeDrivers: drivers.size,
    slowRoutes,
  };
}

/** Writes (or rewrites) one day's row. */
export async function saveDay(redis: RedisClient, day: string) {
  const row = await computeDay(redis, day);
  await prisma.healthDay.upsert({ where: { day }, create: row, update: row });
  return row;
}

/** Just after midnight Lagos (00:10 on), yesterday's row, once. */
export async function saveYesterdayOnce(redis: RedisClient, now = Date.now()): Promise<string | null> {
  if (lagosHour(now) !== 0 || lagosMinute(now) < 10) return null;
  const yesterday = lagosDay(now - 24 * HOUR);
  const first = await redis.send('SET', `health:day-saved:${yesterday}`, '1', 'NX', 'EX', String(3 * 24 * 3600)).catch(() => null);
  if (first !== 'OK') return null;
  await saveDay(redis, yesterday);
  return yesterday;
}

type Day = Awaited<ReturnType<typeof computeDay>>;

/** The week in a few lines, against the week before. */
export function weeklyText(week: Day[], before: Day[], span: { from: string; to: string }): { title: string; body: string } {
  const sum = (rows: Day[], k: keyof Day) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const maxOf = (rows: Day[], k: keyof Day) => rows.reduce<number | null>((a, r) => (r[k] === null || r[k] === undefined ? a : Math.max(a ?? 0, Number(r[k]))), null);
  const change = (now: number, then: number) => (then > 0 ? ` (${now >= then ? '+' : ''}${Math.round(((now - then) / then) * 100)}%)` : '');
  const line = (label: string, k: keyof Day) => `${label}: ${sum(week, k).toLocaleString('en-NG')}${change(sum(week, k), sum(before, k))}`;
  const errorPct = sum(week, 'apiRequests') ? ((sum(week, 'apiErrors') / sum(week, 'apiRequests')) * 100).toFixed(2) : '0';
  const p95s = week.map((d) => d.apiP95Ms).filter((x): x is number => x !== null);
  const { from, to } = span;
  const body = [
    line('Searches', 'searches'),
    line('Trips', 'trips'),
    `Active riders (busiest day): ${maxOf(week, 'activeRiders') ?? 0} · drivers: ${maxOf(week, 'activeDrivers') ?? 0}`,
    line('API requests', 'apiRequests'),
    `API errors: ${errorPct}% · slowest day's 95th percentile: ${p95s.length ? Math.max(...p95s) : '—'} ms`,
    line('Driver location pings', 'locPings'),
    `Node: event-loop delay peak ${maxOf(week, 'maxLoopP99Ms') ?? '—'} ms · CPU peak ${maxOf(week, 'maxCpuPct') ?? '—'}% · memory peak ${maxOf(week, 'maxRssMb') ?? '—'} MB`,
    `Kafka: most behind ${maxOf(week, 'maxKafkaLag') ?? '—'} messages`,
  ].join('\n');
  return { title: `📊 Wheelers week ${from} to ${to}`, body };
}

/** Monday from 09:00 Lagos, the week before, once. */
export async function weeklySummaryOnce(redis: RedisClient, now = Date.now(), send = sendAlert): Promise<boolean> {
  if (lagosWeekday(now) !== 1 || lagosHour(now) < 9) return false;
  const today = lagosDay(now);
  const first = await redis.send('SET', `health:weekly:${today}`, '1', 'NX', 'EX', String(8 * 24 * 3600)).catch(() => null);
  if (first !== 'OK') return false;
  const days = Array.from({ length: 14 }, (_, i) => lagosDay(now - (14 - i) * 24 * HOUR));
  const rows = await prisma.healthDay.findMany({ where: { day: { in: days } }, orderBy: { day: 'asc' } });
  const byDay = new Map(rows.map((r) => [r.day, r as unknown as Day]));
  const week = days.slice(7).map((d) => byDay.get(d)).filter((x): x is Day => Boolean(x));
  const before = days.slice(0, 7).map((d) => byDay.get(d)).filter((x): x is Day => Boolean(x));
  const { title, body } = weeklyText(week, before, { from: days[7]!, to: days[13]! });
  await send(title, body, { force: true });
  return true;
}
