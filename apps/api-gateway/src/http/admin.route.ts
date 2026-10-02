import type { IncomingMessage, ServerResponse } from 'http';
import { driverClient } from '@wheleers/db';
import { isRecord, getString } from '../utils/object';
import { readJsonBody, sendJson } from './utils';
import { verifyAdminAuth } from './admin-auth.route';
import type { DriverKycStorage } from '../storage/driver-kyc-storage';
import { logActivity } from '../analytics/log-activity';
import { KYC_FIELDS, fieldReasonsFrom, isKycField, readableRejection, rejectedFieldsFrom } from '../drivers/kyc-fields';
import { notifyKycDecision, type KycNotifyDeps } from '../drivers/kyc-notify';

interface AdminRouteDeps extends KycNotifyDeps {
  adminApiKey: string;
  jwtSecret: string;
  kycStorage: DriverKycStorage;
}

/**
 * GET /admin/drivers?status=SUBMITTED
 * Lists drivers by KYC submission status.
 */
export async function handleAdminListDriversRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminRouteDeps,
): Promise<void> {
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  // ?status=REJECTED: drivers sent back to fix something, waiting on them.
  const wanted = new URL(req.url ?? '/', 'http://admin').searchParams.get('status');
  const status = wanted === 'REJECTED' ? 'REJECTED' : 'SUBMITTED';
  const submissions = await driverClient.findKycSubmissionsByStatus(status);

  const drivers = submissions.map((submission) => ({
    driverId: submission.driverId,
    name: submission.driver.user.name,
    email: submission.driver.user.email,
    phone: submission.driver.user.phone,
    vehicleMake: submission.vehicleMake,
    vehicleModel: submission.vehicleModel,
    vehiclePlate: submission.vehiclePlate,
    vehicleYear: submission.vehicleYear,
    status: submission.status,
    submittedAt: submission.submittedAt,
    reviewedAt: submission.reviewedAt,
    // Under review again after a fix: only these were resent.
    resubmittedFields: submission.status === 'SUBMITTED' ? (submission.rejectedFields ?? []).filter(isKycField) : [],
    rejectedFields: submission.status === 'REJECTED' ? (submission.rejectedFields ?? []).filter(isKycField) : [],
  }));

  sendJson(res, 200, { drivers });
}

/**
 * GET /admin/drivers/:driverId
 * Returns full driver details with signed document URLs.
 */
export async function handleAdminGetDriverRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminRouteDeps,
  driverId: string,
): Promise<void> {
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const driver = await driverClient.findById(driverId).catch(() => null);
  if (!driver) {
    sendJson(res, 404, { error: 'Driver not found' });
    return;
  }

  const submission = await driverClient.findKycSubmission(driverId);
  if (!submission) {
    sendJson(res, 404, { error: 'No KYC submission found' });
    return;
  }

  // Generate signed URLs for documents
  // A licence can be a PDF (older ones were stored as .jpg): the page needs
  // to know to show it as a document, and the link to open it as one.
  const licenceFileType = submission.licenceImageKey ? await deps.kycStorage.fileTypeOf(submission.licenceImageKey) : null;
  const [ninUrl, licenceUrl, selfieUrl] = await Promise.all([
    submission.ninImageKey ? deps.kycStorage.getSignedUrl(submission.ninImageKey) : null,
    submission.licenceImageKey
      ? deps.kycStorage.getSignedUrl(submission.licenceImageKey, 3600, licenceFileType === 'application/pdf' ? 'application/pdf' : undefined)
      : null,
    submission.selfieKey ? deps.kycStorage.getSignedUrl(submission.selfieKey) : null,
  ]);

  // Generate signed URLs for vehicle images
  const vehicleImageUrls: string[] = [];
  if (submission.vehicleImageKeys?.length) {
    const urls = await Promise.all(
      submission.vehicleImageKeys.map((key) => deps.kycStorage.getSignedUrl(key)),
    );
    vehicleImageUrls.push(...urls);
  }

  sendJson(res, 200, {
    driverId: driver.id,
    userId: driver.userId,
    name: driver.user.name,
    email: driver.user.email,
    phone: driver.user.phone,
    kycStatus: driver.kycStatus,
    submission: {
      status: submission.status,
      submittedAt: submission.submittedAt,
      vehicleMake: submission.vehicleMake,
      vehicleModel: submission.vehicleModel,
      vehiclePlate: submission.vehiclePlate,
      vehicleYear: submission.vehicleYear,
      ninImageUrl: ninUrl,
      licenceImageUrl: licenceUrl,
      licenceFileType,
      selfieUrl,
      vehicleImageUrls,
      rejectionReason: submission.rejectionReason,
      rejectedFields: submission.status === 'REJECTED' ? (submission.rejectedFields ?? []) : [],
      // Under review again after a fix: these were resent, the rest was approved before.
      resubmittedFields: submission.status === 'SUBMITTED' ? (submission.rejectedFields ?? []).filter(isKycField) : [],
      previousRejectionReason: submission.status === 'SUBMITTED' && (submission.rejectedFields ?? []).length > 0
        ? submission.rejectionReason
        : null,
      fieldStatuses: (submission.fieldStatuses as Record<string, unknown>) ?? {},
    },
  });
}

/**
 * POST /admin/drivers/:driverId/field-review
 * Approve or reject a single KYC field.
 * Body: { field: "nin"|"licence"|"selfie"|"vehicle", status: "approved"|"rejected", reason?: string }
 */
export async function handleAdminFieldReviewRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminRouteDeps,
  driverId: string,
): Promise<void> {
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const rawBody = await readJsonBody(req);
  if (!isRecord(rawBody)) {
    sendJson(res, 400, { error: 'Body must be a JSON object' });
    return;
  }

  const field = getString(rawBody, 'field');
  const status = getString(rawBody, 'status');
  const reason = getString(rawBody, 'reason') ?? '';
  const validStatuses = ['approved', 'rejected'];

  if (!field || !isKycField(field)) {
    sendJson(res, 400, { error: `field must be one of: ${KYC_FIELDS.join(', ')}` });
    return;
  }

  if (!status || !validStatuses.includes(status)) {
    sendJson(res, 400, { error: 'status must be "approved" or "rejected"' });
    return;
  }

  const submission = await driverClient.findKycSubmission(driverId);
  if (!submission || submission.status !== 'SUBMITTED') {
    sendJson(res, 400, { error: 'No pending submission to review' });
    return;
  }

  const existing = (submission.fieldStatuses as Record<string, unknown>) ?? {};
  const updated: Record<string, unknown> = {
    ...existing,
    [field]: { status, reason, reviewedBy: auth.adminName, reviewedAt: new Date().toISOString() },
  };

  await driverClient.updateFieldStatuses(driverId, updated as Record<string, string>);

  sendJson(res, 200, { field, status, fieldStatuses: updated });
}

/**
 * POST /admin/drivers/:driverId/approve
 * Approves the driver's KYC submission.
 */
export async function handleAdminApproveDriverRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminRouteDeps,
  driverId: string,
): Promise<void> {
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  // Decided once: only while under review, so a second click (or a second
  // admin) gets a clear answer instead of deciding again.
  const decided = await driverClient.approvePendingKyc(driverId, auth.adminName);
  if (!decided) {
    sendJson(res, 400, { error: 'No pending submission to approve' });
    return;
  }

  // Tell the driver they're cleared to drive. Non-blocking: a failed push or
  // mail must never make the approval itself look like it failed.
  void notifyKycDecision(deps, driverId, { outcome: 'APPROVED' });

  void logAdminDriverAction(driverId, 'admin_driver_approved', { admin: auth.adminName });

  sendJson(res, 200, { status: 'APPROVED' });
}

/**
 * POST /admin/drivers/:driverId/reject
 * Rejects the driver's KYC submission with a reason.
 */
export async function handleAdminRejectDriverRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminRouteDeps,
  driverId: string,
): Promise<void> {
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const rawBody = await readJsonBody(req);
  if (!isRecord(rawBody)) {
    sendJson(res, 400, { error: 'Body must be a JSON object' });
    return;
  }

  const submission = await driverClient.findKycSubmission(driverId);
  if (!submission || submission.status !== 'SUBMITTED') {
    sendJson(res, 400, { error: 'No pending submission to reject' });
    return;
  }

  // What goes back, and why, in words a driver reads ("Driver's licence:
  // photo is blurry."), from the admin's per-item review. The admin page's
  // own summary is the fallback.
  const rawFields = Array.isArray(rawBody.rejectedFields) ? rawBody.rejectedFields : [];
  const rejectedFields = rejectedFieldsFrom(rawFields, submission.fieldStatuses);
  const reasons = fieldReasonsFrom(submission.fieldStatuses, rejectedFields);
  const reason = readableRejection(rejectedFields, reasons, getString(rawBody, 'reason') ?? null);

  const decided = await driverClient.rejectPendingKyc(driverId, auth.adminName, reason, rejectedFields);
  if (!decided) {
    sendJson(res, 400, { error: 'No pending submission to reject' });
    return;
  }

  void notifyKycDecision(deps, driverId, { outcome: 'REJECTED', fields: rejectedFields, reasons });

  void logAdminDriverAction(driverId, 'admin_driver_rejected', {
    admin: auth.adminName,
    reason,
    rejectedFields,
  });

  sendJson(res, 200, { status: 'REJECTED', reason, rejectedFields });
}

/**
 * Admin moderation rows are logged against the DRIVER's user id — that's the
 * account the action happened to. Resolving it costs one lookup, done
 * fire-and-forget so moderation never waits on analytics.
 */
async function logAdminDriverAction(
  driverId: string,
  eventType: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    const driver = await driverClient.findById(driverId);
    if (driver?.userId) {
      logActivity({ userId: driver.userId, eventType, metadata: { ...metadata, driverId } });
    }
  } catch {
    // analytics only — never surface
  }
}
