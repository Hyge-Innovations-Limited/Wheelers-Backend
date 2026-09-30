import type { RedisClient } from '../redis/client';
import { sendMetaReaction } from '../whatsapp-flows/whatsapp-notifier';

/**
 * The trip's status light on WhatsApp: one reaction that changes, instead of
 * a new message every time the driver writes or calls. It sits on the chat
 * message ("Message or call <driver> … [Chat or call]"), the newest one when
 * the rider asks for a fresh link; on the ride card only if that could not
 * be sent.
 *
 *   live     🟢  the trip is on, nothing waiting
 *   message  💬  the driver wrote and the Trip chat page is closed
 *   call     📞  the driver is calling (and stays after a missed call)
 *   none         the trip ended: the reaction is removed
 *
 * The card's WhatsApp id is remembered when the card is sent. Meta is only
 * asked when the status really changes: ten messages cost one reaction.
 * set() answers false when there is no card to react to, or Meta refused;
 * the caller then falls back to a real message, so nothing is lost.
 */

export type CardStatus = 'live' | 'message' | 'call' | 'none';

const EMOJI: Record<CardStatus, string> = { live: '🟢', message: '💬', call: '📞', none: '' };
const CARD_TTL_SECONDS = 24 * 60 * 60;

interface CardRecord {
  messageId: string;
  phone: string;
  status: CardStatus | null;
}

const cardKey = (rideId: string) => `tripchat:card:${rideId}`;

export interface CardStatusDeps {
  redis: RedisClient;
  meta: { metaAccessToken: string; metaPhoneNumberId: string };
}

async function read(redis: RedisClient, rideId: string): Promise<CardRecord | null> {
  const raw = await redis.get(cardKey(rideId)).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CardRecord;
  } catch {
    return null;
  }
}

/**
 * This message now carries the light: 🟢, or whatever the trip already
 * showed. A message that had it before loses its reaction, so only one
 * message in the chat ever wears it.
 */
export async function rememberRideCard(deps: CardStatusDeps, rideId: string, phone: string, messageId: string): Promise<void> {
  if (!messageId) return;
  const before = await read(deps.redis, rideId);
  if (before?.messageId === messageId) return;
  const carried = before?.status && before.status !== 'none' ? before.status : 'live';
  if (before?.status) await sendMetaReaction(deps.meta, before.phone, before.messageId, '').catch(() => false);
  await deps.redis.set(cardKey(rideId), JSON.stringify({ messageId, phone, status: null } satisfies CardRecord), CARD_TTL_SECONDS);
  await setCardStatus(deps, rideId, carried);
}

export async function setCardStatus(deps: CardStatusDeps, rideId: string, status: CardStatus): Promise<boolean> {
  const card = await read(deps.redis, rideId);
  if (!card) return false;
  if (card.status === status) return true;
  const ok = await sendMetaReaction(deps.meta, card.phone, card.messageId, EMOJI[status]).catch(() => false);
  if (!ok) return false;
  if (status === 'none') {
    await deps.redis.del(cardKey(rideId)).catch(() => undefined);
  } else {
    await deps.redis.set(cardKey(rideId), JSON.stringify({ ...card, status }), CARD_TTL_SECONDS).catch(() => undefined);
  }
  return true;
}

export async function cardStatusOf(redis: RedisClient, rideId: string): Promise<CardStatus | null> {
  return (await read(redis, rideId))?.status ?? null;
}
