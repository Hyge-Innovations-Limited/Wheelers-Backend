import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { adminClient } from '@wheleers/db';
import { verifyPassword } from '../auth/local';
import type { RedisClient } from '../redis/client';
import { extractAdminId } from '../http/admin-auth.route';
import { readJsonBody, sendJson } from '../http/utils';
import { isRecord, getString } from '../utils/object';
import { clientIp, recordAdminActivity } from './activity';

/**
 * The locked areas of the dashboard: Chats, Trip recordings and the money
 * pages (Fees, Stellar, Usage) need the admin's password again, on top of the
 * login, and close after five minutes with no activity.
 *
 * The server decides, not only the page: every call to a locked area is
 * refused with 423 until this login is unlocked. An unlock belongs to one
 * login (one browser), lasts five minutes, and each call to a locked area or
 * "still here" ping from an active page restarts the five minutes. Five wrong
 * passwords stop the tries for fifteen minutes. Every unlock, wrong try and
 * lock is on Team → Activity.
 */

export const ADMIN_UNLOCK_SECONDS = 5 * 60;
export const ADMIN_UNLOCK_TRIES = 5;
export const ADMIN_UNLOCK_BLOCK_SECONDS = 15 * 60;

const LOCKED: RegExp[] = [
  /^\/admin\/chats\//,
  /^\/admin\/trip-recordings$/,
  /^\/admin\/rides\/[^/]+\/recordings$/,
  /^\/admin\/fees\//,
  /^\/admin\/stellar$/,
  /^\/admin\/usage\//,
];

/** A locked area's API; the Fees page's Excel download too (insights export, scope=fees). */
export function isLockedAdminPath(url: URL): boolean {
  if (url.pathname === '/admin/insights/export' && url.searchParams.get('scope') === 'fees') return true;
  return LOCKED.some((pattern) => pattern.test(url.pathname));
}

/** One login: the admin and this very token (another browser is another login). */
function loginOf(req: IncomingMessage, jwtSecret: string): { adminId: string; key: string } | null {
  const adminId = extractAdminId(req, jwtSecret);
  if (!adminId) return null;
  const token = (req.headers.authorization ?? '').slice(7);
  const login = createHash('sha256').update(token).digest('hex').slice(0, 24);
  return { adminId, key: `admin:unlock:${adminId}:${login}` };
}
const triesKey = (adminId: string) => `admin:unlock-tries:${adminId}`;

/**
 * A locked area asked for by a login that has not unlocked it (or whose five
 * minutes ran out). Unlocked: its five minutes start again. No admin login
 * (the bootstrap key, or none at all): left to the route's own check.
 */
export async function adminAreaLocked(req: IncomingMessage, jwtSecret: string, redis: RedisClient): Promise<boolean> {
  const login = loginOf(req, jwtSecret);
  if (!login) return false;
  const restarted = await redis.send('EXPIRE', login.key, String(ADMIN_UNLOCK_SECONDS)).catch(() => 0);
  return restarted !== 1;
}

export const ADMIN_LOCKED_BODY = { error: 'Locked. Enter your password to open this page.', code: 'ADMIN_LOCKED' };

interface AreaLockDeps {
  jwtSecret: string;
  redis: RedisClient;
}

/**
 *   POST /admin/unlock       { password }  → 200 { unlockedForSeconds } | 403 WRONG_PASSWORD { triesLeft } | 429 TOO_MANY_TRIES
 *   POST /admin/unlock/ping                → 200 { unlocked } (an unlocked login's five minutes start again)
 *   POST /admin/lock                       → 200 { unlocked: false }
 * 403, not 401, for a wrong password: 401 signs the dashboard out.
 */
export async function handleAdminAreaLockRoute(req: IncomingMessage, res: ServerResponse, deps: AreaLockDeps, url: URL): Promise<boolean> {
  const path = url.pathname;
  if (path !== '/admin/unlock' && path !== '/admin/unlock/ping' && path !== '/admin/lock') return false;
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }
  const login = loginOf(req, deps.jwtSecret);
  const admin = login ? await adminClient.findById(login.adminId).catch(() => null) : null;
  if (!login || !admin?.active) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }
  const ip = clientIp(req);

  if (path === '/admin/unlock/ping') {
    const restarted = await deps.redis.send('EXPIRE', login.key, String(ADMIN_UNLOCK_SECONDS)).catch(() => 0);
    sendJson(res, 200, { unlocked: restarted === 1 });
    return true;
  }

  if (path === '/admin/lock') {
    await deps.redis.del(login.key).catch(() => undefined);
    recordAdminActivity({ adminId: admin.id, adminName: admin.name, kind: 'locked', ip });
    sendJson(res, 200, { unlocked: false });
    return true;
  }

  const tries = Number(await deps.redis.get(triesKey(admin.id)).catch(() => null) ?? 0);
  if (tries >= ADMIN_UNLOCK_TRIES) {
    sendJson(res, 429, { error: 'Too many wrong passwords. Try again in 15 minutes.', code: 'TOO_MANY_TRIES' });
    return true;
  }
  const body = await readJsonBody(req).catch(() => null);
  const password = isRecord(body) ? getString(body, 'password') : undefined;
  if (!password) {
    sendJson(res, 400, { error: 'Enter your password.' });
    return true;
  }
  if (!(await verifyPassword(password, admin.passwordHash))) {
    const now = Number(await deps.redis.send('INCR', triesKey(admin.id)).catch(() => tries + 1));
    if (now === 1) await deps.redis.send('EXPIRE', triesKey(admin.id), String(ADMIN_UNLOCK_BLOCK_SECONDS)).catch(() => undefined);
    recordAdminActivity({ adminId: admin.id, adminName: admin.name, kind: 'unlock-failed', ip });
    const triesLeft = Math.max(0, ADMIN_UNLOCK_TRIES - now);
    if (triesLeft === 0) {
      sendJson(res, 429, { error: 'Too many wrong passwords. Try again in 15 minutes.', code: 'TOO_MANY_TRIES' });
      return true;
    }
    sendJson(res, 403, { error: 'Wrong password.', code: 'WRONG_PASSWORD', triesLeft });
    return true;
  }
  await deps.redis.set(login.key, '1', ADMIN_UNLOCK_SECONDS);
  await deps.redis.del(triesKey(admin.id)).catch(() => undefined);
  recordAdminActivity({ adminId: admin.id, adminName: admin.name, kind: 'unlocked', ip });
  sendJson(res, 200, { unlockedForSeconds: ADMIN_UNLOCK_SECONDS });
  return true;
}
