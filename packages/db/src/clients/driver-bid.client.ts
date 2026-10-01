import { prisma } from '../prisma';
import type { DriverBidStatus } from '@prisma/client';

/**
 * Durable record of driver bids. ride-service keeps the live auction in
 * memory and forgets it the moment a ride is matched, so this is the only
 * place a driver can look back at what they offered and how it went.
 *
 * One row per (ride, driver): a re-bid on the same request — after the rider
 * counters, say — replaces the amount rather than adding a second entry, so
 * the history reads "you bid ₦6,000 on this trip", not three near-duplicates.
 */
export const driverBidClient = {
  record: (input: {
    rideId: string;
    driverId: string;
    driverUserId: string;
    riderId: string;
    amountNgn: number;
    etaSeconds: number;
    distanceKm?: number;
  }) =>
    prisma.driverBid.upsert({
      where: { rideId_driverId: { rideId: input.rideId, driverId: input.driverId } },
      create: {
        rideId: input.rideId,
        driverId: input.driverId,
        driverUserId: input.driverUserId,
        riderId: input.riderId,
        amountNgn: input.amountNgn,
        etaSeconds: input.etaSeconds,
        distanceKm: input.distanceKm ?? null,
      },
      update: {
        amountNgn: input.amountNgn,
        etaSeconds: input.etaSeconds,
        distanceKm: input.distanceKm ?? null,
        status: 'PENDING',
        resolvedAt: null,
      },
    }),

  /**
   * The rider picked this driver: their bid won, every other open bid lost.
   * Open includes DECLINED — a declined driver is still in the search (their
   * card is live, red) until the ride goes, so it ends for them too.
   */
  markAccepted: (rideId: string, driverId: string) => {
    const now = new Date();
    return prisma.$transaction([
      prisma.driverBid.updateMany({
        where: { rideId, driverId },
        data: { status: 'ACCEPTED', resolvedAt: now },
      }),
      prisma.driverBid.updateMany({
        where: { rideId, driverId: { not: driverId }, status: { in: ['PENDING', 'DECLINED'] } },
        data: { status: 'LOST', resolvedAt: now },
      }),
    ]);
  },

  /**
   * The trip itself was cancelled after a driver was chosen (by them, by the
   * rider, by the system). Their bid stops reading ACCEPTED: the driver app
   * rebuilds cards from these rows, and an ACCEPTED one came back as a green
   * "Starting your trip…" for a trip that no longer exists.
   */
  cancelAccepted: (rideId: string) =>
    prisma.driverBid.updateMany({
      where: { rideId, status: 'ACCEPTED' },
      data: { status: 'CANCELLED', resolvedAt: new Date() },
    }),

  /** The auction ended with nobody chosen — timeout or cancellation. */
  resolvePending: (rideId: string, status: Extract<DriverBidStatus, 'EXPIRED' | 'CANCELLED'>) =>
    prisma.driverBid.updateMany({
      // DECLINED bids are still open (the driver can bid again): they end with the search too.
      where: { rideId, status: { in: ['PENDING', 'DECLINED'] } },
      data: { status, resolvedAt: new Date() },
    }),

  /**
   * The rider declined every open offer (the search goes on). Answers which
   * drivers to tell.
   */
  declineOpen: async (rideId: string): Promise<Array<{ driverId: string; driverUserId: string }>> => {
    const open = await prisma.driverBid.findMany({
      where: { rideId, status: 'PENDING' },
      select: { driverId: true, driverUserId: true },
    });
    if (open.length === 0) return [];
    await prisma.driverBid.updateMany({
      where: { rideId, status: 'PENDING', driverId: { in: open.map((bid) => bid.driverId) } },
      data: { status: 'DECLINED', resolvedAt: new Date() },
    });
    return open;
  },

  /** The driver took their own bid back before the rider answered. */
  markWithdrawn: (rideId: string, driverId: string) =>
    prisma.driverBid.updateMany({
      where: { rideId, driverId, status: 'PENDING' },
      data: { status: 'WITHDRAWN', resolvedAt: new Date() },
    }),

  findForDriver: (driverId: string, limit = 20, cursor?: string) =>
    prisma.driverBid.findMany({
      where: { driverId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        ride: {
          select: {
            status: true,
            pickupAddress: true,
            destAddress: true,
            fareEstimateNgn: true,
            riderOfferNgn: true,
            agreedFareNgn: true,
            distanceKm: true,
            matchedAt: true,
            completedAt: true,
            cancelledAt: true,
          },
        },
      },
    }),

  findById: (bidId: string) =>
    prisma.driverBid.findUnique({ where: { id: bidId } }),

  findPendingByDriverUser: (driverUserId: string) =>
    prisma.driverBid.findMany({
      where: { driverUserId, status: 'PENDING' },
      select: { id: true, rideId: true, riderId: true, driverId: true },
    }),

  /**
   * A driver who just won a ride — or went dark — is off the market: every
   * other open bid of theirs is withdrawn so no second rider can pay for a
   * driver who no longer exists to take them. Returns the affected bids so
   * callers can tell each rider.
   */
  withdrawAllPendingForDriver: async (
    driverUserId: string,
    exceptRideId?: string,
  ) => {
    const affected = await prisma.driverBid.findMany({
      where: {
        driverUserId,
        status: 'PENDING',
        ...(exceptRideId ? { rideId: { not: exceptRideId } } : {}),
      },
      select: { id: true, rideId: true, riderId: true, driverId: true },
    });
    if (affected.length === 0) return affected;
    await prisma.driverBid.updateMany({
      where: { id: { in: affected.map((bid) => bid.id) } },
      data: { status: 'WITHDRAWN', resolvedAt: new Date() },
    });
    return affected;
  },

  findByRide: (rideId: string) =>
    prisma.driverBid.findMany({
      where: { rideId },
      orderBy: { createdAt: 'asc' },
    }),
};
