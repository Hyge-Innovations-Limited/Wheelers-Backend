import { randomBytes } from 'node:crypto';
import type { RedisClient } from '../redis/client';
import type { MetaWhatsappRouteDeps } from './deps';

/**
 * A ride for later starting its search outside the rider's 24 h WhatsApp
 * window: a plain message cannot reach them there, only an approved template.
 * Set WHATSAPP_SCHEDULED_TEMPLATE (its name in Meta) and, when not English,
 * WHATSAPP_SCHEDULED_TEMPLATE_LANG. Unset: rides for later are offered only
 * inside the window (the ride page's scheduleUntil), and one that would start
 * outside it does not start.
 *
 * The template (see the setup notes, meta-template.md): body "Your ride for
 * later from {{1}} to {{2}} is looking for a driver now. Tap below to see the
 * offers and pick one.", a URL button "See driver offers" to
 * https://<app>/ride-page/open/{{1}} — {{1}} a random one-time code, never the
 * link itself (GET /ride-page/open/:code spends it and sends the rider on to
 * the page with a fresh link) — and a quick reply "OK" (a tap is a message:
 * it opens the rider's window, so the chat can speak to them again).
 */
export function scheduledStartTemplate(): { name: string; language: string } | null {
  const name = process.env['WHATSAPP_SCHEDULED_TEMPLATE']?.trim();
  if (!name) return null;
  return { name, language: process.env['WHATSAPP_SCHEDULED_TEMPLATE_LANG']?.trim() || 'en' };
}

/**
 * A ride for later's start could not reach the rider in the chat: their window
 * is closed and the template was not sent (none set, or Meta refused it). A
 * plain message is never tried there (it would not arrive).
 */
export class ChatUnreachableError extends Error {
  constructor() {
    super('The rider cannot be reached in the chat: their WhatsApp window is closed and the start template was not sent.');
    this.name = 'ChatUnreachableError';
  }
}

/** The template's quick reply ("OK"): a tap opens the rider's window, and needs no answer. */
export const SCHEDULED_TEMPLATE_REPLY_ID = 'ride_later_ok';

/* ── the button's one-time code ──────────────────────────────────────── */

/** As long as the template's button may sensibly be tapped (it is kept in the chat). */
const OPEN_CODE_TTL_SECONDS = 24 * 60 * 60;
const openCodeKey = (code: string) => `ride_page:open:${code}`;

/** A random code for the template's button: whose page it opens. */
export async function createRidePageOpenCode(redis: RedisClient, userId: string): Promise<string> {
  const code = randomBytes(18).toString('base64url');
  await redis.set(openCodeKey(code), userId, OPEN_CODE_TTL_SECONDS);
  return code;
}

/** The button was tapped: whose page it opens, once (the code is spent). Null: unknown, spent or old. */
export async function takeRidePageOpenCode(redis: RedisClient, code: string): Promise<string | null> {
  const key = openCodeKey(code);
  const taken = await Promise.resolve().then(() => redis.send('GETDEL', key)).catch(() => undefined);
  if (typeof taken === 'string') return taken || null;
  if (taken === null) return null;
  // A Redis without GETDEL (tests, a very old server): read, then delete.
  const userId = await redis.get(key).catch(() => null);
  if (userId) await redis.del(key).catch(() => undefined);
  return userId;
}

/** A template parameter: one line, short (Meta refuses new lines, tabs and long runs of spaces). */
function templateText(value: string, max = 60): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  const first = flat.split(',')[0]?.trim() || flat;
  return first.length > max ? `${first.slice(0, max - 1)}…` : first || '-';
}

/** Sends the start as the template. True when Meta took it. */
export async function sendScheduledStartTemplate(
  deps: Pick<MetaWhatsappRouteDeps, 'metaAccessToken' | 'metaPhoneNumberId' | 'redisClient'>,
  userId: string,
  phone: string,
  trip: { pickupAddress: string; destAddress: string },
): Promise<boolean> {
  const template = scheduledStartTemplate();
  if (!template || !deps.metaAccessToken || !deps.metaPhoneNumberId) return false;
  const code = await createRidePageOpenCode(deps.redisClient, userId).catch(() => null);
  if (!code) return false;
  const response = await fetch(`https://graph.facebook.com/v21.0/${deps.metaPhoneNumberId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${deps.metaAccessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.language },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: templateText(trip.pickupAddress) }, { type: 'text', text: templateText(trip.destAddress) }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
          { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: SCHEDULED_TEMPLATE_REPLY_ID }] },
        ],
      },
    }),
  }).catch(() => null);
  if (!response?.ok) {
    console.warn('[whatsapp] scheduled start template refused', { status: response?.status, payload: response ? (await response.text().catch(() => '')).slice(0, 300) : 'no response' });
    return false;
  }
  return true;
}
