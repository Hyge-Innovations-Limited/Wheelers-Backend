import type { IncomingMessage, ServerResponse } from 'http';
import { readJsonBody, sendJson } from './utils';
import { verifyAdminAuth } from './admin-auth.route';
import { recordCapture } from './admin-team.route';
import type { AdminAlertDeps } from '../admin/activity';

interface Deps extends AdminAlertDeps {
  jwtSecret: string;
  adminApiKey: string;
}

const KINDS = new Set(['capture-shortcut', 'print-screen', 'browser-capture', 'print', 'save-page']);

/**
 * POST /admin/security/capture-attempt   { kind, page }
 *
 * The admin panel cannot stop a screenshot, but it notices most attempts and
 * says so here. One line in the log, with the admin's name: who, what they
 * pressed, which page they were on, and from where.
 *
 *   pm2 logs api-gateway | grep admin-security
 */
export async function handleAdminSecurityRoute(req: IncomingMessage, res: ServerResponse, deps: Deps, url: URL): Promise<boolean> {
  if (url.pathname !== '/admin/security/capture-attempt') return false;
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }
  const admin = await verifyAdminAuth(req, deps);
  if (!admin) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }
  const body = ((await readJsonBody(req).catch(() => null)) ?? {}) as Record<string, unknown>;
  const kind = typeof body.kind === 'string' && KINDS.has(body.kind) ? body.kind : 'unknown';
  const page = typeof body.page === 'string' ? body.page.slice(0, 200).replace(/[^\w\-/.()]/g, '') : null;
  const forwarded = req.headers['x-forwarded-for'];
  const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined) ?? req.socket.remoteAddress ?? null;
  const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 200) : null;

  console.warn('[admin-security] screenshot attempt', { admin: admin.adminName, kind, page, ip, userAgent });
  await recordCapture(deps, admin, page, kind, ip);
  sendJson(res, 200, { ok: true });
  return true;
}
