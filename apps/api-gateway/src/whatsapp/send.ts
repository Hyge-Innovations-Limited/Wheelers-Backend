import { createHmac, timingSafeEqual } from 'crypto';
import type { IncomingMessage } from 'http';
import { appendWhatsappConversation } from '../LLM/conversation-store';
import { getBookingStage, lookupUserIdByPhone } from '../whatsapp-flows/bid-state';
import { withQuickActions, withQuickActionsForm } from '../whatsapp-flows/whatsapp-notifier';
import { MetaWhatsappRouteDeps } from './deps';
import { BOOKING_STEPS } from './parse';

export function getHeaderValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  return typeof value === 'string' ? value : null;
}

export function isValidMetaSignature(
  rawBody: Buffer,
  signature: string | null,
  appSecret: string | undefined,
): boolean {
  if (!appSecret) return true; // skip validation if no secret configured
  if (!signature) return false;

  // Meta sends: sha256=<hex>
  const expectedPrefix = 'sha256=';
  if (!signature.startsWith(expectedPrefix)) return false;

  const providedHash = signature.slice(expectedPrefix.length);
  const computedHash = createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex');

  const left = Buffer.from(providedHash, 'utf8');
  const right = Buffer.from(computedHash, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function normalizeMetaPhone(value: string | undefined): string | null {
  if (!value) return null;
  // Meta sends phone without '+', e.g. "2349012345678"
  const withPlus = value.startsWith('+') ? value : `+${value}`;
  if (!/^\+[1-9]\d{6,14}$/.test(withPlus)) return null;
  return withPlus;
}

/**
 * Mark the rider's message as read (blue ticks) and show the "typing…"
 * indicator while we work. WhatsApp can't stream text, but the indicator
 * holds until our reply arrives (or ~25s), so the bot reads as answering
 * rather than silent. Fire-and-forget — a failure here must never delay
 * the actual reply.
 */
export function sendTypingIndicator(
  deps: MetaWhatsappRouteDeps,
  incomingMessageId: string | undefined,
): void {
  if (!deps.metaAccessToken || !deps.metaPhoneNumberId || !incomingMessageId) return;

  const endpoint = `https://graph.facebook.com/v21.0/${deps.metaPhoneNumberId}/messages`;
  void fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${deps.metaAccessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: incomingMessageId,
      typing_indicator: { type: 'text' },
    }),
  })
    .then(async (response) => {
      if (!response.ok) {
        const payload = await response.text();
        console.warn('[whatsapp] typing indicator failed', { status: response.status, payload: payload.slice(0, 200) });
      }
    })
    .catch(() => {});
}

export async function inBookingStep(deps: MetaWhatsappRouteDeps, phone: string): Promise<boolean> {
  const userId = await lookupUserIdByPhone(deps.redisClient, phone).catch(() => null);
  if (!userId) return false;
  const stage = await getBookingStage(deps.redisClient, userId).catch(() => null);
  return Boolean(stage && BOOKING_STEPS.has(stage));
}

export async function sendMetaReply(
  deps: MetaWhatsappRouteDeps,
  to: string,
  message: string,
): Promise<void> {
  if (!deps.metaAccessToken || !deps.metaPhoneNumberId) {
    console.warn('[whatsapp] Cannot send reply — META_ACCESS_TOKEN or META_PHONE_NUMBER_ID not configured');
    return;
  }

  const recipient = to.replace(/^\+/, '');
  const endpoint = `https://graph.facebook.com/v21.0/${deps.metaPhoneNumberId}/messages`;
  const post = (payload: Record<string, unknown>) => fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${deps.metaAccessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: recipient, ...payload }),
  });

  // Every plain reply carries the Quick Actions button — except inside a
  // booking step, where "Where are you going?" with Add money / Withdraw under
  // it invites a rider mid-address to wander off. A refused list falls back to
  // the words alone.
  if (!(await inBookingStep(deps, recipient))) {
    if (deps.whatsappQuickActionsFlowId) {
      const riderId = await lookupUserIdByPhone(deps.redisClient, recipient).catch(() => null);
      if (riderId) {
        const asForm = await post({ type: 'interactive', interactive: withQuickActionsForm(message, deps.whatsappQuickActionsFlowId, riderId, deps.jwtSecret) }).catch(() => null);
        if (asForm?.ok) return;
      }
    }
    const asList = await post({ type: 'interactive', interactive: withQuickActions(message) }).catch(() => null);
    if (asList?.ok) return;
  }
  const response = await post({ type: 'text', text: { body: message } });
  if (!response.ok) {
    const payload = await response.text();
    console.error('[whatsapp] Meta reply failed', { status: response.status, payload });
  }
}

/**
 * A price under the floor is not refused, it is nudged: the lowest price for the
 * trip, with one button that offers exactly that. Typing a higher amount still works.
 */
export async function sendFloorNudge(deps: MetaWhatsappRouteDeps, phone: string, incomingMessage: string, offeredNgn: number, floorNgn: number): Promise<void> {
  const body = `₦${offeredNgn.toLocaleString()} is under the lowest price for this trip, ₦${floorNgn.toLocaleString()}.\n\nTap below to offer ₦${floorNgn.toLocaleString()}, or type a higher amount.`;
  await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: incomingMessage }, { role: 'assistant', content: body }]);
  const sent = await sendInteractive(deps, phone, { type: 'button', body: { text: body }, action: { buttons: [{ type: 'reply', reply: { id: `offer_floor:${floorNgn}`, title: `Offer ₦${floorNgn.toLocaleString()}` } }] } });
  if (!sent) await sendMetaReply(deps, phone, body);
}

/** Words alone — no button under them. For a prompt whose answer is the next thing typed. */
export async function sendMetaText(deps: MetaWhatsappRouteDeps, to: string, message: string): Promise<void> {
  if (!deps.metaAccessToken || !deps.metaPhoneNumberId) return;
  const response = await fetch(`https://graph.facebook.com/v21.0/${deps.metaPhoneNumberId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${deps.metaAccessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace(/^\+/, ''), type: 'text', text: { body: message } }),
  }).catch(() => null);
  if (!response?.ok) console.error('[whatsapp] Meta text failed', { status: response?.status ?? null });
}

/**
 * Send the interactive booking FLOW — a tappable form instead of typing.
 * The flow_token carries `new:<userId>` so the flow endpoint opens on the
 * RIDE_SETUP screen; everything the form submits runs through the same
 * guarded handlers as typed bookings.
 */
export async function sendMetaFlowMessage(
  deps: MetaWhatsappRouteDeps,
  to: string,
  flowToken: string,
): Promise<boolean> {
  if (!deps.metaAccessToken || !deps.metaPhoneNumberId || !deps.whatsappFlowId) return false;

  const recipient = to.replace(/^\+/, '');
  const endpoint = `https://graph.facebook.com/v21.0/${deps.metaPhoneNumberId}/messages`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${deps.metaAccessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'interactive',
      interactive: {
        type: 'flow',
        header: { type: 'text', text: 'Wheelers' },
        body: { text: 'Welcome! Tap below to book a ride — set your pickup, destination and your price, and nearby drivers bid in seconds.' },
        footer: { text: 'Wheelers' },
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            flow_id: deps.whatsappFlowId,
            flow_token: flowToken,
            flow_cta: 'Book now',
            // data_exchange: opening the flow calls our endpoint's INIT, so
            // the screen renders with real data. 'navigate' skipped the
            // endpoint and left ${data...} placeholders literally on screen.
            flow_action: 'data_exchange',
          },
        },
      },
    }),
  });
  if (!response.ok) {
    const payload = await response.text();
    console.error('[whatsapp] flow message failed', { status: response.status, payload });
    return false;
  }
  return true;
}

export async function sendWhatsappText(
  deps: MetaWhatsappRouteDeps,
  phone: string,
  incomingMessage: string,
  reply: string,
): Promise<void> {
  await appendWhatsappConversation(deps.redisClient, phone, [
    { role: 'user', content: incomingMessage },
    { role: 'assistant', content: reply },
  ]);
  await sendMetaReply(deps, phone, reply);
}

/**
 * A message with one tappable link button. WhatsApp opens it in its in-app
 * browser, on top of the chat. If the interactive message is refused, the
 * rider still gets the link as plain text — never silence.
 */
export async function sendMetaLinkButton(
  deps: MetaWhatsappRouteDeps,
  to: string,
  body: string,
  buttonText: string,
  url: string,
): Promise<void> {
  if (!deps.metaAccessToken || !deps.metaPhoneNumberId) {
    console.warn('[whatsapp] Cannot send link button — Meta credentials not configured');
    return;
  }
  const response = await fetch(`https://graph.facebook.com/v21.0/${deps.metaPhoneNumberId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${deps.metaAccessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to.replace(/^\+/, ''),
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        body: { text: body },
        action: { name: 'cta_url', parameters: { display_text: buttonText.slice(0, 20), url } },
      },
    }),
  }).catch(() => null);

  if (!response?.ok) {
    console.error('[whatsapp] link button failed — falling back to a text link', {
      status: response?.status ?? null,
      payload: response ? await response.text().catch(() => '') : 'network error',
    });
    await sendMetaReply(deps, to, `${body}\n\n${url}`);
  }
}

export async function replyAndLog(
  deps: MetaWhatsappRouteDeps,
  phone: string,
  userMessage: string,
  reply: string,
): Promise<void> {
  await appendWhatsappConversation(deps.redisClient, phone, [
    { role: 'user', content: userMessage },
    { role: 'assistant', content: reply },
  ]);
  await sendMetaReply(deps, phone, reply);
}

// ── Privacy consent: asked once, before anything else ────────────────────

export function clip(text: string, max: number): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).replace(/[\s,·-]+$/, '')}…`;
}

/** Up to three tappable replies. A tap arrives as its title, like typed text. */
export async function sendMetaButtons(
  deps: MetaWhatsappRouteDeps,
  to: string,
  body: string,
  titles: string[],
): Promise<void> {
  const fallback = `${body}\n\n${titles.map((title) => `• *${title}*`).join('\n')}`;
  if (!deps.metaAccessToken || !deps.metaPhoneNumberId) {
    await sendMetaReply(deps, to, fallback);
    return;
  }
  const response = await fetch(`https://graph.facebook.com/v21.0/${deps.metaPhoneNumberId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${deps.metaAccessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to.replace(/^\+/, ''),
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body.slice(0, 1024) },
        action: {
          buttons: titles.slice(0, 3).map((title, index) => ({
            type: 'reply',
            reply: { id: `way_out_${index}`, title: title.slice(0, 20) },
          })),
        },
      },
    }),
  }).catch(() => null);

  if (!response?.ok) {
    console.error('[whatsapp] buttons failed — falling back to text', {
      status: response?.status ?? null,
      payload: response ? await response.text().catch(() => '') : 'network error',
    });
    await sendMetaReply(deps, to, fallback);
  }
}

/** One interactive message. False when it could not be sent, so the caller can say it in text. */
export async function sendInteractive(deps: MetaWhatsappRouteDeps, to: string, interactive: Record<string, unknown>): Promise<boolean> {
  if (!deps.metaAccessToken || !deps.metaPhoneNumberId) return false;
  const response = await fetch(`https://graph.facebook.com/v21.0/${deps.metaPhoneNumberId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${deps.metaAccessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace(/^\+/, ''), type: 'interactive', interactive }),
  }).catch(() => null);
  if (!response?.ok) {
    console.error('[whatsapp] interactive message failed — falling back to text', {
      kind: interactive['type'],
      status: response?.status ?? null,
      payload: response ? await response.text().catch(() => '') : 'network error',
    });
    return false;
  }
  return true;
}

