import { LAUNCH_ZONES, OUTSIDE_ZONES_LABEL } from '@wheleers/config';
import { prisma } from '../prisma';
import { PLATFORM_USER_ID } from './platform-wallet';

/**
 * The admin Home analytics and the Fees page, from one definition of a ride.
 *
 * Every ride number reads the `ride_facts` view (migration 20260927090000),
 * which carries the Lagos calendar day of each event, the booking channel, the
 * launch zones and the fee split. Every endpoint, the Excel workbook and the
 * reconciliation check take the same AnalyticsFilters, turned into SQL in one
 * place (rideConditions), so the screen, the download and the QA can't disagree.
 *
 * Periods are Lagos days, both ends included. Money is returned as numbers
 * rounded to kobo. Searches replaced by a newer one from the same rider never
 * count: they were housekeeping, not demand.
 */

export type RideChannelName = 'APP' | 'WHATSAPP' | 'MCP' | 'UNKNOWN';
export type Bucket = 'day' | 'week' | 'month';

export interface AnalyticsFilters {
  /** First Lagos day, YYYY-MM-DD, included. */
  from: string;
  /** Last Lagos day, YYYY-MM-DD, included. */
  to: string;
  /** A launch zone name, or 'outside'. Matches rides that start or end there. */
  zone?: string | null;
  channel?: RideChannelName | null;
  rideType?: 'single' | 'group' | null;
  driverId?: string | null;
  riderId?: string | null;
}

export const RIDE_CHANNELS: RideChannelName[] = ['APP', 'WHATSAPP', 'MCP', 'UNKNOWN'];
export const CHANNEL_LABELS: Record<RideChannelName, string> = { APP: 'App', WHATSAPP: 'WhatsApp', MCP: 'Claude', UNKNOWN: 'Unknown' };

/* ── SQL building ─────────────────────────────────────────────────────── */

class Sql {
  readonly params: unknown[] = [];
  /** A placeholder for a value; never interpolate values into SQL text. */
  p(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }
}

/** The Lagos calendar day of a UTC timestamp column. */
const lagosDay = (expr: string) => `((${expr} AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos')::date`;

const between = (q: Sql, col: string, f: AnalyticsFilters) => `${col} BETWEEN ${q.p(f.from)}::date AND ${q.p(f.to)}::date`;

/** The ride filters, as conditions on ride_facts aliased `alias`. */
function rideConditions(q: Sql, f: AnalyticsFilters, alias = 'f'): string[] {
  const c = [`NOT ${alias}.superseded`];
  if (f.zone === 'outside') c.push(`(${alias}.pickup_zone IS NULL AND ${alias}.dest_zone IS NULL)`);
  else if (f.zone) {
    const zone = q.p(f.zone);
    c.push(`(${alias}.pickup_zone = ${zone} OR ${alias}.dest_zone = ${zone})`);
  }
  if (f.channel) c.push(`${alias}.channel = ${q.p(f.channel)}`);
  if (f.rideType === 'group') c.push(`${alias}.is_group`);
  if (f.rideType === 'single') c.push(`NOT ${alias}.is_group`);
  if (f.driverId) c.push(`${alias}.driver_id = ${q.p(f.driverId)}`);
  if (f.riderId) c.push(`${alias}.rider_id = ${q.p(f.riderId)}`);
  return c;
}

const where = (conditions: string[]) => (conditions.length ? `WHERE ${conditions.join(' AND ')}` : '');

async function rows<T>(q: Sql, sql: string): Promise<T[]> {
  return prisma.$queryRawUnsafe<T[]>(sql, ...q.params);
}

const num = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const ratio = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 10000) / 10000 : null);

/* ── dates ────────────────────────────────────────────────────────────── */

const DAY_MS = 86_400_000;
const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);

export function isDay(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(dayMs(value));
}

/** Today in Lagos, YYYY-MM-DD. */
export function lagosToday(now = new Date()): string {
  return toDay(now.getTime() + 60 * 60 * 1000);
}

/** Days in the period, both ends included. */
export function periodDays(f: Pick<AnalyticsFilters, 'from' | 'to'>): number {
  return Math.round((dayMs(f.to) - dayMs(f.from)) / DAY_MS) + 1;
}

/** The period of the same length just before this one. */
export function previousPeriod(f: AnalyticsFilters): AnalyticsFilters {
  const days = periodDays(f);
  return { ...f, from: toDay(dayMs(f.from) - days * DAY_MS), to: toDay(dayMs(f.from) - DAY_MS) };
}

/* ── summary ──────────────────────────────────────────────────────────── */

export interface Kpis {
  requests: number;
  completed: number;
  cancelled: number;
  cancelledNoDriver: number;
  cancelledBeforeMatch: number;
  cancelledAfterMatch: number;
  disputed: number;
  matchRate: number | null;
  gmvNgn: number;
  avgFareNgn: number | null;
  medianFareNgn: number | null;
  distanceKm: number;
  commissionNgn: number;
  serviceFeeNgn: number;
  stateLevyNgn: number;
  depositFeesNgn: number;
  /** Commission + service fee + deposit fees. The state levy is owed to Lagos, so it is not revenue. */
  platformRevenueNgn: number;
  driverPayoutsNgn: number;
  activeDrivers: number;
  activeRiders: number;
  ridesWithBids: number;
  ridesWithAcceptedBid: number;
  bidAcceptanceRate: number | null;
  avgBidsPerRide: number | null;
  medianSecondsToFirstBid: number | null;
  /* Money that is not about one ride: ride filters do not apply. */
  depositsNgn: number;
  depositCount: number;
  withdrawalsNgn: number;
  withdrawalCount: number;
  refundsNgn: number;
  newUsers: number;
  newRiders: number;
  newDrivers: number;
}

async function kpis(f: AnalyticsFilters): Promise<Kpis> {
  const rq = new Sql();
  const inCreated = between(rq, 'f.created_day', f);
  const inCompleted = between(rq, 'f.completed_day', f);
  const inCancelled = between(rq, 'f.cancelled_day', f);
  const done = `f.status = 'COMPLETED' AND ${inCompleted}`;
  const [ride] = await rows<Record<string, unknown>>(rq, `
    SELECT
      count(*) FILTER (WHERE ${inCreated})                                              AS requests,
      count(*) FILTER (WHERE ${done})                                                   AS completed,
      count(*) FILTER (WHERE f.status = 'CANCELLED' AND ${inCancelled})                 AS cancelled,
      count(*) FILTER (WHERE f.status = 'CANCELLED' AND ${inCancelled} AND f.no_driver) AS no_driver,
      count(*) FILTER (WHERE f.status = 'CANCELLED' AND ${inCancelled} AND NOT f.no_driver
                         AND (f.cancel_stage IS NULL OR f.cancel_stage = 'BEFORE_MATCH')) AS before_match,
      count(*) FILTER (WHERE f.status = 'CANCELLED' AND ${inCancelled}
                         AND f.cancel_stage IN ('AFTER_MATCH', 'DRIVER_EN_ROUTE', 'ACTIVE_TRIP')) AS after_match,
      count(*) FILTER (WHERE f.status = 'DISPUTED' AND ${inCreated})                    AS disputed,
      sum(f.fare_ngn) FILTER (WHERE ${done})                                            AS gmv,
      avg(f.fare_ngn) FILTER (WHERE ${done})                                            AS avg_fare,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY f.fare_ngn) FILTER (WHERE ${done})   AS median_fare,
      sum(f.distance_km) FILTER (WHERE ${done})                                         AS distance,
      sum(f.commission_ngn) FILTER (WHERE ${done})                                      AS commission,
      sum(f.service_fee_ngn) FILTER (WHERE ${done})                                     AS service_fee,
      sum(f.state_levy_ngn) FILTER (WHERE ${done})                                      AS state_levy,
      sum(f.fare_ngn - f.platform_total_ngn) FILTER (WHERE ${done} AND f.platform_total_ngn IS NOT NULL) AS payouts,
      count(DISTINCT f.driver_id) FILTER (WHERE ${done})                                AS active_drivers,
      count(DISTINCT f.rider_id) FILTER (WHERE ${done})                                 AS active_riders
    FROM ride_facts f
    ${where([...rideConditions(rq, f), `(${inCreated} OR ${inCompleted} OR ${inCancelled})`])}`);

  const bq = new Sql();
  const [bids] = await rows<Record<string, unknown>>(bq, `
    WITH per_ride AS (
      SELECT f.id,
             count(b.*) AS bids,
             bool_or(b.status = 'ACCEPTED') AS accepted,
             extract(epoch FROM min(b."createdAt") - f.created_at) AS secs_to_first
      FROM ride_facts f
      JOIN "DriverBid" b ON b."rideId" = f.id
      ${where([...rideConditions(bq, f), between(bq, 'f.created_day', f)])}
      GROUP BY f.id, f.created_at
    )
    SELECT count(*) AS rides, count(*) FILTER (WHERE accepted) AS accepted, avg(bids) AS avg_bids,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY secs_to_first) AS median_secs
    FROM per_ride`);

  const mq = new Sql();
  const inLedger = between(mq, lagosDay('t."createdAt"'), f);
  const [money] = await rows<Record<string, unknown>>(mq, `
    SELECT
      sum(t."amountNgn") FILTER (WHERE t.type = 'DEPOSIT' AND t.direction = 'CREDIT')  AS deposits,
      count(*) FILTER (WHERE t.type = 'DEPOSIT' AND t.direction = 'CREDIT')            AS deposit_count,
      sum(t."amountNgn") FILTER (WHERE t.type = 'PLATFORM_FEE' AND t.metadata->>'kind' = 'deposit_fee') AS deposit_fees,
      sum(t."amountNgn") FILTER (WHERE t.type = 'REFUND' AND t.direction = 'CREDIT')   AS refunds
    FROM "Transaction" t WHERE ${inLedger}`);

  const wq = new Sql();
  const [withdrawals] = await rows<Record<string, unknown>>(wq, `
    SELECT sum(w."requestedAmountNgn") AS amount, count(*) AS n
    FROM "WithdrawalRequest" w
    WHERE w.status = 'SETTLED' AND ${between(wq, lagosDay('w."settledAt"'), f)}`);

  const uq = new Sql();
  const [users] = await rows<Record<string, unknown>>(uq, `
    SELECT count(*) AS n,
           count(*) FILTER (WHERE u.role IN ('RIDER', 'BOTH')) AS riders,
           count(*) FILTER (WHERE u.role IN ('DRIVER', 'BOTH')) AS drivers
    FROM "User" u
    WHERE u.id <> ${uq.p(PLATFORM_USER_ID)} AND ${between(uq, lagosDay('u."createdAt"'), f)}`);

  const requests = num(ride?.requests);
  const completed = num(ride?.completed);
  const commissionNgn = num(ride?.commission);
  const serviceFeeNgn = num(ride?.service_fee);
  const depositFeesNgn = num(money?.deposit_fees);
  const ridesWithBids = num(bids?.rides);
  const ridesWithAcceptedBid = num(bids?.accepted);
  return {
    requests,
    completed,
    cancelled: num(ride?.cancelled),
    cancelledNoDriver: num(ride?.no_driver),
    cancelledBeforeMatch: num(ride?.before_match),
    cancelledAfterMatch: num(ride?.after_match),
    disputed: num(ride?.disputed),
    matchRate: ratio(completed, requests),
    gmvNgn: num(ride?.gmv),
    avgFareNgn: ride?.avg_fare == null ? null : num(ride.avg_fare),
    medianFareNgn: ride?.median_fare == null ? null : num(ride.median_fare),
    distanceKm: num(ride?.distance),
    commissionNgn,
    serviceFeeNgn,
    stateLevyNgn: num(ride?.state_levy),
    depositFeesNgn,
    platformRevenueNgn: num(commissionNgn + serviceFeeNgn + depositFeesNgn),
    driverPayoutsNgn: num(ride?.payouts),
    activeDrivers: num(ride?.active_drivers),
    activeRiders: num(ride?.active_riders),
    ridesWithBids,
    ridesWithAcceptedBid,
    bidAcceptanceRate: ratio(ridesWithAcceptedBid, ridesWithBids),
    avgBidsPerRide: bids?.avg_bids == null ? null : num(bids.avg_bids),
    medianSecondsToFirstBid: bids?.median_secs == null ? null : Math.round(Number(bids.median_secs)),
    depositsNgn: num(money?.deposits),
    depositCount: num(money?.deposit_count),
    withdrawalsNgn: num(withdrawals?.amount),
    withdrawalCount: num(withdrawals?.n),
    refundsNgn: num(money?.refunds),
    newUsers: num(users?.n),
    newRiders: num(users?.riders),
    newDrivers: num(users?.drivers),
  };
}

export interface Snapshot {
  inFlight: number;
  walletFloatNgn: number;
  walletLockedNgn: number;
  platformWalletNgn: number;
}

async function snapshot(): Promise<Snapshot> {
  const q = new Sql();
  const [s] = await rows<Record<string, unknown>>(q, `
    SELECT
      (SELECT count(*) FROM "Ride" WHERE status IN ('DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS')) AS in_flight,
      (SELECT sum("balanceNgn") FROM "Wallet" WHERE "userId" <> ${q.p(PLATFORM_USER_ID)}) AS float,
      (SELECT sum("lockedNgn") FROM "Wallet" WHERE "userId" <> ${q.p(PLATFORM_USER_ID)}) AS locked,
      (SELECT "balanceNgn" FROM "Wallet" WHERE "userId" = ${q.p(PLATFORM_USER_ID)}) AS platform`);
  return {
    inFlight: num(s?.in_flight),
    walletFloatNgn: num(s?.float),
    walletLockedNgn: num(s?.locked),
    platformWalletNgn: num(s?.platform),
  };
}

export interface SummaryResponse {
  filters: AnalyticsFilters;
  days: number;
  previous: { from: string; to: string };
  current: Kpis;
  previousKpis: Kpis;
  snapshot: Snapshot;
}

async function summary(f: AnalyticsFilters): Promise<SummaryResponse> {
  const prev = previousPeriod(f);
  const [current, previousKpis, snap] = await Promise.all([kpis(f), kpis(prev), snapshot()]);
  return { filters: f, days: periodDays(f), previous: { from: prev.from, to: prev.to }, current, previousKpis, snapshot: snap };
}

/* ── timeseries ───────────────────────────────────────────────────────── */

export interface SeriesPoint {
  /** First Lagos day of the bucket. */
  bucket: string;
  requests: number;
  completed: number;
  cancelled: number;
  gmvNgn: number;
  commissionNgn: number;
  serviceFeeNgn: number;
  stateLevyNgn: number;
  depositFeesNgn: number;
  depositsNgn: number;
  newUsers: number;
}

async function timeseries(f: AnalyticsFilters, bucket: Bucket): Promise<SeriesPoint[]> {
  const q = new Sql();
  const b = q.p(bucket);
  const sql = `
    WITH days AS (
      SELECT d::date AS day FROM generate_series(${q.p(f.from)}::date, ${q.p(f.to)}::date, interval '1 day') d
    ),
    req AS (
      SELECT f.created_day AS d, count(*) AS n FROM ride_facts f
      ${where([...rideConditions(q, f), between(q, 'f.created_day', f)])} GROUP BY 1
    ),
    comp AS (
      SELECT f.completed_day AS d, count(*) AS n, sum(f.fare_ngn) AS gmv, sum(f.commission_ngn) AS commission,
             sum(f.service_fee_ngn) AS service_fee, sum(f.state_levy_ngn) AS state_levy
      FROM ride_facts f
      ${where([...rideConditions(q, f), `f.status = 'COMPLETED'`, between(q, 'f.completed_day', f)])} GROUP BY 1
    ),
    canc AS (
      SELECT f.cancelled_day AS d, count(*) AS n FROM ride_facts f
      ${where([...rideConditions(q, f), `f.status = 'CANCELLED'`, between(q, 'f.cancelled_day', f)])} GROUP BY 1
    ),
    money AS (
      SELECT ${lagosDay('t."createdAt"')} AS d,
             sum(t."amountNgn") FILTER (WHERE t.type = 'DEPOSIT' AND t.direction = 'CREDIT') AS deposits,
             sum(t."amountNgn") FILTER (WHERE t.type = 'PLATFORM_FEE' AND t.metadata->>'kind' = 'deposit_fee') AS deposit_fees
      FROM "Transaction" t WHERE ${between(q, lagosDay('t."createdAt"'), f)} GROUP BY 1
    ),
    signups AS (
      SELECT ${lagosDay('u."createdAt"')} AS d, count(*) AS n FROM "User" u
      WHERE u.id <> ${q.p(PLATFORM_USER_ID)} AND ${between(q, lagosDay('u."createdAt"'), f)} GROUP BY 1
    )
    SELECT to_char(date_trunc(${b}::text, days.day::timestamp), 'YYYY-MM-DD') AS bucket,
           sum(coalesce(req.n, 0)) AS requests, sum(coalesce(comp.n, 0)) AS completed, sum(coalesce(canc.n, 0)) AS cancelled,
           sum(coalesce(comp.gmv, 0)) AS gmv, sum(coalesce(comp.commission, 0)) AS commission,
           sum(coalesce(comp.service_fee, 0)) AS service_fee, sum(coalesce(comp.state_levy, 0)) AS state_levy,
           sum(coalesce(money.deposit_fees, 0)) AS deposit_fees, sum(coalesce(money.deposits, 0)) AS deposits,
           sum(coalesce(signups.n, 0)) AS new_users
    FROM days
    LEFT JOIN req ON req.d = days.day
    LEFT JOIN comp ON comp.d = days.day
    LEFT JOIN canc ON canc.d = days.day
    LEFT JOIN money ON money.d = days.day
    LEFT JOIN signups ON signups.d = days.day
    GROUP BY 1 ORDER BY 1`;
  const result = await rows<Record<string, unknown>>(q, sql);
  return result.map((r) => ({
    bucket: String(r.bucket),
    requests: num(r.requests),
    completed: num(r.completed),
    cancelled: num(r.cancelled),
    gmvNgn: num(r.gmv),
    commissionNgn: num(r.commission),
    serviceFeeNgn: num(r.service_fee),
    stateLevyNgn: num(r.state_levy),
    depositFeesNgn: num(r.deposit_fees),
    depositsNgn: num(r.deposits),
    newUsers: num(r.new_users),
  }));
}

/* ── breakdowns ───────────────────────────────────────────────────────── */

export type BreakdownBy = 'channel' | 'zone' | 'rideType' | 'cancelReason';

export interface BreakdownRow {
  key: string;
  label: string;
  requests: number;
  completed: number;
  cancelled: number;
  gmvNgn: number;
}

async function breakdown(f: AnalyticsFilters, by: BreakdownBy): Promise<BreakdownRow[]> {
  const keyExpr = {
    channel: 'f.channel',
    zone: `coalesce(f.pickup_zone, 'outside')`,
    rideType: `CASE WHEN f.is_group THEN 'group' ELSE 'single' END`,
    cancelReason: `CASE WHEN f.status <> 'CANCELLED' THEN NULL
                        WHEN f.no_driver THEN 'no_driver'
                        WHEN f.cancel_stage IN ('AFTER_MATCH', 'DRIVER_EN_ROUTE', 'ACTIVE_TRIP') THEN 'after_match'
                        ELSE 'before_match' END`,
  }[by];
  const q = new Sql();
  const inCreated = between(q, 'f.created_day', f);
  const done = `f.status = 'COMPLETED' AND ${between(q, 'f.completed_day', f)}`;
  const cancelled = `f.status = 'CANCELLED' AND ${between(q, 'f.cancelled_day', f)}`;
  const result = await rows<Record<string, unknown>>(q, `
    SELECT ${keyExpr} AS key,
           count(*) FILTER (WHERE ${inCreated}) AS requests,
           count(*) FILTER (WHERE ${done}) AS completed,
           count(*) FILTER (WHERE ${cancelled}) AS cancelled,
           sum(f.fare_ngn) FILTER (WHERE ${done}) AS gmv
    FROM ride_facts f
    ${where([...rideConditions(q, f), `(${inCreated} OR ${done} OR ${cancelled})`])}
    GROUP BY 1`);
  const label = (key: string): string => {
    if (by === 'channel') return CHANNEL_LABELS[key as RideChannelName] ?? key;
    if (by === 'zone') return key === 'outside' ? OUTSIDE_ZONES_LABEL : key;
    if (by === 'rideType') return key === 'group' ? 'Group' : 'Single';
    return { no_driver: 'No driver found', before_match: 'Cancelled before a driver', after_match: 'Cancelled after a driver' }[key] ?? key;
  };
  return result
    .filter((r) => r.key != null)
    .map((r) => ({ key: String(r.key), label: label(String(r.key)), requests: num(r.requests), completed: num(r.completed), cancelled: num(r.cancelled), gmvNgn: num(r.gmv) }))
    .filter((r) => (by === 'cancelReason' ? r.cancelled > 0 : true))
    .sort((a, b) => (by === 'cancelReason' ? b.cancelled - a.cancelled : b.requests - a.requests));
}

/* ── tables ───────────────────────────────────────────────────────────── */

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface TableQuery {
  q?: string | null;
  sort?: string | null;
  dir?: 'asc' | 'desc' | null;
  limit?: number;
  offset?: number;
}

export type TripStatusFilter = 'all' | 'completed' | 'cancelled' | 'no_driver' | 'disputed' | 'active' | 'open';

export interface TripRow {
  id: string;
  createdAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  status: string;
  channel: RideChannelName;
  rideType: 'single' | 'group';
  pickupZone: string | null;
  destZone: string | null;
  pickupAddress: string;
  destAddress: string;
  riderId: string;
  riderName: string | null;
  riderPhone: string | null;
  driverId: string | null;
  driverName: string | null;
  driverPhone: string | null;
  fareNgn: number | null;
  commissionNgn: number | null;
  serviceFeeNgn: number | null;
  stateLevyNgn: number | null;
  platformTotalNgn: number | null;
  driverPayoutNgn: number | null;
  feeSplitEstimated: boolean;
  distanceKm: number | null;
  durationSeconds: number | null;
  bids: number;
  cancelReason: string | null;
}

const TRIP_SORT: Record<string, string> = {
  createdAt: 'f.created_at', completedAt: 'f.completed_at', fare: 'f.fare_ngn', commission: 'f.commission_ngn',
  platformTotal: 'f.platform_total_ngn', distance: 'f.distance_km', duration: 'f.duration_seconds', bids: 'bids',
  status: 'f.status', channel: 'f.channel', zone: 'f.pickup_zone', rider: 'ru.name', driver: 'du.name',
};

const clampLimit = (limit: number | undefined, max: number) => Math.min(max, Math.max(1, Math.floor(limit ?? 50)));
const orderBy = (map: Record<string, string>, t: TableQuery, fallback: string) => {
  const col = (t.sort && map[t.sort]) || fallback;
  return `${col} ${t.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`;
};
const optNum = (value: unknown) => (value == null ? null : num(value));
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value == null ? null : String(value));

async function trips(f: AnalyticsFilters, status: TripStatusFilter, t: TableQuery, maxLimit = 200): Promise<Page<TripRow>> {
  const q = new Sql();
  const cond = rideConditions(q, f);
  // Each status is dated by the moment that defines it.
  if (status === 'completed') cond.push(`f.status = 'COMPLETED'`, between(q, 'f.completed_day', f));
  else if (status === 'cancelled') cond.push(`f.status = 'CANCELLED'`, between(q, 'f.cancelled_day', f));
  else if (status === 'no_driver') cond.push(`f.status = 'CANCELLED' AND f.no_driver`, between(q, 'f.cancelled_day', f));
  else if (status === 'disputed') cond.push(`f.status = 'DISPUTED'`, between(q, 'f.created_day', f));
  else if (status === 'active') cond.push(`f.status IN ('DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS')`);
  else if (status === 'open') cond.push(`f.status IN ('REQUESTED', 'MATCHING')`, between(q, 'f.created_day', f));
  else cond.push(between(q, 'f.created_day', f));
  if (t.q?.trim()) {
    const like = q.p(`%${t.q.trim()}%`);
    cond.push(`(f.pickup_address ILIKE ${like} OR f.dest_address ILIKE ${like} OR ru.name ILIKE ${like} OR ru.phone ILIKE ${like}
                OR du.name ILIKE ${like} OR du.phone ILIKE ${like} OR f.id ILIKE ${like})`);
  }
  const limit = clampLimit(t.limit, maxLimit);
  const offset = Math.max(0, Math.floor(t.offset ?? 0));
  const result = await rows<Record<string, unknown>>(q, `
    SELECT f.*, ru.name AS rider_name, ru.phone AS rider_phone, du.name AS driver_name, du.phone AS driver_phone,
           (SELECT count(*) FROM "DriverBid" b WHERE b."rideId" = f.id)::int AS bids,
           count(*) OVER () AS total
    FROM ride_facts f
    LEFT JOIN "User" ru ON ru.id = f.rider_id
    LEFT JOIN "Driver" d ON d.id = f.driver_id
    LEFT JOIN "User" du ON du.id = d."userId"
    ${where(cond)}
    ORDER BY ${orderBy(TRIP_SORT, t, 'f.created_at')}, f.id
    LIMIT ${q.p(limit)} OFFSET ${q.p(offset)}`);
  const total = num(result[0]?.total);
  return {
    items: result.map((r) => {
      const fare = optNum(r.fare_ngn);
      const platformTotal = optNum(r.platform_total_ngn);
      return {
        id: String(r.id),
        createdAt: iso(r.created_at)!,
        completedAt: iso(r.completed_at),
        cancelledAt: iso(r.cancelled_at),
        status: String(r.status),
        channel: String(r.channel) as RideChannelName,
        rideType: r.is_group ? 'group' : 'single',
        pickupZone: (r.pickup_zone as string | null) ?? null,
        destZone: (r.dest_zone as string | null) ?? null,
        pickupAddress: String(r.pickup_address ?? ''),
        destAddress: String(r.dest_address ?? ''),
        riderId: String(r.rider_id),
        riderName: (r.rider_name as string | null) ?? null,
        riderPhone: (r.rider_phone as string | null) ?? null,
        driverId: (r.driver_id as string | null) ?? null,
        driverName: (r.driver_name as string | null) ?? null,
        driverPhone: (r.driver_phone as string | null) ?? null,
        fareNgn: fare,
        commissionNgn: optNum(r.commission_ngn),
        serviceFeeNgn: optNum(r.service_fee_ngn),
        stateLevyNgn: optNum(r.state_levy_ngn),
        platformTotalNgn: platformTotal,
        driverPayoutNgn: fare != null && platformTotal != null ? num(fare - platformTotal) : null,
        feeSplitEstimated: Boolean(r.fee_split_estimated),
        distanceKm: optNum(r.distance_km),
        durationSeconds: r.duration_seconds == null ? null : Number(r.duration_seconds),
        bids: num(r.bids),
        cancelReason: (r.cancel_reason as string | null) ?? null,
      } satisfies TripRow;
    }),
    total,
    limit,
    offset,
    hasMore: offset + result.length < total,
  };
}

export interface DriverRow {
  driverId: string;
  userId: string;
  name: string | null;
  phone: string | null;
  status: string;
  kycStatus: string;
  trips: number;
  gmvNgn: number;
  earningsNgn: number;
  commissionNgn: number;
  avgFareNgn: number | null;
  bids: number;
  bidsWon: number;
  bidWinRate: number | null;
  lastTripAt: string | null;
}

const DRIVER_SORT: Record<string, string> = {
  trips: 'trips', gmv: 'gmv', earnings: 'earnings', commission: 'commission', bids: 'bids', bidsWon: 'won',
  winRate: 'win_rate', lastTrip: 'last_trip', name: 'u.name',
};

async function drivers(f: AnalyticsFilters, t: TableQuery, maxLimit = 200): Promise<Page<DriverRow>> {
  const q = new Sql();
  const doneCond = [...rideConditions(q, f), `f.driver_id IS NOT NULL`, `f.status = 'COMPLETED'`, between(q, 'f.completed_day', f)];
  const bidCond = [...rideConditions(q, f), between(q, 'f.created_day', f)];
  const outer: string[] = [`(r.driver_id IS NOT NULL OR b.driver_id IS NOT NULL)`];
  if (t.q?.trim()) {
    const like = q.p(`%${t.q.trim()}%`);
    outer.push(`(u.name ILIKE ${like} OR u.phone ILIKE ${like} OR d.id ILIKE ${like})`);
  }
  const limit = clampLimit(t.limit, maxLimit);
  const offset = Math.max(0, Math.floor(t.offset ?? 0));
  const result = await rows<Record<string, unknown>>(q, `
    WITH r AS (
      SELECT f.driver_id, count(*) AS trips, sum(f.fare_ngn) AS gmv,
             sum(f.fare_ngn - f.platform_total_ngn) FILTER (WHERE f.platform_total_ngn IS NOT NULL) AS earnings,
             sum(f.commission_ngn) AS commission, max(f.completed_at) AS last_trip
      FROM ride_facts f ${where(doneCond)} GROUP BY 1
    ),
    b AS (
      SELECT bid."driverId" AS driver_id, count(*) AS bids, count(*) FILTER (WHERE bid.status = 'ACCEPTED') AS won
      FROM "DriverBid" bid JOIN ride_facts f ON f.id = bid."rideId" ${where(bidCond)} GROUP BY 1
    )
    SELECT d.id AS driver_id, d."userId" AS user_id, u.name, u.phone, d.status::text AS status, d."kycStatus"::text AS kyc,
           coalesce(r.trips, 0) AS trips, coalesce(r.gmv, 0) AS gmv, coalesce(r.earnings, 0) AS earnings,
           coalesce(r.commission, 0) AS commission, r.last_trip,
           coalesce(b.bids, 0) AS bids, coalesce(b.won, 0) AS won,
           CASE WHEN coalesce(b.bids, 0) > 0 THEN b.won::float8 / b.bids ELSE NULL END AS win_rate,
           count(*) OVER () AS total
    FROM "Driver" d
    JOIN "User" u ON u.id = d."userId"
    LEFT JOIN r ON r.driver_id = d.id
    LEFT JOIN b ON b.driver_id = d.id
    ${where(outer)}
    ORDER BY ${orderBy(DRIVER_SORT, t, 'trips')}, d.id
    LIMIT ${q.p(limit)} OFFSET ${q.p(offset)}`);
  const total = num(result[0]?.total);
  return {
    items: result.map((r) => {
      const trips = num(r.trips);
      const gmv = num(r.gmv);
      return {
        driverId: String(r.driver_id),
        userId: String(r.user_id),
        name: (r.name as string | null) ?? null,
        phone: (r.phone as string | null) ?? null,
        status: String(r.status),
        kycStatus: String(r.kyc),
        trips,
        gmvNgn: gmv,
        earningsNgn: num(r.earnings),
        commissionNgn: num(r.commission),
        avgFareNgn: trips > 0 ? num(gmv / trips) : null,
        bids: num(r.bids),
        bidsWon: num(r.won),
        bidWinRate: r.win_rate == null ? null : Math.round(Number(r.win_rate) * 10000) / 10000,
        lastTripAt: iso(r.last_trip),
      };
    }),
    total,
    limit,
    offset,
    hasMore: offset + result.length < total,
  };
}

export interface RiderRow {
  riderId: string;
  name: string | null;
  phone: string | null;
  joinedAt: string;
  requests: number;
  trips: number;
  cancelled: number;
  spendNgn: number;
  avgFareNgn: number | null;
  topChannel: RideChannelName | null;
  lastRequestAt: string | null;
  walletBalanceNgn: number;
}

const RIDER_SORT: Record<string, string> = {
  requests: 'x.requests', trips: 'x.trips', cancelled: 'x.cancelled', spend: 'x.spend', lastRequest: 'x.last_request',
  joined: 'u."createdAt"', balance: 'w."balanceNgn"', name: 'u.name',
};

async function riders(f: AnalyticsFilters, t: TableQuery, maxLimit = 200): Promise<Page<RiderRow>> {
  const q = new Sql();
  const inCreated = between(q, 'f.created_day', f);
  const done = `f.status = 'COMPLETED' AND ${between(q, 'f.completed_day', f)}`;
  const cancelled = `f.status = 'CANCELLED' AND ${between(q, 'f.cancelled_day', f)}`;
  const inner = [...rideConditions(q, f), `(${inCreated} OR ${done} OR ${cancelled})`];
  const outer: string[] = [];
  if (t.q?.trim()) {
    const like = q.p(`%${t.q.trim()}%`);
    outer.push(`(u.name ILIKE ${like} OR u.phone ILIKE ${like} OR u.id ILIKE ${like})`);
  }
  const limit = clampLimit(t.limit, maxLimit);
  const offset = Math.max(0, Math.floor(t.offset ?? 0));
  const result = await rows<Record<string, unknown>>(q, `
    WITH x AS (
      SELECT f.rider_id,
             count(*) FILTER (WHERE ${inCreated}) AS requests,
             count(*) FILTER (WHERE ${done}) AS trips,
             count(*) FILTER (WHERE ${cancelled}) AS cancelled,
             coalesce(sum(f.fare_ngn) FILTER (WHERE ${done}), 0) AS spend,
             mode() WITHIN GROUP (ORDER BY f.channel) AS top_channel,
             max(f.created_at) AS last_request
      FROM ride_facts f ${where(inner)} GROUP BY 1
    )
    SELECT u.id, u.name, u.phone, u."createdAt" AS joined, x.*, coalesce(w."balanceNgn", 0) AS balance,
           count(*) OVER () AS total
    FROM x JOIN "User" u ON u.id = x.rider_id
    LEFT JOIN "Wallet" w ON w."userId" = u.id
    ${where(outer)}
    ORDER BY ${orderBy(RIDER_SORT, t, 'x.trips')}, u.id
    LIMIT ${q.p(limit)} OFFSET ${q.p(offset)}`);
  const total = num(result[0]?.total);
  return {
    items: result.map((r) => {
      const trips = num(r.trips);
      const spend = num(r.spend);
      return {
        riderId: String(r.id),
        name: (r.name as string | null) ?? null,
        phone: (r.phone as string | null) ?? null,
        joinedAt: iso(r.joined)!,
        requests: num(r.requests),
        trips,
        cancelled: num(r.cancelled),
        spendNgn: spend,
        avgFareNgn: trips > 0 ? num(spend / trips) : null,
        topChannel: (r.top_channel as RideChannelName | null) ?? null,
        lastRequestAt: iso(r.last_request),
        walletBalanceNgn: num(r.balance),
      };
    }),
    total,
    limit,
    offset,
    hasMore: offset + result.length < total,
  };
}

/* ── fees ─────────────────────────────────────────────────────────────── */

export interface FeeTotals {
  commissionNgn: number;
  serviceFeeNgn: number;
  depositFeesNgn: number;
  /** Commission + service fee + deposit fees. */
  incomeNgn: number;
  /** Collected on rides and owed to Lagos State: a pass-through, not income. */
  stateLevyNgn: number;
  /** Paystack's fee on deposits, where Wheelers absorbs it. */
  depositProviderCostNgn: number;
  /** Paystack's fee on each withdrawal transfer. */
  transferCostNgn: number;
  otherProviderCostNgn: number;
  costsNgn: number;
  netNgn: number;
  feeRides: number;
  deposits: number;
  transfers: number;
  /** Commission on rides whose split was reconstructed by the backfill. */
  estimatedCommissionNgn: number;
}

export interface FeePoint extends Omit<FeeTotals, 'feeRides' | 'deposits' | 'transfers' | 'estimatedCommissionNgn'> {
  bucket: string;
}

export interface FeesSummary {
  filters: AnalyticsFilters;
  bucket: Bucket;
  totals: FeeTotals;
  previousTotals: FeeTotals;
  previous: { from: string; to: string };
  points: FeePoint[];
  platformWalletNgn: number;
}

async function feePoints(f: AnalyticsFilters, bucket: Bucket): Promise<Array<FeePoint & { feeRides: number; deposits: number; transfers: number; estimatedCommissionNgn: number }>> {
  const q = new Sql();
  const b = q.p(bucket);
  const kind = `coalesce(t.metadata->>'kind', CASE WHEN t.type = 'PLATFORM_FEE' THEN 'ride_fee' ELSE 'provider_fee' END)`;
  const result = await rows<Record<string, unknown>>(q, `
    WITH days AS (
      SELECT d::date AS day FROM generate_series(${q.p(f.from)}::date, ${q.p(f.to)}::date, interval '1 day') d
    ),
    rides AS (
      SELECT f.completed_day AS d, count(*) AS n, sum(f.commission_ngn) AS commission, sum(f.service_fee_ngn) AS service_fee,
             sum(f.state_levy_ngn) AS levy, sum(f.commission_ngn) FILTER (WHERE f.fee_split_estimated) AS estimated
      FROM ride_facts f
      ${where([...rideConditions(q, f), `f.status = 'COMPLETED'`, `f.platform_total_ngn IS NOT NULL`, between(q, 'f.completed_day', f)])}
      GROUP BY 1
    ),
    ledger AS (
      SELECT ${lagosDay('t."createdAt"')} AS d,
             sum(t."amountNgn") FILTER (WHERE t.type = 'PLATFORM_FEE' AND ${kind} = 'deposit_fee') AS deposit_fees,
             count(*) FILTER (WHERE t.type = 'PLATFORM_FEE' AND ${kind} = 'deposit_fee') AS deposits,
             sum(t."amountNgn") FILTER (WHERE t.type = 'PROVIDER_FEE' AND ${kind} = 'deposit_provider_fee') AS deposit_cost,
             sum(t."amountNgn") FILTER (WHERE t.type = 'PROVIDER_FEE' AND ${kind} = 'transfer_fee') AS transfer_cost,
             count(*) FILTER (WHERE t.type = 'PROVIDER_FEE' AND ${kind} = 'transfer_fee') AS transfers,
             sum(t."amountNgn") FILTER (WHERE t.type = 'PROVIDER_FEE' AND ${kind} NOT IN ('deposit_provider_fee', 'transfer_fee')) AS other_cost
      FROM "Transaction" t
      JOIN "Wallet" w ON w.id = t."walletId" AND w."userId" = ${q.p(PLATFORM_USER_ID)}
      WHERE t.type IN ('PLATFORM_FEE', 'PROVIDER_FEE') AND ${between(q, lagosDay('t."createdAt"'), f)}
      GROUP BY 1
    )
    SELECT to_char(date_trunc(${b}::text, days.day::timestamp), 'YYYY-MM-DD') AS bucket,
           sum(coalesce(rides.n, 0)) AS fee_rides, sum(coalesce(rides.commission, 0)) AS commission,
           sum(coalesce(rides.service_fee, 0)) AS service_fee, sum(coalesce(rides.levy, 0)) AS levy,
           sum(coalesce(rides.estimated, 0)) AS estimated,
           sum(coalesce(ledger.deposit_fees, 0)) AS deposit_fees, sum(coalesce(ledger.deposits, 0)) AS deposits,
           sum(coalesce(ledger.deposit_cost, 0)) AS deposit_cost, sum(coalesce(ledger.transfer_cost, 0)) AS transfer_cost,
           sum(coalesce(ledger.transfers, 0)) AS transfers, sum(coalesce(ledger.other_cost, 0)) AS other_cost
    FROM days LEFT JOIN rides ON rides.d = days.day LEFT JOIN ledger ON ledger.d = days.day
    GROUP BY 1 ORDER BY 1`);
  return result.map((r) => {
    const commissionNgn = num(r.commission);
    const serviceFeeNgn = num(r.service_fee);
    const depositFeesNgn = num(r.deposit_fees);
    const incomeNgn = num(commissionNgn + serviceFeeNgn + depositFeesNgn);
    const depositProviderCostNgn = num(r.deposit_cost);
    const transferCostNgn = num(r.transfer_cost);
    const otherProviderCostNgn = num(r.other_cost);
    const costsNgn = num(depositProviderCostNgn + transferCostNgn + otherProviderCostNgn);
    return {
      bucket: String(r.bucket),
      commissionNgn,
      serviceFeeNgn,
      depositFeesNgn,
      incomeNgn,
      stateLevyNgn: num(r.levy),
      depositProviderCostNgn,
      transferCostNgn,
      otherProviderCostNgn,
      costsNgn,
      netNgn: num(incomeNgn - costsNgn),
      feeRides: num(r.fee_rides),
      deposits: num(r.deposits),
      transfers: num(r.transfers),
      estimatedCommissionNgn: num(r.estimated),
    };
  });
}

function totalOf(points: Array<FeePoint & { feeRides: number; deposits: number; transfers: number; estimatedCommissionNgn: number }>): FeeTotals {
  const sum = (key: keyof FeeTotals) => num(points.reduce((acc, p) => acc + Number(p[key as keyof typeof p] ?? 0), 0));
  return {
    commissionNgn: sum('commissionNgn'),
    serviceFeeNgn: sum('serviceFeeNgn'),
    depositFeesNgn: sum('depositFeesNgn'),
    incomeNgn: sum('incomeNgn'),
    stateLevyNgn: sum('stateLevyNgn'),
    depositProviderCostNgn: sum('depositProviderCostNgn'),
    transferCostNgn: sum('transferCostNgn'),
    otherProviderCostNgn: sum('otherProviderCostNgn'),
    costsNgn: sum('costsNgn'),
    netNgn: sum('netNgn'),
    feeRides: sum('feeRides'),
    deposits: sum('deposits'),
    transfers: sum('transfers'),
    estimatedCommissionNgn: sum('estimatedCommissionNgn'),
  };
}

async function fees(f: AnalyticsFilters, bucket: Bucket): Promise<FeesSummary> {
  const prev = previousPeriod(f);
  const [points, prevPoints, snap] = await Promise.all([feePoints(f, bucket), feePoints(prev, 'month'), snapshot()]);
  return {
    filters: f,
    bucket,
    totals: totalOf(points),
    previousTotals: totalOf(prevPoints),
    previous: { from: prev.from, to: prev.to },
    points: points.map(({ feeRides: _a, deposits: _b, transfers: _c, estimatedCommissionNgn: _d, ...p }) => p),
    platformWalletNgn: snap.platformWalletNgn,
  };
}

export type FeeKind = 'ride_fee' | 'deposit_fee' | 'deposit_provider_fee' | 'transfer_fee' | 'provider_fee';
export const FEE_KIND_LABELS: Record<FeeKind, string> = {
  ride_fee: 'Ride fee',
  deposit_fee: 'Deposit fee',
  deposit_provider_fee: 'Paystack deposit fee',
  transfer_fee: 'Paystack transfer fee',
  provider_fee: 'Other provider fee',
};

export interface FeeLedgerRow {
  id: string;
  createdAt: string;
  kind: FeeKind;
  label: string;
  direction: 'CREDIT' | 'DEBIT';
  amountNgn: number;
  referenceId: string | null;
  commissionNgn: number | null;
  serviceFeeNgn: number | null;
  stateLevyNgn: number | null;
}

async function feeLedger(f: AnalyticsFilters, kind: FeeKind | null, t: TableQuery, maxLimit = 200): Promise<Page<FeeLedgerRow>> {
  const q = new Sql();
  const kindExpr = `coalesce(t.metadata->>'kind', CASE WHEN t.type = 'PLATFORM_FEE' THEN 'ride_fee' ELSE 'provider_fee' END)`;
  const cond = [`t.type IN ('PLATFORM_FEE', 'PROVIDER_FEE')`, between(q, lagosDay('t."createdAt"'), f)];
  if (kind) cond.push(`${kindExpr} = ${q.p(kind)}`);
  if (t.q?.trim()) cond.push(`t."referenceId" ILIKE ${q.p(`%${t.q.trim()}%`)}`);
  const limit = clampLimit(t.limit, maxLimit);
  const offset = Math.max(0, Math.floor(t.offset ?? 0));
  const sort = orderBy({ createdAt: 't."createdAt"', amount: 't."amountNgn"', kind: 'kind' }, t, 't."createdAt"');
  const result = await rows<Record<string, unknown>>(q, `
    SELECT t.id, t."createdAt" AS created_at, ${kindExpr} AS kind, t.direction::text AS direction, t."amountNgn" AS amount,
           t."referenceId" AS reference_id, r."commissionNgn" AS commission, r."serviceFeeNgn" AS service_fee, r."stateLevyNgn" AS levy,
           count(*) OVER () AS total
    FROM "Transaction" t
    JOIN "Wallet" w ON w.id = t."walletId" AND w."userId" = ${q.p(PLATFORM_USER_ID)}
    LEFT JOIN "Ride" r ON r.id = t."referenceId" AND t.type = 'PLATFORM_FEE'
    ${where(cond)}
    ORDER BY ${sort}, t.id
    LIMIT ${q.p(limit)} OFFSET ${q.p(offset)}`);
  const total = num(result[0]?.total);
  return {
    items: result.map((r) => {
      const k = String(r.kind) as FeeKind;
      return {
        id: String(r.id),
        createdAt: iso(r.created_at)!,
        kind: k,
        label: FEE_KIND_LABELS[k] ?? k,
        direction: String(r.direction) as 'CREDIT' | 'DEBIT',
        amountNgn: num(r.amount),
        referenceId: (r.reference_id as string | null) ?? null,
        commissionNgn: optNum(r.commission),
        serviceFeeNgn: optNum(r.service_fee),
        stateLevyNgn: optNum(r.levy),
      };
    }),
    total,
    limit,
    offset,
    hasMore: offset + result.length < total,
  };
}

/* ── reconciliation (task A-08) ───────────────────────────────────────── */

export interface ReconcileCheck {
  key: string;
  label: string;
  left: { label: string; value: number };
  right: { label: string; value: number };
  diff: number;
  ok: boolean;
}

/**
 * Each headline total, computed two independent ways. A difference means the
 * dashboard and the money disagree somewhere, and says where to look.
 */
async function reconcile(f: AnalyticsFilters): Promise<ReconcileCheck[]> {
  const q = new Sql();
  const inDone = between(q, lagosDay('r."completedAt"'), f);
  const [x] = await rows<Record<string, unknown>>(q, `
    WITH done AS (
      SELECT r.* FROM "Ride" r
      WHERE r.status = 'COMPLETED' AND ${inDone}
        AND r."cancelReason" IS DISTINCT FROM 'Replaced by a newer request'
    ),
    view_done AS (
      SELECT count(*) AS n FROM ride_facts f WHERE f.status = 'COMPLETED' AND NOT f.superseded AND ${between(q, 'f.completed_day', f)}
    ),
    ledger AS (
      SELECT t."referenceId" AS ride_id,
             sum(t."amountNgn") FILTER (WHERE t.type = 'PLATFORM_FEE' AND t.direction = 'CREDIT') AS fee,
             sum(t."amountNgn") FILTER (WHERE t.type = 'RIDE_PAYMENT' AND t.direction = 'DEBIT') AS paid,
             sum(t."amountNgn") FILTER (WHERE t.type = 'DRIVER_PAYOUT' AND t.direction = 'CREDIT') AS payout
      FROM "Transaction" t JOIN done ON done.id = t."referenceId"
      WHERE t.type IN ('PLATFORM_FEE', 'RIDE_PAYMENT', 'DRIVER_PAYOUT')
      GROUP BY 1
    ),
    settled AS (SELECT done.* FROM done WHERE done."platformFeeNgn" IS NOT NULL)
    SELECT
      (SELECT count(*) FROM done) AS done_raw,
      (SELECT n FROM view_done) AS done_view,
      (SELECT coalesce(sum("platformFeeNgn"), 0) FROM settled) AS ride_fee_total,
      (SELECT coalesce(sum(fee), 0) FROM ledger) AS ledger_fee_total,
      (SELECT coalesce(sum("commissionNgn" + "serviceFeeNgn" + "stateLevyNgn"), 0) FROM settled WHERE "commissionNgn" IS NOT NULL) AS split_sum,
      (SELECT coalesce(sum("platformFeeNgn"), 0) FROM settled WHERE "commissionNgn" IS NOT NULL) AS split_total,
      (SELECT coalesce(sum(coalesce("fareFinalNgn", "agreedFareNgn")), 0) FROM settled) AS fare_total,
      (SELECT coalesce(sum(paid), 0) FROM ledger) AS paid_total,
      (SELECT coalesce(sum(coalesce("fareFinalNgn", "agreedFareNgn") - "platformFeeNgn"), 0) FROM settled) AS payout_expected,
      (SELECT coalesce(sum(payout), 0) FROM ledger) AS payout_total`);

  const wq = new Sql();
  const [w] = await rows<Record<string, unknown>>(wq, `
    SELECT
      (SELECT coalesce(sum(w."reservedAmountNgn"), 0) FROM "WithdrawalRequest" w
        WHERE w.status = 'SETTLED' AND ${between(wq, lagosDay('w."settledAt"'), f)}) AS requested,
      (SELECT coalesce(sum(t."amountNgn"), 0) FROM "Transaction" t
        JOIN "WithdrawalRequest" w ON w.id = t."referenceId"
        WHERE t.type = 'WITHDRAWAL' AND t.direction = 'DEBIT' AND w.status = 'SETTLED'
          AND ${between(wq, lagosDay('w."settledAt"'), f)}) AS ledger`);

  const check = (key: string, label: string, left: [string, unknown], right: [string, unknown], tolerance = 0.01): ReconcileCheck => {
    const a = num(left[1]);
    const b = num(right[1]);
    const diff = num(a - b);
    return { key, label, left: { label: left[0], value: a }, right: { label: right[0], value: b }, diff, ok: Math.abs(diff) <= tolerance };
  };
  return [
    check('completed', 'Completed trips: dashboard view vs ride table', ['ride_facts view', x?.done_view], ['Ride table', x?.done_raw]),
    check('fees', 'Platform fees: ride rows vs ledger', ['Sum of ride platform fees', x?.ride_fee_total], ['PLATFORM_FEE ledger rows', x?.ledger_fee_total]),
    check('split', 'Fee split adds up to the fee', ['Commission + service + levy', x?.split_sum], ['Platform fee on the same rides', x?.split_total]),
    check('fares', 'Fares: ride rows vs what riders paid', ['Fares of settled trips', x?.fare_total], ['RIDE_PAYMENT ledger rows', x?.paid_total]),
    check('payouts', 'Driver payouts: fare minus fees vs ledger', ['Fare minus platform fee', x?.payout_expected], ['DRIVER_PAYOUT ledger rows', x?.payout_total]),
    check('withdrawals', 'Withdrawals: requests vs ledger', ['Settled withdrawal requests', w?.requested], ['WITHDRAWAL ledger rows', w?.ledger]),
  ];
}

/* ── options ──────────────────────────────────────────────────────────── */

function options() {
  return {
    zones: [...LAUNCH_ZONES.map((z) => ({ value: z.name, label: z.name })), { value: 'outside', label: OUTSIDE_ZONES_LABEL }],
    channels: RIDE_CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABELS[c] })),
    rideTypes: [{ value: 'single', label: 'Single' }, { value: 'group', label: 'Group' }],
  };
}

export const adminAnalyticsClient = {
  summary,
  timeseries,
  breakdown,
  trips,
  drivers,
  riders,
  fees,
  feePoints,
  feeLedger,
  reconcile,
  options,
};
