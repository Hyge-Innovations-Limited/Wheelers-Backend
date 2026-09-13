import { prisma } from '../prisma';

export type MemoryRole = 'user' | 'assistant';

export interface MemoryFactInput {
  predicate: string;
  object: string;
  source?: string;
}

/**
 * Rider memory: the durable WhatsApp transcript plus the facts distilled from
 * it. Everything here is per user; nothing crosses accounts.
 */
export const memoryClient = {
  appendMessages: (userId: string, messages: Array<{ role: MemoryRole; content: string }>) =>
    prisma.whatsappMessage.createMany({
      data: messages.map((m) => ({ userId, role: m.role, content: m.content.slice(0, 2_000) })),
    }),

  /** Newest `limit` turns, returned oldest-first so they read as a conversation. */
  recentMessages: async (userId: string, limit = 24) => {
    const rows = await prisma.whatsappMessage.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { role: true, content: true, createdAt: true },
    });
    return rows.reverse();
  },

  /** Upsert an edge; seeing it again raises its weight. */
  upsertFacts: async (userId: string, facts: MemoryFactInput[]) => {
    for (const fact of facts) {
      const predicate = fact.predicate.trim().toLowerCase().slice(0, 64);
      const object = fact.object.trim().slice(0, 300);
      if (!predicate || !object) continue;
      await prisma.userMemoryFact.upsert({
        where: { userId_predicate_object: { userId, predicate, object } },
        create: { userId, predicate, object, source: fact.source ?? 'llm' },
        update: { weight: { increment: 1 }, lastSeenAt: new Date() },
      });
    }
  },

  listFacts: (userId: string) =>
    prisma.userMemoryFact.findMany({
      where: { userId },
      orderBy: [{ weight: 'desc' }, { lastSeenAt: 'desc' }],
      select: { predicate: true, object: true, weight: true, lastSeenAt: true, source: true },
    }),

  forgetFact: (userId: string, predicate: string, object?: string) =>
    prisma.userMemoryFact.deleteMany({
      where: { userId, predicate, ...(object ? { object } : {}) },
    }),

  /** The rider's recent trips — the most reliable memory there is. */
  recentRides: (userId: string, limit = 8) =>
    prisma.ride.findMany({
      where: { riderId: userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        status: true,
        pickupAddress: true,
        destAddress: true,
        riderOfferNgn: true,
        agreedFareNgn: true,
        fareFinalNgn: true,
        paymentMethod: true,
        distanceKm: true,
        createdAt: true,
        completedAt: true,
      },
    }),
};
