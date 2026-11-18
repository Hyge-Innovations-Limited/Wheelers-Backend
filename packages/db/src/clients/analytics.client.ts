import { prisma } from '../prisma';
import { NOT_GROUP_TRIP } from './group-trip.client';

export const analyticsClient = {
  /** High-level platform stats */
  platformStats: async () => {
    const [
      totalRiders,
      totalDrivers,
      approvedDrivers,
      onlineDrivers,
      totalRides,
      completedRides,
      cancelledRides,
      activeRides,
      revenueAgg,
      platformFeeAgg,
      totalUsers,
    ] = await Promise.all([
      prisma.user.count({ where: { role: { in: ['RIDER', 'BOTH'] } } }),
      prisma.driver.count(),
      prisma.driver.count({ where: { kycStatus: 'APPROVED' } }),
      prisma.driver.count({ where: { status: 'ONLINE' } }),
      prisma.ride.count({ where: NOT_GROUP_TRIP }),
      prisma.ride.count({ where: { status: 'COMPLETED', ...NOT_GROUP_TRIP } }),
      prisma.ride.count({ where: { status: 'CANCELLED', ...NOT_GROUP_TRIP } }),
      prisma.ride.count({ where: { status: { in: ['REQUESTED', 'MATCHING', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'] }, ...NOT_GROUP_TRIP } }),
      prisma.ride.aggregate({ where: { status: 'COMPLETED', ...NOT_GROUP_TRIP }, _sum: { fareFinalNgn: true } }),
      prisma.ride.aggregate({ where: { status: 'COMPLETED', ...NOT_GROUP_TRIP }, _sum: { platformFeeNgn: true } }),
      prisma.user.count(),
    ]);

    return {
      totalUsers,
      totalRiders,
      totalDrivers,
      approvedDrivers,
      onlineDrivers,
      totalRides,
      completedRides,
      cancelledRides,
      activeRides,
      totalRevenueNgn: revenueAgg._sum.fareFinalNgn?.toString() ?? '0',
      platformFeesNgn: platformFeeAgg._sum.platformFeeNgn?.toString() ?? '0',
    };
  },

  /** Driver-focused analytics */
  driverAnalytics: async () => {
    const [
      totalDrivers,
      byKycStatus,
      byStatus,
      topDrivers,
      pendingKyc,
    ] = await Promise.all([
      prisma.driver.count(),
      prisma.driver.groupBy({
        by: ['kycStatus'],
        _count: true,
      }),
      prisma.driver.groupBy({
        by: ['status'],
        _count: true,
      }),
      prisma.driver.findMany({
        orderBy: { totalRides: 'desc' },
        take: 10,
        include: { user: { select: { name: true, phone: true, email: true } } },
      }),
      prisma.driverKycSubmission.count({ where: { status: 'SUBMITTED' } }),
    ]);

    return {
      totalDrivers,
      pendingKyc,
      byKycStatus: byKycStatus.map((g) => ({ status: g.kycStatus, count: g._count })),
      byStatus: byStatus.map((g) => ({ status: g.status, count: g._count })),
      topDrivers: topDrivers.map((d) => ({
        driverId: d.id,
        name: d.user.name,
        phone: d.user.phone,
        email: d.user.email,
        totalRides: d.totalRides,
        totalEarningsNgn: d.totalEarningsNgn.toString(),
        rating: d.rating,
        kycStatus: d.kycStatus,
        status: d.status,
      })),
    };
  },

  /** Rider-focused analytics */
  riderAnalytics: async () => {
    const [
      totalRiders,
      ridersWithRides,
      topRiders,
      ridesByStatus,
    ] = await Promise.all([
      prisma.user.count({ where: { role: { in: ['RIDER', 'BOTH'] } } }),
      prisma.ride.groupBy({
        by: ['riderId'],
        where: NOT_GROUP_TRIP,
        _count: true,
      }).then((g) => g.length),
      prisma.$queryRaw<Array<{
        riderId: string;
        name: string | null;
        phone: string | null;
        email: string | null;
        rideCount: bigint;
        totalSpentNgn: string | null;
      }>>`
        SELECT
          r."riderId",
          u."name",
          u."phone",
          u."email",
          COUNT(r.id)::bigint AS "rideCount",
          COALESCE(SUM(r."fareFinalNgn"), 0)::text AS "totalSpentNgn"
        FROM "Ride" r
        JOIN "User" u ON u.id = r."riderId"
        WHERE r.status = 'COMPLETED' AND r."groupRole" IS DISTINCT FROM 'TRIP'
        GROUP BY r."riderId", u."name", u."phone", u."email"
        ORDER BY "rideCount" DESC
        LIMIT 10
      `,
      prisma.ride.groupBy({
        by: ['status'],
        where: NOT_GROUP_TRIP,
        _count: true,
      }),
    ]);

    return {
      totalRiders,
      ridersWithRides,
      ridesByStatus: ridesByStatus.map((g) => ({ status: g.status, count: g._count })),
      topRiders: topRiders.map((r) => ({
        riderId: r.riderId,
        name: r.name,
        phone: r.phone,
        email: r.email,
        rideCount: Number(r.rideCount),
        totalSpentNgn: r.totalSpentNgn ?? '0',
      })),
    };
  },

  /** Recent rides for admin view */
  recentRides: (limit = 20) =>
    prisma.ride.findMany({
      where: NOT_GROUP_TRIP,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        riderId: true,
        driverId: true,
        status: true,
        pickupAddress: true,
        destAddress: true,
        fareEstimateNgn: true,
        fareFinalNgn: true,
        platformFeeNgn: true,
        distanceKm: true,
        createdAt: true,
        completedAt: true,
      },
    }),
};
