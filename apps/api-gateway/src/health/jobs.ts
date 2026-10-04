import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { RedisClient } from '../redis/client';
import { INSTANCES_KEY, overallStatus, runHealthChecks, type HealthStatus, type InstanceHeartbeat } from './checks';
import type { StatsRecorder } from './stats';

/**
 * Keeps the Health page's history:
 *   every process, every 20 s: its request and query counts into Redis;
 *   every process, every minute: a heartbeat (memory, event loop delay, sockets);
 *   one process (the leader), every minute: the checks, kept for 7 days.
 * Nothing here can stop the gateway: every failure is logged once and skipped.
 */

export const SAMPLES_KEY = 'health:samples';
export const SAMPLE_KEEP_MS = 7 * 24 * 3600 * 1000;

export interface HealthSample {
  at: number;
  overall: HealthStatus;
  /** key → [status, latency ms or null] */
  c: Record<string, [HealthStatus, number | null]>;
}

export function startHealthJobs(deps: {
  redis: RedisClient;
  recorder: StatsRecorder;
  instanceId: string;
  sockets: () => number;
  isLeader: () => Promise<boolean>;
  horizonUrl?: string | null;
}): () => void {
  const startedAt = Date.now();
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  let warned = false;
  const warnOnce = (what: string, error: unknown) => {
    if (warned) return;
    warned = true;
    console.warn(`[health] ${what} failed; will keep trying quietly`, { error: error instanceof Error ? error.message : String(error) });
  };

  const flush = setInterval(() => {
    void deps.recorder.flush(deps.redis).catch((error) => warnOnce('writing counts', error));
  }, 20_000);

  const minute = setInterval(() => {
    void (async () => {
      const memory = process.memoryUsage();
      const beat: InstanceHeartbeat = {
        instanceId: deps.instanceId,
        pid: process.pid,
        startedAt,
        at: Date.now(),
        rssMb: Math.round(memory.rss / 1048576),
        heapMb: Math.round(memory.heapUsed / 1048576),
        loopP99Ms: Math.round(loop.percentile(99) / 1e6),
        sockets: deps.sockets(),
      };
      loop.reset();
      await deps.redis.send('HSET', INSTANCES_KEY, deps.instanceId, JSON.stringify(beat));

      if (!(await deps.isLeader())) return;
      const checks = await runHealthChecks({ redis: deps.redis, horizonUrl: deps.horizonUrl });
      const sample: HealthSample = {
        at: Date.now(),
        overall: overallStatus(checks),
        c: Object.fromEntries(checks.map((check) => [check.key, [check.status, check.latencyMs]])),
      };
      await deps.redis.send('ZADD', SAMPLES_KEY, String(sample.at), JSON.stringify(sample));
      await deps.redis.send('ZREMRANGEBYSCORE', SAMPLES_KEY, '-inf', String(sample.at - SAMPLE_KEEP_MS));

      // Processes that stopped reporting an hour ago are gone for good.
      const reply = await deps.redis.send('HGETALL', INSTANCES_KEY);
      if (Array.isArray(reply)) {
        for (let i = 0; i + 1 < reply.length; i += 2) {
          try {
            const old = JSON.parse(String(reply[i + 1])) as InstanceHeartbeat;
            if (sample.at - old.at > 3600_000) await deps.redis.send('HDEL', INSTANCES_KEY, String(reply[i]));
          } catch { /* skipped */ }
        }
      }
    })().catch((error) => warnOnce('the minute check', error));
  }, 60_000);

  return () => {
    clearInterval(flush);
    clearInterval(minute);
    loop.disable();
  };
}
