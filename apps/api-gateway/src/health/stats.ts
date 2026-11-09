import type { RedisClient } from '../redis/client';

/**
 * Per-minute counts for the admin Health page: API requests and database
 * queries, each with failures and a latency histogram (so the p95 of both
 * gateway processes together can be read back). Counted in memory, written
 * to Redis once a minute per process; minute, quarter-hour and hour totals are
 * kept so 1 hour, 24 hours and 7 days each read about a hundred keys.
 */

/** Upper bounds of the latency buckets, ms. The last is "slower than 2.5 s". */
export const BUCKET_BOUNDS = [25, 50, 100, 250, 500, 1000, 2500, Infinity] as const;
export const SLOW_QUERY_MS = 500;
const KEEP_SECONDS = 8 * 24 * 3600;

export type StatKind = 'http' | 'db' | 'dbexec';

export interface StatTotals {
  count: number;
  errors: number;
  sumMs: number;
  slow: number;
  buckets: number[];
}

export const emptyTotals = (): StatTotals => ({ count: 0, errors: 0, sumMs: 0, slow: 0, buckets: BUCKET_BOUNDS.map(() => 0) });

export function addSample(t: StatTotals, ms: number, failed: boolean, slowMs: number): void {
  t.count += 1;
  if (failed) t.errors += 1;
  t.sumMs += ms;
  if (ms >= slowMs) t.slow += 1;
  t.buckets[BUCKET_BOUNDS.findIndex((bound) => ms <= bound)] += 1;
}

export function mergeTotals(into: StatTotals, from: StatTotals): void {
  into.count += from.count;
  into.errors += from.errors;
  into.sumMs += from.sumMs;
  into.slow += from.slow;
  from.buckets.forEach((n, i) => { into.buckets[i] += n; });
}

/** The bucket bound under which this share of calls finished; null with nothing counted. */
export function percentileMs(t: StatTotals, share = 0.95): number | null {
  if (t.count === 0) return null;
  let seen = 0;
  for (let i = 0; i < BUCKET_BOUNDS.length; i++) {
    seen += t.buckets[i]!;
    if (seen >= t.count * share) return BUCKET_BOUNDS[i] === Infinity ? 5000 : BUCKET_BOUNDS[i]!;
  }
  return 5000;
}

export const MINUTE = 60_000;
export const QUARTER = 15 * MINUTE;
export const HOUR = 60 * MINUTE;
export const totalsKey = (kind: StatKind, size: number, slot: number) => `health:${kind}:${size / MINUTE}m:${slot}`;
export const opsKey = (hourSlot: number) => `health:dbops:${hourSlot}`;
/** Per endpoint, per hour: count, time, the database and outside-service share, and a latency histogram. */
export const routesKey = (hourSlot: number) => `health:routes:${hourSlot}`;
/** A request slower than this counts as slow on the Health page. */
export const SLOW_REQUEST_MS = 1000;
/** Endpoints kept per process per minute: a flood of odd paths cannot fill Redis. */
const MAX_ROUTES_PER_MINUTE = 200;

export interface RouteTotals {
  count: number;
  errors: number;
  slow: number;
  sumMs: number;
  dbMs: number;
  dbQueries: number;
  extMs: number;
  extCalls: number;
  buckets: number[];
}

const emptyRoute = (): RouteTotals => ({ count: 0, errors: 0, slow: 0, sumMs: 0, dbMs: 0, dbQueries: 0, extMs: 0, extCalls: 0, buckets: BUCKET_BOUNDS.map(() => 0) });

function fieldsOf(t: StatTotals): Array<[string, number]> {
  const fields: Array<[string, number]> = [
    ['count', t.count], ['errors', t.errors], ['sumMs', Math.round(t.sumMs)], ['slow', t.slow],
    ...t.buckets.map((n, i): [string, number] => [`b${i}`, n]),
  ];
  return fields.filter(([, n]) => n > 0);
}

export function totalsFromHash(raw: Record<string, string>): StatTotals {
  const n = (k: string) => Number(raw[k] ?? 0) || 0;
  return { count: n('count'), errors: n('errors'), sumMs: n('sumMs'), slow: n('slow'), buckets: BUCKET_BOUNDS.map((_, i) => n(`b${i}`)) };
}

export async function hgetall(redis: RedisClient, key: string): Promise<Record<string, string>> {
  const reply = await redis.send('HGETALL', key);
  const out: Record<string, string> = {};
  if (Array.isArray(reply)) {
    for (let i = 0; i + 1 < reply.length; i += 2) out[String(reply[i])] = String(reply[i + 1]);
  }
  return out;
}

/** This process's counts, by minute, until written. */
export function createStatsRecorder(now: () => number = Date.now) {
  const minutes = new Map<number, {
    http: StatTotals;
    db: StatTotals;
    /** The same queries timed by Postgres alone (no wait for a connection). */
    dbExec: StatTotals;
    ops: Map<string, { count: number; sumMs: number; slow: number; errors: number }>;
    routes: Map<string, RouteTotals>;
  }>();

  function slot(at: number) {
    const minute = Math.floor(at / MINUTE);
    let entry = minutes.get(minute);
    if (!entry) {
      entry = { http: emptyTotals(), db: emptyTotals(), dbExec: emptyTotals(), ops: new Map(), routes: new Map() };
      minutes.set(minute, entry);
    }
    return entry;
  }

  return {
    /** An API request finished: 5xx counts as an error. */
    http(ms: number, status: number): void {
      addSample(slot(now()).http, ms, status >= 500, 1000);
    },

    /** One request's time, split (health/request-timing.ts). */
    route(key: string, ms: number, status: number, split: { dbMs: number; dbQueries: number; externalMs: number; externalCalls: number } | undefined): void {
      const entry = slot(now());
      let r = entry.routes.get(key);
      if (!r) {
        if (entry.routes.size >= MAX_ROUTES_PER_MINUTE) return;
        r = emptyRoute();
        entry.routes.set(key, r);
      }
      r.count += 1;
      if (status >= 500) r.errors += 1;
      if (ms >= SLOW_REQUEST_MS) r.slow += 1;
      r.sumMs += ms;
      r.dbMs += split?.dbMs ?? 0;
      r.dbQueries += split?.dbQueries ?? 0;
      r.extMs += split?.externalMs ?? 0;
      r.extCalls += split?.externalCalls ?? 0;
      r.buckets[BUCKET_BOUNDS.findIndex((bound) => ms <= bound)] += 1;
    },

    /** How long Postgres itself took for a query (Prisma's query event): the rest of a query's time was waiting. */
    dbExec(ms: number): void {
      addSample(slot(now()).dbExec, ms, false, SLOW_QUERY_MS);
    },

    /** A database query finished. */
    db(name: string, ms: number, failed: boolean): void {
      const entry = slot(now());
      addSample(entry.db, ms, failed, SLOW_QUERY_MS);
      const op = entry.ops.get(name) ?? { count: 0, sumMs: 0, slow: 0, errors: 0 };
      op.count += 1;
      op.sumMs += ms;
      if (ms >= SLOW_QUERY_MS) op.slow += 1;
      if (failed) op.errors += 1;
      entry.ops.set(name, op);
    },

    /** Writes every finished minute to Redis (the current one keeps counting). */
    async flush(redis: RedisClient): Promise<void> {
      const current = Math.floor(now() / MINUTE);
      for (const [minute, entry] of [...minutes.entries()].sort(([a], [b]) => a - b)) {
        if (minute >= current) continue;
        minutes.delete(minute);
        const at = minute * MINUTE;
        for (const kind of ['http', 'db', 'dbexec'] as const) {
          const fields = fieldsOf(kind === 'dbexec' ? entry.dbExec : entry[kind]);
          if (fields.length === 0) continue;
          for (const size of [MINUTE, QUARTER, HOUR]) {
            const key = totalsKey(kind, size, Math.floor(at / size));
            for (const [field, n] of fields) await redis.send('HINCRBY', key, field, String(n));
            await redis.send('EXPIRE', key, String(KEEP_SECONDS));
          }
        }
        if (entry.ops.size > 0) {
          const key = opsKey(Math.floor(at / HOUR));
          for (const [name, op] of entry.ops) {
            await redis.send('HINCRBY', key, `${name}\tcount`, String(op.count));
            await redis.send('HINCRBY', key, `${name}\tsumMs`, String(Math.round(op.sumMs)));
            if (op.slow) await redis.send('HINCRBY', key, `${name}\tslow`, String(op.slow));
            if (op.errors) await redis.send('HINCRBY', key, `${name}\terrors`, String(op.errors));
          }
          await redis.send('EXPIRE', key, String(KEEP_SECONDS));
        }
        if (entry.routes.size > 0) {
          const key = routesKey(Math.floor(at / HOUR));
          for (const [route, r] of entry.routes) {
            const metrics: Array<[string, number]> = [
              ['count', r.count], ['errors', r.errors], ['slow', r.slow], ['sumMs', r.sumMs], ['dbMs', r.dbMs],
              ['dbQueries', r.dbQueries], ['extMs', r.extMs], ['extCalls', r.extCalls],
              ...r.buckets.map((n, i): [string, number] => [`b${i}`, n]),
            ];
            for (const [metric, n] of metrics) if (n > 0) await redis.send('HINCRBY', key, `${route}\t${metric}`, String(Math.round(n)));
          }
          await redis.send('EXPIRE', key, String(KEEP_SECONDS));
        }
      }
    },
  };
}

export type StatsRecorder = ReturnType<typeof createStatsRecorder>;
