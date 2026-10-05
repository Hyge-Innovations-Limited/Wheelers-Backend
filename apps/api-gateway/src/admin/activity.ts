import { createHmac } from 'node:crypto';
import type { IncomingMessage } from 'http';
import { adminActivityClient, adminClient, type AdminActivityInput } from '@wheleers/db';

/**
 * What admins do in the dashboard, recorded for the owners' Team activity
 * page. Recording never slows or fails a request: it happens after, and a
 * failure is logged and dropped.
 */

export type AdminRoleName = 'OWNER' | 'STAFF';

/**
 * The admin's code in the hidden mark on every dashboard page: six letters
 * and digits from their ID, keyed with the server secret so it cannot be
 * worked out from outside. A leaked screenshot's mark names whose session it was.
 */
export function adminMarkCode(adminId: string, secret: string): string {
  return createHmac('sha256', secret).update(`mark:${adminId}`).digest('hex').slice(0, 6).toUpperCase();
}

export function clientIp(req: IncomingMessage): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  return (typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined) ?? req.socket?.remoteAddress ?? null;
}

export function recordAdminActivity(input: AdminActivityInput): void {
  void adminActivityClient.record(input).catch((error) => {
    console.warn('[admin-activity] not recorded', { kind: input.kind, error: error instanceof Error ? error.message : String(error) });
  });
}

const names = new Map<string, { name: string; at: number }>();
async function adminNameOf(adminId: string): Promise<string> {
  const known = names.get(adminId);
  if (known && Date.now() - known.at < 5 * 60_000) return known.name;
  const admin = await adminClient.findById(adminId).catch(() => null);
  const name = admin?.name ?? 'Unknown admin';
  names.set(adminId, { name, at: Date.now() });
  return name;
}

const DETAIL_PAGE = /^\/admin\/(users|drivers|rides|trips|group-rides|alerts|interstate)\/[^/]+$/;
const QUIET = /^\/admin\/(login|activity|me|security|health|team|create-admin)(\/|$)/;

/**
 * The API requests worth a line on the timeline, read from what the dashboard
 * asked for: searches (who looked up whom), records opened, and every change
 * (approvals, refunds, role changes). Lists and charts loading are not.
 */
export function describeAdminRequest(method: string, url: URL, status: number): Omit<AdminActivityInput, 'adminId' | 'adminName'> | null {
  const path = url.pathname;
  if (!path.startsWith('/admin/') || QUIET.test(path) || status >= 500) return null;
  if (method === 'GET') {
    if (status >= 400) return null;
    const q = (url.searchParams.get('q') ?? url.searchParams.get('search') ?? '').trim();
    if (q) return { kind: 'search', page: path, detail: { q: q.slice(0, 120) } };
    if (DETAIL_PAGE.test(path)) return { kind: 'view', page: path };
    return null;
  }
  if (method === 'OPTIONS' || method === 'HEAD') return null;
  return { kind: 'action', page: path, detail: { method, status } };
}

/** After a request to /admin/*: one line on the timeline, when it is worth one. */
export async function recordAdminRequest(adminId: string, method: string, url: URL, status: number, ip: string | null): Promise<void> {
  const described = describeAdminRequest(method, url, status);
  if (!described) return;
  recordAdminActivity({ ...described, adminId, adminName: await adminNameOf(adminId), ip });
}
