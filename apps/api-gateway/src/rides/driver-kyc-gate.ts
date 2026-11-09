import { driverClient } from '@wheleers/db';
import { driverPapersView, lagosToday, papersRequiredFrom } from '../http/driver-papers.route';

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

/**
 * From the day papers are required (DRIVER_PAPERS_REQUIRED_FROM), a driver
 * with a required paper missing, sent back or expired, or without their name
 * and licence details, cannot go online. A paper sent and waiting to be
 * checked does not stop them: they have done their part.
 */
export class DriverPapersError extends Error {
  readonly code = 'PAPERS_REQUIRED';
  constructor(readonly toDo: number) {
    super(toDo === 1
      ? 'One of your papers is missing or has expired. Open Your papers to send it, then go online.'
      : `${toDo} of your papers are missing or have expired. Open Your papers to send them, then go online.`);
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
  const requiredFrom = papersRequiredFrom();
  if (driver && requiredFrom && lagosToday().getTime() >= requiredFrom.getTime()) {
    const { toDo } = await driverPapersView(driver.id);
    if (toDo > 0) {
      approvedUntil.delete(userId);
      throw new DriverPapersError(toDo);
    }
  }
  if (approvedUntil.size > 50_000) approvedUntil.clear();
  approvedUntil.set(userId, Date.now() + APPROVED_TTL_MS);
}
