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

  /**
   * Everyone who has a referral code, whether or not anyone used it yet: their
   * code and, of all time, friends brought, how many rode, cashback given and
   * what they have left. Most friends first; search by name, phone or code.
   */
  async codes(f: { q?: string | null; sort?: 'referred' | 'newest' | 'cashback'; limit?: number; offset?: number }) {
    const where: Prisma.Sql[] = [Prisma.sql`true`];
    const q = f.q?.trim();
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      const digits = q.replace(/\D/g, '');
      const phone = digits.length >= 4 ? `%${digits.replace(/^0/, '')}%` : null;
      where.push(Prisma.sql`(k."code" ILIKE ${like} OR u."name" ILIKE ${like} OR u."username" ILIKE ${like}
        ${phone ? Prisma.sql`OR u."phone" LIKE ${phone}` : Prisma.empty})`);
    }
    const condition = Prisma.join(where, ' AND ');
    const order = f.sort === 'newest'
      ? Prisma.sql`k."createdAt" DESC`
      : f.sort === 'cashback'
        ? Prisma.sql`earned_ngn DESC, referred DESC, k."createdAt" DESC`
        : Prisma.sql`referred DESC, rode DESC, k."createdAt" DESC`;
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
    const offset = Math.max(f.offset ?? 0, 0);

    const [counted, rows] = await Promise.all([
      prisma.$queryRaw<Row[]>`SELECT count(*) AS total FROM "ReferralCode" k JOIN "User" u ON u."id" = k."userId" WHERE ${condition}`,
      prisma.$queryRaw<Row[]>`
        SELECT k."userId" AS user_id, u."name", u."phone", u."role"::text AS role, k."code", k."isActive" AS is_active, k."createdAt" AS code_created_at,
          COALESCE(r.referred, 0) AS referred, COALESCE(r.rode, 0) AS rode, COALESCE(r.waiting, 0) AS waiting, COALESCE(r.no_ride, 0) AS no_ride,
          r.last_referred_at,
          COALESCE(c.earned_ngn, 0) AS earned_ngn, COALESCE(c.available_ngn, 0) AS available_ngn
        FROM "ReferralCode" k
        JOIN "User" u ON u."id" = k."userId"
        LEFT JOIN LATERAL (
          SELECT count(*) AS referred,
            count(*) FILTER (WHERE x."status" = 'QUALIFIED_RIDE') AS rode,
            count(*) FILTER (WHERE x."status" = 'PENDING') AS waiting,
            count(*) FILTER (WHERE x."status" = 'EXPIRED_NO_RIDE') AS no_ride,
            max(x."appliedAt") AS last_referred_at
          FROM "Referral" x WHERE x."referrerId" = k."userId"
        ) r ON true
        LEFT JOIN LATERAL (
          SELECT sum(c."amountNgn") AS earned_ngn,
            sum(c."remainingAmountNgn") FILTER (WHERE c."status" = 'AVAILABLE' AND c."freezesAt" > now()) AS available_ngn
          FROM "ReferralCashback" c WHERE c."userId" = k."userId"
        ) c ON true
        WHERE ${condition}
        ORDER BY ${order}
        LIMIT ${limit} OFFSET ${offset}`,
    ]);

    return {
      total: Number(plain(counted)[0]?.total ?? 0),
      limit,
      offset,
      rows: plain(rows).map((r) => ({
        userId: String(r.user_id),
        name: (r.name as string | null) ?? null,
        phone: (r.phone as string | null) ?? null,
        role: String(r.role),
        code: String(r.code),
        active: Boolean(r.is_active),
        codeCreatedAt: (r.code_created_at as Date).toISOString(),
        referred: Number(r.referred),
        rode: Number(r.rode),
        waiting: Number(r.waiting),
        noRide: Number(r.no_ride),
        lastReferredAt: r.last_referred_at ? (r.last_referred_at as Date).toISOString() : null,
        earnedNgn: Number(r.earned_ngn),
        availableNgn: Number(r.available_ngn),
      })),
    };
  },

  /**
   * One person's referrals, of all time: their code, who brought them, every
   * friend they brought (with how far that friend got), and every naira of
   * cashback: given for which friend, spent on which ride, left, frozen.
   * Null when they are not a user.
   */
  async person(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, phone: true, username: true, role: true, createdAt: true, referralCode: { select: { code: true, isActive: true, createdAt: true } } },
    });
    if (!user) return null;

    const [broughtBy, friends, cashback, usages] = await Promise.all([
      prisma.referral.findUnique({
        where: { referredUserId: userId },
        select: { code: true, status: true, appliedAt: true, referrer: { select: { id: true, name: true, phone: true } } },
      }),
      prisma.$queryRaw<Row[]>`
        SELECT r."id", r."code", r."status"::text AS status, r."appliedAt" AS applied_at, r."expiresAt" AS expires_at, r."qualifiedAt" AS qualified_at,
          b."id" AS friend_id, b."name" AS friend_name, b."phone" AS friend_phone, b."createdAt" AS friend_joined_at,
          fr."id" AS first_ride_id, fr."tripNumber" AS first_ride_number, fr."completedAt" AS first_ride_at, fr."fareFinalNgn" AS first_ride_fare_ngn,
          (SELECT count(*) FROM "Ride" x WHERE x."riderId" = r."referredUserId" AND x."status" = 'COMPLETED') AS friend_trips,
          (SELECT max(x."completedAt") FROM "Ride" x WHERE x."riderId" = r."referredUserId" AND x."status" = 'COMPLETED') AS friend_last_trip_at,
          c."amountNgn" AS cashback_ngn, c."status"::text AS cashback_status
        FROM "Referral" r
        JOIN "User" b ON b."id" = r."referredUserId"
        LEFT JOIN "Ride" fr ON fr."id" = r."firstRideId"
        LEFT JOIN LATERAL (
          SELECT c."amountNgn", c."status" FROM "ReferralCashback" c WHERE c."sourceReferralId" = r."id" ORDER BY c."createdAt" LIMIT 1
        ) c ON true
        WHERE r."referrerId" = ${userId}
        ORDER BY r."appliedAt" DESC
        LIMIT 1000`,
      prisma.referralCashback.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 500,
        select: {
          id: true, type: true, amountNgn: true, remainingAmountNgn: true, status: true, freezesAt: true, frozenAt: true, usedAt: true, createdAt: true,
          sourceReferral: { select: { referredUser: { select: { id: true, name: true, phone: true } } } },
        },
      }),
      prisma.$queryRaw<Row[]>`
        SELECT u."id", u."amountNgn" AS amount_ngn, u."status"::text AS status, u."createdAt" AS created_at, u."settledAt" AS settled_at,
          x."id" AS ride_id, x."tripNumber" AS trip_number, x."fareFinalNgn" AS fare_ngn
        FROM "ReferralCashbackUsage" u
        JOIN "ReferralCashback" c ON c."id" = u."cashbackId"
        LEFT JOIN "Ride" x ON x."id" = u."rideId"
        WHERE c."userId" = ${userId}
        ORDER BY u."createdAt" DESC
        LIMIT 500`,
    ]);

    const friendRows = plain(friends).map((r) => ({
      id: String(r.id),
      code: String(r.code),
      status: r.status as ReferralStatusName,
      appliedAt: (r.applied_at as Date).toISOString(),
      expiresAt: (r.expires_at as Date).toISOString(),
      qualifiedAt: r.qualified_at ? (r.qualified_at as Date).toISOString() : null,
      friend: { id: String(r.friend_id), name: (r.friend_name as string | null) ?? null, phone: (r.friend_phone as string | null) ?? null, joinedAt: (r.friend_joined_at as Date).toISOString() },
      firstRide: r.first_ride_id
        ? { id: String(r.first_ride_id), tripNumber: Number(r.first_ride_number), completedAt: r.first_ride_at ? (r.first_ride_at as Date).toISOString() : null, fareNgn: r.first_ride_fare_ngn == null ? null : Number(r.first_ride_fare_ngn) }
        : null,
      friendTrips: Number(r.friend_trips ?? 0),
      friendLastTripAt: r.friend_last_trip_at ? (r.friend_last_trip_at as Date).toISOString() : null,
      cashback: r.cashback_ngn == null ? null : { amountNgn: Number(r.cashback_ngn), status: String(r.cashback_status) },
    }));
    const now = Date.now();
    const money = (v: Prisma.Decimal) => Number(v.toString());
    const cashbackRows = cashback.map((c) => ({
      id: c.id,
      type: c.type,
      amountNgn: money(c.amountNgn),
      remainingNgn: money(c.remainingAmountNgn),
      status: c.status,
      freezesAt: c.freezesAt.toISOString(),
      frozenAt: c.frozenAt?.toISOString() ?? null,
      usedAt: c.usedAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
      forFriend: c.sourceReferral?.referredUser ?? null,
    }));
    const usageRows = plain(usages).map((u) => ({
      id: String(u.id),
      amountNgn: Number(u.amount_ngn),
      status: String(u.status),
      createdAt: (u.created_at as Date).toISOString(),
      settledAt: u.settled_at ? (u.settled_at as Date).toISOString() : null,
      ride: u.ride_id ? { id: String(u.ride_id), tripNumber: Number(u.trip_number), fareNgn: u.fare_ngn == null ? null : Number(u.fare_ngn) } : null,
    }));

    const sum = (rows: Array<{ amountNgn: number }>) => rows.reduce((t, r) => t + r.amountNgn, 0);
    return {
      user: { id: user.id, name: user.name, phone: user.phone, username: user.username, role: user.role, joinedAt: user.createdAt.toISOString() },
      code: user.referralCode ? { code: user.referralCode.code, active: user.referralCode.isActive, createdAt: user.referralCode.createdAt.toISOString() } : null,
      broughtBy: broughtBy
        ? { code: broughtBy.code, status: broughtBy.status, appliedAt: broughtBy.appliedAt.toISOString(), referrer: broughtBy.referrer }
        : null,
      summary: {
        referred: friendRows.length,
        rode: friendRows.filter((r) => r.status === 'QUALIFIED_RIDE').length,
        waiting: friendRows.filter((r) => r.status === 'PENDING').length,
        noRide: friendRows.filter((r) => r.status === 'EXPIRED_NO_RIDE').length,
        friendsStillRiding: friendRows.filter((r) => r.friendLastTripAt && now - Date.parse(r.friendLastTripAt) < 30 * 86_400_000).length,
        friendTrips: friendRows.reduce((t, r) => t + r.friendTrips, 0),
        earnedNgn: sum(cashbackRows),
        spentNgn: sum(usageRows.filter((u) => u.status === 'SETTLED')),
        availableNgn: cashbackRows.filter((c) => c.status === 'AVAILABLE' && Date.parse(c.freezesAt) > now).reduce((t, c) => t + c.remainingNgn, 0),
        frozenNgn: cashbackRows.filter((c) => c.status === 'FROZEN').reduce((t, c) => t + c.remainingNgn, 0),
      },
      friends: friendRows,
      cashback: cashbackRows,
      spending: usageRows,
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
