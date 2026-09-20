import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

/**
 * Everything the admin panel needs to show the business as it actually is.
 *
 * Two rules shaped this file:
 *  1. Money comes from the `Transaction` ledger, not from ride columns. Ride
 *     columns only carry the fare of *completed* rides, which quietly reads as
 *     "no revenue" whenever settlement is behind. The ledger is the truth.
 *  2. Numbers are returned as strings for anything money-shaped. Decimal(18,2)
 *     does not survive a JSON round-trip as a float without losing kobo.
 */

const ACTIVE_RIDE_STATUSES = [
  'REQUESTED',
  'MATCHING',
  'DRIVER_ASSIGNED',
  'DRIVER_EN_ROUTE',
  'ARRIVED',
  'IN_PROGRESS',
] as const;

/** The synthetic account that collects platform fees — never a real customer. */
const PLATFORM_USER_ID = '00000000-0000-0000-0000-000000000001';

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

const money = (value: Prisma.Decimal | null | undefined): string =>
  (value ?? new Prisma.Decimal(0)).toFixed(2);

export type AdminUserListRow = {
  id: string;
  name: string | null;
  username: string | null;
  email: string | null;
  phone: string | null;
  role: string;
  riderKycStatus: string;
  createdAt: Date;
  isDriver: boolean;
  driverId: string | null;
  driverStatus: string | null;
  driverKycStatus: string | null;
  driverRating: number | null;
  driverTotalRides: number | null;
  driverEarningsNgn: string | null;
  vehicle: string | null;
  walletBalanceNgn: string;
  walletLockedNgn: string;
  ridesTotal: number;
  ridesCompleted: number;
  ridesCancelled: number;
  totalSpentNgn: string;
  lastRideAt: Date | null;
};

export const adminMetricsClient = {
  /**
   * The user directory: every rider and driver, searchable, sortable, paged.
   * Aggregates are computed per row so the table can show real ride counts and
   * spend without N+1 follow-up queries.
   */
  listUsers: async (options: {
    role?: 'all' | 'rider' | 'driver';
    q?: string;
    limit?: number;
    offset?: number;
    sort?: 'recent' | 'rides' | 'spend' | 'name';
  } = {}) => {
    const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
    const offset = Math.max(options.offset ?? 0, 0);
    const role = options.role ?? 'all';
    const q = options.q?.trim();

    const filters: Prisma.Sql[] = [Prisma.sql`u.id <> ${PLATFORM_USER_ID}`];
    if (role === 'driver') filters.push(Prisma.sql`d.id IS NOT NULL`);
    else if (role === 'rider') filters.push(Prisma.sql`d.id IS NULL`);

    if (q) {
      const like = `%${q}%`;
      filters.push(Prisma.sql`(
        u.name ILIKE ${like}
        OR u.phone ILIKE ${like}
        OR u.email ILIKE ${like}
        OR u.username ILIKE ${like}
        OR u.id::text = ${q}
      )`);
    }

    const where = Prisma.sql`WHERE ${Prisma.join(filters, ' AND ')}`;

    // "Rides" and "spend" mean different columns depending on which side of the
    // marketplace you are looking at: a driver's volume is trips driven and
    // money earned, a rider's is trips taken and money spent. Sorting drivers
    // by their (usually zero) rider stats ranked the busiest driver last.
    const ridesOrder =
      role === 'driver'
        ? Prisma.sql`COALESCE(d."totalRides", 0) DESC`
        : role === 'rider'
          ? Prisma.sql`COALESCE(r.completed, 0) DESC`
          : Prisma.sql`GREATEST(COALESCE(d."totalRides", 0), COALESCE(r.completed, 0)) DESC`;

    const spendOrder =
      role === 'driver'
        ? Prisma.sql`COALESCE(d."totalEarningsNgn", 0) DESC`
        : role === 'rider'
          ? Prisma.sql`COALESCE(r.spent, 0) DESC`
          : Prisma.sql`GREATEST(COALESCE(d."totalEarningsNgn", 0), COALESCE(r.spent, 0)) DESC`;

    const orderBy =
      options.sort === 'rides'
        ? Prisma.sql`${ridesOrder}, u."createdAt" DESC`
        : options.sort === 'spend'
          ? Prisma.sql`${spendOrder}, u."createdAt" DESC`
          : options.sort === 'name'
            ? Prisma.sql`COALESCE(NULLIF(u.name, ''), u.username, u.phone) ASC NULLS LAST`
            : Prisma.sql`u."createdAt" DESC`;

    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT
        u.id,
        u.name,
        u.username,
        u.email,
        u.phone,
        u.role::text                         AS role,
        u."riderKycStatus"::text             AS "riderKycStatus",
        u."createdAt",
        d.id                                 AS "driverId",
        d.status::text                       AS "driverStatus",
        d."kycStatus"::text                  AS "driverKycStatus",
        d.rating                             AS "driverRating",
        d."totalRides"                       AS "driverTotalRides",
        d."totalEarningsNgn"::text           AS "driverEarningsNgn",
        NULLIF(TRIM(CONCAT_WS(' ', d."vehicleMake", d."vehicleModel")), '') AS vehicle,
        COALESCE(w."balanceNgn", 0)::text    AS "walletBalanceNgn",
        COALESCE(w."lockedNgn", 0)::text     AS "walletLockedNgn",
        COALESCE(r.total, 0)::int            AS "ridesTotal",
        COALESCE(r.completed, 0)::int        AS "ridesCompleted",
        COALESCE(r.cancelled, 0)::int        AS "ridesCancelled",
        COALESCE(r.spent, 0)::text           AS "totalSpentNgn",
        r."lastRideAt"
      FROM "User" u
      LEFT JOIN "Driver" d ON d."userId" = u.id
      LEFT JOIN "Wallet" w ON w."userId" = u.id
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)                                                   AS total,
          COUNT(*) FILTER (WHERE ride.status = 'COMPLETED')          AS completed,
          COUNT(*) FILTER (WHERE ride.status = 'CANCELLED')          AS cancelled,
          COALESCE(SUM(ride."fareFinalNgn") FILTER (WHERE ride.status = 'COMPLETED'), 0) AS spent,
          MAX(ride."createdAt")                                      AS "lastRideAt"
        FROM "Ride" ride
        WHERE ride."riderId" = u.id
      ) r ON TRUE
      ${where}
      ORDER BY ${orderBy}
      LIMIT ${limit} OFFSET ${offset}
    `;

    const totalRow = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM "User" u
      LEFT JOIN "Driver" d ON d."userId" = u.id
      ${where}
    `;

    const items: AdminUserListRow[] = rows.map((row) => ({
      id: row.id as string,
      name: (row.name as string) ?? null,
      username: (row.username as string) ?? null,
      email: (row.email as string) ?? null,
      phone: (row.phone as string) ?? null,
      role: row.role as string,
      riderKycStatus: row.riderKycStatus as string,
      createdAt: row.createdAt as Date,
      isDriver: row.driverId !== null,
      driverId: (row.driverId as string) ?? null,
      driverStatus: (row.driverStatus as string) ?? null,
      driverKycStatus: (row.driverKycStatus as string) ?? null,
      driverRating: row.driverRating === null ? null : Number(row.driverRating),
      driverTotalRides: row.driverTotalRides === null ? null : Number(row.driverTotalRides),
      driverEarningsNgn: (row.driverEarningsNgn as string) ?? null,
      vehicle: (row.vehicle as string) ?? null,
      walletBalanceNgn: row.walletBalanceNgn as string,
      walletLockedNgn: row.walletLockedNgn as string,
      ridesTotal: Number(row.ridesTotal),
      ridesCompleted: Number(row.ridesCompleted),
      ridesCancelled: Number(row.ridesCancelled),
      totalSpentNgn: row.totalSpentNgn as string,
      lastRideAt: (row.lastRideAt as Date) ?? null,
    }));

    const total = totalRow[0]?.count ?? 0;
    return {
      items,
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    };
  },

  /** Everything about one person, on one screen. */
  getUserDetail: async (userId: string) => {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        driver: true,
        wallet: true,
        virtualAccount: true,
        referralCode: true,
      },
    });
    if (!user) return null;

    const walletId = user.wallet?.id;

    const [
      rideGroups,
      completedAgg,
      recentRides,
      driverRideGroups,
      driverRecentRides,
      transactions,
      txnGroups,
      withdrawals,
      referralsMade,
    ] = await Promise.all([
      prisma.ride.groupBy({
        by: ['status'],
        where: { riderId: userId },
        _count: { _all: true },
      }),
      prisma.ride.aggregate({
        where: { riderId: userId, status: 'COMPLETED' },
        _sum: { fareFinalNgn: true, distanceKm: true, platformFeeNgn: true },
        _avg: { fareFinalNgn: true, distanceKm: true },
      }),
      prisma.ride.findMany({
        where: { riderId: userId },
        orderBy: { createdAt: 'desc' },
        take: 15,
        select: {
          id: true, status: true, pickupAddress: true, destAddress: true,
          fareEstimateNgn: true, fareFinalNgn: true, distanceKm: true,
          cancelReason: true, createdAt: true, completedAt: true, driverId: true,
        },
      }),
      user.driver
        ? prisma.ride.groupBy({
            by: ['status'],
            where: { driverId: user.driver.id },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      user.driver
        ? prisma.ride.findMany({
            where: { driverId: user.driver.id },
            orderBy: { createdAt: 'desc' },
            take: 15,
            select: {
              id: true, status: true, pickupAddress: true, destAddress: true,
              fareFinalNgn: true, platformFeeNgn: true, distanceKm: true,
              createdAt: true, completedAt: true,
            },
          })
        : Promise.resolve([]),
      walletId
        ? prisma.transaction.findMany({
            where: { walletId },
            orderBy: { createdAt: 'desc' },
            take: 25,
          })
        : Promise.resolve([]),
      walletId
        ? prisma.transaction.groupBy({
            by: ['type'],
            where: { walletId },
            _sum: { amountNgn: true },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      prisma.withdrawalRequest.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      prisma.referral.count({ where: { referrerId: userId } }),
    ]);

    const countBy = (groups: Array<{ status: string; _count: { _all: number } }>) =>
      Object.fromEntries(groups.map((g) => [g.status, g._count._all]));

    const riderCounts = countBy(rideGroups as never);
    const driverCounts = countBy(driverRideGroups as never);
    const sum = (counts: Record<string, number>) =>
      Object.values(counts).reduce((a, b) => a + b, 0);

    return {
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        email: user.email,
        phone: user.phone,
        role: user.role,
        riderKycStatus: user.riderKycStatus,
        kycVerifiedAt: user.kycVerifiedAt,
        privacyConsent: user.privacyConsent,
        privacyConsentAt: user.privacyConsentAt,
        photoUrl: user.photoUrl,
        createdAt: user.createdAt,
        referralCode: user.referralCode?.code ?? null,
        referralsMade,
      },
      wallet: user.wallet
        ? {
            id: user.wallet.id,
            balanceNgn: money(user.wallet.balanceNgn),
            lockedNgn: money(user.wallet.lockedNgn),
            byType: txnGroups.map((g) => ({
              type: g.type,
              count: g._count._all,
              totalNgn: money(g._sum.amountNgn),
            })),
          }
        : null,
      virtualAccount: user.virtualAccount
        ? {
            bankName: user.virtualAccount.bankName,
            accountNumber: user.virtualAccount.accountNumber,
            accountName: user.virtualAccount.accountName,
            status: user.virtualAccount.status,
          }
        : null,
      driver: user.driver
        ? {
            id: user.driver.id,
            status: user.driver.status,
            kycStatus: user.driver.kycStatus,
            rating: user.driver.rating,
            totalRides: user.driver.totalRides,
            totalEarningsNgn: money(user.driver.totalEarningsNgn),
            vehicleMake: user.driver.vehicleMake,
            vehicleModel: user.driver.vehicleModel,
            vehiclePlate: user.driver.vehiclePlate,
            vehicleYear: user.driver.vehicleYear,
            lastSeenAt: user.driver.lastSeenAt,
            rides: {
              total: sum(driverCounts),
              completed: driverCounts.COMPLETED ?? 0,
              cancelled: driverCounts.CANCELLED ?? 0,
              byStatus: driverCounts,
            },
          }
        : null,
      rides: {
        total: sum(riderCounts),
        completed: riderCounts.COMPLETED ?? 0,
        cancelled: riderCounts.CANCELLED ?? 0,
        active: ACTIVE_RIDE_STATUSES.reduce((n, s) => n + (riderCounts[s] ?? 0), 0),
        byStatus: riderCounts,
        totalSpentNgn: money(completedAgg._sum.fareFinalNgn),
        avgFareNgn: money(completedAgg._avg.fareFinalNgn),
        totalDistanceKm: completedAgg._sum.distanceKm ?? 0,
        avgDistanceKm: completedAgg._avg.distanceKm ?? 0,
      },
      recentRides: recentRides.map((r) => ({
        ...r,
        fareEstimateNgn: r.fareEstimateNgn ? money(r.fareEstimateNgn) : null,
        fareFinalNgn: r.fareFinalNgn ? money(r.fareFinalNgn) : null,
      })),
      driverRecentRides: driverRecentRides.map((r) => ({
        ...r,
        fareFinalNgn: r.fareFinalNgn ? money(r.fareFinalNgn) : null,
        platformFeeNgn: r.platformFeeNgn ? money(r.platformFeeNgn) : null,
      })),
      transactions: transactions.map((t) => ({
        id: t.id,
        type: t.type,
        direction: t.direction,
        amountNgn: money(t.amountNgn),
        balanceAfterNgn: money(t.balanceAfterNgn),
        referenceId: t.referenceId,
        createdAt: t.createdAt,
      })),
      withdrawals: withdrawals.map((w) => ({
        id: w.id,
        status: w.status,
        amountNgn: money(w.requestedAmountNgn),
        bankAccountNumber: w.bankAccountNumber,
        bankAccountName: w.bankAccountName,
        failureReason: w.failureReason,
        createdAt: w.createdAt,
        settledAt: w.settledAt,
      })),
    };
  },

  /**
   * The whole business in one payload: people, rides, and — from the ledger —
   * money, each with today / 7-day / 30-day windows beside the all-time figure.
   */
  overview: async () => {
    const today = startOfToday();
    const d7 = daysAgo(7);
    const d30 = daysAgo(30);

    const [users, drivers, rides, completed, moneyRows, walletAgg, withdrawalRows, pendingKyc, unmatchedRows] =
      await Promise.all([
        prisma.$queryRaw<Array<Record<string, number>>>`
          SELECT
            COUNT(*)::int                                                          AS total,
            COUNT(*) FILTER (WHERE "createdAt" >= ${today})::int                   AS today,
            COUNT(*) FILTER (WHERE "createdAt" >= ${d7})::int                      AS last7d,
            COUNT(*) FILTER (WHERE "createdAt" >= ${d30})::int                     AS last30d,
            COUNT(*) FILTER (WHERE role IN ('RIDER', 'BOTH'))::int                 AS riders,
            COUNT(*) FILTER (WHERE "riderKycStatus" = 'VERIFIED')::int             AS "kycVerified"
          FROM "User"
          WHERE id <> ${PLATFORM_USER_ID}
        `,
        prisma.$queryRaw<Array<Record<string, number>>>`
          SELECT
            COUNT(*)::int                                                AS total,
            COUNT(*) FILTER (WHERE "kycStatus" = 'APPROVED')::int        AS approved,
            COUNT(*) FILTER (WHERE status = 'ONLINE')::int               AS online,
            COUNT(*) FILTER (WHERE status = 'ON_RIDE')::int              AS "onRide",
            COUNT(*) FILTER (WHERE "createdAt" >= ${d30})::int           AS last30d
          FROM "Driver" d
          JOIN "User" u ON u.id = d."userId"
        `,
        prisma.$queryRaw<Array<Record<string, unknown>>>`
          SELECT
            status::text                                            AS status,
            COUNT(*)::int                                           AS total,
            COUNT(*) FILTER (WHERE "createdAt" >= ${today})::int    AS today,
            COUNT(*) FILTER (WHERE "createdAt" >= ${d7})::int       AS last7d,
            COUNT(*) FILTER (WHERE "createdAt" >= ${d30})::int      AS last30d
          FROM "Ride"
          GROUP BY status
        `,
        prisma.$queryRaw<Array<Record<string, string>>>`
          SELECT
            COALESCE(SUM("fareFinalNgn"), 0)::text                                              AS gross,
            COALESCE(SUM("platformFeeNgn"), 0)::text                                            AS fees,
            COALESCE(AVG("fareFinalNgn"), 0)::text                                              AS "avgFare",
            COALESCE(AVG("distanceKm"), 0)::text                                                AS "avgDistanceKm",
            COALESCE(SUM("distanceKm"), 0)::text                                                AS "totalDistanceKm",
            COALESCE(AVG("durationSeconds"), 0)::text                                           AS "avgDurationSeconds",
            COALESCE(SUM("fareFinalNgn") FILTER (WHERE "completedAt" >= ${today}), 0)::text     AS "grossToday",
            COALESCE(SUM("fareFinalNgn") FILTER (WHERE "completedAt" >= ${d7}), 0)::text        AS "gross7d",
            COALESCE(SUM("fareFinalNgn") FILTER (WHERE "completedAt" >= ${d30}), 0)::text       AS "gross30d",
            COALESCE(SUM("platformFeeNgn") FILTER (WHERE "completedAt" >= ${d30}), 0)::text     AS "fees30d",
            -- Counted on completedAt, like the revenue beside them. Counting on
            -- createdAt instead let the dashboard show money earned today next
            -- to "0 rides completed", because a ride booked last night and
            -- finished this morning fell into two different buckets.
            COUNT(*) FILTER (WHERE "completedAt" >= ${today})::int                              AS "countToday",
            COUNT(*) FILTER (WHERE "completedAt" >= ${d7})::int                                 AS "count7d",
            COUNT(*) FILTER (WHERE "completedAt" >= ${d30})::int                                AS "count30d"
          FROM "Ride"
          WHERE status = 'COMPLETED'
        `,
        prisma.$queryRaw<Array<Record<string, unknown>>>`
          SELECT
            t.type::text                                                           AS type,
            COUNT(*)::int                                                          AS count,
            COALESCE(SUM(t."amountNgn"), 0)::text                                  AS "allTime",
            COALESCE(SUM(t."amountNgn") FILTER (WHERE t."createdAt" >= ${today}), 0)::text  AS today,
            COALESCE(SUM(t."amountNgn") FILTER (WHERE t."createdAt" >= ${d7}), 0)::text     AS last7d,
            COALESCE(SUM(t."amountNgn") FILTER (WHERE t."createdAt" >= ${d30}), 0)::text    AS last30d
          FROM "Transaction" t
          GROUP BY t.type
        `,
        prisma.$queryRaw<Array<Record<string, string>>>`
          SELECT
            COALESCE(SUM("balanceNgn"), 0)::text                                    AS float,
            COALESCE(SUM("lockedNgn"), 0)::text                                     AS locked,
            COALESCE(SUM("balanceNgn") FILTER (WHERE "userId" = ${PLATFORM_USER_ID}), 0)::text AS platform
          FROM "Wallet"
        `,
        prisma.$queryRaw<Array<Record<string, unknown>>>`
          SELECT status::text AS status, COUNT(*)::int AS count,
                 COALESCE(SUM("requestedAmountNgn"), 0)::text AS "amountNgn"
          FROM "WithdrawalRequest"
          GROUP BY status
        `,
        prisma.driverKycSubmission.count({ where: { status: 'SUBMITTED' } }),
        // Requests that died before any driver took them. `driverId IS NULL` is
        // the honest test: a cancelReason is free text and cannot be counted on.
        prisma.$queryRaw<Array<Record<string, number>>>`
          SELECT
            COUNT(*)::int                                              AS total,
            COUNT(*) FILTER (WHERE "createdAt" >= ${d30})::int         AS last30d
          FROM "Ride"
          WHERE status = 'CANCELLED' AND "driverId" IS NULL
        `,
      ]);

    const rideRows = rides as Array<{
      status: string; total: number; today: number; last7d: number; last30d: number;
    }>;
    const byStatus = Object.fromEntries(rideRows.map((r) => [r.status, r.total]));
    const windowSum = (key: 'total' | 'today' | 'last7d' | 'last30d') =>
      rideRows.reduce((n, r) => n + Number(r[key]), 0);

    const totalRides = windowSum('total');
    const completedRides = byStatus.COMPLETED ?? 0;
    const activeRides = ACTIVE_RIDE_STATUSES.reduce((n, s) => n + (byStatus[s] ?? 0), 0);

    const ledger = (moneyRows as Array<Record<string, string>>).reduce(
      (acc, row) => {
        acc[row.type as string] = {
          count: Number(row.count),
          allTime: row.allTime,
          today: row.today,
          last7d: row.last7d,
          last30d: row.last30d,
        };
        return acc;
      },
      {} as Record<string, { count: number; allTime: string; today: string; last7d: string; last30d: string }>,
    );
    const zero = { count: 0, allTime: '0', today: '0', last7d: '0', last30d: '0' };
    const line = (type: string) => ledger[type] ?? zero;

    const c = (completed as Array<Record<string, string>>)[0];
    const u = (users as Array<Record<string, number>>)[0];
    const d = (drivers as Array<Record<string, number>>)[0];
    const w = (walletAgg as Array<Record<string, string>>)[0];
    const unmatched = (unmatchedRows as Array<Record<string, number>>)[0] ?? { total: 0, last30d: 0 };

    return {
      users: {
        total: Number(u.total),
        riders: Number(u.riders),
        drivers: Number(d.total),
        newToday: Number(u.today),
        new7d: Number(u.last7d),
        new30d: Number(u.last30d),
        kycVerified: Number(u.kycVerified),
      },
      drivers: {
        total: Number(d.total),
        approved: Number(d.approved),
        online: Number(d.online),
        onRide: Number(d.onRide),
        new30d: Number(d.last30d),
        pendingKyc,
      },
      rides: {
        // `attempted` and `total` are the same number, named twice on purpose:
        // "attempted" is what an operator means when they ask how many rides
        // people tried to take, completed or not.
        attempted: totalRides,
        neverMatched: Number(unmatched.total),
        neverMatched30d: Number(unmatched.last30d),
        matchRate: totalRides > 0 ? (totalRides - Number(unmatched.total)) / totalRides : 0,
        total: totalRides,
        completed: completedRides,
        cancelled: byStatus.CANCELLED ?? 0,
        disputed: byStatus.DISPUTED ?? 0,
        active: activeRides,
        byStatus,
        today: windowSum('today'),
        last7d: windowSum('last7d'),
        last30d: windowSum('last30d'),
        completedToday: Number(c.countToday),
        completed7d: Number(c.count7d),
        completed30d: Number(c.count30d),
        completionRate: totalRides > 0 ? completedRides / totalRides : 0,
        // Requests that never found a driver — the matching funnel's real leak.
        avgFareNgn: c.avgFare,
        avgDistanceKm: Number(c.avgDistanceKm),
        totalDistanceKm: Number(c.totalDistanceKm),
        avgDurationSeconds: Number(c.avgDurationSeconds),
      },
      money: {
        grossProcessedNgn: c.gross,
        grossTodayNgn: c.grossToday,
        gross7dNgn: c.gross7d,
        gross30dNgn: c.gross30d,
        platformRevenueNgn: c.fees,
        platformRevenue30dNgn: c.fees30d,
        depositsNgn: line('DEPOSIT').allTime,
        deposits30dNgn: line('DEPOSIT').last30d,
        depositCount: line('DEPOSIT').count,
        ridePaymentsNgn: line('RIDE_PAYMENT').allTime,
        driverPayoutsNgn: line('DRIVER_PAYOUT').allTime,
        driverPayouts30dNgn: line('DRIVER_PAYOUT').last30d,
        platformFeesLedgerNgn: line('PLATFORM_FEE').allTime,
        withdrawalsNgn: line('WITHDRAWAL').allTime,
        withdrawals30dNgn: line('WITHDRAWAL').last30d,
        refundsNgn: line('REFUND').allTime,
        penaltiesNgn: line('PENALTY').allTime,
        walletFloatNgn: w.float,
        walletLockedNgn: w.locked,
        platformWalletNgn: w.platform,
        byType: Object.entries(ledger).map(([type, v]) => ({ type, ...v })),
      },
      withdrawals: (withdrawalRows as Array<{ status: string; count: number; amountNgn: string }>).map(
        (row) => ({ status: row.status, count: Number(row.count), amountNgn: row.amountNgn }),
      ),
      generatedAt: new Date().toISOString(),
    };
  },

  /**
   * Group rides, told as a funnel.
   *
   * A group-ride request has to survive several steps before anyone travels:
   * take a verification selfie, become eligible for matching, actually get
   * matched with someone going the same way, then convert into a booked trip.
   * Counting only "requests" hides which of those steps is losing people —
   * and in practice the selfie is where most of them go.
   */
  groupRideMetrics: async () => {
    const today = startOfToday();
    const d7 = daysAgo(7);
    const d30 = daysAgo(30);

    const [statusRows, faceRows, groupRows, timingRows, fareRows] = await Promise.all([
      prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT
          status::text                                            AS status,
          COUNT(*)::int                                           AS total,
          COUNT(*) FILTER (WHERE "createdAt" >= ${today})::int    AS today,
          COUNT(*) FILTER (WHERE "createdAt" >= ${d7})::int       AS last7d,
          COUNT(*) FILTER (WHERE "createdAt" >= ${d30})::int      AS last30d
        FROM "GroupRideMatchRequest"
        GROUP BY status
      `,
      prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT "uploadStatus"::text AS status, COUNT(*)::int AS count
        FROM "GroupRideFaceVerification"
        GROUP BY "uploadStatus"
      `,
      // Group size comes from how many requests share a groupId — the source
      // of truth for who actually travelled together.
      prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT
          COUNT(*)::int                        AS groups,
          COALESCE(AVG(size), 0)::float        AS "avgSize",
          COALESCE(MAX(size), 0)::int          AS "maxSize",
          COALESCE(SUM(size), 0)::int          AS "ridersGrouped"
        FROM (
          SELECT "groupId", COUNT(*)::int AS size
          FROM "GroupRideMatchRequest"
          WHERE "groupId" IS NOT NULL
          GROUP BY "groupId"
        ) g
      `,
      prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT
          COALESCE(AVG(EXTRACT(EPOCH FROM ("groupedAt" - "readyForMatchAt"))), 0)::float AS "avgSecondsToGroup",
          COUNT(*)::int AS "measured"
        FROM "GroupRideMatchRequest"
        WHERE "groupedAt" IS NOT NULL AND "readyForMatchAt" IS NOT NULL
      `,
      prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT
          COALESCE(SUM("fareEstimateNgn") FILTER (WHERE status = 'BOOKED'), 0)::text AS "bookedValueNgn",
          COALESCE(AVG("fareEstimateNgn") FILTER (WHERE status = 'BOOKED'), 0)::text AS "avgSeatFareNgn"
        FROM "GroupRideMatchRequest"
      `,
    ]);

    const rows = statusRows as Array<{
      status: string; total: number; today: number; last7d: number; last30d: number;
    }>;
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, Number(r.total)]));
    const count = (status: string) => byStatus[status] ?? 0;
    const sumWindow = (key: 'total' | 'today' | 'last7d' | 'last30d') =>
      rows.reduce((n, r) => n + Number(r[key]), 0);

    const total = sumWindow('total');
    const awaitingSelfie = count('PENDING_FACE_UPLOAD');
    // Anything past the selfie step got far enough to be matchable.
    const reachedMatching =
      count('READY_FOR_MATCH') + count('MATCHING') + count('GROUPED') + count('BOOKED');
    const grouped = count('GROUPED') + count('BOOKED');
    const booked = count('BOOKED');

    const faces = Object.fromEntries(
      (faceRows as Array<{ status: string; count: number }>).map((f) => [f.status, Number(f.count)]),
    );
    const g = (groupRows as Array<Record<string, number>>)[0];
    const t = (timingRows as Array<Record<string, number>>)[0];
    const f = (fareRows as Array<Record<string, string>>)[0];

    return {
      total,
      today: sumWindow('today'),
      last7d: sumWindow('last7d'),
      last30d: sumWindow('last30d'),
      byStatus,
      /** Where people drop out, in order. */
      funnel: [
        { step: 'Requested', count: total },
        { step: 'Selfie done', count: total - awaitingSelfie },
        { step: 'Reached matching', count: reachedMatching },
        { step: 'Matched into a group', count: grouped },
        { step: 'Booked', count: booked },
      ],
      awaitingSelfie,
      expired: count('EXPIRED'),
      cancelled: count('CANCELLED'),
      matchRate: reachedMatching > 0 ? grouped / reachedMatching : 0,
      bookingRate: total > 0 ? booked / total : 0,
      selfieDropOffRate: total > 0 ? awaitingSelfie / total : 0,
      faceVerification: {
        stored: faces.STORED ?? 0,
        uploading: faces.UPLOADING ?? 0,
        failed: faces.FAILED ?? 0,
      },
      groups: {
        formed: Number(g?.groups ?? 0),
        avgSize: Number(g?.avgSize ?? 0),
        maxSize: Number(g?.maxSize ?? 0),
        ridersGrouped: Number(g?.ridersGrouped ?? 0),
      },
      avgSecondsToGroup: Number(t?.avgSecondsToGroup ?? 0),
      bookedValueNgn: f?.bookedValueNgn ?? '0',
      avgSeatFareNgn: f?.avgSeatFareNgn ?? '0',
    };
  },

  /** Daily buckets for the dashboard charts — gap-free, so lines don't lie. */
  timeseries: async (days = 30) => {
    const span = Math.min(Math.max(days, 1), 365);
    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      WITH days AS (
        SELECT generate_series(
          date_trunc('day', now()) - ((${span}::int - 1) * interval '1 day'),
          date_trunc('day', now()),
          interval '1 day'
        ) AS day
      )
      SELECT
        to_char(d.day, 'YYYY-MM-DD')            AS date,
        COALESCE(s.signups, 0)::int             AS signups,
        COALESCE(ds.signups, 0)::int            AS "driverSignups",
        COALESCE(rc.created, 0)::int            AS "ridesRequested",
        COALESCE(rk.completed, 0)::int          AS "ridesCompleted",
        COALESCE(rx.cancelled, 0)::int          AS "ridesCancelled",
        COALESCE(rk.revenue, 0)::text           AS "grossNgn",
        COALESCE(rk.fees, 0)::text              AS "platformFeesNgn",
        COALESCE(dep.deposits, 0)::text         AS "depositsNgn"
      FROM days d
      LEFT JOIN (
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*) AS signups
        FROM "User" GROUP BY 1
      ) s ON s.day = d.day
      LEFT JOIN (
        SELECT date_trunc('day', u."createdAt") AS day, COUNT(*) AS signups
        FROM "User" u JOIN "Driver" dr ON dr."userId" = u.id
        GROUP BY 1
      ) ds ON ds.day = d.day
      LEFT JOIN (
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*) AS created
        FROM "Ride" GROUP BY 1
      ) rc ON rc.day = d.day
      LEFT JOIN (
        SELECT date_trunc('day', "completedAt") AS day,
               COUNT(*) AS completed,
               SUM("fareFinalNgn") AS revenue,
               SUM("platformFeeNgn") AS fees
        FROM "Ride"
        WHERE status = 'COMPLETED' AND "completedAt" IS NOT NULL
        GROUP BY 1
      ) rk ON rk.day = d.day
      LEFT JOIN (
        SELECT date_trunc('day', "cancelledAt") AS day, COUNT(*) AS cancelled
        FROM "Ride"
        WHERE status = 'CANCELLED' AND "cancelledAt" IS NOT NULL
        GROUP BY 1
      ) rx ON rx.day = d.day
      LEFT JOIN (
        SELECT date_trunc('day', "createdAt") AS day, SUM("amountNgn") AS deposits
        FROM "Transaction" WHERE type = 'DEPOSIT' GROUP BY 1
      ) dep ON dep.day = d.day
      ORDER BY d.day ASC
    `;

    return rows.map((row) => ({
      date: row.date as string,
      signups: Number(row.signups),
      driverSignups: Number(row.driverSignups),
      ridesRequested: Number(row.ridesRequested),
      ridesCompleted: Number(row.ridesCompleted),
      ridesCancelled: Number(row.ridesCancelled),
      grossNgn: row.grossNgn as string,
      platformFeesNgn: row.platformFeesNgn as string,
      depositsNgn: row.depositsNgn as string,
    }));
  },

  /**
   * Why requests fail. `cancelReason` is free text written by whoever cancelled,
   * so this is grouped as-is rather than bucketed into invented categories.
   */
  cancellationBreakdown: async () => {
    const rows = await prisma.ride.groupBy({
      by: ['cancelReason'],
      where: { status: 'CANCELLED' },
      _count: { _all: true },
      orderBy: { _count: { id: 'desc' } },
      take: 15,
    });
    return rows.map((r) => ({
      reason: r.cancelReason ?? 'Unknown',
      count: r._count._all,
    }));
  },

  /** The rides table: filterable and paged, unlike the old fixed top-20. */
  listRides: async (options: {
    status?: string;
    q?: string;
    limit?: number;
    offset?: number;
  } = {}) => {
    const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
    const offset = Math.max(options.offset ?? 0, 0);
    const q = options.q?.trim();

    // `live` is every status where somebody is mid-journey right now: a rider
    // waiting on bids, a driver on the way, a trip under way. An operator
    // asking "who is out there at this moment" wants all of them in one list,
    // not one status at a time.
    const statusFilter: Prisma.RideWhereInput =
      !options.status || options.status === 'all'
        ? {}
        : options.status === 'live'
          ? { status: { in: [...ACTIVE_RIDE_STATUSES] as Prisma.EnumRideStatusFilter['in'] } }
          : { status: options.status as Prisma.EnumRideStatusFilter['equals'] };

    const where: Prisma.RideWhereInput = {
      ...statusFilter,
      ...(q
        ? {
            OR: [
              { pickupAddress: { contains: q, mode: 'insensitive' } },
              { destAddress: { contains: q, mode: 'insensitive' } },
              { id: q },
              { riderId: q },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.ride.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        select: {
          id: true, riderId: true, driverId: true, status: true,
          pickupAddress: true, destAddress: true,
          fareEstimateNgn: true, fareFinalNgn: true, platformFeeNgn: true,
          distanceKm: true, durationSeconds: true, cancelReason: true,
          createdAt: true, completedAt: true, cancelledAt: true,
          driver: { select: { id: true, user: { select: { name: true } } } },
        },
      }),
      prisma.ride.count({ where }),
    ]);

    // One lookup for every rider on the page, so the table shows people.
    const riderIds = [...new Set(rows.map((r) => r.riderId))];
    const riders = riderIds.length
      ? await prisma.user.findMany({
          where: { id: { in: riderIds } },
          select: { id: true, name: true, phone: true },
        })
      : [];
    const riderById = new Map(riders.map((r) => [r.id, r]));

    return {
      items: rows.map((r) => ({
        id: r.id,
        status: r.status,
        riderId: r.riderId,
        riderName: riderById.get(r.riderId)?.name ?? null,
        riderPhone: riderById.get(r.riderId)?.phone ?? null,
        driverId: r.driverId,
        driverName: r.driver?.user.name ?? null,
        pickupAddress: r.pickupAddress,
        destAddress: r.destAddress,
        fareEstimateNgn: r.fareEstimateNgn ? money(r.fareEstimateNgn) : null,
        fareFinalNgn: r.fareFinalNgn ? money(r.fareFinalNgn) : null,
        platformFeeNgn: r.platformFeeNgn ? money(r.platformFeeNgn) : null,
        distanceKm: r.distanceKm,
        durationSeconds: r.durationSeconds,
        cancelReason: r.cancelReason,
        createdAt: r.createdAt,
        completedAt: r.completedAt,
        cancelledAt: r.cancelledAt,
      })),
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
    };
  },
};
