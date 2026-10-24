import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

/**
 * The admin Referrals page: who brought whom, whether the friend rode, and the
 * cashback it earned. The rules are referral.client.ts's: the referrer earns
 * ₦1,000 when the friend completes a ride within 30 days of using the code,
 * ₦500 when they do not; cashback not used in 30 days is frozen until the next
 * friend joins.
 *
 * The period is Lagos days, both included, and counts referrals by the day the
 * code was used. Cashback available and frozen are as of now.
 */

export const REFERRAL_STATUSES = ['PENDING', 'QUALIFIED_RIDE', 'EXPIRED_NO_RIDE', 'CLOSED'] as const;
export type ReferralStatusName = (typeof REFERRAL_STATUSES)[number];

export type ReferralFilters = {
  from: string;
  to: string;
  status?: ReferralStatusName | null;
  /** A name, phone number or code, of either person. */
  q?: string | null;
  limit?: number;
  offset?: number;
};

type Row = Record<string, unknown>;

/** Every bigint and decimal as a number; nulls stay null. */
function plain<T extends Row>(rows: T[]): T[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => {
    if (typeof v === 'bigint') return [k, Number(v)];
    if (v !== null && typeof v === 'object' && !(v instanceof Date) && 'toFixed' in (v as object)) return [k, Number(String(v))];
    return [k, v];
  })) as T);
}

/** Lagos midnight of `from` to Lagos midnight after `to`, in UTC (the columns are UTC). */
function bounds(f: Pick<ReferralFilters, 'from' | 'to'>) {
  return {
    start: Prisma.sql`(${f.from}::date::timestamp - interval '1 hour')`,
    end: Prisma.sql`(${f.to}::date::timestamp + interval '23 hours')`,
  };
}

const lagosDay = (column: Prisma.Sql) => Prisma.sql`((${column} AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos')::date`;

export const adminReferralsClient = {
  async overview(f: ReferralFilters) {
    const { start, end } = bounds(f);
    const inPeriod = Prisma.sql`r."appliedAt" >= ${start} AND r."appliedAt" < ${end}`;

    const [summary, rewards, wallet, codes, byDay, topReferrers] = await Promise.all([
      prisma.$queryRaw<Row[]>`
        SELECT count(*) AS referred,
          count(DISTINCT r."referrerId") AS referrers,
          count(*) FILTER (WHERE r."status" = 'QUALIFIED_RIDE') AS rode,
          count(*) FILTER (WHERE r."status" = 'EXPIRED_NO_RIDE') AS no_ride,
          count(*) FILTER (WHERE r."status" = 'PENDING') AS waiting,
          count(*) FILTER (WHERE r."status" = 'CLOSED') AS closed,
          round(avg(extract(epoch FROM (fr."completedAt" - r."appliedAt")) / 86400.0)::numeric, 1) AS avg_days_to_first_ride
        FROM "Referral" r
        LEFT JOIN "Ride" fr ON fr."id" = r."firstRideId"
        WHERE ${inPeriod}`,
      // Cashback earned in the period (by when it was given) and spent on rides in it.
      prisma.$queryRaw<Row[]>`
        SELECT
          (SELECT COALESCE(sum(c."amountNgn"), 0) FROM "ReferralCashback" c WHERE c."createdAt" >= ${start} AND c."createdAt" < ${end}) AS earned_ngn,
          (SELECT COALESCE(sum(c."amountNgn"), 0) FROM "ReferralCashback" c WHERE c."type" = 'RIDE_QUALIFIED' AND c."createdAt" >= ${start} AND c."createdAt" < ${end}) AS earned_ride_ngn,
          (SELECT COALESCE(sum(c."amountNgn"), 0) FROM "ReferralCashback" c WHERE c."type" = 'NO_RIDE_EXPIRED' AND c."createdAt" >= ${start} AND c."createdAt" < ${end}) AS earned_no_ride_ngn,
          (SELECT COALESCE(sum(u."amountNgn"), 0) FROM "ReferralCashbackUsage" u WHERE u."status" = 'SETTLED' AND u."settledAt" >= ${start} AND u."settledAt" < ${end}) AS spent_ngn`,
      prisma.$queryRaw<Row[]>`
        SELECT
          COALESCE(sum(c."remainingAmountNgn") FILTER (WHERE c."status" = 'AVAILABLE' AND c."freezesAt" > now()), 0) AS available_ngn,
          count(DISTINCT c."userId") FILTER (WHERE c."status" = 'AVAILABLE' AND c."freezesAt" > now() AND c."remainingAmountNgn" > 0) AS people_with_cashback,
          COALESCE(sum(c."remainingAmountNgn") FILTER (WHERE c."status" = 'FROZEN'), 0) AS frozen_ngn
        FROM "ReferralCashback" c`,
      prisma.$queryRaw<Row[]>`
        SELECT count(*) AS codes,
          count(*) FILTER (WHERE k."createdAt" >= ${start} AND k."createdAt" < ${end}) AS codes_in_period,
          (SELECT count(DISTINCT r."referrerId") FROM "Referral" r) AS referrers_ever
        FROM "ReferralCode" k`,
      prisma.$queryRaw<Row[]>`
        WITH joined AS (
          SELECT ${lagosDay(Prisma.sql`r."appliedAt"`)} AS day, count(*) AS n FROM "Referral" r
          WHERE ${inPeriod} GROUP BY 1
        ), rode AS (
          SELECT ${lagosDay(Prisma.sql`r."qualifiedAt"`)} AS day, count(*) AS n FROM "Referral" r
          WHERE r."qualifiedAt" >= ${start} AND r."qualifiedAt" < ${end} GROUP BY 1
        )
        SELECT g::date AS day, COALESCE(j.n, 0) AS referred, COALESCE(q.n, 0) AS rode
        FROM generate_series(${f.from}::date, ${f.to}::date, interval '1 day') AS g
        LEFT JOIN joined j ON j.day = g::date
        LEFT JOIN rode q ON q.day = g::date
        ORDER BY 1`,
      prisma.$queryRaw<Row[]>`
        SELECT r."referrerId" AS user_id, u."name", u."phone", k."code",
          count(*) AS referred,
          count(*) FILTER (WHERE r."status" = 'QUALIFIED_RIDE') AS rode,
          count(*) FILTER (WHERE r."status" = 'PENDING') AS waiting,
          COALESCE(sum(c."amountNgn"), 0) AS earned_ngn,
          max(r."appliedAt") AS last_referred_at
        FROM "Referral" r
        JOIN "User" u ON u."id" = r."referrerId"
        LEFT JOIN "ReferralCode" k ON k."userId" = r."referrerId"
        LEFT JOIN "ReferralCashback" c ON c."sourceReferralId" = r."id"
        WHERE ${inPeriod}
        GROUP BY r."referrerId", u."name", u."phone", k."code"
        ORDER BY referred DESC, rode DESC, last_referred_at DESC
        LIMIT 20`,
    ]);

    const s = plain(summary)[0] ?? {};
    const r = plain(rewards)[0] ?? {};
    const w = plain(wallet)[0] ?? {};
    const k = plain(codes)[0] ?? {};
    const rode = Number(s.rode ?? 0);
    const noRide = Number(s.no_ride ?? 0);
    return {
      summary: {
        referred: Number(s.referred ?? 0),
        referrers: Number(s.referrers ?? 0),
        rode,
        noRide,
        waiting: Number(s.waiting ?? 0),
        closed: Number(s.closed ?? 0),
        /** Of the friends whose 30 days are over, the share who rode. */
        rodeRate: rode + noRide > 0 ? rode / (rode + noRide) : null,
        avgDaysToFirstRide: s.avg_days_to_first_ride == null ? null : Number(s.avg_days_to_first_ride),
        codes: Number(k.codes ?? 0),
        codesInPeriod: Number(k.codes_in_period ?? 0),
        referrersEver: Number(k.referrers_ever ?? 0),
      },
      cashback: {
        earnedNgn: Number(r.earned_ngn ?? 0),
        earnedForRidesNgn: Number(r.earned_ride_ngn ?? 0),
        earnedNoRideNgn: Number(r.earned_no_ride_ngn ?? 0),
        spentNgn: Number(r.spent_ngn ?? 0),
        availableNgn: Number(w.available_ngn ?? 0),
        peopleWithCashback: Number(w.people_with_cashback ?? 0),
        frozenNgn: Number(w.frozen_ngn ?? 0),
      },
      byDay: plain(byDay).map((d) => ({ day: (d.day as Date).toISOString().slice(0, 10), referred: Number(d.referred), rode: Number(d.rode) })),
      topReferrers: plain(topReferrers).map((t) => ({
        userId: String(t.user_id),
        name: (t.name as string | null) ?? null,
        phone: (t.phone as string | null) ?? null,
        code: (t.code as string | null) ?? null,
        referred: Number(t.referred),
        rode: Number(t.rode),
        waiting: Number(t.waiting),
        earnedNgn: Number(t.earned_ngn),
        lastReferredAt: (t.last_referred_at as Date).toISOString(),
      })),
    };
  },

  /** Every referral in the period, newest first: both people, the friend's first ride and the cashback. */
  async list(f: ReferralFilters) {
    const { start, end } = bounds(f);
    const where: Prisma.Sql[] = [Prisma.sql`r."appliedAt" >= ${start} AND r."appliedAt" < ${end}`];
    if (f.status) where.push(Prisma.sql`r."status" = ${f.status}::"ReferralStatus"`);
    const q = f.q?.trim();
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      const digits = q.replace(/\D/g, '');
      // Phone numbers match on their last digits too: 0803… and +234803… are the same person.
      const phone = digits.length >= 4 ? `%${digits.replace(/^0/, '')}%` : null;
      where.push(Prisma.sql`(
        r."code" ILIKE ${like} OR a."name" ILIKE ${like} OR b."name" ILIKE ${like}
        ${phone ? Prisma.sql`OR a."phone" LIKE ${phone} OR b."phone" LIKE ${phone}` : Prisma.empty}
      )`);
    }
    const condition = Prisma.join(where, ' AND ');
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
    const offset = Math.max(f.offset ?? 0, 0);

    const [counted, rows] = await Promise.all([
      prisma.$queryRaw<Row[]>`
        SELECT count(*) AS total FROM "Referral" r
        JOIN "User" a ON a."id" = r."referrerId"
        JOIN "User" b ON b."id" = r."referredUserId"
        WHERE ${condition}`,
      prisma.$queryRaw<Row[]>`
        SELECT r."id", r."code", r."status"::text AS status, r."appliedAt" AS applied_at, r."expiresAt" AS expires_at, r."qualifiedAt" AS qualified_at,
          a."id" AS referrer_id, a."name" AS referrer_name, a."phone" AS referrer_phone,
          b."id" AS referred_id, b."name" AS referred_name, b."phone" AS referred_phone,
          fr."id" AS first_ride_id, fr."tripNumber" AS first_ride_number, fr."completedAt" AS first_ride_at, fr."fareFinalNgn" AS first_ride_fare_ngn,
          (SELECT count(*) FROM "Ride" x WHERE x."riderId" = r."referredUserId" AND x."status" = 'COMPLETED') AS friend_trips,
          c."amountNgn" AS cashback_ngn, c."status"::text AS cashback_status
        FROM "Referral" r
        JOIN "User" a ON a."id" = r."referrerId"
        JOIN "User" b ON b."id" = r."referredUserId"
        LEFT JOIN "Ride" fr ON fr."id" = r."firstRideId"
        LEFT JOIN LATERAL (
          SELECT c."amountNgn", c."status" FROM "ReferralCashback" c WHERE c."sourceReferralId" = r."id" ORDER BY c."createdAt" LIMIT 1
        ) c ON true
        WHERE ${condition}
        ORDER BY r."appliedAt" DESC
        LIMIT ${limit} OFFSET ${offset}`,
    ]);

    return {
      total: Number(plain(counted)[0]?.total ?? 0),
      limit,
      offset,
      rows: plain(rows).map((r) => ({
        id: String(r.id),
        code: String(r.code),
        status: r.status as ReferralStatusName,
        appliedAt: (r.applied_at as Date).toISOString(),
        expiresAt: (r.expires_at as Date).toISOString(),
        qualifiedAt: r.qualified_at ? (r.qualified_at as Date).toISOString() : null,
        referrer: { id: String(r.referrer_id), name: (r.referrer_name as string | null) ?? null, phone: (r.referrer_phone as string | null) ?? null },
        referred: { id: String(r.referred_id), name: (r.referred_name as string | null) ?? null, phone: (r.referred_phone as string | null) ?? null },
        firstRide: r.first_ride_id
          ? { id: String(r.first_ride_id), tripNumber: Number(r.first_ride_number), completedAt: r.first_ride_at ? (r.first_ride_at as Date).toISOString() : null, fareNgn: r.first_ride_fare_ngn == null ? null : Number(r.first_ride_fare_ngn) }
          : null,
        friendTrips: Number(r.friend_trips ?? 0),
        cashback: r.cashback_ngn == null ? null : { amountNgn: Number(r.cashback_ngn), status: String(r.cashback_status) },
      })),
    };
  },
};
