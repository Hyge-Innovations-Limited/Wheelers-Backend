import { prisma }  from '../prisma';
import type { DisputeStatus, DisputeResolution } from '@prisma/client';

export const complianceClient = {

  // ── Disputes ───────────────────────────────────────────────────────────────

  createDispute: (data: {
    id:            string;   // UUID from the DISPUTE_OPENED Kafka event
    rideId:        string;
    openedBy:      string;
    openedByRole:  string;
    againstId:     string;
    reason:        string;
  }) =>
    prisma.dispute.create({ data }),

  findDisputeById: (disputeId: string) =>
    prisma.dispute.findUniqueOrThrow({ where: { id: disputeId } }),

  findDisputeByRide: (rideId: string) =>
    prisma.dispute.findFirst({ where: { rideId } }),

  findOpenDisputes: () =>
    prisma.dispute.findMany({
      where:   { status: { in: ['OPEN', 'REVIEWING'] } },
      orderBy: { createdAt: 'asc' },
      include: { ride: true },
    }),

  updateDisputeStatus: (disputeId: string, status: DisputeStatus) =>
    prisma.dispute.update({
      where: { id: disputeId },
      data:  { status },
    }),

  resolveDispute: (disputeId: string, data: {
    resolution:  DisputeResolution;
    resolvedBy:  string;
    notes?:      string;
    refundNgn?:  number;
    bonusNgn?:   number;
  }) =>
    prisma.dispute.update({
      where: { id: disputeId },
      data: {
        ...data,
        status:     'RESOLVED',
        resolvedAt: new Date(),
      },
    }),

  // ── Feedback ───────────────────────────────────────────────────────────────

  createFeedback: (data: {
    id:             string;
    rideId:         string;
    reviewerId:     string;
    reviewerRole:   string;
    revieweeId:     string;
    rating:         number;
    comment?:       string;
  }) =>
    prisma.feedback.create({ data }),

  findFeedbackForRide: (rideId: string) =>
    prisma.feedback.findMany({ where: { rideId } }),

  /**
   * Persist one rating and refresh the reviewee's aggregate. Ratings were
   * decorative before this: FEEDBACK_LOGGED had no consumer, and the old
   * recalculation filtered by the wrong id, so every driver sat at 5.0
   * forever and riders had no rating at all.
   *
   * revieweeId is always a USER id. If that user has a Driver row, the
   * feedback updates their driver rating; otherwise their rider rating.
   * Duplicate (rideId, reviewer) pairs are absorbed — one ride, one vote.
   */
  recordFeedbackAndAggregate: async (data: {
    id: string;
    rideId: string;
    reviewerId: string;
    reviewerRole: string;
    revieweeId: string;
    rating: number;
    comment?: string;
  }): Promise<{ applied: boolean; average: number; count: number } | null> => {
    try {
      await prisma.feedback.create({ data });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'P2002') throw error;
      return null; // this reviewer already rated this ride
    }

    const aggregate = await prisma.feedback.aggregate({
      where: { revieweeId: data.revieweeId },
      _avg: { rating: true },
      _count: { rating: true },
    });
    const average = aggregate._avg.rating ?? data.rating;
    const count = aggregate._count.rating;

    const driver = await prisma.driver.findUnique({ where: { userId: data.revieweeId } });
    // The event says 'rider' (its schema allows only 'rider' | 'driver'). This
    // compared with 'RIDER', never matched, and a rider's rating of their
    // driver went to the driver's rider rating instead: no driver's rating
    // ever moved. scripts/recompute-ratings.mjs repairs what was stored.
    if (driver && String(data.reviewerRole).toLowerCase() === 'rider') {
      await prisma.driver.update({
        where: { id: driver.id },
        data: { rating: average, ratingCount: count },
      });
    } else {
      await prisma.user.update({
        where: { id: data.revieweeId },
        data: { riderRating: average, riderRatingCount: count },
      });
    }
    return { applied: true, average, count };
  },

  // ── Notifications ──────────────────────────────────────────────────────────

  createNotification: (data: {
    userId:        string;
    title:         string;
    body:          string;
    category:      string;
    referenceId?:  string;
    referenceType?: string;
  }) =>
    prisma.notification.create({ data: data as Parameters<typeof prisma.notification.create>[0]['data'] }),

  markNotificationsRead: (userId: string, notificationIds: string[]) =>
    prisma.notification.updateMany({
      where: { userId, id: { in: notificationIds } },
      data:  { read: true },
    }),

  markAllNotificationsRead: (userId: string) =>
    prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    }),

  findUnreadNotifications: (userId: string, limit = 20) =>
    prisma.notification.findMany({
      where:   { userId, read: false },
      orderBy: { createdAt: 'desc' },
      take:    limit,
    }),

  listNotifications: (userId: string, limit = 50) =>
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
};
