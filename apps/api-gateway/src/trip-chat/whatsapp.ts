import { createWalletPageToken, TRIP_PAGE_TOKEN_TTL_SECONDS } from '../auth/local';
import { sendMetaLinkMessage, sendMetaWhatsappMessage, type WhatsappNotifierDeps } from '../whatsapp-flows/whatsapp-notifier';
import type { RedisClient } from '../redis/client';
import { setCardStatus } from './card-status';
import type { TripWhatsapp } from './deps';

/**
 * The rider's own link to the Trip chat page for one ride. The token names the
 * rider and the ride; `call` tells the page to answer that call on opening.
 */
export function tripPageUrl(appBaseUrl: string, jwtSecret: string, riderId: string, rideId: string, callId?: string): string {
  const token = createWalletPageToken(riderId, 'trip', jwtSecret, TRIP_PAGE_TOKEN_TTL_SECONDS, rideId);
  const base = appBaseUrl.replace(/\/+$/, '');
  return `${base}/widget/trip/chat.html#t=${encodeURIComponent(token)}${callId ? `&call=${encodeURIComponent(callId)}` : ''}`;
}

export function createTripWhatsapp(notifier: WhatsappNotifierDeps, appBaseUrl: string | undefined, jwtSecret: string, redis: RedisClient): TripWhatsapp {
  const cardDeps = { redis, meta: { metaAccessToken: notifier.metaAccessToken, metaPhoneNumberId: notifier.metaPhoneNumberId } };
  return {
    setCardStatus: (rideId, status) => setCardStatus(cardDeps, rideId, status).catch(() => false),
    pageUrl: (riderId, rideId, callId) => (appBaseUrl ? tripPageUrl(appBaseUrl, jwtSecret, riderId, rideId, callId) : null),
    send: async (phone, body, button) => {
      if (button) {
        await sendMetaLinkMessage(notifier, phone, body, button.text, button.url);
        return;
      }
      await sendMetaWhatsappMessage(notifier, phone, body);
    },
  };
}
