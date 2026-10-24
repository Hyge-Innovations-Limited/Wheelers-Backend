/**
 * The admin dashboard's numbers, kept for a minute. Opening the dashboard asks
 * for ten or so summaries at once, each a handful of queries; worked out
 * every time, they took the database connections riders and drivers were
 * waiting for (Health: "Waiting for a connection", the admin login check at
 * 20 ms where Postgres needs 0). So, per gateway process:
 *
 *  - an answer is kept for 60 seconds (the same filters again: no queries);
 *  - the same question asked twice at once is worked out once;
 *  - at most 3 are worked out at the same time; the rest wait their turn
 *    here, not for a database connection.
 *
 * Errors are never kept. Nothing here is per person: these answers are the
 * same for every admin who may see them.
 */

const KEEP_MS = 60_000;
const MAX_KEPT = 300;
const AT_ONCE = 3;

const kept = new Map<string, { at: number; value: unknown }>();
const working = new Map<string, Promise<unknown>>();
const queue: Array<() => void> = [];
let running = 0;

/** One of the AT_ONCE places; a finished job hands its place straight to the next in line. */
async function inTurn<T>(work: () => Promise<T>): Promise<T> {
  if (running < AT_ONCE) running += 1;
  else await new Promise<void>((resolve) => queue.push(resolve));
  try {
    return await work();
  } finally {
    const next = queue.shift();
    if (next) next();
    else running -= 1;
  }
}

/** The key for a request: the path and its filters, in a fixed order. */
export function dashboardKey(url: URL): string {
  const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  return `${url.pathname}?${new URLSearchParams(params).toString()}`;
}

export async function kept60s<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const hit = kept.get(key);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.value as T;
  const already = working.get(key);
  if (already) return already as Promise<T>;
  const job = inTurn(compute)
    .then((value) => {
      kept.delete(key);
      kept.set(key, { at: Date.now(), value });
      if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value!);
      return value;
    })
    .finally(() => working.delete(key));
  working.set(key, job);
  return job;
}

/** Tests, and anything that knows the numbers just changed. */
export function forgetDashboard(): void {
  kept.clear();
}

export function dashboardCacheState() {
  return { kept: kept.size, working: working.size, running, waiting: queue.length };
}
