import type { IncomingMessage, ServerResponse } from 'http';
import type { RedisClient } from '../redis/client';
import { runHealthChecks } from '../health/checks';
import { buildHealthReport, RANGES, type HealthRange } from '../health/report';
import { verifyAdminAuth } from './admin-auth.route';
import { sendJson } from './utils';

interface AdminHealthDeps {
  adminApiKey: string;
  jwtSecret: string;
  redis: RedisClient;
  horizonUrl?: string | null;
}

/**
 * GET /admin/health?range=1h|24h|7d
 * The checks run now, plus the period's uptime, charts, spikes, incidents and slowest queries.
 */
export async function handleAdminHealthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminHealthDeps,
  url: URL,
): Promise<void> {
  if (!(await verifyAdminAuth(req, deps))) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }
  const asked = url.searchParams.get('range') ?? '24h';
  const range: HealthRange = asked in RANGES ? (asked as HealthRange) : '24h';
  try {
    const live = await runHealthChecks({ redis: deps.redis, horizonUrl: deps.horizonUrl });
    sendJson(res, 200, await buildHealthReport(deps.redis, range, live));
  } catch (error) {
    console.error('[admin-health] report failed', { error: error instanceof Error ? error.message : String(error) });
    sendJson(res, 500, { error: 'Could not build the health report.' });
  }
}

/**
 * The database's own view, for finding what to fix:
 *
 *   GET  /admin/health/sql          the slowest SQL by total time (pg_stat_statements, when switched
 *                                   on), and each table's size, full scans vs index use, and dead rows
 *   POST /admin/health/sql/reset    owners: start the SQL figures from zero (after a fix, to see its effect)
 *
 * pg_stat_statements needs Postgres started with it (infra/docker-compose.yml);
 * without it the SQL list says how to switch it on and the tables still show.
 */
export async function handleAdminHealthSqlRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminHealthDeps,
  url: URL,
): Promise<boolean> {
  if (url.pathname !== '/admin/health/sql' && url.pathname !== '/admin/health/sql/reset') return false;
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }
  const { prisma } = await import('@wheleers/db');

  if (url.pathname === '/admin/health/sql/reset') {
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed' }); return true; }
    if (auth.role !== 'OWNER') { sendJson(res, 403, { error: 'Owners only.' }); return true; }
    try {
      await prisma.$queryRawUnsafe('SELECT pg_stat_statements_reset()');
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 409, { error: 'pg_stat_statements is not switched on.', detail: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (req.method !== 'GET') { sendJson(res, 405, { error: 'Method not allowed' }); return true; }

  const num = (v: unknown) => (v === null || v === undefined ? null : Number(String(v)));
  let statements: { available: true; since: string | null; rows: Array<Record<string, unknown>> } | { available: false; reason: string };
  try {
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
      SELECT left(regexp_replace(s.query, '\\s+', ' ', 'g'), 700) AS query,
             s.calls, s.total_exec_time AS total_ms, s.mean_exec_time AS mean_ms, s.max_exec_time AS max_ms,
             s.rows, s.shared_blks_hit AS cache_hits, s.shared_blks_read AS disk_reads
      FROM pg_stat_statements s
      WHERE s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND s.query NOT ILIKE '%pg_stat_statements%'
      ORDER BY s.total_exec_time DESC
      LIMIT 30`);
    const info = await prisma.$queryRawUnsafe<Array<{ stats_reset: Date | null }>>('SELECT stats_reset FROM pg_stat_statements_info').catch(() => []);
    statements = {
      available: true,
      since: info[0]?.stats_reset ? new Date(info[0].stats_reset).toISOString() : null,
      rows: rows.map((r) => ({
        query: String(r.query ?? ''),
        calls: num(r.calls),
        totalMs: Math.round(num(r.total_ms) ?? 0),
        meanMs: Math.round((num(r.mean_ms) ?? 0) * 10) / 10,
        maxMs: Math.round(num(r.max_ms) ?? 0),
        rows: num(r.rows),
        cacheHitPct: (() => {
          const hits = num(r.cache_hits) ?? 0;
          const reads = num(r.disk_reads) ?? 0;
          return hits + reads > 0 ? Math.round((hits / (hits + reads)) * 1000) / 10 : null;
        })(),
      })),
    };
  } catch (error) {
    statements = {
      available: false,
      reason: `pg_stat_statements is not switched on (${error instanceof Error ? error.message.split('\n')[0] : 'unknown'}). Start Postgres with shared_preload_libraries=pg_stat_statements (infra/docker-compose.yml), then deploy: the migration creates the extension.`,
    };
  }

  const tables = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
    SELECT t.relname AS table,
           pg_total_relation_size(t.relid) AS bytes,
           t.n_live_tup AS live_rows, t.n_dead_tup AS dead_rows,
           t.seq_scan AS full_scans, t.seq_tup_read AS rows_read_by_full_scans, t.idx_scan AS index_scans,
           t.last_autovacuum, t.last_autoanalyze
    FROM pg_stat_user_tables t
    ORDER BY pg_total_relation_size(t.relid) DESC
    LIMIT 40`).catch(() => []);

  sendJson(res, 200, {
    statements,
    tables: tables.map((t) => ({
      table: String(t.table),
      sizeMb: Math.round(((num(t.bytes) ?? 0) / 1048576) * 10) / 10,
      liveRows: num(t.live_rows),
      deadRows: num(t.dead_rows),
      fullScans: num(t.full_scans),
      rowsReadByFullScans: num(t.rows_read_by_full_scans),
      indexScans: num(t.index_scans),
      lastAutovacuum: t.last_autovacuum ? new Date(t.last_autovacuum as Date).toISOString() : null,
      lastAutoanalyze: t.last_autoanalyze ? new Date(t.last_autoanalyze as Date).toISOString() : null,
    })),
  });
  return true;
}
