import type { IncomingMessage, ServerResponse } from 'http';
import { DRIVER_PAPERS, driverPaper } from '@wheleers/config';
import { driverCheckClient, driverClient, driverPaperClient } from '@wheleers/db';
import { clientIp, recordAdminActivity } from '../admin/activity';
import type { DriverKycStorage } from '../storage/driver-kyc-storage';
import { isRecord, getString } from '../utils/object';
import { MANUAL_SOURCES, readDay, readInsurance, readLicence, readPlate, type Reading } from '../verification/driver-checks';
import { prembly, type PremblyAnswer, type PremblyConfig } from '../verification/prembly';
import { verifyAdminAuth } from './admin-auth.route';
import { lagosToday } from './driver-papers.route';
import { readJsonBody, sendJson } from './utils';

interface AdminChecksDeps {
  adminApiKey: string;
  jwtSecret: string;
  /** For the selfie a face check sends. Null when storage is not configured: face checks are off. */
  kycStorage: Pick<DriverKycStorage, 'getImageAsBase64'> | null;
  /** Null when PREMBLY_API_KEY is not set: the paid checks are off, the hand checks still work. */
  prembly: PremblyConfig | null;
  fetchImpl?: typeof fetch;
}

/** The same check on the same number within this long gives back the saved answer, not a new (paid) one, unless forced. */
const REUSE_DAYS = 30;
const DAY_MS = 86_400_000;
const PAID_KINDS = ['licence', 'plate', 'insurance'] as const;
type PaidKind = (typeof PAID_KINDS)[number];
const MANUAL_KEYS: readonly string[] = MANUAL_SOURCES.map((s) => s.key);
const labelOf = (type: string | null) => (type ? DRIVER_PAPERS.find((p) => p.type === type)?.label ?? type : null);
const day = (date: Date | null | undefined) => (date ? date.toISOString().slice(0, 10) : null);
const clean = (value: string | null | undefined, max = 300) => (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

type CheckRow = Awaited<ReturnType<typeof driverCheckClient.record>>;
const view = (c: CheckRow) => ({
  id: c.id,
  kind: c.kind,
  paperType: c.paperType,
  paperLabel: labelOf(c.paperType),
  source: c.source,
  input: c.input,
  outcome: c.outcome,
  mismatches: c.mismatches,
  found: c.found,
  reference: c.reference,
  note: c.note,
  by: c.byName,
  at: c.createdAt.toISOString(),
});

/** The first of the month, Lagos time: what "this month" counts from. */
function monthStart(now = new Date()): Date {
  const lagos = new Date(now.getTime() + 60 * 60_000);
  return new Date(Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), 1) - 60 * 60_000);
}

/**
 * Checking a driver's licence and car, for the admin:
 *   GET  /admin/drivers/:id/checks           every check so far, what a new one would send, and whether Prembly is on
 *   POST /admin/drivers/:id/checks/prembly   owners: { kind: "licence" | "plate" | "insurance", dob?, number?, firstName?, lastName?, withFace?, channel?, force? }
 *   POST /admin/drivers/:id/checks/manual    { paperType, source: "autoreg" | "dvis" | "niid" | "other", outcome: "verified" | "failed", note? }
 *
 * A Prembly check costs money, so only owners run one, and the same check on
 * the same number within 30 days gives back the saved answer unless `force`.
 * What comes back is kept as key fields (names, dates, make, colour, policy
 * status) with what does not agree with what the driver gave us; the licence
 * photo is shown in the answer once and never kept.
 *
 * A hand check is one an admin did on a government site (AutoReg, DVIS,
 * NIID) or by other means, recorded with a note: failing one needs the note.
 * Neither approves or sends back a paper: that stays the admin's decision.
 * Returns false when the path is not one of these.
 */
export async function handleAdminDriverChecksRoute(req: IncomingMessage, res: ServerResponse, deps: AdminChecksDeps, url: URL): Promise<boolean> {
  const match = /^\/admin\/drivers\/([^/]+)\/checks(?:\/(prembly|manual))?$/.exec(url.pathname);
  if (!match) return false;
  const action = match[2] ?? null;

  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }
  if ((action === null && req.method !== 'GET') || (action !== null && req.method !== 'POST')) {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }

  const driverId = decodeURIComponent(match[1]!);
  const driver = await driverClient.findById(driverId).catch(() => null);
  if (!driver) {
    sendJson(res, 404, { error: 'Driver not found' });
    return true;
  }
  const [submission, insurancePaper] = await Promise.all([
    driverClient.findKycSubmission(driverId).catch(() => null),
    driverPaperClient.find(driverId, 'insurance'),
  ]);
  const plate = driver.vehiclePlate ?? submission?.vehiclePlate ?? null;
  const vehicleMake = driver.vehicleMake ?? submission?.vehicleMake ?? null;
  const vehicleModel = driver.vehicleModel ?? submission?.vehicleModel ?? null;

  if (action === null) {
    const checks = await driverCheckClient.listForDriver(driverId);
    sendJson(res, 200, {
      prembly: {
        on: Boolean(deps.prembly),
        canRun: auth.role === 'OWNER',
        thisMonth: await driverCheckClient.countSince('prembly', monthStart()),
        reuseDays: REUSE_DAYS,
      },
      inputs: {
        legalName: driver.legalName ?? null,
        accountName: driver.user?.name ?? null,
        licenceNumber: driver.licenceNumber ?? null,
        licenceExpiresOn: day(driver.licenceExpiresOn),
        plate,
        vehicle: [vehicleMake, vehicleModel].filter(Boolean).join(' ') || null,
        insuranceNumber: insurancePaper?.number ?? null,
        insuranceExpiresOn: day(insurancePaper?.expiresOn),
        hasSelfie: Boolean(submission?.selfieKey && deps.kycStorage),
      },
      manualSources: MANUAL_SOURCES,
      checks: checks.map(view),
    });
    return true;
  }

  const body = await readJsonBody(req).catch(() => null);
  if (!isRecord(body)) {
    sendJson(res, 400, { error: 'Body must be a JSON object' });
    return true;
  }

  if (action === 'manual') {
    const paper = driverPaper(getString(body, 'paperType') ?? '');
    const source = getString(body, 'source') ?? '';
    const outcome = getString(body, 'outcome');
    const note = clean(getString(body, 'note'));
    if (!paper) { sendJson(res, 400, { error: 'Which paper was checked?' }); return true; }
    if (!MANUAL_KEYS.includes(source)) { sendJson(res, 400, { error: `source must be one of ${MANUAL_KEYS.join(', ')}` }); return true; }
    if (outcome !== 'verified' && outcome !== 'failed') { sendJson(res, 400, { error: 'outcome must be "verified" or "failed"' }); return true; }
    if (outcome === 'failed' && note.length < 4) {
      sendJson(res, 400, { error: 'Say what was wrong: the next admin reads it.', code: 'NOTE_NEEDED' });
      return true;
    }
    const doc = await driverPaperClient.find(driverId, paper.type);
    const check = await driverCheckClient.record({
      driverId, kind: 'manual', paperType: paper.type, source, outcome,
      input: doc?.number ?? (paper.type === 'hackneyPermit' || paper.type === 'roadworthiness' || paper.type === 'vioInspection' ? plate : null),
      note: note || null, byId: auth.adminId, byName: auth.adminName,
    });
    recordAdminActivity({
      adminId: auth.adminId, adminName: auth.adminName, kind: 'action', page: `/admin/dashboard/drivers/${driverId}`,
      detail: { what: outcome === 'verified' ? 'checked a paper by hand: good' : 'checked a paper by hand: failed', paper: paper.label, source, driverId, ...(note ? { note } : {}) },
      ip: clientIp(req),
    });
    sendJson(res, 200, { check: view(check) });
    return true;
  }

  // A Prembly check.
  if (auth.role !== 'OWNER') {
    sendJson(res, 403, { error: 'Only owners run Prembly checks: each one costs money.', code: 'OWNERS_ONLY' });
    return true;
  }
  if (!deps.prembly) {
    sendJson(res, 503, { error: 'Prembly is not set up on this server (PREMBLY_API_KEY).', code: 'PREMBLY_OFF' });
    return true;
  }
  const kind = getString(body, 'kind') as PaidKind | null;
  if (!kind || !PAID_KINDS.includes(kind)) {
    sendJson(res, 400, { error: 'kind must be "licence", "plate" or "insurance"' });
    return true;
  }
  const force = body.force === true;
  const today = lagosToday();
  const config = deps.prembly;

  let input: string;
  let checkKind: string = kind;
  let paperType: string | null = null;
  let call: () => Promise<PremblyAnswer>;
  let read: (data: Record<string, unknown>, face: Extract<PremblyAnswer, { kind: 'found' }>['face']) => Reading;

  if (kind === 'licence') {
    input = clean(getString(body, 'number') ?? driver.licenceNumber, 40).toUpperCase();
    const dob = readDay(getString(body, 'dob'));
    const nameParts = clean(driver.legalName ?? driver.user?.name).split(' ').filter(Boolean);
    const firstName = clean(getString(body, 'firstName') ?? nameParts[0], 60);
    const lastName = clean(getString(body, 'lastName') ?? (nameParts.length > 1 ? nameParts[nameParts.length - 1] : ''), 60);
    if (!input) { sendJson(res, 400, { error: 'No licence number: the driver has not typed one. Type it from the photo.' }); return true; }
    if (!dob) { sendJson(res, 400, { error: 'Type the date of birth from the licence (FRSC needs it).', code: 'DOB_NEEDED' }); return true; }
    const withFace = body.withFace === true;
    if (withFace) {
      checkKind = 'licenceFace';
      const selfie = submission?.selfieKey && deps.kycStorage ? await deps.kycStorage.getImageAsBase64(submission.selfieKey).catch(() => null) : null;
      if (!selfie) { sendJson(res, 400, { error: 'No selfie on file to compare with the licence photo.', code: 'NO_SELFIE' }); return true; }
      call = () => prembly.licenceFace(config, { number: input, dob, imageBase64: selfie }, deps.fetchImpl);
    } else {
      if (!firstName || !lastName) { sendJson(res, 400, { error: 'Type the first and last name as on the licence.', code: 'NAME_NEEDED' }); return true; }
      call = () => prembly.licence(config, { number: input, dob, firstName, lastName }, deps.fetchImpl);
    }
    read = (data, face) => readLicence(data, { legalName: driver.legalName ?? null, accountName: driver.user?.name ?? null, licenceExpiresOn: day(driver.licenceExpiresOn) }, face, today);
  } else if (kind === 'plate') {
    input = clean(getString(body, 'number') ?? plate, 20).toUpperCase().replace(/\s+/g, '');
    if (!input) { sendJson(res, 400, { error: 'No plate number: the driver has not given one.' }); return true; }
    call = () => prembly.plate(config, input, deps.fetchImpl);
    read = (data) => readPlate(data, { vehicleMake, vehicleModel });
  } else {
    paperType = 'insurance';
    input = clean(getString(body, 'number') ?? insurancePaper?.number, 60).toUpperCase();
    const channel = clean(getString(body, 'channel') ?? 'Policy', 30) || 'Policy';
    if (!input) { sendJson(res, 400, { error: 'No policy number: the driver has not typed one. Type it from the certificate.' }); return true; }
    call = () => prembly.insurance(config, { number: input, channel }, deps.fetchImpl);
    read = (data) => readInsurance(data, { plate, vehicleMake, vehicleModel, paperExpiresOn: day(insurancePaper?.expiresOn) }, today);
  }

  if (!force) {
    const saved = await driverCheckClient.recent(driverId, checkKind, input, new Date(Date.now() - REUSE_DAYS * DAY_MS));
    if (saved) {
      sendJson(res, 200, { check: view(saved), reused: true });
      return true;
    }
  }

  const answer = await call();
  const reading = answer.kind === 'found' ? read(answer.data, answer.face) : null;
  const outcome = answer.kind === 'error' ? 'error' : answer.kind === 'not_found' ? 'not_found' : reading!.mismatches.length ? 'mismatch' : 'verified';
  const check = await driverCheckClient.record({
    driverId, kind: checkKind, paperType, source: 'prembly', input, outcome,
    mismatches: reading?.mismatches ?? [],
    found: reading?.found ?? null,
    reference: answer.kind === 'error' ? null : answer.reference,
    note: answer.kind === 'found' ? null : clean(answer.detail),
    byId: auth.adminId, byName: auth.adminName,
  });
  recordAdminActivity({
    adminId: auth.adminId, adminName: auth.adminName, kind: 'action', page: `/admin/dashboard/drivers/${driverId}`,
    detail: { what: 'ran a Prembly check', check: checkKind, outcome, driverId },
    ip: clientIp(req),
  });

  // The licence photo, for the admin to look at now: in this answer only, never saved.
  const photo = answer.kind === 'found' && (kind === 'licence') && typeof answer.data.photo === 'string' && answer.data.photo.length > 100 ? answer.data.photo : null;
  sendJson(res, answer.kind === 'error' ? 502 : 200, {
    check: view(check),
    reused: false,
    ...(photo ? { photo } : {}),
    ...(answer.kind === 'error' ? { error: answer.detail } : {}),
  });
  return true;
}
