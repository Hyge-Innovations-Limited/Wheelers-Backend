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

const COUNT: Record<string, number> = { 1: 1, 2: 2, 3: 3, 4: 4, one: 1, two: 2, three: 3, four: 4 };
const N = '(1|2|3|4|one|two|three|four)';
const FRIEND = '(?:wife|husband|friend|sister|brother|mum|mom|mother|dad|father|son|daughter|child|kid|baby|colleague|partner|girlfriend|boyfriend|cousin|aunty|auntie|uncle|babe|guy)';
const LEAD = '(?:with|and|plus|carrying|i\\s+have|we\\s+have|i\\s+get|got)';
const BAGS = '(?:luggage|luggages|suitcases?|bags|boxes|loads?)';
const PETS = '(?:pets?|dogs?|cats?|puppy|puppies|kittens?)';
const SOME = '(?:(?:my|our|some|a|an|the|two|2|three|3|big|small|little|heavy)\\s+){0,2}';

type Rule = { re: RegExp; read: (m: RegExpMatchArray) => SaidTripDetails };
const RULES: Rule[] = [
  { re: new RegExp(`\\bwe\\s*(?:are|[’']re|re|be)\\s+${N}\\b(?:\\s+(?:people|persons|passengers|of\\s+us))?`, 'gi'), read: (m) => ({ passengers: COUNT[m[1]!.toLowerCase()] }) },
  { re: new RegExp(`\\b${N}\\s+of\\s+us\\b`, 'gi'), read: (m) => ({ passengers: COUNT[m[1]!.toLowerCase()] }) },
  { re: new RegExp(`\\b(?:for\\s+)?${N}\\s+(?:people|persons|passengers|pple)\\b`, 'gi'), read: (m) => ({ passengers: COUNT[m[1]!.toLowerCase()] }) },
  { re: new RegExp(`\\bme\\s+and\\s+my\\s+${FRIEND}\\b`, 'gi'), read: () => ({ passengers: 2 }) },
  { re: new RegExp(`\\b(?:no|without)\\s+${BAGS}\\b`, 'gi'), read: () => ({ luggage: false }) },
  { re: new RegExp(`\\b(?:no|without)\\s+${PETS}\\b`, 'gi'), read: () => ({ pet: false }) },
  { re: new RegExp(`\\b${LEAD}\\s+${SOME}${BAGS}\\b`, 'gi'), read: () => ({ luggage: true }) },
  { re: new RegExp(`\\b${LEAD}\\s+${SOME}${PETS}\\b`, 'gi'), read: () => ({ pet: true }) },
  { re: /\b(?:luggage|luggages|suitcases?)\b/gi, read: () => ({ luggage: true }) },
  { re: /\b(?:pets?|puppy|puppies|kittens?)\b/gi, read: () => ({ pet: true }) },
];

/** Words that are left when a message was only about the details. */
const FILLER = /^(?:and|also|pls|please|ok|okay|yes|yeah|we|i|have|got|abeg|oh|o|sir|ma|too|as well|then|so|just|[,.!?&+-])*$/i;

/** The details a message gives, and the message without those words. Nothing said: null. */
export function readSaidTripDetails(message: string): { said: SaidTripDetails; rest: string; onlyDetails: boolean } | null {
  const text = message.slice(0, 500);
  let said: SaidTripDetails = {};
  let rest = text;
  for (const rule of RULES) {
    rest = rest.replace(rule.re, (...args) => {
      const match = args.slice(0, -2) as unknown as RegExpMatchArray;
      const read = rule.read(match);
      // The first word of each kind wins ("no bags" before a later bare "luggage").
      said = { ...read, ...said };
      return ' ';
    });
  }
  if (Object.keys(said).length === 0) return null;
  rest = rest
    .replace(/\s+([,.!?])/g, '$1')
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

/** For a chat search: the details given (the ride page's box), else what was said in the chat; none: {}. */
export async function searchTripDetails(redis: RedisClient, userId: string, given?: TripDetails): Promise<{ tripDetails?: TripDetails }> {
  const details = given ?? (await saidTripDetails(redis, userId).catch(() => undefined));
  return details ? { tripDetails: details } : {};
}
