import { randomUUID } from 'node:crypto';
import { DRIVER_PAPERS } from '@wheleers/config';
import { driverPaperClient } from '@wheleers/db';
import type { NotificationEvent } from '@wheleers/kafka-schemas';

export type PaperNotifyDeps = {
  publisher?: { publishNotificationEvent(event: NotificationEvent): Promise<void> };
};

const labelOf = (type: string) => DRIVER_PAPERS.find((p) => p.type === type)?.label ?? 'paper';

/** A push and the in-app notification. Tapping the push opens Your papers. Never throws. */
async function tell(deps: PaperNotifyDeps, userId: string, title: string, body: string, kind: string): Promise<void> {
  if (!deps.publisher) return;
  const timestamp = new Date().toISOString();
  const events: NotificationEvent[] = [
    { eventType: 'PUSH_SEND', notificationId: randomUUID(), userId, title, body, data: { type: kind }, priority: 'high', timestamp },
    { eventType: 'IN_APP_SEND', notificationId: randomUUID(), userId, title, body, category: 'kyc', read: false, timestamp },
  ];
  for (const event of events) {
    await deps.publisher.publishNotificationEvent(event).catch((error) =>
      console.warn('[driver-papers] notification failed', { userId, eventType: event.eventType, error: error instanceof Error ? error.message : String(error) }));
  }
}

/** The driver is told what the admin decided about one paper. */
export async function notifyPaperDecision(
  deps: PaperNotifyDeps,
  driverUserId: string,
  decision: { type: string; outcome: 'APPROVED' | 'REJECTED'; reason: string | null },
): Promise<void> {
  const label = labelOf(decision.type);
  if (decision.outcome === 'APPROVED') {
    await tell(deps, driverUserId, `${label} approved`, `Your ${label.toLowerCase()} has been checked and approved.`, 'paper_approved');
    return;
  }
  await tell(
    deps, driverUserId, `${label}: please send it again`,
    decision.reason ? `${decision.reason} Open Your papers to send a new one.` : 'Open Your papers to send a new one.',
    'paper_rejected',
  );
}

/**
 * The driver is told everything an admin decided in one go, in ONE message:
 * what to send again and why, numbered, and how many were approved. Nothing
 * when nothing was decided.
 */
export async function notifyPaperDecisions(
  deps: PaperNotifyDeps,
  driverUserId: string,
  decided: { approved: string[]; sentBack: Array<{ type: string; reason: string }> },
): Promise<void> {
  const { approved, sentBack } = decided;
  if (sentBack.length === 0 && approved.length === 0) return;
  if (sentBack.length === 0) {
    const labels = approved.map(labelOf);
    await tell(
      deps, driverUserId,
      approved.length === 1 ? `${labels[0]} approved` : `${approved.length} papers approved`,
      approved.length === 1 ? `Your ${labels[0]!.toLowerCase()} has been checked and approved.` : `Checked and approved: ${labels.join(', ')}.`,
      'paper_approved',
    );
    return;
  }
  const list = sentBack.map((p, i) => `${sentBack.length > 1 ? `${i + 1}) ` : ''}${labelOf(p.type)}: ${p.reason}`).join('\n');
  const title = sentBack.length === 1 ? `${labelOf(sentBack[0]!.type)}: please send it again` : `Please send ${sentBack.length} papers again`;
  const good = approved.length === 0 ? '' : approved.length === 1 ? `\n${labelOf(approved[0]!)} is approved.` : `\n${approved.length} others are approved.`;
  await tell(deps, driverUserId, title, `${list}${good}\nOpen Your papers to send ${sentBack.length === 1 ? 'a new one' : 'new ones'}.`, 'paper_rejected');
}

/** How many days ahead each reminder goes out; 0 is the day after it has run out. */
export const REMINDER_DAYS = [30, 14, 3, 0] as const;
const DAY_MS = 86_400_000;

/**
 * The reminder a paper is due, if any: the nearest threshold its date has
 * reached that it has not been reminded at yet. A paper 10 days from its
 * date that was last reminded at 30 is due the 14-day one; reminded at 14
 * already, nothing until 3.
 */
export function reminderDue(expiresOn: Date, remindedAt: number | null, today: Date): number | null {
  const daysLeft = Math.round((expiresOn.getTime() - today.getTime()) / DAY_MS);
  const reached = daysLeft < 0 ? 0 : [...REMINDER_DAYS].reverse().find((d) => d > 0 && daysLeft <= d) ?? null;
  if (reached === null) return null;
  return remindedAt !== null && remindedAt <= reached ? null : reached;
}

function reminderWords(label: string, expiresOn: Date, today: Date): { title: string; body: string } {
  const daysLeft = Math.round((expiresOn.getTime() - today.getTime()) / DAY_MS);
  if (daysLeft < 0) return { title: `${label} has expired`, body: `Send the renewed one in Your papers to keep your account in good standing.` };
  const when = daysLeft === 0 ? 'today' : daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`;
  return { title: `${label} expires ${when}`, body: 'Renew it, then send the new one in Your papers.' };
}

/**
 * One pass over every paper and licence running out within 30 days: each gets
 * the reminder it is due, once. Returns how many were sent.
 */
export async function sendPaperReminders(deps: PaperNotifyDeps, today: Date): Promise<number> {
  const until = new Date(today.getTime() + 30 * DAY_MS);
  let sent = 0;
  for (const doc of await driverPaperClient.dueForReminder(until)) {
    if (!doc.expiresOn) continue;
    const due = reminderDue(doc.expiresOn, doc.remindedAt, today);
    if (due === null) continue;
    const words = reminderWords(labelOf(doc.type), doc.expiresOn, today);
    await tell(deps, doc.driver.userId, words.title, words.body, 'paper_expiring');
    await driverPaperClient.markReminded(doc.id, due);
    sent += 1;
  }
  for (const driver of await driverPaperClient.licencesDueForReminder(until)) {
    if (!driver.licenceExpiresOn) continue;
    const due = reminderDue(driver.licenceExpiresOn, driver.licenceRemindedAt, today);
    if (due === null) continue;
    const words = reminderWords("Driver's licence", driver.licenceExpiresOn, today);
    await tell(deps, driver.userId, words.title, words.body.replace('send the new one in Your papers', 'enter the new date in Your papers'), 'paper_expiring');
    await driverPaperClient.markLicenceReminded(driver.id, due);
    sent += 1;
  }
  return sent;
}

/** Every six hours, on the one process that runs jobs. */
export function startPaperReminderJob(deps: PaperNotifyDeps, shouldRun: () => Promise<boolean>, today: () => Date, everyMs = 6 * 60 * 60_000): () => void {
  const pass = () => {
    void (async () => {
      if (!(await shouldRun().catch(() => false))) return;
      const sent = await sendPaperReminders(deps, today()).catch((error) => {
        console.warn('[driver-papers] reminder pass failed', { error: error instanceof Error ? error.message : String(error) });
        return 0;
      });
      if (sent > 0) console.info('[driver-papers] expiry reminders sent', { sent });
    })();
  };
  const first = setTimeout(pass, 2 * 60_000);
  const timer = setInterval(pass, everyMs);
  first.unref?.(); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
