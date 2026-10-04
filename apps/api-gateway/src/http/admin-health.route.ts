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
