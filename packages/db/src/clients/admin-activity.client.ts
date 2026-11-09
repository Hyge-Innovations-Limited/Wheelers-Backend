import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

/** What admins did in the dashboard: the owners' Team activity page. */
export interface AdminActivityInput {
  adminId: string | null;
  adminName: string;
  kind: string;
  page?: string | null;
  detail?: Record<string, unknown> | null;
  flagged?: boolean;
  ip?: string | null;
}

export const adminActivityClient = {
  record: (input: AdminActivityInput) =>
    prisma.adminActivity.create({
      data: {
        adminId: input.adminId,
        adminName: input.adminName.slice(0, 120),
        kind: input.kind.slice(0, 40),
        page: input.page?.slice(0, 300) ?? null,
        detail: (input.detail ?? undefined) as Prisma.InputJsonValue | undefined,
        flagged: input.flagged ?? false,
        ip: input.ip?.slice(0, 64) ?? null,
      },
    }),

  /** Newest first, `limit` at a time; pass the last row's createdAt as `before` for the next page. */
  list: (filters: { adminId?: string; kind?: string; flagged?: boolean; before?: Date; since?: Date; limit?: number }) =>
    prisma.adminActivity.findMany({
      where: {
        ...(filters.adminId ? { adminId: filters.adminId } : {}),
        ...(filters.kind ? { kind: filters.kind } : {}),
        ...(filters.flagged ? { flagged: true } : {}),
        ...(filters.before || filters.since
          ? { createdAt: { ...(filters.before ? { lt: filters.before } : {}), ...(filters.since ? { gte: filters.since } : {}) } }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(filters.limit ?? 50, 1), 200),
    }),

  /** Flagged events since a moment: the sidebar badge. */
  flaggedSince: (since: Date) =>
    prisma.adminActivity.count({ where: { flagged: true, createdAt: { gte: since } } }),

  /** Per admin: last seen, events today, flags this week. */
  summaries: async (todayStart: Date, weekStart: Date) => {
    const [last, today, flags] = await Promise.all([
      prisma.adminActivity.groupBy({ by: ['adminId'], where: { adminId: { not: null } }, _max: { createdAt: true } }),
      prisma.adminActivity.groupBy({ by: ['adminId'], where: { adminId: { not: null }, createdAt: { gte: todayStart } }, _count: { _all: true } }),
      prisma.adminActivity.groupBy({ by: ['adminId'], where: { adminId: { not: null }, flagged: true, createdAt: { gte: weekStart } }, _count: { _all: true } }),
    ]);
    const out = new Map<string, { lastSeenAt: Date | null; today: number; flagsThisWeek: number }>();
    const row = (id: string) => out.get(id) ?? out.set(id, { lastSeenAt: null, today: 0, flagsThisWeek: 0 }).get(id)!;
    for (const r of last) if (r.adminId) row(r.adminId).lastSeenAt = r._max.createdAt;
    for (const r of today) if (r.adminId) row(r.adminId).today = r._count._all;
    for (const r of flags) if (r.adminId) row(r.adminId).flagsThisWeek = r._count._all;
    return out;
  },
};
