import { prisma } from './prisma';

/**
 * Every query through the shared Prisma client, timed, for the admin Health
 * page: "model.action" (e.g. "Ride.findMany", "raw.queryRaw"), how long it
 * took and whether it failed. Installed once; listeners never slow or break a
 * query (they are called after it, and their errors are swallowed).
 */
export type QueryListener = (name: string, ms: number, failed: boolean) => void;

const listeners = new Set<QueryListener>();
let installed = false;

export function onPrismaQuery(listener: QueryListener): () => void {
  if (!installed) {
    installed = true;
    prisma.$use(async (params, next) => {
      const started = performance.now();
      let failed = false;
      try {
        return await next(params);
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        const ms = performance.now() - started;
        const name = `${params.model ?? 'raw'}.${params.action}`;
        for (const notify of listeners) {
          try { notify(name, ms, failed); } catch { /* a listener never breaks a query */ }
        }
      }
    });
  }
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export type ExecutionListener = (ms: number) => void;
const executionListeners = new Set<ExecutionListener>();
let executionInstalled = false;

/**
 * How long Postgres itself took for each query (Prisma's query event), without
 * the wait for a free connection that onPrismaQuery's time includes. The two
 * side by side say whether "slow" is the database or the queue for it.
 */
export function onPrismaExecution(listener: ExecutionListener): () => void {
  if (!executionInstalled) {
    executionInstalled = true;
    const on = prisma.$on as unknown as (event: 'query', cb: (e: { duration: number }) => void) => void;
    on.call(prisma, 'query', (event) => {
      for (const notify of executionListeners) {
        try { notify(Number(event.duration) || 0); } catch { /* a listener never breaks a query */ }
      }
    });
  }
  executionListeners.add(listener);
  return () => { executionListeners.delete(listener); };
}
