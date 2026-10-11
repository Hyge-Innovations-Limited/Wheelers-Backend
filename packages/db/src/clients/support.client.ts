import { prisma } from '../prisma';

const LIVE_TRIP = ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'] as const;
const preview = (content: string) => (content.length > 140 ? `${content.slice(0, 139)}…` : content);

/** People's chats with Wheelers support, and the admin's inbox of them. */
export const supportClient = {
  /** The conversation a person is in now, or the last one they had. */
  currentFor: (userId: string) =>
    prisma.supportConversation.findFirst({ where: { userId }, orderBy: [{ status: 'asc' }, { lastMessageAt: 'desc' }] }),

  find: (id: string) =>
    prisma.supportConversation.findUnique({ where: { id }, include: { user: { select: { id: true, name: true, phone: true, email: true, role: true } } } }),

  messages: (conversationId: string, limit = 300) =>
    prisma.supportMessage.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' }, take: limit }),

  /** How many messages a person sent in the last `withinMs`: what the send limit counts. */
  sentRecently: (userId: string, withinMs: number) =>
    prisma.supportMessage.count({ where: { sender: 'USER', createdAt: { gte: new Date(Date.now() - withinMs) }, conversation: { userId } } }),

  /** The trip a person is on right now, as rider or as driver. */
  liveRideOf: async (userId: string) => {
    const ride = await prisma.ride.findFirst({
      where: { status: { in: [...LIVE_TRIP] }, OR: [{ riderId: userId }, { driver: { userId } }] },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return ride?.id ?? null;
  },

  /** Is this person the rider or the driver of this ride? */
  isOnRide: async (userId: string, rideId: string) =>
    (await prisma.ride.count({ where: { id: rideId, OR: [{ riderId: userId }, { driver: { userId } }] } })) > 0,

  /**
   * A message from the person. It goes into their open conversation; when
   * there is none (first time, or the last was resolved) a new one starts.
   */
  userSend: (input: { userId: string; content: string; rideId: string | null; topic: string | null }) =>
    prisma.$transaction(async (tx) => {
      const open = await tx.supportConversation.findFirst({ where: { userId: input.userId, status: 'OPEN' }, orderBy: { lastMessageAt: 'desc' } });
      const now = new Date();
      const conversation = open
        ? await tx.supportConversation.update({
          where: { id: open.id },
          data: { lastMessageAt: now, lastMessagePreview: preview(input.content), unreadForSupport: { increment: 1 }, rideId: open.rideId ?? input.rideId, topic: open.topic ?? input.topic },
        })
        : await tx.supportConversation.create({
          data: { userId: input.userId, rideId: input.rideId, topic: input.topic, lastMessageAt: now, lastMessagePreview: preview(input.content), unreadForSupport: 1 },
        });
      const message = await tx.supportMessage.create({ data: { conversationId: conversation.id, sender: 'USER', content: input.content, createdAt: now } });
      return { conversation, message, started: !open };
    }),

  /** A reply from support. The first admin to answer is the one it is assigned to. */
  supportSend: (input: { conversationId: string; content: string; adminId: string | null; adminName: string }) =>
    prisma.$transaction(async (tx) => {
      const now = new Date();
      const current = await tx.supportConversation.findUniqueOrThrow({ where: { id: input.conversationId } });
      const message = await tx.supportMessage.create({ data: { conversationId: current.id, sender: 'SUPPORT', senderName: input.adminName, content: input.content, createdAt: now } });
      const conversation = await tx.supportConversation.update({
        where: { id: current.id },
        data: {
          lastMessageAt: now, lastMessagePreview: preview(input.content), unreadForUser: { increment: 1 }, unreadForSupport: 0,
          // Answering a resolved chat opens it again: the person will reply here.
          status: 'OPEN', resolvedAt: null,
          ...(current.assignedAdminName ? {} : { assignedAdminId: input.adminId, assignedAdminName: input.adminName }),
        },
      });
      return { conversation, message };
    }),

  readByUser: (conversationId: string) =>
    prisma.supportConversation.updateMany({ where: { id: conversationId, unreadForUser: { gt: 0 } }, data: { unreadForUser: 0 } }),

  readBySupport: (conversationId: string) =>
    prisma.supportConversation.updateMany({ where: { id: conversationId, unreadForSupport: { gt: 0 } }, data: { unreadForSupport: 0 } }),

  assign: (conversationId: string, admin: { id: string | null; name: string }) =>
    prisma.supportConversation.update({ where: { id: conversationId }, data: { assignedAdminId: admin.id, assignedAdminName: admin.name } }),

  resolve: (conversationId: string) =>
    prisma.supportConversation.update({ where: { id: conversationId }, data: { status: 'RESOLVED', resolvedAt: new Date(), unreadForSupport: 0 } }),

  /** The inbox: waiting-for-an-answer first, then the most recent. */
  list: (status: 'OPEN' | 'RESOLVED', limit = 100) =>
    prisma.supportConversation.findMany({
      where: { status },
      orderBy: status === 'OPEN' ? [{ unreadForSupport: 'desc' }, { lastMessageAt: 'desc' }] : [{ resolvedAt: 'desc' }],
      take: limit,
      include: { user: { select: { id: true, name: true, phone: true, role: true } } },
    }),

  counts: async () => {
    const [open, waiting] = await Promise.all([
      prisma.supportConversation.count({ where: { status: 'OPEN' } }),
      prisma.supportConversation.count({ where: { status: 'OPEN', unreadForSupport: { gt: 0 } } }),
    ]);
    return { open, waiting };
  },

  /** Which of these rides are live right now: the inbox marks those conversations. */
  liveRideIds: async (rideIds: string[]) => {
    if (rideIds.length === 0) return new Set<string>();
    const rows = await prisma.ride.findMany({ where: { id: { in: rideIds }, status: { in: [...LIVE_TRIP] } }, select: { id: true } });
    return new Set(rows.map((row) => row.id));
  },

  /** What support needs to know about the trip a conversation is about. */
  rideSummary: async (rideId: string) => {
    const ride = await prisma.ride.findUnique({
      where: { id: rideId },
      select: {
        id: true, riderId: true, status: true, pickupAddress: true, destAddress: true, fareEstimateNgn: true, agreedFareNgn: true, startedAt: true, createdAt: true,
        driver: { select: { vehicleMake: true, vehicleModel: true, vehiclePlate: true, user: { select: { name: true, phone: true } } } },
      },
    });
    if (!ride) return null;
    const rider = await prisma.user.findUnique({ where: { id: ride.riderId }, select: { name: true, phone: true } });
    return { ...ride, rider };
  },
};
