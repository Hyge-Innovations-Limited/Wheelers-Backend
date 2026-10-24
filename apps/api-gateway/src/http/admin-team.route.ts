import type { IncomingMessage, ServerResponse } from 'http';
import { adminActivityClient, adminClient, prisma } from '@wheleers/db';
import { BALANCE_ACCESS_MS } from './admin-desk.route';
import { adminMarkCode, clientIp, recordAdminActivity } from '../admin/activity';
import { forgetAdmin, verifyAdminAuth, type AdminAuth } from './admin-auth.route';
import { readJsonBody, sendJson } from './utils';

interface TeamDeps {
  adminApiKey: string;
  jwtSecret: string;
}

/**
 * The admin team:
 *   GET   /admin/me                     who is signed in, their role and mark code
 *   POST  /admin/activity               the dashboard reports a page opened or a screenshot shortcut
 *   GET   /admin/team                   owners: every admin, role, last seen, flags
 *   PATCH /admin/team/:id               owners: { role: OWNER | STAFF | SUPPORT }
 *   GET   /admin/team/activity          owners: the timeline (?adminId&kind&flagged=1&before&limit)
 *   GET   /admin/team/flags             owners: flagged events in the last 24 hours and balance requests waiting (the sidebar badge)
 *   GET   /admin/team/trace?code=       owners: whose mark is this
 *   GET   /admin/team/balance-requests  owners: support asking to see someone's wallet balance
 *   POST  /admin/team/balance-requests/:id/approve|deny   owners: yes (for an hour) or no
 * Returns false when the path is not one of these.
 */
export async function handleAdminTeamRoute(req: IncomingMessage, res: ServerResponse, deps: TeamDeps, url: URL): Promise<boolean> {
  const path = url.pathname;
  const isTeam = path === '/admin/me' || path === '/admin/activity' || path === '/admin/team' || path.startsWith('/admin/team/');
  if (!isTeam) return false;

  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }

  if (path === '/admin/me' && req.method === 'GET') {
    const admin = auth.adminId ? await adminClient.findById(auth.adminId) : null;
    sendJson(res, 200, {
      id: auth.adminId,
      username: admin?.username ?? 'api-key',
      name: auth.adminName,
      role: auth.role,
      markCode: auth.adminId ? adminMarkCode(auth.adminId, deps.jwtSecret) : null,
    });
    return true;
  }

  if (path === '/admin/activity' && req.method === 'POST') {
    const body = ((await readJsonBody(req).catch(() => null)) ?? {}) as Record<string, unknown>;
    const page = typeof body.page === 'string' ? body.page.slice(0, 300) : null;
    if (body.kind === 'capture') {
      const key = typeof body.key === 'string' ? body.key.slice(0, 40) : null;
      recordCapture(auth, page, key, clientIp(req));
    } else if (body.kind === 'page' && page) {
      recordAdminActivity({ adminId: auth.adminId, adminName: auth.adminName, kind: 'page', page, ip: clientIp(req) });
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  // Everything below is the owners' view of the team.
  if (auth.role !== 'OWNER') {
    sendJson(res, 404, { error: 'Not found' });
    return true;
  }

  if (path === '/admin/team' && req.method === 'GET') {
    const now = new Date();
    const todayStart = new Date(now.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }) + 'T00:00:00+01:00');
    const [admins, summaries] = await Promise.all([
      adminClient.list(),
      adminActivityClient.summaries(todayStart, new Date(now.getTime() - 7 * 86400_000)),
    ]);
    sendJson(res, 200, {
      admins: admins.map((a) => ({
        ...a,
        markCode: adminMarkCode(a.id, deps.jwtSecret),
        lastSeenAt: summaries.get(a.id)?.lastSeenAt ?? null,
        today: summaries.get(a.id)?.today ?? 0,
        flagsThisWeek: summaries.get(a.id)?.flagsThisWeek ?? 0,
        isYou: a.id === auth.adminId,
      })),
    });
    return true;
  }

  const roleMatch = path.match(/^\/admin\/team\/([^/]+)$/);
  if (roleMatch && req.method === 'PATCH' && !['activity', 'flags', 'trace', 'balance-requests'].includes(roleMatch[1]!)) {
    const body = ((await readJsonBody(req).catch(() => null)) ?? {}) as Record<string, unknown>;
    const role = body.role === 'OWNER' || body.role === 'STAFF' || body.role === 'SUPPORT' ? body.role : null;
    if (!role) {
      sendJson(res, 400, { error: 'role must be OWNER, STAFF or SUPPORT' });
      return true;
    }
    const target = await adminClient.findById(roleMatch[1]!);
    if (!target) {
      sendJson(res, 404, { error: 'No such admin' });
      return true;
    }
    const updated = await adminClient.setRole(target.id, role);
    forgetAdmin(target.id);
    if (!updated) {
      sendJson(res, 409, { error: 'There must always be at least one owner.' });
      return true;
    }
    recordAdminActivity({
      adminId: auth.adminId, adminName: auth.adminName, kind: 'role-change', ip: clientIp(req),
      detail: { admin: target.name, from: target.role, to: role },
    });
    sendJson(res, 200, { id: updated.id, role: updated.role });
    return true;
  }

  if (path === '/admin/team/activity' && req.method === 'GET') {
    const before = url.searchParams.get('before');
    const rows = await adminActivityClient.list({
      adminId: url.searchParams.get('adminId') || undefined,
      kind: url.searchParams.get('kind') || undefined,
      flagged: url.searchParams.get('flagged') === '1',
      before: before && !Number.isNaN(Date.parse(before)) ? new Date(before) : undefined,
      limit: Number(url.searchParams.get('limit')) || 50,
    });
    sendJson(res, 200, { rows, next: rows.length ? rows[rows.length - 1]!.createdAt : null });
    return true;
  }

  if (path === '/admin/team/flags' && req.method === 'GET') {
    const [last24h, balanceRequests] = await Promise.all([
      adminActivityClient.flaggedSince(new Date(Date.now() - 86400_000)),
      prisma.balanceAccessRequest.count({ where: { status: 'PENDING' } }),
    ]);
    sendJson(res, 200, { last24h, balanceRequests });
    return true;
  }

  // Support asking to see someone's wallet balance: waiting first, then the last decided.
  if (path === '/admin/team/balance-requests' && req.method === 'GET') {
    const rows = await prisma.balanceAccessRequest.findMany({ orderBy: [{ status: 'desc' }, { createdAt: 'desc' }], take: 40 });
    const people = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId))] } }, select: { id: true, name: true, phone: true } });
    const who = new Map(people.map((p) => [p.id, p]));
    sendJson(res, 200, {
      requests: rows
        .sort((a, b) => Number(b.status === 'PENDING') - Number(a.status === 'PENDING') || b.createdAt.getTime() - a.createdAt.getTime())
        .map((r) => ({
          id: r.id,
          askedBy: r.adminName,
          person: { id: r.userId, name: who.get(r.userId)?.name ?? 'No name yet', phone: who.get(r.userId)?.phone ?? null },
          reason: r.reason,
          status: r.status === 'APPROVED' && r.expiresAt && r.expiresAt.getTime() <= Date.now() ? 'EXPIRED' : r.status,
          decidedBy: r.decidedByName,
          askedAt: r.createdAt.toISOString(),
          expiresAt: r.expiresAt?.toISOString() ?? null,
        })),
    });
    return true;
  }

  const decide = path.match(/^\/admin\/team\/balance-requests\/([^/]+)\/(approve|deny)$/);
  if (decide && req.method === 'POST') {
    const request = await prisma.balanceAccessRequest.findUnique({ where: { id: decide[1]! } });
    if (!request) {
      sendJson(res, 404, { error: 'No such request' });
      return true;
    }
    if (request.status !== 'PENDING') {
      sendJson(res, 409, { error: `Already ${request.status === 'APPROVED' ? 'approved' : 'declined'} by ${request.decidedByName ?? 'an owner'}.` });
      return true;
    }
    const approve = decide[2] === 'approve';
    const now = new Date();
    const updated = await prisma.balanceAccessRequest.update({
      where: { id: request.id },
      data: {
        status: approve ? 'APPROVED' : 'DENIED',
        decidedById: auth.adminId, decidedByName: auth.adminName, decidedAt: now,
        expiresAt: approve ? new Date(now.getTime() + BALANCE_ACCESS_MS) : null,
      },
    });
    recordAdminActivity({
      adminId: auth.adminId, adminName: auth.adminName, kind: 'action', ip: clientIp(req),
      detail: { what: approve ? 'let support see a wallet balance' : 'declined support seeing a wallet balance', for: request.adminName, userId: request.userId, reason: request.reason },
    });
    sendJson(res, 200, { id: updated.id, status: updated.status, expiresAt: updated.expiresAt?.toISOString() ?? null });
    return true;
  }

  if (path === '/admin/team/trace' && req.method === 'GET') {
    const code = (url.searchParams.get('code') ?? '').trim().toUpperCase();
    const admins = await adminClient.list();
    const match = admins.find((a) => adminMarkCode(a.id, deps.jwtSecret) === code);
    sendJson(res, 200, { code, admin: match ? { id: match.id, name: match.name, username: match.username, role: match.role } : null });
    return true;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
  return true;
}

/** A screenshot shortcut: on the timeline, flagged red for the owners. */
export function recordCapture(auth: AdminAuth, page: string | null, key: string | null, ip: string | null): void {
  recordAdminActivity({ adminId: auth.adminId, adminName: auth.adminName, kind: 'screenshot', page, flagged: true, ip, detail: key ? { key } : null });
}
