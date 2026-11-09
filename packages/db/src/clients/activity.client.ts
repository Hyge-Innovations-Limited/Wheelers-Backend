import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

export type ActivityEventInput = {
  userId: string;
  eventType: string;
  source: string;
  rideId?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Kafka rows: "{topic}:{partition}:{offset}". Omit for synchronous rows. */
  dedupKey?: string;
  occurredAt?: Date;
};

function toCreateData(input: ActivityEventInput) {
  return {
    userId: input.userId,
    eventType: input.eventType,
    source: input.source,
    rideId: input.rideId ?? null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    metadata: (input.metadata ?? undefined) as any,
    dedupKey: input.dedupKey ?? randomUUID(),
    occurredAt: input.occurredAt ?? new Date(),
  };
}

export const activityClient = {
  /** Idempotent single insert — a replayed dedupKey is silently a no-op. */
  record: async (input: ActivityEventInput) => {
    try {
      return await prisma.userActivityEvent.create({ data: toCreateData(input) });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return null; // duplicate delivery — already recorded
      }
      throw error;
    }
  },

  /** Buffered flush for the Kafka sink. skipDuplicates keeps replays safe. */
  recordMany: async (inputs: ActivityEventInput[]) => {
    if (inputs.length === 0) return { count: 0 };
    return prisma.userActivityEvent.createMany({
      data: inputs.map(toCreateData),
      skipDuplicates: true,
    });
  },

  /** Latest activity across ALL users — the admin dashboard's live feed. */
  listRecent: async (limit = 50) =>
    prisma.userActivityEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
    }),

  /**
   * A page of activity for the admin Activity page, newest first: only the
   * given event types when named, only one person when named, and older than
   * `before` when paging back.
   */
  listPage: async (options: {
    eventTypes?: string[];
    /** Left out, whatever else is asked for: the bot probes, on a page about people. */
    exceptTypes?: string[];
    userId?: string;
    before?: Date;
    /** The earliest moment wanted (a date range's start). */
    after?: Date;
    limit?: number;
  }) => {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const rows = await prisma.userActivityEvent.findMany({
      where: {
        ...(options.eventTypes?.length
          ? { eventType: { in: options.eventTypes } }
          : options.exceptTypes?.length
            ? { eventType: { notIn: options.exceptTypes } }
            : {}),
        ...(options.userId ? { userId: options.userId } : {}),
        ...(options.before || options.after
          ? { createdAt: { ...(options.before ? { lt: options.before } : {}), ...(options.after ? { gte: options.after } : {}) } }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });
    return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
  },

  /** Every row of one event type since a cutoff, capped: the Activity page counts problems from these. */
  listSince: async (eventType: string, since: Date, cap = 2000, until?: Date) =>
    prisma.userActivityEvent.findMany({
      where: { eventType, createdAt: { gte: since, ...(until ? { lt: until } : {}) } },
      orderBy: { createdAt: 'desc' },
      take: cap,
      select: { userId: true, metadata: true, createdAt: true },
    }),

  /** Event counts by type since a cutoff — the dashboard's 24h pulse. */
  countsByType: async (since: Date) => {
    const rows = await prisma.userActivityEvent.groupBy({
      by: ['eventType'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      orderBy: { _count: { id: 'desc' } },
      take: 30,
    });
    return rows.map((row) => ({ eventType: row.eventType, count: row._count._all }));
  },

  listByUser: async (
    userId: string,
    options?: { limit?: number; cursor?: string; eventType?: string },
  ) => {
    const limit = Math.min(options?.limit ?? 50, 200);
    const items = await prisma.userActivityEvent.findMany({
      where: {
        userId,
        ...(options?.eventType ? { eventType: options.eventType } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(options?.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    return {
      items: page,
      nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
    };
  },
};
