import { normalizeMetaPhone } from './send';

export const OPENER_WORDS = new Set([
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
export function isBookingOpener(message: string): boolean {
  const words = message
    .toLowerCase()
    .replace(/[^a-z\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0 || words.length > 6) return false;
  return words.every((word) => OPENER_WORDS.has(word.replace(/'/g, '')));
}

export interface MetaMessageInfo {
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
  /** A form was closed with its last button. WhatsApp disables that message's button, so the chat may need a fresh one. */
  flowCompleted?: { flow: string; rearm: boolean };
}

export function extractMetaMessages(body: unknown): MetaMessageInfo[] {
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

export function parseMetaMessage(
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
        // A Flow was completed with its last button. The webhook only needs to know so it
        // does not treat the empty message as chat; nothing is sent back.
        if (interactive?.type === 'nfm_reply') {
          const reply = interactive.nfm_reply as Record<string, unknown> | undefined;
          let response: Record<string, unknown> = {};
          try { response = typeof reply?.response_json === 'string' ? JSON.parse(reply.response_json) as Record<string, unknown> : {}; } catch { response = {}; }
          if (typeof response.flow !== 'string') return null;
          return { messageId: wamid, phone, profileName, messageBody: '', isLocation: false, flowCompleted: { flow: response.flow, rearm: String(response.rearm ?? 'true') !== 'false' } };
        }
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
export type AcceptCommand =
  | { kind: 'numbered'; driverNumber: number }
  | { kind: 'unspecified' };

export function parseAcceptCommand(message: string): AcceptCommand | null {
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

export function isMoreCommand(message: string): boolean {
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
export function looksLikeConversation(message: string): boolean {
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
export function stripDirectionPrefix(message: string): string {
  const stripped = message
    .trim()
    .replace(/^(?:i(?:'m| am)?\s+(?:dey\s+)?(?:going|go|headed|heading)\s+to|take me to|carry me to|drop me (?:at|off at)|go(?:ing)? to|to|from)\s+/i, '')
    .trim();
  return stripped.length >= 3 ? stripped : message.trim();
}

export function isCancelCommand(message: string): boolean {
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
export function mentionsPrice(message: string): boolean {
  return /\b(price|offer|bid|fare|pay|amount|naira)\b|₦|\b\d+(?:\.\d+)?\s*k\b/i.test(message);
}

export function isEditPickupCommand(message: string): boolean {
  const m = message.trim().toLowerCase();
  if (/^edit\s*(pickup|from)$/i.test(m)) return true;
  if (mentionsPrice(m) && !/\b(pickup|pick\s*-?\s*up|origin)\b/i.test(m)) return false;
  // The verb must be followed by the thing being edited: "change my pickup",
  // "edit pickup to Shoprite", "update from". Not "change … from 2000".
  return /\b(edit|change|update|modify)\s+(?:my\s+|the\s+)?(pickup|pick\s*-?\s*up|origin|start(?:ing)?\s+point|from)\b/i.test(m)
    || /\b(pickup|pick\s*-?\s*up)\s+(?:needs?\s+)?(?:to\s+be\s+)?(edit(?:ed)?|chang(?:e|ed)|updat(?:e|ed)|modif(?:y|ied))\b/i.test(m);
}

export function isEditDestinationCommand(message: string): boolean {
  const m = message.trim().toLowerCase();
  if (/^edit\s*(destination|to)$/i.test(m)) return true;
  if (mentionsPrice(m) && !/\b(destination|dest|drop\s*-?\s*off|dropoff)\b/i.test(m)) return false;
  return /\b(edit|change|update|modify)\s+(?:my\s+|the\s+)?(destination|dest|drop\s*-?\s*off|dropoff|where\s+(?:i'?m|i\s+am)\s+going|to)\b/i.test(m)
    || /\b(destination|dest|drop\s*-?\s*off|dropoff)\s+(?:needs?\s+)?(?:to\s+be\s+)?(edit(?:ed)?|chang(?:e|ed)|updat(?:e|ed)|modif(?:y|ied))\b/i.test(m);
}

/** Extract inline address from edit command, e.g. "edit pickup golden gate bridge" → "golden gate bridge" */
export function extractEditAddress(message: string): string | null {
  const m = message.trim();
  // Strip the command keywords, whatever remains is the address
  const stripped = m.replace(/\b(edit|change|update|modify)\b/i, '')
    .replace(/\b(pickup|pick\s*up|pick\s*-\s*up|origin|start|from|destination|dest|drop\s*off|dropoff|drop\s*-\s*off|where|to)\b/i, '')
    .replace(/\b(to|the)\b/gi, '')
    .trim();
  return stripped.length >= 3 ? stripped : null;
}

export const CANCELLATION_REASON_PROMPT = [
  'Why do you want to cancel your ride?',
  '',
  '1. Long waiting time',
  '2. Wrong pickup or destination point',
  '3. Want to change ride type',
  '4. Accidental request',
  '',
  'Reply with *1–4* or type your reason.',
].join('\n');

export function parseCancellationReason(message: string): string | null {
  const normalized = message.trim().replace(/\s+/g, ' ');
  if (!normalized || isCancelCommand(normalized)) return null;

  const option = CANCELLATION_REASONS[normalized];
  if (option) return option;

  // Do not treat an unsupported numeric option as a free-text reason.
  if (/^\d+$/.test(normalized)) return null;

  return normalized.slice(0, 240);
}

export function isWithdrawalStatusCommand(message: string): boolean {
  return /^(withdrawal?\s+status|withdrawals)$/i.test(message.trim());
}

export function isWithdrawalStage(stage: string | null): boolean {
  return stage === 'awaiting_withdrawal_amount'
    || stage === 'awaiting_withdrawal_bank'
    || stage === 'awaiting_withdrawal_account'
    || stage === 'awaiting_withdrawal_confirmation';
}

export function isGroupCancelCommand(message: string): boolean {
  const m = message.trim().toLowerCase();
  return /\b(cancel|leave|stop|end)\b.*\bgroup\b/.test(m) || /\bgroup\b.*\b(cancel|leave|stop|end)\b/.test(m);
}

export function isGroupStatusCommand(message: string): boolean {
  const m = message.trim().toLowerCase();
  return /\bgroup\b.*\bstatus\b/.test(m) || /\bstatus\b.*\bgroup\b/.test(m);
}

export const PLACE_CHOICE_ID = /^place_choice_(\d+|none)$/;

export const NONE_OF_THESE = 'None of these';

/** list_reply id → what the rider "said": the option's number, or none of them. */
export function placeChoiceReply(id: unknown): string | null {
  const match = typeof id === 'string' ? PLACE_CHOICE_ID.exec(id) : null;
  if (!match) return null;
  return match[1] === 'none' ? NONE_OF_THESE : match[1]!;
}

export function isAffirmativeReply(message: string): boolean {
  return /^(yes|yeah|yea|yep|yup|ok|okay|confirm|correct|sure|continue|go ahead|y)\b/i.test(message.trim());
}

/** The steps where a reply is a question the rider is in the middle of answering. */
export const BOOKING_STEPS: ReadonlySet<string> = new Set([
  'awaiting_pickup', 'awaiting_destination', 'awaiting_trip_confirm', 'adding_stop', 'awaiting_price',
  'awaiting_route_confirmation', 'editing_pickup', 'editing_destination', 'awaiting_cancel_reason',
  'group_awaiting_pickup', 'group_awaiting_destination', 'group_awaiting_confirm', 'group_awaiting_face_photo',
  'awaiting_withdrawal_amount', 'awaiting_withdrawal_bank', 'awaiting_withdrawal_account', 'awaiting_withdrawal_confirmation',
]);

export const CANCELLATION_REASONS: Record<string, string> = {
  '1': 'Long waiting time',
  '2': 'Wrong pickup or destination point',
  '3': 'Want to change ride type',
  '4': 'Accidental request',
};
