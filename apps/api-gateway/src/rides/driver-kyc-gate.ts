import { driverClient } from '@wheleers/db';

/**
 * A driver works only once their KYC is APPROVED. Matching has always
 * skipped unapproved drivers; this also stops them going online, bidding on
 * a request or taking an interstate departure, whatever the app shows them.
 */

export class DriverKycError extends Error {
  readonly code = 'KYC_REQUIRED';
  constructor(readonly kycStatus: string) {
    super(
      kycStatus === 'SUBMITTED'
        ? 'Your documents are being reviewed. You can drive once you are approved.'
        : kycStatus === 'REJECTED'
          ? 'Your verification needs attention. Open the app to fix it.'
          : 'Finish your verification (KYC) before you can drive.',
    );
  }
}

/** Approved drivers are remembered briefly, so going online is not a database read every time. */
const APPROVED_TTL_MS = 60_000;
const approvedUntil = new Map<string, number>();

export async function assertDriverApproved(userId: string): Promise<void> {
  if ((approvedUntil.get(userId) ?? 0) > Date.now()) return;
  const driver = await driverClient.findByUserId(userId);
  const status = String(driver?.kycStatus ?? 'NONE');
  if (status !== 'APPROVED') {
    approvedUntil.delete(userId);
    throw new DriverKycError(status);
  }
  if (approvedUntil.size > 50_000) approvedUntil.clear();
  approvedUntil.set(userId, Date.now() + APPROVED_TTL_MS);
}
