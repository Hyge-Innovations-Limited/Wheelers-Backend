import type { IncomingMessage, ServerResponse } from 'http';
import { isDay, lagosToday, periodDays, prisma } from '@wheleers/db';
import { clientIp, recordAdminActivity } from '../admin/activity';
import { verifyAdminAuth } from './admin-auth.route';
import { sendJson } from './utils';

/**
 * Data for analysts (Power BI, Python, Excel): where riders stop, as tables
 * one can download and as a funnel to look at.
 *
 *   GET /admin/data/datasets?from=&to=                what can be downloaded, with rows in the period
 *   GET /admin/data/export?dataset=&from=&to=         one dataset as CSV (UTF-8, comma, header row)
 *   GET /admin/data/funnel?from=&to=&channel=         rides by stage and the WhatsApp page by step, with where people left
 *
 * from and to are Lagos days, both included (default: the last 30 days).
 * Owners and staff; support never gets here. The datasets carry ids, never
 * names, phone numbers or addresses. Every download is on Team activity.
 */

interface Deps {
  adminApiKey: string;
  jwtSecret: string;
}

type Dataset = { name: string; title: string; description: string; dayColumn: string; orderBy: string };

/** The views in migration 20261023090000_analytics_funnels; their columns are described in docs/analytics-data.md. */
export const DATASETS: readonly Dataset[] = [
  { name: 'ride_funnel', title: 'Rides by stage', description: 'One row per ride, every channel: when each stage happened (offers, driver, arrived, trip, done), how far it got, where it stopped, why it was cancelled.', dayColumn: 'requested_day', orderBy: 'requested_at' },
  { name: 'ride_page_sessions', title: 'WhatsApp page visits', description: 'One row per visit to the WhatsApp ride page: what the rider did (price changes, raises, offers seen, accept, cancel and why) and the step they left at.', dayColumn: 'day', orderBy: 'started_at' },
  { name: 'ride_page_events', title: 'WhatsApp page steps', description: 'Every step on the WhatsApp ride page, in order within each visit.', dayColumn: 'day', orderBy: 'recorded_at' },
  { name: 'ride_bids', title: 'Driver offers', description: 'Every driver offer: its price against the rider\'s, how far away, how long after the request.', dayColumn: 'day', orderBy: 'offered_at' },
  { name: 'rider_events', title: 'Rider and driver activity', description: 'Quotes (ride_quoted, ride_trip_confirmed, ride_estimate_requested), searches, accepts, cancels, sign-ins and more, per person.', dayColumn: 'day', orderBy: 'occurred_at' },
  { name: 'price_quotes', title: 'Prices shown', description: 'Every price the app or WhatsApp showed: distance, suggested and lowest price, surge, hour of day.', dayColumn: 'day', orderBy: 'quoted_at' },
];

/** The most rows one download carries: beyond this, download a shorter period. */
const MAX_ROWS = 300_000;
const MAX_PERIOD_DAYS = 800;

class BadRequest extends Error {}

function period(url: URL): { from: string; to: string } {
  const to = url.searchParams.get('to') || lagosToday();
  const from = url.searchParams.get('from') || new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
  if (!isDay(from) || !isDay(to)) throw new BadRequest('from and to must be dates like 2026-10-23');
  if (from > to) throw new BadRequest('from must not be after to');
  if (periodDays({ from, to }) > MAX_PERIOD_DAYS) throw new BadRequest(`the period can be at most ${MAX_PERIOD_DAYS} days`);
  return { from, to };
}

/** One CSV cell: dates as ISO, numbers plain, text quoted when it must be. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object') {
    // Prisma decimals print as numbers; anything else as JSON.
    const text = 'toFixed' in (value as object) ? String(value) : JSON.stringify(value);
    return csvCell(text);
  }
  const text = String(value);
  return /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const columns = Object.keys(rows[0]!);
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

const count = (value: unknown) => Number(value ?? 0);

async function funnel(from: string, to: string, channel: string | null) {
  const channelOk = channel && /^[A-Z_]{2,20}$/.test(channel) ? channel : null;
  const rides = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT channel,
      count(*) FILTER (WHERE outcome <> 'replaced_by_new_request') AS requested,
      count(*) FILTER (WHERE stage_reached >= 2 AND outcome <> 'replaced_by_new_request') AS got_offers,
      count(*) FILTER (WHERE stage_reached >= 3) AS driver_assigned,
      count(*) FILTER (WHERE stage_reached >= 4) AS driver_arrived,
      count(*) FILTER (WHERE stage_reached >= 5) AS trip_started,
      count(*) FILTER (WHERE stage_reached >= 6) AS completed,
      count(*) FILTER (WHERE outcome = 'no_driver') AS no_driver,
      count(*) FILTER (WHERE outcome = 'cancelled') AS cancelled,
      round(avg(minutes_to_first_offer)::numeric, 2) AS avg_minutes_to_first_offer,
      round(avg(minutes_to_driver_assigned)::numeric, 2) AS avg_minutes_to_driver,
      round(avg(minutes_driver_to_pickup)::numeric, 2) AS avg_minutes_driver_to_pickup
    FROM ride_funnel
    WHERE requested_day BETWEEN ${from}::date AND ${to}::date
      AND (${channelOk}::text IS NULL OR channel = ${channelOk}::text)
    GROUP BY channel ORDER BY channel`;

  const cancels = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT COALESCE(stopped_at_stage, furthest_stage) AS stage, COALESCE(cancel_reason, '(none given)') AS reason, count(*) AS rides
    FROM ride_funnel
    WHERE requested_day BETWEEN ${from}::date AND ${to}::date
      AND outcome IN ('cancelled', 'no_driver')
      AND (${channelOk}::text IS NULL OR channel = ${channelOk}::text)
    GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 40`;

  const [page] = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT count(*) AS opened,
      count(*) FILTER (WHERE saw_price OR searched) AS saw_price,
      count(*) FILTER (WHERE tapped_find_drivers OR searched) AS searched,
      count(*) FILTER (WHERE got_offers) AS got_offers,
      count(*) FILTER (WHERE tapped_accept) AS tapped_accept,
      count(*) FILTER (WHERE driver_confirmed) AS driver_confirmed,
      count(*) FILTER (WHERE cancelled) AS cancelled,
      count(*) FILTER (WHERE wallet_was_short) AS wallet_short,
      count(*) FILTER (WHERE raises_tapped > 0 OR price_updates > 0) AS changed_price_while_searching,
      round(avg(seconds_on_page)::numeric, 0) AS avg_seconds_on_page
    FROM ride_page_sessions WHERE day BETWEEN ${from}::date AND ${to}::date`;

  // Where visits that did not book ended: the step they reached and the last thing they did.
  const leftAt = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT furthest_step, COALESCE(last_event, '') AS last_event, count(*) AS visits
    FROM ride_page_sessions
    WHERE day BETWEEN ${from}::date AND ${to}::date AND outcome <> 'booked'
    GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 30`;

  // Shown a price, then: did they search? From the per-person quote and search events.
  const [quotes] = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    WITH q AS (
      SELECT user_id, source FROM rider_events
      WHERE day BETWEEN ${from}::date AND ${to}::date AND event IN ('ride_quoted', 'ride_estimate_requested')
      GROUP BY 1, 2
    ), s AS (
      SELECT DISTINCT rider_id AS user_id FROM ride_funnel WHERE requested_day BETWEEN ${from}::date AND ${to}::date
    )
    SELECT
      count(*) FILTER (WHERE q.source = 'whatsapp') AS whatsapp_quoted_riders,
      count(*) FILTER (WHERE q.source = 'whatsapp' AND s.user_id IS NOT NULL) AS whatsapp_then_searched,
      count(*) FILTER (WHERE q.source = 'app') AS app_quoted_riders,
      count(*) FILTER (WHERE q.source = 'app' AND s.user_id IS NOT NULL) AS app_then_searched
    FROM q LEFT JOIN s ON s.user_id = q.user_id`;

  const plain = (row: Record<string, unknown> | undefined) =>
    Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [k, typeof v === 'bigint' || (v !== null && typeof v === 'object') ? Number(String(v)) : v]));
  return {
    from, to, channel: channelOk,
    rides: rides.map(plain),
    cancels: cancels.map((r) => ({ stage: String(r.stage), reason: String(r.reason), rides: count(r.rides) })),
    page: plain(page),
    leftAt: leftAt.map((r) => ({ step: String(r.furthest_step), lastEvent: String(r.last_event), visits: count(r.visits) })),
    quotes: plain(quotes),
  };
}

export async function handleAdminDataRoute(req: IncomingMessage, res: ServerResponse, deps: Deps, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith('/admin/data/')) return false;
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }
  if (auth.role === 'SUPPORT') {
    sendJson(res, 403, { error: 'Not for the support desk.' });
    return true;
  }
  res.setHeader('Cache-Control', 'no-store');

  try {
    const { from, to } = period(url);

    if (url.pathname === '/admin/data/datasets') {
      const rows = await Promise.all(DATASETS.map(async (d) => {
        const [r] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*) AS n FROM ${d.name} WHERE ${d.dayColumn} BETWEEN $1::date AND $2::date`, from, to);
        return { name: d.name, title: d.title, description: d.description, rows: Number(r?.n ?? 0) };
      }));
      sendJson(res, 200, { from, to, maxRows: MAX_ROWS, datasets: rows });
      return true;
    }

    if (url.pathname === '/admin/data/export') {
      const dataset = DATASETS.find((d) => d.name === url.searchParams.get('dataset'));
      if (!dataset) throw new BadRequest(`dataset must be one of ${DATASETS.map((d) => d.name).join(', ')}`);
      // The name comes from the list above, never from the request.
      const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT * FROM ${dataset.name} WHERE ${dataset.dayColumn} BETWEEN $1::date AND $2::date ORDER BY ${dataset.orderBy} LIMIT ${MAX_ROWS + 1}`, from, to);
      if (rows.length > MAX_ROWS) {
        sendJson(res, 413, { error: `More than ${MAX_ROWS.toLocaleString()} rows: download a shorter period.`, code: 'TOO_MANY_ROWS' });
        return true;
      }
      recordAdminActivity({
        adminId: auth.adminId, adminName: auth.adminName, kind: 'export', page: '/admin/dashboard/data',
        detail: { what: 'downloaded data', dataset: dataset.name, from, to, rows: rows.length }, ip: clientIp(req),
      });
      const name = `wheelers-${dataset.name}-${from}-to-${to}.csv`;
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'no-store',
      });
      // A byte-order mark so Excel reads ₦ and names right.
      res.end(`﻿${toCsv(rows)}`);
      return true;
    }

    if (url.pathname === '/admin/data/funnel') {
      sendJson(res, 200, await funnel(from, to, url.searchParams.get('channel')));
      return true;
    }

    sendJson(res, 404, { error: 'Not found' });
    return true;
  } catch (error) {
    if (error instanceof BadRequest) {
      sendJson(res, 400, { error: error.message });
      return true;
    }
    console.error('[admin-data] failed', { path: url.pathname, error: error instanceof Error ? error.message : String(error) });
    sendJson(res, 500, { error: 'Could not load that just now.' });
    return true;
  }
}
