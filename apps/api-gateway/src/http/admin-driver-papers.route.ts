import type { IncomingMessage, ServerResponse } from 'http';
import { DRIVER_PAPERS, DRIVER_PAPER_SOON_DAYS, driverPaper } from '@wheleers/config';
import { driverClient, driverPaperClient } from '@wheleers/db';
import { clientIp, recordAdminActivity } from '../admin/activity';
import { notifyPaperDecision, type PaperNotifyDeps } from '../drivers/paper-notify';
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
 * A paper sent back needs a reason: it is what the driver is told. The driver
 * gets a push and an in-app notification either way.
 * Returns false when the path is not one of these.
 */
export async function handleAdminDriverPapersRoute(req: IncomingMessage, res: ServerResponse, deps: AdminPapersDeps, url: URL): Promise<boolean> {
  const one = /^\/admin\/drivers\/([^/]+)\/papers$/.exec(url.pathname);
  const review = /^\/admin\/drivers\/([^/]+)\/papers\/([^/]+)\/review$/.exec(url.pathname);
  if (url.pathname !== '/admin/driver-papers' && !one && !review) return false;

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
      })),
    });
    return true;
  }

  const driverId = (one ?? review)![1]!;
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
