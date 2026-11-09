import type { RedisClient } from '../redis/client';

/**
 * Reactions as notifications (Timi, 3 Nov 2026): at the moments a rider is
 * waiting for, the bot reacts with an emoji to the last message they sent.
 * Their phone shows "Wheelers reacted 🚗 to: …" even with WhatsApp closed.
 * The messages themselves are unchanged; a reaction is on top, never instead.
 *
 * Off unless WHATSAPP_RIDE_REACTIONS=on. Each moment reacts once per ride.
 * Nothing to react to (no message from them in 30 days, or a reaction Meta
 * refuses) is fine: the message has already gone, so nobody misses anything.
 */
export type RideMoment = 'requested' | 'offer' | 'accepted' | 'arrived' | 'done';

export const RIDE_MOMENT_EMOJI: Record<RideMoment, string> = {
  requested: '👍',
  offer: '🙋',
  accepted: '🚗',
  arrived: '📍',
  done: '✅',
};

/** Meta lets a reaction go on a message up to 30 days old. */
const LAST_IN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Long enough to outlast any one ride. */
const ONCE_TTL_SECONDS = 3 * 24 * 60 * 60;

/** By phone: every ride event knows the rider's number. */
export const lastInboundKey = (phone: string) => `whatsapp:phone:${phone.replace(/\D/g, '')}:last_in_msg`;
const onceKey = (rideId: string, moment: RideMoment) => `whatsapp:ride:${rideId}:reacted:${moment}`;

export const rideReactionsOn = () => (process.env['WHATSAPP_RIDE_REACTIONS'] ?? '').trim().toLowerCase() === 'on';

/** Every message a rider sends: kept as the one the next reaction goes on. */
export async function rememberLastInbound(redis: Pick<RedisClient, 'set'>, phone: string, messageId: string | undefined): Promise<void> {
  if (!messageId || !phone) return;
  await redis.set(lastInboundKey(phone), messageId, LAST_IN_TTL_SECONDS).catch(() => undefined);
}

export interface RideReactionDeps {
  redisClient: Pick<RedisClient, 'get' | 'setIfNotExists'>;
  metaAccessToken: string;
  metaPhoneNumberId: string;
}

/** React for this moment of this ride, once. True when Meta took it. Never throws. */
export async function reactForRide(deps: RideReactionDeps, phone: string, rideId: string, moment: RideMoment): Promise<boolean> {
  try {
    if (!rideReactionsOn() || !deps.metaAccessToken || !deps.metaPhoneNumberId) return false;
    const messageId = await deps.redisClient.get(lastInboundKey(phone));
    if (!messageId) return false;
    if (!(await deps.redisClient.setIfNotExists(onceKey(rideId, moment), '1', ONCE_TTL_SECONDS))) return false;
    const res = await fetch(`https://graph.facebook.com/v21.0/${deps.metaPhoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deps.metaAccessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone.replace(/^\+/, ''),
        type: 'reaction',
        reaction: { message_id: messageId, emoji: RIDE_MOMENT_EMOJI[moment] },
      }),
    });
    if (!res.ok) {
      console.warn('[whatsapp] ride reaction refused', { moment, status: res.status });
      return false;
    }
    return true;
  } catch (error) {
    console.warn('[whatsapp] ride reaction failed', { moment, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
