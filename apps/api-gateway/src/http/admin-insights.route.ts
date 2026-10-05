import type { IncomingMessage, ServerResponse } from 'http';
import { LAUNCH_ZONES } from '@wheleers/config';
import { adminAnalyticsClient, isDay, lagosToday, periodDays, RIDE_CHANNELS } from '@wheleers/db';
import type { AnalyticsFilters, BreakdownBy, Bucket, FeeKind, RideChannelName, TableQuery, TripStatusFilter } from '@wheleers/db';
import { buildWorkbook } from '../analytics/workbook';
import type { WorkbookScope } from '../analytics/workbook';
import { verifyAdminAuth } from './admin-auth.route';
import { clientIp, recordAdminActivity } from '../admin/activity';
import { sendJson } from './utils';

/**
 * The admin Home analytics and the Fees page. Every endpoint takes the same
 * filters in the query string:
 *
 *   from, to     Lagos days YYYY-MM-DD, both included (default: the last 30 days)
 *   zone         a launch zone name, or 'outside'
 *   channel      APP | WHATSAPP | MCP | UNKNOWN
 *   rideType     single | group
 *   driverId, riderId
 *
 *   GET /admin/insights/options                  what the filter menus offer
 *   GET /admin/insights/summary                  KPIs, the previous period's, and a live snapshot
 *   GET /admin/insights/timeseries?bucket=       day | week | month
 *   GET /admin/insights/breakdown?by=            channel | zone | rideType | cancelReason
 *   GET /admin/insights/hours                    requests and drivers on shift, by hour of day and weekday
 *   GET /admin/insights/trips?status=&q=&sort=&dir=&limit=&offset=
 *   GET /admin/insights/drivers?q=&sort=&dir=&limit=&offset=
 *   GET /admin/insights/riders?q=&sort=&dir=&limit=&offset=
 *   GET /admin/insights/reconcile                each headline total computed two ways
 *   GET /admin/insights/export?scope=overview|fees&bucket=&contacts=1   the Excel workbook
 *   GET /admin/fees/summary?bucket=
 *   GET /admin/fees/ledger?kind=&q=&sort=&dir=&limit=&offset=
 *   GET /admin/fees/deposits?q=&sort=&dir=&limit=&offset=      every deposit made (not tied to a ride)
 *   GET /admin/fees/withdrawals?q=&sort=&dir=&limit=&offset=   every withdrawal requested
 */

interface Deps {
  adminApiKey: string;
  jwtSecret: string;
}

class BadRequest extends Error {}

const MAX_PERIOD_DAYS = 800;
const BUCKETS: Bucket[] = ['day', 'week', 'month'];
const BREAKDOWNS: BreakdownBy[] = ['channel', 'zone', 'rideType', 'cancelReason'];
const TRIP_STATUSES: TripStatusFilter[] = ['all', 'completed', 'cancelled', 'no_driver', 'disputed', 'active', 'open'];
const FEE_KINDS: FeeKind[] = ['ride_fee', 'deposit_fee', 'withdrawal_fee', 'deposit_provider_fee', 'transfer_fee', 'provider_fee'];
const ID = /^[0-9a-zA-Z-]{8,64}$/;

function pick<T extends string>(url: URL, key: string, allowed: readonly T[], fallback: T): T {
  const raw = url.searchParams.get(key);
  if (raw == null || raw === '') return fallback;
  if (!(allowed as readonly string[]).includes(raw)) throw new BadRequest(`${key} must be one of ${allowed.join(', ')}`);
  return raw as T;
}

export function parseFilters(url: URL): AnalyticsFilters {
  const today = lagosToday();
  const to = url.searchParams.get('to') || today;
  const from = url.searchParams.get('from') || new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
  if (!isDay(from) || !isDay(to)) throw new BadRequest('from and to must be dates like 2026-09-27');
  if (from > to) throw new BadRequest('from must not be after to');
  if (periodDays({ from, to }) > MAX_PERIOD_DAYS) throw new BadRequest(`the period can be at most ${MAX_PERIOD_DAYS} days`);

  const zone = url.searchParams.get('zone') || null;
  if (zone && zone !== 'outside' && !LAUNCH_ZONES.some((z) => z.name === zone)) throw new BadRequest('unknown zone');
  const channel = url.searchParams.get('channel') || null;
  if (channel && !RIDE_CHANNELS.includes(channel as RideChannelName)) throw new BadRequest('unknown channel');
  const rideType = url.searchParams.get('rideType') || null;
  if (rideType && rideType !== 'single' && rideType !== 'group') throw new BadRequest('rideType must be single or group');
  const driverId = url.searchParams.get('driverId') || null;
  const riderId = url.searchParams.get('riderId') || null;
  if ((driverId && !ID.test(driverId)) || (riderId && !ID.test(riderId))) throw new BadRequest('invalid driverId or riderId');

  return {
    from,
    to,
    zone,
    channel: channel as RideChannelName | null,
    rideType: rideType as 'single' | 'group' | null,
    driverId,
    riderId,
  };
}

function tableQuery(url: URL): TableQuery {
  const int = (key: string, fallback: number) => {
    const n = Number.parseInt(url.searchParams.get(key) ?? '', 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const dir = url.searchParams.get('dir');
  return {
    q: url.searchParams.get('q'),
    sort: url.searchParams.get('sort'),
    dir: dir === 'asc' || dir === 'desc' ? dir : null,
    limit: int('limit', 50),
    offset: int('offset', 0),
  };
}

/** Handles every /admin/insights/* and /admin/fees/* path. Returns false when the path is not one of them. */
export async function handleAdminInsightsRoute(req: IncomingMessage, res: ServerResponse, deps: Deps, url: URL): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/admin/insights/') && !path.startsWith('/admin/fees/')) return false;
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }

  try {
    if (path === '/admin/insights/options') {
      sendJson(res, 200, { ...adminAnalyticsClient.options(), today: lagosToday() });
      return true;
    }
    const f = parseFilters(url);
    switch (path) {
      case '/admin/insights/summary':
        sendJson(res, 200, { ...(await adminAnalyticsClient.summary(f)) });
        return true;
      case '/admin/insights/timeseries': {
        const bucket = pick(url, 'bucket', BUCKETS, 'day');
        sendJson(res, 200, { filters: f, bucket, points: await adminAnalyticsClient.timeseries(f, bucket) });
        return true;
      }
      case '/admin/insights/breakdown': {
        const by = pick(url, 'by', BREAKDOWNS, 'channel');
        sendJson(res, 200, { filters: f, by, rows: await adminAnalyticsClient.breakdown(f, by) });
        return true;
      }
      case '/admin/insights/hours':
        sendJson(res, 200, { ...(await adminAnalyticsClient.hours(f)) });
        return true;
      case '/admin/insights/trips': {
        const status = pick(url, 'status', TRIP_STATUSES, 'all');
        sendJson(res, 200, { ...(await adminAnalyticsClient.trips(f, status, tableQuery(url))) });
        return true;
      }
      case '/admin/insights/drivers':
        sendJson(res, 200, { ...(await adminAnalyticsClient.drivers(f, tableQuery(url))) });
        return true;
      case '/admin/insights/riders':
        sendJson(res, 200, { ...(await adminAnalyticsClient.riders(f, tableQuery(url))) });
        return true;
      case '/admin/insights/reconcile':
        sendJson(res, 200, { filters: f, checks: await adminAnalyticsClient.reconcile(f) });
        return true;
      case '/admin/insights/export': {
        const scope = pick<WorkbookScope>(url, 'scope', ['overview', 'fees'], 'overview');
        const bucket = pick(url, 'bucket', BUCKETS, 'day');
        const contacts = url.searchParams.get('contacts') === '1';
        // The workbook holds every rider's and driver's details: owners only.
        if (auth.role !== 'OWNER') {
          recordAdminActivity({ adminId: auth.adminId, adminName: auth.adminName, kind: 'export-blocked', page: path, flagged: true, ip: clientIp(req), detail: { scope, from: f.from, to: f.to } });
          sendJson(res, 403, { error: 'This download is not available.' });
          return true;
        }
        recordAdminActivity({ adminId: auth.adminId, adminName: auth.adminName, kind: 'export', page: path, ip: clientIp(req), detail: { scope, from: f.from, to: f.to, contacts } });
        const file = await buildWorkbook(scope, f, bucket, contacts);
        const name = `wheelers-${scope}-${f.from}-to-${f.to}.xlsx`;
        res.statusCode = 200;
        res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('content-disposition', `attachment; filename="${name}"`);
        res.setHeader('access-control-expose-headers', 'content-disposition');
        res.setHeader('cache-control', 'no-store');
        res.setHeader('content-length', file.length);
        res.end(file);
        return true;
      }
      case '/admin/fees/summary': {
        const bucket = pick(url, 'bucket', BUCKETS, 'day');
        sendJson(res, 200, { ...(await adminAnalyticsClient.fees(f, bucket)) });
        return true;
      }
      case '/admin/fees/deposits':
        sendJson(res, 200, { ...(await adminAnalyticsClient.deposits(f, tableQuery(url))) });
        return true;
      case '/admin/fees/withdrawals':
        sendJson(res, 200, { ...(await adminAnalyticsClient.withdrawals(f, tableQuery(url))) });
        return true;
      case '/admin/fees/ledger': {
        const raw = url.searchParams.get('kind');
        const kind = raw ? pick(url, 'kind', FEE_KINDS, 'ride_fee') : null;
        sendJson(res, 200, { ...(await adminAnalyticsClient.feeLedger(f, kind, tableQuery(url))) });
        return true;
      }
      default:
        sendJson(res, 404, { error: 'Not found' });
        return true;
    }
  } catch (error) {
    if (error instanceof BadRequest) {
      sendJson(res, 400, { error: error.message });
      return true;
    }
    console.error('[admin-analytics] request failed', { path, error: error instanceof Error ? error.message : String(error) });
    sendJson(res, 500, { error: 'Could not load these numbers. Try again.' });
    return true;
  }
}
