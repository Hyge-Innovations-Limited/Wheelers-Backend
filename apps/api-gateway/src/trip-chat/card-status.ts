import type { RedisClient } from '../redis/client';
import { sendMetaReaction } from '../whatsapp-flows/whatsapp-notifier';

/**
 * The WhatsApp ride card as a status light: one reaction on the card that
 * changes, instead of a new message every time the driver writes or calls.
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

/** The ride card was sent: remember it, and light it 🟢. */
export async function rememberRideCard(deps: CardStatusDeps, rideId: string, phone: string, messageId: string): Promise<void> {
  if (!messageId) return;
  await deps.redis.set(cardKey(rideId), JSON.stringify({ messageId, phone, status: null } satisfies CardRecord), CARD_TTL_SECONDS);
  await setCardStatus(deps, rideId, 'live');
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
