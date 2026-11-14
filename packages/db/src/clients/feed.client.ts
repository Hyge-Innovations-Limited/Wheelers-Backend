import type { FeedPostKind, FeedPostStatus, Prisma } from '@prisma/client';
import { prisma } from '../prisma';

/**
 * The drivers' Feed (14 Nov 2026). A driver's post waits for an admin
 * (PENDING, seen only by its author); approved, it is in everyone's feed.
 * Likes and reports are one per person per post, so a double tap never counts
 * twice. Three reports send an approved post back to the admin.
 */

export const FEED_REPORTS_TO_HIDE = 3;

export type FeedFilter = 'all' | 'alerts' | 'wheelers';
export type FeedCursor = { at: Date; id: string };

const postInclude = (viewerUserId: string | null) => ({
  photos: { orderBy: { position: 'asc' as const } },
  driver: { select: { id: true, userId: true, user: { select: { name: true } } } },
  ...(viewerUserId ? { likes: { where: { userId: viewerUserId }, select: { userId: true } } } : {}),
});

export type FeedPostRow = Prisma.FeedPostGetPayload<{ include: { photos: true; driver: { select: { id: true; userId: true; user: { select: { name: true } } } }; likes: { select: { userId: true } } } }>;

const kindOf = (filter: FeedFilter): FeedPostKind | undefined => (filter === 'alerts' ? 'ROAD_ALERT' : filter === 'wheelers' ? 'WHEELERS' : undefined);

/** Not by a driver this viewer hid. A Wheelers post (no driver) is never hidden. */
const notHidden = (hidden: string[]): Prisma.FeedPostWhereInput =>
  hidden.length === 0 ? {} : { OR: [{ driverId: null }, { driverId: { notIn: hidden } }] };

export const feedClient = {
  /** The driver behind a signed-in user, with what decides whether they may post. */
  driverOf: (userId: string) =>
    prisma.driver.findUnique({ where: { userId }, select: { id: true, userId: true, kycStatus: true, feedBlockedAt: true, user: { select: { name: true } } } }),

  postsSince: (driverId: string, since: Date) =>
    prisma.feedPost.count({ where: { driverId, createdAt: { gte: since } } }),

  create: (input: {
    driverId: string | null;
    kind: FeedPostKind;
    text: string;
    photos: Array<{ fileKey: string; width: number; height: number }>;
    /** Wheelers posts go live at once. */
    live?: { by: string; pinned: boolean };
  }) =>
    prisma.feedPost.create({
      data: {
        driverId: input.driverId,
        kind: input.kind,
        text: input.text,
        ...(input.live
          ? { status: 'APPROVED' as FeedPostStatus, approvedAt: new Date(), reviewedAt: new Date(), reviewedBy: input.live.by.slice(0, 120), pinned: input.live.pinned }
          : {}),
        photos: { create: input.photos.map((p, position) => ({ ...p, position })) },
      },
      include: postInclude(null),
    }),

  hiddenDriverIds: async (userId: string) =>
    (await prisma.feedHide.findMany({ where: { userId }, select: { hiddenDriverId: true } })).map((h) => h.hiddenDriverId),

  hide: (userId: string, hiddenDriverId: string) =>
    prisma.feedHide.createMany({ data: [{ userId, hiddenDriverId }], skipDuplicates: true }),

  unhide: (userId: string, hiddenDriverId: string) =>
    prisma.feedHide.deleteMany({ where: { userId, hiddenDriverId } }),

  /**
   * One page of the live feed, newest first, after `cursor`. Pinned posts are
   * not in it (see `pinned`). Live for `liveSince`; road alerts only since
   * `alertSince`.
   */
  page: (input: { viewerUserId: string; hidden: string[]; filter: FeedFilter; cursor: FeedCursor | null; limit: number; liveSince: Date; alertSince: Date }) => {
    const kind = kindOf(input.filter);
    const where: Prisma.FeedPostWhereInput = {
      AND: [
        { status: 'APPROVED', deletedAt: null, pinned: false, approvedAt: { gte: input.liveSince } },
        kind ? { kind } : {},
        { NOT: { kind: 'ROAD_ALERT', approvedAt: { lt: input.alertSince } } },
        notHidden(input.hidden),
        input.cursor ? { OR: [{ approvedAt: { lt: input.cursor.at } }, { approvedAt: input.cursor.at, id: { lt: input.cursor.id } }] } : {},
      ],
    };
    return prisma.feedPost.findMany({
      where,
      orderBy: [{ approvedAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
      include: postInclude(input.viewerUserId),
    }) as Promise<FeedPostRow[]>;
  },

  /** Pinned posts (any age), for the top of the first page. */
  pinned: (input: { viewerUserId: string; hidden: string[]; filter: FeedFilter }) => {
    const kind = kindOf(input.filter);
    return prisma.feedPost.findMany({
      where: { AND: [{ status: 'APPROVED', deletedAt: null, pinned: true }, kind ? { kind } : {}, notHidden(input.hidden)] },
      orderBy: [{ approvedAt: 'desc' }],
      take: 5,
      include: postInclude(input.viewerUserId),
    }) as Promise<FeedPostRow[]>;
  },

  /** The author's own posts still waiting, shown to them at the top of their feed. */
  ownWaiting: (driverId: string, viewerUserId: string) =>
    prisma.feedPost.findMany({
      where: { driverId, status: 'PENDING', deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: postInclude(viewerUserId),
    }) as Promise<FeedPostRow[]>,

  /** Everything a driver posted (any status), newest first. */
  mine: (driverId: string, viewerUserId: string, cursor: FeedCursor | null, limit: number) =>
    prisma.feedPost.findMany({
      where: {
        driverId,
        deletedAt: null,
        ...(cursor ? { OR: [{ createdAt: { lt: cursor.at } }, { createdAt: cursor.at, id: { lt: cursor.id } }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      include: postInclude(viewerUserId),
    }) as Promise<FeedPostRow[]>,

  find: (id: string) => prisma.feedPost.findUnique({ where: { id }, include: postInclude(null) }),

  /** A like, once per person; only on a live post. True when it was new. */
  like: (postId: string, userId: string) =>
    prisma.$transaction(async (tx) => {
      const post = await tx.feedPost.findFirst({ where: { id: postId, status: 'APPROVED', deletedAt: null }, select: { id: true } });
      if (!post) return { ok: false as const };
      const made = await tx.feedLike.createMany({ data: [{ postId, userId }], skipDuplicates: true });
      const updated = made.count === 1
        ? await tx.feedPost.update({ where: { id: postId }, data: { likeCount: { increment: 1 } }, select: { likeCount: true } })
        : await tx.feedPost.findUniqueOrThrow({ where: { id: postId }, select: { likeCount: true } });
      return { ok: true as const, likeCount: updated.likeCount };
    }),

  unlike: (postId: string, userId: string) =>
    prisma.$transaction(async (tx) => {
      const gone = await tx.feedLike.deleteMany({ where: { postId, userId } });
      const post = gone.count === 1
        ? await tx.feedPost.update({ where: { id: postId }, data: { likeCount: { decrement: 1 } }, select: { likeCount: true } })
        : await tx.feedPost.findUnique({ where: { id: postId }, select: { likeCount: true } });
      return post ? { ok: true as const, likeCount: Math.max(0, post.likeCount) } : { ok: false as const };
    }),

  /**
   * A report, once per person. At FEED_REPORTS_TO_HIDE reports a live post
   * goes back to waiting (out of every feed) for an admin to look at again.
   */
  report: (postId: string, userId: string, reason: string | null) =>
    prisma.$transaction(async (tx) => {
      const post = await tx.feedPost.findFirst({ where: { id: postId, deletedAt: null }, select: { id: true } });
      if (!post) return { ok: false as const, sentBack: false };
      const made = await tx.feedReport.createMany({ data: [{ postId, userId, reason }], skipDuplicates: true });
      if (made.count === 0) return { ok: true as const, sentBack: false };
      await tx.feedPost.update({ where: { id: postId }, data: { reportCount: { increment: 1 } } });
      const sent = await tx.feedPost.updateMany({
        where: { id: postId, status: 'APPROVED', pinned: false, reportCount: { gte: FEED_REPORTS_TO_HIDE } },
        data: { status: 'PENDING' },
      });
      return { ok: true as const, sentBack: sent.count === 1 };
    }),

  /** The author deletes their own post. */
  deleteOwn: async (postId: string, driverId: string) =>
    (await prisma.feedPost.updateMany({ where: { id: postId, driverId, deletedAt: null }, data: { deletedAt: new Date(), deletedBy: 'author' } })).count === 1,

  // ── admin ────────────────────────────────────────────────────────────

  /** The admin's lists: waiting (oldest first), live or rejected (newest first). */
  adminList: (status: FeedPostStatus, limit: number) =>
    prisma.feedPost.findMany({
      where: { status, deletedAt: null },
      orderBy: status === 'PENDING' ? [{ createdAt: 'asc' }] : [{ reviewedAt: 'desc' }],
      take: limit,
      include: {
        photos: { orderBy: { position: 'asc' } },
        driver: { select: { id: true, userId: true, feedBlockedAt: true, vehiclePlate: true, user: { select: { name: true, phone: true } } } },
        reports: { select: { reason: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 5 },
      },
    }),

  adminCounts: async () => {
    const rows = await prisma.feedPost.groupBy({ by: ['status'], where: { deletedAt: null }, _count: { _all: true } });
    const count = (s: FeedPostStatus) => rows.find((r) => r.status === s)?._count._all ?? 0;
    return { waiting: count('PENDING'), live: count('APPROVED'), rejected: count('REJECTED') };
  },

  /**
   * An admin's answer on a waiting post; only a waiting one (two admins on
   * the same post: the second gets null). Approving keeps the time it first
   * went live and clears its reports.
   */
  review: (id: string, decision: { approve: boolean; reason: string | null; by: string }) =>
    prisma.$transaction(async (tx) => {
      const post = await tx.feedPost.findFirst({ where: { id, status: 'PENDING', deletedAt: null }, select: { approvedAt: true, driver: { select: { userId: true } } } });
      if (!post) return null;
      const now = new Date();
      const done = await tx.feedPost.updateMany({
        where: { id, status: 'PENDING', deletedAt: null },
        data: decision.approve
          ? { status: 'APPROVED', approvedAt: post.approvedAt ?? now, reportCount: 0, rejectionReason: null, reviewedAt: now, reviewedBy: decision.by.slice(0, 120) }
          : { status: 'REJECTED', rejectionReason: decision.reason, reviewedAt: now, reviewedBy: decision.by.slice(0, 120) },
      });
      if (done.count === 0) return null;
      if (decision.approve) await tx.feedReport.deleteMany({ where: { postId: id } });
      return { authorUserId: post.driver?.userId ?? null, firstTime: post.approvedAt === null };
    }),

  setPinned: async (id: string, pinned: boolean) =>
    (await prisma.feedPost.updateMany({ where: { id, status: 'APPROVED', deletedAt: null }, data: { pinned } })).count === 1,

  remove: async (id: string, by: string) =>
    (await prisma.feedPost.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: new Date(), deletedBy: by.slice(0, 120) } })).count === 1,

  setBlocked: async (driverId: string, blocked: boolean) =>
    (await prisma.driver.updateMany({ where: { id: driverId }, data: { feedBlockedAt: blocked ? new Date() : null } })).count === 1,
};
