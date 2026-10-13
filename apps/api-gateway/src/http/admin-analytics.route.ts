import type { IncomingMessage, ServerResponse } from 'http';
import { activityClient, analyticsClient, userClient } from '@wheleers/db';
import { verifyAdminAuth } from './admin-auth.route';
import { sendJson } from './utils';
import { GUEST_USER_ID, OUTCOME_FAILED, OUTCOME_OK } from '../analytics/user-outcomes';

interface AnalyticsDeps {
  adminApiKey: string;
  jwtSecret: string;
}

export async function handleAdminPlatformStatsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AnalyticsDeps,
): Promise<void> {
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const stats = await analyticsClient.platformStats();
  sendJson(res, 200, stats);
}

export async function handleAdminDriverAnalyticsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AnalyticsDeps,
): Promise<void> {
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const analytics = await analyticsClient.driverAnalytics();
  sendJson(res, 200, analytics);
}

export async function handleAdminRiderAnalyticsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AnalyticsDeps,
): Promise<void> {
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const analytics = await analyticsClient.riderAnalytics();
  sendJson(res, 200, analytics);
}

export async function handleAdminRecentRidesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AnalyticsDeps,
): Promise<void> {
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const rides = await analyticsClient.recentRides();
  sendJson(res, 200, { rides });
}

export async function handleAdminUserActivityRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AnalyticsDeps,
  url: URL,
): Promise<void> {
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const userId = url.searchParams.get('userId');
  if (!userId) {
    sendJson(res, 400, { error: 'userId query parameter is required' });
    return;
  }

  const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const [result, users] = await Promise.all([
    activityClient.listByUser(userId, {
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
      cursor: url.searchParams.get('cursor') ?? undefined,
      eventType: url.searchParams.get('type') ?? undefined,
    }),
    userClient.findManyByIds([userId]).catch(() => []),
  ]);

  sendJson(res, 200, { ...result, user: users[0] ?? null });
}

export async function handleAdminActivityFeedRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AnalyticsDeps,
  url: URL,
): Promise<void> {
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [recent, counts] = await Promise.all([
    activityClient.listRecent(limit),
    activityClient.countsByType(since),
  ]);

  // Resolve names so the feed reads as people, not uuids
  const userIds = [...new Set(recent.map((row) => row.userId))];
  const users = userIds.length
    ? await userClient.findManyByIds(userIds).catch(() => [])
    : [];
  const nameById = new Map(users.map((u) => [u.id, { name: u.name, phone: u.phone }]));

  sendJson(res, 200, {
    counts,
    recent: recent.map((row) => ({
      id: row.id,
      userId: row.userId,
      userName: nameById.get(row.userId)?.name ?? null,
      userPhone: nameById.get(row.userId)?.phone ?? null,
      eventType: row.eventType,
      source: row.source,
      rideId: row.rideId,
      metadata: row.metadata,
      occurredAt: row.occurredAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    })),
  });
}

/** "referral_code_applied" → "Referral code applied": a name for the rows other parts of the server write. */
function eventWords(eventType: string): string {
  const words = eventType.replace(/[_:.]+/g, ' ').trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Activity';
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * GET /admin/analytics/app-activity?outcome=failed|ok|all&before=<ISO>&limit=
 *
 * The admin Activity page: what people tried in the app and how it went, in
 * words. `failed` is the refusals, each with the sentence the person saw;
 * `ok` is everything that worked. With it, the last 24 hours counted: how
 * many problems, how many people, how many were our fault, and the problems
 * hitting the most people.
 */
export async function handleAdminAppActivityRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AnalyticsDeps,
  url: URL,
): Promise<void> {
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const outcome = url.searchParams.get('outcome') ?? 'all';
  const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const beforeRaw = url.searchParams.get('before');
  const before = beforeRaw && !Number.isNaN(Date.parse(beforeRaw)) ? new Date(beforeRaw) : undefined;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [page, failures] = await Promise.all([
    activityClient.listPage({
      eventTypes: outcome === 'failed' ? [OUTCOME_FAILED] : undefined,
      userId: url.searchParams.get('userId') ?? undefined,
      before,
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 60,
    }),
    activityClient.listSince(OUTCOME_FAILED, since),
  ]);
  // "ok" is everything but the refusals; asked for alone, they are dropped from the page.
  const rows = outcome === 'ok' ? page.rows.filter((row) => row.eventType !== OUTCOME_FAILED) : page.rows;

  const userIds = [...new Set(rows.map((row) => row.userId).filter((id) => id !== GUEST_USER_ID))];
  const users = userIds.length ? await userClient.findManyByIds(userIds).catch(() => []) : [];
  const userById = new Map(users.map((user) => [user.id, user]));

  // The last 24 hours: each distinct problem, and how many different people met it.
  const problems = new Map<string, { action: string; message: string; count: number; people: Set<string>; ours: boolean }>();
  const affected = new Set<string>();
  let ours = 0;
  for (const row of failures) {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const action = text(meta.action) ?? 'Used the app';
    const message = text(meta.message) ?? 'The request was refused.';
    const person = row.userId === GUEST_USER_ID ? `guest:${text(meta.phone) ?? ''}` : row.userId;
    affected.add(person);
    if (meta.fault === 'ours') ours += 1;
    const key = `${action}|${message}`;
    const known = problems.get(key) ?? { action, message, count: 0, people: new Set<string>(), ours: meta.fault === 'ours' };
    known.count += 1;
    known.people.add(person);
    problems.set(key, known);
  }

  sendJson(res, 200, {
    summary: {
      failed: failures.length,
      people: affected.size,
      ourFault: ours,
      top: [...problems.values()]
        .sort((a, b) => b.people.size - a.people.size || b.count - a.count)
        .slice(0, 6)
        .map((problem) => ({ action: problem.action, message: problem.message, count: problem.count, people: problem.people.size, ours: problem.ours })),
    },
    rows: rows.map((row) => {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const failed = row.eventType === OUTCOME_FAILED;
      const user = userById.get(row.userId) ?? null;
      return {
        id: row.id,
        at: row.createdAt.toISOString(),
        ok: !failed,
        action: text(meta.action) ?? eventWords(row.eventType),
        message: failed ? (text(meta.message) ?? 'The request was refused.') : null,
        ourFault: meta.fault === 'ours',
        userId: user ? row.userId : null,
        name: user?.name ?? null,
        phone: user?.phone ?? text(meta.phone),
        role: user?.role ?? null,
        signedIn: row.userId !== GUEST_USER_ID,
        where: row.source,
        rideId: row.rideId,
        // For whoever has to find it in the logs.
        technical: [text(meta.method), text(meta.path), typeof meta.status === 'number' ? String(meta.status) : null].filter(Boolean).join(' ') || null,
      };
    }),
    hasMore: page.hasMore,
    nextBefore: page.rows.length ? page.rows[page.rows.length - 1].createdAt.toISOString() : null,
  });
}
