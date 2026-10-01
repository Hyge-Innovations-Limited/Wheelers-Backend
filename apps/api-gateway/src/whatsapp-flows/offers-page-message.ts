import type { RedisClient } from '../redis/client';
import { tripLines } from './trip-text';
import { sendMetaReaction } from './whatsapp-notifier';

/**
 * "Your bid is in": the ONE chat message a search gets. Its button opens the
 * offers page (web), where the rider sees every offer, accepts one (paying
 * there if the wallet is short), declines them all, changes the price or
 * cancels. No amount on it, and no "N drivers found" messages after it: the
 * number of offers waiting shows as a reaction on this message, 1️⃣ … 🔟,
 * changing in place — like the 🟢 💬 📞 on a trip.
 */

export interface OffersMessageMeta {
  metaAccessToken: string;
  metaPhoneNumberId: string;
}

interface Record_ {
  messageId: string;
  phone: string;
  count: number;
}

const KEY = (rideId: string) => `offers:page:message:${rideId}`;
const TTL_SECONDS = 3 * 60 * 60;
const KEYCAPS = ['', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

/** The reaction for N offers: nothing for none, 🔟 for ten or more. */
export function offerCountEmoji(count: number): string {
  if (!(count > 0)) return '';
  return KEYCAPS[Math.min(Math.floor(count), 10)]!;
}

export function bidPlacedText(trip: { pickupAddress: string; destAddress: string; stopAddresses?: string[] }): string {
  return [
    '*Your bid is in*',
    '',
    ...tripLines({ pickupAddress: trip.pickupAddress, destAddress: trip.destAddress, stops: (trip.stopAddresses ?? []).map((address) => ({ address })) }),
    '',
    'Drivers near you can see it now.',
    '',
    'Tap *See driver offers* to pick a driver, change your price or cancel. The number on this message shows how many offers are waiting.',
  ].join('\n').slice(0, 1024);
}

async function read(redis: RedisClient, rideId: string): Promise<Record_ | null> {
  const raw = await redis.get(KEY(rideId)).catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw) as Record_; } catch { return null; }
}

/**
 * Send it. The message id is kept so the count can be shown on it. False when
 * WhatsApp refused it: the caller falls back to its older message.
 */
export async function sendOffersPageMessage(
  deps: { redis: RedisClient; meta: OffersMessageMeta },
  phone: string,
  rideId: string,
  pageUrl: string,
  trip: { pickupAddress: string; destAddress: string; stopAddresses?: string[] },
  /** Another message carries the button instead (e.g. "Your driver had to cancel"): its words, not "Your bid is in". */
  bodyText?: string,
): Promise<boolean> {
  const response = await fetch(`https://graph.facebook.com/v21.0/${deps.meta.metaPhoneNumberId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${deps.meta.metaAccessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone.replace(/^\+/, ''),
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        body: { text: bodyText ?? bidPlacedText(trip) },
        action: { name: 'cta_url', parameters: { display_text: 'See driver offers', url: pageUrl } },
      },
    }),
  }).catch(() => null);
  if (!response?.ok) {
    console.error('[offers-page] bid message failed', { status: response?.status ?? null, payload: response ? await response.text().catch(() => '') : 'network error' });
    return false;
  }
  const body = await response.json().catch(() => null) as { messages?: Array<{ id?: unknown }> } | null;
  const messageId = body?.messages?.[0]?.id;
  if (typeof messageId === 'string' && messageId) {
    await deps.redis.set(KEY(rideId), JSON.stringify({ messageId, phone, count: 0 } satisfies Record_), TTL_SECONDS).catch(() => undefined);
  }
  return true;
}

/** Is this search's offers on the page (so no offers message is ever sent to the chat)? */
export async function hasOffersPageMessage(redis: RedisClient, rideId: string): Promise<boolean> {
  return (await read(redis, rideId)) !== null;
}

/** Show how many offers are waiting. Meta is only asked when the number changes. */
export async function showOfferCount(deps: { redis: RedisClient; meta: OffersMessageMeta }, rideId: string, count: number): Promise<boolean> {
  const record = await read(deps.redis, rideId);
  if (!record) return false;
  const shown = Math.min(Math.max(0, Math.floor(count)), 10);
  if (Math.min(record.count, 10) === shown) return true;
  const ok = await sendMetaReaction(deps.meta, record.phone, record.messageId, offerCountEmoji(shown)).catch(() => false);
  if (ok) await deps.redis.set(KEY(rideId), JSON.stringify({ ...record, count: shown }), TTL_SECONDS).catch(() => undefined);
  return ok;
}

/** The search is over (a driver was chosen, it was cancelled, it timed out): the number goes. */
export async function clearOfferCount(deps: { redis: RedisClient; meta: OffersMessageMeta }, rideId: string): Promise<void> {
  const record = await read(deps.redis, rideId);
  if (!record) return;
  if (record.count > 0) await sendMetaReaction(deps.meta, record.phone, record.messageId, '').catch(() => false);
  await deps.redis.del(KEY(rideId)).catch(() => undefined);
}
