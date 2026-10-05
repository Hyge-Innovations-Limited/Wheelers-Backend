import { createHmac } from 'node:crypto';
import type { IncomingMessage } from 'http';
import { adminActivityClient, adminClient, type AdminActivityInput } from '@wheleers/db';
import type { RedisClient } from '../redis/client';
import { sendEmail } from '../email/resend';

/**
 * What admins do in the dashboard, recorded for the owners' Team activity
 * page. Recording never slows or fails a request: it happens after, and a
 * failure is logged and dropped.
 */

export type AdminRoleName = 'OWNER' | 'STAFF';

export interface AdminAlertDeps {
  redis?: RedisClient;
  resendApiKey?: string;
  /** Who is emailed when staff take a screenshot or try to download: OWNER_ALERT_EMAILS, comma separated. */
  ownerEmails?: string[];
}

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

const lagosTime = (at = new Date()) => at.toLocaleString('en-NG', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' });

/**
 * An email to the owners when staff do something they should know about.
 * At most one per admin per 10 minutes, so a burst of key presses is one email.
 */
export async function alertOwners(deps: AdminAlertDeps, event: { adminId: string | null; adminName: string; what: string; page?: string | null }): Promise<void> {
  const emails = deps.ownerEmails ?? [];
  if (!deps.resendApiKey || emails.length === 0) return;
  if (deps.redis) {
    const first = await deps.redis.send('SET', `admin:alert:${event.adminId ?? event.adminName}`, '1', 'EX', '600', 'NX').catch(() => 'OK');
    if (first !== 'OK') return;
  }
  const html = `<p><strong>${escapeHtml(event.adminName)}</strong> ${escapeHtml(event.what)}${event.page ? ` on <code>${escapeHtml(event.page)}</code>` : ''}.</p>
<p>${lagosTime()} (Lagos). The full record is on the Team page of the admin dashboard.</p>`;
  for (const to of emails) {
    await sendEmail({
      to,
      subject: `Wheelers admin: ${event.adminName} ${event.what}`.slice(0, 120),
      html,
      from: 'Wheelers <hello@wheelersng.com>',
    }, deps.resendApiKey).catch((error) => console.warn('[admin-activity] owner alert not sent', { error: error instanceof Error ? error.message : String(error) }));
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function ownerEmailsFromEnv(raw = process.env['OWNER_ALERT_EMAILS']): string[] {
  return (raw ?? '').split(',').map((e) => e.trim()).filter((e) => /.+@.+\..+/.test(e));
}
