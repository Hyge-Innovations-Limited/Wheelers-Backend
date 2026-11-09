import { randomUUID } from 'node:crypto';
import { driverClient } from '@wheleers/db';
import type { NotificationEvent } from '@wheleers/kafka-schemas';
import { sendEmail } from '../email/resend';
import { buildDriverApprovedEmail, buildDriverRejectedEmail } from '../email/templates';
import { KYC_FIELD_LABELS, type KycField } from './kyc-fields';

export type KycNotifyDeps = {
  publisher?: { publishNotificationEvent(event: NotificationEvent): Promise<void> };
  resendApiKey?: string;
};

type Decision =
  | { outcome: 'APPROVED' }
  | { outcome: 'REJECTED'; fields: KycField[]; reasons: Partial<Record<KycField, string>> };

/**
 * Tells the driver what the admin decided: a push (tapping it opens the right
 * screen), the in-app notification, and an email. Every channel on its own:
 * one failing never stops the others, and never the decision itself.
 */
export async function notifyKycDecision(deps: KycNotifyDeps, driverId: string, decision: Decision): Promise<void> {
  const driver = await driverClient.findById(driverId).catch(() => null);
  if (!driver) return;
  const timestamp = new Date().toISOString();

  const title = decision.outcome === 'APPROVED' ? "You're approved" : 'Your verification needs a fix';
  const body = decision.outcome === 'APPROVED'
    ? 'Welcome to Wheelers. Go online and start taking rides.'
    : decision.fields.length === 1
      ? `Please send your ${KYC_FIELD_LABELS[decision.fields[0]!].toLowerCase()} again. Everything else is approved.`
      : `Please fix ${decision.fields.length} items. Open the app to see what to send again.`;

  if (deps.publisher) {
    const pushes: NotificationEvent[] = [
      {
        eventType: 'PUSH_SEND',
        notificationId: randomUUID(),
        userId: driver.userId,
        title,
        body,
        data: { type: decision.outcome === 'APPROVED' ? 'kyc_approved' : 'kyc_rejected' },
        priority: 'high',
        timestamp,
      },
      {
        eventType: 'IN_APP_SEND',
        notificationId: randomUUID(),
        userId: driver.userId,
        title,
        body,
        category: 'kyc',
        read: false,
        timestamp,
      },
    ];
    for (const event of pushes) {
      await deps.publisher.publishNotificationEvent(event).catch((error) =>
        console.warn('[kyc] decision notification failed', {
          driverId, eventType: event.eventType, error: error instanceof Error ? error.message : String(error),
        }));
    }
  }

  const email = driver.user?.email;
  if (!deps.resendApiKey || !email) {
    console.warn('[kyc] decision email not sent', { driverId, reason: deps.resendApiKey ? 'no email on file' : 'RESEND_API_KEY not set' });
    return;
  }
  try {
    const name = driver.user?.name ?? undefined;
    const template = decision.outcome === 'APPROVED'
      ? buildDriverApprovedEmail(name)
      : buildDriverRejectedEmail(name, decision.fields.map((f) => ({ label: KYC_FIELD_LABELS[f], reason: decision.reasons[f] })));
    await sendEmail({ to: email, ...template }, deps.resendApiKey);
    console.info('[kyc] decision email sent', { driverId, outcome: decision.outcome });
  } catch (error) {
    console.error('[kyc] decision email failed', { driverId, error: error instanceof Error ? error.message : String(error) });
  }
}
