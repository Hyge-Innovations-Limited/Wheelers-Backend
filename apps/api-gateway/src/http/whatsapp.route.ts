import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { driverClient, userClient, groupRideClient, walletClient, walletSecurityClient, virtualAccountClient, withdrawalClient, rideClient } from '@wheleers/db';
import {
  GoogleMapsRoutePlanner,
  calculateRideFees,
  validateRiderOffer,
  depositNeededFor,
} from '@wheleers/config';
import {
  RideRequestedEvent,
  RideCancelledEvent,
  RideOfferAcceptedEvent,
  FeedbackLoggedEvent,
} from '@wheleers/kafka-schemas';
import type { PaymentsClient } from '@wheleers/payments';
import { createWalletPageToken, DEPOSIT_PAGE_TOKEN_TTL_SECONDS, RIDE_PAGE_TOKEN_TTL_SECONDS, WALLET_PAGE_TOKEN_TTL_SECONDS, type WalletPageScope } from '../auth/local';
import type { RidePageChatEvent } from './ride-page.route';
import { confirmRideWithOffer, offerKey, publishWhatsappRide } from '../rides/whatsapp-ride.service';
import { cancelRiderSos, raiseRiderSos } from '../safety/rider-sos';
import {
  QUICK_ACTION_IDS, HISTORY_ROW, REPEAT_ROW, REVERSE_ROW, isQuickActionId, asksForMenu,
  recentTrips, reversed, buildQuickActions, buildHistoryList, buildRepeatButtons, quickActionsBody, type PastTrip,
} from './quick-actions';
import type { GatewayPublisher } from '../websocket/publisher';
import { onboardWhatsappUser, provisionDepositAccount } from '../onboarding/user-onboarding';
import {
  appendWhatsappConversation,
  getWhatsappConversation,
} from '../LLM/conversation-store';
import { WhatsappBotService } from '../LLM/whatsapp-bot.service';
import { createLlm } from '../LLM/llm';
import type { LlmClient } from '../LLM/llm';
import { geocodeMissLine, isPinInsideServiceArea, outsideServiceAreaMatch, OUTSIDE_SERVICE_AREA_LINE } from '../LLM/geocoding';
import { parseRideIntent } from '../LLM/ride-intent-parser';
import { classifyWalletIntent, mightConcernMoney, walletIntentModel } from '../LLM/wallet-intent';
import { classifyBookingIntent, mightNotBeAnAddress } from '../LLM/booking-intent';
import type { BookingIntentResult } from '../LLM/booking-intent';
import { loadRiderMemory, rememberExchange, renderRiderMemoryForIntent } from '../LLM/rider-memory';
import { geocodeAddress, reverseGeocode, findPlaceOptions, findAreaSpots, kmBetween, SAME_CITY_KM, SAME_PLACE_KM } from '../LLM/geocoding';
import { verifySelfiePhoto } from '../LLM/face-check';
import { downloadMetaMedia } from '../whatsapp-flows/meta-media';
import { buildReadyForMatchEvent } from '../group-ride/ready-event';
import { findGroupRideSuggestion } from '../group-ride/suggestion';
import { logActivity } from '../analytics/log-activity';
import type { GroupRideFaceStorage } from '../storage/group-ride-face-storage';
import {
  storeWhatsappRide,
  setActiveRide,
  getActiveRide,
  clearActiveRide,
  setPhoneLookup,
  cleanupRideKeys,
  setPendingLocation,
  setPendingAreaHint,
  getPendingAreaHint,
  clearPendingAreaHint,
  getPendingLocation,
  clearPendingLocation,
  setBookingStage,
  getBookingStage,
  clearBookingStage,
  getBids,
  getLastBatch,
  storeLastBatch,
  getRideState,
  getRideMeta,
  getAcceptedBid,
  storePendingRoute,
  getPendingRoute,
  clearPendingRoute,
  storePendingGroupRide,
  getPendingGroupRide,
  clearPendingGroupRide,
  setGroupRequestRider,
  getGroupRequestRider,
  clearGroupRequestRider,
  storePendingGeoChoices,
  getPendingGeoChoices,
  clearPendingGeoChoices,
  storePendingFarPlace,
  getPendingFarPlace,
  clearPendingFarPlace,
  noteBookingMiss,
  clearBookingMisses,
  getGroupSeat,
  recordAcceptedSeat,
  clearAcceptedSeats,
  getGroupSeatMembers,
  storePendingAccept,
  markOffersMessageSent,
  getPendingAccept,
  clearPendingAccept,
  clearPendingWhatsappWithdrawal,
  storeLastRoute,
  getLastRoute,
  getLastCompletedRide,
  lookupUserIdByPhone,
  clearLastCompletedRide,
} from '../whatsapp-flows/bid-state';
import { MAX_CHAT_STOPS } from '../whatsapp-flows/bid-state';
import type { PendingGeoChoices, PendingRouteData, RouteStop } from '../whatsapp-flows/bid-state';
import { signFlowToken } from '../whatsapp-flows/encryption';
import type { WhatsappBid } from '../whatsapp-flows/bid-state';
import { sendFlowOffersMessage, sendBidPlacedMessage } from '../whatsapp-flows/whatsapp-notifier';
import { EDIT_TRIP_FLOW_ENABLED, META_FLOWS_ENABLED, QUICK_ACTIONS_FLOW_ENABLED } from '../whatsapp-flows/flow-toggle';
import { withQuickActions, withQuickActionsForm } from '../whatsapp-flows/whatsapp-notifier';
import {
  CHANGE_PRICE_REPLY_ID,
  formatBidList,
  parseOfferReplyId,
  sendOffersInChat,
  sortOffers,
} from '../whatsapp-flows/whatsapp-notifier';
import type { DriverKycStorage } from '../storage/driver-kyc-storage';
import type { RedisClient } from '../redis/client';
import { readRawBody, sendJson } from './utils';

export interface MetaWhatsappRouteDeps {
  jwtSecret: string;
  publisher: GatewayPublisher;
  paymentsClient: PaymentsClient;
  redisClient: RedisClient;
  routePlanner: GoogleMapsRoutePlanner;
  googleMapsApiKey: string;
  metaAccessToken?: string;
  metaPhoneNumberId?: string;
  metaAppSecret?: string;
  metaWebhookVerifyToken?: string;
  groqApiKey?: string;
  groqModel: string;
  groqTimeoutMs: number;
  appBaseUrl?: string;
  driverKycStorage?: DriverKycStorage;
  groupRideFaceStorage?: GroupRideFaceStorage;
  /** Platform treasury VA — payouts draw from this float when configured. */
  /** Published Meta Flow id for the booking form. Unset = chat-only booking. */
  whatsappFlowId?: string;
  whatsappOffersFlowId?: string;
  /** Published "Edit trip" form. Unset = Edit trip opens the chat's Choose sheet. */
  whatsappEditTripFlowId?: string;
  /** Published offers form. Unset = offers arrive with reply buttons / the Choose list. */
  whatsappOffersFormFlowId?: string;
  /** Published Quick Actions form. Unset = the menu is WhatsApp's list picker. */
  whatsappQuickActionsFlowId?: string;
}

/* ─── Meta Cloud API helpers ─── */

function getHeaderValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  return typeof value === 'string' ? value : null;
}

function isValidMetaSignature(
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

function normalizeMetaPhone(value: string | undefined): string | null {
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
function sendTypingIndicator(
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

/** The steps where a reply is a question the rider is in the middle of answering. */
const BOOKING_STEPS: ReadonlySet<string> = new Set([
  'awaiting_pickup', 'awaiting_destination', 'awaiting_trip_confirm', 'adding_stop', 'awaiting_price',
  'awaiting_route_confirmation', 'editing_pickup', 'editing_destination', 'awaiting_cancel_reason',
  'group_awaiting_pickup', 'group_awaiting_destination', 'group_awaiting_confirm', 'group_awaiting_face_photo',
  'awaiting_withdrawal_amount', 'awaiting_withdrawal_bank', 'awaiting_withdrawal_account', 'awaiting_withdrawal_confirmation',
]);
async function inBookingStep(deps: MetaWhatsappRouteDeps, phone: string): Promise<boolean> {
  const userId = await lookupUserIdByPhone(deps.redisClient, phone).catch(() => null);
  if (!userId) return false;
  const stage = await getBookingStage(deps.redisClient, userId).catch(() => null);
  return Boolean(stage && BOOKING_STEPS.has(stage));
}

async function sendMetaReply(
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
    if (QUICK_ACTIONS_FLOW_ENABLED && deps.whatsappQuickActionsFlowId) {
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

/** Words alone — no button under them. For a prompt whose answer is the next thing typed. */
async function sendMetaText(deps: MetaWhatsappRouteDeps, to: string, message: string): Promise<void> {
  if (!deps.metaAccessToken || !deps.metaPhoneNumberId) return;
  const response = await fetch(`https://graph.facebook.com/v21.0/${deps.metaPhoneNumberId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${deps.metaAccessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace(/^\+/, ''), type: 'text', text: { body: message } }),
  }).catch(() => null);
  if (!response?.ok) console.error('[whatsapp] Meta text failed', { status: response?.status ?? null });
}

const OPENER_WORDS = new Set([
  'hi', 'hello', 'hey', 'hiya', 'yo', 'sup', 'wassup', 'whatsup', 'whats', 'up',
  'good', 'morning', 'afternoon', 'evening', 'day', 'how', 'far', 'you', 'dey',
  'there', 'wheelers', 'start', 'menu', 'book', 'ride', 'a', 'i', 'want', 'my',
  'need', 'abeg', 'please', 'o', 'oo', 'now', 'wanna',
]);

/**
 * "Hi", "Hi wassup", "good morning o", "book a ride abeg" — all openers that
 * deserve the greeting + Book Ride button. "Hi, take me to Lekki" is NOT:
 * 'take'/'lekki' are content words, so the chat brain handles it fully.
 */
function isBookingOpener(message: string): boolean {
  const words = message
    .toLowerCase()
    .replace(/[^a-z\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0 || words.length > 6) return false;
  return words.every((word) => OPENER_WORDS.has(word.replace(/'/g, '')));
}

/**
 * Send the interactive booking FLOW — a tappable form instead of typing.
 * The flow_token carries `new:<userId>` so the flow endpoint opens on the
 * RIDE_SETUP screen; everything the form submits runs through the same
 * guarded handlers as typed bookings.
 */
async function sendMetaFlowMessage(
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

function sendOk(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/plain');
  res.end('OK');
}

/* ─── Webhook verification (GET) ─── */

export function handleMetaWhatsappVerify(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MetaWhatsappRouteDeps,
): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  console.info('[whatsapp] Verify attempt', { mode, token: token?.slice(0, 10), expected: deps.metaWebhookVerifyToken?.slice(0, 10) });
  if (mode === 'subscribe' && token === deps.metaWebhookVerifyToken) {
    console.info('[whatsapp] Webhook verified');
    res.statusCode = 200;
    res.setHeader('content-type', 'text/plain');
    res.end(challenge ?? '');
    return;
  }

  sendJson(res, 403, { error: 'Verification failed' });
}

/* ─── Extract message from Meta webhook payload ─── */

interface MetaMessageInfo {
  messageId: string;
  phone: string;
  profileName?: string;
  messageBody: string;
  isLocation: boolean;
  locationLat?: number;
  locationLng?: number;
  isImage?: boolean;
  imageMediaId?: string;
  imageMimeType?: string;
  /** The id of the button or list row that was tapped — what it MEANS, where the title is only what it said. */
  replyId?: string;
}

function extractMetaMessages(body: unknown): MetaMessageInfo[] {
  const out: MetaMessageInfo[] = [];
  const payload = body as Record<string, unknown>;
  if (payload.object !== 'whatsapp_business_account') return out;

  const entries = payload.entry as Array<Record<string, unknown>> | undefined;
  if (!entries?.length) return out;

  for (const entry of entries) {
    const changes = entry.changes as Array<Record<string, unknown>> | undefined;
    if (!changes?.length) continue;

    for (const change of changes) {
      const value = change.value as Record<string, unknown> | undefined;
      if (!value) continue;

      const messages = value.messages as Array<Record<string, unknown>> | undefined;
      if (!messages?.length) continue;

      // Meta batches: a text and a pin sent together arrive in one delivery.
      // Handling only the first silently dropped the second.
      for (const msg of messages) {
        const info = parseMetaMessage(msg, value);
        if (info) out.push(info);
      }
    }
  }

  return out;
}

function parseMetaMessage(
  msg: Record<string, unknown>,
  value: Record<string, unknown>,
): MetaMessageInfo | null {
      const msgId = msg.id as string | undefined;
      const from = msg.from as string | undefined;
      const phone = normalizeMetaPhone(from);
      if (!phone) return null;

      // Get profile name from contacts array
      const contacts = value.contacts as Array<Record<string, unknown>> | undefined;
      const profileName = contacts?.[0]?.profile
        ? (contacts[0].profile as Record<string, unknown>).name as string | undefined
        : undefined;

      const wamid = msgId ?? '';

      // Handle location messages
      if (msg.type === 'location') {
        const location = msg.location as Record<string, unknown> | undefined;
        const lat = Number(location?.latitude);
        const lng = Number(location?.longitude);
        return {
          messageId: wamid,
          phone,
          profileName,
          messageBody: `[Location: ${lat},${lng}]`,
          isLocation: true,
          locationLat: lat,
          locationLng: lng,
        };
      }

      // Handle text messages
      if (msg.type === 'text') {
        const text = msg.text as Record<string, unknown> | undefined;
        return {
          messageId: wamid,
          phone,
          profileName,
          messageBody: (text?.body as string | undefined)?.trim() ?? '',
          isLocation: false,
        };
      }

      // Handle image messages — carried through for the group-ride selfie
      // step; everywhere else the empty body keeps the old drop behavior.
      if (msg.type === 'image') {
        const image = msg.image as Record<string, unknown> | undefined;
        const mediaId = typeof image?.id === 'string' ? image.id : undefined;
        return {
          messageId: wamid,
          phone,
          profileName,
          messageBody: '',
          isLocation: false,
          isImage: true,
          imageMediaId: mediaId,
          imageMimeType: typeof image?.mime_type === 'string' ? image.mime_type : undefined,
        };
      }

      // Handle interactive messages (button replies, list replies)
      if (msg.type === 'interactive') {
        const interactive = msg.interactive as Record<string, unknown> | undefined;
        if (interactive?.type === 'button_reply') {
          const buttonReply = interactive.button_reply as Record<string, unknown>;
          return {
            messageId: wamid,
            phone,
            profileName,
            messageBody: (buttonReply?.title as string) ?? '',
            isLocation: false,
            replyId: typeof buttonReply?.id === 'string' ? buttonReply.id : undefined,
          };
        }
        // A Flow that was closed with its last button. Whatever the form did, it
        // already told the chat (the Edit-trip form sends the updated card when
        // it saves) — answering this too would be a second message about nothing.
        if (interactive?.type === 'nfm_reply') return null;
        if (interactive?.type === 'list_reply') {
          const listReply = interactive.list_reply as Record<string, unknown>;
          return {
            messageId: wamid,
            phone,
            profileName,
            // A place-picker row answers with its position ("2"), exactly as if
            // the rider had typed the number. Its title is cut to 24 characters
            // by WhatsApp, so it must never be read back as an address.
            messageBody: placeChoiceReply(listReply?.id) ?? (listReply?.title as string) ?? '',
            isLocation: false,
            replyId: typeof listReply?.id === 'string' ? listReply.id : undefined,
          };
        }
      }

      // Ignore reactions, read receipts, and other non-content message types
      const msgType = msg.type as string | undefined;
      if (msgType === 'reaction' || msgType === 'system' || msgType === 'unsupported' || msgType === 'order' || msgType === 'ephemeral') {
        return null;
      }

      // Default: treat as empty (stickers, images, audio, video, etc.)
      return { messageId: wamid, phone, profileName, messageBody: '', isLocation: false };
}

/* ─── Parse bid commands from user text ─── */

/**
 * "accept 2" picks a specific driver; a bare "accept" means "take the bid" —
 * which is what riders actually type when there is only one to take. Requiring
 * a digit meant that message matched nothing and fell through to the
 * unrecognised-command reply, so the rider was told to pay for a ride they had
 * not managed to accept yet.
 */
type AcceptCommand =
  | { kind: 'numbered'; driverNumber: number }
  | { kind: 'unspecified' };

function parseAcceptCommand(message: string): AcceptCommand | null {
  const numbered = message.match(/(?:^|\bi\s+)accept\s+(?:driver\s+)?(\d+)\s*$/i);
  if (numbered) {
    return { kind: 'numbered', driverNumber: parseInt(numbered[1], 10) };
  }

  // Just the number — "1" — which is what people actually reply to a numbered
  // list. Capped at two digits so it can never swallow a counter-offer amount:
  // those are 3-6 digits (see parseCounterOffer), and no fare is under ₦100.
  const bareNumber = message.trim().match(/^(\d{1,2})\s*[.!]?$/);
  if (bareNumber) {
    return { kind: 'numbered', driverNumber: parseInt(bareNumber[1], 10) };
  }

  // Bare accept, with or without a trailing object: "accept", "i accept",
  // "accept it", "accept the offer".
  const bare = message
    .trim()
    .match(/^(?:i\s+)?accept(?:\s+(?:it|this|that|the\s+(?:bid|offer|driver|price)))?\s*[.!]?$/i);
  if (bare) {
    return { kind: 'unspecified' };
  }

  return null;
}

/**
 * "2,600" is two thousand six hundred, not a typo. Fold thousands separators
 * (comma or a single space), a leading ₦/N, and a trailing ".00" away before
 * the number patterns run, so the amount a rider typed is the amount we use.
 */
export function normalizeAmountText(message: string): string {
  return message
    .toLowerCase()
    .trim()
    .replace(/(\d)[,\s](?=\d{3}\b)/g, '$1')
    .replace(/(\d)\.0{1,2}\b/g, '$1')
    .replace(/(^|\s)(?:₦|ngn|naira|n)\s*(?=\d)/g, '$1n')
    .replace(/(\d)\s*(?:naira|ngn)\b/g, '$1');
}

export function parseCounterOffer(message: string): number | null {
  const lower = normalizeAmountText(message);
  // Match plain numbers like "1500", "2000"
  const numMatch = lower.match(/^(\d{3,6})$/);
  if (numMatch) return parseInt(numMatch[1], 10);
  // Match "₦1500", "N1500"
  const currMatch = lower.match(/^[₦n]\s*(\d{3,6})$/);
  if (currMatch) return parseInt(currMatch[1], 10);
  // Match "1.5k", "2k"
  const kMatch = lower.match(/^(\d+(?:\.\d+)?)\s*k$/);
  if (kMatch) return Math.round(parseFloat(kMatch[1]) * 1000);
  // Match natural language with a number: "I rebid 1300", "counter offer to 1400", "my offer is ₦1200"
  const nlNum = lower.match(/(?:bid|offer|counter|price|pay)\b.*?[₦n]?\s*(\d{3,6})\b/);
  if (nlNum) return parseInt(nlNum[1], 10);
  // Match natural language with "k" shorthand: "I'll do 1.5k", "offer 2k"
  const nlK = lower.match(/(?:bid|offer|counter|price|pay)\b.*?(\d+(?:\.\d+)?)\s*k\b/);
  if (nlK) return Math.round(parseFloat(nlK[1]) * 1000);
  // Last resort: message with a number + negotiation keyword (e.g. "how about 1300", "I'll do 1.5k")
  const hasNegotiationWord = /\b(bid|offer|counter|price|pay|how\s*about|what\s*about|do|make\s*it|set|change)\b/.test(lower);
  if (hasNegotiationWord) {
    const anyK = lower.match(/\b(\d+(?:\.\d+)?)\s*k\b/);
    if (anyK) return Math.round(parseFloat(anyK[1]) * 1000);
    const anyNum = lower.match(/\b(\d{3,6})\b/);
    if (anyNum) return parseInt(anyNum[1], 10);
  }
  return null;
}

function isMoreCommand(message: string): boolean {
  return /^(more|more\s+drivers|refresh|next)$/i.test(message.trim());
}

/**
 * True when a reply is conversation rather than an attempt at an address.
 *
 * The booking stages assume the next message answers the question they asked,
 * and hand it straight to the geocoder. But a stage survives in Redis for ten
 * minutes, so a rider who wandered off mid-booking and came back with "Hey
 * wassup" had their greeting geocoded — Google answered with "Nigeria", the
 * whole country. Anything matching here is left for the intent parser and the
 * chatbot instead.
 */
function looksLikeConversation(message: string): boolean {
  const trimmed = message.trim();

  // Greetings and small talk.
  if (/^(hi|hey|hello|yo|wassup|sup|how far|good\s+(morning|afternoon|evening)|thanks?|thank you|abeg|please|ok(ay)?|hmm+)\b/i.test(trimmed)) {
    return true;
  }

  // A question, or a restated trip — both belong to the intent parser.
  if (/\?\s*$/.test(trimmed)) return true;

  return /\b(i\s+(wanna|want|need|dey)|take me|carry me|book (a|me)|from\s+.+\s+to\s+|going to|go to|what'?s|who are|how much)\b/i.test(
    trimmed,
  );
}

/**
 * Riders answer "where are you headed?" with "To University gate" — and the
 * filler words get geocoded along with the place, which is enough to throw
 * Google onto an unrelated fuzzy match. Strip them before geocoding.
 */
function stripDirectionPrefix(message: string): string {
  const stripped = message
    .trim()
    .replace(/^(?:i(?:'m| am)?\s+(?:dey\s+)?(?:going|go|headed|heading)\s+to|take me to|carry me to|drop me (?:at|off at)|go(?:ing)? to|to|from)\s+/i, '')
    .trim();
  return stripped.length >= 3 ? stripped : message.trim();
}

async function planRouteSafe(
  deps: MetaWhatsappRouteDeps,
  pickup: { lat: number; lng: number; address: string },
  destination: { lat: number; lng: number; address: string },
  stops: RouteStop[] = [],
): Promise<Awaited<ReturnType<GoogleMapsRoutePlanner['planRoute']>> | null> {
  try {
    return await deps.routePlanner.planRoute({ origin: pickup, destination, ...(stops.length ? { stops } : {}) });
  } catch (error) {
    console.warn('[whatsapp] route planning failed', {
      pickup: pickup.address,
      destination: destination.address,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

const ROUTE_PLAN_FAILED_REPLY =
  'Could not find a driving route between those two points.\n\nPlease double-check the addresses, or share a location pin';

/**
 * Every normal booking is a potential group ride. Appended to the fare quote
 * when open group requests share this corridor; empty string otherwise, so
 * the suggestion never blocks or delays the normal flow's message.
 */
async function buildGroupSuggestionLine(
  userId: string,
  pickup: { lat: number; lng: number },
  destination: { lat: number; lng: number },
): Promise<string> {
  const suggestion = await findGroupRideSuggestion(userId, pickup, destination);
  if (!suggestion) return '';
  return `\n\n${suggestion.count} rider${suggestion.count === 1 ? ' is' : 's are'} already heading your way. Reply *group* to share the car — you set your own seat price, always cheaper than riding alone!`;
}

function isCancelCommand(message: string): boolean {
  const m = message.trim().toLowerCase();
  if (/^(?:cancel|never\s*mind|nevermind)[\s!.]*$/i.test(m)) return true;
  // "cancel my ride", "please abort the booking", "stop the search", "stop looking"
  if (/\b(cancel|abort)\b.*\b(ride|trip|booking|withdrawal|withdraw|search|request)\b/i.test(m)) return true;
  if (/\b(stop|end)\s+(?:the\s+|my\s+|this\s+)?(ride|trip|booking|search(?:ing)?|looking|request)\b/i.test(m)) return true;
  // "ride cancel", "booking cancelled" — but never "ride to Oshodi bus stop".
  return /\b(ride|trip|booking|withdrawal|withdraw)\b\s*(?:is\s+|should\s+be\s+)?(cancel(?:led)?|abort(?:ed)?)\b/i.test(m);
}

/**
 * Price talk is never an address edit. "change my offer to 2500" contains
 * "change … to" and used to be geocoded as a destination.
 */
function mentionsPrice(message: string): boolean {
  return /\b(price|offer|bid|fare|pay|amount|naira)\b|₦|\b\d+(?:\.\d+)?\s*k\b/i.test(message);
}

function isEditPickupCommand(message: string): boolean {
  const m = message.trim().toLowerCase();
  if (/^edit\s*(pickup|from)$/i.test(m)) return true;
  if (mentionsPrice(m) && !/\b(pickup|pick\s*-?\s*up|origin)\b/i.test(m)) return false;
  // The verb must be followed by the thing being edited: "change my pickup",
  // "edit pickup to Shoprite", "update from". Not "change … from 2000".
  return /\b(edit|change|update|modify)\s+(?:my\s+|the\s+)?(pickup|pick\s*-?\s*up|origin|start(?:ing)?\s+point|from)\b/i.test(m)
    || /\b(pickup|pick\s*-?\s*up)\s+(?:needs?\s+)?(?:to\s+be\s+)?(edit(?:ed)?|chang(?:e|ed)|updat(?:e|ed)|modif(?:y|ied))\b/i.test(m);
}

function isEditDestinationCommand(message: string): boolean {
  const m = message.trim().toLowerCase();
  if (/^edit\s*(destination|to)$/i.test(m)) return true;
  if (mentionsPrice(m) && !/\b(destination|dest|drop\s*-?\s*off|dropoff)\b/i.test(m)) return false;
  return /\b(edit|change|update|modify)\s+(?:my\s+|the\s+)?(destination|dest|drop\s*-?\s*off|dropoff|where\s+(?:i'?m|i\s+am)\s+going|to)\b/i.test(m)
    || /\b(destination|dest|drop\s*-?\s*off|dropoff)\s+(?:needs?\s+)?(?:to\s+be\s+)?(edit(?:ed)?|chang(?:e|ed)|updat(?:e|ed)|modif(?:y|ied))\b/i.test(m);
}

/** Extract inline address from edit command, e.g. "edit pickup golden gate bridge" → "golden gate bridge" */
function extractEditAddress(message: string): string | null {
  const m = message.trim();
  // Strip the command keywords, whatever remains is the address
  const stripped = m.replace(/\b(edit|change|update|modify)\b/i, '')
    .replace(/\b(pickup|pick\s*up|pick\s*-\s*up|origin|start|from|destination|dest|drop\s*off|dropoff|drop\s*-\s*off|where|to)\b/i, '')
    .replace(/\b(to|the)\b/gi, '')
    .trim();
  return stripped.length >= 3 ? stripped : null;
}

const CANCELLATION_REASON_PROMPT = [
  'Why do you want to cancel your ride?',
  '',
  '1. Long waiting time',
  '2. Wrong pickup or destination point',
  '3. Want to change ride type',
  '4. Accidental request',
  '',
  'Reply with *1–4* or type your reason.',
].join('\n');

const CANCELLATION_REASONS: Record<string, string> = {
  '1': 'Long waiting time',
  '2': 'Wrong pickup or destination point',
  '3': 'Want to change ride type',
  '4': 'Accidental request',
};

function parseCancellationReason(message: string): string | null {
  const normalized = message.trim().replace(/\s+/g, ' ');
  if (!normalized || isCancelCommand(normalized)) return null;

  const option = CANCELLATION_REASONS[normalized];
  if (option) return option;

  // Do not treat an unsupported numeric option as a free-text reason.
  if (/^\d+$/.test(normalized)) return null;

  return normalized.slice(0, 240);
}

function isWithdrawalStatusCommand(message: string): boolean {
  return /^(withdrawal?\s+status|withdrawals)$/i.test(message.trim());
}

function isWithdrawalStage(stage: string | null): boolean {
  return stage === 'awaiting_withdrawal_amount'
    || stage === 'awaiting_withdrawal_bank'
    || stage === 'awaiting_withdrawal_account'
    || stage === 'awaiting_withdrawal_confirmation';
}

async function sendWhatsappText(
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
async function sendMetaLinkButton(
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

/** The rider's own link to the bidding page: name a price, watch offers, accept one. */
function ridePageUrl(deps: MetaWhatsappRouteDeps, userId: string): string | null {
  if (!deps.appBaseUrl) return null;
  const token = createWalletPageToken(userId, 'ride', deps.jwtSecret, RIDE_PAGE_TOKEN_TTL_SECONDS);
  return `${deps.appBaseUrl.replace(/\/+$/, '')}/widget/ride/ride.html#t=${encodeURIComponent(token)}`;
}

/**
 * A fare quote, with a button to name the price on the bidding page. Typing
 * the price in the chat still works — it is the fallback for a phone that will
 * not open the page — so the text says so.
 */
async function sendQuoteWithPriceButton(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  quote: string,
): Promise<string> {
  // Every quote in this file comes through here — so this is the one place
  // that says: a trip is CONFIRMED before a price is asked for. A changed trip
  // is stored without `confirmed`, and is shown for confirmation again.
  const trip = await getPendingRoute(deps.redisClient, user.id).catch(() => null);
  if (trip && !trip.confirmed) {
    const firstLine = quote.split('\n')[0] ?? '';
    return sendTripConfirmation(deps, user, phone, trip, /^\*[^*]+\*$/.test(firstLine) ? firstLine : undefined);
  }

  // With the trip form on, bidding is in the form — never the web page. This is
  // the fallback for a phone that could not open it: the price is typed here.
  const url = EDIT_TRIP_FLOW_ENABLED && deps.whatsappEditTripFlowId ? null : ridePageUrl(deps, user.id);
  if (!url) {
    await sendMetaReply(deps, phone, quote);
    return quote;
  }
  await sendMetaLinkButton(deps, phone,
    quote.replace('Send your offer (e.g.', 'Tap *Set your price* — or just type your offer (e.g.'),
    'Set your price', url);
  return quote;
}

/**
 * The one chat message a search needs. With the offers form: "your bid is in" with
 * the button that opens it — and no offers message ever follows, the form shows
 * them live. Without the form: "Finding you a driver", and offers follow in the chat.
 */
async function sendSearchStarted(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  trip: { pickupAddress: string; destAddress: string; offerNgn: number; stopAddresses?: string[] },
): Promise<string> {
  if (deps.metaAccessToken && deps.metaPhoneNumberId) {
    const notifier = { metaAccessToken: deps.metaAccessToken, metaPhoneNumberId: deps.metaPhoneNumberId, offersFormFlowId: deps.whatsappOffersFormFlowId, flowTokenSecret: deps.jwtSecret };
    if (await sendBidPlacedMessage(notifier, phone, user.id, trip)) {
      const rideId = await getActiveRide(deps.redisClient, user.id).catch(() => null);
      if (rideId) await markOffersMessageSent(deps.redisClient, rideId).catch(() => undefined);
      return `[your bid of ₦${trip.offerNgn.toLocaleString()} is in — sent the See driver offers button]`;
    }
  }
  const url = ridePageUrl(deps, user.id);
  const lines = [
    `*Finding you a driver!*`,
    ``,
    `Pickup: *${trip.pickupAddress}*`,
    ...(trip.stopAddresses ?? []).map((stop, index) => `Stop ${index + 1}: *${stop}*`),
    `Destination: *${trip.destAddress}*`,
    `Your offer: ₦${trip.offerNgn.toLocaleString()}`,
    ``,
    `Drivers' offers will land right here in this chat — tap the one you want.`,
  ];
  const text = lines.join('\n');
  // The button is only for changing the price; offers are never on that page.
  if (url) await sendMetaLinkButton(deps, phone, text, 'Change my price', url);
  else await sendMetaReply(deps, phone, text);
  return text;
}

interface ConfirmedRideForChat {
  driverId: string; driverName: string; driverPhone: string; driverRating: number; totalRides: number;
  vehicleModel: string; vehiclePlate: string; etaSeconds: number; fareNgn: number;
  pickupAddress?: string; destAddress?: string; stopAddresses?: string[];
}

const SOS_REPLY_ID = 'ride_sos';
const SOS_CANCEL_REPLY_ID = 'ride_sos_cancel';
const TRACK_REPLY_ID = 'ride_track';

/** A signed URL for one of a driver's KYC photos. Null when there is none, storage is off, or it fails. */
async function driverPhotoUrl(deps: MetaWhatsappRouteDeps, driverId: string, which: 'selfie' | 'car'): Promise<string | null> {
  if (!deps.driverKycStorage) return null;
  try {
    const kyc = await driverClient.findKycSubmission(driverId);
    const key = which === 'selfie' ? kyc?.selfieKey : kyc?.vehicleImageKeys?.[0];
    return key ? await deps.driverKycStorage.getSignedUrl(key) : null;
  } catch {
    return null;
  }
}

/* ── quick actions: the menu, history, repeat / reverse ─────────────────── */

/** The text fallback of the menu is numbered rows; a typed number maps back to the row's id by its title. */
const MENU_TITLE_TO_ID: Record<string, string> = {
  'Book a ride': QUICK_ACTION_IDS.book, 'Repeat last ride': QUICK_ACTION_IDS.repeat, 'Reverse last ride': QUICK_ACTION_IDS.reverse,
  'Ride history': QUICK_ACTION_IDS.history, 'Your current trip': QUICK_ACTION_IDS.currentTrip,
  'Add money': QUICK_ACTION_IDS.addMoney, 'Withdraw': QUICK_ACTION_IDS.withdraw, 'Contact support': QUICK_ACTION_IDS.support,
};

const supportContact = () => process.env['SUPPORT_CONTACT']?.trim() || null;

/**
 * The menu. One message with ONE button. With the Quick Actions form published,
 * the button opens it and every action is a screen inside (quick-actions-flow.ts);
 * otherwise it is WhatsApp's list picker, and numbered text if that is refused.
 */
async function sendQuickActions(deps: MetaWhatsappRouteDeps, user: { id: string }, phone: string, activeRideId: string | null, log: string, greeting = false): Promise<void> {
  const who = await userClient.findById(user.id).catch(() => null);
  const firstName = who?.name?.trim().split(/\s+/)[0] || null;
  if (QUICK_ACTIONS_FLOW_ENABLED && deps.whatsappQuickActionsFlowId) {
    const sent = await sendInteractive(deps, phone, {
      type: 'flow',
      body: { text: quickActionsBody(greeting, firstName) },
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_id: deps.whatsappQuickActionsFlowId,
          flow_token: signFlowToken(`menu:${user.id}`, deps.jwtSecret),
          flow_cta: 'Quick Actions',
          // data_exchange: opening calls our endpoint, so the menu is built for right now.
          flow_action: 'data_exchange',
        },
      },
    });
    if (sent) {
      await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: log }, { role: 'assistant', content: '[sent the quick actions form]' }]);
      return;
    }
  }
  const trips = await recentTrips(user.id, 1);
  const menu = buildQuickActions({
    greeting,
    firstName,
    lastTrip: trips[0] ?? null,
    busy: Boolean(activeRideId),
    supportContact: supportContact(),
  });
  await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: log }, { role: 'assistant', content: '[sent the quick actions menu]' }]);
  if (await sendInteractive(deps, phone, menu)) return;
  const rows = (menu['action'] as { sections: Array<{ rows: Array<{ title: string }> }> }).sections.flatMap((section) => section.rows);
  await sendMetaReply(deps, phone, `${greeting ? 'Hey!' : ''}What would you like to do?\n\n${rows.map((row, index) => `*${index + 1}.* ${row.title}`).join('\n')}\n\nReply with the number.`);
  await storePendingGeoChoices(deps.redisClient, user.id, { context: 'menu', options: rows.map((row) => ({ lat: 0, lng: 0, address: row.title })) }).catch(() => undefined);
}

/**
 * Book the same trip again — or the same trip backwards. The past ride's
 * coordinates are re-planned so distance and fare are today's, then it lands
 * on the ordinary trip card: Confirm or edit, then the price. Nothing new
 * after that.
 */
async function bookFromPastTrip(deps: MetaWhatsappRouteDeps, user: { id: string }, phone: string, log: string, trip: PastTrip, backwards: boolean): Promise<void> {
  const { pickup, destination, stops } = backwards ? reversed(trip) : trip;
  const planned = await planRouteSafe(deps, pickup, destination, stops);
  if (!planned) {
    await replyAndLog(deps, phone, log, `I could not plan that trip today — a road may have changed.\n\nType it instead, e.g. *from ${shortAddress(pickup.address)} to ${shortAddress(destination.address)}*`);
    return;
  }
  await Promise.all([clearPendingGeoChoices(deps.redisClient, user.id), clearPendingFarPlace(deps.redisClient, user.id), clearBookingMisses(deps.redisClient, user.id)].map((step) => step.catch(() => undefined)));
  const route: PendingRouteData = {
    pickupLat: pickup.lat, pickupLng: pickup.lng, pickupAddress: pickup.address,
    destLat: destination.lat, destLng: destination.lng, destAddress: destination.address,
    stops,
    distanceKm: planned.distanceKm,
    durationSeconds: planned.durationSeconds,
    suggestedFareNgn: planned.suggestedFareNgn,
    minOfferNgn: planned.minOfferNgn,
    ratePerKmNgn: planned.ratePerKmNgn,
    route: planned.geometry,
  };
  await storePendingRoute(deps.redisClient, user.id, route);
  const said = await sendTripConfirmation(deps, user, phone, route, backwards ? '*Same trip, back the other way*' : '*Same trip as before*');
  await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: log }, { role: 'assistant', content: said }]);
}
const shortAddress = (address: string) => address.split(',')[0]?.trim() || address;

/** A tap on the menu, the history list, or a Repeat/Reverse button. */
async function handleQuickAction(deps: MetaWhatsappRouteDeps, user: { id: string }, phone: string, replyId: string, incoming: string, activeRideId: string | null): Promise<void> {
  const log = incoming || `[tapped ${replyId}]`;
  const tripFrom = async (id: string) => (await recentTrips(user.id, 10)).find((trip) => trip.rideId === id) ?? null;

  if (replyId === QUICK_ACTION_IDS.addMoney) return sendWalletPageButton(deps, user, phone, log, 'deposit');
  if (replyId === QUICK_ACTION_IDS.withdraw) return sendWalletPageButton(deps, user, phone, log, 'withdraw');
  if (replyId === QUICK_ACTION_IDS.support) {
    const contact = supportContact();
    return replyAndLog(deps, phone, log, contact ? `*Wheelers support*\n\n${contact}\n\nA person will reply as soon as they can.` : 'Support is not set up yet — reply here and we will see it.');
  }
  if (replyId === QUICK_ACTION_IDS.currentTrip) {
    if (!activeRideId) return sendQuickActions(deps, user, phone, null, log);
    const state = await getRideState(deps.redisClient, activeRideId).catch(() => null);
    if (state === 'confirmed' || state === 'in_progress') {
      const accepted = await getAcceptedBid(deps.redisClient, activeRideId).catch(() => null);
      return replyAndLog(deps, phone, log, `*${accepted?.driverName ?? 'Your driver'}* is ${state === 'in_progress' ? 'driving you now' : 'on the way'}.\n\nYour ride card is just above — tap *Track live trip* on it, or reply *cancel*.`);
    }
    const said = await sendCurrentOffers(deps, phone, activeRideId);
    await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: log }, { role: 'assistant', content: said }]);
    return;
  }

  // Everything below starts a booking: not while one is live.
  if (activeRideId) {
    return replyAndLog(deps, phone, log, 'You already have a ride going. Reply *cancel* to end it first, then book again.');
  }
  if (replyId === QUICK_ACTION_IDS.book) return replyAndLog(deps, phone, log, BOOKING_START_PROMPT);
  if (replyId === QUICK_ACTION_IDS.history) {
    const trips = await recentTrips(user.id, 5);
    const list = buildHistoryList(trips);
    if (!list) return replyAndLog(deps, phone, log, `No rides yet — your first one goes here.\n\n${BOOKING_START_PROMPT}`);
    await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: log }, { role: 'assistant', content: `[sent ${trips.length} past rides to pick from]` }]);
    if (!await sendInteractive(deps, phone, list)) {
      await sendMetaReply(deps, phone, `Your recent rides:\n\n${trips.map((trip, index) => `*${index + 1}.* ${shortAddress(trip.pickup.address)} → ${shortAddress(trip.destination.address)}`).join('\n')}\n\nReply with the number to book it again.`);
      await storePendingGeoChoices(deps.redisClient, user.id, { context: 'history', options: trips.map((trip) => ({ lat: 0, lng: 0, address: trip.rideId })) }).catch(() => undefined);
    }
    return;
  }
  if (replyId === QUICK_ACTION_IDS.repeat || replyId === QUICK_ACTION_IDS.reverse) {
    const [last] = await recentTrips(user.id, 1);
    if (!last) return replyAndLog(deps, phone, log, `No completed ride to repeat yet.\n\n${BOOKING_START_PROMPT}`);
    return bookFromPastTrip(deps, user, phone, log, last, replyId === QUICK_ACTION_IDS.reverse);
  }
  const picked = HISTORY_ROW.exec(replyId);
  if (picked) {
    const trip = await tripFrom(picked[1]!);
    if (!trip) return replyAndLog(deps, phone, log, 'That ride is not in your recent history any more. Reply *menu* to see the list again.');
    await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: log }, { role: 'assistant', content: `[offered Repeat / Reverse for ${trip.rideId}]` }]);
    if (!await sendInteractive(deps, phone, buildRepeatButtons(trip, '*This ride*'))) await bookFromPastTrip(deps, user, phone, log, trip, false);
    return;
  }
  const again = REPEAT_ROW.exec(replyId) ?? REVERSE_ROW.exec(replyId);
  if (again) {
    const trip = await tripFrom(again[1]!);
    if (!trip) return replyAndLog(deps, phone, log, 'That ride is not in your recent history any more. Reply *menu* to see the list again.');
    return bookFromPastTrip(deps, user, phone, log, trip, REVERSE_ROW.test(replyId));
  }
}

/** Everything about the ride, as one tidy list — the text under the driver's photo. */
function rideDetailsText(ride: ConfirmedRideForChat): string {
  return [
    `*Ride confirmed & paid*`,
    ``,
    `*YOUR DRIVER*`,
    `Name: ${ride.driverName}`,
    `Rating: ${ride.driverRating.toFixed(1)} · ${ride.totalRides.toLocaleString()} rides`,
    ...(ride.driverPhone ? [`Phone: ${ride.driverPhone}`] : []),
    ``,
    `*THE CAR*`,
    `Car: ${ride.vehicleModel}`,
    `Plate: *${ride.vehiclePlate}* — check it before you get in`,
    ``,
    `*YOUR TRIP*`,
    ...(ride.pickupAddress ? [`From: ${ride.pickupAddress}`] : []),
    ...(ride.stopAddresses ?? []).map((stop, index) => `Stop ${index + 1}: ${stop}`),
    ...(ride.destAddress ? [`To: ${ride.destAddress}`] : []),
    `₦${ride.fareNgn.toLocaleString()} — held in your wallet, paid when the trip ends`,
    `Arrives in about ${Math.max(1, Math.ceil(ride.etaSeconds / 60))} min`,
    ``,
    `*Track live trip* — watch your driver on the map.`,
    `*SOS* — feel unsafe at any point? One tap and Wheelers' safety team has your trip and location.`,
  ].join('\n').slice(0, 1024);   // WhatsApp's limit for a button message's body
}

/**
 * "Your ride is confirmed" — TWO messages, the same from the chat, the offers
 * form and the page:
 *
 * ONE message: the DRIVER'S photo on top, every detail under it, and two
 * buttons — Track live trip, SOS.
 *
 * A face is what the rider needs now; the car matters later, at the kerb, so
 * its photo rides on "has arrived" instead (sendDriverArrivedNotification).
 * This used to be two messages and the card wore the car.
 *
 * WhatsApp gives a message ONE link button or up to three reply buttons, never
 * both. Two buttons means reply buttons, and a reply button cannot open a link —
 * so SOS acts on the tap, and Track live trip answers with the map's link button
 * (handleRideCardTap). That one extra message is the price of the second button.
 *
 * No photo on file, or WhatsApp refuses the picture → the same card without it;
 * refuses that too → plain text. The details always arrive.
 */
async function sendRideConfirmation(
  deps: MetaWhatsappRouteDeps,
  userId: string,
  phone: string,
  ride: ConfirmedRideForChat,
): Promise<string> {
  const selfieUrl = await driverPhotoUrl(deps, ride.driverId, 'selfie');
  const details = rideDetailsText(ride);

  const card = (photo: string | null) => ({
    type: 'button',
    ...(photo ? { header: { type: 'image', image: { link: photo } } } : {}),
    body: { text: details },
    action: {
      buttons: [
        ...(deps.appBaseUrl ? [{ type: 'reply', reply: { id: TRACK_REPLY_ID, title: 'Track live trip' } }] : []),
        { type: 'reply', reply: { id: SOS_REPLY_ID, title: 'SOS' } },
      ],
    },
  });
  // A photo Meta refuses (an expired link, a format it dislikes) must not cost
  // the rider their driver's details: the same card goes again without it.
  const sent = (selfieUrl !== null && await sendInteractive(deps, phone, card(selfieUrl))) || await sendInteractive(deps, phone, card(null));
  if (!sent) await sendMetaReply(deps, phone, details);
  return details;
}

const RIDE_CARD_REPLIES: ReadonlySet<string> = new Set([TRACK_REPLY_ID, SOS_REPLY_ID, SOS_CANCEL_REPLY_ID]);

/**
 * The ride card's buttons, and "I'm safe". Answered whatever else the chat is
 * doing. SOS gets one short message: a person who has just asked for help must
 * see that it was heard — and one who slipped needs the way to take it back.
 */
async function handleRideCardTap(deps: MetaWhatsappRouteDeps, userId: string, phone: string, replyId: string): Promise<void> {
  if (replyId === TRACK_REPLY_ID) {
    const url = ridePageUrl(deps, userId);
    if (url) await sendMetaLinkButton(deps, phone, 'Your driver, live on the map.', 'Open live map', url);
    return;
  }
  if (replyId === SOS_CANCEL_REPLY_ID) {
    const withdrawn = await cancelRiderSos(userId);
    await sendMetaReply(deps, phone, withdrawn ? 'Glad you are safe — the alert has been withdrawn.' : 'You have no open alert. Tap *SOS* on your ride card if you ever need us.');
    return;
  }
  const { alreadyOpen } = await raiseRiderSos(userId);
  logActivity({ userId, eventType: 'safety_alert_raised', source: 'whatsapp', metadata: { alreadyOpen } });
  const text = `*${alreadyOpen ? 'We already have your alert' : 'SOS received'}.* Wheelers' safety team has your trip, your driver and your location.\n\nIn immediate danger? Call *112*.`;
  const sent = await sendInteractive(deps, phone, {
    type: 'button',
    body: { text },
    action: { buttons: [{ type: 'reply', reply: { id: SOS_CANCEL_REPLY_ID, title: "I'm safe" } }] },
  });
  if (!sent) await sendMetaReply(deps, phone, text);
}

/**
 * What happened on the bidding page, told to the chat. The page is where the
 * rider acts; the chat is the record — and where the driver's details need to
 * be when the page is closed and the car is outside.
 */
export function createRidePageChatNotifier(deps: MetaWhatsappRouteDeps) {
  return async (event: RidePageChatEvent): Promise<void> => {
    if (!event.phone) return;

    if (event.kind === 'search_started') {
      const text = await sendSearchStarted(deps, { id: event.userId }, event.phone, event);
      await appendWhatsappConversation(deps.redisClient, event.phone, [
        { role: 'user', content: `[named a price on the offers page: ₦${event.offerNgn.toLocaleString()}]` },
        { role: 'assistant', content: text },
      ]);
      return;
    }

    if (event.kind === 'search_cancelled') {
      const text = 'Search cancelled — nothing was charged. Message me whenever you need a ride.';
      await appendWhatsappConversation(deps.redisClient, event.phone, [
        { role: 'user', content: '[cancelled the search on the offers page]' },
        { role: 'assistant', content: text },
      ]);
      await sendMetaReply(deps, event.phone, text);
      return;
    }

    const ride = event.ride;
    const text = await sendRideConfirmation(deps, event.userId, event.phone, ride);
    await appendWhatsappConversation(deps.redisClient, event.phone, [
      { role: 'user', content: `[accepted ${ride.driverName}'s offer on the offers page]` },
      { role: 'assistant', content: text },
    ]);
  };
}

/* ── offers in the chat: tap one and it is yours ────────────────────────── */

/**
 * The offers on the table right now, as a fresh message to tap. `news` is the
 * reason a fresh one is needed ("Tunde changed their price…") and leads it.
 * Returns what was said, for the conversation log.
 */
async function sendCurrentOffers(
  deps: MetaWhatsappRouteDeps,
  phone: string,
  rideId: string,
  news?: string,
): Promise<string> {
  const bids = sortOffers(await getBids(deps.redisClient, rideId));
  if (bids.length === 0) {
    const text = `${news ? `${news}\n\n` : ''}Still asking drivers near you — I'll message you the moment one responds.\n\nType a new price (e.g. *3000*) to change your offer, or *cancel* to stop.`;
    await sendMetaReply(deps, phone, text);
    return text;
  }

  const meta = await getRideMeta(deps.redisClient, rideId);
  const offerNgn = meta?.offerNgn ?? 0;
  // What "1" means if they type a number must be what this message shows.
  await storeLastBatch(deps.redisClient, rideId, bids);

  // A group seat is booked by number: the car only moves when every rider picks the same driver.
  const groupSeat = await getGroupSeat(deps.redisClient, rideId).catch(() => null);
  if (!groupSeat && deps.metaAccessToken && deps.metaPhoneNumberId) {
    const sent = await sendOffersInChat(
      { metaAccessToken: deps.metaAccessToken, metaPhoneNumberId: deps.metaPhoneNumberId, offersFormFlowId: deps.whatsappOffersFormFlowId, flowTokenSecret: deps.jwtSecret },
      phone, bids, offerNgn, news ? [news] : undefined, meta?.riderId,
    );
    if (sent === 'form') await markOffersMessageSent(deps.redisClient, rideId).catch(() => undefined);
    if (sent) return `${news ? `${news} ` : ''}[sent ${bids.length} offer${bids.length === 1 ? '' : 's'} to tap]`;
  }
  const text = `${news ? `${news}\n\n` : ''}${formatBidList(bids, offerNgn)}`;
  await sendMetaReply(deps, phone, text);
  return text;
}

/**
 * "Add money to ride with Tunde" — one button, to the deposit page, which opens
 * straight on the amount to send. Nothing else to do: the deposit landing is
 * what confirms the driver (see createWhatsappDepositFinisher).
 */
async function sendRideTopupButton(
  deps: MetaWhatsappRouteDeps,
  userId: string,
  phone: string,
  short: { driverName: string; fareNgn: number; balanceNgn: number; shortNgn: number; sendNgn: number },
  news?: string,
): Promise<string> {
  const driver = short.driverName.split(' ')[0] || short.driverName;
  const lines = [
    ...(news ? [news, ''] : []),
    `*Add money to ride with ${driver}*`,
    ``,
    `Fare: ₦${short.fareNgn.toLocaleString()} · your wallet: ₦${short.balanceNgn.toLocaleString()}`,
    `Send *₦${short.sendNgn.toLocaleString()}* and ₦${short.shortNgn.toLocaleString()} lands in your wallet.`,
    ``,
    `The moment it lands, ${driver} is confirmed — no need to come back and tap anything.`,
  ];

  if (deps.appBaseUrl) {
    const token = createWalletPageToken(userId, 'deposit', deps.jwtSecret, DEPOSIT_PAGE_TOKEN_TTL_SECONDS);
    const url = `${deps.appBaseUrl.replace(/\/+$/, '')}/widget/wallet/deposit.html#t=${encodeURIComponent(token)}`;
    const text = lines.join('\n');
    await sendMetaLinkButton(deps, phone, text, 'Add money', url);
    return text;
  }

  // No page to open: the account number goes in the chat, as it used to.
  const account = await virtualAccountClient.findByUserId(userId).catch(() => null);
  if (account) {
    lines.push(``, `Bank: *${account.bankName}*`, `Account: \`\`\`${account.accountNumber}\`\`\``, `Name: *${account.accountName}*`);
  }
  const text = lines.join('\n');
  await sendMetaReply(deps, phone, text);
  return text;
}

/** Remember who they chose, so a deposit (or a typed *pay*) can finish the job. */
async function rememberChosenOffer(deps: MetaWhatsappRouteDeps, userId: string, rideId: string, bid: WhatsappBid): Promise<void> {
  const driver = await driverClient.findById(bid.driverId).catch(() => null);
  await storePendingAccept(deps.redisClient, userId, {
    rideId,
    bidId: bid.bidId,
    driverId: bid.driverId,
    driverUserId: bid.driverUserId,
    driverName: bid.driverName,
    driverPhone: driver?.user?.phone ?? '',
    driverRating: bid.driverRating,
    totalRides: driver?.totalRides ?? 0,
    vehicleModel: bid.vehicleModel,
    vehiclePlate: bid.vehiclePlate,
    etaSeconds: bid.etaSeconds,
    fareNgn: bid.counterOfferNgn,
  });
}

/**
 * The rider took an offer in the chat — a tapped button, a tapped list row, a
 * typed number, or *pay*. One path for all four, and the same rules as the
 * page's Accept because it IS the same function underneath.
 *
 * `shownPriceNgn` is the price on the message they tapped. Chat messages cannot
 * be edited, so an old one can show a price the driver has since changed; a tap
 * on it shows them the new price instead of holding it.
 */
async function acceptOfferInChat(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  incomingMessage: string,
  rideId: string,
  key: string,
  shownPriceNgn: number | null,
): Promise<void> {
  const log = (reply: string) => appendWhatsappConversation(deps.redisClient, phone, [
    { role: 'user', content: incomingMessage },
    { role: 'assistant', content: reply },
  ]);

  const bid = (await getBids(deps.redisClient, rideId)).find((candidate) => offerKey(candidate) === key);
  if (!bid) {
    await clearPendingAccept(deps.redisClient, user.id);
    await log(await sendCurrentOffers(deps, phone, rideId, 'That offer is no longer on the table — nothing was charged.'));
    return;
  }
  if (shownPriceNgn !== null && bid.counterOfferNgn !== shownPriceNgn) {
    await clearPendingAccept(deps.redisClient, user.id);
    await log(await sendCurrentOffers(deps, phone, rideId,
      `${bid.driverName} changed their price to ₦${bid.counterOfferNgn.toLocaleString()} (it was ₦${shownPriceNgn.toLocaleString()}) — nothing was charged.`));
    return;
  }

  const result = await confirmRideWithOffer({ redisClient: deps.redisClient, publisher: deps.publisher }, user.id, rideId, key);
  if (result.ok) {
    logActivity({ userId: user.id, eventType: 'ride_offer_accepted', source: 'whatsapp', rideId, metadata: { fareNgn: result.ride.fareNgn, driverId: result.ride.driverId } });
    await log(await sendRideConfirmation(deps, user.id, phone, result.ride));
    return;
  }

  const driver = `*${bid.driverName}*`;
  switch (result.code) {
    case 'WALLET_SHORT':
      await rememberChosenOffer(deps, user.id, rideId, bid);
      await log(await sendRideTopupButton(deps, user.id, phone, { driverName: bid.driverName, ...result }));
      return;
    case 'DRIVER_UNAVAILABLE':
      await clearPendingAccept(deps.redisClient, user.id);
      await log(await sendCurrentOffers(deps, phone, rideId, `${bid.driverName} can't be reached right now — your money has not moved.`));
      return;
    case 'DRIVER_TAKEN':
      await clearPendingAccept(deps.redisClient, user.id);
      await log(await sendCurrentOffers(deps, phone, rideId, `Another rider is confirming ${bid.driverName} right now — your money has not moved.`));
      return;
    case 'ALREADY_CONFIRMING': {
      const reply = `One moment — ${driver} is being confirmed.`;
      await log(reply);
      await sendMetaReply(deps, phone, reply);
      return;
    }
    case 'HOLD_FAILED':
    case 'CONFIRM_FAILED': {
      await rememberChosenOffer(deps, user.id, rideId, bid);
      const reply = result.code === 'HOLD_FAILED'
        ? `Could not hold the fare in your wallet just now — nothing was charged. Reply *pay* to try ${driver} again.`
        : `Could not confirm the ride just now — your money is locked safely. Reply *pay* to try ${driver} again.`;
      await log(reply);
      await sendMetaReply(deps, phone, reply);
      return;
    }
    default: {
      await clearPendingAccept(deps.redisClient, user.id);
      await clearActiveRide(deps.redisClient, user.id);
      const reply = 'This search has ended — nothing was charged. Reply *search again* for a fresh one.';
      await log(reply);
      await sendMetaReply(deps, phone, reply);
    }
  }
}

/**
 * What the offers FORM needs the chat to say. Only the two things a rider must
 * keep: the confirmed driver's details, and the Add money button. Changing the
 * price, declining and cancelling are answered inside the form and cost the
 * chat nothing.
 */
/**
 * What the Quick Actions form needs from the chat: the offers hooks (its OFFERS
 * screen is the offers form), where support points, the Withdraw button, and a
 * way to open an account number for a rider who has none yet.
 */
export function createQuickActionsChatHooks(deps: MetaWhatsappRouteDeps) {
  return {
    ...createOffersFormChatHooks(deps),
    supportContact,
    /** A bid placed inside a form (Edit trip or Quick Actions): the chat gets its one message, the See driver offers button. */
    onBidPlaced: async (userId: string, rideId: string, offerNgn: number): Promise<void> => {
      const [who, meta] = await Promise.all([userClient.findById(userId).catch(() => null), getRideMeta(deps.redisClient, rideId)]);
      if (!who?.phone || !meta) return;
      const said = await sendSearchStarted(deps, { id: userId }, who.phone, {
        pickupAddress: meta.pickupAddress, destAddress: meta.destinationAddress, stopAddresses: (meta.stops ?? []).map((stop) => stop.address), offerNgn,
      });
      await appendWhatsappConversation(deps.redisClient, who.phone, [{ role: 'user', content: `[bid ₦${offerNgn.toLocaleString()} in the form]` }, { role: 'assistant', content: said }]);
    },
    /** Book a ride from Quick Actions: booking is the chat's job — one clear prompt, no menu under it. */
    onBookInChat: async (userId: string): Promise<void> => {
      const phone = (await userClient.findById(userId).catch(() => null))?.phone;
      if (!phone) return;
      const prompt = `Where are you going?\n\n${BOOKING_START_PROMPT}`;
      await sendMetaText(deps, phone, prompt);
      await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: '[chose Book a ride in Quick Actions]' }, { role: 'assistant', content: prompt }]);
    },
    onWithdraw: async (userId: string): Promise<void> => {
      const phone = (await userClient.findById(userId).catch(() => null))?.phone;
      if (!phone) return;
      await sendWalletPageButton(deps, { id: userId }, phone, '[chose Withdraw in Quick Actions]', 'withdraw');
    },
    ensureDepositAccount: async (userId: string) => {
      const who = await userClient.findById(userId).catch(() => null);
      await provisionDepositAccount(deps.paymentsClient, userId, who?.name ?? undefined, who?.phone ?? undefined).catch(() => undefined);
      const account = await virtualAccountClient.findByUserId(userId).catch(() => null);
      return account ? { bankName: account.bankName, accountNumber: account.accountNumber, accountName: account.accountName } : null;
    },
  };
}

export function createOffersFormChatHooks(deps: MetaWhatsappRouteDeps) {
  const phoneOf = async (userId: string) => (await userClient.findById(userId).catch(() => null))?.phone ?? null;
  return {
    onRideConfirmed: async (userId: string, ride: ConfirmedRideForChat): Promise<void> => {
      const phone = await phoneOf(userId);
      if (!phone) return;
      logActivity({ userId, eventType: 'ride_offer_accepted', source: 'whatsapp_form', metadata: { fareNgn: ride.fareNgn, driverId: ride.driverId } });
      const said = await sendRideConfirmation(deps, userId, phone, ride);
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: `[accepted ${ride.driverName}'s offer in the offers form]` },
        { role: 'assistant', content: said },
      ]);
    },
    onWalletShort: async (userId: string, rideId: string, bid: WhatsappBid, short: { balanceNgn: number; fareNgn: number; shortNgn: number; sendNgn: number }): Promise<void> => {
      const phone = await phoneOf(userId);
      if (!phone) return;
      await rememberChosenOffer(deps, userId, rideId, bid);        // the deposit landing finishes the job
      const said = await sendRideTopupButton(deps, userId, phone, { driverName: bid.driverName, ...short });
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: `[chose ${bid.driverName} in the offers form — wallet short]` },
        { role: 'assistant', content: said },
      ]);
    },
  };
}

/**
 * A WhatsApp rider's deposit has landed. If they were adding money to take a
 * driver they had tapped, take that driver now — the deposit IS the "pay".
 * Returns true when the chat has been told what happened, so the plain
 * "deposit received" message is not sent on top.
 *
 * Everything that can go wrong between the tap and the transfer is answered
 * here, because nobody is looking at a screen when it happens:
 *   the driver left / re-priced / was taken → money stays in the wallet, fresh offers
 *   the search ended                        → money stays in the wallet, "search again"
 *   they sent too little                    → what is still missing, same button
 */
export function createWhatsappDepositFinisher(deps: MetaWhatsappRouteDeps) {
  return async (deposit: { userId: string; amountNgn: number; newBalanceNgn: number }): Promise<boolean> => {
    const pending = await getPendingAccept(deps.redisClient, deposit.userId);
    if (!pending) return false;
    const phone = (await userClient.findById(deposit.userId).catch(() => null))?.phone;
    if (!phone) return false;

    const received = `₦${deposit.amountNgn.toLocaleString()} received — your wallet has ₦${deposit.newBalanceNgn.toLocaleString()}.`;
    const log = (reply: string) => appendWhatsappConversation(deps.redisClient, phone, [
      { role: 'user', content: `[deposit of ₦${deposit.amountNgn.toLocaleString()} landed]` },
      { role: 'assistant', content: reply },
    ]);

    const activeRideId = await getActiveRide(deps.redisClient, deposit.userId);
    if (activeRideId !== pending.rideId) {
      // The search they were paying for is over. The money is theirs, in the wallet.
      await clearPendingAccept(deps.redisClient, deposit.userId);
      if (activeRideId) return false;
      const reply = `${received}\n\nThe search ended while your transfer was on its way, so *${pending.driverName}* was not booked. Your money is safe in your wallet — reply *search again* to find a driver.`;
      await log(reply);
      await sendMetaReply(deps, phone, reply);
      return true;
    }
    const state = await getRideState(deps.redisClient, pending.rideId).catch(() => null);
    if (state === 'confirmed' || state === 'in_progress') {
      await clearPendingAccept(deps.redisClient, deposit.userId);
      return false;
    }

    const key = pending.bidId ?? `driver:${pending.driverId}`;
    const bid = (await getBids(deps.redisClient, pending.rideId)).find((candidate) => offerKey(candidate) === key);
    if (!bid || bid.counterOfferNgn !== pending.fareNgn) {
      await clearPendingAccept(deps.redisClient, deposit.userId);
      const why = bid
        ? `${pending.driverName} changed their price to ₦${bid.counterOfferNgn.toLocaleString()} while your transfer was on its way, so nothing was booked.`
        : `${pending.driverName} is no longer available, so nothing was booked.`;
      await log(await sendCurrentOffers(deps, phone, pending.rideId, `${received} ${why} Your money is safe in your wallet.`));
      return true;
    }

    const result = await confirmRideWithOffer({ redisClient: deps.redisClient, publisher: deps.publisher }, deposit.userId, pending.rideId, key);
    if (result.ok) {
      logActivity({ userId: deposit.userId, eventType: 'ride_offer_accepted', source: 'whatsapp_deposit', rideId: pending.rideId, metadata: { fareNgn: result.ride.fareNgn, driverId: result.ride.driverId } });
      await log(await sendRideConfirmation(deps, deposit.userId, phone, result.ride));
      return true;
    }
    if (result.code === 'WALLET_SHORT') {
      await rememberChosenOffer(deps, deposit.userId, pending.rideId, bid);   // keep the choice alive for the next transfer
      await log(await sendRideTopupButton(deps, deposit.userId, phone, { driverName: bid.driverName, ...result },
        `${received} That is not quite enough for this ride yet.`));
      return true;
    }
    if (result.code === 'ALREADY_CONFIRMING') return true;   // their own tap got there first and is speaking
    if (result.code === 'HOLD_FAILED' || result.code === 'CONFIRM_FAILED') {
      const reply = `${received}\n\nI could not confirm *${pending.driverName}* just now. Reply *pay* to try again.`;
      await log(reply);
      await sendMetaReply(deps, phone, reply);
      return true;
    }
    await clearPendingAccept(deps.redisClient, deposit.userId);
    if (result.code === 'RIDE_GONE') {
      const reply = `${received}\n\nThe search ended while your transfer was on its way, so *${pending.driverName}* was not booked. Your money is safe in your wallet — reply *search again* to find a driver.`;
      await log(reply);
      await sendMetaReply(deps, phone, reply);
      return true;
    }
    await log(await sendCurrentOffers(deps, phone, pending.rideId,
      `${received} ${pending.driverName} ${result.code === 'DRIVER_TAKEN' ? 'was taken by another rider' : "can't be reached right now"}, so nothing was booked. Your money is safe in your wallet.`));
    return true;
  };
}

/**
 * Money is handled on Wheelers' own page, not in the chat: bank details and a
 * PIN typed into WhatsApp would sit in the chat history for anyone holding the
 * phone. The link names one purpose and dies in 30 minutes; the token rides
 * in the #fragment, which browsers never send to a server or a referrer.
 */
async function sendWalletPageButton(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  incomingMessage: string,
  scope: WalletPageScope,
): Promise<void> {
  if (!deps.appBaseUrl) {
    await sendWhatsappText(deps, phone, incomingMessage, 'That is not available right now. Please try again shortly.');
    return;
  }
  const token = createWalletPageToken(user.id, scope, deps.jwtSecret, scope === 'deposit' ? DEPOSIT_PAGE_TOKEN_TTL_SECONDS : undefined);
  const url = `${deps.appBaseUrl.replace(/\/+$/, '')}/widget/wallet/${scope === 'deposit' ? 'deposit' : 'withdraw'}.html#t=${encodeURIComponent(token)}`;
  const body = scope === 'deposit'
    ? [
        '*Add money to your wallet*',
        '',
        'Tap below to get your Wheelers account number.',
        'Transfer from any bank app — it lands in your wallet by itself.',
      ].join('\n')
    : [
        '*Withdraw to your bank*',
        '',
        'Tap below, pick the amount and the account.',
        'Confirm with your wallet PIN and it is on its way.',
      ].join('\n');
  const minutes = (scope === 'deposit' ? DEPOSIT_PAGE_TOKEN_TTL_SECONDS : WALLET_PAGE_TOKEN_TTL_SECONDS) / 60;
  await sendMetaLinkButton(deps, phone, `${body}\n\n_This link is yours alone and works for ${minutes} minutes._`, scope === 'deposit' ? 'Add money' : 'Withdraw', url);
  await appendWhatsappConversation(deps.redisClient, phone, [
    { role: 'user', content: incomingMessage },
    { role: 'assistant', content: `[sent the ${scope} page button]` },
  ]);
}

/* ─── Group ride flow (plain chat — no Meta interactive flows) ─── */

function isGroupCancelCommand(message: string): boolean {
  const m = message.trim().toLowerCase();
  return /\b(cancel|leave|stop|end)\b.*\bgroup\b/.test(m) || /\bgroup\b.*\b(cancel|leave|stop|end)\b/.test(m);
}

function isGroupStatusCommand(message: string): boolean {
  const m = message.trim().toLowerCase();
  return /\bgroup\b.*\bstatus\b/.test(m) || /\bstatus\b.*\bgroup\b/.test(m);
}

const GROUP_SELFIE_PROMPT = [
  'Quick safety check',
  '',
  'Send a clear *selfie of your face* so other riders know who they are sharing with.',
  '',
  'Just your face, good lighting, no sunglasses. Reply *cancel group* to stop.',
].join('\n');

const MAX_SELFIE_ATTEMPTS = 3;

type WhatsappUser = { id: string };

async function replyAndLog(
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

const PRIVACY_POLICY_URL = (process.env['PRIVACY_POLICY_URL'] ?? 'https://wheelersng.com/privacy').trim();
const CONSENT_CONTINUE = 'Continue';
const CONSENT_NOT_NOW = 'Not now';
const FIRST_MESSAGE_TTL_SECONDS = 24 * 60 * 60;

function firstMessageKey(userId: string): string {
  return `whatsapp:user:${userId}:pre_consent_message`;
}

function consentPrompt(returning: boolean): string {
  return [
    returning ? 'Welcome back to Wheelers!' : 'Welcome to Wheelers!',
    '',
    'Before we start: to book your rides and run your wallet, Wheelers uses your name, phone number, the locations you share, and your trip and payment details. Our privacy policy explains how we use and protect them:',
    PRIVACY_POLICY_URL,
    '',
    `Tap *${CONSENT_CONTINUE}* to agree and get started, or *${CONSENT_NOT_NOW}*.`,
  ].join('\n');
}

/**
 * Nothing is booked, and nothing about the rider goes to a third party, until
 * they have accepted the privacy policy. "Continue" agrees; "Not now" declines
 * — and declining is never final: any later message offers the choice again.
 *
 * These are OUR button titles plus the plainest yes/no, not a guess at what
 * riders might say: anything else simply shows the question again.
 *
 * Returns true when it has dealt with the message.
 */
async function requirePrivacyConsent(
  deps: MetaWhatsappRouteDeps,
  user: { id: string; name: string | null; phone: string | null },
  phone: string,
  msgInfo: MetaMessageInfo,
): Promise<boolean> {
  const consent = await userClient.getPrivacyConsent(user.id);
  if (consent === 'AGREED') return false;

  const said = msgInfo.isLocation ? '' : msgInfo.messageBody.trim().toLowerCase();

  if (/^(continue|i agree|agree|agreed|accept|yes)[\s.!]*$/.test(said)) {
    await userClient.setPrivacyConsent(user.id, 'AGREED');
    logActivity({ userId: user.id, eventType: 'privacy_consent_agreed', source: 'whatsapp', metadata: { policyUrl: PRIVACY_POLICY_URL } });
    // Now — and only now — their name and phone may go to the payment provider.
    void provisionDepositAccount(deps.paymentsClient, user.id, user.name ?? undefined, user.phone ?? phone).catch((error) => {
      console.warn('[whatsapp] deposit account provisioning after consent failed (non-blocking)', {
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    // Pick up where they started: the message that met the question is answered now.
    const stashed = await deps.redisClient.get(firstMessageKey(user.id)).catch(() => null);
    await deps.redisClient.del(firstMessageKey(user.id)).catch(() => undefined);
    let first: MetaMessageInfo | null = null;
    try {
      first = stashed ? (JSON.parse(stashed) as MetaMessageInfo) : null;
    } catch {
      first = null;
    }
    if (first) {
      await sendMetaReply(deps, phone, "Thank you — you're all set.");
      await handleIncomingMetaMessage(deps, { ...first, messageId: '' });
      return true;
    }
    await sendMetaReply(deps, phone, "Thank you — you're all set.");
    await sendQuickActions(deps, user, phone, null, msgInfo.messageBody);
    return true;
  }

  if (/^(not now|no|no thanks|decline|i decline|disagree|i disagree|later)[\s.!]*$/.test(said)) {
    await userClient.setPrivacyConsent(user.id, 'DECLINED');
    await deps.redisClient.del(firstMessageKey(user.id)).catch(() => undefined);
    logActivity({ userId: user.id, eventType: 'privacy_consent_declined', source: 'whatsapp', metadata: {} });
    await sendMetaReply(deps, phone,
      `No problem. We can't book rides without it, so nothing has been set up and we won't message you.\n\nIf you change your mind, just send us a message and tap *${CONSENT_CONTINUE}*.`);
    return true;
  }

  // Anything else: keep what they asked for, and ask the question.
  if (!msgInfo.isImage && (msgInfo.isLocation || msgInfo.messageBody.trim())) {
    await deps.redisClient.set(firstMessageKey(user.id), JSON.stringify(msgInfo), FIRST_MESSAGE_TTL_SECONDS).catch(() => undefined);
  }
  await sendMetaButtons(deps, phone, consentPrompt(consent === 'DECLINED'), [CONSENT_CONTINUE, CONSENT_NOT_NOW]);
  return true;
}

// ── "Which one did you mean?" — a tap, not a typed number ────────────────

const PLACE_CHOICE_ID = /^place_choice_(\d+|none)$/;
const NONE_OF_THESE = 'None of these';

/** list_reply id → what the rider "said": the option's number, or none of them. */
function placeChoiceReply(id: unknown): string | null {
  const match = typeof id === 'string' ? PLACE_CHOICE_ID.exec(id) : null;
  if (!match) return null;
  return match[1] === 'none' ? NONE_OF_THESE : match[1]!;
}

function clip(text: string, max: number): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).replace(/[\s,·-]+$/, '')}…`;
}

export interface PlaceChoice { address: string; name?: string; distanceKm?: number }

/**
 * Row labels for the picker. WhatsApp allows 24 characters for a row's title
 * and 72 for the line under it — "Admiralty Way, Lekki, Nigeria" used to be
 * dumped into the title and arrive as "Admiralty Way, Lekki, Ni".
 *
 * The title carries WHAT DIFFERS between the options:
 *   • branches of one place drop the shared words — "Caleb University College
 *     of Law" / "Caleb University Admissions" → "College of Law" / "Admissions"
 *   • different streets keep their names — "Admiralty Way" / "Admiralty Road"
 *   • one name in several districts leads with the district — "Surulere" / "Akoka"
 * The full label, and how far it is, always sit underneath.
 */
export function placeChoiceRows(choices: Array<PlaceChoice | string>): Array<{ id: string; title: string; description: string }> {
  const parsed = choices.map((choice) => {
    const option = typeof choice === 'string' ? { address: choice } : choice;
    const parts = option.address.split(',').map((part) => part.replace(/\b\d{5,6}\b/g, '').trim()).filter(Boolean)
      .filter((part, index, all) => !(index === all.length - 1 && /^nigeria$/i.test(part)));
    const name = option.name?.trim() || parts[0] || option.address;
    const area = parts.find((part) => part.toLowerCase() !== name.toLowerCase()) ?? '';
    return { name, area, label: parts.join(', ') || option.address, distanceKm: option.distanceKm };
  });

  const distinctNames = new Set(parsed.map((place) => place.name.toLowerCase())).size;
  // Every option has the SAME name ("Shoprite" ×5, "Aiyetoro Street" ×2): the
  // area is what tells them apart. Otherwise the name leads, even if two repeat.
  const namesDiffer = distinctNames > 1 || parsed.length === 1;
  let titles: string[];
  if (namesDiffer) {
    // Names that fit are shown whole ("Admiralty Way" / "Admiralty Road"). Only
    // when one is too long for the 24 characters do the leading words every
    // option shares come off — they say nothing about which one is which, and
    // without this the part that matters ("… College of Law") is what gets cut.
    const words = parsed.map((place) => place.name.split(/\s+/));
    let shared = 0;
    if (parsed.some((place) => place.name.length > 24)) {
      while (words.every((w) => w.length > shared) && new Set(words.map((w) => w[shared]!.toLowerCase())).size === 1) shared += 1;
    }
    titles = words.map((w, index) => {
      // Only a name that does not fit gives up the shared words — "Shoprite
      // Shopping mall" fits and stays whole; "Caleb University College of Law"
      // does not, and becomes "College of Law".
      if (parsed[index]!.name.length <= 24) return parsed[index]!.name;
      const rest = w.slice(shared).join(' ');
      return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : parsed[index]!.name;
    });
  } else {
    titles = parsed.map((place) => place.area || place.name);
  }
  // Two rows may still read the same ("Ikorodu Garage" twice). The second one
  // becomes "Ikorodu Garage 2" — the line underneath says where each one is.
  const seen = new Map<string, number>();
  titles = titles.map((title) => {
    const key = clip(title, 24).toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count === 1 ? clip(title, 24) : `${clip(title, 22)} ${count}`;
  });

  return parsed.map((place, index) => {
    const distance = place.distanceKm != null ? ` · ${place.distanceKm < 10 ? place.distanceKm.toFixed(1) : Math.round(place.distanceKm)} km` : '';
    return {
      id: `place_choice_${index + 1}`,
      title: titles[index]!,
      description: `${clip(place.label, 72 - distance.length)}${distance}`,
    };
  });
}

/** The option a tap (or a typed number) picks, if a picker for one of these contexts is open. */
async function takePickedPlace(
  deps: MetaWhatsappRouteDeps,
  userId: string,
  message: string,
  contexts: Array<PendingGeoChoices['context']>,
): Promise<{ context: PendingGeoChoices['context']; lat: number; lng: number; address: string } | null> {
  if (!/^[1-9]$/.test(message.trim())) return null;
  const choices = await getPendingGeoChoices(deps.redisClient, userId);
  if (!choices || !contexts.includes(choices.context)) return null;
  const pick = choices.options[Number(message.trim()) - 1];
  if (!pick) return null;
  await clearPendingGeoChoices(deps.redisClient, userId);
  return { context: choices.context, ...pick };
}

/**
 * Ask which place they meant with ONE message and a button. Tapping it opens
 * WhatsApp's own picker; the tap comes back as the option's number. If the
 * list cannot be sent, the same question goes out as numbered text — typing
 * the number has always worked and still does.
 */
async function sendPlaceChoices(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  incomingMessage: string,
  input: {
    context: PendingGeoChoices['context'];
    field: 'pickup' | 'destination' | 'stop';
    typed: string;
    candidates: Array<{ lat: number; lng: number; formattedAddress: string; name?: string; distanceKm?: number }>;
    /** A line to lead with, e.g. the pickup that is already settled. */
    intro?: string;
    /** Replaces "I found N places matching …" — for a question that is not about a typed name. */
    question?: string;
  },
): Promise<void> {
  const shown = input.candidates.slice(0, 9);
  const options = shown.map((c) => ({ lat: c.lat, lng: c.lng, address: c.formattedAddress }));
  await storePendingGeoChoices(deps.redisClient, user.id, { context: input.context, options });

  const rows = placeChoiceRows(shown.map((c) => ({ address: c.formattedAddress, name: c.name, distanceKm: c.distanceKm })));
  const body = `${input.intro ? `${input.intro}\n\n` : ''}${input.question ?? `I found ${options.length} places matching "${clip(input.typed.split(',')[0] ?? input.typed, 60)}".\n\nTap *Choose* and pick the right ${input.field}.`}`;
  const asText = [
    `Found a few places matching "${input.typed}" — which one did you mean?`,
    ``,
    ...options.map((option, index) => `*${index + 1}.* ${option.address}`),
    ``,
    `Reply with the number.`,
  ].join('\n');

  await appendWhatsappConversation(deps.redisClient, phone, [
    { role: 'user', content: incomingMessage },
    { role: 'assistant', content: asText },
  ]);

  if (!deps.metaAccessToken || !deps.metaPhoneNumberId) {
    await sendMetaReply(deps, phone, asText);
    return;
  }
  const response = await fetch(`https://graph.facebook.com/v21.0/${deps.metaPhoneNumberId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${deps.metaAccessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone.replace(/^\+/, ''),
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: body },
        action: {
          button: 'Choose',
          sections: [{
            title: input.field === 'pickup' ? 'Pick the right pickup' : input.field === 'stop' ? 'Pick the stop' : 'Pick the destination',
            rows: [
              ...rows,
              { id: 'place_choice_none', title: NONE_OF_THESE, description: 'Type the address again with the area or a landmark' },
            ],
          }],
        },
      },
    }),
  }).catch(() => null);

  if (!response?.ok) {
    console.error('[whatsapp] place picker failed — falling back to numbered text', {
      status: response?.status ?? null,
      payload: response ? await response.text().catch(() => '') : 'network error',
    });
    await sendMetaReply(deps, phone, asText);
  }
}

// ── Reading the rider, not just the reply ────────────────────────────────

/** The small, fast model: Gemini flash-lite, with Groq's 20b as its backup. */
function bookingIntentGroq(deps: MetaWhatsappRouteDeps): LlmClient {
  return createLlm({ groqApiKey: deps.groqApiKey, groqModel: deps.groqModel, timeoutMs: deps.groqTimeoutMs }, 'intent');
}

function isAffirmativeReply(message: string): boolean {
  return /^(yes|yeah|yea|yep|yup|ok|okay|confirm|correct|sure|continue|go ahead|y)\b/i.test(message.trim());
}

const BOOKING_START_PROMPT =
  'Send your *pickup* and your *destination*, e.g.\n*From Ikeja City Mall to Unilag gate, Yaba*\n\nOr share your pickup location pin first, then type the destination.';

/** Throw the half-made booking away and begin again. */
async function startBookingOver(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  incomingMessage: string,
): Promise<void> {
  await Promise.all([
    clearPendingRoute(deps.redisClient, user.id),
    clearPendingLocation(deps.redisClient, user.id),
    clearPendingAreaHint(deps.redisClient, user.id),
    clearPendingGeoChoices(deps.redisClient, user.id),
    clearPendingFarPlace(deps.redisClient, user.id),
    clearBookingMisses(deps.redisClient, user.id),
    clearBookingStage(deps.redisClient, user.id),
  ].map((step) => step.catch(() => undefined)));
  await replyAndLog(deps, phone, incomingMessage, `No problem — let's start fresh.\n\n${BOOKING_START_PROMPT}`);
}

/** Up to three tappable replies. A tap arrives as its title, like typed text. */
async function sendMetaButtons(
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

/**
 * The reply for "I could not use that". The first time it is the normal prompt
 * plus one line naming the exits. From the second time on the rider is plainly
 * stuck, so the exits become buttons — nobody should have to guess a magic
 * word to get out of a booking. Asking for help skips straight to the buttons.
 */
async function replyWithWayOut(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  incomingMessage: string,
  options: { prompt: string; hint: string; buttons: string[]; wantsHelp?: boolean },
): Promise<void> {
  const misses = await noteBookingMiss(deps.redisClient, user.id).catch(() => 1);
  if (misses < 2 && !options.wantsHelp) {
    await replyAndLog(deps, phone, incomingMessage, `${options.prompt}\n\n${options.hint}`);
    return;
  }

  const support = process.env['SUPPORT_CONTACT']?.trim();
  const body = [
    options.wantsHelp ? 'No wahala — here is what you can do from here:' : 'Looks like we are not getting anywhere — my bad. What would you like to do?',
    '',
    options.prompt,
    ...(support ? ['', `Need a person? Reach Wheelers support: ${support}`] : []),
  ].join('\n');
  if (options.wantsHelp) console.info('[whatsapp] rider asked for help mid-booking', { userId: user.id });

  await appendWhatsappConversation(deps.redisClient, phone, [
    { role: 'user', content: incomingMessage },
    { role: 'assistant', content: body },
  ]);
  await sendMetaButtons(deps, phone, body, options.buttons);
}

/**
 * A place hundreds of km from the other end of the trip is almost always the
 * wrong match, not a real plan — "7 Osaro Isokpan" from Akoka resolved to Benin
 * City and the bot cheerfully quoted ₦97,100 for 311 km. Hold it and ask.
 * Returns true when it asked (the caller stops).
 */
async function askIfFarPlaceIsMeant(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  incomingMessage: string,
  field: 'pickup' | 'destination',
  place: { lat: number; lng: number; address: string },
  otherEnd: { lat: number; lng: number },
): Promise<boolean> {
  const distanceKm = Math.round(kmBetween(otherEnd, place));
  if (distanceKm <= SAME_CITY_KM) return false;

  await storePendingFarPlace(deps.redisClient, user.id, { field, ...place, distanceKm });
  const other = field === 'destination' ? 'pickup' : 'destination';
  await replyAndLog(deps, phone, incomingMessage, [
    `I found *${place.address}* — but that is about *${distanceKm.toLocaleString()} km* from your ${other}, in another city.`,
    '',
    `If you meant somewhere closer, send the ${field} again with the area or city — e.g. *"7 Osaro Isokpan, Yaba"*.`,
    '',
    `Reply *yes* if you really are going that far.`,
  ].join('\n'));
  return true;
}

/**
 * Change one end of a quoted trip and re-quote it. Every way of asking for
 * that — "edit destination …", a sentence the model understood, a bare address
 * resent at the price step, a "yes" to a far-away place — lands here.
 */
async function replanPendingRoute(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  incomingMessage: string,
  pendingRoute: PendingRouteData,
  field: 'pickup' | 'destination',
  address: string,
  /** A place the rider has already settled on: picked from the list, or a far one they said yes to. */
  chosen?: { lat: number; lng: number; address: string; farConfirmed?: boolean },
): Promise<void> {
  const isPickup = field === 'pickup';
  const otherEnd = isPickup
    ? { lat: pendingRoute.destLat, lng: pendingRoute.destLng }
    : { lat: pendingRoute.pickupLat, lng: pendingRoute.pickupLng };

  let geo: { lat: number; lng: number; formattedAddress: string } | null = chosen
    ? { lat: chosen.lat, lng: chosen.lng, formattedAddress: chosen.address }
    : null;
  if (!geo) {
    const matches = await findPlaceOptions(deps.googleMapsApiKey, address, { spokenText: incomingMessage, near: otherEnd });
    if (matches.length > 1) {
      // "No, Caleb law" has more than one answer too — ask, never guess.
      await sendPlaceChoices(deps, user, phone, incomingMessage, {
        context: isPickup ? 'edit_pickup' : 'edit_destination',
        field,
        typed: address,
        candidates: matches,
      });
      return;
    }
    geo = matches[0] ?? null;
  }
  if (!geo) {
    await replyAndLog(deps, phone, incomingMessage,
      `${geocodeMissLine(address)}\n\nPlease try a more specific ${field} address or share a location pin\n\nYour booking is unchanged.`);
    return;
  }

  const place = { lat: geo.lat, lng: geo.lng, address: geo.formattedAddress };
  if (!chosen?.farConfirmed && await askIfFarPlaceIsMeant(deps, user, phone, incomingMessage, field, place, otherEnd)) return;

  const pickup = isPickup ? place : { lat: pendingRoute.pickupLat, lng: pendingRoute.pickupLng, address: pendingRoute.pickupAddress };
  const destination = isPickup ? { lat: pendingRoute.destLat, lng: pendingRoute.destLng, address: pendingRoute.destAddress } : place;

  const plannedRoute = await planRouteSafe(deps, pickup, destination, pendingRoute.stops);
  if (!plannedRoute) {
    await replyAndLog(deps, phone, incomingMessage, `${ROUTE_PLAN_FAILED_REPLY}\n\nYour booking is unchanged.`);
    return;
  }

  const suggestedFare = plannedRoute.suggestedFareNgn;
  const minFare = plannedRoute.minOfferNgn;
  await storePendingRoute(deps.redisClient, user.id, {
    pickupLat: pickup.lat,
    pickupLng: pickup.lng,
    pickupAddress: pickup.address,
    destLat: destination.lat,
    destLng: destination.lng,
    destAddress: destination.address,
    distanceKm: plannedRoute.distanceKm,
    durationSeconds: plannedRoute.durationSeconds,
    suggestedFareNgn: suggestedFare,
    minOfferNgn: minFare,
    ratePerKmNgn: plannedRoute.ratePerKmNgn,
    route: plannedRoute.geometry,
    stops: pendingRoute.stops,
  });
  await setBookingStage(deps.redisClient, user.id, 'awaiting_price');
  await clearBookingMisses(deps.redisClient, user.id).catch(() => undefined);

  await quoteAndLog(deps, user, phone, incomingMessage, [
    `*${isPickup ? 'Pickup updated!' : 'Destination updated!'}*`,
    ``,
    `Pickup: *${pickup.address}*`,
    ``,
    `Destination: *${destination.address}*`,
    ``,
    `${plannedRoute.distanceKm.toFixed(1)} km · ~${Math.ceil(plannedRoute.durationSeconds / 60)} min`,
    `Minimum fare: ₦${minFare.toLocaleString()}`,
    `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
    ``,
    `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
  ].join('\n'));
}

/* ── confirm the trip before the price: Confirm · Add a stop · Edit ─────── */

const TRIP_CONFIRM_ID = 'trip_confirm';
const TRIP_ADD_STOP_ID = 'trip_add_stop';
const TRIP_EDIT_ID = 'trip_edit';
const TRIP_EDIT_PICKUP_ID = 'trip_edit_pickup';
const TRIP_EDIT_DESTINATION_ID = 'trip_edit_destination';
const TRIP_CANCEL_ID = 'trip_cancel';
const TRIP_REMOVE_STOP = /^trip_remove_stop_(\d)$/;

/** Pickup, every stop in order, destination — the same lines on the card, the quote and the edit list. */
function tripLines(trip: PendingRouteData): string[] {
  return [
    `Pickup: *${trip.pickupAddress}*`,
    ...(trip.stops ?? []).map((stop, index) => `Stop ${index + 1}: *${stop.address}*`),
    `Destination: *${trip.destAddress}*`,
  ];
}

/**
 * "Is this your trip?" — shown after the destination is known and after every
 * change, BEFORE any price is asked for. Three taps: it is right, add a stop,
 * or change something. Typing works too ("add a stop at Yaba market", "no, pick
 * me at the gate") — the step's handler reads it.
 */
async function sendTripConfirmation(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  trip: PendingRouteData,
  headline?: string,
): Promise<string> {
  await setBookingStage(deps.redisClient, user.id, 'awaiting_trip_confirm');

  // WhatsApp allows a message reply buttons OR one form button — never both. With
  // the form published, the card is ONE message with ONE button: confirming,
  // editing and stops all happen in the form, and the price step follows it.
  if (EDIT_TRIP_FLOW_ENABLED && deps.whatsappEditTripFlowId) {
    const formCard = [
      headline ?? '*Check your trip*',
      ``,
      ...tripLines(trip),
      ``,
      `${trip.distanceKm.toFixed(1)} km · ~${Math.ceil(trip.durationSeconds / 60)} min · suggested fare ₦${trip.suggestedFareNgn.toLocaleString()}`,
      ``,
      `Tap *${TRIP_FORM_CTA}* — confirm it as it is, change the pickup or destination, or add a stop. All in one place.`,
      ``,
      `_Form not opening? Reply_ *yes* _to confirm, or just type the change, e.g._ add a stop at Yaba market`,
    ].join('\n');
    if (await sendTripForm(deps, user.id, phone, formCard, TRIP_FORM_CTA)) return formCard;
  }

  const canAddStop = (trip.stops?.length ?? 0) < MAX_CHAT_STOPS;
  const body = [
    headline ?? '*Check your trip*',
    ``,
    ...tripLines(trip),
    ``,
    `${trip.distanceKm.toFixed(1)} km · ~${Math.ceil(trip.durationSeconds / 60)} min · suggested fare ₦${trip.suggestedFareNgn.toLocaleString()}`,
    ``,
    `All correct? Tap *Confirm trip*. To change anything tap *Edit trip* — or just type it, e.g. _add a stop at Yaba market_.`,
  ].join('\n');

  const buttons = [
    { id: TRIP_CONFIRM_ID, title: 'Confirm trip' },
    ...(canAddStop ? [{ id: TRIP_ADD_STOP_ID, title: 'Add a stop' }] : []),
    { id: TRIP_EDIT_ID, title: 'Edit trip' },
  ];
  const sent = await sendInteractive(deps, phone, {
    type: 'button',
    body: { text: body.slice(0, 1024) },
    action: { buttons: buttons.map((button) => ({ type: 'reply', reply: button })) },
  });
  if (!sent) await sendMetaReply(deps, phone, `${body}\n\nReply *confirm*, *add stop* or *edit*.`);
  return body;
}

/** The "Edit trip" sheet: WhatsApp's own picker, one row per thing that can change. */
async function sendTripEditMenu(deps: MetaWhatsappRouteDeps, phone: string, trip: PendingRouteData): Promise<string> {
  const stops = trip.stops ?? [];
  const rows = [
    { id: TRIP_EDIT_PICKUP_ID, title: 'Change pickup', description: clip(trip.pickupAddress, 72) },
    { id: TRIP_EDIT_DESTINATION_ID, title: 'Change destination', description: clip(trip.destAddress, 72) },
    ...(stops.length < MAX_CHAT_STOPS ? [{ id: TRIP_ADD_STOP_ID, title: 'Add a stop', description: 'A place to pass through on the way' }] : []),
    ...stops.map((stop, index) => ({ id: `trip_remove_stop_${index + 1}`, title: `Remove stop ${index + 1}`, description: clip(stop.address, 72) })),
    { id: TRIP_CANCEL_ID, title: 'Cancel booking', description: 'Throw this trip away' },
  ];
  const body = `*Edit your trip*\n\n${tripLines(trip).join('\n')}\n\nTap *Choose* and pick what to change.`;
  const sent = await sendInteractive(deps, phone, {
    type: 'list',
    body: { text: body.slice(0, 1024) },
    action: { button: 'Choose', sections: [{ title: 'What to change', rows }] },
  });
  if (!sent) {
    await sendMetaReply(deps, phone, `${body}\n\nType what to change — e.g. *edit pickup Unilag gate*, *edit destination Yaba*, *add a stop at Shoprite*${stops.length ? ', *remove stop 1*' : ''}.`);
  }
  return body;
}

/** 20 characters — WhatsApp's limit for a form button. */
const TRIP_FORM_CTA = 'Confirm or edit trip';

/**
 * A message whose button opens the trip form (edit-trip-flow.ts), filled with
 * the trip as it stands. False when it could not be sent, so the caller carries
 * on with reply buttons in the chat.
 */
async function sendTripForm(deps: MetaWhatsappRouteDeps, userId: string, phone: string, body: string, cta: string): Promise<boolean> {
  if (!EDIT_TRIP_FLOW_ENABLED || !deps.whatsappEditTripFlowId) return false;
  return sendInteractive(deps, phone, {
    type: 'flow',
    body: { text: body.slice(0, 1024) },
    action: {
      name: 'flow',
      parameters: {
        flow_message_version: '3',
        flow_id: deps.whatsappEditTripFlowId,
        flow_token: signFlowToken(`edit:${userId}`, deps.jwtSecret),
        flow_cta: cta.slice(0, 20),
        // data_exchange: opening calls our endpoint's INIT, so the boxes arrive filled in.
        flow_action: 'data_exchange',
      },
    },
  });
}

/**
 * They ASKED to edit (typed "edit", "add a stop", or tapped a button on a card
 * sent before the form existed): a short message with the form's button. The
 * normal path needs no such message — the trip card's own button is the form.
 */
async function sendEditTripForm(deps: MetaWhatsappRouteDeps, userId: string, phone: string, addingStop: boolean): Promise<boolean> {
  return sendTripForm(deps, userId, phone,
    addingStop
      ? '*Add your stop* — tap below and type it in a Stop box. You can change the pickup or destination there too.\n\n_Form not opening? Just type it here, e.g._ add a stop at Yaba market'
      : '*Edit your trip* — pickup, stops and destination, all in one place.\n\n_Form not opening? Just type the change here, e.g._ pick me at Unilag gate',
    addingStop ? 'Add a stop' : 'Edit trip');
}

/** One interactive message. False when it could not be sent, so the caller can say it in text. */
async function sendInteractive(deps: MetaWhatsappRouteDeps, to: string, interactive: Record<string, unknown>): Promise<boolean> {
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

/** The trip is right: now, and only now, the price. */
async function confirmTripAndQuote(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  incomingMessage: string,
  trip: PendingRouteData,
): Promise<void> {
  await storePendingRoute(deps.redisClient, user.id, { ...trip, confirmed: true });
  await setBookingStage(deps.redisClient, user.id, 'awaiting_price');
  await clearBookingMisses(deps.redisClient, user.id).catch(() => undefined);
  await quoteAndLog(deps, user, phone, incomingMessage, [
    `*Trip confirmed*`,
    ``,
    ...tripLines(trip),
    ``,
    `${trip.distanceKm.toFixed(1)} km · ~${Math.ceil(trip.durationSeconds / 60)} min`,
    `Minimum fare: ₦${trip.minOfferNgn.toLocaleString()}`,
    `Suggested fare: ₦${trip.suggestedFareNgn.toLocaleString()}`,
    ``,
    `Send your offer (e.g. *${trip.suggestedFareNgn.toLocaleString()}* or *${Math.round(trip.suggestedFareNgn * 0.85).toLocaleString()}*)`,
  ].join('\n'));
}

/** Re-plan the same ends with a different list of stops, and show the trip again. */
async function replanWithStops(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  incomingMessage: string,
  trip: PendingRouteData,
  stops: RouteStop[],
  headline: string,
): Promise<void> {
  const pickup = { lat: trip.pickupLat, lng: trip.pickupLng, address: trip.pickupAddress };
  const destination = { lat: trip.destLat, lng: trip.destLng, address: trip.destAddress };
  const planned = await planRouteSafe(deps, pickup, destination, stops);
  if (!planned) {
    await replyAndLog(deps, phone, incomingMessage, `I could not find a driving route through that stop. Your trip is unchanged — try a different place, or share a location pin`);
    return;
  }
  const next: PendingRouteData = {
    ...trip,
    stops,
    distanceKm: planned.distanceKm,
    durationSeconds: planned.durationSeconds,
    suggestedFareNgn: planned.suggestedFareNgn,
    minOfferNgn: planned.minOfferNgn,
    ratePerKmNgn: planned.ratePerKmNgn,
    route: planned.geometry,
    confirmed: false,
    offerNgn: undefined,
  };
  await storePendingRoute(deps.redisClient, user.id, next);
  await clearBookingMisses(deps.redisClient, user.id).catch(() => undefined);
  const said = await sendTripConfirmation(deps, user, phone, next, headline);
  await appendWhatsappConversation(deps.redisClient, phone, [
    { role: 'user', content: incomingMessage },
    { role: 'assistant', content: said },
  ]);
}

const ADD_STOP_PROMPT = 'Where do you want to stop?\n\nType the place — e.g. *"Yaba market"* or *"Shoprite Ikeja"* — or share a location pin\n\nReply *back* to leave the trip as it is.';

async function askForStop(deps: MetaWhatsappRouteDeps, user: { id: string }, phone: string, incomingMessage: string, trip: PendingRouteData): Promise<void> {
  if ((trip.stops?.length ?? 0) >= MAX_CHAT_STOPS) {
    await replyAndLog(deps, phone, incomingMessage, `A trip can have up to ${MAX_CHAT_STOPS} stops, and yours has ${MAX_CHAT_STOPS}. Remove one first — tap *Edit trip*.`);
    return;
  }
  await setBookingStage(deps.redisClient, user.id, 'adding_stop');
  await replyAndLog(deps, phone, incomingMessage, ADD_STOP_PROMPT);
}

/**
 * Add a stop by name (looked up like every other place: Places first, the
 * picker when there is more than one answer) or as a place already settled on
 * (picked from the list, or a shared pin).
 */
async function addStopToTrip(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  incomingMessage: string,
  trip: PendingRouteData,
  typed: string,
  chosen?: RouteStop,
): Promise<void> {
  const stops = trip.stops ?? [];
  if (stops.length >= MAX_CHAT_STOPS) {
    await askForStop(deps, user, phone, incomingMessage, trip);
    return;
  }
  const pickup = { lat: trip.pickupLat, lng: trip.pickupLng };

  // Only the three fields: a picked place arrives with the picker's bookkeeping on it,
  // and whatever is stored here is sent to drivers as the stop.
  let stop: RouteStop | null = chosen ? { lat: chosen.lat, lng: chosen.lng, address: chosen.address } : null;
  if (!stop) {
    const matches = await findPlaceOptions(deps.googleMapsApiKey, typed, { spokenText: incomingMessage, near: pickup });
    if (matches.length > 1) {
      await setBookingStage(deps.redisClient, user.id, 'adding_stop');
      await sendPlaceChoices(deps, user, phone, incomingMessage, { context: 'stop', field: 'stop', typed, candidates: matches });
      return;
    }
    stop = matches[0] ? { lat: matches[0].lat, lng: matches[0].lng, address: matches[0].formattedAddress } : null;
  }
  if (!stop) {
    await setBookingStage(deps.redisClient, user.id, 'adding_stop');
    await replyAndLog(deps, phone, incomingMessage, `${geocodeMissLine(typed)}\n\nTry the stop again with the area or a landmark, share a pin, or reply *back*.`);
    return;
  }

  // A stop in another city is a wrong match, not a plan.
  const awayKm = Math.round(kmBetween(pickup, stop));
  if (awayKm > SAME_CITY_KM) {
    await setBookingStage(deps.redisClient, user.id, 'adding_stop');
    await replyAndLog(deps, phone, incomingMessage, `I found *${stop.address}* — but that is about ${awayKm.toLocaleString()} km from your pickup, in another city.\n\nSend the stop again with the area — e.g. *"Shoprite, Ikeja"* — or reply *back*.`);
    return;
  }
  const samePlace = [
    { label: 'your pickup', lat: trip.pickupLat, lng: trip.pickupLng },
    { label: 'your destination', lat: trip.destLat, lng: trip.destLng },
    ...stops.map((existing, index) => ({ label: `stop ${index + 1}`, lat: existing.lat, lng: existing.lng })),
  ].find((place) => kmBetween(place, stop!) < SAME_PLACE_KM);
  if (samePlace) {
    await setBookingStage(deps.redisClient, user.id, 'adding_stop');
    await replyAndLog(deps, phone, incomingMessage, `*${stop.address}* is the same place as ${samePlace.label}. Send a different stop, or reply *back*.`);
    return;
  }

  await replanWithStops(deps, user, phone, incomingMessage, trip, [...stops, stop], `*Stop added*`);
}

async function removeStopFromTrip(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  incomingMessage: string,
  trip: PendingRouteData,
  /** 1-based. Omitted with one stop on the trip = that one. */
  position?: number,
): Promise<void> {
  const stops = trip.stops ?? [];
  if (stops.length === 0) {
    const said = await sendTripConfirmation(deps, user, phone, trip, 'Your trip has no stops');
    await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: incomingMessage }, { role: 'assistant', content: said }]);
    return;
  }
  const index = (position ?? (stops.length === 1 ? 1 : 0)) - 1;
  if (!stops[index]) {
    const said = await sendTripEditMenu(deps, phone, trip);      // more than one stop and they did not say which
    await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: incomingMessage }, { role: 'assistant', content: said }]);
    return;
  }
  await replanWithStops(deps, user, phone, incomingMessage, trip, stops.filter((_, at) => at !== index), `*Stop removed*`);
}

/** Ask for the new pickup / destination; the existing editing steps take it from there (Places + the picker). */
async function askForNewEnd(deps: MetaWhatsappRouteDeps, user: { id: string }, phone: string, incomingMessage: string, trip: PendingRouteData, field: 'pickup' | 'destination'): Promise<void> {
  await setBookingStage(deps.redisClient, user.id, field === 'pickup' ? 'editing_pickup' : 'editing_destination');
  await replyAndLog(deps, phone, incomingMessage,
    `Current ${field}: *${field === 'pickup' ? trip.pickupAddress : trip.destAddress}*\n\nType the new ${field} — a name is enough, I'll show you the matches — or share a location pin`);
}

/**
 * A tap on the trip card or the Edit sheet. Handled by what was tapped, not by
 * the step the chat thinks it is on: those messages stay tappable, and a rider
 * who confirmed and THEN taps "Edit trip" on the card above means it.
 */
async function handleTripTap(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  incomingMessage: string,
  replyId: string,
  hasActiveRide: boolean,
): Promise<void> {
  if (hasActiveRide) {
    await replyAndLog(deps, phone, incomingMessage, 'Drivers are already looking at this trip. To change it, reply *cancel* and send the new trip.');
    return;
  }
  const trip = await getPendingRoute(deps.redisClient, user.id);
  if (!trip) {
    await clearBookingStage(deps.redisClient, user.id);
    await replyAndLog(deps, phone, incomingMessage, `That trip has expired.\n\n${BOOKING_START_PROMPT}`);
    return;
  }
  await clearPendingGeoChoices(deps.redisClient, user.id).catch(() => undefined);

  if (replyId === TRIP_CONFIRM_ID) return confirmTripAndQuote(deps, user, phone, incomingMessage, trip);

  // Edit / Add a stop: the form when there is one — every change in one place, one message back.
  if ((replyId === TRIP_EDIT_ID || replyId === TRIP_ADD_STOP_ID) && await sendEditTripForm(deps, user.id, phone, replyId === TRIP_ADD_STOP_ID)) {
    await setBookingStage(deps.redisClient, user.id, 'awaiting_trip_confirm');     // typing still works while the form is open
    await appendWhatsappConversation(deps.redisClient, phone, [
      { role: 'user', content: incomingMessage },
      { role: 'assistant', content: '[sent the Edit trip form]' },
    ]);
    return;
  }
  if (replyId === TRIP_ADD_STOP_ID) return askForStop(deps, user, phone, incomingMessage, trip);
  if (replyId === TRIP_EDIT_PICKUP_ID) return askForNewEnd(deps, user, phone, incomingMessage, trip, 'pickup');
  if (replyId === TRIP_EDIT_DESTINATION_ID) return askForNewEnd(deps, user, phone, incomingMessage, trip, 'destination');
  if (replyId === TRIP_CANCEL_ID) {
    await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
    return replyAndLog(deps, phone, incomingMessage, CANCELLATION_REASON_PROMPT);
  }
  const remove = TRIP_REMOVE_STOP.exec(replyId);
  if (remove) return removeStopFromTrip(deps, user, phone, incomingMessage, trip, Number(remove[1]));

  // TRIP_EDIT_ID, or a row from a newer version of the sheet.
  await setBookingStage(deps.redisClient, user.id, 'awaiting_trip_confirm');
  const said = await sendTripEditMenu(deps, phone, trip);
  await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: incomingMessage }, { role: 'assistant', content: said }]);
}

/** replyAndLog for a fare quote: same record, plus the "Set your price" button. */
async function quoteAndLog(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  userMessage: string,
  quote: string,
): Promise<void> {
  // Logged AFTER sending: an unconfirmed trip goes out as the confirmation card, not this quote.
  const said = await sendQuoteWithPriceButton(deps, user, phone, quote);
  await appendWhatsappConversation(deps.redisClient, phone, [
    { role: 'user', content: userMessage },
    { role: 'assistant', content: said },
  ]);
}

/** Entry: "group ride" intent. Pre-filled locations skip straight ahead. */
async function startGroupRideFlow(
  deps: MetaWhatsappRouteDeps,
  user: WhatsappUser,
  phone: string,
  incomingMessage: string,
  prefill?: {
    pickup?: { lat: number; lng: number; address: string };
    destination?: { lat: number; lng: number; address: string };
  },
): Promise<void> {
  const pending = {
    ...(prefill?.pickup
      ? {
          pickupLat: prefill.pickup.lat,
          pickupLng: prefill.pickup.lng,
          pickupAddress: prefill.pickup.address,
        }
      : {}),
    ...(prefill?.destination
      ? {
          destLat: prefill.destination.lat,
          destLng: prefill.destination.lng,
          destAddress: prefill.destination.address,
        }
      : {}),
  };
  await storePendingGroupRide(deps.redisClient, user.id, pending);

  if (pending.pickupLat !== undefined && pending.destLat !== undefined) {
    await presentGroupQuote(deps, user, phone, incomingMessage);
    return;
  }

  if (pending.pickupLat !== undefined) {
    await setBookingStage(deps.redisClient, user.id, 'group_awaiting_destination');
    await replyAndLog(deps, phone, incomingMessage,
      `*Group ride!* Riders heading the same way share one car and split the fare.\n\nPickup: *${pending.pickupAddress}*\n\nWhere are you headed? Type the destination or share a pin`);
    return;
  }

  await setBookingStage(deps.redisClient, user.id, 'group_awaiting_pickup');
  await replyAndLog(deps, phone, incomingMessage,
    `*Group ride!* Riders heading the same way share one car and split the fare.\n\nWhere should we pick you up? Share a location pin or type the address.`);
}

/** Both locations known: plan the route, quote it, ask for one yes. */
async function presentGroupQuote(
  deps: MetaWhatsappRouteDeps,
  user: WhatsappUser,
  phone: string,
  incomingMessage: string,
): Promise<void> {
  const pending = await getPendingGroupRide(deps.redisClient, user.id);
  if (
    !pending ||
    pending.pickupLat === undefined || pending.pickupLng === undefined ||
    pending.destLat === undefined || pending.destLng === undefined
  ) {
    await clearBookingStage(deps.redisClient, user.id);
    await replyAndLog(deps, phone, incomingMessage,
      'Session expired — type *group ride* to start again.');
    return;
  }

  const pickup = { lat: pending.pickupLat, lng: pending.pickupLng, address: pending.pickupAddress ?? '' };
  const destination = { lat: pending.destLat, lng: pending.destLng, address: pending.destAddress ?? '' };

  const plannedRoute = await planRouteSafe(deps, pickup, destination);
  if (!plannedRoute) {
    await replyAndLog(deps, phone, incomingMessage, ROUTE_PLAN_FAILED_REPLY);
    return;
  }

  // Every seat has its own price, set by its own rider. Suggested is 25%
  // off the solo fare — sharing should always beat riding alone.
  const suggestedSeatNgn = Math.round((plannedRoute.suggestedFareNgn * 0.75) / 50) * 50;

  await storePendingGroupRide(deps.redisClient, user.id, {
    ...pending,
    plannedDistanceKm: plannedRoute.distanceKm,
    plannedDurationSeconds: plannedRoute.durationSeconds,
    fareEstimateNgn: suggestedSeatNgn,
  });
  await setBookingStage(deps.redisClient, user.id, 'group_awaiting_confirm');

  const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
  await replyAndLog(deps, phone, incomingMessage, [
    `*Group ride*`,
    ``,
    `Pickup: *${pickup.address}*`,
    `Destination: *${destination.address}*`,
    `${plannedRoute.distanceKm.toFixed(1)} km · ~${durationMin} min`,
    ``,
    `Solo fare: ₦${plannedRoute.suggestedFareNgn.toLocaleString()}`,
    `*Your seat, your price.* Suggested: *₦${suggestedSeatNgn.toLocaleString()}* (25% off solo).`,
    ``,
    `Reply *yes* to offer ₦${suggestedSeatNgn.toLocaleString()}, send *your own price*, or *cancel*.`,
  ].join('\n'));
}

/** Text messages while in one of the group stages. */
async function handleGroupStageText(
  deps: MetaWhatsappRouteDeps,
  user: WhatsappUser,
  phone: string,
  incomingMessage: string,
  stage: 'group_awaiting_pickup' | 'group_awaiting_destination' | 'group_awaiting_confirm' | 'group_awaiting_face_photo',
): Promise<void> {
  if (isCancelCommand(incomingMessage) || isGroupCancelCommand(incomingMessage)) {
    await cancelGroupRide(deps, user, phone, incomingMessage);
    return;
  }

  if (stage === 'group_awaiting_pickup' || stage === 'group_awaiting_destination') {
    // Riders often answer the pickup question with the whole route
    // ("From 108 Opebi to 15 Aiyetoro Street") — take both in one go.
    const routeMatch = incomingMessage.trim().match(/^from\s+(.+?)\s+to\s+(.+)$/i);
    if (routeMatch) {
      const pickupGeo = await geocodeAddress(deps.googleMapsApiKey, routeMatch[1]!.trim());
      const destGeo = await geocodeAddress(deps.googleMapsApiKey, routeMatch[2]!.trim(),
        pickupGeo ? { near: { lat: pickupGeo.lat, lng: pickupGeo.lng } } : {});
      if (pickupGeo && destGeo) {
        const pending = (await getPendingGroupRide(deps.redisClient, user.id)) ?? {};
        await storePendingGroupRide(deps.redisClient, user.id, {
          ...pending,
          pickupLat: pickupGeo.lat,
          pickupLng: pickupGeo.lng,
          pickupAddress: pickupGeo.formattedAddress,
          destLat: destGeo.lat,
          destLng: destGeo.lng,
          destAddress: destGeo.formattedAddress,
        });
        await presentGroupQuote(deps, user, phone, incomingMessage);
        return;
      }
      if (!pickupGeo) {
        await replyAndLog(deps, phone, incomingMessage,
          `${geocodeMissLine(routeMatch[1]!.trim())}\n\nPlease type a more specific pickup address or share a location pin`);
        return;
      }
      // Pickup resolved but destination didn't — keep it, say so, ask again.
      await replyAndLog(deps, phone, incomingMessage, geocodeMissLine(routeMatch[2]!.trim()));
      await applyGroupLocation(deps, user, phone, incomingMessage, 'group_awaiting_pickup', {
        lat: pickupGeo.lat,
        lng: pickupGeo.lng,
        address: pickupGeo.formattedAddress,
      });
      return;
    }

    const typed = stripDirectionPrefix(incomingMessage);

    // A bare number answers a pending "which one did you mean?" list.
    if (/^[1-9]$/.test(typed)) {
      const choices = await getPendingGeoChoices(deps.redisClient, user.id);
      const expectedContext = stage === 'group_awaiting_pickup' ? 'group_pickup' : 'group_destination';
      const pick = choices?.context === expectedContext ? choices.options[Number(typed) - 1] : undefined;
      if (pick) {
        await clearPendingGeoChoices(deps.redisClient, user.id);
        await applyGroupLocation(deps, user, phone, incomingMessage, stage, pick);
        return;
      }
    }

    const candidates = await findPlaceOptions(deps.googleMapsApiKey, typed, { spokenText: incomingMessage });
    if (candidates.length === 0) {
      await replyAndLog(deps, phone, incomingMessage,
        `${geocodeMissLine(typed)}\n\nPlease type a more specific address or share a location pin`);
      return;
    }

    // Ambiguous place name ("Aiyetoro" exists in Surulere AND Akoka) — ask
    // instead of assuming. A query that pins the area returns one candidate.
    if (candidates.length > 1) {
      await sendPlaceChoices(deps, user, phone, incomingMessage, {
        context: stage === 'group_awaiting_pickup' ? 'group_pickup' : 'group_destination',
        field: stage === 'group_awaiting_pickup' ? 'pickup' : 'destination',
        typed,
        candidates,
      });
      return;
    }

    await applyGroupLocation(deps, user, phone, incomingMessage, stage, {
      lat: candidates[0]!.lat,
      lng: candidates[0]!.lng,
      address: candidates[0]!.formattedAddress,
    });
    return;
  }

  if (stage === 'group_awaiting_confirm') {
    if (/^(yes|yeah|yea|yep|ok|okay|confirm|y)\b/i.test(incomingMessage.trim())) {
      await createGroupMatchRequest(deps, user, phone, incomingMessage);
      return;
    }

    // A number here is the rider naming their own seat price.
    const offered = parseCounterOffer(incomingMessage);
    if (offered !== null && offered >= 500) {
      const pending = await getPendingGroupRide(deps.redisClient, user.id);
      if (pending) {
        await storePendingGroupRide(deps.redisClient, user.id, {
          ...pending,
          fareEstimateNgn: offered,
        });
      }
      await createGroupMatchRequest(deps, user, phone, incomingMessage);
      return;
    }

    await replyAndLog(deps, phone, incomingMessage,
      'Reply *yes* to use the suggested seat price, send *your own price* (e.g. *4200*), or *cancel*.');
    return;
  }

  // group_awaiting_face_photo — they typed instead of sending a photo
  await replyAndLog(deps, phone, incomingMessage, GROUP_SELFIE_PROMPT);
}

/** Location pins while in a group location stage. */
async function applyGroupLocation(
  deps: MetaWhatsappRouteDeps,
  user: WhatsappUser,
  phone: string,
  incomingMessage: string,
  stage: 'group_awaiting_pickup' | 'group_awaiting_destination',
  point: { lat: number; lng: number; address: string },
): Promise<void> {
  const pending = (await getPendingGroupRide(deps.redisClient, user.id)) ?? {};

  if (stage === 'group_awaiting_pickup') {
    await storePendingGroupRide(deps.redisClient, user.id, {
      ...pending,
      pickupLat: point.lat,
      pickupLng: point.lng,
      pickupAddress: point.address,
    });
    if (pending.destLat !== undefined) {
      await presentGroupQuote(deps, user, phone, incomingMessage);
      return;
    }
    await setBookingStage(deps.redisClient, user.id, 'group_awaiting_destination');
    await replyAndLog(deps, phone, incomingMessage,
      `Pickup: *${point.address}*\n\nWhere are you headed? Type the destination or share a pin`);
    return;
  }

  await storePendingGroupRide(deps.redisClient, user.id, {
    ...pending,
    destLat: point.lat,
    destLng: point.lng,
    destAddress: point.address,
  });
  await presentGroupQuote(deps, user, phone, incomingMessage);
}

/** "yes" on the quote: create the match request, then ask for the selfie. */
async function createGroupMatchRequest(
  deps: MetaWhatsappRouteDeps,
  user: WhatsappUser,
  phone: string,
  incomingMessage: string,
): Promise<void> {
  const pending = await getPendingGroupRide(deps.redisClient, user.id);
  if (
    !pending ||
    pending.pickupLat === undefined || pending.pickupLng === undefined ||
    pending.destLat === undefined || pending.destLng === undefined
  ) {
    await clearBookingStage(deps.redisClient, user.id);
    await replyAndLog(deps, phone, incomingMessage,
      'Session expired — type *group ride* to start again.');
    return;
  }

  try {
    const request = await groupRideClient.createMatchRequest({
      userId: user.id,
      pickupLat: pending.pickupLat,
      pickupLng: pending.pickupLng,
      pickupAddress: pending.pickupAddress ?? '',
      destLat: pending.destLat,
      destLng: pending.destLng,
      destAddress: pending.destAddress ?? '',
      plannedDistanceKm: pending.plannedDistanceKm,
      plannedDurationSeconds: pending.plannedDurationSeconds,
      fareEstimateNgn: pending.fareEstimateNgn,
    });

    await storePendingGroupRide(deps.redisClient, user.id, {
      ...pending,
      matchRequestId: request.id,
      faceAttempts: 0,
    });
    await setGroupRequestRider(deps.redisClient, user.id, request.id);

    // Verification is once per person, not once per ride — a rider with a
    // previously verified selfie goes straight into matching.
    const priorVerification = await groupRideClient
      .findLatestStoredFaceVerificationByUser(user.id)
      .catch(() => null);
    if (priorVerification && deps.groupRideFaceStorage) {
      try {
        const stored = await deps.groupRideFaceStorage.copyFrom({
          sourceBucket: priorVerification.bucket,
          sourceObjectKey: priorVerification.objectKey,
          matchRequestId: request.id,
          userId: user.id,
          mimeType: priorVerification.mimeType,
        });
        await groupRideClient.upsertFaceVerificationUpload({
          matchRequestId: request.id,
          userId: user.id,
          bucket: stored.bucket,
          objectKey: stored.objectKey,
          mimeType: stored.mimeType,
          capturedAt: stored.capturedAt,
        });
        const completed = await groupRideClient.completeFaceVerificationAndMarkReady({
          matchRequestId: request.id,
          sizeBytes: priorVerification.sizeBytes ?? undefined,
          capturedAt: stored.capturedAt,
        });
        await deps.publisher.publishGroupRideEvent(buildReadyForMatchEvent(completed.request));

        await clearPendingGroupRide(deps.redisClient, user.id);
        await clearBookingStage(deps.redisClient, user.id);

        await replyAndLog(deps, phone, incomingMessage, [
          `You're already verified — no selfie needed this time.`,
          ``,
          `*Matching in progress!* We're finding riders heading your way — you'll get a message here the moment your group is formed.`,
          ``,
          `Reply *group status* to check, or *cancel group* to leave.`,
        ].join('\n'));
        return;
      } catch (error) {
        console.warn('[whatsapp][group-ride] selfie reuse failed — asking for a fresh one', {
          userId: user.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await setBookingStage(deps.redisClient, user.id, 'group_awaiting_face_photo');
    await replyAndLog(deps, phone, incomingMessage, GROUP_SELFIE_PROMPT);
  } catch (error) {
    console.error('[whatsapp][group-ride] createMatchRequest failed', {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
    });
    await replyAndLog(deps, phone, incomingMessage,
      'Could not start your group ride right now. Please try again in a moment.');
  }
}

/** The selfie arrives: guardrail-check it, store it, mark ready for matching. */
async function handleGroupSelfie(
  deps: MetaWhatsappRouteDeps,
  user: WhatsappUser,
  phone: string,
  mediaId: string | undefined,
): Promise<void> {
  const pending = await getPendingGroupRide(deps.redisClient, user.id);
  if (!pending?.matchRequestId) {
    await clearBookingStage(deps.redisClient, user.id);
    await replyAndLog(deps, phone, '[Photo]',
      'Session expired — type *group ride* to start again.');
    return;
  }

  if (!mediaId || !deps.metaAccessToken || !deps.groupRideFaceStorage) {
    console.warn('[whatsapp][group-ride] selfie received but media pipeline unavailable', {
      hasMediaId: Boolean(mediaId),
      hasToken: Boolean(deps.metaAccessToken),
      hasStorage: Boolean(deps.groupRideFaceStorage),
    });
    await replyAndLog(deps, phone, '[Photo]',
      'Could not read that photo. Please try sending it again.');
    return;
  }

  let media;
  try {
    media = await downloadMetaMedia(deps.metaAccessToken, mediaId);
  } catch (error) {
    console.warn('[whatsapp][group-ride] media download failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    await replyAndLog(deps, phone, '[Photo]',
      'Could not read that photo. Please send a clear JPEG or PNG selfie (under 5 MB).');
    return;
  }

  // Guardrail: a real human face, not a pet, meme, or screenshot.
  const groq = createLlm({ groqApiKey: deps.groqApiKey, groqModel: deps.groqModel, timeoutMs: deps.groqTimeoutMs });
  const verdict = await verifySelfiePhoto(groq, media.buffer, media.mimeType);
  if (!verdict.accepted) {
    const attempts = (pending.faceAttempts ?? 0) + 1;
    if (attempts >= MAX_SELFIE_ATTEMPTS) {
      await cancelGroupRide(deps, user, phone, '[Photo]');
      return;
    }
    await storePendingGroupRide(deps.redisClient, user.id, { ...pending, faceAttempts: attempts });
    await replyAndLog(deps, phone, '[Photo]',
      `That doesn't look like a clear selfie of you\n\nPlease send a real photo of *your face* — no pets, cartoons, or screenshots. (${MAX_SELFIE_ATTEMPTS - attempts} tr${MAX_SELFIE_ATTEMPTS - attempts === 1 ? 'y' : 'ies'} left)`);
    return;
  }

  try {
    const stored = await deps.groupRideFaceStorage.uploadBuffer({
      matchRequestId: pending.matchRequestId,
      userId: user.id,
      imageBuffer: media.buffer,
      mimeType: media.mimeType,
    });

    await groupRideClient.upsertFaceVerificationUpload({
      matchRequestId: pending.matchRequestId,
      userId: user.id,
      bucket: stored.bucket,
      objectKey: stored.objectKey,
      mimeType: stored.mimeType,
      capturedAt: stored.capturedAt,
    });

    const completed = await groupRideClient.completeFaceVerificationAndMarkReady({
      matchRequestId: pending.matchRequestId,
      sizeBytes: stored.sizeBytes,
      capturedAt: stored.capturedAt,
    });

    await deps.publisher.publishGroupRideEvent(buildReadyForMatchEvent(completed.request));

    await clearPendingGroupRide(deps.redisClient, user.id);
    await clearBookingStage(deps.redisClient, user.id);

    await replyAndLog(deps, phone, '[Selfie]', [
      `*Selfie verified — you're all set!*`,
      ``,
      `*Matching in progress!* We're finding riders heading your way — you'll get a message here the moment your group is formed.`,
      ``,
      `You won't need a selfie again for future group rides.`,
      ``,
      `Reply *group status* to check, or *cancel group* to leave.`,
    ].join('\n'));
  } catch (error) {
    console.error('[whatsapp][group-ride] face upload failed', {
      userId: user.id,
      matchRequestId: pending.matchRequestId,
      error: error instanceof Error ? error.message : String(error),
    });
    await replyAndLog(deps, phone, '[Photo]',
      'Something went wrong saving your photo. Please send it again.');
  }
}

async function cancelGroupRide(
  deps: MetaWhatsappRouteDeps,
  user: WhatsappUser,
  phone: string,
  incomingMessage: string,
): Promise<void> {
  const pending = await getPendingGroupRide(deps.redisClient, user.id);
  const matchRequestId = pending?.matchRequestId ?? (await getGroupRequestRider(deps.redisClient, user.id));

  let cancelled = false;
  let alreadyBooked = false;
  if (matchRequestId) {
    try {
      const result = await groupRideClient.cancelMatchRequestForUser(matchRequestId, user.id, 'rider_cancelled');
      cancelled = result.count > 0;
      if (cancelled) {
        await deps.publisher.publishGroupRideEvent({
          eventType: 'GROUP_RIDE_MATCH_CANCELLED',
          rideId: matchRequestId,
          riderId: user.id,
          reason: 'rider_cancelled',
          timestamp: new Date().toISOString(),
        });
      } else {
        const current = await groupRideClient.findMatchRequestByIdForUser(matchRequestId, user.id).catch(() => null);
        alreadyBooked = Boolean(current && ['GROUPED', 'BOOKED'].includes(String(current.status)));
      }
    } catch {
      // Already terminal (grouped/expired) — nothing to release.
    }
  }

  if (alreadyBooked) {
    // The group is already a ride with a driver — cancelling that is the
    // normal ride cancellation, with its reasons and any penalty.
    await replyAndLog(deps, phone, incomingMessage,
      'Your group is already booked with a driver, so it can\'t be dropped here. Reply *cancel* to cancel the ride itself.');
    return;
  }

  await clearPendingGroupRide(deps.redisClient, user.id);
  await clearGroupRequestRider(deps.redisClient, user.id);
  await clearBookingStage(deps.redisClient, user.id);
  await replyAndLog(deps, phone, incomingMessage, cancelled
    ? 'Group ride cancelled. Type *group ride* whenever you want to start another, or book a normal ride any time.'
    : 'No group ride to cancel. Type *group ride* to start one, or book a normal ride any time.');
}

/**
 * "normal" reply to the wait-nudge: stop the group search and rebook the
 * same trip as a standard ride, landing the rider at the familiar
 * quote → offer → bids flow.
 */
async function convertGroupToNormalRide(
  deps: MetaWhatsappRouteDeps,
  user: WhatsappUser,
  phone: string,
  incomingMessage: string,
  matchRequestId: string,
): Promise<void> {
  const request = await groupRideClient.findMatchRequestByIdForUser(matchRequestId, user.id).catch(() => null);
  if (!request || !['READY_FOR_MATCH', 'MATCHING', 'PENDING_FACE_UPLOAD'].includes(request.status)) {
    await replyAndLog(deps, phone, incomingMessage,
      'No waiting group ride found. Type *group ride* to start one, or share a pin for a normal ride');
    return;
  }

  try {
    await groupRideClient.cancelMatchRequestForUser(matchRequestId, user.id, 'converted_to_normal_ride');
    await deps.publisher.publishGroupRideEvent({
      eventType: 'GROUP_RIDE_MATCH_CANCELLED',
      rideId: matchRequestId,
      riderId: user.id,
      reason: 'converted_to_normal_ride',
      timestamp: new Date().toISOString(),
    });
  } catch {
    // already terminal — converting is still fine
  }
  await clearGroupRequestRider(deps.redisClient, user.id);
  await clearPendingGroupRide(deps.redisClient, user.id);

  const pickup = { lat: request.pickupLat, lng: request.pickupLng, address: request.pickupAddress };
  const destination = { lat: request.destLat, lng: request.destLng, address: request.destAddress };

  const plannedRoute = await planRouteSafe(deps, pickup, destination);
  if (!plannedRoute) {
    await replyAndLog(deps, phone, incomingMessage, ROUTE_PLAN_FAILED_REPLY);
    return;
  }

  const distanceKm = plannedRoute.distanceKm;
  const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
  const suggestedFare = plannedRoute.suggestedFareNgn;
  const minFare = plannedRoute.minOfferNgn;

  await storePendingRoute(deps.redisClient, user.id, {
    pickupLat: pickup.lat, pickupLng: pickup.lng, pickupAddress: pickup.address,
    destLat: destination.lat, destLng: destination.lng, destAddress: destination.address,
    distanceKm, durationSeconds: plannedRoute.durationSeconds,
    suggestedFareNgn: suggestedFare, minOfferNgn: minFare,
    ratePerKmNgn: plannedRoute.ratePerKmNgn, route: plannedRoute.geometry,
  });
  await setBookingStage(deps.redisClient, user.id, 'awaiting_price');

  await quoteAndLog(deps, user, phone, incomingMessage, [
    `*Switched to a normal ride.*`,
    ``,
    `Pickup: *${pickup.address}*`,
    `Destination: *${destination.address}*`,
    `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
    `Minimum fare: ₦${minFare.toLocaleString()}`,
    `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
    ``,
    `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
  ].join('\n'));
}

async function sendGroupStatus(
  deps: MetaWhatsappRouteDeps,
  user: WhatsappUser,
  phone: string,
  incomingMessage: string,
): Promise<void> {
  const pending = await getPendingGroupRide(deps.redisClient, user.id);
  const matchRequestId = pending?.matchRequestId ?? (await getGroupRequestRider(deps.redisClient, user.id));

  if (!matchRequestId) {
    await replyAndLog(deps, phone, incomingMessage,
      'No group ride in progress. Type *group ride* to start one!');
    return;
  }

  const request = await groupRideClient.findMatchRequestByIdForUser(matchRequestId, user.id).catch(() => null);
  if (!request) {
    await clearGroupRequestRider(deps.redisClient, user.id);
    await replyAndLog(deps, phone, incomingMessage,
      'No group ride in progress. Type *group ride* to start one!');
    return;
  }

  const statusLine: Record<string, string> = {
    PENDING_FACE_UPLOAD: 'Waiting for your selfie — send a clear photo of your face.',
    READY_FOR_MATCH: 'Matching in progress — looking for riders heading your way.',
    MATCHING: 'Matching in progress — almost there!',
    GROUPED: 'Group found! Getting your route ready.',
    BOOKED: 'Group booked — finding your driver now.',
    EXPIRED: 'That request expired. Type *group ride* to start a new one.',
    CANCELLED: 'That request was cancelled. Type *group ride* to start a new one.',
  };

  await replyAndLog(deps, phone, incomingMessage, [
    `*Group ride status*`,
    ``,
    `Route: ${request.pickupAddress} → ${request.destAddress}`,
    statusLine[request.status] ?? `Status: ${request.status}`,
  ].join('\n'));
}

/* ─── Main POST webhook handler ─── */

export async function handleMetaWhatsappWebhookRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MetaWhatsappRouteDeps,
): Promise<void> {
  try {
    const rawBody = await readRawBody(req);

    if (!isValidMetaSignature(rawBody, getHeaderValue(req, 'x-hub-signature-256'), deps.metaAppSecret)) {
      sendJson(res, 403, { error: 'Invalid signature' });
      return;
    }

    // Always respond 200 quickly — Meta requires fast acknowledgement
    sendOk(res);

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      console.warn('[whatsapp] Invalid JSON in Meta webhook');
      return;
    }

    // Meta sends status updates (delivered, read) — those yield no messages.
    for (const msgInfo of extractMetaMessages(parsed)) {
      await handleIncomingMetaMessage(deps, msgInfo);
    }
  } catch (error) {
    console.error('[whatsapp] webhook handling failed', error);
  }
}

async function handleIncomingMetaMessage(
  deps: MetaWhatsappRouteDeps,
  msgInfo: MetaMessageInfo,
): Promise<void> {
  let dedupKey: string | null = null;
  try {
    // ── Dedup: Meta retries webhooks. SET NX is atomic, so two deliveries
    // of the same wamid in the same instant cannot both run. Released on a
    // thrown error below so the retry gets a real attempt.
    if (msgInfo.messageId) {
      dedupKey = `whatsapp:dedup:${msgInfo.messageId}`;
      const fresh = await deps.redisClient.setIfNotExists(dedupKey, '1', 300).catch(() => true);
      if (!fresh) return;
    }

    const { phone, profileName, messageBody: incomingMessage, isLocation, locationLat, locationLng } = msgInfo;

    // Blue-tick the message and show "typing…" while we think.
    sendTypingIndicator(deps, msgInfo.messageId);

    const user = await onboardWhatsappUser({
      phone,
      profileName,
      deps: {
        jwtSecret: deps.jwtSecret,
        publisher: deps.publisher,
        paymentsClient: deps.paymentsClient,
      },
    });

    // Store phone lookup for Kafka consumer notifications
    await setPhoneLookup(deps.redisClient, user.id, phone).catch(() => {});

    const activeRideId = await getActiveRide(deps.redisClient, user.id);
    const bookingStage = await getBookingStage(deps.redisClient, user.id);

    // Durable per-user record of every WhatsApp interaction — the Redis
    // conversation store caps at 10 messages and expires in 7 days.
    logActivity({
      userId: user.id,
      eventType: 'whatsapp_message_in',
      source: 'whatsapp',
      metadata: {
        isLocation,
        isImage: msgInfo.isImage ?? false,
        stage: bookingStage,
        hasActiveRide: Boolean(activeRideId),
        preview: incomingMessage.slice(0, 160),
      },
    });

    // ── SOS. Before consent, before any booking step, before anything. ────
    if (msgInfo.replyId && RIDE_CARD_REPLIES.has(msgInfo.replyId)) {
      await handleRideCardTap(deps, user.id, phone, msgInfo.replyId);
      return;
    }

    // ── Quick actions: the menu, history, repeat / reverse ───────────────
    if (isQuickActionId(msgInfo.replyId)) {
      await handleQuickAction(deps, user, phone, msgInfo.replyId!, incomingMessage, activeRideId);
      return;
    }

    // "menu" at any point. Mid-search or mid-trip it offers "your current trip"
    // in place of Book; a picker that is waiting for a number is not it.
    if (!isLocation && asksForMenu(incomingMessage) && !(await getPendingGeoChoices(deps.redisClient, user.id))) {
      await sendQuickActions(deps, user, phone, activeRideId, incomingMessage);
      return;
    }

    // A number typed at the text fallback of the menu or the history list
    // (WhatsApp refused the picker): the same tap, by other means.
    if (!isLocation && /^[1-9]$/.test(incomingMessage.trim())) {
      const choices = await getPendingGeoChoices(deps.redisClient, user.id);
      if (choices?.context === 'menu' || choices?.context === 'history') {
        const pick = choices.options[Number(incomingMessage.trim()) - 1];
        await clearPendingGeoChoices(deps.redisClient, user.id);
        if (pick) {
          const id = choices.context === 'history' ? `qa_hist:${pick.address}` : MENU_TITLE_TO_ID[pick.address] ?? QUICK_ACTION_IDS.book;
          await handleQuickAction(deps, user, phone, id, incomingMessage, activeRideId);
          return;
        }
      }
    }

    // ── A tap on an offers message ───────────────────────────────────────
    // Old messages stay tappable forever. One from a search that is over must
    // say so — not fall through to the model as the words "Accept ₦2,800".
    const tappedOffer = parseOfferReplyId(msgInfo.replyId);
    if (!activeRideId && (tappedOffer || msgInfo.replyId === CHANGE_PRICE_REPLY_ID)) {
      await clearPendingAccept(deps.redisClient, user.id);
      await replyAndLog(deps, phone, incomingMessage,
        'That search has ended — nothing was charged. Send your trip again, or reply *search again* for the same route.');
      return;
    }
    // They said "cancel", then took an offer instead of giving a reason: the tap wins.
    if (tappedOffer && bookingStage === 'awaiting_cancel_reason') await clearBookingStage(deps.redisClient, user.id);

    // ── A tap on the trip card or its Edit sheet ─────────────────────────
    if (msgInfo.replyId?.startsWith('trip_')) {
      await handleTripTap(deps, user, phone, incomingMessage, msgInfo.replyId, Boolean(activeRideId));
      return;
    }

    // ── "None of these" on a place picker ─────────────────────────────────
    if (!isLocation && incomingMessage.trim().toLowerCase() === NONE_OF_THESE.toLowerCase()) {
      const offered = await getPendingGeoChoices(deps.redisClient, user.id);
      if (offered) {
        await clearPendingGeoChoices(deps.redisClient, user.id);
        const field = offered.context === 'pickup' || offered.context === 'group_pickup' ? 'pickup' : offered.context === 'stop' ? 'stop' : 'destination';
        await replyAndLog(deps, phone, incomingMessage,
          `No problem. Type the ${field} again with the area or a nearby landmark — e.g. *"Admiralty Way, Lekki Phase 1"* — or share a location pin`);
        return;
      }
    }

    // ── Privacy consent comes first ───────────────────────────────────────
    // Two things never wait for it: a live trip (never interrupt one), and
    // FREEZE — someone locking a stolen phone's wallet must not meet a form.
    if (!activeRideId && !/^freeze$/i.test(incomingMessage.trim())) {
      if (await requirePrivacyConsent(deps, user, phone, msgInfo)) return;
    }

    // ── Booking opener → the tappable FLOW form (meta-flows) ──────────────
    // A bare greeting ("hi", "hi wassup", "book a ride abeg") with no active
    // ride gets the Book Ride button. This runs BEFORE the booking-stage
    // machine on purpose: a stale "awaiting pickup" stage from an abandoned
    // conversation used to swallow greetings forever. Greeting with no live
    // ride = fresh start — clear the stale stage and offer the form.
    // A greeting while a flow-booked ride is live re-sends the offers button
    // — the booking form would only dead-end on 'you have a ride in progress'.
    if (
      META_FLOWS_ENABLED &&
      deps.whatsappOffersFlowId &&
      deps.metaAccessToken &&
      deps.metaPhoneNumberId &&
      activeRideId &&
      isBookingOpener(incomingMessage)
    ) {
      const flowMeta = await getRideMeta(deps.redisClient, activeRideId);
      if (flowMeta?.source === 'flow') {
        const flowBids = await getBids(deps.redisClient, activeRideId);
        await sendFlowOffersMessage(
          {
            metaAccessToken: deps.metaAccessToken,
            metaPhoneNumberId: deps.metaPhoneNumberId,
            offersFlowId: deps.whatsappOffersFlowId,
            flowTokenSecret: deps.jwtSecret,
          },
          phone,
          user.id,
          flowMeta,
          flowBids,
        ).catch((err) => console.warn('[whatsapp] offers re-entry failed', err));
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: '[sent offers button]' },
        ]);
        return;
      }
    }

    if (META_FLOWS_ENABLED && deps.whatsappFlowId && !activeRideId && isBookingOpener(incomingMessage)) {
      const flowToken = signFlowToken(`new:${user.id}`, deps.jwtSecret);
      const sent = await sendMetaFlowMessage(deps, phone, flowToken);
      console.info('[whatsapp] booking opener', {
        message: incomingMessage.slice(0, 40),
        staleStage: bookingStage ?? null,
        sent,
      });
      if (sent) {
        if (bookingStage) await clearBookingStage(deps.redisClient, user.id).catch(() => {});
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: '[sent booking form]' },
        ]);
        return;
      }
      // Send failed — the conversation continues exactly as before.
    }

    // ── Cancellation reason — collect this before clearing the booking ──
    if (bookingStage === 'awaiting_cancel_reason' && !tappedOffer) {
      const reason = parseCancellationReason(incomingMessage);

      if (!reason) {
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage || '[Shared location pin]' },
          { role: 'assistant', content: CANCELLATION_REASON_PROMPT },
        ]);
        await sendMetaReply(deps, phone, CANCELLATION_REASON_PROMPT);
        return;
      }

      if (activeRideId) {
        const cancelledRide = await rideClient.findById(activeRideId).catch(() => null);
        const cancelEvent = RideCancelledEvent.parse({
          eventType: 'RIDE_CANCELLED',
          rideId: activeRideId,
          riderId: user.id,
          driverId: cancelledRide?.driverId ?? undefined,
          cancelledBy: 'rider',
          reason,
          timestamp: new Date().toISOString(),
        });
        await deps.publisher.publishRideEvent(cancelEvent);
        await clearActiveRide(deps.redisClient, user.id);
        await cleanupRideKeys(deps.redisClient, activeRideId);
        await clearPendingAccept(deps.redisClient, user.id);
      }

      await clearBookingStage(deps.redisClient, user.id);
      await clearPendingRoute(deps.redisClient, user.id);
      await clearPendingLocation(deps.redisClient, user.id);

      const reply = [
        activeRideId ? 'Ride cancelled.' : 'Booking cancelled.',
        `Reason: ${reason}`,
        '',
        'Any fare held for this ride will be returned to your wallet.',
      ].join('\n');
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    // ── Group ride: selfie images and stage dispatch ─────────────────────
    if (msgInfo.isImage) {
      if (bookingStage === 'group_awaiting_face_photo') {
        await handleGroupSelfie(deps, user, phone, msgInfo.imageMediaId);
      } else {
        await sendMetaReply(deps, phone,
          'Photos are only used for group-ride selfie verification right now. Type *group ride* to start one!');
      }
      return;
    }

    if (!isLocation && isGroupStatusCommand(incomingMessage)) {
      await sendGroupStatus(deps, user, phone, incomingMessage);
      return;
    }

    if (!isLocation && isGroupCancelCommand(incomingMessage)) {
      await cancelGroupRide(deps, user, phone, incomingMessage);
      return;
    }

    // "wait" / "normal" — answers to the pool wait-nudge. Only intercepted
    // when the rider actually has an open group request; otherwise these
    // words fall through to normal handling.
    if (!isLocation && /^(wait|keep waiting)\b/i.test(incomingMessage.trim())) {
      const matchRequestId = await getGroupRequestRider(deps.redisClient, user.id).catch(() => null);
      if (matchRequestId) {
        const request = await groupRideClient.findMatchRequestByIdForUser(matchRequestId, user.id).catch(() => null);
        if (request && ['READY_FOR_MATCH', 'MATCHING'].includes(request.status) && request.faceVerification) {
          await deps.publisher.publishGroupRideEvent(buildReadyForMatchEvent(request)).catch(() => {});
          await deps.redisClient.del(`whatsapp:group:${request.id}:wait_nudge`).catch(() => {});
          await replyAndLog(deps, phone, incomingMessage,
            `Still looking for co-riders — I'll check in again if nothing turns up.`);
          return;
        }
      }
    }

    if (!isLocation && /^normal(\s*ride)?$/i.test(incomingMessage.trim())) {
      const matchRequestId = await getGroupRequestRider(deps.redisClient, user.id).catch(() => null);
      if (matchRequestId) {
        await convertGroupToNormalRide(deps, user, phone, incomingMessage, matchRequestId);
        return;
      }
    }

    // A bare "group ride" typed mid-booking must start the group flow — the
    // stage handlers below would otherwise geocode it as an address. Longer
    // phrasings ("group ride from Yaba to Lekki") fall through to the intent
    // parser, which extracts the locations as prefills.
    if (
      !isLocation &&
      !activeRideId &&
      /^(?:i\s+(?:wanna|want\s+to)\s+)?(?:book\s+(?:a\s+)?)?(?:group|shared)\s*ride[\s!.]*$/i.test(incomingMessage.trim())
    ) {
      await startGroupRideFlow(deps, user, phone, incomingMessage);
      return;
    }

    if (
      !isLocation &&
      (bookingStage === 'group_awaiting_pickup' ||
        bookingStage === 'group_awaiting_destination' ||
        bookingStage === 'group_awaiting_confirm' ||
        bookingStage === 'group_awaiting_face_photo')
    ) {
      await handleGroupStageText(deps, user, phone, incomingMessage, bookingStage);
      return;
    }

    // ── "FREEZE" — the reply we ask for when a PIN reset was not them ─────
    if (/^freeze$/i.test(incomingMessage.trim()) && !isLocation) {
      // Far future: only support lifts it (admin → unfreeze withdrawals).
      await walletSecurityClient.freezeWithdrawals(user.id, new Date('2099-12-31T00:00:00Z'), 'user_freeze');
      logActivity({ userId: user.id, eventType: 'withdrawals_frozen_by_user', source: 'whatsapp', metadata: {} });
      await sendWhatsappText(deps, phone, incomingMessage,
        'Withdrawals are now locked on your account. Nothing can leave your wallet.\n\nDeposits and rides still work. Contact Wheelers support to unlock it once your phone is safe.');
      return;
    }

    // ── Wallet: the MODEL reads the intent; the page does the work ────────
    // No accepted-phrases list. Whatever the rider typed, in whatever
    // wording, the model says deposit / withdraw / neither — at any point in
    // the conversation, mid-booking or mid-ride included. The cheap guard in
    // front only spares a model call for an address or a bare number.
    if (
      !isLocation &&
      !msgInfo.isImage &&
      !isWithdrawalStatusCommand(incomingMessage) &&
      !isCancelCommand(incomingMessage) &&
      mightConcernMoney(incomingMessage)
    ) {
      const walletIntent = await classifyWalletIntent(
        createLlm({ groqApiKey: deps.groqApiKey, groqModel: deps.groqModel, timeoutMs: deps.groqTimeoutMs }, 'intent'),
        incomingMessage,
        await getWhatsappConversation(deps.redisClient, phone).catch(() => []),
      );
      if (walletIntent !== 'none') {
        await clearPendingWhatsappWithdrawal(deps.redisClient, user.id).catch(() => {});
        if (isWithdrawalStage(bookingStage)) await clearBookingStage(deps.redisClient, user.id);
        await sendWalletPageButton(deps, user, phone, incomingMessage, walletIntent);
        return;
      }
    }

    if (isWithdrawalStatusCommand(incomingMessage) && !isLocation) {
      const latest = (await withdrawalClient.listByUser(user.id, 1).catch(() => []))[0];
      if (!latest) {
        await sendWhatsappText(deps, phone, incomingMessage, 'You have no withdrawal requests yet. Reply *withdraw* to start one.');
        return;
      }

      const accountLast4 = latest.bankAccountNumber.slice(-4);
      const failure = latest.failureReason ? `\nReason: ${latest.failureReason}` : '';
      const reply = [
        `Withdrawal: ₦${Number(latest.requestedAmountNgn).toLocaleString()}`,
        `Status: *${latest.status}*`,
        `Bank account: ••••${accountLast4}`,
        `Requested: ${latest.createdAt.toLocaleString()}`,
        failure,
      ].filter(Boolean).join('\n');
      await sendWhatsappText(deps, phone, incomingMessage, `${reply}\n\nReply *withdraw status* to check again.`);
      return;
    }

    if (isWithdrawalStage(bookingStage) && !activeRideId) {
      // Left over from the old in-chat withdrawal. Bank details are no longer
      // taken in chat — clear the stale stage and hand over the page.
      await clearPendingWhatsappWithdrawal(deps.redisClient, user.id).catch(() => {});
      await clearBookingStage(deps.redisClient, user.id);
      await sendWalletPageButton(deps, user, phone, incomingMessage, 'withdraw');
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // 1. ACTIVE RIDE — handle accept/counter/more/cancel commands
    // ══════════════════════════════════════════════════════════════════════

    if (activeRideId && !isLocation && bookingStage !== 'editing_pickup' && bookingStage !== 'editing_destination') {
      // ── Ride already confirmed/in progress — only allow cancel ──
      const rideState = await getRideState(deps.redisClient, activeRideId).catch(() => null);
      const confirmedStates = ['confirmed', 'in_progress', 'driver_assigned'];
      if (rideState && confirmedStates.includes(rideState)) {
        if (isCancelCommand(incomingMessage)) {
          await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
          await sendMetaReply(deps, phone, CANCELLATION_REASON_PROMPT);
          return;
        }
        const accepted = await getAcceptedBid(deps.redisClient, activeRideId).catch(() => null);
        const driverName = accepted?.driverName ?? 'your driver';
        const reply = rideState === 'in_progress'
          ? `Your ride with *${driverName}* is in progress. Sit tight!\n\nReply *cancel* if you need to cancel.`
          : `*${driverName}* is on the way to you.\n\nReply *cancel* if you need to cancel.`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // ── Tapped an offer: that is the whole decision ──
      if (tappedOffer) {
        await acceptOfferInChat(deps, user, phone, incomingMessage, activeRideId, tappedOffer.key, tappedOffer.shownPriceNgn);
        return;
      }
      if (msgInfo.replyId === CHANGE_PRICE_REPLY_ID) {
        const url = ridePageUrl(deps, user.id);
        const meta = await getRideMeta(deps.redisClient, activeRideId);
        const reply = `Your price is ₦${(meta?.offerNgn ?? 0).toLocaleString()}. Type a new one here (e.g. *${(Math.ceil(((meta?.offerNgn ?? 0) * 1.1) / 100) * 100).toLocaleString()}*)${url ? ' — or tap below to set it' : ''}. Every driver looking at your request sees it.`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        if (url) await sendMetaLinkButton(deps, phone, reply, 'Change my price', url);
        else await sendMetaReply(deps, phone, reply);
        return;
      }

      // ── Edit pickup / destination during active ride ──
      if (isEditPickupCommand(incomingMessage) || isEditDestinationCommand(incomingMessage)) {
        const isPickup = isEditPickupCommand(incomingMessage);
        const rideMeta = await getRideMeta(deps.redisClient, activeRideId);

        if (rideMeta && rideMeta.pickupLat && rideMeta.pickupLng && rideMeta.destinationLat && rideMeta.destinationLng) {
          const inlineAddress = extractEditAddress(incomingMessage);

          if (inlineAddress) {
            // Geocode FIRST — don't cancel the ride until we know the address is valid
            const geo = await geocodeAddress(deps.googleMapsApiKey, inlineAddress);
            if (!geo) {
              const label = isPickup ? 'pickup' : 'destination';
              const reply = `${geocodeMissLine(inlineAddress)} Your ride is still active.\n\nTry a more specific ${label} address or share a location pin`;
              await appendWhatsappConversation(deps.redisClient, phone, [
                { role: 'user', content: incomingMessage },
                { role: 'assistant', content: reply },
              ]);
              await sendMetaReply(deps, phone, reply);
              return;
            }

            const pickup = isPickup
              ? { lat: geo.lat, lng: geo.lng, address: geo.formattedAddress }
              : { lat: rideMeta.pickupLat, lng: rideMeta.pickupLng, address: rideMeta.pickupAddress };
            const destination = !isPickup
              ? { lat: geo.lat, lng: geo.lng, address: geo.formattedAddress }
              : { lat: rideMeta.destinationLat, lng: rideMeta.destinationLng, address: rideMeta.destinationAddress };

            // Plan the new route FIRST — don't cancel the ride until we know
            // the new route is drivable
            const plannedRoute = await planRouteSafe(deps, pickup, destination);
            if (!plannedRoute) {
              const reply = `${ROUTE_PLAN_FAILED_REPLY}\n\nYour ride is still active.`;
              await appendWhatsappConversation(deps.redisClient, phone, [
                { role: 'user', content: incomingMessage },
                { role: 'assistant', content: reply },
              ]);
              await sendMetaReply(deps, phone, reply);
              return;
            }

            // Route planned — now cancel the old ride
            const editCancelledRide = await rideClient.findById(activeRideId).catch(() => null);
            const cancelEvent = RideCancelledEvent.parse({
              eventType: 'RIDE_CANCELLED',
              rideId: activeRideId,
              riderId: user.id,
              driverId: editCancelledRide?.driverId ?? undefined,
              cancelledBy: 'rider',
              reason: 'rider_editing_route',
              timestamp: new Date().toISOString(),
            });
            await deps.publisher.publishRideEvent(cancelEvent);
            await clearActiveRide(deps.redisClient, user.id);
            await cleanupRideKeys(deps.redisClient, activeRideId);
            await clearPendingAccept(deps.redisClient, user.id);
            const distanceKm = plannedRoute.distanceKm;
            const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
            const suggestedFare = plannedRoute.suggestedFareNgn;
            const minFare = plannedRoute.minOfferNgn;

            await storePendingRoute(deps.redisClient, user.id, {
              pickupLat: pickup.lat, pickupLng: pickup.lng, pickupAddress: pickup.address,
              destLat: destination.lat, destLng: destination.lng, destAddress: destination.address,
              distanceKm, durationSeconds: plannedRoute.durationSeconds,
              suggestedFareNgn: suggestedFare, minOfferNgn: minFare,
              ratePerKmNgn: plannedRoute.ratePerKmNgn, route: plannedRoute.geometry,
            });
            await setBookingStage(deps.redisClient, user.id, 'awaiting_price');

            const editedLabel = isPickup ? 'Pickup updated!' : 'Destination updated!';
            const reply = [
              `*${editedLabel}*`,
              ``,
              `Pickup: *${pickup.address}*`,
              ``,
              `Destination: *${destination.address}*`,
              ``,
              `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
              `Minimum fare: ₦${minFare.toLocaleString()}`,
              `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
              ``,
              `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
            ].join('\n');

            await appendWhatsappConversation(deps.redisClient, phone, [
              { role: 'user', content: incomingMessage },
              { role: 'assistant', content: reply },
            ]);
            await sendQuoteWithPriceButton(deps, user, phone, reply);
            return;
          }

          // No inline address — don't cancel yet, just switch to editing stage
          // Store route from current ride meta so editing handlers can replan
          await storePendingRoute(deps.redisClient, user.id, {
            pickupLat: rideMeta.pickupLat, pickupLng: rideMeta.pickupLng, pickupAddress: rideMeta.pickupAddress,
            destLat: rideMeta.destinationLat, destLng: rideMeta.destinationLng, destAddress: rideMeta.destinationAddress,
            distanceKm: rideMeta.distanceKm ?? 0, durationSeconds: rideMeta.durationSeconds ?? 0,
            suggestedFareNgn: rideMeta.suggestedFareNgn, minOfferNgn: 0, ratePerKmNgn: 0, route: null,
          });

          const label = isPickup ? 'pickup' : 'destination';
          const current = isPickup ? rideMeta.pickupAddress : rideMeta.destinationAddress;
          await setBookingStage(deps.redisClient, user.id, isPickup ? 'editing_pickup' : 'editing_destination');

          const reply = `Current ${label}: *${current}*\n\nSend a new ${label} location pin or type the address.`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }
      }

      // ── Cancel command ──
      if (isCancelCommand(incomingMessage)) {
        await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
        const reply = CANCELLATION_REASON_PROMPT;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // ── Pay — rider pays to confirm the selected driver ──
      let pendingAccept = await getPendingAccept(deps.redisClient, user.id);
      if (pendingAccept && pendingAccept.rideId !== activeRideId) {
        // Left over from a ride that timed out or was cancelled. Acting on it
        // used to wipe the CURRENT ride's pointer on a stray "yes".
        await clearPendingAccept(deps.redisClient, user.id);
        pendingAccept = null;
      }
      if (pendingAccept && /^(yes|confirm|accept|go|proceed|pay)$/i.test(incomingMessage.trim())) {
        // Same path as a tap: wallet first, driver still there, hold, then confirm.
        await acceptOfferInChat(deps, user, phone, incomingMessage, pendingAccept.rideId,
          pendingAccept.bidId ?? `driver:${pendingAccept.driverId}`, pendingAccept.fareNgn);
        return;
      }

      // ── Accept a driver: "accept 1", "accept 3" (can override pending accept) ──
      const acceptNum = parseAcceptCommand(incomingMessage);
      if (acceptNum !== null) {
        const lastBatch = await getLastBatch(deps.redisClient, activeRideId);

        if (lastBatch.length === 0) {
          const reply = 'No drivers have bid yet. Hold tight — we\'ll notify you when drivers respond!';
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        // A bare "accept" with a single bid on the table is unambiguous — take
        // it rather than making the rider retype it as "accept 1". With several
        // bids there is a real choice to make, so ask instead of guessing;
        // picking for them would commit their money to a fare they didn't choose.
        if (acceptNum.kind === 'unspecified' && lastBatch.length > 1) {
          const options = lastBatch
            .map(
              (bid, index) =>
                `${index + 1}. ${bid.driverName} — ₦${bid.counterOfferNgn} (${Math.ceil(
                  bid.etaSeconds / 60,
                )} min away)`,
            )
            .join('\n');
          const reply = `You have ${lastBatch.length} drivers to choose from:\n\n${options}\n\nJust reply with the number — 1 to ${lastBatch.length}.`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        const bidIndex = acceptNum.kind === 'numbered' ? acceptNum.driverNumber - 1 : 0;
        const selectedBid = lastBatch[bidIndex];

        if (!selectedBid) {
          const reply = `Invalid driver number. Reply with a number from 1 to ${lastBatch.length}.`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        // ── Group seat: this accept books ONE seat, not the whole car ──
        const seatInfo = await getGroupSeat(deps.redisClient, activeRideId);
        if (seatInfo) {
          const seats = await recordAcceptedSeat(deps.redisClient, seatInfo.anchorRideId, {
            memberRideId: activeRideId,
            riderId: user.id,
            driverId: selectedBid.driverId,
            driverUserId: selectedBid.driverUserId,
            driverName: selectedBid.driverName,
            amountNgn: selectedBid.counterOfferNgn,
            etaSeconds: selectedBid.etaSeconds,
          });

          const sameDriverSeats = seats.filter((s) => s.driverId === selectedBid.driverId);
          const allAgreed = sameDriverSeats.length >= seatInfo.memberCount;
          const members = await getGroupSeatMembers(deps.redisClient, seatInfo.anchorRideId);

          if (allAgreed) {
            const totalNgn = sameDriverSeats.reduce((sum, s) => sum + s.amountNgn, 0);
            // CASH, deliberately: a WALLET acceptance makes wallet-service
            // escrow the ENTIRE group total from whichever member accepted
            // last. Until per-seat wallet settlement exists, each rider pays
            // the driver their own seat price directly.
            await deps.publisher.publishRideEvent(RideOfferAcceptedEvent.parse({
              eventType: 'RIDE_OFFER_ACCEPTED',
              rideId: seatInfo.anchorRideId,
              riderId: user.id,
              driverId: selectedBid.driverId,
              driverUserId: selectedBid.driverUserId,
              agreedFareNgn: totalNgn,
              paymentMethod: 'CASH',
              timestamp: new Date().toISOString(),
            }));
            await clearAcceptedSeats(deps.redisClient, seatInfo.anchorRideId);

            // Every member's active ride moves onto the trip itself so trip
            // updates (started, GPS, completed) reach them all.
            for (const member of members) {
              await setActiveRide(deps.redisClient, member.riderId, seatInfo.anchorRideId).catch(() => {});
            }

            await replyAndLog(deps, phone, incomingMessage,
              `Seat booked with *${selectedBid.driverName}* at ₦${selectedBid.counterOfferNgn.toLocaleString()}.\n\nThat was the last seat — your group is confirmed! Driver details coming right up.`);
            return;
          }

          const remaining = seatInfo.memberCount - sameDriverSeats.length;
          await replyAndLog(deps, phone, incomingMessage,
            `Seat booked with *${selectedBid.driverName}* at ₦${selectedBid.counterOfferNgn.toLocaleString()}.\n\n${sameDriverSeats.length}/${seatInfo.memberCount} seats booked with ${selectedBid.driverName} — waiting for ${remaining} co-rider${remaining === 1 ? '' : 's'}.`);

          // Nudge members who haven't booked with THIS driver yet.
          const bookedRiderIds = new Set(sameDriverSeats.map((s) => s.riderId));
          for (const member of members) {
            if (bookedRiderIds.has(member.riderId) || !member.phone) continue;
            await sendMetaReply(deps, member.phone,
              `A co-rider booked their seat with *${selectedBid.driverName}*. If ${selectedBid.driverName} has an offer in your list, reply its number to complete the group — the car moves when every seat is booked with the same driver.`).catch(() => {});
          }
          return;
        }

        // A typed number is a tap by other means: take the offer now.
        await acceptOfferInChat(deps, user, phone, incomingMessage, activeRideId, offerKey(selectedBid), selectedBid.counterOfferNgn);
        return;
      }

      // ── "more" command — show latest bids ──
      if (isMoreCommand(incomingMessage)) {
        const reply = await sendCurrentOffers(deps, phone, activeRideId);
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        return;
      }

      // ── Counter-offer with a price: "1500", "₦2000", "2k" ──
      const counterOffer = parseCounterOffer(incomingMessage);
      if (counterOffer !== null) {
        const meta = await getRideMeta(deps.redisClient, activeRideId);
        if (meta) {
          // The initial offer was validated against the minimum fare; a
          // counter-offer has to clear the same bar or the floor is bypassed
          // by simply typing a lower number once bidding has started.
          const validation = validateRiderOffer(counterOffer, meta.suggestedFareNgn);
          if (!validation.valid) {
            console.warn('[api-gateway][whatsapp] counter-offer rejected below minimum', {
              rideId: activeRideId,
              riderId: user.id,
              offerNgn: counterOffer,
              minOfferNgn: validation.minOfferNgn,
              suggestedFareNgn: meta.suggestedFareNgn,
            });
            const reply = `Your offer ₦${counterOffer.toLocaleString()} is below the minimum fare of ₦${validation.minOfferNgn.toLocaleString()}.\n\nPlease send a higher amount.`;
            await appendWhatsappConversation(deps.redisClient, phone, [
              { role: 'user', content: incomingMessage },
              { role: 'assistant', content: reply },
            ]);
            await sendMetaReply(deps, phone, reply);
            return;
          }

          // Update the rider's offer in Redis
          meta.offerNgn = counterOffer;
          await deps.redisClient.set(
            `whatsapp:ride:${activeRideId}:meta`,
            JSON.stringify(meta),
            900,
          );

          // Publish counter-offer to ride-service so all drivers see the updated price
          await deps.publisher.publishRideEvent({
            eventType: 'RIDE_RIDER_COUNTER_OFFER',
            rideId: activeRideId,
            riderId: meta.riderId,
            counterOfferNgn: counterOffer,
            timestamp: new Date().toISOString(),
          });

          const reply = `Bid updated to ₦${counterOffer.toLocaleString()}. Drivers will see your new offer.`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }
      }

      // ── Chose a driver, still adding money — point back at the one button ──
      if (pendingAccept) {
        const wallet = await walletClient.findByUserId(user.id);
        const balanceNgn = wallet ? Number(wallet.balanceNgn) : 0;
        if (balanceNgn < pendingAccept.fareNgn) {
          const shortNgn = Math.ceil(pendingAccept.fareNgn - balanceNgn);
          const reply = await sendRideTopupButton(deps, user.id, phone, {
            driverName: pendingAccept.driverName, fareNgn: pendingAccept.fareNgn, balanceNgn, shortNgn, sendNgn: depositNeededFor(shortNgn),
          });
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          return;
        }
      }

      // ── Anything else while searching — show what is on the table, to tap ──
      const reply = await sendCurrentOffers(deps, phone, activeRideId);
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // 2. LOCATION PIN — handle pickup and destination location shares
    // ══════════════════════════════════════════════════════════════════════

    if (isLocation && locationLat !== undefined && locationLng !== undefined && !isNaN(locationLat) && !isNaN(locationLng)) {
      // Block location pins during active ride (unless editing)
      if (activeRideId && bookingStage !== 'editing_pickup' && bookingStage !== 'editing_destination') {
        const reply = 'You have an active ride. Reply *edit from* or *edit to* to change your route, or *cancel* to start fresh.';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: '[Shared location pin]' },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      const reverseGeo = await reverseGeocode(deps.googleMapsApiKey, locationLat, locationLng);
      const address = reverseGeo?.formattedAddress ?? `${locationLat.toFixed(4)}, ${locationLng.toFixed(4)}`;

      if (!isPinInsideServiceArea(locationLat, locationLng, reverseGeo)) {
        const reply = `That pin is outside Nigeria (${address}). ${OUTSIDE_SERVICE_AREA_LINE}`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: '[Shared location pin]' },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // ── Group ride pickup/destination pins ──
      if (bookingStage === 'group_awaiting_pickup' || bookingStage === 'group_awaiting_destination') {
        await applyGroupLocation(
          deps, user, phone,
          `[Shared location: ${address}]`,
          bookingStage,
          { lat: locationLat, lng: locationLng, address },
        );
        return;
      }

      // ── Adding a stop via location pin ──
      if (bookingStage === 'adding_stop') {
        const trip = await getPendingRoute(deps.redisClient, user.id);
        if (trip) {
          await addStopToTrip(deps, user, phone, `[Shared location: ${address}]`, trip, address, { lat: locationLat, lng: locationLng, address });
          return;
        }
      }

      // ── Editing pickup/destination via location pin ──
      if (bookingStage === 'editing_pickup' || bookingStage === 'editing_destination') {
        const pendingRoute = await getPendingRoute(deps.redisClient, user.id);
        if (!pendingRoute) {
          await clearBookingStage(deps.redisClient, user.id);
          const label = bookingStage === 'editing_pickup' ? 'edit from' : 'edit to';
          const reply = `That edit timed out. Reply *${label}* again and then share the pin.`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: `[Shared location: ${address}]` },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }
        if (pendingRoute) {
          const pickup = bookingStage === 'editing_pickup'
            ? { lat: locationLat, lng: locationLng, address }
            : { lat: pendingRoute.pickupLat, lng: pendingRoute.pickupLng, address: pendingRoute.pickupAddress };
          const destination = bookingStage === 'editing_destination'
            ? { lat: locationLat, lng: locationLng, address }
            : { lat: pendingRoute.destLat, lng: pendingRoute.destLng, address: pendingRoute.destAddress };

          const plannedRoute = await planRouteSafe(deps, pickup, destination);
          if (!plannedRoute) {
            const reply = `${ROUTE_PLAN_FAILED_REPLY}\n\nYour booking is unchanged — try a different pin.`;
            await appendWhatsappConversation(deps.redisClient, phone, [
              { role: 'user', content: `[Shared location: ${address}]` },
              { role: 'assistant', content: reply },
            ]);
            await sendMetaReply(deps, phone, reply);
            return;
          }
          const distanceKm = plannedRoute.distanceKm;
          const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
          const suggestedFare = plannedRoute.suggestedFareNgn;
          const minFare = plannedRoute.minOfferNgn;

          // If rider had an active ride, cancel it now that the edit succeeded
          if (activeRideId) {
            const editCancelledRide = await rideClient.findById(activeRideId).catch(() => null);
            const cancelEvent = RideCancelledEvent.parse({
              eventType: 'RIDE_CANCELLED',
              rideId: activeRideId,
              riderId: user.id,
              driverId: editCancelledRide?.driverId ?? undefined,
              cancelledBy: 'rider',
              reason: 'rider_editing_route',
              timestamp: new Date().toISOString(),
            });
            await deps.publisher.publishRideEvent(cancelEvent);
            await clearActiveRide(deps.redisClient, user.id);
            await cleanupRideKeys(deps.redisClient, activeRideId);
            await clearPendingAccept(deps.redisClient, user.id);
          }

          await storePendingRoute(deps.redisClient, user.id, {
            pickupLat: pickup.lat,
            pickupLng: pickup.lng,
            pickupAddress: pickup.address,
            destLat: destination.lat,
            destLng: destination.lng,
            destAddress: destination.address,
            distanceKm,
            durationSeconds: plannedRoute.durationSeconds,
            suggestedFareNgn: suggestedFare,
            minOfferNgn: minFare,
            ratePerKmNgn: plannedRoute.ratePerKmNgn,
            route: plannedRoute.geometry,
          });
          await setBookingStage(deps.redisClient, user.id, 'awaiting_price');

          const editedLabel = bookingStage === 'editing_pickup' ? 'Pickup updated!' : 'Destination updated!';
          const reply = [
            `*${editedLabel}*`,
            ``,
            `Pickup: *${pickup.address}*`,
            ``,
            `Destination: *${destination.address}*`,
            ``,
            `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
            `Minimum fare: ₦${minFare.toLocaleString()}`,
            `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
            ``,
            `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
          ].join('\n');

          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: `[Shared location: ${address}]` },
            { role: 'assistant', content: reply },
          ]);
          await sendQuoteWithPriceButton(deps, user, phone, reply);
          return;
        }
      }

      // A pin is the destination only while we are actually waiting for one.
      // Any other time it is a fresh pickup — a stale pickup from an
      // abandoned booking used to turn the next pin into a wrong-way route.
      const storedPickup = await getPendingLocation(deps.redisClient, user.id);
      const pendingPickup = bookingStage === 'awaiting_destination' ? storedPickup : null;

      if (!pendingPickup) {
        if (activeRideId) {
          const reply = 'You have an active ride. Reply *edit from* or *edit to* to change your route, or *cancel* to start fresh.';
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: `[Shared location: ${address}]` },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }
        // ── FIRST location pin = PICKUP ──
        const rememberedDestination = (await getPendingAreaHint(deps.redisClient, user.id).catch(() => null))?.counterpartAddress?.trim();
        await clearPendingAreaHint(deps.redisClient, user.id).catch(() => {});
        await setPendingLocation(deps.redisClient, user.id, {
          lat: locationLat,
          lng: locationLng,
          address,
          savedAt: new Date().toISOString(),
        });
        await setBookingStage(deps.redisClient, user.id, 'awaiting_destination');

        // They already told us where they are going: answer the destination
        // step with it instead of asking again.
        if (rememberedDestination) {
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: `[Shared pickup location: ${address}]` },
            { role: 'assistant', content: `Pickup: ${address}` },
          ]);
          await handleIncomingMetaMessage(deps, { ...msgInfo, messageId: '', isLocation: false, locationLat: undefined, locationLng: undefined, messageBody: rememberedDestination });
          return;
        }

        const reply = `Pickup: *${address}*\n\nNow share your *destination* location pin!`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: `[Shared pickup location: ${address}]` },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // ── SECOND location pin = DESTINATION ──
      // We have pickup, now got destination — go straight to finding drivers
      const pickup = { lat: pendingPickup.lat, lng: pendingPickup.lng, address: pendingPickup.address };
      const destination = { lat: locationLat, lng: locationLng, address };

      // Check for existing active ride
      if (activeRideId) {
        await clearPendingLocation(deps.redisClient, user.id);
        await clearBookingStage(deps.redisClient, user.id);
        const reply = 'You already have an active ride. Say *cancel* first to book a new one.';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: `[Shared destination location: ${address}]` },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // Plan route, store it, and ask rider for their price
      const plannedRoute = await planRouteSafe(deps, pickup, destination);
      if (!plannedRoute) {
        // Keep the pending pickup and stage so the rider can re-share a pin
        const reply = ROUTE_PLAN_FAILED_REPLY;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: `[Shared destination location: ${address}]` },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      await clearPendingLocation(deps.redisClient, user.id);
      await clearBookingStage(deps.redisClient, user.id);
      const distanceKm = plannedRoute.distanceKm;
      const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
      const suggestedFare = plannedRoute.suggestedFareNgn;
      const minFare = plannedRoute.minOfferNgn;

      await storePendingRoute(deps.redisClient, user.id, {
        pickupLat: pickup.lat,
        pickupLng: pickup.lng,
        pickupAddress: pickup.address,
        destLat: destination.lat,
        destLng: destination.lng,
        destAddress: destination.address,
        distanceKm,
        durationSeconds: plannedRoute.durationSeconds,
        suggestedFareNgn: suggestedFare,
        minOfferNgn: minFare,
        ratePerKmNgn: plannedRoute.ratePerKmNgn,
        route: plannedRoute.geometry,
      });
      await setBookingStage(deps.redisClient, user.id, 'awaiting_price');

      const groupSuggestion = await buildGroupSuggestionLine(user.id, pickup, destination);
      const reply = [
        `Pickup: *${pickup.address}*`,
        ``,
        `Destination: *${destination.address}*`,
        ``,
        `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
        `Minimum fare: ₦${minFare.toLocaleString()}`,
        `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
        ``,
        `Negotiate your price and we'll find you a driver!`,
        `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
      ].join('\n') + groupSuggestion;

      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: `[Shared destination location: ${address}]` },
        { role: 'assistant', content: reply },
      ]);
      await sendQuoteWithPriceButton(deps, user, phone, reply);
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // 3. AWAITING DESTINATION — user can type an address or share a pin
    // ══════════════════════════════════════════════════════════════════════

    // ── Answering "whereabouts in <area>?" for the PICKUP ──
    if (bookingStage === 'awaiting_pickup' && !isLocation && incomingMessage.trim()) {
      if (isCancelCommand(incomingMessage)) {
        await clearPendingAreaHint(deps.redisClient, user.id);
        await clearBookingStage(deps.redisClient, user.id);
        const reply = 'No problem — ride cancelled. Message me whenever you need one.';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      if (mightNotBeAnAddress(incomingMessage)) {
        const pickupStepIntent = await classifyBookingIntent(bookingIntentGroq(deps), {
          step: 'pickup',
          message: incomingMessage,
          context: {},
          recentMessages: await getWhatsappConversation(deps.redisClient, phone),
        });
        if (pickupStepIntent.intent === 'cancel') {
          await clearPendingAreaHint(deps.redisClient, user.id);
          await clearBookingStage(deps.redisClient, user.id);
          await clearBookingMisses(deps.redisClient, user.id).catch(() => undefined);
          await replyAndLog(deps, phone, incomingMessage, 'No problem — ride cancelled. Message me whenever you need one.');
          return;
        }
        if (pickupStepIntent.intent === 'restart') {
          await startBookingOver(deps, user, phone, incomingMessage);
          return;
        }
        if (pickupStepIntent.intent === 'help') {
          await replyWithWayOut(deps, user, phone, incomingMessage, {
            wantsHelp: true,
            prompt: 'Where should we pick you up? Type the address or a nearby landmark, or share a location pin',
            hint: 'Or reply *start again* or *cancel*.',
            buttons: ['Start again', 'Cancel ride'],
          });
          return;
        }
      }

      const hint = await getPendingAreaHint(deps.redisClient, user.id);
      const answer = incomingMessage.trim();

      // A tap on the picker (or a typed number) answers "which pickup did you mean?".
      let pickedPickup: { lat: number; lng: number; formattedAddress: string } | null = null;
      if (/^[1-9]$/.test(answer)) {
        const choices = await getPendingGeoChoices(deps.redisClient, user.id);
        const pick = choices?.context === 'pickup' ? choices.options[Number(answer) - 1] : undefined;
        if (pick) {
          await clearPendingGeoChoices(deps.redisClient, user.id);
          pickedPickup = { lat: pick.lat, lng: pick.lng, formattedAddress: pick.address };
        }
      }

      // The question was "whereabouts in X?", so the expected answer is a
      // landmark. Riders often restate the whole trip instead ("I wanna go
      // from Allen"), and geocoding that verbatim asks Google to find a
      // sentence — which it answers with the country. Hand anything that
      // reads like a fresh request back to the intent parser by falling
      // through, rather than treating it as an address.
      if (looksLikeConversation(answer)) {
        await clearPendingAreaHint(deps.redisClient, user.id);
        await clearBookingStage(deps.redisClient, user.id);
        // Deliberately no `return` — execution continues to intent parsing
        // below, which understands this sentence properly.
      } else {

      // "roundabout" on its own geocodes to nothing — it only means something
      // combined with the area they already named. Word order matters more
      // than it looks: measured against Google, "Allen roundabout" resolves to
      // the actual roundabout while "roundabout, Allen" returns ZERO_RESULTS.
      // Area first, then looser fallbacks, then the bare answer in case they
      // typed a full address instead of a landmark.
      const candidates = hint?.area
        ? [`${hint.area} ${answer}`, `${answer}, ${hint.area}`, answer]
        : [answer];

      // A name that exists in several places ("Admiralty" Way AND Road, "Aiyetoro"
      // in Surulere AND Akoka): ask, never assume. Only for a plain answer — when
      // they are answering "whereabouts in Lekki?", the area already narrows it.
      if (!pickedPickup && !hint?.area && !looksLikeConversation(answer)) {
        const matches = await findPlaceOptions(deps.googleMapsApiKey, answer, { spokenText: incomingMessage });
        if (matches.length > 1) {
          await sendPlaceChoices(deps, user, phone, incomingMessage, { context: 'pickup', field: 'pickup', typed: answer, candidates: matches });
          return;
        }
        if (matches.length === 1) pickedPickup = matches[0]!;
      }

      let pickupGeo = pickedPickup;
      for (const candidate of pickedPickup ? [] : candidates) {
        pickupGeo = await geocodeAddress(deps.googleMapsApiKey, candidate);
        if (pickupGeo) break;
      }

      if (!pickupGeo) {
        const missLine = outsideServiceAreaMatch(answer)
          ? geocodeMissLine(answer)
          : `Could not find "${answer}"${hint?.area ? ` in ${hint.area}` : ''} on the map.`;
        await replyWithWayOut(deps, user, phone, incomingMessage, {
          prompt: `${missLine}\n\nTry a nearby landmark or street name, or share a location pin`,
          hint: 'Or reply *start again* or *cancel*.',
          buttons: ['Start again', 'Cancel ride'],
        });
        return;
      }

      await setPendingLocation(deps.redisClient, user.id, {
        lat: pickupGeo.lat,
        lng: pickupGeo.lng,
        address: pickupGeo.formattedAddress,
        savedAt: new Date().toISOString(),
        // The hint is cleared below, so the destination they already gave has
        // to travel with the pickup for "yes" to mean anything next turn.
        suggestedDestination: hint?.counterpartAddress || undefined,
      });
      await clearPendingAreaHint(deps.redisClient, user.id);
      await setBookingStage(deps.redisClient, user.id, 'awaiting_destination');

      // They picked the pickup from a list, and told us the destination in the
      // same breath as the trip. Asking them to type "yes" is one message too
      // many: answer the destination step with what they already said.
      if (pickedPickup && hint?.counterpartAddress) {
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: `Pickup: ${pickupGeo.formattedAddress}` },
        ]);
        await handleIncomingMetaMessage(deps, { ...msgInfo, messageId: '', messageBody: hint.counterpartAddress });
        return;
      }

      // If they already told us where they were going, don't ask again.
      const reply = hint?.counterpartAddress
        ? `Pickup: *${pickupGeo.formattedAddress}*\n\nAnd your destination is *${hint.counterpartAddress}* — type "yes" to confirm, or send a different destination.`
        : `Pickup: *${pickupGeo.formattedAddress}*\n\nWhere are you going? Type the destination or share a pin`;
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
      }
    }

    if (bookingStage === 'awaiting_destination' && !isLocation) {
      if (isCancelCommand(incomingMessage)) {
        await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
        const reply = CANCELLATION_REASON_PROMPT;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // Not every reply here is a destination. Anything that might be more
      // than a place is read for meaning first; a plain place skips the model.
      let destinationStepIntent: BookingIntentResult = { intent: 'answer' };
      if (mightNotBeAnAddress(incomingMessage) && !isAffirmativeReply(incomingMessage)) {
        const soFar = await getPendingLocation(deps.redisClient, user.id);
        destinationStepIntent = await classifyBookingIntent(bookingIntentGroq(deps), {
          step: 'destination',
          message: incomingMessage,
          context: { pickupAddress: soFar?.address },
          recentMessages: await getWhatsappConversation(deps.redisClient, phone),
        });
      }
      if (destinationStepIntent.intent === 'cancel') {
        await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
        await replyAndLog(deps, phone, incomingMessage, CANCELLATION_REASON_PROMPT);
        return;
      }
      if (destinationStepIntent.intent === 'restart') {
        await startBookingOver(deps, user, phone, incomingMessage);
        return;
      }
      if (destinationStepIntent.intent === 'change_pickup') {
        await clearPendingLocation(deps.redisClient, user.id);
        await clearPendingFarPlace(deps.redisClient, user.id).catch(() => undefined);
        await setBookingStage(deps.redisClient, user.id, 'awaiting_pickup');
        if (!destinationStepIntent.address) {
          await replyAndLog(deps, phone, incomingMessage, 'Sure — where should we pick you up instead? Type the address or share a location pin');
          return;
        }
        // They named the new pickup in the same breath: answer the pickup step with it.
        // No message id: this is the same WhatsApp message, already de-duplicated once.
        await handleIncomingMetaMessage(deps, { ...msgInfo, messageId: '', messageBody: destinationStepIntent.address });
        return;
      }
      // 'other' (a question, chatter) carries on below, where small talk is
      // handed to the chatbot as before.
      if (destinationStepIntent.intent === 'help' || destinationStepIntent.intent === 'confirm') {
        await replyWithWayOut(deps, user, phone, incomingMessage, {
          wantsHelp: destinationStepIntent.intent === 'help',
          prompt: 'Where are you going? Type the destination or share a location pin',
          hint: 'Or reply *change pickup*, *start again* or *cancel*.',
          buttons: ['Change pickup', 'Start again', 'Cancel ride'],
        });
        return;
      }

      const pendingPickup = await getPendingLocation(deps.redisClient, user.id);
      if (!pendingPickup) {
        await clearBookingStage(deps.redisClient, user.id);
        const reply = 'Session expired. Type your pickup and destination like:\n\n*"From [pickup] to [destination]"*\n\nOr share a location pin';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // We asked them to type "yes" to confirm the destination they named in
      // their first message. Checked before the small-talk filter because
      // "ok" counts as small talk there, and before geocoding because "Yes"
      // is not a place.
      const isAffirmative = /^(yes|yeah|yea|yep|yup|ok|okay|confirm|correct|sure|y)\b/i.test(incomingMessage.trim());

      // "yes" to "that is 311 km away, in another city — really?"
      const heldFarPlace = await getPendingFarPlace(deps.redisClient, user.id);
      if (heldFarPlace) await clearPendingFarPlace(deps.redisClient, user.id);
      const confirmedFarPlace = isAffirmative && heldFarPlace?.field === 'destination' ? heldFarPlace : null;

      const confirmedDestination = isAffirmative && !confirmedFarPlace ? pendingPickup.suggestedDestination?.trim() : undefined;

      if (isAffirmative && !confirmedDestination && !confirmedFarPlace) {
        const reply = `Where are you going? Type the destination or share a pin`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // Small talk is not a destination. This stage lives for ten minutes, so
      // a rider returning to an abandoned booking with "Hey wassup" had their
      // greeting geocoded. Leave it to the intent parser and the chatbot, and
      // keep the stage so their next real answer still lands here.
      // "going to X" is an answer, not chat, however the sentence starts.
      const strippedDestination = stripDirectionPrefix(incomingMessage);
      const isDirectionAnswer = strippedDestination !== incomingMessage.trim();
      if (!confirmedDestination && !isDirectionAnswer && looksLikeConversation(incomingMessage)) {
        // deliberately no reply and no return — falls through to intent parsing
      } else {

      // Try to geocode the typed destination
      const typedDestination = confirmedDestination ?? strippedDestination;

      // A bare number answers a pending "which one did you mean?" list.
      let destGeo: { lat: number; lng: number; formattedAddress: string } | null = confirmedFarPlace
        ? { lat: confirmedFarPlace.lat, lng: confirmedFarPlace.lng, formattedAddress: confirmedFarPlace.address }
        : null;
      const pickupPoint = { lat: pendingPickup.lat, lng: pendingPickup.lng };
      if (!destGeo && /^[1-9]$/.test(typedDestination)) {
        const choices = await getPendingGeoChoices(deps.redisClient, user.id);
        const pick = choices?.context === 'destination'
          ? choices.options[Number(typedDestination) - 1]
          : undefined;
        if (pick) {
          await clearPendingGeoChoices(deps.redisClient, user.id);
          destGeo = { lat: pick.lat, lng: pick.lng, formattedAddress: pick.address };
        }
      }

      if (!destGeo) {
        // "Whereabouts in Lekki?" → "the mall": search inside the area first.
        const destHint = await getPendingAreaHint(deps.redisClient, user.id).catch(() => null);
        const areaHint = destHint?.kind === 'destination' ? destHint.area?.trim() : undefined;
        const narrowed = areaHint && !typedDestination.toLowerCase().includes(areaHint.toLowerCase())
          ? `${typedDestination}, ${areaHint}`
          : typedDestination;
        // Lean the search towards the pickup: "7 Osaro Isokpan" from Akoka is
        // the one in Lagos, not the better-known street of that name in Benin.
        let candidates = await findPlaceOptions(deps.googleMapsApiKey, narrowed, { near: pickupPoint, spokenText: incomingMessage });
        if (candidates.length === 0 && narrowed !== typedDestination) {
          candidates = await findPlaceOptions(deps.googleMapsApiKey, typedDestination, { near: pickupPoint, spokenText: incomingMessage });
        }

        // Ambiguous place ("Aiyetoro" is in Surulere AND Akoka) — ask, don't
        // assume. A query that pins the area returns a single candidate.
        if (candidates.length > 1) {
          await sendPlaceChoices(deps, user, phone, incomingMessage, {
            context: 'destination',
            field: 'destination',
            typed: typedDestination,
            candidates,
          });
          return;
        }

        destGeo = candidates[0] ?? null;
      }

      if (!destGeo) {
        await replyWithWayOut(deps, user, phone, incomingMessage, {
          prompt: `${geocodeMissLine(typedDestination)}\n\nPlease type a more specific destination — add the area or a landmark — or share a location pin`,
          hint: 'Or reply *change pickup*, *start again* or *cancel*.',
          buttons: ['Change pickup', 'Start again', 'Cancel ride'],
        });
        return;
      }

      // Destination geocoded — plan route
      const pickup = { lat: pendingPickup.lat, lng: pendingPickup.lng, address: pendingPickup.address };
      const destination = { lat: destGeo.lat, lng: destGeo.lng, address: destGeo.formattedAddress };

      // Still in another city after leaning towards the pickup? Ask before quoting.
      if (!confirmedFarPlace && await askIfFarPlaceIsMeant(deps, user, phone, incomingMessage, 'destination', destination, pickupPoint)) {
        return;
      }
      await clearBookingMisses(deps.redisClient, user.id).catch(() => undefined);

      const plannedRoute = await planRouteSafe(deps, pickup, destination);
      if (!plannedRoute) {
        // Keep the stage and pending pickup so their next answer still lands here
        const reply = ROUTE_PLAN_FAILED_REPLY;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      await clearPendingLocation(deps.redisClient, user.id);
      await clearPendingAreaHint(deps.redisClient, user.id).catch(() => {});
      await clearPendingGeoChoices(deps.redisClient, user.id).catch(() => {});
      await clearBookingStage(deps.redisClient, user.id);
      const distanceKm = plannedRoute.distanceKm;
      const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
      const suggestedFare = plannedRoute.suggestedFareNgn;
      const minFare = plannedRoute.minOfferNgn;

      await storePendingRoute(deps.redisClient, user.id, {
        pickupLat: pickup.lat,
        pickupLng: pickup.lng,
        pickupAddress: pickup.address,
        destLat: destination.lat,
        destLng: destination.lng,
        destAddress: destination.address,
        distanceKm,
        durationSeconds: plannedRoute.durationSeconds,
        suggestedFareNgn: suggestedFare,
        minOfferNgn: minFare,
        ratePerKmNgn: plannedRoute.ratePerKmNgn,
        route: plannedRoute.geometry,
      });
      await setBookingStage(deps.redisClient, user.id, 'awaiting_price');

      const groupSuggestion = await buildGroupSuggestionLine(user.id, pickup, destination);
      const reply = [
        `Pickup: *${pickup.address}*`,
        ``,
        `Destination: *${destination.address}*`,
        ``,
        `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
        `Minimum fare: ₦${minFare.toLocaleString()}`,
        `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
        ``,
        `Negotiate your price and we'll find you a driver!`,
        `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
      ].join('\n') + groupSuggestion;

      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendQuoteWithPriceButton(deps, user, phone, reply);
      return;
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // 3b. EDITING PICKUP / DESTINATION — user types an address
    // ══════════════════════════════════════════════════════════════════════

    if ((bookingStage === 'editing_pickup' || bookingStage === 'editing_destination') && !isLocation) {
      // Cancel during editing — clear everything
      if (isCancelCommand(incomingMessage)) {
        await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
        const reply = CANCELLATION_REASON_PROMPT;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      const pendingRoute = await getPendingRoute(deps.redisClient, user.id);
      if (!pendingRoute) {
        await clearBookingStage(deps.redisClient, user.id);
        const reply = 'Session expired. Share a location pin to start a new booking';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      const editField = bookingStage === 'editing_pickup' ? 'pickup' : 'destination';

      const pickedForEdit = await takePickedPlace(deps, user.id, incomingMessage, ['edit_pickup', 'edit_destination']);
      if (pickedForEdit) {
        await replanPendingRoute(deps, user, phone, incomingMessage, pendingRoute, editField, pickedForEdit.address, pickedForEdit);
        return;
      }

      // "yes" to a far-away place we held back, or a fresh address.
      const heldEditPlace = await getPendingFarPlace(deps.redisClient, user.id);
      if (heldEditPlace) await clearPendingFarPlace(deps.redisClient, user.id);
      if (heldEditPlace && heldEditPlace.field === editField && isAffirmativeReply(incomingMessage)) {
        await replanPendingRoute(deps, user, phone, incomingMessage, pendingRoute, editField, heldEditPlace.address, { ...heldEditPlace, farConfirmed: true });
        return;
      }

      // They may have changed their mind about editing at all.
      if (mightNotBeAnAddress(incomingMessage)) {
        const editIntent = await classifyBookingIntent(bookingIntentGroq(deps), {
          step: editField,
          message: incomingMessage,
          context: { pickupAddress: pendingRoute.pickupAddress, destinationAddress: pendingRoute.destAddress },
          recentMessages: await getWhatsappConversation(deps.redisClient, phone),
        });
        if (editIntent.intent === 'cancel') {
          await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
          await replyAndLog(deps, phone, incomingMessage, CANCELLATION_REASON_PROMPT);
          return;
        }
        if (editIntent.intent === 'restart') {
          await startBookingOver(deps, user, phone, incomingMessage);
          return;
        }
        if (editIntent.intent === 'help' || editIntent.intent === 'confirm') {
          // "ok leave it" / "never mind the change": back to the quote as it was.
          await setBookingStage(deps.redisClient, user.id, 'awaiting_price');
          await replyAndLog(deps, phone, incomingMessage,
            `No change made. Your trip is still:\n\nPickup: *${pendingRoute.pickupAddress}*\nDestination: *${pendingRoute.destAddress}*\n\nSend your price (suggested ₦${pendingRoute.suggestedFareNgn.toLocaleString()}), or reply *change pickup*, *change destination* or *cancel*.`);
          return;
        }
      }

      await replanPendingRoute(deps, user, phone, incomingMessage, pendingRoute, editField, stripDirectionPrefix(incomingMessage));
      return;
    }

    if (bookingStage === 'awaiting_route_confirmation' && !isLocation) {
      const pendingRoute = await getPendingRoute(deps.redisClient, user.id);
      const answer = incomingMessage.trim();

      if (isCancelCommand(answer)) {
        await clearPendingRoute(deps.redisClient, user.id);
        await clearBookingStage(deps.redisClient, user.id);
        const reply = 'No problem — nothing booked. Message me when you need a ride.';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      if (!pendingRoute || pendingRoute.offerNgn === undefined) {
        await clearBookingStage(deps.redisClient, user.id);
        const reply = 'That took too long — send your pickup and destination again and we\'ll re-check the price.';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      const confirmed = /^(?:y|ya|yes|yeah|yep|ok|okay|correct|right|sure|go|confirm(?:ed)?|book(?:\s+it)?)(?:\s+(?:please|book(?:\s+it)?|go|proceed|confirm|now|abeg))?[\s!.]*$/i.test(answer);

      if (!confirmed) {
        // A new price is the correction we invited — apply it and re-confirm.
        const newOffer = parseCounterOffer(answer);
        if (newOffer !== null) {
          if (newOffer < pendingRoute.minOfferNgn) {
            const reply = `₦${newOffer.toLocaleString()} is below the minimum fare of ₦${pendingRoute.minOfferNgn.toLocaleString()} for this trip. Send a higher amount, or *yes* to book at ₦${pendingRoute.offerNgn.toLocaleString()}.`;
            await appendWhatsappConversation(deps.redisClient, phone, [
              { role: 'user', content: incomingMessage },
              { role: 'assistant', content: reply },
            ]);
            await sendMetaReply(deps, phone, reply);
            return;
          }
          await storePendingRoute(deps.redisClient, user.id, { ...pendingRoute, offerNgn: newOffer });
          await setBookingStage(deps.redisClient, user.id, 'awaiting_route_confirmation');
          const reply = [
            `Offer updated to ₦${newOffer.toLocaleString()}`,
            ``,
            `Pickup: *${pendingRoute.pickupAddress}*`,
            `Destination: *${pendingRoute.destAddress}*`,
            ``,
            `Reply *yes* to find drivers, or *edit pickup <address>* / *edit destination <address>* to fix the route.`,
          ].join('\n');
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        // Anything else is an address correction. The price handler knows
        // "edit pickup <address>" / "edit destination <address>"; a bare
        // address is applied as the destination directly.
        await setBookingStage(deps.redisClient, user.id, 'awaiting_price');
        if (!isEditPickupCommand(answer) && !isEditDestinationCommand(answer) && answer.length >= 3) {
          const geo = await geocodeAddress(deps.googleMapsApiKey, answer);
          if (geo) {
            const pickup = { lat: pendingRoute.pickupLat, lng: pendingRoute.pickupLng, address: pendingRoute.pickupAddress };
            const destination = { lat: geo.lat, lng: geo.lng, address: geo.formattedAddress };
            const replanned = await planRouteSafe(deps, pickup, destination);
            if (replanned) {
              await storePendingRoute(deps.redisClient, user.id, {
                pickupLat: pickup.lat,
                pickupLng: pickup.lng,
                pickupAddress: pickup.address,
                destLat: destination.lat,
                destLng: destination.lng,
                destAddress: destination.address,
                distanceKm: replanned.distanceKm,
                durationSeconds: replanned.durationSeconds,
                suggestedFareNgn: replanned.suggestedFareNgn,
                minOfferNgn: replanned.minOfferNgn,
                ratePerKmNgn: replanned.ratePerKmNgn,
                route: replanned.geometry,
              });
              const reply = [
                `Destination updated`,
                ``,
                `Pickup: *${pickup.address}*`,
                `Destination: *${destination.address}*`,
                `${replanned.distanceKm.toFixed(1)} km · ~${Math.ceil(replanned.durationSeconds / 60)} min`,
                `Minimum fare: ₦${replanned.minOfferNgn.toLocaleString()}`,
                `Suggested fare: ₦${replanned.suggestedFareNgn.toLocaleString()}`,
                ``,
                `Send your offer, or *edit pickup <address>* if the pickup is wrong.`,
              ].join('\n');
              await appendWhatsappConversation(deps.redisClient, phone, [
                { role: 'user', content: incomingMessage },
                { role: 'assistant', content: reply },
              ]);
              await sendMetaReply(deps, phone, reply);
              return;
            }
          }
        }
        const reply = [
          `Got it — nothing booked yet.`,
          ``,
          `Send a *price* to search with, or "edit pickup <address>" / "edit destination <address>" to fix the route.`,
        ].join('\n');
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      const pickup = {
        lat: pendingRoute.pickupLat,
        lng: pendingRoute.pickupLng,
        address: pendingRoute.pickupAddress,
      };
      const destination = {
        lat: pendingRoute.destLat,
        lng: pendingRoute.destLng,
        address: pendingRoute.destAddress,
      };
      const offerNgn = pendingRoute.offerNgn;

      // Two quick "yes"es (different wamids) must not book twice.
      const publishClaim = await deps.redisClient.setIfNotExists(`whatsapp:user:${user.id}:publishing`, '1', 30).catch(() => true);
      if (!publishClaim) return;

      const rideId = randomUUID();
      const event = RideRequestedEvent.parse({
        eventType: 'RIDE_REQUESTED',
        rideId,
        riderId: user.id,
        pickup,
        destination,
        stops: pendingRoute.stops ?? [],
        plannedDistanceKm: pendingRoute.distanceKm,
        plannedDurationSeconds: pendingRoute.durationSeconds,
        fareEstimateNgn: pendingRoute.suggestedFareNgn,
        paymentMethod: 'WALLET',
        riderOfferNgn: offerNgn,
        suggestedFareNgn: pendingRoute.suggestedFareNgn,
        minOfferNgn: pendingRoute.minOfferNgn,
        ratePerKmNgn: pendingRoute.ratePerKmNgn,
        route: pendingRoute.route,
        timestamp: new Date().toISOString(),
      });

      try {
        await deps.publisher.publishRideEvent(event);
      } catch (publishError) {
        console.error('[api-gateway][whatsapp] ride publish FAILED — quote kept', {
          rideId,
          riderId: user.id,
          error: publishError instanceof Error ? publishError.message : String(publishError),
        });
        await deps.redisClient.del(`whatsapp:user:${user.id}:publishing`).catch(() => {});
        const reply = 'Could not start the search just now. Reply *yes* to try again.';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }
      await clearPendingRoute(deps.redisClient, user.id);

      await storeWhatsappRide(deps.redisClient, rideId, {
        riderId: user.id,
        phone,
        pickupAddress: pickup.address,
        pickupLat: pickup.lat,
        pickupLng: pickup.lng,
        destinationAddress: destination.address,
        destinationLat: destination.lat,
        destinationLng: destination.lng,
        distanceKm: pendingRoute.distanceKm,
        durationSeconds: pendingRoute.durationSeconds,
        offerNgn,
        suggestedFareNgn: pendingRoute.suggestedFareNgn,
        paymentMethod: 'WALLET',
        createdAt: new Date().toISOString(),
      });
      await setActiveRide(deps.redisClient, user.id, rideId);
      await setBookingStage(deps.redisClient, user.id, 'searching');
      await storeLastRoute(deps.redisClient, user.id, {
        pickupLat: pendingRoute.pickupLat,
        pickupLng: pendingRoute.pickupLng,
        pickupAddress: pendingRoute.pickupAddress,
        destLat: pendingRoute.destLat,
        destLng: pendingRoute.destLng,
        destAddress: pendingRoute.destAddress,
        distanceKm: pendingRoute.distanceKm,
        durationSeconds: pendingRoute.durationSeconds,
        suggestedFareNgn: pendingRoute.suggestedFareNgn,
        minOfferNgn: pendingRoute.minOfferNgn,
        ratePerKmNgn: pendingRoute.ratePerKmNgn,
        route: pendingRoute.route,
        offerNgn,
      });

      const reply = [
        `*Finding you a driver!*`,
        ``,
        `Pickup: *${pickup.address}*`,
        `Destination: *${destination.address}*`,
        `${pendingRoute.distanceKm.toFixed(1)} km · ~${Math.ceil(pendingRoute.durationSeconds / 60)} min`,
        `Your offer: ₦${offerNgn.toLocaleString()}`,
        ``,
        `We'll send you all available drivers!`,
      ].join('\n');

      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // "WHERE IS THE STOP?" — a typed place, a tapped match, or "back"
    // ══════════════════════════════════════════════════════════════════════
    if (bookingStage === 'adding_stop' && !isLocation) {
      const trip = await getPendingRoute(deps.redisClient, user.id);
      if (!trip) {
        await clearBookingStage(deps.redisClient, user.id);
        await replyAndLog(deps, phone, incomingMessage, `That trip has expired.\n\n${BOOKING_START_PROMPT}`);
        return;
      }
      if (/^(back|no|nothing|never\s*mind|nevermind|leave it|cancel)[\s!.]*$/i.test(incomingMessage.trim())) {
        await clearPendingGeoChoices(deps.redisClient, user.id).catch(() => undefined);
        const said = await sendTripConfirmation(deps, user, phone, trip, 'No stop added — here is your trip');
        await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: incomingMessage }, { role: 'assistant', content: said }]);
        return;
      }
      const pickedStop = await takePickedPlace(deps, user.id, incomingMessage, ['stop']);
      if (pickedStop) {
        await addStopToTrip(deps, user, phone, incomingMessage, trip, pickedStop.address, pickedStop);
        return;
      }
      await addStopToTrip(deps, user, phone, incomingMessage, trip, stripDirectionPrefix(incomingMessage));
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // "IS THIS YOUR TRIP?" — before any price. Taps are handled above by id;
    // this is for what they TYPE: yes, a price, or what to change.
    // ══════════════════════════════════════════════════════════════════════
    if (bookingStage === 'awaiting_trip_confirm' && !isLocation) {
      const trip = await getPendingRoute(deps.redisClient, user.id);
      if (!trip) {
        await clearBookingStage(deps.redisClient, user.id);
        await replyAndLog(deps, phone, incomingMessage, `That trip has expired.\n\n${BOOKING_START_PROMPT}`);
        return;
      }

      if (isCancelCommand(incomingMessage)) {
        await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
        await replyAndLog(deps, phone, incomingMessage, CANCELLATION_REASON_PROMPT);
        return;
      }

      // A tap on "which one did you mean?" after a typed change.
      const picked = await takePickedPlace(deps, user.id, incomingMessage, ['edit_pickup', 'edit_destination', 'stop']);
      if (picked) {
        if (picked.context === 'stop') await addStopToTrip(deps, user, phone, incomingMessage, trip, picked.address, picked);
        else await replanPendingRoute(deps, user, phone, incomingMessage, trip, picked.context === 'edit_pickup' ? 'pickup' : 'destination', picked.address, picked);
        return;
      }

      // A place in another city is waiting on a yes/no.
      const farPlace = await getPendingFarPlace(deps.redisClient, user.id);
      if (farPlace) {
        await clearPendingFarPlace(deps.redisClient, user.id);
        if (isAffirmativeReply(incomingMessage)) {
          await replanPendingRoute(deps, user, phone, incomingMessage, trip, farPlace.field, farPlace.address, { ...farPlace, farConfirmed: true });
          return;
        }
      }

      if (isEditPickupCommand(incomingMessage) || isEditDestinationCommand(incomingMessage)) {
        const field = isEditPickupCommand(incomingMessage) ? 'pickup' : 'destination';
        const inlineAddress = extractEditAddress(incomingMessage);
        if (inlineAddress) await replanPendingRoute(deps, user, phone, incomingMessage, trip, field, inlineAddress);
        else await askForNewEnd(deps, user, phone, incomingMessage, trip, field);
        return;
      }
      if (/^edit(\s+(my\s+)?trip)?[\s!.]*$/i.test(incomingMessage.trim())) {
        if (await sendEditTripForm(deps, user.id, phone, false)) {
          await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: incomingMessage }, { role: 'assistant', content: '[sent the Edit trip form]' }]);
          return;
        }
        const said = await sendTripEditMenu(deps, phone, trip);
        await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: incomingMessage }, { role: 'assistant', content: said }]);
        return;
      }
      const removeTyped = /^remove\s+stop\s*(\d)?[\s!.]*$/i.exec(incomingMessage.trim());
      if (removeTyped) {
        await removeStopFromTrip(deps, user, phone, incomingMessage, trip, removeTyped[1] ? Number(removeTyped[1]) : undefined);
        return;
      }

      // They skipped ahead and named a price: the trip on screen is the trip
      // they are pricing. Confirm it and let the price step read the number.
      if (parseCounterOffer(incomingMessage) !== null) {
        await storePendingRoute(deps.redisClient, user.id, { ...trip, confirmed: true });
        await setBookingStage(deps.redisClient, user.id, 'awaiting_price');
        await handleIncomingMetaMessage(deps, { ...msgInfo, messageId: '', replyId: undefined });
        return;
      }
      if (isAffirmativeReply(incomingMessage)) {
        await confirmTripAndQuote(deps, user, phone, incomingMessage, trip);
        return;
      }

      const wanted = await classifyBookingIntent(bookingIntentGroq(deps), {
        step: 'confirm',
        message: incomingMessage,
        context: { pickupAddress: trip.pickupAddress, destinationAddress: trip.destAddress, stopAddresses: (trip.stops ?? []).map((stop) => stop.address) },
        recentMessages: await getWhatsappConversation(deps.redisClient, phone),
      });

      if (wanted.intent === 'confirm') {
        await confirmTripAndQuote(deps, user, phone, incomingMessage, trip);
        return;
      }
      if (wanted.intent === 'change_pickup' || wanted.intent === 'change_destination') {
        const field = wanted.intent === 'change_pickup' ? 'pickup' : 'destination';
        if (wanted.address) await replanPendingRoute(deps, user, phone, incomingMessage, trip, field, wanted.address);
        else await askForNewEnd(deps, user, phone, incomingMessage, trip, field);
        return;
      }
      if (wanted.intent === 'add_stop') {
        // They named it → add it right here. They did not → the form is the shortest way to say where.
        if (wanted.address) await addStopToTrip(deps, user, phone, incomingMessage, trip, wanted.address);
        else if (await sendEditTripForm(deps, user.id, phone, true)) {
          await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: incomingMessage }, { role: 'assistant', content: '[sent the Edit trip form]' }]);
        } else await askForStop(deps, user, phone, incomingMessage, trip);
        return;
      }
      if (wanted.intent === 'remove_stop') {
        await removeStopFromTrip(deps, user, phone, incomingMessage, trip);
        return;
      }
      if (wanted.intent === 'cancel') {
        await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
        await replyAndLog(deps, phone, incomingMessage, CANCELLATION_REASON_PROMPT);
        return;
      }
      if (wanted.intent === 'restart') {
        await startBookingOver(deps, user, phone, incomingMessage);
        return;
      }

      // Anything else: the trip again, with the three things they can do.
      const said = await sendTripConfirmation(deps, user, phone, trip,
        wanted.intent === 'help' ? 'No wahala — this is the trip I have for you' : 'I did not catch that — this is the trip I have for you');
      await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: incomingMessage }, { role: 'assistant', content: said }]);
      return;
    }

    if (bookingStage === 'awaiting_price' && !isLocation) {
      const pendingRoute = await getPendingRoute(deps.redisClient, user.id);
      if (pendingRoute) {
        // ── "group" — switch this quote into the group-ride flow ──
        if (/^group(\s*ride)?$/i.test(incomingMessage.trim())) {
          await clearPendingRoute(deps.redisClient, user.id);
          await startGroupRideFlow(deps, user, phone, incomingMessage, {
            pickup: {
              lat: pendingRoute.pickupLat,
              lng: pendingRoute.pickupLng,
              address: pendingRoute.pickupAddress,
            },
            destination: {
              lat: pendingRoute.destLat,
              lng: pendingRoute.destLng,
              address: pendingRoute.destAddress,
            },
          });
          return;
        }

        // ── Direct edit commands: "edit pickup" / "edit destination" ──
        if (isEditPickupCommand(incomingMessage) || isEditDestinationCommand(incomingMessage)) {
          const isPickup = isEditPickupCommand(incomingMessage);
          const inlineAddress = extractEditAddress(incomingMessage);

          if (inlineAddress) {
            await replanPendingRoute(deps, user, phone, incomingMessage, pendingRoute, isPickup ? 'pickup' : 'destination', inlineAddress);
            return;
          }

          // No inline address — ask for it
          const label = isPickup ? 'pickup' : 'destination';
          const current = isPickup ? pendingRoute.pickupAddress : pendingRoute.destAddress;
          await setBookingStage(deps.redisClient, user.id, isPickup ? 'editing_pickup' : 'editing_destination');
          const reply = `Current ${label}: *${current}*\n\nSend a new ${label} location pin or type the address.`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        // ── Cancel during awaiting_price ──
        if (isCancelCommand(incomingMessage)) {
          await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
          const reply = CANCELLATION_REASON_PROMPT;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        // A tap on "which one did you mean?" for a corrected address.
        const pickedEdit = await takePickedPlace(deps, user.id, incomingMessage, ['edit_pickup', 'edit_destination']);
        if (pickedEdit) {
          await replanPendingRoute(deps, user, phone, incomingMessage, pendingRoute,
            pickedEdit.context === 'edit_pickup' ? 'pickup' : 'destination', pickedEdit.address, pickedEdit);
          return;
        }

        // A place in another city is waiting on a yes/no.
        const farPlace = await getPendingFarPlace(deps.redisClient, user.id);
        if (farPlace) {
          await clearPendingFarPlace(deps.redisClient, user.id);
          if (isAffirmativeReply(incomingMessage)) {
            await replanPendingRoute(deps, user, phone, incomingMessage, pendingRoute, farPlace.field, farPlace.address, { ...farPlace, farConfirmed: true });
            return;
          }
          // Anything else is read normally below — usually the corrected address.
        }

        const offerNgn = parseCounterOffer(incomingMessage);

        if (offerNgn === null) {
          // Not a price. Rather than insist on one, find out what they DO want.
          const wanted = await classifyBookingIntent(bookingIntentGroq(deps), {
            step: 'price',
            message: incomingMessage,
            context: { pickupAddress: pendingRoute.pickupAddress, destinationAddress: pendingRoute.destAddress },
            recentMessages: await getWhatsappConversation(deps.redisClient, phone),
          });

          if (wanted.intent === 'change_pickup' || wanted.intent === 'change_destination') {
            const field = wanted.intent === 'change_pickup' ? 'pickup' : 'destination';
            await clearBookingMisses(deps.redisClient, user.id);
            if (wanted.address) {
              await replanPendingRoute(deps, user, phone, incomingMessage, pendingRoute, field, wanted.address);
              return;
            }
            const current = field === 'pickup' ? pendingRoute.pickupAddress : pendingRoute.destAddress;
            await setBookingStage(deps.redisClient, user.id, field === 'pickup' ? 'editing_pickup' : 'editing_destination');
            await replyAndLog(deps, phone, incomingMessage,
              `Current ${field}: *${current}*\n\nSend the new ${field} — type the address or share a location pin`);
            return;
          }

          if (wanted.intent === 'add_stop') {
            await clearBookingMisses(deps.redisClient, user.id);
            if (wanted.address) await addStopToTrip(deps, user, phone, incomingMessage, pendingRoute, wanted.address);
            else await askForStop(deps, user, phone, incomingMessage, pendingRoute);
            return;
          }
          if (wanted.intent === 'remove_stop') {
            await clearBookingMisses(deps.redisClient, user.id);
            await removeStopFromTrip(deps, user, phone, incomingMessage, pendingRoute);
            return;
          }

          if (wanted.intent === 'cancel') {
            await clearBookingMisses(deps.redisClient, user.id);
            await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
            await replyAndLog(deps, phone, incomingMessage, CANCELLATION_REASON_PROMPT);
            return;
          }

          if (wanted.intent === 'restart') {
            await startBookingOver(deps, user, phone, incomingMessage);
            return;
          }

          const pricePrompt = `Minimum: ₦${pendingRoute.minOfferNgn.toLocaleString()}\nSuggested: ₦${pendingRoute.suggestedFareNgn.toLocaleString()}`;

          if (wanted.intent === 'confirm') {
            // Never turn a bare "ok" into a fare — they name the number.
            await replyAndLog(deps, phone, incomingMessage,
              `Almost there — just tell me your price.\n\n${pricePrompt}\n\nSend *${pendingRoute.suggestedFareNgn.toLocaleString()}* to go with the suggested fare, or name your own.`);
            return;
          }

          if (wanted.intent === 'answer') {
            // The model heard a price we could not read as a number ("two
            // thousand five hundred"). We do not guess amounts.
            await replyAndLog(deps, phone, incomingMessage,
              `I couldn't read that as an amount — please send it in figures, like *${pendingRoute.suggestedFareNgn.toLocaleString()}*.\n\n${pricePrompt}`);
            return;
          }

          await replyWithWayOut(deps, user, phone, incomingMessage, {
            wantsHelp: wanted.intent === 'help',
            prompt: `Please send a price for your ride.\n\n${pricePrompt}\n\nExample: *${pendingRoute.suggestedFareNgn.toLocaleString()}*`,
            hint: 'Or reply *change pickup*, *change destination* or *cancel*.',
            buttons: ['Change pickup', 'Change destination', 'Cancel ride'],
          });
          return;
        }

        await clearBookingMisses(deps.redisClient, user.id);

        if (offerNgn < pendingRoute.minOfferNgn) {
          const reply = `Your offer ₦${offerNgn.toLocaleString()} is below the minimum fare of ₦${pendingRoute.minOfferNgn.toLocaleString()}.\n\nPlease send a higher amount.`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        // Publish ride — payment happens when rider accepts a driver. The same
        // step the bidding page takes when they name the price there.
        const published = await publishWhatsappRide(deps, { id: user.id, phone }, pendingRoute, offerNgn);
        if (!published.ok) {
          if (published.code === 'ALREADY_PUBLISHING') return;
          const reply = published.code === 'BELOW_MINIMUM'
            ? `Your offer ₦${offerNgn.toLocaleString()} is below the minimum fare of ₦${published.minOfferNgn.toLocaleString()}.\n\nPlease send a higher amount.`
            : 'Could not start the search just now. Send your price again to retry.';
          await replyAndLog(deps, phone, incomingMessage, reply);
          return;
        }

        const searchText = await sendSearchStarted(deps, user, phone, {
          pickupAddress: pendingRoute.pickupAddress,
          destAddress: pendingRoute.destAddress,
          stopAddresses: (pendingRoute.stops ?? []).map((stop) => stop.address),
          offerNgn,
        });
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: searchText },
        ]);
        return;
      } else {
        // The quote expired (10 minutes) but the stage lingered — the price
        // used to fall through to the chatbot, which answered "3000" as chat.
        await clearBookingStage(deps.redisClient, user.id);
        const reply = 'That quote expired — send your pickup and destination again and we\'ll re-check the price.';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // 5. CANCEL RIDE (via LLM intent or direct text, no active ride)
    // ══════════════════════════════════════════════════════════════════════

    if (isCancelCommand(incomingMessage)) {
      // Clear any pending state
      await clearPendingLocation(deps.redisClient, user.id);
      await clearBookingStage(deps.redisClient, user.id);
      await clearPendingRoute(deps.redisClient, user.id);

      const reply = 'Nothing to cancel. Share your location to book a ride!';
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // 6. NO ACTIVE RIDE, NO PENDING STATE — AI conversation / ride intent
    // ══════════════════════════════════════════════════════════════════════

    // ── "menu", or a bare "hi" with nothing going on: the quick actions ──
    if (isBookingOpener(incomingMessage)) {
      await sendQuickActions(deps, user, phone, null, incomingMessage, true);
      return;
    }

    // ── "Search again" is a VERB, not a vibe. Handled BEFORE the intent
    // parser: fed "keep searching", the LLM re-read the old route out of
    // the chat history as a brand-new request and asked the rider to
    // confirm addresses they had already confirmed. Restart the search.
    if (/^\s*(search again|keep searching|try again|retry|find (me )?(a )?driver)\b/i.test(incomingMessage)) {
      const lastRoute = await getLastRoute(deps.redisClient, user.id);
      if (!lastRoute) {
        const reply = 'Tell me the route first — like *"From 102 Opebi Rd to Yaba"* — and I\'ll find you a driver.';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      const rideId = randomUUID();
      const searchEvent = RideRequestedEvent.parse({
        eventType: 'RIDE_REQUESTED',
        rideId,
        riderId: user.id,
        pickup: { lat: lastRoute.pickupLat, lng: lastRoute.pickupLng, address: lastRoute.pickupAddress },
        destination: { lat: lastRoute.destLat, lng: lastRoute.destLng, address: lastRoute.destAddress },
        stops: lastRoute.stops ?? [],
        plannedDistanceKm: lastRoute.distanceKm,
        plannedDurationSeconds: lastRoute.durationSeconds,
        fareEstimateNgn: lastRoute.suggestedFareNgn,
        paymentMethod: 'WALLET',
        riderOfferNgn: lastRoute.offerNgn,
        suggestedFareNgn: lastRoute.suggestedFareNgn,
        minOfferNgn: lastRoute.minOfferNgn,
        ratePerKmNgn: lastRoute.ratePerKmNgn,
        route: lastRoute.route as never,
        timestamp: new Date().toISOString(),
      });
      await deps.publisher.publishRideEvent(searchEvent);

      await storeWhatsappRide(deps.redisClient, rideId, {
        riderId: user.id,
        phone,
        pickupAddress: lastRoute.pickupAddress,
        pickupLat: lastRoute.pickupLat,
        pickupLng: lastRoute.pickupLng,
        destinationAddress: lastRoute.destAddress,
        destinationLat: lastRoute.destLat,
        destinationLng: lastRoute.destLng,
        distanceKm: lastRoute.distanceKm,
        stops: lastRoute.stops,
        durationSeconds: lastRoute.durationSeconds,
        offerNgn: lastRoute.offerNgn,
        suggestedFareNgn: lastRoute.suggestedFareNgn,
        paymentMethod: 'WALLET',
        createdAt: new Date().toISOString(),
      });
      await setActiveRide(deps.redisClient, user.id, rideId);
      await setBookingStage(deps.redisClient, user.id, 'searching');

      const reply = [
        `*Searching again!*`,
        ``,
        `${lastRoute.pickupAddress} → ${lastRoute.destAddress}`,
        `Your offer: ₦${lastRoute.offerNgn.toLocaleString()}`,
        ``,
        `Asking drivers nearby — offers land here as they come. Sending a higher number any time raises your offer.`,
      ].join('\n');
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    const recentMessages = await getWhatsappConversation(deps.redisClient, phone);

    const groq = createLlm({ groqApiKey: deps.groqApiKey, groqModel: deps.groqModel, timeoutMs: deps.groqTimeoutMs });

    // Try to parse ride intent — with what we remember about this rider, so
    // "take me home" and "same place as last time" resolve to real addresses.
    const riderMemory = await loadRiderMemory(user.id).catch(() => null);
    const rideIntent = await parseRideIntent(
      groq,
      incomingMessage,
      riderMemory?.transcript?.length ? riderMemory.transcript : recentMessages,
      riderMemory ? renderRiderMemoryForIntent(riderMemory) : undefined,
    );

    if (rideIntent && (rideIntent.intent === 'ride_request' || rideIntent.intent === 'group_ride_request') && rideIntent.outsideNigeria) {
      const place = rideIntent.destination?.address || rideIntent.pickup?.address || 'that place';
      const reply = `${place} is outside Nigeria. ${OUTSIDE_SERVICE_AREA_LINE}\n\nAnywhere in Nigeria I can take you?`;
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    if (rideIntent && rideIntent.intent !== 'other') {
      // Learn from booking messages too — the general-chat path does its own.
      rememberExchange(groq, user.id, incomingMessage, null);
    }

    // ── Money, caught by the general parser too (no guard in front of this one) ──
    if (rideIntent?.intent === 'deposit' || rideIntent?.intent === 'withdraw') {
      await sendWalletPageButton(deps, user, phone, incomingMessage, rideIntent.intent);
      return;
    }

    // ── Edit pickup/destination with no pending route → tell user to start fresh ──
    if (rideIntent?.intent === 'edit_pickup' || rideIntent?.intent === 'edit_destination') {
      const reply = 'No ride in progress to edit. Start a new ride by typing:\n\n*"From [pickup] to [destination]"*\n\nOr share a location pin';
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    if (rideIntent?.intent === 'group_ride_request') {
      const pickupGeo = rideIntent.pickup?.specific && rideIntent.pickup.address.trim()
        ? await geocodeAddress(deps.googleMapsApiKey, rideIntent.pickup.address, { spokenText: incomingMessage })
        : null;
      const destGeo = rideIntent.destination?.specific && rideIntent.destination.address.trim()
        ? await geocodeAddress(deps.googleMapsApiKey, rideIntent.destination.address, { spokenText: incomingMessage })
        : null;

      await startGroupRideFlow(deps, user, phone, incomingMessage, {
        ...(pickupGeo
          ? { pickup: { lat: pickupGeo.lat, lng: pickupGeo.lng, address: pickupGeo.formattedAddress } }
          : {}),
        ...(destGeo
          ? { destination: { lat: destGeo.lat, lng: destGeo.lng, address: destGeo.formattedAddress } }
          : {}),
      });
      return;
    }

    if (rideIntent?.intent === 'ride_request') {
      const hasPickup = rideIntent.pickup?.specific && rideIntent.pickup.address.trim();
      const hasDestination = rideIntent.destination?.specific && rideIntent.destination.address.trim();

      // ── Both pickup & destination typed → geocode both and plan route ──
      if (hasPickup && hasDestination) {
        // Pickup first, so the destination can be searched for NEAR it. Looked
        // up side by side, "osaro isokpan" had no idea the trip started in Lagos.
        const pickupOptions = await findPlaceOptions(deps.googleMapsApiKey, rideIntent.pickup!.address, { spokenText: incomingMessage });
        if (pickupOptions.length > 1) {
          // Several pickups by that name. Ask — and remember where they are
          // going, so choosing one carries straight on to the destination.
          await setPendingAreaHint(deps.redisClient, user.id, {
            kind: 'pickup',
            area: '',
            counterpartAddress: rideIntent.destination!.address.trim(),
          });
          await setBookingStage(deps.redisClient, user.id, 'awaiting_pickup');
          await sendPlaceChoices(deps, user, phone, incomingMessage, {
            context: 'pickup', field: 'pickup', typed: rideIntent.pickup!.address, candidates: pickupOptions,
          });
          return;
        }
        const pickupGeo = pickupOptions[0] ?? null;

        const destOptions = pickupGeo
          ? await findPlaceOptions(deps.googleMapsApiKey, rideIntent.destination!.address, {
              spokenText: incomingMessage,
              near: { lat: pickupGeo.lat, lng: pickupGeo.lng },
            })
          : [];
        if (pickupGeo && destOptions.length > 1) {
          // "Caleb University" is a main campus, a College of Law, an admissions
          // office… The pickup is settled; the destination step takes the tap.
          await setPendingLocation(deps.redisClient, user.id, {
            lat: pickupGeo.lat, lng: pickupGeo.lng, address: pickupGeo.formattedAddress, savedAt: new Date().toISOString(),
          });
          await setBookingStage(deps.redisClient, user.id, 'awaiting_destination');
          await sendPlaceChoices(deps, user, phone, incomingMessage, {
            context: 'destination', field: 'destination', typed: rideIntent.destination!.address, candidates: destOptions,
            intro: `Pickup: *${pickupGeo.formattedAddress}*`,
          });
          return;
        }
        const destGeo = destOptions[0] ?? null;

        if (!pickupGeo) {
          const reply = `${geocodeMissLine(rideIntent.pickup!.address)}\n\nPlease try a more specific pickup address, or share a location pin`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        if (!destGeo) {
          // Pickup worked — save it and ask for destination again
          await setPendingLocation(deps.redisClient, user.id, {
            lat: pickupGeo.lat,
            lng: pickupGeo.lng,
            address: pickupGeo.formattedAddress,
            savedAt: new Date().toISOString(),
          });
          await setBookingStage(deps.redisClient, user.id, 'awaiting_destination');

          const reply = `Pickup: *${pickupGeo.formattedAddress}*\n\n${geocodeMissLine(rideIntent.destination!.address)}\n\nPlease type a more specific destination or share a destination location pin`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        // Both geocoded — plan route and ask for price. Any pickup pin from an
        // abandoned booking is superseded by what they just typed.
        await clearPendingLocation(deps.redisClient, user.id).catch(() => {});
        const pickup = { lat: pickupGeo.lat, lng: pickupGeo.lng, address: pickupGeo.formattedAddress };
        const destination = { lat: destGeo.lat, lng: destGeo.lng, address: destGeo.formattedAddress };

        // A destination in another city: keep the pickup, and ask before quoting.
        // Their answer ("yes", or the address again with the area) is handled by
        // the destination step.
        if (kmBetween(pickup, destination) > SAME_CITY_KM) {
          await setPendingLocation(deps.redisClient, user.id, { ...pickup, savedAt: new Date().toISOString() });
          await setBookingStage(deps.redisClient, user.id, 'awaiting_destination');
          await askIfFarPlaceIsMeant(deps, user, phone, incomingMessage, 'destination', destination, pickup);
          return;
        }

        const plannedRoute = await planRouteSafe(deps, pickup, destination);
        if (!plannedRoute) {
          const reply = ROUTE_PLAN_FAILED_REPLY;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }
        const distanceKm = plannedRoute.distanceKm;
        const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
        const suggestedFare = plannedRoute.suggestedFareNgn;
        const minFare = plannedRoute.minOfferNgn;

        await storePendingRoute(deps.redisClient, user.id, {
          pickupLat: pickup.lat,
          pickupLng: pickup.lng,
          pickupAddress: pickup.address,
          destLat: destination.lat,
          destLng: destination.lng,
          destAddress: destination.address,
          distanceKm,
          durationSeconds: plannedRoute.durationSeconds,
          suggestedFareNgn: suggestedFare,
          minOfferNgn: minFare,
          ratePerKmNgn: plannedRoute.ratePerKmNgn,
          route: plannedRoute.geometry,
        });

        // A rider who named a price used to be booked instantly — which meant
        // the ONE place the resolved addresses are shown was skipped entirely.
        // Geocoding can quietly land somewhere else ("15 Aiyetoro St, Ikeja"
        // resolves into Surulere), so the rider never saw where they were
        // actually being sent. Show it and take one "yes" first.
        if (rideIntent.offerNgn && rideIntent.offerNgn >= minFare) {
          await storePendingRoute(deps.redisClient, user.id, {
            pickupLat: pickup.lat,
            pickupLng: pickup.lng,
            pickupAddress: pickup.address,
            destLat: destination.lat,
            destLng: destination.lng,
            destAddress: destination.address,
            distanceKm,
            durationSeconds: plannedRoute.durationSeconds,
            suggestedFareNgn: suggestedFare,
            minOfferNgn: minFare,
            ratePerKmNgn: plannedRoute.ratePerKmNgn,
            route: plannedRoute.geometry,
            offerNgn: rideIntent.offerNgn,
          });
          await setBookingStage(deps.redisClient, user.id, 'awaiting_route_confirmation');

          const reply = [
            `Please check this is right`,
            ``,
            `Pickup: *${pickup.address}*`,
            `Destination: *${destination.address}*`,
            `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
            `Your offer: ₦${rideIntent.offerNgn.toLocaleString()}`,
            ``,
            `Reply *yes* to find a driver.`,
            `Wrong spot? Send the correct destination address, or *edit pickup <address>*. Different price? Just send the number.`,
          ].join('\n');

          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }


        await setBookingStage(deps.redisClient, user.id, 'awaiting_price');

        const groupSuggestion = await buildGroupSuggestionLine(user.id, pickup, destination);
        const reply = [
          `Pickup: *${pickup.address}*`,
          ``,
          `Destination: *${destination.address}*`,
          ``,
          `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
          `Minimum fare: ₦${minFare.toLocaleString()}`,
          `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
          ``,
          `Negotiate your price and we'll find you a driver!`,
          `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
        ].join('\n') + groupSuggestion;

        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendQuoteWithPriceButton(deps, user, phone, reply);
        return;
      }

      // ── Pickup typed, destination missing or only an area ("… to Lekki") ──
      if (hasPickup) {
        const destinationAreaText = rideIntent.destination?.address?.trim() || undefined;
        const destinationArea = rideIntent.destination?.area?.trim() || destinationAreaText;

        const pickupMatches = await findPlaceOptions(deps.googleMapsApiKey, rideIntent.pickup!.address, { spokenText: incomingMessage });
        if (pickupMatches.length > 1) {
          await setPendingAreaHint(deps.redisClient, user.id, { kind: 'pickup', area: '', counterpartAddress: destinationAreaText });
          await setBookingStage(deps.redisClient, user.id, 'awaiting_pickup');
          await sendPlaceChoices(deps, user, phone, incomingMessage, {
            context: 'pickup', field: 'pickup', typed: rideIntent.pickup!.address, candidates: pickupMatches,
          });
          return;
        }

        const pickupGeo = pickupMatches[0];
        if (pickupGeo) {
          await setPendingLocation(deps.redisClient, user.id, {
            lat: pickupGeo.lat,
            lng: pickupGeo.lng,
            address: pickupGeo.formattedAddress,
            savedAt: new Date().toISOString(),
          });
          await setBookingStage(deps.redisClient, user.id, 'awaiting_destination');

          // They named an area to go to ("Lekki"): keep it — a one-word answer
          // resolves against it — and offer its well-known spots to tap.
          if (destinationArea && destinationAreaText) {
            await setPendingAreaHint(deps.redisClient, user.id, {
              kind: 'destination',
              area: destinationAreaText,
              counterpartAddress: rideIntent.pickup!.address.trim(),
            });
            const spots = await findAreaSpots(deps.googleMapsApiKey, destinationArea, pickupGeo).catch(() => []);
            if (spots.length >= 2) {
              await sendPlaceChoices(deps, user, phone, incomingMessage, {
                context: 'destination', field: 'destination', typed: destinationArea, candidates: spots,
                intro: `Pickup: *${pickupGeo.formattedAddress}*`,
                question: `Whereabouts in *${destinationArea}* are you headed?\n\nTap *Choose* for well-known spots — or type a landmark or street, or share a location pin`,
              });
              return;
            }
          }

          const reply = destinationArea
            ? `Pickup: *${pickupGeo.formattedAddress}*\n\nWhereabouts in *${destinationArea}* are you headed? A landmark, street or building works — or share a location pin`
            : `Pickup: *${pickupGeo.formattedAddress}*\n\nNow send your *destination* — type the address or share a location pin`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }
        // The pickup they named will not geocode. Say so — falling through
        // used to ask "whereabouts are you headed?" and then expire.
        const reply = `${geocodeMissLine(rideIntent.pickup!.address)}\n\nTry a nearby landmark or street for the pickup, or share a location pin`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // ── Something was named but it is too broad to geocode ──
      // "I wanna go from Allen" used to land on the generic template below,
      // which threw "Allen" away and made the rider retype everything. Ask
      // about the area they actually said, and remember it so a one-word
      // answer ("roundabout") can be resolved against it.
      const vaguePickup = rideIntent.pickup?.address?.trim();

      if (vaguePickup && !hasPickup) {
        await setPendingAreaHint(deps.redisClient, user.id, {
          kind: 'pickup',
          area: vaguePickup,
          counterpartAddress: hasDestination
            ? rideIntent.destination!.address.trim()
            : undefined,
        });
        await setBookingStage(deps.redisClient, user.id, 'awaiting_pickup');

        const areaName = rideIntent.pickup?.area?.trim() || vaguePickup;

        // "Ikorodu" is a town, not a pickup. Offer the spots riders actually
        // name there; typing a landmark or sharing a pin still works.
        const pickupSpots = await findAreaSpots(deps.googleMapsApiKey, areaName).catch(() => []);
        if (pickupSpots.length >= 2) {
          await sendPlaceChoices(deps, user, phone, incomingMessage, {
            context: 'pickup', field: 'pickup', typed: areaName, candidates: pickupSpots,
            question: `Whereabouts in *${areaName}* should the driver pick you up?\n\nTap *Choose* for well-known spots — or type a landmark or street, or share a location pin`,
          });
          return;
        }

        const reply =
          `Whereabouts in *${areaName}* should the driver pick you up?\n\n` +
          `Tell me a landmark, street or bus stop — e.g. "${areaName} roundabout" — or share a location pin`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // ── Only a destination ("take me to Caleb University") ──
      // This used to fall through to the template below and throw away what
      // they said. Remember where they are going; the moment the pickup is
      // settled the destination step is answered with it.
      const knownDestination = rideIntent.destination?.address?.trim();
      if (knownDestination && !rideIntent.pickup?.address?.trim()) {
        await setPendingAreaHint(deps.redisClient, user.id, { kind: 'pickup', area: '', counterpartAddress: knownDestination });
        await setBookingStage(deps.redisClient, user.id, 'awaiting_pickup');
        const goingTo = (rideIntent.destination?.area?.trim() && !rideIntent.destination?.specific ? rideIntent.destination.area : knownDestination).split(',')[0];
        await replyAndLog(deps, phone, incomingMessage,
          `Heading to *${goingTo}* — got it.\n\nWhere should we pick you up? Type the address or a landmark, or share a location pin`);
        return;
      }

      // ── Nothing usable named at all → explain the format ──
      const reply = 'To book a ride, type your pickup and destination like:\n\n*"From [pickup address] to [destination]"*\n\nOr share your pickup location pin';
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    // Ignore empty messages (stickers, images, etc.) — don't send to LLM
    if (!incomingMessage.trim()) {
      return;
    }

    // ── The rating reply: after a trip, a bare 1–5 rates the driver. Armed
    // by the completion receipt ("Reply 1–5 to rate them"), disarmed once
    // used — so a lone digit weeks later can't accidentally become a rating.
    const bareRating = incomingMessage.trim().match(/^([1-5])(\s*\u2B50*|\s*stars?)?$/i);
    if (bareRating) {
      const lastCompleted = await getLastCompletedRide(deps.redisClient, user.id);
      if (lastCompleted) {
        const rating = Number(bareRating[1]);
        await deps.publisher.publishComplianceEvent(FeedbackLoggedEvent.parse({
          eventType: 'FEEDBACK_LOGGED',
          feedbackId: randomUUID(),
          rideId: lastCompleted.rideId,
          reviewerId: user.id,
          reviewerRole: 'RIDER',
          revieweeId: lastCompleted.driverUserId,
          rating,
          timestamp: new Date().toISOString(),
        }));
        await clearLastCompletedRide(deps.redisClient, user.id);
        const reply = rating >= 4
          ? `Thanks! Your ${rating}-star rating was sent${lastCompleted.driverName ? ` to ${lastCompleted.driverName}` : ''}. Book another ride anytime — just send your route.`
          : `Thanks for the honest ${rating}-star rating. Sorry that trip wasn't great — tell us what went wrong and we'll look into it.`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }
    }

    // ── Balance questions are MONEY questions — answered from the database,
    // never by the LLM. The model has old balances sitting in the chat
    // history and will happily parrot them; a rider who just got a refund
    // then "sees" their money missing and assumes theft.
    if (/\b(balance|how much.{0,20}(wallet|money|account)|wallet)\b/i.test(incomingMessage) &&
        !/withdraw|deposit|top ?up|fund/i.test(incomingMessage)) {
      const wallet = await walletClient.findByUserId(user.id).catch(() => null);
      const balance = wallet ? Number(wallet.balanceNgn) : 0;
      const locked = wallet ? Number(wallet.lockedNgn) : 0;
      const reply = locked > 0
        ? `Your wallet balance is ₦${balance.toLocaleString()} (plus ₦${locked.toLocaleString()} held for your current ride).`
        : `Your wallet balance is ₦${balance.toLocaleString()}.`;
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    // AI response for general messages
    const bot = new WhatsappBotService({
      apiKey: deps.groqApiKey,
      model: deps.groqModel,
      timeoutMs: deps.groqTimeoutMs,
      jwtSecret: deps.jwtSecret,
      appBaseUrl: deps.appBaseUrl,
    });
    const reply = await bot.generateReply({
      userId: user.id,
      phone,
      profileName,
      incomingMessage,
      isNewUser: user.created,
      recentMessages,
    });

    await appendWhatsappConversation(deps.redisClient, phone, [
      { role: 'user', content: incomingMessage || '[empty message]' },
      { role: 'assistant', content: reply },
    ]);

    await sendMetaReply(deps, phone, reply);
  } catch (error) {
    if (dedupKey) await deps.redisClient.del(dedupKey).catch(() => {});
    console.error('[whatsapp] message handling failed', error);
    // Don't try to send error — we already responded 200
  }
}
