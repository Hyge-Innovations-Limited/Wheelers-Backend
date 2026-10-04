import { healthClient } from '@wheleers/db';
import type { RedisClient } from '../redis/client';

/**
 * The live checks behind the admin Health page, one per part of the system.
 * Each has a time limit and two thresholds: under the first it is up, under
 * the second it is slow ("degraded"), past it, or failing, it is down.
 */

export type HealthStatus = 'up' | 'degraded' | 'down';

export interface ComponentCheck {
  key: string;
  label: string;
  status: HealthStatus;
  /** How long the check took, ms (null when it has no single round trip). */
  latencyMs: number | null;
  /** One line for the page: why, or what was seen. */
  detail: string;
  /** Up or down here decides "outage" for the whole platform. */
  core: boolean;
}

export interface InstanceHeartbeat {
  instanceId: string;
  pid: number;
  startedAt: number;
  at: number;
  rssMb: number;
  heapMb: number;
  /** Event loop delay p99 over the last minute, ms: how long a request can wait just to be looked at. */
  loopP99Ms: number;
  sockets: number;
}

export const INSTANCES_KEY = 'health:instances';
const INSTANCE_FRESH_MS = 3 * 60_000;

export interface CheckDeps {
  redis: RedisClient;
  /** Stellar testnet Horizon, when Stellar is on. */
  horizonUrl?: string | null;
  now?: () => number;
}

async function timed<T>(work: () => Promise<T>, limitMs: number): Promise<{ ms: number; value?: T; error?: string }> {
  const started = performance.now();
  try {
    const value = await Promise.race([
      work(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer in ${limitMs / 1000}s`)), limitMs)),
    ]);
    return { ms: Math.round(performance.now() - started), value };
  } catch (error) {
    return { ms: Math.round(performance.now() - started), error: error instanceof Error ? error.message : String(error) };
  }
}

const grade = (ms: number, upUnder: number, degradedUnder: number): HealthStatus =>
  ms < upUnder ? 'up' : ms < degradedUnder ? 'degraded' : 'down';

export async function readInstances(redis: RedisClient, now = Date.now()): Promise<InstanceHeartbeat[]> {
  const reply = await redis.send('HGETALL', INSTANCES_KEY);
  const out: InstanceHeartbeat[] = [];
  if (!Array.isArray(reply)) return out;
  for (let i = 1; i < reply.length; i += 2) {
    try {
      const beat = JSON.parse(String(reply[i])) as InstanceHeartbeat;
      if (now - beat.at <= INSTANCE_FRESH_MS) out.push(beat);
    } catch { /* a bad entry is skipped */ }
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

export async function runHealthChecks(deps: CheckDeps): Promise<ComponentCheck[]> {
  const now = (deps.now ?? Date.now)();

  const [db, redis, outbox, instances, horizon] = await Promise.all([
    timed(() => healthClient.ping(), 5000),
    timed(() => deps.redis.send('PING'), 3000),
    timed(() => healthClient.outboxBacklog(), 5000),
    timed(() => readInstances(deps.redis, now), 3000),
    deps.horizonUrl ? timed(async () => {
      const res = await fetch(deps.horizonUrl!, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`Horizon answered ${res.status}`);
    }, 5000) : Promise.resolve(null),
  ]);

  const checks: ComponentCheck[] = [];

  checks.push({
    key: 'postgres', label: 'Database (Postgres)', core: true, latencyMs: db.ms,
    status: db.error ? 'down' : grade(db.ms, 250, 1500),
    detail: db.error ? `Not answering: ${db.error}` : `Answered in ${db.ms} ms`,
  });

  checks.push({
    key: 'redis', label: 'Cache and live state (Redis)', core: true, latencyMs: redis.ms,
    status: redis.error ? 'down' : grade(redis.ms, 50, 500),
    detail: redis.error ? `Not answering: ${redis.error}` : `Answered in ${redis.ms} ms`,
  });

  // Kafka is seen through the outbox: events waiting to be sent pile up when it is down.
  if (outbox.error || !outbox.value) {
    checks.push({ key: 'kafka', label: 'Event bus (Kafka)', core: false, latencyMs: null, status: 'down', detail: `Could not read the outbox: ${outbox.error ?? 'no answer'}` });
  } else {
    const waitedMs = outbox.value.oldestCreatedAt ? now - outbox.value.oldestCreatedAt.getTime() : 0;
    const waited = Math.round(waitedMs / 1000);
    checks.push({
      key: 'kafka', label: 'Event bus (Kafka)', core: false, latencyMs: null,
      status: waitedMs < 60_000 ? 'up' : waitedMs < 5 * 60_000 ? 'degraded' : 'down',
      detail: outbox.value.pending === 0
        ? 'Every event delivered'
        : `${outbox.value.pending} event${outbox.value.pending === 1 ? '' : 's'} waiting; oldest ${waited < 120 ? `${waited}s` : `${Math.round(waited / 60)} min`}`,
    });
  }

  const alive = instances.value ?? [];
  const slowest = alive.reduce((max, beat) => Math.max(max, beat.loopP99Ms), 0);
  checks.push({
    key: 'gateway', label: 'API servers', core: true, latencyMs: null,
    status: alive.length === 0 ? 'down' : slowest >= 500 ? 'degraded' : 'up',
    detail: alive.length === 0
      ? 'No server has reported in the last 3 minutes'
      : `${alive.length} running · ${alive.reduce((sum, b) => sum + b.sockets, 0)} live connections${slowest >= 500 ? ` · busy (${slowest} ms delays)` : ''}`,
  });

  if (horizon) {
    checks.push({
      key: 'stellar', label: 'Stellar testnet (Horizon)', core: false, latencyMs: horizon.ms,
      status: horizon.error ? 'down' : grade(horizon.ms, 1500, 4000),
      detail: horizon.error ? `Not answering: ${horizon.error}` : `Answered in ${horizon.ms} ms`,
    });
  }

  return checks;
}

/** The platform as a whole: an outage when a core part is down, degraded when anything is not up. */
export function overallStatus(checks: ComponentCheck[]): HealthStatus {
  if (checks.some((c) => c.core && c.status === 'down')) return 'down';
  if (checks.some((c) => c.status !== 'up')) return 'degraded';
  return 'up';
}
