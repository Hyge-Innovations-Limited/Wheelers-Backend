import type { LlmClient } from './llm';
import type { WhatsappConversationMessage } from './types';

/**
 * What a rider wants, mid-booking.
 *
 * The booking flow is a sequence of questions — pickup, destination, price —
 * and the code used to assume every reply answered the question just asked.
 * People don't talk like that. After a quote for the wrong city a rider sent
 * the address again with "Lagos" on the end, then "Book a ride", then "Cancel
 * first order" — and got "Please send a price for your ride" three times,
 * because none of those was a number and none matched a list of cancel words.
 *
 * So the MODEL reads the meaning, at every step. It never touches money or
 * state: it names an intent, and the code — which still owns fares, minimums,
 * geocoding and publishing the ride — decides what to do about it.
 */

/** 'confirm' = the trip is on screen with Confirm / Edit trip, before any price is asked for. */
export type BookingStep = 'pickup' | 'destination' | 'confirm' | 'price';

export type BookingIntent =
  | 'answer'              // what the step asked for: a place, or a price
  | 'change_pickup'
  | 'change_destination'
  | 'add_stop'            // a place to pass through on the way
  | 'remove_stop'
  | 'cancel'
  | 'restart'             // throw this booking away and begin a new one
  | 'confirm'             // "ok book it" — wants to go ahead, named no price
  | 'help'                // confused, or wants a person
  | 'other';

export interface BookingIntentResult {
  intent: BookingIntent;
  /** The place they named, in THEIR words. Only for change_pickup / change_destination / add_stop. */
  address?: string;
}

export interface BookingContext {
  pickupAddress?: string | null;
  destinationAddress?: string | null;
  /** Stops already on the trip, in order. */
  stopAddresses?: string[];
}

const INTENTS: ReadonlySet<string> = new Set([
  'answer', 'change_pickup', 'change_destination', 'add_stop', 'remove_stop', 'cancel', 'restart', 'confirm', 'help', 'other',
]);

const STEP_ASKED: Record<BookingStep, string> = {
  pickup: 'their PICKUP place',
  destination: 'their DESTINATION place',
  confirm: 'a CONFIRMATION that the trip shown (pickup, stops, destination) is right',
  price: 'the PRICE they offer (naira)',
};

// Words that say nothing about WHICH address a message is about.
const GENERIC_PLACE_WORDS = new Set([
  'no', 'number', 'street', 'st', 'road', 'rd', 'avenue', 'ave', 'close', 'crescent', 'way', 'lane',
  'lagos', 'nigeria', 'state', 'the', 'and', 'near', 'off', 'by', 'at', 'in', 'to', 'from',
]);

function placeWords(text: string | null | undefined): Set<string> {
  return new Set(
    (text ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3 && !/^\d+$/.test(word) && !GENERIC_PLACE_WORDS.has(word)),
  );
}

/**
 * Evidence for the model, not a decision: which of the two addresses does this
 * message share distinctive words with? A rider who resends "7 Osaro Isokpan
 * Lagos" after a quote to "Isokpan St, Benin City" is plainly talking about the
 * destination — the small model missed that on its own and called it a pickup
 * change, because both addresses mention Lagos.
 */
export function sharedPlaceWords(message: string, context: BookingContext): { pickup: string[]; destination: string[] } {
  const said = placeWords(message);
  const shared = (address?: string | null) => [...placeWords(address)].filter((word) => said.has(word));
  return { pickup: shared(context.pickupAddress), destination: shared(context.destinationAddress) };
}

function buildPrompt(step: BookingStep, message: string, context: BookingContext): string {
  const asked = step === 'price' ? 'price' : step === 'confirm' ? 'confirmation' : 'place';
  const correcting = step === 'price' || step === 'confirm';
  const shared = sharedPlaceWords(message, context);
  const evidence = correcting && (shared.pickup.length > 0 || shared.destination.length > 0)
    ? `\nWord evidence: the message shares [${shared.destination.join(', ')}] with the DESTINATION and [${shared.pickup.join(', ')}] with the PICKUP.`
    : '';

  return `
A rider is part-way through booking a ride on WhatsApp with Wheelers (Nigeria). The assistant just asked for ${STEP_ASKED[step]}.
Pickup so far: ${context.pickupAddress ?? 'not set'}
Destination so far: ${context.destinationAddress ?? 'not set'}${context.stopAddresses?.length ? `\nStops so far: ${context.stopAddresses.map((stop, index) => `${index + 1}. ${stop}`).join(' | ')}` : ''}${evidence}

Classify the rider's message by MEANING — any wording, Pidgin, slang, typos. Return ONLY JSON:
{"intent":"answer"|"change_pickup"|"change_destination"|"add_stop"|"remove_stop"|"cancel"|"restart"|"confirm"|"help"|"other","address":string|null}

answer — gave the ${asked} that was asked for. ${step === 'price'
    ? 'Any price form: "2500", "2.5k", "I fit pay 3k", "two thousand".'
    : step === 'confirm'
      ? 'NEVER use "answer" at this step: saying the trip is right is "confirm".'
    : 'Any place, however short: "Yaba", "the mall", "No 7 Osaro Isokpan" ("No 7" = Number 7).'}
change_destination — wants a different destination, with or without naming it: "that's not where I'm going", "not that one, I mean Ikeja", "wrong place", "I'm going to Yaba instead", "Benin? I said Lagos".
change_pickup — wants a different pickup: "pick me from the gate instead", "I've moved, I'm at Shoprite now".
add_stop — wants to pass through another place on the way, with or without naming it: "add a stop", "I need to stop at Yaba market", "make we branch Shoprite first", "pick my friend at Unilag gate on the way".
remove_stop — wants a stop taken off: "remove the stop", "no need to stop again", "remove Yaba market".
cancel — no longer wants this ride: "cancel first order", "forget it", "never mind", "abeg leave am", "I no do again".
restart — wants a fresh booking: "book a ride", "new ride", "start again", "start afresh".
confirm — ${step === 'confirm' ? 'the trip is right, go ahead: "confirm", "yes", "correct", "na so", "ok", "go ahead", "book it"' : `wants to go ahead but gave no ${asked}: "ok", "go ahead", "book it", "proceed"`}.
help — lost or wants a person: "I don't understand", "this isn't working", "agent", "customer care".
other — anything else: greetings, wallet or balance questions, unrelated chat.
${correcting ? `
At this step a message that is ONLY a place (no price) is the rider CORRECTING an address — never "answer". Use the word evidence: it is the destination unless it clearly matches or refines the pickup. The same address resent with a city or area added is a correction. "No 7 …" means Number 7.` : ''}
address — for change_pickup/change_destination/add_stop only: the place they named, in THEIR words, adding no city or state they did not write. Otherwise null.
Unsure between answer and something else → answer. Unsure among the rest → other.
`.trim();
}

/**
 * Cheap guard for the address steps, so a plain "Shoprite Ikeja" never costs a
 * model call. NOT the decision — it only asks "could this be something other
 * than a place?", generously, by word-stems. The model makes the call.
 *
 * The price step needs no guard: anything that isn't a number goes to the model.
 */
export function mightNotBeAnAddress(message: string): boolean {
  const m = message.toLowerCase().trim();
  if (m.length < 2) return false;
  return /cancel|cancl|forget|never|nvm|leave am|no do|don'?t want|dont want|stop|abort|start|again|afresh|restart|new ride|another|book|order|chang|edit|wrong|instead|actually|not that|no be|i mean|meant|moved|pick ?up|pick me|help|understand|confus|agent|human|person|support|customer|care|talk to|complain|price|how much|proceed|go ahead|continue|^ok|^yes|^fine/.test(m);
}

/** Only when the model is unreachable: the plainest wordings still work. */
export function fallbackBookingIntent(step: BookingStep, message: string): BookingIntentResult {
  const m = message.toLowerCase().trim();
  if (/\b(cancel|never\s*mind|nevermind|forget it|abort)\b/.test(m)) return { intent: 'cancel' };
  if (/\b(start (again|over|afresh)|restart|new ride|book (a|another) ride)\b/.test(m)) return { intent: 'restart' };
  if (/\b(agent|human|customer care|support|help)\b/.test(m)) return { intent: 'help' };
  if (/\b(change|edit|wrong)\b.*\b(destination|drop\s*-?off|where i'?m going)\b/.test(m)) return { intent: 'change_destination' };
  if (/\b(change|edit|wrong)\b.*\b(pick\s*-?up)\b/.test(m)) return { intent: 'change_pickup' };
  if (/\b(remove|delete|no)\b.*\bstop\b/.test(m)) return { intent: 'remove_stop' };
  if (/\b(add|another|one more)\b.*\bstop\b|\bstop (at|by)\b/.test(m)) return { intent: 'add_stop' };
  if (step === 'confirm' && /^(confirm|yes|yeah|yep|ok|okay|correct|go ahead|proceed|na so)\b/.test(m)) return { intent: 'confirm' };
  // Without the model we cannot tell a correction from chatter at the price
  // step, and at the address steps a place is by far the likeliest reply.
  return { intent: step === 'price' || step === 'confirm' ? 'other' : 'answer' };
}

/**
 * The titles of the buttons WE send. A tap arrives as its title, so these are
 * known strings, not guesses at what a rider might type — and they must work
 * even when the model is down, because they are the way out.
 */
const WAY_OUT_BUTTONS: Record<string, BookingIntent> = {
  'change pickup': 'change_pickup',
  'change destination': 'change_destination',
  'start again': 'restart',
  'cancel ride': 'cancel',
  'confirm trip': 'confirm',
  'add a stop': 'add_stop',
};

export async function classifyBookingIntent(
  groq: LlmClient,
  input: {
    step: BookingStep;
    message: string;
    context: BookingContext;
    recentMessages?: WhatsappConversationMessage[];
  },
): Promise<BookingIntentResult> {
  const { step, message, context, recentMessages = [] } = input;
  const tapped = WAY_OUT_BUTTONS[message.trim().toLowerCase()];
  if (tapped) return { intent: tapped };
  if (!groq.configured) return fallbackBookingIntent(step, message);

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: buildPrompt(step, message, context) },
    // Two short turns is enough to read "not that one" or "ok". Kept short on
    // purpose: the trip is already in the prompt, and tokens are the budget.
    ...recentMessages.slice(-2).map((entry) => ({ role: entry.role, content: entry.content.slice(0, 160) })),
    { role: 'user', content: message.slice(0, 500) },
  ];

  try {
    const result = await groq.completeJson(messages);
    const intent = typeof result?.intent === 'string' && INTENTS.has(result.intent)
      ? (result.intent as BookingIntent)
      : null;
    if (!intent) return fallbackBookingIntent(step, message);
    // Asked for the destination and told "change my destination to X"? That
    // is simply the answer. Same for the pickup.
    if ((step === 'destination' && intent === 'change_destination') || (step === 'pickup' && intent === 'change_pickup')) {
      return { intent: 'answer' };
    }

    // "Unsure → answer" must never read as "yes, that trip is right".
    if (step === 'confirm' && intent === 'answer') return { intent: 'other' };
    const wantsAddress = intent === 'change_pickup' || intent === 'change_destination' || intent === 'add_stop';
    const address = wantsAddress && typeof result?.address === 'string' ? result.address.trim() : '';
    return address ? { intent, address: address.slice(0, 200) } : { intent };
  } catch (error) {
    console.warn('[booking-intent] classification failed — using the plain-wording fallback', {
      step,
      error: error instanceof Error ? error.message : String(error),
    });
    return fallbackBookingIntent(step, message);
  }
}
