import { WAITING_RATES_NGN } from '@wheleers/config';
import { rideClient } from '@wheleers/db';
import { actOnWaiting, WaitingDealError } from '../rides/waiting-deal';
import { signFlowToken } from '../whatsapp-flows/encryption';

/**
 * The waiting price in the chat (Timi, 16 Nov 2026), for WhatsApp riders not
 * on the ride page (the page asks itself):
 *
 *   free minutes over   "Your driver has waited 5 min."   [Keep driver waiting] [Cancel ride]
 *   Keep driver waiting  a list: ₦40/min … ₦100/min
 *   the driver counters  "Your driver asks ₦80/min."      [Accept ₦80/min] [Other price] [Cancel ride]
 *   agreed               "Agreed: ₦60/min. Waiting time counts from now."
 *
 * Cancel ride is the usual cancel (its reasons), free.
 *
 * With the Waiting time form published (WHATSAPP_WAITING_FLOW_ID, npm run flow:push:waiting), the question and
 * the counter are one form message each ("Choose", "Answer") and the rest happens in the form
 * (whatsapp-flows/waiting-flow.ts): two messages instead of five. Without it, or if Meta refuses the form
 * message, the buttons above.
 */

export const WAIT_KEEP_ID = 'wait_keep';
export const WAIT_CANCEL_ID = 'wait_cancel';
const RATE_ID = /^wait_rate:(\d+)$/;
const OK_ID = /^wait_ok:(\d+)$/;

type Meta = { metaAccessToken?: string; metaPhoneNumberId?: string };
/** What a form message needs too: the secret that signs its token. */
type FormMeta = Meta & { flowTokenSecret?: string };

export function isWaitingDealReply(replyId: string | undefined | null): boolean {
  return !!replyId && (replyId === WAIT_KEEP_ID || replyId === WAIT_CANCEL_ID || RATE_ID.test(replyId) || OK_ID.test(replyId));
}

const naira = (n: number) => `₦${n.toLocaleString('en-NG')}`;

export function waitingAskMessage(freeMinutes: number): Record<string, unknown> {
  return {
    type: 'button',
    body: { text: `Your driver has waited ${freeMinutes} min.\nKeep them waiting for a price a minute, or cancel. Nothing is charged until you both agree.` },
    action: {
      buttons: [
        { type: 'reply', reply: { id: WAIT_KEEP_ID, title: 'Keep driver waiting' } },
        { type: 'reply', reply: { id: WAIT_CANCEL_ID, title: 'Cancel ride' } },
      ],
    },
  };
}

export function waitingRatesMessage(): Record<string, unknown> {
  return {
    type: 'list',
    body: { text: 'Pick a price a minute. Your driver can accept or ask for another.' },
    action: {
      button: 'Pick a price',
      sections: [{ title: 'Price a minute', rows: WAITING_RATES_NGN.map((n) => ({ id: `wait_rate:${n}`, title: `${naira(n)}/min` })) }],
    },
  };
}

export function driverCounterMessage(ngn: number): Record<string, unknown> {
  return {
    type: 'button',
    body: { text: `Your driver asks ${naira(ngn)}/min to keep waiting.` },
    action: {
      buttons: [
        { type: 'reply', reply: { id: `wait_ok:${ngn}`, title: `Accept ${naira(ngn)}/min` } },
        { type: 'reply', reply: { id: WAIT_KEEP_ID, title: 'Other price' } },
        { type: 'reply', reply: { id: WAIT_CANCEL_ID, title: 'Cancel ride' } },
      ],
    },
  };
}

export const agreedLine = (ngn: number) => `Agreed: ${naira(ngn)}/min. Waiting time counts from now.`;
export const sentLine = (ngn: number) => `Sent ${naira(ngn)}/min. Waiting for your driver.`;

/** The same message as plain text, when Meta refuses the interactive one. */
function asText(interactive: Record<string, unknown>): string {
  const body = (interactive.body as { text?: string } | undefined)?.text ?? '';
  const action = interactive.action as { buttons?: Array<{ reply: { title: string } }>; sections?: Array<{ rows: Array<{ title: string }> }> } | undefined;
  const options = action?.buttons?.map((b) => b.reply.title) ?? action?.sections?.flatMap((s) => s.rows.map((r) => r.title)) ?? [];
  return [body, '', ...options.map((o) => `• *${o}*`)].join('\n').trim();
}

async function post(meta: Meta, to: string, payload: Record<string, unknown>): Promise<boolean> {
  if (!meta.metaAccessToken || !meta.metaPhoneNumberId) return false;
  const response = await fetch(`https://graph.facebook.com/v21.0/${meta.metaPhoneNumberId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${meta.metaAccessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace(/^\+/, ''), ...payload }),
  }).catch(() => null);
  if (!response?.ok) {
    console.warn('[waiting-deal] WhatsApp send failed', { status: response?.status ?? null, type: payload.type });
    return false;
  }
  return true;
}

/** An interactive message, or the same words as text when it is refused. */
export async function sendWaitingInteractive(meta: Meta, to: string, interactive: Record<string, unknown>): Promise<void> {
  if (await post(meta, to, { type: 'interactive', interactive })) return;
  await post(meta, to, { type: 'text', text: { body: asText(interactive) } });
}

export async function sendWaitingText(meta: Meta, to: string, text: string): Promise<void> {
  await post(meta, to, { type: 'text', text: { body: text } });
}

/**
 * A tap on one of the messages above. `cancel` runs the chat's usual cancel (as if they typed it).
 * Never throws.
 */
export async function handleWaitingDealTap(
  meta: Meta,
  userId: string,
  phone: string,
  replyId: string,
  cancel: () => Promise<void>,
): Promise<void> {
  try {
    if (replyId === WAIT_CANCEL_ID) {
      await cancel();
      return;
    }
    if (replyId === WAIT_KEEP_ID) {
      await sendWaitingInteractive(meta, phone, waitingRatesMessage());
      return;
    }
    const rate = RATE_ID.exec(replyId);
    const ok = OK_ID.exec(replyId);
    const ngn = Number((rate ?? ok)?.[1]);
    const ride = await rideClient.findActiveByRider(userId).catch(() => null);
    if (!ride) {
      await sendWaitingText(meta, phone, 'This trip has ended.');
      return;
    }
    const waiting = await actOnWaiting(ride.id, userId, { action: ok ? 'accept' : 'offer', ngn });
    const agreed = waiting?.deal.rateNgn;
    await sendWaitingText(meta, phone, typeof agreed === 'number' ? agreedLine(agreed) : sentLine(ngn));
  } catch (error) {
    if (error instanceof WaitingDealError) {
      await sendWaitingText(meta, phone, error.message);
      return;
    }
    console.warn('[waiting-deal] chat tap failed', { userId, replyId, error: error instanceof Error ? error.message : String(error) });
    await sendWaitingText(meta, phone, 'Something went wrong. Try again.');
  }
}

/** The Waiting time form's id on Meta, when it is published. */
export function waitingFormId(): string | null {
  return process.env['WHATSAPP_WAITING_FLOW_ID']?.trim() || null;
}

/** One form message: the words, and a button that opens the Waiting time form for this rider. */
export function waitingFormMessage(text: string, cta: string, riderId: string, flowId: string, secret: string): Record<string, unknown> {
  return {
    type: 'flow',
    body: { text },
    action: {
      name: 'flow',
      parameters: {
        flow_message_version: '3',
        flow_id: flowId,
        flow_token: signFlowToken(`wait:${riderId}`, secret),
        flow_cta: cta,
        flow_action: 'data_exchange',
      },
    },
  };
}

export const askFormText = (freeMinutes: number) =>
  `*Your driver has waited ${freeMinutes} min*\nKeep them waiting for a price a minute, or cancel. Nothing is charged until you both agree.`;
export const counterFormText = (ngn: number) => `*Your driver asks ${naira(ngn)}/min*\nTo keep waiting. Accept it, pick another price, or cancel.`;

/** The form message when the form is published and can be signed; false when it was not sent (the caller sends the buttons). */
async function sendForm(meta: FormMeta, to: string, riderId: string, text: string, cta: string): Promise<boolean> {
  const flowId = waitingFormId();
  if (!flowId || !meta.flowTokenSecret) return false;
  return post(meta, to, { type: 'interactive', interactive: waitingFormMessage(text, cta, riderId, flowId, meta.flowTokenSecret) });
}

/** The free minutes are over: the form ("Choose"), or the buttons. */
export async function sendWaitingAsk(meta: FormMeta, to: string, riderId: string, freeMinutes: number): Promise<void> {
  if (await sendForm(meta, to, riderId, askFormText(freeMinutes), 'Choose')) return;
  await sendWaitingInteractive(meta, to, waitingAskMessage(freeMinutes));
}

/** The driver asked another price: the form ("Answer"), or the buttons. */
export async function sendDriverCounter(meta: FormMeta, to: string, riderId: string, ngn: number): Promise<void> {
  if (await sendForm(meta, to, riderId, counterFormText(ngn), 'Answer')) return;
  await sendWaitingInteractive(meta, to, driverCounterMessage(ngn));
}
