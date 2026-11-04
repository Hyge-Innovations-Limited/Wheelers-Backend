import type { IncomingMessage, ServerResponse } from 'http';
import { adminActivityClient, adminChatClient } from '@wheleers/db';
import { verifyAdminAuth } from './admin-auth.route';
import { clientIp } from '../admin/activity';
import { sendJson } from './utils';

/**
 * Admin chat history (Timi, 4 Nov 2026). Owners and support; every view is logged.
 *
 *   GET /admin/chats/people?q=&limit=&offset=        riders and drivers by latest activity
 *   GET /admin/chats/people/:userId?before=&limit=   one person's whole chat, a page at a time going back
 *   GET /admin/chats/trips?q=&limit=&offset=         trips newest first
 *   GET /admin/chats/trips/:rideId                   one trip: the rider's chat around it, its driver chat and calls
 */
interface Deps { jwtSecret: string; adminApiKey: string }

const ID = /^[0-9a-zA-Z-]{8,64}$/;
const num = (url: URL, key: string, fallback: number) => {
  const n = Number(url.searchParams.get(key) ?? fallback);
  return Number.isFinite(n) ? n : fallback;
};

export async function handleAdminChatRoute(req: IncomingMessage, res: ServerResponse, deps: Deps, url: URL): Promise<boolean> {
  const path = url.pathname;
  const person = /^\/admin\/chats\/people\/([^/]+)$/.exec(path);
  const trip = /^\/admin\/chats\/trips\/([^/]+)$/.exec(path);
  if (path !== '/admin/chats/people' && path !== '/admin/chats/trips' && !person && !trip) return false;

  try {
    if (req.method !== 'GET') { sendJson(res, 405, { error: 'Method not allowed' }); return true; }
    const auth = await verifyAdminAuth(req, deps);
    if (!auth) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    if (auth.role !== 'OWNER' && auth.role !== 'SUPPORT') { sendJson(res, 403, { error: 'This page is not available.' }); return true; }
    const log = (detail: Record<string, unknown>) => adminActivityClient.record({ adminId: auth.adminId, adminName: auth.adminName, kind: 'view', page: path, detail, ip: clientIp(req) }).catch(() => undefined);
    const q = (url.searchParams.get('q') ?? '').slice(0, 80);

    if (path === '/admin/chats/people') {
      await log({ q: q || null });
      sendJson(res, 200, await adminChatClient.listPeople({ q, limit: num(url, 'limit', 50), offset: num(url, 'offset', 0) }));
      return true;
    }
    if (path === '/admin/chats/trips') {
      await log({ q: q || null });
      sendJson(res, 200, await adminChatClient.listTrips({ q, limit: num(url, 'limit', 50), offset: num(url, 'offset', 0) }));
      return true;
    }
    if (person) {
      const userId = decodeURIComponent(person[1]!);
      if (!ID.test(userId)) { sendJson(res, 400, { error: 'Bad id.' }); return true; }
      const rawBefore = url.searchParams.get('before');
      const before = rawBefore ? new Date(rawBefore) : null;
      if (before && Number.isNaN(before.getTime())) { sendJson(res, 400, { error: 'before must be a time.' }); return true; }
      await log({ userId, before: rawBefore });
      const result = await adminChatClient.forUser(userId, { before, limit: num(url, 'limit', 150) });
      if (!result) { sendJson(res, 404, { error: 'No such person.' }); return true; }
      sendJson(res, 200, result);
      return true;
    }
    const rideId = decodeURIComponent(trip![1]!);
    if (!ID.test(rideId)) { sendJson(res, 400, { error: 'Bad id.' }); return true; }
    await log({ rideId });
    const result = await adminChatClient.forRide(rideId);
    if (!result) { sendJson(res, 404, { error: 'No such trip.' }); return true; }
    sendJson(res, 200, result);
    return true;
  } catch (error) {
    console.error('[admin-chat] failed', error instanceof Error ? error.message : String(error));
    sendJson(res, 500, { error: 'Something went wrong. Try again.' });
    return true;
  }
}
