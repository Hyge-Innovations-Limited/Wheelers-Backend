import type { IncomingMessage, ServerResponse } from 'http';
import { DRIVER_PAPERS, driverPaper } from '@wheleers/config';
import { driverCheckClient, driverClient, driverPaperClient } from '@wheleers/db';
import { clientIp, recordAdminActivity } from '../admin/activity';
import type { DriverKycStorage } from '../storage/driver-kyc-storage';
import { isRecord, getString } from '../utils/object';
import type { LlmClient } from '../LLM/llm';
import { MANUAL_SOURCES, namesAgree, plateKey, readDay, readInsurance, readLicence, readPlate, type Reading } from '../verification/driver-checks';
import { readLicencePhoto, type LicenceReading } from '../verification/licence-reader';
import { prembly, type PremblyAnswer, type PremblyConfig } from '../verification/prembly';
import { verifyAdminAuth } from './admin-auth.route';
import { lagosToday } from './driver-papers.route';
import { readJsonBody, sendJson } from './utils';

interface AdminChecksDeps {
  adminApiKey: string;
  jwtSecret: string;
  /** For the selfie a face check sends, and the links to the driver's papers. Null when storage is not configured: face checks are off, papers do not open. */
  kycStorage: Pick<DriverKycStorage, 'getImageAsBase64' | 'getSignedUrl' | 'fileTypeOf' | 'getFile'> | null;
  /** Reads the licence photo for the form. Null: no model set up, the admin types it. */
  llm?: LlmClient | null;
  /** Null when PREMBLY_API_KEY is not set: the paid checks are off, the hand checks still work. */
  prembly: PremblyConfig | null;
  fetchImpl?: typeof fetch;
  /** Tests: told of each background check, to wait for it. */
  onFinished?: (done: Promise<void>) => void;
}

/** The same check on the same number within this long gives back the saved answer, not a new (paid) one, unless forced. */
const REUSE_DAYS = 30;
const DAY_MS = 86_400_000;
const PAID_KINDS = ['licence', 'plate', 'insurance'] as const;
/** A licence photo read in the last hour is not read again: opening a driver twice costs one reading. Kept in memory only. */
const READ_TTL_MS = 60 * 60_000;
const readings = new Map<string, { at: number; reading: LicenceReading }>();
/**
 * A Prembly check runs in the background and the page asks for it until it
 * is in: the government records behind Prembly can take a minute, longer
 * than a web request should hang. One still running after this long never
 * got its answer (the server restarted) and becomes an error.
 */
const RUNNING_FOR_MS = 3 * 60_000;
/** The FRSC photo of a licence check just in, for the page to show: in memory for ten minutes, never saved. */
const PHOTO_TTL_MS = 10 * 60_000;
const photos = new Map<string, { at: number; photo: string }>();
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
  ...(photos.has(c.id) && Date.now() - photos.get(c.id)!.at < PHOTO_TTL_MS ? { photo: photos.get(c.id)!.photo } : {}),
});

/** The first of the month, Lagos time: what "this month" counts from. */
function monthStart(now = new Date()): Date {
  const lagos = new Date(now.getTime() + 60 * 60_000);
  return new Date(Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), 1) - 60 * 60_000);
}

/**
 * Checking a driver's licence and car, for the admin:
 *   GET  /admin/drivers/:id/checks           every check so far, what a new one would send, whether Prembly is on, and
 *                                            the driver's licence photo, selfie and each paper (link, number, dates) to check against
 *   POST /admin/drivers/:id/checks/prembly   owners: { kind: "licence" | "plate" | "insurance", dob?, number?, firstName?, lastName?, withFace?, channel?, force? }
 *   POST /admin/drivers/:id/checks/manual    { paperType, source: "autoreg" | "dvis" | "niid" | "other", outcome: "verified" | "failed", note? }
 *   POST /admin/drivers/:id/checks/read-licence   { again? }   AI reads the licence photo: number, names, date of birth, dates
 *
 * A Prembly check costs money, so only owners run one, and the same check on
 * the same number within 30 days gives back the saved answer unless `force`.
 * It runs in the background: the POST answers 202 with the check "pending",
 * the page asks GET until it is in. Pressing again while it runs joins it.
 * What comes back is kept as key fields (names, dates, make, colour, policy
 * status) with what does not agree with what the driver gave us; the licence
 * photo is shown in the answer once and never kept.
 *
 * A hand check is one an admin did on a government site (AutoReg, DVIS,
 * NIID) or by other means, recorded with a note: failing one needs the note.
 * Neither approves or sends back a paper: that stays the admin's decision.
 *
 * Reading the licence fills the licence check's form (the date of birth
 * above all, which FRSC needs and we do not keep) and says where the photo
 * disagrees with what the driver typed. It is a suggestion to look at against
 * the photo, never saved: kept in memory for an hour so it is read once.
 * Returns false when the path is not one of these.
 */
export async function handleAdminDriverChecksRoute(req: IncomingMessage, res: ServerResponse, deps: AdminChecksDeps, url: URL): Promise<boolean> {
  const match = /^\/admin\/drivers\/([^/]+)\/checks(?:\/(prembly|manual|read-licence))?$/.exec(url.pathname);
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
    await driverCheckClient.expireRunning(driverId, new Date(Date.now() - RUNNING_FOR_MS), 'No answer came back (the server restarted while it ran). Try again.').catch(() => null);
    const storage = deps.kycStorage;
    const sign = (key: string, pdf = false) =>
      storage ? storage.getSignedUrl(key, 3600, pdf ? 'application/pdf' : undefined).catch(() => null) : Promise.resolve(null);
    const today = lagosToday();
    const licenceKey = submission?.licenceImageKey ?? null;
    const licencePdf = licenceKey && storage ? (await storage.fileTypeOf(licenceKey).catch(() => null)) === 'application/pdf' : false;
    const [checks, papers, licenceUrl, selfieUrl] = await Promise.all([
      driverCheckClient.listForDriver(driverId),
      driverPaperClient.listForDriver(driverId),
      licenceKey ? sign(licenceKey, licencePdf) : Promise.resolve(null),
      submission?.selfieKey ? sign(submission.selfieKey) : Promise.resolve(null),
    ]);
    const documents = {
      licence: licenceUrl ? { url: licenceUrl, isPdf: licencePdf } : null,
      selfieUrl,
      // Every paper sent, in the order the app lists them: what each check is set against, with its dates.
      papers: await Promise.all(
        [...papers].sort((a, b) => DRIVER_PAPERS.findIndex((p) => p.type === a.type) - DRIVER_PAPERS.findIndex((p) => p.type === b.type)).map(async (doc) => ({
          type: doc.type,
          label: labelOf(doc.type),
          number: doc.number,
          status: doc.status,
          uploadedAt: doc.uploadedAt.toISOString(),
          expiresOn: day(doc.expiresOn),
          daysLeft: doc.expiresOn ? Math.round((doc.expiresOn.getTime() - today.getTime()) / DAY_MS) : null,
          isPdf: doc.fileType === 'application/pdf',
          url: await sign(doc.fileKey, doc.fileType === 'application/pdf'),
        })),
      ),
    };
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
      documents,
      checks: checks.map(view),
    });
    return true;
  }

  const body = await readJsonBody(req).catch(() => null);
  if (!isRecord(body)) {
    sendJson(res, 400, { error: 'Body must be a JSON object' });
    return true;
  }

  if (action === 'read-licence') {
    const key = submission?.licenceImageKey ?? null;
    if (!key) { sendJson(res, 404, { error: 'This driver has not sent a licence photo.', code: 'NO_LICENCE' }); return true; }
    if (!deps.llm?.configured || !deps.kycStorage) {
      sendJson(res, 503, { error: 'Reading photos is not set up on this server: type it from the photo.', code: 'READER_OFF' });
      return true;
    }
    let saved = readings.get(key);
    if (saved && (Date.now() - saved.at > READ_TTL_MS || body.again === true)) { readings.delete(key); saved = undefined; }
    let reading = saved?.reading ?? null;
    if (!reading) {
      const file = await deps.kycStorage.getFile(key);
      if (!file) { sendJson(res, 502, { error: 'Could not open the licence photo.' }); return true; }
      reading = await readLicencePhoto(deps.llm, file.bytes, file.type);
      if (!reading) { sendJson(res, 502, { error: 'Could not read the licence photo just now: type it from the photo.', code: 'NOT_READ' }); return true; }
      for (const [k, v] of readings) if (Date.now() - v.at > READ_TTL_MS || readings.size > 500) readings.delete(k);
      readings.set(key, { at: Date.now(), reading });
    }
    // Where the photo and what the driver typed disagree: worth a look before paying for the FRSC check.
    const differs: string[] = [];
    const typedName = driver.legalName ?? driver.user?.name ?? null;
    const photoName = [reading.firstName, reading.middleName, reading.lastName].filter(Boolean).join(' ') || null;
    if (reading.licenceNumber && driver.licenceNumber && plateKey(reading.licenceNumber) !== plateKey(driver.licenceNumber)) {
      differs.push(`The photo shows licence number ${reading.licenceNumber}; the driver typed ${driver.licenceNumber}.`);
    }
    if (photoName && typedName && !namesAgree(photoName, typedName)) differs.push(`The photo shows ${photoName}; the driver typed ${typedName}.`);
    const typedExpiry = day(driver.licenceExpiresOn);
    if (reading.expiresOn && typedExpiry && reading.expiresOn !== typedExpiry) differs.push(`The photo shows it expires ${reading.expiresOn}; the driver typed ${typedExpiry}.`);
    if (reading.expiresOn && reading.expiresOn < day(lagosToday())!) differs.push(`The photo shows it expired on ${reading.expiresOn}.`);
    sendJson(res, 200, { reading, differs, cached: Boolean(saved) });
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
    const channel = clean(getString(body, 'channel') ?? 'policy', 30) || 'policy';
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

  const running = await driverCheckClient.running(driverId, checkKind, input, new Date(Date.now() - RUNNING_FOR_MS));
  if (running) {
    sendJson(res, 202, { check: view(running), reused: false, pending: true });
    return true;
  }

  const pending = await driverCheckClient.record({
    driverId, kind: checkKind, paperType, source: 'prembly', input, outcome: 'pending',
    byId: auth.adminId, byName: auth.adminName,
  });
  const ip = clientIp(req);
  const finished = (async () => {
    const answer = await call();
    const reading = answer.kind === 'found' ? read(answer.data, answer.face) : null;
    const outcome = answer.kind === 'error' ? 'error' : answer.kind === 'not_found' ? 'not_found' : reading!.mismatches.length ? 'mismatch' : 'verified';
    const notCharged = answer.charged === false ? ' Not charged.' : '';
    await driverCheckClient.finish(pending.id, {
      outcome,
      mismatches: reading?.mismatches ?? [],
      found: reading?.found ?? null,
      reference: answer.kind === 'error' ? null : answer.reference,
      note: answer.kind === 'found' ? null : `${clean(answer.detail, 280)}${notCharged}`,
    });
    // The licence photo, for the admin to look at now: in memory, never saved.
    if (answer.kind === 'found' && kind === 'licence' && typeof answer.data.photo === 'string' && answer.data.photo.length > 100) {
      for (const [k, v] of photos) if (Date.now() - v.at > PHOTO_TTL_MS) photos.delete(k);
      photos.set(pending.id, { at: Date.now(), photo: answer.data.photo });
    }
    recordAdminActivity({
      adminId: auth.adminId, adminName: auth.adminName, kind: 'action', page: `/admin/dashboard/drivers/${driverId}`,
      detail: { what: 'ran a Prembly check', check: checkKind, outcome, driverId }, ip,
    });
  })().catch(async (error) => {
    console.warn('[driver-checks] Prembly check failed', { id: pending.id, error: error instanceof Error ? error.message : String(error) });
    await driverCheckClient.finish(pending.id, { outcome: 'error', note: 'Something went wrong on our side. Try again.' }).catch(() => null);
  });
  deps.onFinished?.(finished);

  sendJson(res, 202, { check: view(pending), reused: false, pending: true });
  return true;
}
