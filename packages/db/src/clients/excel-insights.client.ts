import { prisma } from '../prisma';

/**
 * The "why" sheets of the owners' Excel download: where rides stop, prices
 * shown and taken, the WhatsApp page, speed of service, supply against
 * demand, cohorts, rider types, driver quality and the money journey. Each
 * reads the analysis views (migration 20261023090000_analytics_funnels) with
 * the same filters as the dashboard: the period (Lagos days), a zone, a channel.
 *
 * Values come back as plain numbers (Postgres counts and decimals converted).
 */
export interface InsightFilters {
  from: string;
  to: string;
  /** A launch zone name, or 'outside'. Rides that start or end there. */
  zone?: string | null;
  channel?: string | null;
}

type Row = Record<string, unknown>;

class Q {
  readonly params: unknown[] = [];
  p(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }
}

/** Every bigint and decimal as a number; nulls stay null. */
function plain(rows: Row[]): Row[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => {
    if (typeof v === 'bigint') return [k, Number(v)];
    if (v !== null && typeof v === 'object' && !(v instanceof Date) && 'toFixed' in (v as object)) return [k, Number(String(v))];
    return [k, v];
  })));
}

async function run(q: Q, sql: string): Promise<Row[]> {
  return plain(await prisma.$queryRawUnsafe<Row[]>(sql, ...q.params));
}

/** The ride filters on ride_funnel (alias f): the period, not a search replaced by a newer one, the zone and channel. */
function rideWhere(q: Q, f: InsightFilters, alias = 'f'): string {
  const c = [
    `${alias}.requested_day BETWEEN ${q.p(f.from)}::date AND ${q.p(f.to)}::date`,
    `${alias}.outcome <> 'replaced_by_new_request'`,
  ];
  if (f.zone === 'outside') c.push(`(${alias}.pickup_zone IS NULL AND ${alias}.dest_zone IS NULL)`);
  else if (f.zone) {
    const z = q.p(f.zone);
    c.push(`(${alias}.pickup_zone = ${z} OR ${alias}.dest_zone = ${z})`);
  }
  if (f.channel) c.push(`${alias}.channel = ${q.p(f.channel)}`);
  return c.join(' AND ');
}

const days = (q: Q, f: InsightFilters, col: string) => `${col} BETWEEN ${q.p(f.from)}::date AND ${q.p(f.to)}::date`;

export const excelInsightsClient = {
  /** Per day and channel: how many rides reached each stage. */
  funnel(f: InsightFilters) {
    const q = new Q();
    return run(q, `
      SELECT f.requested_day AS day, f.channel,
        count(*) AS requested,
        count(*) FILTER (WHERE f.stage_reached >= 2) AS got_offer,
        count(*) FILTER (WHERE f.stage_reached >= 3) AS driver_assigned,
        count(*) FILTER (WHERE f.stage_reached >= 4) AS driver_arrived,
        count(*) FILTER (WHERE f.stage_reached >= 5) AS trip_started,
        count(*) FILTER (WHERE f.stage_reached >= 6) AS completed,
        count(*) FILTER (WHERE f.outcome = 'no_driver') AS no_driver,
        count(*) FILTER (WHERE f.outcome = 'cancelled') AS cancelled
      FROM ride_funnel f WHERE ${rideWhere(q, f)}
      GROUP BY 1, 2 ORDER BY 1, 2`);
  },

  /** Rides that ended without a trip: the stage, the reason, how many, and how long they had searched. */
  stopped(f: InsightFilters) {
    const q = new Q();
    return run(q, `
      SELECT COALESCE(f.stopped_at_stage, f.furthest_stage) AS stage,
        COALESCE(f.cancel_reason, CASE WHEN f.outcome = 'no_driver' THEN 'No driver accepted in time' ELSE '(none given)' END) AS reason,
        count(*) AS rides,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY f.minutes_until_cancelled))::numeric, 1) AS median_minutes_searched
      FROM ride_funnel f WHERE ${rideWhere(q, f)} AND f.outcome IN ('cancelled', 'no_driver')
      GROUP BY 1, 2 ORDER BY 1, 3 DESC`);
  },

  /** Per day and where: riders shown a price, confirming the trip (WhatsApp), searching, completing a ride that day. */
  quotes(f: InsightFilters) {
    const q = new Q();
    const channelSource = f.channel === 'WHATSAPP' ? `AND e.source = 'whatsapp'` : f.channel === 'APP' ? `AND e.source = 'app'` : '';
    return run(q, `
      WITH quoted AS (
        SELECT e.day, e.source, e.user_id FROM rider_events e
        WHERE ${days(q, f, 'e.day')} AND e.event IN ('ride_quoted', 'ride_estimate_requested') ${channelSource}
        GROUP BY 1, 2, 3
      ), confirmed AS (
        SELECT e.day, e.user_id FROM rider_events e
        WHERE ${days(q, f, 'e.day')} AND e.event = 'ride_trip_confirmed' GROUP BY 1, 2
      ), rides AS (
        SELECT f.requested_day AS day, f.rider_id AS user_id, bool_or(f.outcome = 'completed') AS completed
        FROM ride_funnel f WHERE ${days(q, f, 'f.requested_day')} AND f.outcome <> 'replaced_by_new_request'
        GROUP BY 1, 2
      )
      SELECT qt.day, qt.source,
        count(*) AS riders_shown_a_price,
        count(c.user_id) AS confirmed_the_trip,
        count(r.user_id) AS searched,
        count(*) FILTER (WHERE r.completed) AS completed_a_ride
      FROM quoted qt
      LEFT JOIN confirmed c ON c.day = qt.day AND c.user_id = qt.user_id AND qt.source = 'whatsapp'
      LEFT JOIN rides r ON r.day = qt.day AND r.user_id = qt.user_id
      GROUP BY 1, 2 ORDER BY 1, 2`);
  },

  /** Per day: WhatsApp page visits by the furthest step reached. */
  page(f: InsightFilters) {
    const q = new Q();
    return run(q, `
      SELECT s.day,
        count(*) AS visits,
        count(*) FILTER (WHERE s.saw_price OR s.searched) AS saw_price,
        count(*) FILTER (WHERE s.tapped_find_drivers OR s.searched) AS searched,
        count(*) FILTER (WHERE s.got_offers) AS got_offers,
        count(*) FILTER (WHERE s.tapped_accept) AS tapped_accept,
        count(*) FILTER (WHERE s.driver_confirmed) AS booked,
        count(*) FILTER (WHERE s.cancelled) AS cancelled,
        count(*) FILTER (WHERE s.wallet_was_short) AS asked_to_add_money,
        round(avg(s.seconds_on_page)) AS avg_seconds_on_page
      FROM ride_page_sessions s WHERE ${days(q, f, 's.day')}
      GROUP BY 1 ORDER BY 1`);
  },

  /** WhatsApp visits that did not book: the step reached and the last thing done. */
  pageLeft(f: InsightFilters) {
    const q = new Q();
    return run(q, `
      SELECT s.furthest_step, COALESCE(s.last_event, '') AS last_event, count(*) AS visits
      FROM ride_page_sessions s WHERE ${days(q, f, 's.day')} AND s.outcome <> 'booked'
      GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 40`);
  },

  /** The rider's offer against the suggested price, in bands: how often each got an offer, a driver, a trip. */
  offerBands(f: InsightFilters) {
    const q = new Q();
    return run(q, `
      SELECT band, count(*) AS rides,
        count(*) FILTER (WHERE stage_reached >= 2) AS got_offer,
        count(*) FILTER (WHERE stage_reached >= 3) AS driver_assigned,
        count(*) FILTER (WHERE outcome = 'completed') AS completed
      FROM (
        SELECT f.*, CASE
          WHEN f.rider_offer_ngn IS NULL OR COALESCE(f.suggested_fare_ngn, 0) = 0 THEN '9 unknown'
          WHEN f.rider_offer_ngn / f.suggested_fare_ngn < 0.95 THEN '1 under 95%'
          WHEN f.rider_offer_ngn / f.suggested_fare_ngn < 1.0 THEN '2 95–100%'
          WHEN f.rider_offer_ngn / f.suggested_fare_ngn < 1.05 THEN '3 100–105%'
          WHEN f.rider_offer_ngn / f.suggested_fare_ngn < 1.15 THEN '4 105–115%'
          ELSE '5 over 115%' END AS band
        FROM ride_funnel f WHERE ${rideWhere(q, f)}
      ) x GROUP BY 1 ORDER BY 1`);
  },

  /** Drivers' counter-offers against the rider's price, in bands: how often each was the one chosen. */
  bidBands(f: InsightFilters) {
    const q = new Q();
    return run(q, `
      SELECT band, count(*) AS offers, count(*) FILTER (WHERE b.status = 'ACCEPTED') AS chosen,
        round(avg(b.minutes_after_request)::numeric, 2) AS avg_minutes_after_request
      FROM (
        SELECT b.*, CASE
          WHEN b.ratio_to_rider_offer IS NULL THEN '9 unknown'
          WHEN b.ratio_to_rider_offer <= 1.0 THEN '1 at or under the rider''s price'
          WHEN b.ratio_to_rider_offer <= 1.1 THEN '2 up to 10% more'
          WHEN b.ratio_to_rider_offer <= 1.25 THEN '3 10–25% more'
          WHEN b.ratio_to_rider_offer <= 1.5 THEN '4 25–50% more'
          ELSE '5 over 50% more' END AS band
        FROM ride_bids b WHERE ${days(q, f, 'b.day')}
      ) b GROUP BY 1 ORDER BY 1`);
  },

  /** WhatsApp visits that raised or changed their price while searching, against those that did not. */
  raises(f: InsightFilters) {
    const q = new Q();
    return run(q, `
      SELECT CASE WHEN s.raises_tapped > 0 OR s.price_updates > 0 THEN 'Raised or changed the price' ELSE 'Kept their price' END AS what_they_did,
        count(*) AS visits_that_searched,
        count(*) FILTER (WHERE s.got_offers) AS got_offers,
        count(*) FILTER (WHERE s.driver_confirmed) AS booked
      FROM ride_page_sessions s WHERE ${days(q, f, 's.day')} AND (s.searched OR s.tapped_find_drivers)
      GROUP BY 1 ORDER BY 1`);
  },

  /** By pickup zone and hour: how quickly an offer, a driver and the pickup came. */
  speed(f: InsightFilters) {
    const q = new Q();
    return run(q, `
      SELECT COALESCE(f.pickup_zone, 'Outside the zones') AS zone, f.requested_hour AS hour, count(*) AS rides,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY f.minutes_to_first_offer))::numeric, 1) AS median_to_first_offer,
        round((percentile_cont(0.9) WITHIN GROUP (ORDER BY f.minutes_to_first_offer))::numeric, 1) AS slowest10_to_first_offer,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY f.minutes_to_driver_assigned))::numeric, 1) AS median_to_driver,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY f.minutes_driver_to_pickup))::numeric, 1) AS median_driver_to_pickup,
        round(100.0 * count(*) FILTER (WHERE f.outcome = 'completed') / count(*), 1) AS pct_completed
      FROM ride_funnel f WHERE ${rideWhere(q, f)}
      GROUP BY 1, 2 ORDER BY 1, 2`);
  },

  /** By hour of day, weekdays and weekends: requests and drivers online, on average per hour. */
  supply(f: InsightFilters) {
    const q = new Q();
    const from = q.p(f.from);
    const to = q.p(f.to);
    const rides = rideWhere(q, f);
    return run(q, `
      WITH hours AS (
        SELECT h FROM generate_series(
          (${from}::date::timestamp - interval '1 hour'),
          (${to}::date::timestamp + interval '23 hours'),
          interval '1 hour') AS h
      ), online AS (
        SELECT hrs.h, count(DISTINCT s."driverId") AS drivers
        FROM hours hrs
        LEFT JOIN "DriverShift" s ON s."startedAt" < hrs.h + interval '1 hour' AND COALESCE(s."endedAt", now()) > hrs.h
        GROUP BY hrs.h
      ), slots AS (
        SELECT extract(hour FROM (o.h AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos')::int AS hour,
          extract(isodow FROM (o.h AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos') >= 6 AS weekend,
          o.drivers
        FROM online o
      ), demand AS (
        SELECT f.requested_hour AS hour, extract(isodow FROM f.requested_day) >= 6 AS weekend,
          count(*) AS requests, count(*) FILTER (WHERE f.outcome = 'completed') AS completed
        FROM ride_funnel f WHERE ${rides} GROUP BY 1, 2
      )
      SELECT s.hour, CASE WHEN s.weekend THEN 'Weekend' ELSE 'Weekday' END AS days,
        count(*) AS hours_in_period,
        round(avg(s.drivers)::numeric, 1) AS avg_drivers_online,
        round(COALESCE(max(d.requests), 0)::numeric / count(*), 2) AS avg_requests_per_hour,
        CASE WHEN avg(s.drivers) > 0 THEN round((COALESCE(max(d.requests), 0)::numeric / count(*)) / avg(s.drivers)::numeric, 2) END AS requests_per_driver_online,
        CASE WHEN COALESCE(max(d.requests), 0) > 0 THEN round(100.0 * max(d.completed) / max(d.requests), 1) END AS pct_completed
      FROM slots s LEFT JOIN demand d ON d.hour = s.hour AND d.weekend = s.weekend
      GROUP BY 1, 2 ORDER BY 2, 1`);
  },

  /**
   * Week of a first completed ride, and the share riding again 1 to 8 weeks
   * later: the 12 weeks up to the end of the period. `who` is rider or driver.
   */
  cohorts(f: InsightFilters, who: 'rider' | 'driver') {
    const q = new Q();
    const col = who === 'rider' ? 'f.rider_id' : 'f.driver_id';
    const to = q.p(f.to);
    const weeks = Array.from({ length: 8 }, (_, i) => i + 1)
      .map((w) => `count(DISTINCT r.u) FILTER (WHERE r.wk = c.cohort + ${w * 7}) AS week_${w}`).join(',\n        ');
    return run(q, `
      WITH r AS (
        SELECT ${col} AS u, date_trunc('week', f.requested_day)::date AS wk
        FROM ride_funnel f WHERE f.outcome = 'completed' AND ${col} IS NOT NULL GROUP BY 1, 2
      ), c AS (SELECT u, min(wk) AS cohort FROM r GROUP BY u)
      SELECT c.cohort AS first_week, count(DISTINCT c.u) AS people,
        ${weeks}
      FROM c LEFT JOIN r ON r.u = c.u
      WHERE c.cohort BETWEEN date_trunc('week', ${to}::date)::date - 7 * 11 AND ${to}::date
      GROUP BY 1 ORDER BY 1`);
  },

  /**
   * Per week: riders with a completed ride, new ones (their first ever ride),
   * returning (they rode in the 28 days before the week) and back after a gap.
   * Each rider's previous ride day comes from one pass over their rides.
   */
  riderTypes(f: InsightFilters) {
    const q = new Q();
    const from = q.p(f.from);
    const to = q.p(f.to);
    // One pass, no join: each rider's ride days with the one before, and which is first in its week.
    return run(q, `
      WITH daily AS (
        SELECT f.rider_id AS u, f.requested_day AS d, count(*) AS n
        FROM ride_funnel f WHERE f.outcome = 'completed' AND f.rider_id IS NOT NULL
        GROUP BY 1, 2
      ), marked AS (
        SELECT u, d, date_trunc('week', d)::date AS wk,
          lag(d) OVER (PARTITION BY u ORDER BY d) AS prev_d,
          row_number() OVER (PARTITION BY u, date_trunc('week', d) ORDER BY d) AS nth_in_week,
          sum(n) OVER (PARTITION BY u, date_trunc('week', d)) AS rides_in_week
        FROM daily
      )
      SELECT wk AS week, count(*) AS riders, sum(rides_in_week) AS rides,
        count(*) FILTER (WHERE prev_d IS NULL) AS new_riders,
        count(*) FILTER (WHERE prev_d >= wk - 28) AS returning,
        count(*) FILTER (WHERE prev_d < wk - 28) AS back_after_a_gap
      FROM marked
      WHERE nth_in_week = 1 AND wk BETWEEN date_trunc('week', ${from}::date)::date AND ${to}::date
      GROUP BY 1 ORDER BY 1`);
  },

  /** Riders in the period by how many trips they completed, and those at risk at its end. */
  rideCounts(f: InsightFilters) {
    const q = new Q();
    const to = q.p(f.to);
    return run(q, `
      WITH per AS (
        SELECT f.rider_id AS u, count(*) AS rides FROM ride_funnel f
        WHERE ${rideWhere(q, f)} AND f.outcome = 'completed' AND f.rider_id IS NOT NULL GROUP BY 1
      ), risk AS (
        SELECT f.rider_id AS u FROM ride_funnel f WHERE f.outcome = 'completed' AND f.rider_id IS NOT NULL
        GROUP BY 1
        HAVING count(*) FILTER (WHERE f.requested_day < ${to}::date - 14) >= 2
           AND count(*) FILTER (WHERE f.requested_day BETWEEN ${to}::date - 14 AND ${to}::date) = 0
      )
      SELECT '1 trip' AS riders_with, count(*) FILTER (WHERE rides = 1) AS riders FROM per
      UNION ALL SELECT '2–3 trips', count(*) FILTER (WHERE rides BETWEEN 2 AND 3) FROM per
      UNION ALL SELECT '4–9 trips', count(*) FILTER (WHERE rides BETWEEN 4 AND 9) FROM per
      UNION ALL SELECT '10 or more trips', count(*) FILTER (WHERE rides >= 10) FROM per
      UNION ALL SELECT 'At risk: 2+ trips before, none in the last 14 days', count(*) FROM risk`);
  },

  /** Per driver, the 500 with the most completed trips: offers, how often chosen, reliability, speed, hours and fares. */
  drivers(f: InsightFilters) {
    const q = new Q();
    const from = q.p(f.from);
    const to = q.p(f.to);
    const rides = rideWhere(q, f);
    return run(q, `
      WITH b AS (
        SELECT b.driver_id, count(*) AS offers, count(*) FILTER (WHERE b.status = 'ACCEPTED') AS chosen,
          round((percentile_cont(0.5) WITHIN GROUP (ORDER BY b.minutes_after_request))::numeric, 2) AS median_minutes_to_offer
        FROM ride_bids b WHERE b.day BETWEEN ${from}::date AND ${to}::date GROUP BY 1
      ), r AS (
        SELECT f.driver_id,
          count(*) FILTER (WHERE f.outcome = 'completed') AS completed,
          count(*) FILTER (WHERE f.outcome = 'cancelled' AND f.stage_reached >= 3) AS cancelled_after_assigned,
          round(avg(f.minutes_driver_to_pickup)::numeric, 1) AS avg_minutes_to_pickup,
          sum(COALESCE(f.final_fare_ngn, f.agreed_fare_ngn)) FILTER (WHERE f.outcome = 'completed') AS fares_ngn
        FROM ride_funnel f WHERE ${rides} AND f.driver_id IS NOT NULL GROUP BY 1
      ), s AS (
        SELECT sh."driverId" AS driver_id,
          sum(extract(epoch FROM (
            LEAST(COALESCE(sh."endedAt", now()), (${to}::date + 1)::timestamp - interval '1 hour')
            - GREATEST(sh."startedAt", ${from}::date::timestamp - interval '1 hour'))) / 3600.0) AS online_hours
        FROM "DriverShift" sh
        WHERE sh."startedAt" < (${to}::date + 1)::timestamp - interval '1 hour'
          AND COALESCE(sh."endedAt", now()) > ${from}::date::timestamp - interval '1 hour'
        GROUP BY 1
      )
      SELECT d."id" AS driver_id, u."name" AS driver, d."rating" AS rating,
        COALESCE(b.offers, 0) AS offers, COALESCE(b.chosen, 0) AS chosen, b.median_minutes_to_offer,
        COALESCE(r.completed, 0) AS completed, COALESCE(r.cancelled_after_assigned, 0) AS cancelled_after_assigned,
        r.avg_minutes_to_pickup,
        round(COALESCE(s.online_hours, 0)::numeric, 1) AS online_hours,
        COALESCE(r.fares_ngn, 0) AS fares_ngn,
        CASE WHEN COALESCE(s.online_hours, 0) > 0.25 THEN round((COALESCE(r.fares_ngn, 0) / s.online_hours::numeric), 0) END AS fares_per_online_hour
      FROM "Driver" d
      JOIN "User" u ON u."id" = d."userId"
      LEFT JOIN b ON b.driver_id = d."id"
      LEFT JOIN r ON r.driver_id = d."id"
      LEFT JOIN s ON s.driver_id = d."id"
      WHERE COALESCE(b.offers, 0) + COALESCE(r.completed, 0) + COALESCE(s.online_hours, 0) > 0
      ORDER BY COALESCE(r.completed, 0) DESC, COALESCE(b.offers, 0) DESC
      LIMIT 500`);
  },

  /** Per day: riders asked to add money on the WhatsApp page, how many deposited within 30 minutes and booked; and XLM's share of trips. */
  money(f: InsightFilters) {
    const q = new Q();
    const from = q.p(f.from);
    const to = q.p(f.to);
    return run(q, `
      WITH short AS (
        SELECT e."sessionId", e."userId", min(e."createdAt") AS at,
          ((min(e."createdAt") AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos')::date AS day
        FROM "RidePageEvent" e WHERE e."event" = 'wallet_short_shown'
        GROUP BY 1, 2
      ), shortdays AS (
        SELECT s.day,
          count(*) AS asked_to_add_money,
          count(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM "Transaction" t JOIN "Wallet" w ON w."id" = t."walletId"
            WHERE w."userId" = s."userId" AND t."type" = 'DEPOSIT' AND t."direction" = 'CREDIT'
              AND t."createdAt" BETWEEN s.at AND s.at + interval '30 minutes')) AS deposited_within_30_min,
          count(*) FILTER (WHERE ps.driver_confirmed) AS then_booked
        FROM short s LEFT JOIN ride_page_sessions ps ON ps.session_id = s."sessionId"
        WHERE s.day BETWEEN ${from}::date AND ${to}::date
        GROUP BY 1
      ), trips AS (
        SELECT f.requested_day AS day, count(*) FILTER (WHERE f.outcome = 'completed') AS completed,
          count(*) FILTER (WHERE f.outcome = 'completed' AND f.payment_method = 'XLM') AS completed_paid_in_xlm
        FROM ride_funnel f WHERE f.requested_day BETWEEN ${from}::date AND ${to}::date GROUP BY 1
      )
      SELECT COALESCE(t.day, sd.day) AS day,
        COALESCE(sd.asked_to_add_money, 0) AS asked_to_add_money,
        COALESCE(sd.deposited_within_30_min, 0) AS deposited_within_30_min,
        COALESCE(sd.then_booked, 0) AS then_booked,
        COALESCE(t.completed, 0) AS completed_trips,
        COALESCE(t.completed_paid_in_xlm, 0) AS completed_paid_in_xlm
      FROM trips t FULL JOIN shortdays sd ON sd.day = t.day
      ORDER BY 1`);
  },
};
