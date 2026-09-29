import type { NotificationEvent, RideEvent } from '@wheleers/kafka-schemas';
import type { RedisClient } from '../redis/client';
import type { TurnConfig } from './ice-servers';

/** What the trip chat needs from the rest of the gateway. Narrow on purpose, so tests can hand it fakes. */
export interface TripChatDeps {
  redis: RedisClient;
  /** Delivers to every socket a user has open, on any gateway process. */
  sockets: {
    sendToUser(userId: string, type: string, payload: Record<string, unknown>): Promise<void>;
    isUserConnected(userId: string): Promise<boolean>;
  };
  publisher: {
    publishRideEvent(event: RideEvent): Promise<void>;
    publishNotificationEvent(event: NotificationEvent): Promise<void>;
  };
  /** Messages to WhatsApp riders. Absent when Meta is not configured (and in tests). */
  whatsapp?: TripWhatsapp;
  calls: {
    enabled: boolean;
    turn: TurnConfig;
    /** How long a phone rings. The WhatsApp rider has to see the message and open the page, so they get longer. */
    ringMs?: { app: number; whatsapp: number };
    /** A call is cut off after this long. */
    maxCallMs?: number;
  };
  now?: () => number;
}

export interface TripWhatsapp {
  /** The rider's own link to the Trip chat page for this ride; `callId` makes the page answer that call. */
  pageUrl(riderId: string, rideId: string, callId?: string): string | null;
  /** A message, with one button that opens `button.url` when given. */
  send(phone: string, body: string, button?: { text: string; url: string }): Promise<void>;
  /**
   * The ride card's status light (card-status.ts). False when this ride has
   * no card to react to, or Meta refused: send a real message instead.
   */
  setCardStatus(rideId: string, status: 'live' | 'message' | 'call' | 'none'): Promise<boolean>;
}

// WhatsApp riders see 📞 on the ride card, tap it, and open the page: they get a minute.
export const RING_MS = { app: 30_000, whatsapp: 60_000 };
export const MAX_CALL_MS = 30 * 60 * 1000;
/** Calls one person may start on one trip in ten minutes. */
export const CALLS_PER_TEN_MINUTES = 5;
/** Messages one person may send on one trip in a minute. */
export const MESSAGES_PER_MINUTE = 20;
export const MAX_MESSAGE_CHARS = 1000;

export const nowOf = (deps: TripChatDeps) => (deps.now ? deps.now() : Date.now());
