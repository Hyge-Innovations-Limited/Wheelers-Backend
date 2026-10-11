import type { IncomingMessage, ServerResponse } from 'http';
import { DRIVER_PAPERS, DRIVER_PAPER_NEEDS, DRIVER_PAPER_SOON_DAYS, driverPaper, type DriverPaper } from '@wheleers/config';
import { driverClient, driverPaperClient } from '@wheleers/db';
import { verifyLocalAccessToken } from '../auth/local';
import { logActivity } from '../analytics/log-activity';
import { isRecord, getString } from '../utils/object';
import { sniffKycFileType, type DriverKycStorage } from '../storage/driver-kyc-storage';
import { readJsonBody, sendJson } from './utils';

interface DriverPapersDeps {
  jwtSecret: string;
  /** Where files go. Null when storage is not configured: papers can be read, not sent. */
  kycStorage: Pick<DriverKycStorage, 'upload'> | null;
}

/** How a paper stands, as the driver is told it. */
export type PaperState = 'missing' | 'waiting' | 'approved' | 'rejected' | 'expired';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const DAY_MS = 86_400_000;

function userIdOf(req: IncomingMessage, jwtSecret: string): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  try {
    return verifyLocalAccessToken(header.slice(7), jwtSecret).sub;
  } catch {
    return null;
  }
}

/** Today in Lagos (UTC+1), as the date-only value dates are stored as. */
export function lagosToday(now = new Date()): Date {
  const lagos = new Date(now.getTime() + 60 * 60_000);
  return new Date(Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), lagos.getUTCDate()));
}

/** "2027-03-31" → that day, or null when it is not a real date. */
export function parseDay(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

const day = (date: Date | null | undefined) => (date ? date.toISOString().slice(0, 10) : null);

/**
 * The day from which a driver needs their papers in to go online, when one
 * has been set (DRIVER_PAPERS_REQUIRED_FROM=2026-11-15 in .env). Not set:
 * papers are asked for and shown, and block nobody.
 */
export function papersRequiredFrom(): Date | null {
  return parseDay(process.env.DRIVER_PAPERS_REQUIRED_FROM);
}

export type DriverDetails = { legalName: string; licenceNumber: string; licenceExpiresOn: Date };

/** The name and licence details as typed, cleaned and checked. The error is in the driver's words. */
export function readDriverDetails(body: Record<string, unknown>, today: Date): { ok: true; details: DriverDetails } | { ok: false; error: string; code: string } {
  const legalName = (getString(body, 'legalName') ?? '').replace(/\s+/g, ' ').trim();
  const licenceNumber = (getString(body, 'licenceNumber') ?? '').replace(/\s+/g, '').toUpperCase();
  const licenceExpiresOn = parseDay(body.licenceExpiresOn);
  if (legalName.length < 5 || legalName.length > 80 || !legalName.includes(' ') || !/^[\p{L}][\p{L} .'’-]*$/u.test(legalName)) {
    return { ok: false, error: 'Enter your full name as it is on your licence: first name and surname.', code: 'BAD_NAME' };
  }
  if (!/^[A-Z0-9]{6,20}$/.test(licenceNumber)) {
    return { ok: false, error: 'Enter the licence number as it is on your licence: letters and numbers only.', code: 'BAD_LICENCE_NUMBER' };
  }
  if (!licenceExpiresOn) return { ok: false, error: 'Enter the date your licence expires.', code: 'BAD_DATE' };
  if (licenceExpiresOn.getTime() < today.getTime()) {
    return { ok: false, error: 'That licence has expired. Renew it, then enter the new date.', code: 'EXPIRED' };
  }
  return { ok: true, details: { legalName, licenceNumber, licenceExpiresOn } };
}

type Stored = Awaited<ReturnType<typeof driverPaperClient.listForDriver>>[number];

function stateOf(paper: DriverPaper, doc: Stored | undefined, today: Date): PaperState {
  if (!doc) return 'missing';
  // A paper past its date is no paper, whatever a reviewer said of it while it was good.
  if (paper.expires && doc.expiresOn && doc.expiresOn.getTime() < today.getTime()) return 'expired';
  return doc.status === 'APPROVED' ? 'approved' : doc.status === 'REJECTED' ? 'rejected' : 'waiting';
}

// When several papers can meet one need, the need stands as well as the best of them.
const RANK: Record<PaperState, number> = { approved: 4, waiting: 3, rejected: 2, expired: 1, missing: 0 };

/** Everything the app's papers screen shows: the typed details, each need and its papers, and how many things are still to do. */
export async function driverPapersView(driverId: string, now = new Date()) {
  const [docs, details] = await Promise.all([driverPaperClient.listForDriver(driverId), driverPaperClient.details(driverId)]);
  const today = lagosToday(now);
  const byType = new Map(docs.map((doc) => [doc.type, doc]));

  const needs = DRIVER_PAPER_NEEDS.map((need) => {
    const papers = need.anyOf.map((type) => {
      const paper = DRIVER_PAPERS.find((p) => p.type === type)!;
      const doc = byType.get(type);
      const state = stateOf(paper, doc, today);
      const daysLeft = doc?.expiresOn ? Math.round((doc.expiresOn.getTime() - today.getTime()) / DAY_MS) : null;
      return {
        type: paper.type, label: paper.label, hint: paper.hint, expires: paper.expires, numbered: paper.numbered,
        document: doc ? {
          state,
          number: doc.number,
          expiresOn: day(doc.expiresOn),
          uploadedAt: doc.uploadedAt.toISOString(),
          rejectionReason: state === 'rejected' ? doc.rejectionReason : null,
          // Still good, but for less than a month: time to renew.
          expiringSoon: paper.expires && daysLeft !== null && daysLeft >= 0 && daysLeft <= DRIVER_PAPER_SOON_DAYS,
          daysLeft: paper.expires ? daysLeft : null,
        } : null,
      };
    });
    const state = papers.reduce<PaperState>((best, p) => (RANK[p.document?.state ?? 'missing'] > RANK[best] ? p.document!.state : best), 'missing');
    return { key: need.key, label: need.label, required: need.required, state, papers };
  });

  const licenceExpired = Boolean(details?.licenceExpiresOn && details.licenceExpiresOn.getTime() < today.getTime());
  const detailsComplete = Boolean(details?.legalName && details.licenceNumber && details.licenceExpiresOn) && !licenceExpired;
  // What the driver still has to do: a required need with nothing good against it, or the details.
  const toDo = needs.filter((n) => n.required && (n.state === 'missing' || n.state === 'rejected' || n.state === 'expired')).length + (detailsComplete ? 0 : 1);

  const requiredFrom = papersRequiredFrom();
  return {
    // The day papers start to be needed to go online (null: no such day is set), and whether this driver is stopped by it now.
    requiredFrom: day(requiredFrom),
    blocked: Boolean(requiredFrom && today.getTime() >= requiredFrom.getTime() && toDo > 0),
    details: {
      legalName: details?.legalName ?? null,
      licenceNumber: details?.licenceNumber ?? null,
      licenceExpiresOn: day(details?.licenceExpiresOn),
      licenceExpired,
      complete: detailsComplete,
    },
    needs,
    toDo,
    expiringSoon: needs.flatMap((n) => n.papers).filter((p) => p.document?.expiringSoon).map((p) => p.label),
  };
}

async function driverOf(req: IncomingMessage, res: ServerResponse, deps: Pick<DriverPapersDeps, 'jwtSecret'>) {
  const userId = userIdOf(req, deps.jwtSecret);
  if (!userId) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return null;
  }
  const driver = await driverClient.findByUserId(userId);
  if (!driver) {
    sendJson(res, 404, { error: 'Driver record not found' });
    return null;
  }
  return { userId, driver };
}

/**
 * The driver's papers and typed details:
 *   GET /drivers/papers           what is needed, what has been sent and how each stands
 *   POST /drivers/papers          one paper: { type, file (base64 photo or PDF), expiresOn?, number? }
 *   PUT /drivers/papers/details   { legalName, licenceNumber, licenceExpiresOn }
 * A paper sent again replaces the one before and waits for review again.
 * Returns false when the path is not one of these.
 */
export async function handleDriverPapersRoute(req: IncomingMessage, res: ServerResponse, deps: DriverPapersDeps, url: URL): Promise<boolean> {
  if (url.pathname !== '/drivers/papers' && url.pathname !== '/drivers/papers/details') return false;
  const who = await driverOf(req, res, deps);
  if (!who) return true;
  const { userId, driver } = who;

  if (url.pathname === '/drivers/papers' && req.method === 'GET') {
    sendJson(res, 200, await driverPapersView(driver.id));
    return true;
  }

  const body = await readJsonBody(req).catch(() => null);
  if (!isRecord(body)) {
    sendJson(res, 400, { error: 'Body must be a JSON object' });
    return true;
  }
  const today = lagosToday();

  if (url.pathname === '/drivers/papers/details' && req.method === 'PUT') {
    const read = readDriverDetails(body, today);
    if (!read.ok) {
      sendJson(res, 400, { error: read.error, code: read.code });
      return true;
    }
    await driverPaperClient.saveDetails(driver.id, read.details);
    logActivity({ userId, eventType: 'driver_details_saved', metadata: {} });
    sendJson(res, 200, await driverPapersView(driver.id));
    return true;
  }

  if (url.pathname === '/drivers/papers' && req.method === 'POST') {
    if (!deps.kycStorage) {
      sendJson(res, 503, { error: 'Papers cannot be sent right now. Please try again later.', code: 'STORAGE_OFF' });
      return true;
    }
    const paper = driverPaper(getString(body, 'type') ?? '');
    if (!paper) {
      sendJson(res, 400, { error: 'That is not a paper we ask for.', code: 'UNKNOWN_PAPER' });
      return true;
    }
    const file = getString(body, 'file');
    const bytes = file ? Buffer.from(file, 'base64') : Buffer.alloc(0);
    const fileType = sniffKycFileType(bytes);
    const looksReal = bytes.length >= 512 && (fileType !== 'image/jpeg' || (bytes[0] === 0xff && bytes[1] === 0xd8));
    if (!looksReal) {
      sendJson(res, 400, { error: 'Send a clear photo or a PDF of the paper.', code: 'BAD_FILE' });
      return true;
    }
    if (bytes.length > MAX_FILE_BYTES) {
      sendJson(res, 400, { error: 'That file is too big. Send one under 10 MB.', code: 'FILE_TOO_BIG' });
      return true;
    }
    let expiresOn: Date | null = null;
    if (paper.expires) {
      expiresOn = parseDay(body.expiresOn);
      if (!expiresOn) {
        sendJson(res, 400, { error: `Enter the date your ${paper.label.toLowerCase()} expires.`, code: 'BAD_DATE' });
        return true;
      }
      if (expiresOn.getTime() < today.getTime()) {
        sendJson(res, 400, { error: `That ${paper.label.toLowerCase()} has expired. Renew it, then send the new one.`, code: 'EXPIRED' });
        return true;
      }
      if (expiresOn.getTime() > today.getTime() + 15 * 366 * DAY_MS) {
        sendJson(res, 400, { error: 'Check the expiry date: that is too far away.', code: 'BAD_DATE' });
        return true;
      }
    }
    const number = paper.numbered ? ((getString(body, 'number') ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || null) : null;

    try {
      const fileKey = await deps.kycStorage.upload({ driverId: driver.id, type: `paper-${paper.type}`, imageBuffer: bytes, mimeType: fileType });
      await driverPaperClient.save({ driverId: driver.id, type: paper.type, fileKey, fileType, number, expiresOn });
    } catch (error) {
      console.error('[driver-papers] upload failed', { driverId: driver.id, type: paper.type, error: error instanceof Error ? error.message : String(error) });
      sendJson(res, 500, { error: 'Could not save that paper. Please try again.' });
      return true;
    }
    logActivity({ userId, eventType: 'driver_paper_sent', metadata: { type: paper.type } });
    sendJson(res, 200, await driverPapersView(driver.id));
    return true;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
  return true;
}
