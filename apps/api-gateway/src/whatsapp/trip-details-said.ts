import type { TripDetails } from '@wheleers/config';
import type { RedisClient } from '../redis/client';

/**
 * Trip details typed in the chat: "3 of us", "we're two", "me and my wife",
 * "with my dog", "with luggage", "no bags". Read from the words, not the
 * model, so it holds when the model is out of quota.
 *
 * The words are taken out of the message before it is read as a trip, so
 * "From Yaba to Ikeja City Mall with my dog" is a trip to Ikeja City Mall.
 * What was said is kept for the rider's next search (the chat's and the ride
 * page's), where drivers see it as on the app.
 */
export type SaidTripDetails = { passengers?: number; luggage?: boolean; pet?: boolean };

/** Off unless WHATSAPP_TRIP_DETAILS_CHAT=on: the chat reads these phrases only once it is switched on. */
export function chatTripDetailsOn(): boolean {
  return process.env.WHATSAPP_TRIP_DETAILS_CHAT?.trim() === 'on';
}

const COUNT: Record<string, number> = { 1: 1, 2: 2, 3: 3, 4: 4, one: 1, two: 2, three: 3, four: 4 };
const N = '(1|2|3|4|one|two|three|four)';
const FRIEND = '(?:wife|husband|friend|sister|brother|mum|mom|mother|dad|father|son|daughter|child|kid|baby|colleague|partner|girlfriend|boyfriend|cousin|aunty|auntie|uncle|babe)';
/** Only words that say the rider has it with them: never "and" (an address can say "Lekki and Loads Street"). */
const LEAD = '(?:with|carrying|i\\s+have|we\\s+have|i\\s+get|we\\s+get|i\\s+dey\\s+with)';
const BAGS = '(?:luggage|luggages|suitcases?|bags|boxes|loads?)';
const PETS = '(?:pets?|dogs?|cats?|puppy|puppies|kittens?)';
const SOME = '(?:(?:my|our|some|a|an|the|two|2|three|3|big|small|little|heavy)\\s+){0,2}';
/** "we are 3" ends there, or goes on with people / of us: "we are two minutes away" is not a head count. */
const COUNT_ENDS = '(?:\\s+(?:people|persons|passengers|of\\s+us)\\b|(?=\\s*(?:[,!?]|\\.(?!\\d)|$|\\s+(?:and|with|from|to|going|pls|please|abeg)\\b)))';
/** "a pet shop", "cat food", "With Bags Plaza": a thing or a place, not what the rider has with them. */
const NOT_CARRIED = '(?!\\s+(?:shop|store|food|walker|clinic|plaza|ltd|limited|market|street|road|avenue)\\b)';

type Rule = { re: RegExp; read: (m: RegExpMatchArray) => SaidTripDetails };
// Applied in this order: a "no bags" anywhere wins over a "with bags".
const RULES: Rule[] = [
  { re: new RegExp(`\\bwe(?:\\s+are|\\s*['\u2019]re|\\s+be)\\s+${N}${COUNT_ENDS}`, 'gi'), read: (m) => ({ passengers: COUNT[m[1]!.toLowerCase()] }) },
  { re: new RegExp(`\\b${N}\\s+of\\s+us\\b`, 'gi'), read: (m) => ({ passengers: COUNT[m[1]!.toLowerCase()] }) },
  { re: new RegExp(`\\b(?:for\\s+)?${N}\\s+(?:people|persons|passengers|pple)\\b`, 'gi'), read: (m) => ({ passengers: COUNT[m[1]!.toLowerCase()] }) },
  { re: new RegExp(`\\bme\\s+and\\s+my\\s+${FRIEND}\\b(?!['\u2019])`, 'gi'), read: () => ({ passengers: 2 }) },
  { re: new RegExp(`\\b(?:no|without)\\s+${BAGS}\\b`, 'gi'), read: () => ({ luggage: false }) },
  { re: new RegExp(`\\b(?:no|without)\\s+${PETS}\\b`, 'gi'), read: () => ({ pet: false }) },
  { re: new RegExp(`\\b${LEAD}\\s+${SOME}${BAGS}\\b(?!\\s+of\\b)${NOT_CARRIED}`, 'gi'), read: () => ({ luggage: true }) },
  { re: new RegExp(`\\b${LEAD}\\s+${SOME}${PETS}\\b${NOT_CARRIED}`, 'gi'), read: () => ({ pet: true }) },
];

/** Words that are left when a message was only about the details. */
const FILLER = /^(?:and|also|pls|please|abeg|oh|o|sir|ma|too|then|so|just|[,.!?&+-])*$/i;

/**
 * The details a message gives, and the message without those words. Nothing
 * said: null. A group ride is left alone (each seat is one rider), and so is
 * a very long message.
 */
export function readSaidTripDetails(message: string): { said: SaidTripDetails; rest: string; onlyDetails: boolean } | null {
  if (message.length > 1000 || /\bgroup\b/i.test(message)) return null;
  let said: SaidTripDetails = {};
  let rest = message;
  for (const rule of RULES) {
    rest = rest.replace(rule.re, (...args) => {
      const match = args.slice(0, -2) as unknown as RegExpMatchArray;
      // An earlier rule wins for the same kind.
      said = { ...rule.read(match), ...said };
      return ' ';
    });
  }
  if (Object.keys(said).length === 0) return null;
  rest = rest
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/([,.!?])(?:\s*[,.!?])+/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/(?:^|\s)(?:and|with|plus)\s*[,.!?]*\s*$/i, '')
    .replace(/^[\s,.&+-]+|[\s,&+-]+$/g, '')
    .trim();
  const words = rest.toLowerCase().replace(/[,.!?]/g, ' ').trim().split(/\s+/).filter(Boolean);
  return { said, rest, onlyDetails: words.length === 0 || words.every((word) => FILLER.test(word)) };
}

/** "3 people · luggage · a pet", "1 person · no luggage". */
export function saidLine(said: SaidTripDetails): string {
  return [
    said.passengers !== undefined ? (said.passengers === 1 ? '1 person' : `${said.passengers} people`) : null,
    said.luggage === true ? 'luggage' : said.luggage === false ? 'no luggage' : null,
    said.pet === true ? 'a pet' : said.pet === false ? 'no pet' : null,
  ].filter(Boolean).join(' · ');
}

const KEY = (userId: string) => `whatsapp:user:${userId}:trip-details`;
/** Long enough for one booking; an old "with my dog" never rides on next week's trip. */
const KEEP_SECONDS = 2 * 60 * 60;

async function readStored(redis: RedisClient, userId: string): Promise<SaidTripDetails | null> {
  const raw = await redis.get(KEY(userId)).catch(() => null);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as SaidTripDetails;
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** Kept for the rider's next search; a later message changes only what it says. */
export async function rememberSaidTripDetails(redis: RedisClient, userId: string, said: SaidTripDetails): Promise<SaidTripDetails> {
  const merged = { ...(await readStored(redis, userId)), ...said };
  await redis.set(KEY(userId), JSON.stringify(merged), KEEP_SECONDS).catch(() => undefined);
  return merged;
}

/** What the rider said in the chat, as trip details (what was not said: 1 person, no). None said: undefined. */
export async function saidTripDetails(redis: RedisClient, userId: string): Promise<TripDetails | undefined> {
  const said = await readStored(redis, userId);
  if (!said) return undefined;
  return {
    passengers: typeof said.passengers === 'number' && said.passengers >= 1 && said.passengers <= 4 ? Math.round(said.passengers) : 1,
    luggage: said.luggage === true,
    pet: said.pet === true,
  };
}

/** The search went out with them: the next trip starts fresh. */
export async function clearSaidTripDetails(redis: RedisClient, userId: string): Promise<void> {
  await redis.del(KEY(userId)).catch(() => undefined);
}

/**
 * For a search: the details given (the ride page's box), else the trip's own
 * (search again: the last search's) with what the rider has said in the chat
 * since put over it ("search again with my dog" adds the dog, keeps the rest).
 * Nothing at all: {}.
 */
export async function searchTripDetails(redis: RedisClient, userId: string, given?: TripDetails, trips?: TripDetails): Promise<{ tripDetails?: TripDetails }> {
  if (given) return { tripDetails: given };
  const said = await readStored(redis, userId).catch(() => null);
  if (!said && !trips) return {};
  const passengers = typeof said?.passengers === 'number' && said.passengers >= 1 && said.passengers <= 4 ? Math.round(said.passengers) : trips?.passengers ?? 1;
  return {
    tripDetails: {
      passengers,
      luggage: typeof said?.luggage === 'boolean' ? said.luggage : trips?.luggage ?? false,
      pet: typeof said?.pet === 'boolean' ? said.pet : trips?.pet ?? false,
      ...(trips?.note ? { note: trips.note } : {}),
    },
  };
}
