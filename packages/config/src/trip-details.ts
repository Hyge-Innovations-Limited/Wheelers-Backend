/**
 * What the rider tells drivers about the trip before they bid: how many
 * people, luggage, a pet, and a short note. Set on "Set your price" (app and
 * ride page); drivers see it on the request card and through the trip.
 *
 * Absent (older apps, chat bookings): nothing was asked, and drivers see
 * nothing new. The price does not change with it: the driver can bid higher.
 */
export type TripDetails = {
  passengers: number;
  luggage: boolean;
  pet: boolean;
  note?: string;
};

export const TRIP_PASSENGERS_MAX = 4;
export const TRIP_NOTE_MAX = 60;

/**
 * The box is shown (app and ride page) and its details taken only with
 * TRIP_DETAILS_BOX=on: off, it is gone everywhere at once, no app update.
 */
export function tripDetailsBoxOn(): boolean {
  return process.env.TRIP_DETAILS_BOX?.trim() === 'on';
}

/** The details from a booking request: none while the box is switched off. */
export function tripDetailsFromRequest(value: unknown): TripDetails | undefined {
  return tripDetailsBoxOn() ? readTripDetails(value) : undefined;
}

const NUMBER_WORDS: Record<string, string> = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };

/** The note as a screen would read it: look-alike letters, words and styled digits turned into plain digits. */
function readableNote(note: string): string {
  let text = note.normalize('NFKC')
    // Hidden characters, keycap marks and emoji (also the ones put between digits to break a number).
    .replace(/[\u00AD\u200B-\u200F\u2060\uFEFF\uFE0E\uFE0F\u20E3]/gu, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine)\b/giu, (word) => NUMBER_WORDS[word.toLowerCase()] ?? word);
  // O and o for 0, I, l and | for 1, but only touching a digit (so "I'm at the gate" stays).
  for (let pass = 0; pass < 12; pass += 1) {
    const next = text
      .replace(/(?<=\p{Nd})[Oo](?![\p{L}])|(?<![\p{L}])[Oo](?=\p{Nd})/gu, '0')
      .replace(/(?<=\p{Nd})[Il|](?![\p{L}])|(?<![\p{L}])[Il|](?=\p{Nd})/gu, '1');
    if (next === text) break;
    text = next;
  }
  return text;
}

/**
 * True when the note could pass a way to reach the rider outside the app: seven or more digits in all
 * (however written or split up), an @handle, or a web address (wa.me, t . me, example dot com).
 */
function carriesContact(note: string): boolean {
  const text = readableNote(note);
  // Seven or more digits in one number-like run: only non-letters (up to three) between the digits, so
  // "Gate 12, House 34, Flat 567" (words between) is an address and "0803 123 | 4567" is a number.
  if (/\p{Nd}(?:[^\p{L}:]{0,3}\p{Nd}){6,}/u.test(text)) return true;
  if (/@\w/u.test(text)) return true;
  // A web address: the dot touches the word before it ("wa.me"); the spaced trick has a space before the dot
  // ("wa . me"); or the dot is spelled ("wa dot me"). "gate. To the left" has no space before the dot.
  if (/\w\.(?:me|com|ng|ly|to|co|io|link)\b|\w\s+\.\s*(?:me|com|ng|ly|to|co|io|link)\b|\bdot\s*(?:me|com|ng|ly|to|co|io|link)\b/iu.test(text)) return true;
  return false;
}

/**
 * What every driver who gets the request sees: people, luggage, pet and the
 * rider's cleaned note (as on inDrive). The note goes to every bidder, and only the matched driver
 * gets it whole: a note that carries a way to reach the rider (a phone number however it is written,
 * an @handle, a web address) is left off for bidders altogether.
 */
export function tripDetailsForOffer(details: TripDetails | undefined): TripDetails | undefined {
  if (!details) return undefined;
  const note = details.note && !carriesContact(details.note) ? details.note : undefined;
  return {
    passengers: details.passengers,
    luggage: details.luggage,
    pet: details.pet,
    ...(note ? { note } : {}),
  };
}

// A link in the note is spam or a trap for the driver: written without spaces, as links are.
const LINK = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|ng|net|org|io|me|co|app|link|ly|xyz|info|biz|online|site|shop|store|tv|gg|dev|ai|ee)\b(?:\/\S*)?/giu;

/** At most `max` UTF-16 units, never half an emoji (the event's limit counts units). */
function cutTo(text: string, max: number): string {
  let out = '';
  for (const char of text) {
    if (out.length + char.length > max) break;
    out += char;
  }
  return out;
}

/** The note as the driver sees it: one line, no links or hidden characters, at most 60 characters. */
export function cleanTripNote(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Cut first: the filters below must never run over a long string sent to slow the server.
  const note = cutTo(value, TRIP_NOTE_MAX * 4)
    .normalize('NFKC')
    // Half an emoji, control and invisible characters: gone. The joiner inside an emoji (U+200D) stays.
    .replace(/\p{Cs}/gu, '')
    .replace(/(?!\u200d)[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')
    // Marks piled on one letter draw over the driver's screen: two at most.
    .replace(/(\p{M}{2})\p{M}+/gu, '$1')
    .replace(LINK, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = cutTo(note, TRIP_NOTE_MAX).trim();
  return cut || undefined;
}

/** The rider's trip details from a request body, cleaned; undefined when none were sent. */
export function readTripDetails(value: unknown): TripDetails | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const count = typeof raw.passengers === 'number' && Number.isFinite(raw.passengers) ? Math.round(raw.passengers) : 1;
  const note = cleanTripNote(raw.note);
  return {
    passengers: Math.min(TRIP_PASSENGERS_MAX, Math.max(1, count)),
    luggage: raw.luggage === true,
    pet: raw.pet === true,
    ...(note ? { note } : {}),
  };
}

/** The ride row's columns for these details (all null when none were given). */
export function tripDetailsColumns(details: TripDetails | undefined): {
  passengers: number | null;
  hasLuggage: boolean | null;
  hasPet: boolean | null;
  riderNote: string | null;
} {
  return {
    passengers: details?.passengers ?? null,
    hasLuggage: details ? details.luggage : null,
    hasPet: details ? details.pet : null,
    riderNote: details?.note ?? null,
  };
}

/** The details back from a ride row; undefined for a ride booked without them. */
export function tripDetailsFromRow(row: {
  passengers?: number | null;
  hasLuggage?: boolean | null;
  hasPet?: boolean | null;
  riderNote?: string | null;
}): TripDetails | undefined {
  if (row.passengers == null) return undefined;
  return {
    passengers: row.passengers,
    luggage: row.hasLuggage === true,
    pet: row.hasPet === true,
    ...(row.riderNote ? { note: row.riderNote } : {}),
  };
}
