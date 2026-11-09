import type { IncomingMessage, ServerResponse } from 'http';
import { DRIVER_PAPERS, DRIVER_PAPER_SOON_DAYS, driverPaper } from '@wheleers/config';
import { driverCheckClient, driverClient, driverPaperClient } from '@wheleers/db';
import { clientIp, recordAdminActivity } from '../admin/activity';
import { notifyPaperDecision, notifyPaperDecisions, type PaperNotifyDeps } from '../drivers/paper-notify';
import type { DriverKycStorage } from '../storage/driver-kyc-storage';
import { isRecord, getString } from '../utils/object';
import { verifyAdminAuth } from './admin-auth.route';
import { driverPapersView, lagosToday } from './driver-papers.route';
import { readJsonBody, sendJson } from './utils';

interface AdminPapersDeps extends PaperNotifyDeps {
  adminApiKey: string;
  jwtSecret: string;
  /** To open a paper. Null when storage is not configured: lists still work, files do not open. */
  kycStorage: Pick<DriverKycStorage, 'getSignedUrl'> | null;
}

const DAY_MS = 86_400_000;
const FILTERS = ['waiting', 'expiring', 'expired', 'sentBack'] as const;
type Filter = (typeof FILTERS)[number];
const day = (date: Date | null | undefined) => (date ? date.toISOString().slice(0, 10) : null);
const labelOf = (type: string) => DRIVER_PAPERS.find((p) => p.type === type)?.label ?? type;

/**
 * Drivers' papers, for the admin:
 *   GET  /admin/driver-papers?filter=waiting|expiring|expired|sentBack   the lists, with how many are in each
 *   GET  /admin/drivers/:id/papers                                       one driver: details, every paper, a link to open each
 *   POST /admin/drivers/:id/papers/:type/review  { decision: "approve" | "reject", reason? }
 *   POST /admin/drivers/:id/papers/decide        { decisions: [{ type, decision: "approve" | "reject", reason? }] }
 *   POST /admin/driver-papers/approve            { items: [{ driverId, type }] }   many drivers' papers at once
 * A paper sent back needs a reason: it is what the driver is told. The driver
 * gets a push and an in-app notification either way: for `decide`, ONE that
 * lists everything to send again and how many were approved; for the bulk
 * approve, one for each driver. `decide` checks every decision first and
 * saves none if any is wrong. The bulk approve takes only papers still
 * waiting and in date, and says which it passed over and why.
 * Returns false when the path is not one of these.
 */
export async function handleAdminDriverPapersRoute(req: IncomingMessage, res: ServerResponse, deps: AdminPapersDeps, url: URL): Promise<boolean> {
  const one = /^\/admin\/drivers\/([^/]+)\/papers$/.exec(url.pathname);
  const review = /^\/admin\/drivers\/([^/]+)\/papers\/([^/]+)\/review$/.exec(url.pathname);
  const decide = /^\/admin\/drivers\/([^/]+)\/papers\/decide$/.exec(url.pathname);
  const bulk = url.pathname === '/admin/driver-papers/approve';
  if (url.pathname !== '/admin/driver-papers' && !one && !review && !decide && !bulk) return false;

  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }
  const today = lagosToday();
  const soon = new Date(today.getTime() + DRIVER_PAPER_SOON_DAYS * DAY_MS);

  if (url.pathname === '/admin/driver-papers') {
    if (req.method !== 'GET') { sendJson(res, 405, { error: 'Method not allowed' }); return true; }
    const asked = url.searchParams.get('filter') ?? 'waiting';
    const filter: Filter = (FILTERS as readonly string[]).includes(asked) ? (asked as Filter) : 'waiting';
    const [rows, counts] = await Promise.all([driverPaperClient.queue(filter, today, soon), driverPaperClient.counts(today, soon)]);
    // Each driver's latest answer for each check, newest first: what the list shows beside their papers.
    const checks = new Map<string, Array<{ kind: string; paperType: string | null; source: string; outcome: string }>>();
    for (const c of await driverCheckClient.forDrivers([...new Set(rows.map((r) => r.driverId))]).catch(() => [])) {
      const list = checks.get(c.driverId) ?? [];
      if (!list.some((x) => x.kind === c.kind && x.paperType === c.paperType && x.source === c.source)) list.push({ kind: c.kind, paperType: c.paperType, source: c.source, outcome: c.outcome });
      checks.set(c.driverId, list);
    }
    sendJson(res, 200, {
      filter,
      counts,
      items: rows.map((doc) => ({
        driverId: doc.driverId,
        driverName: doc.driver.legalName ?? doc.driver.user.name ?? 'Unnamed driver',
        phone: doc.driver.user.phone,
        kycStatus: doc.driver.kycStatus,
        type: doc.type,
        label: labelOf(doc.type),
        status: doc.status,
        expired: Boolean(doc.expiresOn && doc.expiresOn.getTime() < today.getTime()),
        uploadedAt: doc.uploadedAt.toISOString(),
        expiresOn: day(doc.expiresOn),
        daysLeft: doc.expiresOn ? Math.round((doc.expiresOn.getTime() - today.getTime()) / DAY_MS) : null,
        rejectionReason: doc.rejectionReason,
        checks: checks.get(doc.driverId) ?? [],
      })),
    });
    return true;
  }

  if (bulk) {
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed' }); return true; }
    const body = await readJsonBody(req).catch(() => null);
    const raw = isRecord(body) && Array.isArray(body.items) ? body.items : null;
    if (!raw || raw.length === 0 || raw.length > 200) {
      sendJson(res, 400, { error: 'items must list 1 to 200 papers: [{ driverId, type }]' });
      return true;
    }
    const asked = new Map<string, { driverId: string; type: string }>();
    for (const item of raw) {
      const driverId = isRecord(item) ? getString(item, 'driverId') : null;
      const type = isRecord(item) ? getString(item, 'type') : null;
      if (driverId && type && driverPaper(type)) asked.set(`${driverId}:${type}`, { driverId, type });
    }
    const docs = await driverPaperClient.findMany([...asked.values()]);
    const found = new Map(docs.map((d) => [`${d.driverId}:${d.type}`, d]));
    const skipped: Array<{ driverId: string; type: string; why: string }> = [];
    const approvedBy = new Map<string, { userId: string; types: string[] }>();
    for (const [key, item] of asked) {
      const doc = found.get(key);
      if (!doc) { skipped.push({ ...item, why: 'not sent' }); continue; }
      if (doc.status !== 'PENDING') { skipped.push({ ...item, why: doc.status === 'APPROVED' ? 'already approved' : 'sent back' }); continue; }
      if (doc.expiresOn && doc.expiresOn.getTime() < today.getTime()) { skipped.push({ ...item, why: 'expired' }); continue; }
      await driverPaperClient.review(item.driverId, item.type, { status: 'APPROVED', reason: null, by: auth.adminName });
      const mine = approvedBy.get(item.driverId) ?? { userId: doc.driver.userId, types: [] };
      mine.types.push(item.type);
      approvedBy.set(item.driverId, mine);
    }
    const approved = [...approvedBy.entries()].flatMap(([driverId, d]) => d.types.map((type) => ({ driverId, type })));
    if (approved.length) {
      recordAdminActivity({
        adminId: auth.adminId, adminName: auth.adminName, kind: 'action', page: '/admin/dashboard/driver-papers',
        detail: { what: 'approved papers in bulk', papers: approved.length, drivers: approvedBy.size },
        ip: clientIp(req),
      });
    }
    for (const d of approvedBy.values()) void notifyPaperDecisions(deps, d.userId, { approved: d.types, sentBack: [] });
    sendJson(res, 200, { ok: true, approved, skipped });
    return true;
  }

  const driverId = decodeURIComponent((one ?? review ?? decide)![1]!);
  const driver = await driverClient.findById(driverId).catch(() => null);
  if (!driver) {
    sendJson(res, 404, { error: 'Driver not found' });
    return true;
  }

  if (one) {
    if (req.method !== 'GET') { sendJson(res, 405, { error: 'Method not allowed' }); return true; }
    const [view, docs] = await Promise.all([driverPapersView(driverId), driverPaperClient.listForDriver(driverId)]);
    const stored = new Map(docs.map((doc) => [doc.type, doc]));
    const storage = deps.kycStorage;
    const needs = await Promise.all(view.needs.map(async (need) => ({
      ...need,
      papers: await Promise.all(need.papers.map(async (paper) => {
        const doc = stored.get(paper.type);
        return {
          ...paper,
          document: paper.document && doc ? {
            ...paper.document,
            // Why it was sent back stays on the admin's view even once it is past its date.
            rejectionReason: doc.rejectionReason,
            status: doc.status,
            fileType: doc.fileType,
            url: storage
              ? await storage.getSignedUrl(doc.fileKey, 3600, doc.fileType === 'application/pdf' ? 'application/pdf' : undefined).catch(() => null)
              : null,
            reviewedAt: doc.reviewedAt?.toISOString() ?? null,
            reviewedBy: doc.reviewedBy,
          } : null,
        };
      })),
    })));
    sendJson(res, 200, {
      driver: { id: driver.id, name: driver.user?.name ?? null, phone: driver.user?.phone ?? null, kycStatus: driver.kycStatus },
      details: view.details,
      toDo: view.toDo,
      requiredFrom: view.requiredFrom,
      blocked: view.blocked,
      needs,
    });
    return true;
  }

  if (decide) {
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed' }); return true; }
    const body = await readJsonBody(req).catch(() => null);
    const raw = isRecord(body) && Array.isArray(body.decisions) ? body.decisions : null;
    if (!raw || raw.length === 0 || raw.length > DRIVER_PAPERS.length) {
      sendJson(res, 400, { error: 'decisions must list the papers decided: [{ type, decision, reason? }]' });
      return true;
    }
    const docs = new Map((await driverPaperClient.listForDriver(driverId)).map((d) => [d.type, d]));
    const errors: Array<{ type: string; error: string }> = [];
    const plan: Array<{ type: string; label: string; decision: 'approve' | 'reject'; reason: string }> = [];
    for (const item of raw) {
      const type = isRecord(item) ? getString(item, 'type') ?? '' : '';
      const decision = isRecord(item) ? getString(item, 'decision') : null;
      const reason = isRecord(item) ? (getString(item, 'reason') ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) : '';
      const paper = driverPaper(type);
      const doc = paper ? docs.get(paper.type) : undefined;
      if (!paper || !doc) { errors.push({ type, error: 'This driver has not sent that paper.' }); continue; }
      if (plan.some((p) => p.type === paper.type)) { errors.push({ type, error: 'Decided twice.' }); continue; }
      if (decision !== 'approve' && decision !== 'reject') { errors.push({ type, error: 'decision must be "approve" or "reject"' }); continue; }
      if (decision === 'reject' && reason.length < 4) { errors.push({ type, error: `Say why the ${paper.label.toLowerCase()} is being sent back: the driver is told this.` }); continue; }
      if (decision === 'approve' && doc.expiresOn && doc.expiresOn.getTime() < today.getTime()) { errors.push({ type, error: `The ${paper.label.toLowerCase()} has expired: it cannot be approved.` }); continue; }
      // Approving what is already approved changes nothing and tells the driver nothing.
      if (decision === 'approve' && doc.status === 'APPROVED') continue;
      plan.push({ type: paper.type, label: paper.label, decision, reason });
    }
    if (errors.length) {
      sendJson(res, 400, { error: errors[0]!.error, errors, code: 'DECISIONS_REFUSED' });
      return true;
    }
    for (const p of plan) {
      await driverPaperClient.review(driverId, p.type, { status: p.decision === 'approve' ? 'APPROVED' : 'REJECTED', reason: p.decision === 'reject' ? p.reason : null, by: auth.adminName });
    }
    const approved = plan.filter((p) => p.decision === 'approve').map((p) => p.type);
    const sentBack = plan.filter((p) => p.decision === 'reject').map((p) => ({ type: p.type, reason: p.reason }));
    if (plan.length) {
      recordAdminActivity({
        adminId: auth.adminId, adminName: auth.adminName, kind: 'action', page: `/admin/dashboard/drivers/${driverId}`,
        detail: {
          what: 'decided papers', driverId,
          ...(approved.length ? { approved: plan.filter((p) => p.decision === 'approve').map((p) => p.label).join(', ') } : {}),
          ...(sentBack.length ? { sentBack: plan.filter((p) => p.decision === 'reject').map((p) => `${p.label}: ${p.reason}`).join(' | ') } : {}),
        },
        ip: clientIp(req),
      });
    }
    void notifyPaperDecisions(deps, driver.userId, { approved, sentBack });
    sendJson(res, 200, { ok: true, approved, sentBack: sentBack.map((p) => p.type), toDo: (await driverPapersView(driverId)).toDo });
    return true;
  }

  // review
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed' }); return true; }
  const paper = driverPaper(decodeURIComponent(review![2]!));
  const existing = paper ? await driverPaperClient.find(driverId, paper.type) : null;
  if (!paper || !existing) {
    sendJson(res, 404, { error: 'This driver has not sent that paper.' });
    return true;
  }
  const body = await readJsonBody(req).catch(() => null);
  const decision = isRecord(body) ? getString(body, 'decision') : null;
  const reason = isRecord(body) ? (getString(body, 'reason') ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  if (decision !== 'approve' && decision !== 'reject') {
    sendJson(res, 400, { error: 'decision must be "approve" or "reject"' });
    return true;
  }
  if (decision === 'reject' && reason.length < 4) {
    sendJson(res, 400, { error: 'Say why it is being sent back: the driver is told this.', code: 'REASON_NEEDED' });
    return true;
  }
  if (decision === 'approve' && existing.expiresOn && existing.expiresOn.getTime() < today.getTime()) {
    sendJson(res, 409, { error: 'This paper has expired. It cannot be approved: the driver must send the renewed one.', code: 'EXPIRED' });
    return true;
  }

  const status = decision === 'approve' ? 'APPROVED' : 'REJECTED';
  await driverPaperClient.review(driverId, paper.type, { status, reason: reason || null, by: auth.adminName });
  recordAdminActivity({
    adminId: auth.adminId, adminName: auth.adminName, kind: 'action', page: `/admin/dashboard/drivers/${driverId}`,
    detail: { what: decision === 'approve' ? 'approved a paper' : 'sent a paper back', paper: paper.label, driverId, ...(reason ? { reason } : {}) },
    ip: clientIp(req),
  });
  void notifyPaperDecision(deps, driver.userId, { type: paper.type, outcome: status, reason: reason || null });
  sendJson(res, 200, { ok: true, type: paper.type, status, toDo: (await driverPapersView(driverId)).toDo });
  return true;
}
