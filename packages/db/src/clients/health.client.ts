import { prisma } from '../prisma';

/** The database's side of the admin Health page: is it answering, and is the event outbox draining. */
export const healthClient = {
  /** One round trip, nothing read. */
  ping: async (): Promise<void> => {
    await prisma.$queryRaw`SELECT 1`;
  },

  /** Events waiting to reach Kafka: how many, and how long the oldest has waited. */
  outboxBacklog: async (): Promise<{ pending: number; oldestCreatedAt: Date | null }> => {
    const [pending, oldest] = await Promise.all([
      prisma.outboxEvent.count({ where: { publishedAt: null } }),
      prisma.outboxEvent.findFirst({ where: { publishedAt: null }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    ]);
    return { pending, oldestCreatedAt: oldest?.createdAt ?? null };
  },
};
