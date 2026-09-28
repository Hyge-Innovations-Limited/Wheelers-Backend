import { prisma } from '../prisma';
import type { ChatSenderRole } from '@prisma/client';

/** "text": typed by the rider or driver. "call": a line the call service writes when a call ends. */
export type ChatMessageKind = 'text' | 'call';

export const chatClient = {
  async create(params: {
    rideId: string;
    senderId: string;
    senderRole: ChatSenderRole;
    content: string;
    kind?: ChatMessageKind;
  }) {
    return prisma.chatMessage.create({
      data: {
        rideId: params.rideId,
        senderId: params.senderId,
        senderRole: params.senderRole,
        content: params.content,
        kind: params.kind ?? 'text',
      },
    });
  },

  async findByRideId(params: {
    rideId: string;
    limit?: number;
    cursor?: string;
  }) {
    const take = params.limit ?? 50;
    const where = { rideId: params.rideId };

    const messages = await prisma.chatMessage.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take,
      ...(params.cursor
        ? { cursor: { id: params.cursor }, skip: 1 }
        : {}),
    });

    const nextCursor = messages.length === take ? messages[messages.length - 1].id : null;

    return { items: messages, nextCursor };
  },

  /**
   * Everything the trip chat needs to decide who may talk on a ride, and to
   * name them: the ride's state and times, the rider, the driver. Null when
   * there is no such ride.
   */
  async tripParties(rideId: string) {
    const ride = await prisma.ride.findUnique({
      where: { id: rideId },
      select: {
        id: true, tripNumber: true, status: true, channel: true, riderId: true, driverId: true,
        completedAt: true, cancelledAt: true, updatedAt: true,
        driver: { select: { id: true, userId: true, vehicleMake: true, vehicleModel: true, vehiclePlate: true, user: { select: { id: true, name: true, phone: true } } } },
      },
    });
    if (!ride) return null;
    const rider = await prisma.user.findUnique({ where: { id: ride.riderId }, select: { id: true, name: true, phone: true } });
    return { ...ride, rider };
  },

  /** The rider's most recent ride that had a driver: the one a "chat with my driver" means. */
  async latestTripOfRider(riderId: string) {
    return prisma.ride.findFirst({
      where: { riderId, driverId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
  },

  /** The latest `limit` lines of a trip's chat, oldest first: what a chat screen opens on. */
  async latestForRide(rideId: string, limit = 100) {
    const newestFirst = await prisma.chatMessage.findMany({
      where: { rideId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return newestFirst.reverse();
  },
};
