import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * A process's vitals for the Health page: CPU, memory and event-loop delay, read once a minute.
 * The event-loop delay is the number that says Node itself is struggling (a busy CPU or a long
 * synchronous job holds every request up), before any request looks slow.
 */
export interface VitalsSample {
  at: number;
  /** Which service and which process (pm2 cluster mode runs several of one service). */
  svc: string;
  id: string;
  /** Share of one CPU core this process used since the last sample. */
  cpuPct: number;
  rssMb: number;
  heapMb: number;
  /** 99% of event-loop waits were shorter than this. */
  loopP99Ms: number;
}

export const VITALS_KEY = 'health:vitals';
export const VITALS_KEEP_MS = 8 * 24 * 3600 * 1000;

export function createVitalsSampler(svc: string, id: string) {
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  let lastCpu = process.cpuUsage();
  let lastAt = Date.now();
  return {
    sample(now = Date.now()): VitalsSample {
      const cpu = process.cpuUsage(lastCpu);
      const elapsedMs = Math.max(1, now - lastAt);
      lastCpu = process.cpuUsage();
      lastAt = now;
      const memory = process.memoryUsage();
      const out: VitalsSample = {
        at: now, svc, id,
        cpuPct: Math.round(((cpu.user + cpu.system) / 1000 / elapsedMs) * 1000) / 10,
        rssMb: Math.round(memory.rss / 1048576),
        heapMb: Math.round(memory.heapUsed / 1048576),
        loopP99Ms: Math.round(loop.percentile(99) / 1e6),
      };
      loop.reset();
      return out;
    },
    stop() { loop.disable(); },
  };
}
