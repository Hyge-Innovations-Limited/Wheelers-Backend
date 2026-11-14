import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { feedClient } from '@wheleers/db';
import type { NotificationEvent } from '@wheleers/kafka-schemas';
import { clientIp, recordAdminActivity } from '../admin/activity';
import { isRecord, getString } from '../utils/object';
import type { DriverKycStorage } from '../storage/driver-kyc-storage';
import { photoSigningWindow, shrinkFeedPhoto } from '../storage/feed-photos';
import { verifyAdminAuth } from './admin-auth.route';
import { FEED_PHOTOS_MAX, FEED_TEXT_MAX, shortName } from './feed.route';
import { readJsonBody, sendJson } from './utils';

/**
 * The drivers' Feed, for the admin (14 Nov 2026):
 *   GET  /admin/feed?status=waiting|live|rejected     the lists with how many are in each (waiting: oldest first)
 *   POST /admin/feed/:id/review  { decision: "approve" | "reject", reason? }   one waiting post; the driver is told
 *   POST /admin/feed/approve     { ids: [] }          many waiting posts at once
 *   POST /admin/feed             { text, pinned?, photos?: base64[] }   a Wheelers post, live at once
 *   POST /admin/feed/:id/pin     { pinned }
 *   POST /admin/feed/:id/remove                       off every feed (kept, as deleted)
 *   POST /admin/feed/drivers/:driverId/block { blocked }   stop (or let) a driver post
 * Returns false when the path is not one of these.
 */

interface AdminFeedDeps {
  adminApiKey: string;
  jwtSecret: string;
  feedStorage: Pick<DriverKycStorage, 'upload' | 'getSignedUrl'> | null;
  publisher?: { publishNotificationEvent(event: NotificationEvent): Promise<void> };
  shrink?: typeof shrinkFeedPhoto;
}

const STATUSES = { waiting: 'PENDING', live: 'APPROVED', rejected: 'REJECTED' } as const;
type ListName = keyof typeof STATUSES;
/** The reasons the admin picks from (any other text is allowed too). */
export const FEED_REJECT_REASONS = ['Not about driving', 'Rude or offensive', 'Personal information', 'Spam or advert'] as const;
const PAGE = 100;

/** The author is told, by push and in the app. Never throws. */
async function tellAuthor(deps: AdminFeedDeps, userId: string, approved: boolean, reason: string | null): Promise<void> {
  if (!deps.publisher) return;
  const title = approved ? 'Your post is live' : "Your post wasn't approved";
  const body = approved ? 'Drivers can now see it on the Feed.' : reason ? `${reason}.` : 'Open My posts to see it.';
  const timestamp = new Date().toISOString();
  const events: NotificationEvent[] = [
    { eventType: 'PUSH_SEND', notificationId: randomUUID(), userId, title, body, data: { type: approved ? 'feed_post_live' : 'feed_post_rejected' }, priority: 'normal', timestamp },
    { eventType: 'IN_APP_SEND', notificationId: randomUUID(), userId, title, body, category: 'system', read: false, timestamp },
  ];
  for (const event of events) {
    await deps.publisher.publishNotificationEvent(event).catch((error) =>
      console.warn('[admin-feed] notification failed', { userId, eventType: event.eventType, error: error instanceof Error ? error.message : String(error) }));
  }
}

export async function handleAdminFeedRoute(req: IncomingMessage, res: ServerResponse, deps: AdminFeedDeps, url: URL): Promise<boolean> {
  const path = url.pathname;
  const review = /^\/admin\/feed\/([0-9a-f-]{36})\/review$/.exec(path);
  const pin = /^\/admin\/feed\/([0-9a-f-]{36})\/pin$/.exec(path);
  const remove = /^\/admin\/feed\/([0-9a-f-]{36})\/remove$/.exec(path);
  const block = /^\/admin\/feed\/drivers\/([^/]+)\/block$/.exec(path);
  if (path !== '/admin/feed' && path !== '/admin/feed/approve' && !review && !pin && !remove && !block) return false;

  const auth = await verifyAdminAuth(req, deps);
  if (!auth) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
  const note = (detail: Record<string, unknown>) => recordAdminActivity({
    adminId: auth.adminId, adminName: auth.adminName, kind: 'action', page: '/admin/dashboard/feed', detail, ip: clientIp(req),
  });
  const body = async (): Promise<Record<string, unknown>> => {
    try { const b = await readJsonBody(req); return isRecord(b) ? b : {}; } catch { return {}; }
  };

  if (path === '/admin/feed' && req.method === 'GET') {
    const asked = url.searchParams.get('status') ?? 'waiting';
    const list: ListName = asked in STATUSES ? (asked as ListName) : 'waiting';
    const [rows, counts] = await Promise.all([feedClient.adminList(STATUSES[list], PAGE), feedClient.adminCounts()]);
    const window = photoSigningWindow();
    sendJson(res, 200, {
      status: list,
      counts,
      reasons: FEED_REJECT_REASONS,
      items: await Promise.all(rows.map(async (p) => ({
        id: p.id,
        kind: p.kind === 'ROAD_ALERT' ? 'road_alert' : p.kind === 'WHEELERS' ? 'wheelers' : 'driver',
        text: p.text,
        photos: deps.feedStorage
          ? (await Promise.all(p.photos.map(async (ph) => ({ url: await deps.feedStorage!.getSignedUrl(ph.fileKey, window.expiresInSeconds, 'image/jpeg', window.signingDate).catch(() => null), width: ph.width, height: ph.height })))).filter((ph) => ph.url)
          : [],
        driver: p.driver ? {
          id: p.driver.id, name: p.driver.user.name ?? null, shownAs: shortName(p.driver.user.name), phone: p.driver.user.phone ?? null,
          plate: p.driver.vehiclePlate ?? null, blocked: Boolean(p.driver.feedBlockedAt),
        } : null,
        likeCount: p.likeCount,
        reportCount: p.reportCount,
        reports: p.reports.map((r) => ({ reason: r.reason, at: r.createdAt.toISOString() })),
        /** Back in the queue after reports (it was live before). */
        wasLive: p.status === 'PENDING' && p.approvedAt !== null,
        pinned: p.pinned,
        rejectionReason: p.rejectionReason,
        reviewedBy: p.reviewedBy,
        reviewedAt: p.reviewedAt?.toISOString() ?? null,
        createdAt: p.createdAt.toISOString(),
      }))),
    });
    return true;
  }

  if (req.method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed' }); return true; }

  if (review) {
    const b = await body();
    const decision = getString(b, 'decision');
    if (decision !== 'approve' && decision !== 'reject') { sendJson(res, 400, { error: 'Choose approve or reject.' }); return true; }
    const reason = decision === 'reject' ? (getString(b, 'reason') ?? '').trim().slice(0, 200) : '';
    if (decision === 'reject' && !reason) { sendJson(res, 400, { error: 'Give the driver a reason.' }); return true; }
    const done = await feedClient.review(review[1]!, { approve: decision === 'approve', reason: reason || null, by: auth.adminName });
    if (!done) { sendJson(res, 409, { error: 'Someone already decided this post, or it was deleted.' }); return true; }
    // Approved again after reports: the driver was never told it left, so nothing to say.
    if (done.authorUserId && (decision === 'reject' || done.firstTime)) void tellAuthor(deps, done.authorUserId, decision === 'approve', reason || null);
    note({ what: decision === 'approve' ? 'approved a feed post' : 'rejected a feed post', postId: review[1], reason: reason || undefined });
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (path === '/admin/feed/approve') {
    const b = await body();
    const ids = Array.isArray(b.ids) ? [...new Set(b.ids.filter((x): x is string => typeof x === 'string'))].slice(0, 200) : [];
    if (ids.length === 0) { sendJson(res, 400, { error: 'Pick posts to approve.' }); return true; }
    let approved = 0;
    for (const id of ids) {
      const done = await feedClient.review(id, { approve: true, reason: null, by: auth.adminName }).catch(() => null);
      if (!done) continue;
      approved += 1;
      if (done.authorUserId && done.firstTime) void tellAuthor(deps, done.authorUserId, true, null);
    }
    note({ what: 'approved feed posts in bulk', posts: approved });
    sendJson(res, 200, { approved, skipped: ids.length - approved });
    return true;
  }

  if (path === '/admin/feed') {
    const b = await body();
    const text = (getString(b, 'text') ?? '').trim();
    const raw = Array.isArray(b.photos) ? b.photos.filter((p): p is string => typeof p === 'string' && p.length > 0) : [];
    if (!text && raw.length === 0) { sendJson(res, 400, { error: 'Write something or add a photo.' }); return true; }
    if ([...text].length > FEED_TEXT_MAX * 2) { sendJson(res, 400, { error: `Keep it to ${FEED_TEXT_MAX * 2} characters.` }); return true; }
    if (raw.length > FEED_PHOTOS_MAX) { sendJson(res, 400, { error: `Up to ${FEED_PHOTOS_MAX} photos.` }); return true; }
    if (raw.length > 0 && !deps.feedStorage) { sendJson(res, 503, { error: 'Photo storage is not set up.' }); return true; }
    const shrink = deps.shrink ?? shrinkFeedPhoto;
    const photos: Array<{ fileKey: string; width: number; height: number }> = [];
    for (const r of raw) {
      const shrunk = await shrink(Buffer.from(r.replace(/^data:[^,]*,/, ''), 'base64'));
      if (!shrunk.ok) { sendJson(res, 400, { error: shrunk.error }); return true; }
      const fileKey = await deps.feedStorage!.upload({ driverId: 'wheelers', type: 'post', imageBuffer: shrunk.photo.bytes, mimeType: 'image/jpeg' });
      photos.push({ fileKey, width: shrunk.photo.width, height: shrunk.photo.height });
    }
    const post = await feedClient.create({ driverId: null, kind: 'WHEELERS', text, photos, live: { by: auth.adminName, pinned: b.pinned === true } });
    note({ what: 'posted on the feed as Wheelers', postId: post.id, pinned: post.pinned });
    sendJson(res, 201, { id: post.id });
    return true;
  }

  if (pin) {
    const b = await body();
    const ok = await feedClient.setPinned(pin[1]!, b.pinned === true);
    if (!ok) { sendJson(res, 409, { error: 'Only a live post can be pinned.' }); return true; }
    note({ what: b.pinned === true ? 'pinned a feed post' : 'unpinned a feed post', postId: pin[1] });
    sendJson(res, 200, { pinned: b.pinned === true });
    return true;
  }

  if (remove) {
    const ok = await feedClient.remove(remove[1]!, auth.adminName);
    if (!ok) { sendJson(res, 404, { error: 'That post is already gone.' }); return true; }
    note({ what: 'removed a feed post', postId: remove[1] });
    sendJson(res, 200, { removed: true });
    return true;
  }

  if (block) {
    const b = await body();
    const ok = await feedClient.setBlocked(block[1]!, b.blocked === true);
    if (!ok) { sendJson(res, 404, { error: 'No such driver.' }); return true; }
    note({ what: b.blocked === true ? 'blocked a driver from posting' : 'let a driver post again', driverId: block[1] });
    sendJson(res, 200, { blocked: b.blocked === true });
    return true;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
  return true;
}
