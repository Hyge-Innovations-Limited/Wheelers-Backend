import type { RedisClient } from '../redis/client';
import { serviceUsage } from '../usage/service-usage';
import { overallStatus, readInstances, type ComponentCheck, type HealthStatus } from './checks';
import { SAMPLES_KEY, type HealthSample } from './jobs';
import {
  HOUR, MINUTE, QUARTER, emptyTotals, hgetall, mergeTotals, opsKey, percentileMs, totalsFromHash, totalsKey,
  type StatTotals,
} from './stats';

/**
 * Everything the admin Health page shows for one period: the checks right
 * now, uptime and a status bar per part, API and database charts, spikes
 * (minutes far above the period's usual), past incidents and the queries the
 * database spends its time on.
 */

export const RANGES = {
  '1h': { size: MINUTE, points: 60 },
  '24h': { size: QUARTER, points: 96 },
  '7d': { size: HOUR, points: 168 },
} as const;
export type HealthRange = keyof typeof RANGES;

export interface HealthPoint {
  at: number;
  requests: number;
  errors: number;
  httpP95: number | null;
  queries: number;
  dbErrors: number;
  dbP95: number | null;
  slowQueries: number;
  dbPingMs: number | null;
  redisPingMs: number | null;
}

const RANK: Record<HealthStatus, number> = { up: 0, degraded: 1, down: 2 };
const worst = (a: HealthStatus | null, b: HealthStatus): HealthStatus => (a === null || RANK[b] > RANK[a] ? b : a);
const avg = (values: number[]) => (values.length ? Math.round(values.reduce((s, v) => s + v, 0) / values.length) : null);

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const SPIKE_METRICS: Array<{ key: keyof HealthPoint; label: string; unit: 'ms' | 'count'; min: number }> = [
  { key: 'httpP95', label: 'API response time (p95)', unit: 'ms', min: 500 },
  { key: 'errors', label: 'API errors (5xx)', unit: 'count', min: 5 },
  { key: 'requests', label: 'API traffic', unit: 'count', min: 100 },
  { key: 'dbP95', label: 'Database query time (p95)', unit: 'ms', min: 100 },
  { key: 'slowQueries', label: 'Slow database queries', unit: 'count', min: 5 },
  { key: 'dbPingMs', label: 'Database ping', unit: 'ms', min: 250 },
];

/** Points at least 3× the period's median and past an absolute floor; neighbours merge into one spike. */
export function findSpikes(points: HealthPoint[], size: number) {
  const spikes: Array<{ metric: string; label: string; unit: 'ms' | 'count'; from: number; to: number; peak: number; usual: number }> = [];
  for (const metric of SPIKE_METRICS) {
    const values = points.map((p) => p[metric.key] as number | null);
    const usual = median(values.filter((v): v is number => v !== null && v > 0));
    const bar = Math.max(metric.min, usual * 3);
    let open: (typeof spikes)[number] | null = null;
    points.forEach((point, i) => {
      const v = values[i];
      if (v !== null && v !== undefined && v >= bar) {
        if (open && open.to === point.at) {
          open.to = point.at + size;
          open.peak = Math.max(open.peak, v);
        } else {
          open = { metric: String(metric.key), label: metric.label, unit: metric.unit, from: point.at, to: point.at + size, peak: v, usual: Math.round(usual) };
          spikes.push(open);
        }
      } else {
        open = null;
      }
    });
  }
  return spikes.sort((a, b) => b.from - a.from).slice(0, 20);
}

export async function buildHealthReport(redis: RedisClient, range: HealthRange, live: ComponentCheck[], now = Date.now()) {
  const { size, points: count } = RANGES[range];
  const firstSlot = Math.floor(now / size) - (count - 1);
  const from = firstSlot * size;

  // Counts per point, for both processes together.
  const totals = await Promise.all(Array.from({ length: count }, async (_, i) => {
    const slot = firstSlot + i;
    const [http, db] = await Promise.all([
      hgetall(redis, totalsKey('http', size, slot)).catch(() => ({})),
      hgetall(redis, totalsKey('db', size, slot)).catch(() => ({})),
    ]);
    return { at: slot * size, http: totalsFromHash(http), db: totalsFromHash(db) };
  }));

  // The minute checks in the period.
  const raw = await redis.send('ZRANGEBYSCORE', SAMPLES_KEY, String(from), '+inf').catch(() => null);
  const samples: HealthSample[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      try { samples.push(JSON.parse(String(item)) as HealthSample); } catch { /* skipped */ }
    }
  }
  const bySlot = new Map<number, HealthSample[]>();
  for (const sample of samples) {
    const slot = Math.floor(sample.at / size);
    bySlot.set(slot, [...(bySlot.get(slot) ?? []), sample]);
  }
  const samplesAt = (i: number) => bySlot.get(firstSlot + i) ?? [];

  const points: HealthPoint[] = totals.map((t, i) => {
    const inPoint = samplesAt(i);
    const latencyOf = (key: string) => inPoint.map((s) => s.c[key]?.[1]).filter((v): v is number => typeof v === 'number');
    return {
      at: t.at,
      requests: t.http.count,
      errors: t.http.errors,
      httpP95: percentileMs(t.http),
      queries: t.db.count,
      dbErrors: t.db.errors,
      dbP95: percentileMs(t.db),
      slowQueries: t.db.slow,
      dbPingMs: avg(latencyOf('postgres')),
      redisPingMs: avg(latencyOf('redis')),
    };
  });

  // Uptime and a status bar per part.
  const components = live.map((check) => {
    const seen = samples.filter((s) => s.c[check.key]);
    const available = seen.filter((s) => s.c[check.key]![0] !== 'down').length;
    const bars = Array.from({ length: count }, (_, i) => {
      let status: HealthStatus | null = null;
      for (const s of samplesAt(i)) if (s.c[check.key]) status = worst(status, s.c[check.key]![0]);
      return status ?? 'none';
    });
    return { ...check, uptimePct: seen.length ? Math.round((available / seen.length) * 10000) / 100 : null, checks: seen.length, bars };
  });

  // Incidents: unbroken runs of checks that were not up.
  const latestAt = samples.length ? samples[samples.length - 1]!.at : 0;
  const incidents: Array<{ key: string; label: string; status: HealthStatus; from: number; to: number; minutes: number; ongoing: boolean }> = [];
  for (const check of live) {
    let run: (typeof incidents)[number] | null = null;
    for (const s of samples) {
      const status = s.c[check.key]?.[0];
      if (status && status !== 'up') {
        if (!run) {
          run = { key: check.key, label: check.label, status, from: s.at, to: s.at + MINUTE, minutes: 1, ongoing: false };
          incidents.push(run);
        } else {
          run.status = worst(run.status, status);
          run.to = s.at + MINUTE;
          run.minutes = Math.max(1, Math.round((run.to - run.from) / MINUTE));
        }
        run.ongoing = s.at === latestAt;
      } else if (status) {
        run = null;
      }
    }
  }
  incidents.sort((a, b) => b.from - a.from);

  // Where the database spends its time.
  const hours = Array.from({ length: Math.ceil((now - from) / HOUR) + 1 }, (_, i) => Math.floor(from / HOUR) + i);
  const ops = new Map<string, { count: number; sumMs: number; slow: number; errors: number }>();
  for (const hour of hours) {
    const hash = await hgetall(redis, opsKey(hour)).catch(() => ({} as Record<string, string>));
    for (const [field, value] of Object.entries(hash)) {
      const [name, metric] = field.split('\t');
      if (!name || !metric) continue;
      const op = ops.get(name) ?? { count: 0, sumMs: 0, slow: 0, errors: 0 };
      if (metric === 'count' || metric === 'sumMs' || metric === 'slow' || metric === 'errors') op[metric] += Number(value) || 0;
      ops.set(name, op);
    }
  }
  const queries = [...ops.entries()]
    .map(([name, op]) => ({ name, ...op, avgMs: op.count ? Math.round(op.sumMs / op.count) : 0 }))
    .sort((a, b) => b.sumMs - a.sumMs)
    .slice(0, 15);

  const sum = (pick: (t: (typeof totals)[number]) => StatTotals) => {
    const all = emptyTotals();
    for (const t of totals) mergeTotals(all, pick(t));
    return all;
  };
  const http = sum((t) => t.http);
  const db = sum((t) => t.db);

  const [instances, services] = await Promise.all([
    readInstances(redis, now).catch(() => []),
    serviceUsage(redis, 1).catch(() => []),
  ]);

  return {
    range,
    generatedAt: now,
    overall: overallStatus(live),
    components,
    summary: {
      requests: http.count,
      errors: http.errors,
      errorRatePct: http.count ? Math.round((http.errors / http.count) * 10000) / 100 : 0,
      httpP95: percentileMs(http),
      httpAvgMs: http.count ? Math.round(http.sumMs / http.count) : null,
      queries: db.count,
      dbErrors: db.errors,
      dbP95: percentileMs(db),
      dbAvgMs: db.count ? Math.round(db.sumMs / db.count) : null,
      slowQueries: db.slow,
    },
    points,
    spikes: findSpikes(points, size),
    incidents: incidents.slice(0, 20),
    queries,
    instances: instances.map((b) => ({ ...b, uptimeMs: now - b.startedAt })),
    services: services
      .filter((s) => s.today.calls > 0)
      .map((s) => ({ key: s.key, label: s.label, calls: s.today.calls, failed: s.today.failed, avgMs: s.today.avgMs })),
  };
}

export type HealthReport = Awaited<ReturnType<typeof buildHealthReport>>;
