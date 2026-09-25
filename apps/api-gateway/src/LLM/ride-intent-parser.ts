import type { LlmClient } from './llm';
import type { WhatsappConversationMessage } from './types';

export interface RideLocation {
  address: string;
  area: string;
  specific: boolean;
}

export interface RideIntent {
  intent: 'ride_request' | 'group_ride_request' | 'ride_status' | 'cancel_ride' | 'edit_pickup' | 'edit_destination' | 'deposit' | 'withdraw' | 'other';
  pickup: RideLocation | null;
  destination: RideLocation | null;
  offerNgn: number | null;
  paymentMethod: 'CASH' | 'WALLET' | 'CRYPTO_WALLET' | null;
  /** True when the pickup or destination is clearly not in Nigeria. */
  outsideNigeria?: boolean;
}

const RIDE_INTENT_SYSTEM_PROMPT = `
You extract ride request details from WhatsApp messages.
Return ONLY a JSON object with these fields:
- "intent": "ride_request" | "group_ride_request" | "ride_status" | "cancel_ride" | "edit_pickup" | "edit_destination" | "deposit" | "withdraw" | "other"
- "pickup": { "address": string, "area": string, "specific": boolean } | null
- "destination": { "address": string, "area": string, "specific": boolean } | null
- "offerNgn": number | null
- "paymentMethod": "WALLET" | "CRYPTO_WALLET" | "CASH" | null
- "outsideNigeria": boolean — true if the pickup or destination is clearly outside Nigeria (another country or a city/landmark abroad: Paris, London, Accra, Dubai, New York, Eiffel Tower). Wheelers operates ONLY in Nigeria.

"specific" field:
- true = the location is precise enough to find on a map (a street, landmark, building, mall, hotel, school, hospital, market, plaza, station, airport, bridge, gate, pier, park, etc.)
- false = just a broad area/neighborhood/city name with no specific point (e.g. "Lekki", "VI", "Ikeja", "downtown", "midtown")
- Examples of SPECIFIC (true): "Chevron roundabout Lekki", "Shoprite Ikeja", "Palms Mall", "Unilag main gate", "MM2 airport", "Ikeja City Mall", "Wuse market Abuja", "15 Aiyetoro Street Akoka"
- Examples of NOT SPECIFIC (false): "Lekki", "VI", "Ikeja", "Surulere", "downtown", "Abuja"

Rules:
- If the user wants a GROUP ride / shared ride / to share a ride and split the fare with other riders → "group_ride_request"
  (e.g. "group ride", "shared ride", "I wanna book a group ride", "share a ride"). Fill pickup/destination like ride_request if mentioned.
- If the message is about booking a normal ride, going somewhere, or requesting a trip → "ride_request"
- If the user wants to CHANGE/EDIT/UPDATE only the pickup location → "edit_pickup"
  Set "pickup" to the NEW pickup location. Set "destination" to null (do NOT fill destination from history).
- If the user wants to CHANGE/EDIT/UPDATE only the destination location → "edit_destination"
  Set "destination" to the NEW destination location. Set "pickup" to null (do NOT fill pickup from history).
- If asking about an ongoing ride status → "ride_status"
- If cancelling a ride → "cancel_ride"
- If they want to PUT money INTO their Wheelers wallet, or ask how to (top up, fund, add money, "where do I send money", "give me my account number") — in any wording, Pidgin or typos → "deposit"
- If they want to TAKE money OUT to a bank account, or ask how to (withdraw, cash out, "I wan collect my money") → "withdraw"
  NOT these: paying for a ride, a fare offer, asking their balance, or a complaint about a past transaction — those stay "other".
  For "deposit" and "withdraw", set all other fields to null.
- Everything else (greetings, wallet questions, general chat) → "other"
- For "other" intent, set all other fields to null
- Locations: keep the place in the rider's own words. You may expand a Lagos abbreviation you are CERTAIN of ("VI" → "Victoria Island, Lagos", "Lekki" → "Lekki, Lagos", "Unilag" → "University of Lagos, Lagos").
- NEVER add a state, city or area the rider did not say. You do not know where every school, church, estate or company is, and a wrong guess makes the map lookup fail: "Caleb University" must become "Caleb University, Nigeria" — NOT "Caleb University, Nasarawa State". When unsure, the rider's words plus ", Nigeria" is always the right answer.
- Extract price EXACTLY as the rider typed it, only converting the notation: "2000" → 2000, "₦2,000" → 2000, "2,600" → 2600, "2 600" → 2600, "2k" → 2000, "2.5k" → 2500, "5k" → 5000. Never round, "correct" or adjust the number.
- If a system message describes "What we know about this rider", use it: "home", "my house", "my place" → the rider's home address; "work", "office" → the work address; "the usual", "same place", "where I went yesterday/last time" → the matching recent ride. Fill the address from memory with specific=true. If memory has no such place, leave the field null.
- If payment method not mentioned, set to null
- "wallet" or "use wallet" = "WALLET" (means Naira wallet by default)
- "crypto wallet" or "pay with crypto" or "USDC" = "CRYPTO_WALLET"
- NEVER fill a pickup or destination from earlier messages, from the assistant's own replies, or from memory, unless the rider's CURRENT message refers to it ("home", "work", "the usual", "same place as last time"). A message that names only one end names only that end: leave the other null. "I want to go from Ilemere" → pickup Ilemere, destination null — even if a destination was discussed a minute ago.
- For "edit_pickup" / "edit_destination" intents, ONLY extract the location being changed. Do NOT fill in the other location from history.

Examples:
"I want to go from Chevron to Adeola Odeku for 2000" →
{"intent":"ride_request","pickup":{"address":"Chevron Roundabout, Lekki, Lagos","area":"Lekki","specific":true},"destination":{"address":"Adeola Odeku Street, Victoria Island, Lagos","area":"VI","specific":true},"offerNgn":2000,"paymentMethod":null}

"Take me from Lekki to VI" →
{"intent":"ride_request","pickup":{"address":"Lekki, Lagos","area":"Lekki","specific":false},"destination":{"address":"Victoria Island, Lagos","area":"VI","specific":false},"offerNgn":null,"paymentMethod":null}

"Book me a ride to Paris" →
{"intent":"ride_request","pickup":null,"destination":{"address":"Paris, France","area":"Paris","specific":false},"offerNgn":null,"paymentMethod":null,"outsideNigeria":true}

"Ikeja to Ajah for 2,600" →
{"intent":"ride_request","pickup":{"address":"Ikeja, Lagos","area":"Ikeja","specific":false},"destination":{"address":"Ajah, Lagos","area":"Ajah","specific":false},"offerNgn":2600,"paymentMethod":null,"outsideNigeria":false}

(with memory saying home = "12 Adebayo Street, Surulere, Lagos") "take me home from Shoprite Ikeja" →
{"intent":"ride_request","pickup":{"address":"Shoprite, Ikeja, Lagos","area":"Ikeja","specific":true},"destination":{"address":"12 Adebayo Street, Surulere, Lagos","area":"Surulere","specific":true},"offerNgn":null,"paymentMethod":null,"outsideNigeria":false}

"Change my pickup to Fiora garden" →
{"intent":"edit_pickup","pickup":{"address":"Fiora Garden, Lagos","area":"Lagos","specific":true},"destination":null,"offerNgn":null,"paymentMethod":null}

"Edit the destination to Shoprite Lekki" →
{"intent":"edit_destination","pickup":null,"destination":{"address":"Shoprite, Lekki, Lagos","area":"Lekki","specific":true},"offerNgn":null,"paymentMethod":null}

"I wanna book a group ride" →
{"intent":"group_ride_request","pickup":null,"destination":null,"offerNgn":null,"paymentMethod":null}

"Group ride from Yaba to Lekki" →
{"intent":"group_ride_request","pickup":{"address":"Yaba, Lagos","area":"Yaba","specific":false},"destination":{"address":"Lekki, Lagos","area":"Lekki","specific":false},"offerNgn":null,"paymentMethod":null}

"Cancel my ride" →
{"intent":"cancel_ride","pickup":null,"destination":null,"offerNgn":null,"paymentMethod":null}

"Hello how are you" →
{"intent":"other","pickup":null,"destination":null,"offerNgn":null,"paymentMethod":null}
`.trim();

/**
 * "I want to go from Caleb University" names a PICKUP. Measured live, one model
 * filed it under destination in 3 runs out of 5 — so the same message got a
 * place picker one minute and a useless template the next. This is grammar, not
 * a guess at wording: the rider said "from" and never said "to", so the one
 * place they named is where they are.
 */
export function repairFromOnly(intent: RideIntent, message: string): void {
  if (intent.intent !== 'ride_request' || intent.pickup || !intent.destination) return;
  const lower = ` ${message.toLowerCase()} `;
  if (!/\sfrom\s/.test(lower)) return;
  // "to" as a direction ("… to Yaba"), not as part of "want to go" / "going to leave from".
  const withoutVerbs = lower.replace(/\b(want|wanna|need|like|trying|going|have|got)\s+to\s+(go|leave|move|travel|book|get|be|come)\b/g, ' ');
  if (/\sto\s/.test(withoutVerbs)) return;
  intent.pickup = intent.destination;
  intent.destination = null;
}

/**
 * A place the rider did not say is not theirs. Models fill the other end of a trip
 * from the chat above (the bot's own trip card, an old booking) or from memory —
 * measured live: "I want to go from Ilemere road" came back with the destination of
 * a trip discussed minutes earlier. So every place the model returns must be traceable
 * to the CURRENT message: a word of the address appears in it (typos and prefixes
 * allowed), an abbreviation the prompt permits ("VI", "Unilag"), or a memory cue
 * ("home", "work", "the usual"). Anything else is dropped, never guessed.
 */
const MEMORY_CUES = /\b(home|house|my place|work|office|usual|same place|last time|yesterday|last night|this morning|earlier|again|back)\b/i;
const FILLER = new Set(['lagos', 'nigeria', 'state', 'street', 'road', 'rd', 'st', 'avenue', 'ave', 'close', 'estate', 'area', 'the', 'and', 'of', 'bus', 'stop', 'junction']);
const ALIASES: Record<string, string[]> = { vi: ['victoria', 'island'], unilag: ['university', 'lagos'], lasu: ['lagos', 'state', 'university'], mmia: ['murtala', 'muhammed', 'airport'] };
const tokensOf = (text: string) => text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((token) => token.length >= 2);
function similar(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  if (a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 2) return false;
  // Levenshtein ≤ 2: "ilemre" is "ilemere".
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row++) {
    const current = [row];
    for (let column = 1; column <= b.length; column++) {
      current[column] = Math.min(previous[column]! + 1, current[column - 1]! + 1, previous[column - 1]! + (a[row - 1] === b[column - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]! <= 2;
}
export function saidInMessage(address: string, message: string): boolean {
  if (MEMORY_CUES.test(message)) return true;
  const said = tokensOf(message).flatMap((token) => [token, ...(ALIASES[token] ?? [])]);
  const named = tokensOf(address).filter((token) => !FILLER.has(token));
  if (named.length === 0) return true;
  return named.some((token) => said.some((word) => similar(word, token)));
}
export function groundToMessage(intent: RideIntent, message: string): void {
  for (const end of ['pickup', 'destination'] as const) {
    const place = intent[end];
    if (place?.address && !saidInMessage(place.address, message)) {
      console.info('[ride-intent] dropped a place the rider did not say', { end, address: place.address, message: message.slice(0, 80) });
      intent[end] = null;
    }
  }
}

/** Regex fallback for critical intents when Groq is unavailable. */
function fallbackRideIntent(message: string): RideIntent | null {
  const lower = message.toLowerCase().trim();
  if (/\b(group|shared?)\s*ride\b/.test(lower)) {
    return { intent: 'group_ride_request', pickup: null, destination: null, offerNgn: null, paymentMethod: null };
  }
  if (/\b(cancel\s*(my\s*)?ride|stop\s*(my\s*)?ride)\b/.test(lower)) {
    return { intent: 'cancel_ride', pickup: null, destination: null, offerNgn: null, paymentMethod: null };
  }
  if (/\b(ride\s*status|where.*driver|how\s*far)\b/.test(lower)) {
    return { intent: 'ride_status', pickup: null, destination: null, offerNgn: null, paymentMethod: null };
  }
  return tripFromGrammar(message);
}

/**
 * The shape of a trip request, read without a model: "from X to Y", "from X",
 * "take me to Y". Not a list of things riders might say — just the two words
 * that mark the ends of a journey in English and Pidgin alike.
 *
 * It exists because a model that does not answer (a rate limit, an outage)
 * used to mean the rider's clearly-stated trip was thrown away. Measured live
 * on the free tier: "from ikorodu garage to Caleb University" came back empty
 * 3 times in 4. The place names are passed on exactly as typed; the place
 * search and the picker do the rest.
 */
export function tripFromGrammar(message: string): RideIntent | null {
  const text = message.trim().replace(/\s+/g, ' ').replace(/[.!?]+$/, '');
  const place = (raw: string | undefined) => {
    const address = (raw ?? '').replace(/\b(please|pls|abeg|now|asap|thanks?|thank you)\b/gi, ' ').replace(/\s+/g, ' ').replace(/^[\s,]+|[\s,]+$/g, '');
    return address.length >= 3 ? { address, area: '', specific: true } : null;
  };
  const trip = (pickup: ReturnType<typeof place>, destination: ReturnType<typeof place>): RideIntent | null =>
    pickup || destination ? { intent: 'ride_request', pickup, destination, offerNgn: null, paymentMethod: null } : null;

  // "… from X to Y" — the last " to " splits the ends, so "from want-to-go road to Yaba" still works.
  const both = /\bfrom\s+(.+)\s+to\s+(.+)$/i.exec(text);
  if (both) return trip(place(both[1]), place(both[2]));

  const fromOnly = /\bfrom\s+(.+)$/i.exec(text);
  if (fromOnly) return trip(place(fromOnly[1]), null);

  const toOnly = /\b(?:take|carry|drop|drive)\s+me\s+(?:to|at|off at)\s+(.+)$/i.exec(text)
    ?? /\b(?:going|heading|headed|go|travel(?:ling|ing)?)\s+to\s+(.+)$/i.exec(text);
  if (toOnly) return trip(null, place(toOnly[1]));

  return null;
}

export async function parseRideIntent(
  groq: LlmClient,
  message: string,
  recentMessages: WhatsappConversationMessage[],
  riderMemoryContext?: string,
): Promise<RideIntent | null> {
  if (!groq.configured) return fallbackRideIntent(message);

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: RIDE_INTENT_SYSTEM_PROMPT },
  ];
  if (riderMemoryContext) {
    messages.push({ role: 'system', content: riderMemoryContext });
  }

  // Recent turns, so a pickup named two messages ago still counts.
  const contextMessages = recentMessages.slice(-8);
  for (const msg of contextMessages) {
    messages.push({ role: msg.role, content: msg.content });
  }

  messages.push({ role: 'user', content: message });

  try {
    const result = await groq.completeJson(messages);
    if (!result) return fallbackRideIntent(message);

    const intent = result as unknown as RideIntent;
    if (!intent.intent || !['ride_request', 'group_ride_request', 'ride_status', 'cancel_ride', 'edit_pickup', 'edit_destination', 'deposit', 'withdraw', 'other'].includes(intent.intent)) {
      return null;
    }

    groundToMessage(intent, message);
    repairFromOnly(intent, message);
    intent.outsideNigeria = intent.outsideNigeria === true;
    if (typeof intent.offerNgn === 'string') {
      const parsed = Number(String(intent.offerNgn).replace(/[^0-9.]/g, ''));
      intent.offerNgn = Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
    }

    return intent;
  } catch (error) {
    console.warn('[ride-intent] Parse failed, trying regex fallback', {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallbackRideIntent(message);
  }
}
