import type { IncomingMessage, ServerResponse } from 'http';
import { nearestCngStations } from '@wheleers/config';
import { feedClient, type FeedCursor, type FeedFilter, type FeedPostRow } from '@wheleers/db';
import { verifyLocalAccessToken } from '../auth/local';
import { isRecord, getString } from '../utils/object';
import type { DriverKycStorage } from '../storage/driver-kyc-storage';
import { photoSigningWindow, shrinkFeedPhoto } from '../storage/feed-photos';
import { readJsonBody, sendJson } from './utils';

/**
 * The drivers' Feed and the CNG stations (driver app, 14 Nov 2026):
 *   GET    /drivers/feed?filter=all|alerts|wheelers&cursor=   the feed: my waiting posts and pinned first (first page), then live posts newest first
 *   GET    /drivers/feed/mine?cursor=                         everything I posted, any status
 *   POST   /drivers/feed            { text, roadAlert?, photos?: base64[] }   a post; waits for an admin
 *   DELETE /drivers/feed/:id                                  delete my post
 *   POST   /drivers/feed/:id/like   DELETE /drivers/feed/:id/like
 *   POST   /drivers/feed/:id/report { reason? }
 *   POST   /drivers/feed/hide       { driverId }              hide that driver's posts from me
 *   GET    /drivers/stations?lat=&lng=                        CNG stations in Lagos, nearest first
 * Returns false when the path is not one of these.
 */

export interface FeedRouteDeps {
  jwtSecret: string;
  /** Where Feed photos go. Null when storage is not configured: text posts still work. */
  feedStorage: Pick<DriverKycStorage, 'upload' | 'getSignedUrl'> | null;
  /** Photo shrinking, replaceable in tests. */
  shrink?: typeof shrinkFeedPhoto;
}

export const FEED_TEXT_MAX = 280;
export const FEED_PHOTOS_MAX = 4;
export const FEED_POSTS_PER_DAY = 5;
const PAGE = 20;
const DAY_MS = 86_400_000;
/** The feed shows 30 days; a road alert 3 hours. Older posts stay in My posts. */
export const FEED_LIVE_DAYS = 30;
export const ROAD_ALERT_HOURS = 3;

function userIdOf(req: IncomingMessage, jwtSecret: string): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  try {
    return verifyLocalAccessToken(header.slice(7), jwtSecret).sub;
  } catch {
    return null;
  }
}

export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(value: string | null): FeedCursor | null {
  if (!value) return null;
  try {
    const [iso, id] = Buffer.from(value, 'base64url').toString('utf8').split('|');
    const at = new Date(iso ?? '');
    return id && Number.isFinite(at.getTime()) ? { at, id } : null;
  } catch {
    return null;
  }
}

/** "Tunde Adebayo" → "Tunde A.". */
export function shortName(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Driver';
  return parts.length === 1 ? parts[0]! : `${parts[0]} ${parts[parts.length - 1]![0]!.toUpperCase()}.`;
}

const initialsOf = (name: string) => name.split(/\s+/).map((p) => p[0] ?? '').join('').replace(/[^\p{L}]/gu, '').slice(0, 2).toUpperCase() || 'D';

const statusOf = (s: string) => (s === 'APPROVED' ? 'live' : s === 'REJECTED' ? 'rejected' : 'waiting');
const kindOf = (k: string) => (k === 'ROAD_ALERT' ? 'road_alert' : k === 'WHEELERS' ? 'wheelers' : 'driver');

export async function postView(row: FeedPostRow, viewerUserId: string, storage: FeedRouteDeps['feedStorage'], now = Date.now()) {
  const wheelers = row.kind === 'WHEELERS';
  const name = wheelers ? 'Wheelers' : shortName(row.driver?.user?.name);
  const mine = !wheelers && row.driver?.userId === viewerUserId;
  const window = photoSigningWindow(now);
  const photos = storage
    ? await Promise.all(row.photos.map(async (p) => ({
        url: await storage.getSignedUrl(p.fileKey, window.expiresInSeconds, 'image/jpeg', window.signingDate).catch(() => null),
        width: p.width,
        height: p.height,
      })))
    : [];
  return {
    id: row.id,
    kind: kindOf(row.kind),
    text: row.text,
    photos: photos.filter((p) => p.url),
    author: { name, initials: wheelers ? 'W' : initialsOf(name), driverId: wheelers ? null : row.driverId },
    mine,
    liked: (row.likes?.length ?? 0) > 0,
    likeCount: row.likeCount,
    // Only the author learns that a post waits or was not approved, and why.
    status: statusOf(row.status),
    rejectionReason: mine ? row.rejectionReason : null,
    pinned: row.pinned,
    at: (row.approvedAt ?? row.createdAt).toISOString(),
  };
}

const FILTERS: readonly FeedFilter[] = ['all', 'alerts', 'wheelers'];

export async function handleFeedRoute(req: IncomingMessage, res: ServerResponse, deps: FeedRouteDeps, url: URL): Promise<boolean> {
  const path = url.pathname;
  const one = /^\/drivers\/feed\/([0-9a-f-]{36})$/.exec(path);
  const like = /^\/drivers\/feed\/([0-9a-f-]{36})\/like$/.exec(path);
  const report = /^\/drivers\/feed\/([0-9a-f-]{36})\/report$/.exec(path);
  const known = path === '/drivers/feed' || path === '/drivers/feed/mine' || path === '/drivers/feed/hide' || path === '/drivers/stations' || one || like || report;
  if (!known) return false;

  const userId = userIdOf(req, deps.jwtSecret);
  if (!userId) {
    sendJson(res, 401, { error: 'Sign in again.' });
    return true;
  }

  // CNG stations: the same for everyone signed in; nearest first when the phone said where it is.
  if (path === '/drivers/stations') {
    if (req.method !== 'GET') { sendJson(res, 405, { error: 'Method not allowed' }); return true; }
    const lat = Number(url.searchParams.get('lat'));
    const lng = Number(url.searchParams.get('lng'));
    const located = url.searchParams.has('lat') && url.searchParams.has('lng') && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    if (!located) {
      // Without a position: the list from the middle of Lagos (Ikeja), no "you are outside Lagos".
      const { stations } = nearestCngStations(6.6018, 3.3515);
      sendJson(res, 200, { located: false, inLagos: true, stations: stations.map(({ km: _km, minutes: _m, ...s }) => ({ ...s, km: null, minutes: null })) });
      return true;
    }
    const { inLagos, stations } = nearestCngStations(lat, lng);
    sendJson(res, 200, { located: true, inLagos, stations });
    return true;
  }

  const driver = await feedClient.driverOf(userId);
  if (!driver) {
    sendJson(res, 403, { error: 'The Feed is for drivers.' });
    return true;
  }

  if (path === '/drivers/feed' && req.method === 'GET') {
    const asked = url.searchParams.get('filter') ?? 'all';
    const filter: FeedFilter = (FILTERS as readonly string[]).includes(asked) ? (asked as FeedFilter) : 'all';
    const cursor = decodeCursor(url.searchParams.get('cursor'));
    const now = Date.now();
    const hidden = await feedClient.hiddenDriverIds(userId);
    const [waiting, pinned, page] = await Promise.all([
      !cursor && filter === 'all' ? feedClient.ownWaiting(driver.id, userId) : Promise.resolve([]),
      cursor ? Promise.resolve([]) : feedClient.pinned({ viewerUserId: userId, hidden, filter }),
      feedClient.page({
        viewerUserId: userId, hidden, filter, cursor, limit: PAGE,
        liveSince: new Date(now - FEED_LIVE_DAYS * DAY_MS),
        alertSince: new Date(now - ROAD_ALERT_HOURS * 3600_000),
      }),
    ]);
    const rows = [...waiting, ...pinned, ...page];
    const last = page[page.length - 1];
    sendJson(res, 200, {
      posts: await Promise.all(rows.map((r) => postView(r, userId, deps.feedStorage, now))),
      nextCursor: page.length === PAGE && last?.approvedAt ? encodeCursor(last.approvedAt, last.id) : null,
      canPost: driver.kycStatus === 'APPROVED' && !driver.feedBlockedAt,
    });
    return true;
  }

  if (path === '/drivers/feed/mine') {
    if (req.method !== 'GET') { sendJson(res, 405, { error: 'Method not allowed' }); return true; }
    const cursor = decodeCursor(url.searchParams.get('cursor'));
    const rows = await feedClient.mine(driver.id, userId, cursor, PAGE);
    const last = rows[rows.length - 1];
    sendJson(res, 200, {
      posts: await Promise.all(rows.map((r) => postView(r, userId, deps.feedStorage))),
      nextCursor: rows.length === PAGE && last ? encodeCursor(last.createdAt, last.id) : null,
    });
    return true;
  }

  if (path === '/drivers/feed' && req.method === 'POST') {
    if (driver.kycStatus !== 'APPROVED') { sendJson(res, 403, { error: 'You can post once your account is approved.', code: 'NOT_APPROVED' }); return true; }
    if (driver.feedBlockedAt) { sendJson(res, 403, { error: "You can't post on the Feed.", code: 'FEED_BLOCKED' }); return true; }
    let body: unknown;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: 'Something was wrong with that post. Try again.' }); return true; }
    if (!isRecord(body)) { sendJson(res, 400, { error: 'Something was wrong with that post. Try again.' }); return true; }
    const text = (getString(body, 'text') ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const rawPhotos = Array.isArray(body.photos) ? body.photos.filter((p): p is string => typeof p === 'string' && p.length > 0) : [];
    if (text.length === 0 && rawPhotos.length === 0) { sendJson(res, 400, { error: 'Write something or add a photo.', code: 'EMPTY' }); return true; }
    if ([...text].length > FEED_TEXT_MAX) { sendJson(res, 400, { error: `Keep it to ${FEED_TEXT_MAX} characters.`, code: 'TOO_LONG' }); return true; }
    if (rawPhotos.length > FEED_PHOTOS_MAX) { sendJson(res, 400, { error: `Up to ${FEED_PHOTOS_MAX} photos.`, code: 'TOO_MANY_PHOTOS' }); return true; }
    if (rawPhotos.length > 0 && !deps.feedStorage) { sendJson(res, 503, { error: "Photos can't be sent right now. Post without them or try later." }); return true; }
    const today = await feedClient.postsSince(driver.id, new Date(Date.now() - DAY_MS));
    if (today >= FEED_POSTS_PER_DAY) { sendJson(res, 429, { error: `You can post ${FEED_POSTS_PER_DAY} times a day. Try again tomorrow.`, code: 'DAILY_LIMIT' }); return true; }

    // One photo at a time, in a worker thread (the API keeps answering meanwhile): a decoded photo
    // takes ~100 MB and the server has little memory to spare (14 Nov 2026: 1.9 GB, already in swap).
    const shrink = deps.shrink ?? shrinkFeedPhoto;
    const shrunk: Awaited<ReturnType<typeof shrinkFeedPhoto>>[] = [];
    for (const raw of rawPhotos) {
      const one = await shrink(Buffer.from(raw.replace(/^data:[^,]*,/, ''), 'base64'));
      shrunk.push(one);
      if (!one.ok) break;
    }
    const bad = shrunk.find((s) => !s.ok);
    if (bad && !bad.ok) { sendJson(res, 400, { error: bad.error, code: 'BAD_PHOTO' }); return true; }
    let photos: Array<{ fileKey: string; width: number; height: number }>;
    try {
      photos = await Promise.all(shrunk.map(async (s) => {
        if (!s.ok) throw new Error('unreachable');
        const fileKey = await deps.feedStorage!.upload({ driverId: driver.id, type: 'post', imageBuffer: s.photo.bytes, mimeType: 'image/jpeg' });
        return { fileKey, width: s.photo.width, height: s.photo.height };
      }));
    } catch (error) {
      console.error('[feed] photo upload failed', { driverId: driver.id, error: error instanceof Error ? error.message : String(error) });
      sendJson(res, 502, { error: "Your photo didn't send. Try again." });
      return true;
    }
    const roadAlert = body.roadAlert === true;
    const created = await feedClient.create({ driverId: driver.id, kind: roadAlert ? 'ROAD_ALERT' : 'DRIVER', text, photos });
    sendJson(res, 201, { post: await postView({ ...created, likes: [] }, userId, deps.feedStorage) });
    return true;
  }

  if (one) {
    if (req.method !== 'DELETE') { sendJson(res, 405, { error: 'Method not allowed' }); return true; }
    const gone = await feedClient.deleteOwn(one[1]!, driver.id);
    if (!gone) { sendJson(res, 404, { error: 'That post is already gone.' }); return true; }
    sendJson(res, 200, { deleted: true });
    return true;
  }

  if (like) {
    if (req.method !== 'POST' && req.method !== 'DELETE') { sendJson(res, 405, { error: 'Method not allowed' }); return true; }
    const result = req.method === 'POST' ? await feedClient.like(like[1]!, userId) : await feedClient.unlike(like[1]!, userId);
    if (!result.ok) { sendJson(res, 404, { error: 'That post is no longer on the Feed.' }); return true; }
    sendJson(res, 200, { liked: req.method === 'POST', likeCount: result.likeCount });
    return true;
  }

  if (report) {
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed' }); return true; }
    let reason: string | null = null;
    try {
      const body = await readJsonBody(req);
      if (isRecord(body)) reason = (getString(body, 'reason') ?? '').trim().slice(0, 200) || null;
    } catch { /* a report needs no reason */ }
    const result = await feedClient.report(report[1]!, userId, reason);
    if (!result.ok) { sendJson(res, 404, { error: 'That post is already gone.' }); return true; }
    sendJson(res, 200, { reported: true });
    return true;
  }

  if (path === '/drivers/feed/hide') {
    if (req.method !== 'POST' && req.method !== 'DELETE') { sendJson(res, 405, { error: 'Method not allowed' }); return true; }
    let body: unknown;
    try { body = await readJsonBody(req); } catch { body = null; }
    const hiddenDriverId = isRecord(body) ? getString(body, 'driverId') : null;
    if (!hiddenDriverId || hiddenDriverId === driver.id) { sendJson(res, 400, { error: 'Something was wrong. Try again.' }); return true; }
    if (req.method === 'POST') await feedClient.hide(userId, hiddenDriverId);
    else await feedClient.unhide(userId, hiddenDriverId);
    sendJson(res, 200, { hidden: req.method === 'POST' });
    return true;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
  return true;
}
