import type { IncomingMessage, ServerResponse } from 'http';
import { driverClient, userClient } from '@wheleers/db';
import { verifyLocalAccessToken } from '../auth/local';
import { isRecord, getString } from '../utils/object';
import { readJsonBody, sendJson } from './utils';
import { logActivity } from '../analytics/log-activity';
import { sniffKycFileType, type DriverKycStorage } from '../storage/driver-kyc-storage';
import { KYC_FIELD_LABELS, fieldReasonsFrom, isKycField, KYC_FIELDS, type KycField } from '../drivers/kyc-fields';

interface DriverKycDeps {
  jwtSecret: string;
  kycStorage: DriverKycStorage;
}

function extractUserId(req: IncomingMessage, jwtSecret: string): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;

  try {
    const payload = verifyLocalAccessToken(authHeader.slice(7), jwtSecret);
    return payload.sub;
  } catch {
    return null;
  }
}

/** One document to storage, named and typed by what its bytes are (a licence can be a PDF). */
function uploadKycFile(deps: DriverKycDeps, driverId: string, type: string, base64: string): Promise<string> {
  const bytes = Buffer.from(base64, 'base64');
  return deps.kycStorage.upload({ driverId, type, imageBuffer: bytes, mimeType: sniffKycFileType(bytes) });
}

type KycInput = {
  ninImage?: string;
  licenceImage?: string;
  selfieImage?: string;
  vehicleImages: string[];
  vehicle?: { vehicleMake: string; vehicleModel: string; vehiclePlate: string; vehicleYear: number };
  phone?: string;
};

function readKycInput(body: Record<string, unknown>): KycInput {
  const vehicleMake = getString(body, 'vehicleMake');
  const vehicleModel = getString(body, 'vehicleModel');
  const vehiclePlate = getString(body, 'vehiclePlate');
  const vehicleYear = typeof body.vehicleYear === 'number' ? body.vehicleYear : undefined;
  const vehicleImages = Array.isArray(body.vehicleImages)
    ? body.vehicleImages.filter((img): img is string => typeof img === 'string' && img.length > 0)
    : [];
  return {
    ninImage: getString(body, 'ninImage') ?? undefined,
    licenceImage: getString(body, 'licenceImage') ?? undefined,
    selfieImage: getString(body, 'selfieImage') ?? undefined,
    vehicleImages,
    vehicle: vehicleMake && vehicleModel && vehiclePlate && vehicleYear
      ? { vehicleMake, vehicleModel, vehiclePlate, vehicleYear }
      : undefined,
    phone: getString(body, 'phone') ?? undefined,
  };
}

/** Which of these items the request is missing. */
function missingFields(input: KycInput, fields: readonly KycField[]): KycField[] {
  return fields.filter((field) => {
    switch (field) {
      case 'nin': return !input.ninImage;
      case 'licence': return !input.licenceImage;
      case 'selfie': return !input.selfieImage;
      case 'vehicle': return !input.vehicle;
      case 'vehiclePhotos': return input.vehicleImages.length < 7;
    }
  });
}

/** Stores the given items; returns only the keys for what was stored. */
async function uploadKycFields(deps: DriverKycDeps, driverId: string, input: KycInput, fields: readonly KycField[]) {
  const has = (f: KycField) => fields.includes(f);
  const [ninImageKey, licenceImageKey, selfieKey, vehicleImageKeys] = await Promise.all([
    has('nin') ? uploadKycFile(deps, driverId, 'nin', input.ninImage!) : undefined,
    has('licence') ? uploadKycFile(deps, driverId, 'licence', input.licenceImage!) : undefined,
    has('selfie') ? uploadKycFile(deps, driverId, 'selfie', input.selfieImage!) : undefined,
    has('vehiclePhotos')
      ? Promise.all(input.vehicleImages.slice(0, 10).map((img, i) => uploadKycFile(deps, driverId, `vehicle-${i}`, img)))
      : undefined,
  ]);
  return {
    ...(ninImageKey ? { ninImageKey } : {}),
    ...(licenceImageKey ? { licenceImageKey } : {}),
    ...(selfieKey ? { selfieKey } : {}),
    ...(vehicleImageKeys ? { vehicleImageKeys } : {}),
    ...(has('vehicle') && input.vehicle ? input.vehicle : {}),
  };
}

const ALREADY_APPROVED = {
  error: 'You are already verified. Nothing to send.',
  code: 'ALREADY_APPROVED',
} as const;

/**
 * POST /drivers/kyc/submit
 * The whole application: NIN, licence (photo or PDF), selfie, vehicle
 * details and 7–10 vehicle photos, base64. For a new driver, or an app that
 * resends everything after a rejection. Refused for an approved driver: it
 * would put a working driver back under review and off the road.
 */
export async function handleDriverKycSubmitRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DriverKycDeps,
): Promise<void> {
  const userId = extractUserId(req, deps.jwtSecret);
  if (!userId) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const driver = await driverClient.findByUserId(userId);
  if (!driver) {
    sendJson(res, 404, { error: 'Driver record not found' });
    return;
  }
  if (driver.kycStatus === 'APPROVED') {
    sendJson(res, 409, ALREADY_APPROVED);
    return;
  }

  try {
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const input = readKycInput(rawBody);

    if (!input.ninImage || !input.licenceImage || !input.selfieImage) {
      sendJson(res, 400, { error: 'ninImage, licenceImage, and selfieImage are required (base64)' });
      return;
    }

    if (!input.vehicle) {
      sendJson(res, 400, { error: 'vehicleMake, vehicleModel, vehiclePlate, and vehicleYear are required' });
      return;
    }

    if (input.vehicleImages.length < 7) {
      sendJson(res, 400, { error: 'At least 7 vehicle photos are required' });
      return;
    }

    const stored = await uploadKycFields(deps, driver.id, input, KYC_FIELDS);
    const accepted = await driverClient.submitFullKyc(driver.id, {
      ...stored,
      ...input.vehicle,
      ninImageKey: stored.ninImageKey!,
      licenceImageKey: stored.licenceImageKey!,
      selfieKey: stored.selfieKey!,
      vehicleImageKeys: stored.vehicleImageKeys!,
    });
    if (!accepted) {
      // Approved while the upload ran: nothing was changed.
      sendJson(res, 409, ALREADY_APPROVED);
      return;
    }

    if (input.phone) {
      await userClient.updateProfile(userId, { phone: input.phone });
    }

    logActivity({ userId, eventType: 'driver_kyc_submitted', metadata: {} });

    sendJson(res, 200, { status: 'SUBMITTED' });
  } catch (error) {
    console.error('[driver-kyc] submit failed', {
      driverId: driver.id,
      error: error instanceof Error ? error.message : String(error),
    });
    sendJson(res, 500, { error: 'KYC submission failed' });
  }
}

/**
 * POST /drivers/kyc/resubmit
 * After a rejection, only the items sent back: the same body as submit,
 * holding just those. Everything already approved is kept. Only for a
 * rejected driver; any other status gets 409 and nothing changes.
 */
export async function handleDriverKycResubmitRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DriverKycDeps,
): Promise<void> {
  const userId = extractUserId(req, deps.jwtSecret);
  if (!userId) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const driver = await driverClient.findByUserId(userId);
  if (!driver) {
    sendJson(res, 404, { error: 'Driver record not found' });
    return;
  }
  if (driver.kycStatus === 'APPROVED') {
    sendJson(res, 409, ALREADY_APPROVED);
    return;
  }

  const submission = await driverClient.findKycSubmission(driver.id);
  if (driver.kycStatus !== 'REJECTED' || submission?.status !== 'REJECTED') {
    sendJson(res, 409, { error: 'There is nothing to fix right now.', code: 'NOT_REJECTED', kycStatus: driver.kycStatus });
    return;
  }

  const rejected = (submission.rejectedFields ?? []).filter(isKycField);
  const fields: KycField[] = rejected.length > 0 ? KYC_FIELDS.filter((f) => rejected.includes(f)) : [...KYC_FIELDS];

  try {
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const input = readKycInput(rawBody);
    const missing = missingFields(input, fields);
    if (missing.length > 0) {
      sendJson(res, 400, {
        error: `Still needed: ${missing.map((f) => KYC_FIELD_LABELS[f]).join(', ')}.`,
        code: 'MISSING_FIELDS',
        missing,
      });
      return;
    }

    const stored = await uploadKycFields(deps, driver.id, input, fields);
    const accepted = await driverClient.resubmitKycFields(driver.id, fields, stored);
    if (!accepted) {
      sendJson(res, 409, { error: 'There is nothing to fix right now.', code: 'NOT_REJECTED' });
      return;
    }

    if (input.phone && fields.includes('vehicle')) {
      await userClient.updateProfile(userId, { phone: input.phone });
    }

    logActivity({ userId, eventType: 'driver_kyc_resubmitted', metadata: { fields } });

    sendJson(res, 200, { status: 'SUBMITTED', resubmitted: fields });
  } catch (error) {
    console.error('[driver-kyc] resubmit failed', {
      driverId: driver.id,
      error: error instanceof Error ? error.message : String(error),
    });
    sendJson(res, 500, { error: 'KYC resubmission failed' });
  }
}

/**
 * GET /drivers/kyc/status
 * Returns the current KYC submission status for the authenticated driver.
 */
export async function handleDriverKycStatusRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Pick<DriverKycDeps, 'jwtSecret'>,
): Promise<void> {
  const userId = extractUserId(req, deps.jwtSecret);
  if (!userId) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const driver = await driverClient.findByUserId(userId);
  if (!driver) {
    sendJson(res, 404, { error: 'Driver record not found' });
    return;
  }

  const submission = await driverClient.findKycSubmission(driver.id);

  // What to fix, only while rejected: after a resubmission rejectedFields
  // names what was resent, which is the reviewer's business, not the driver's.
  const rejected = submission?.status === 'REJECTED';
  const rejectedFields = rejected ? (submission.rejectedFields ?? []).filter(isKycField) : [];

  sendJson(res, 200, {
    kycStatus: driver.kycStatus,
    submission: submission ? {
      status: submission.status,
      submittedAt: submission.submittedAt,
      reviewedAt: submission.reviewedAt,
      rejectionReason: rejected ? submission.rejectionReason : null,
      rejectedFields,
      fieldReasons: rejected ? fieldReasonsFrom(submission.fieldStatuses, rejectedFields) : {},
      vehicleMake: submission.vehicleMake,
      vehicleModel: submission.vehicleModel,
      vehiclePlate: submission.vehiclePlate,
      vehicleYear: submission.vehicleYear,
    } : null,
  });
}
