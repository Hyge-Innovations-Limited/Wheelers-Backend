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
