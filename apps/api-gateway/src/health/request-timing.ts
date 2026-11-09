import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Where one API request's time goes, for the Health page's "Slowest
 * endpoints": the database (Prisma's own timer, so a wait for a free
 * connection counts here), outside services (Google, the AI, Paystack, Meta,
 * Prembly, Horizon), and the rest, which is our own work.
 *
 * Every request runs inside its own timing (runWithTiming, in the server's
 * request handler); the database and outbound-call meters add to whichever
 * request is running. Work outside a request (jobs, sockets) adds to nothing.
 * Calls made side by side are each added in full, so database + outside can
 * exceed the request's own time; "own work" is then shown as 0.
 */
export interface RequestTiming {
  dbMs: number;
  dbQueries: number;
  externalMs: number;
  externalCalls: number;
}

const storage = new AsyncLocalStorage<RequestTiming>();

export function runWithTiming<T>(fn: () => T): T {
  return storage.run({ dbMs: 0, dbQueries: 0, externalMs: 0, externalCalls: 0 }, fn);
}

export function currentTiming(): RequestTiming | undefined {
  return storage.getStore();
}

export function addDbTime(ms: number): void {
  const t = storage.getStore();
  if (!t) return;
  t.dbMs += ms;
  t.dbQueries += 1;
}

export function addExternalTime(ms: number): void {
  const t = storage.getStore();
  if (!t) return;
  t.externalMs += ms;
  t.externalCalls += 1;
}

const ID_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|\d{3,}|WH-?\d+|[A-Za-z0-9_-]{24,}|\+?\d{7,})$/i;

/**
 * The endpoint a request was for, with ids taken out, so one route is one
 * row: GET /admin/drivers/9eda…/papers → GET /admin/drivers/:id/papers.
 * Static files (the pages WhatsApp opens) are one row each kind.
 */
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export function routeKey(method: string | undefined, pathname: string, status?: number): string {
  const verb = method && METHODS.has(method) ? method : 'OTHER';
  // Paths nobody serves are one row: anyone can make up a new one each request,
  // and each would be its own row in Redis.
  if (status === 404) return `${verb} (not found)`;
  if (pathname.startsWith('/widget/')) return `${verb} /widget/*`;
  const path = pathname
    .split('/')
    .map((segment) => (segment && ID_SEGMENT.test(segment) ? ':id' : segment))
    .join('/')
    .slice(0, 120);
  return `${verb} ${path || '/'}`;
}
