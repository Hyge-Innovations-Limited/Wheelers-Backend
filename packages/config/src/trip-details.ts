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

/**
 * What drivers bidding on the request see: people, luggage, pet. The note is
 * only for the driver who gets the ride (it can hold a gate code or a flat
 * number, and that driver already has the rider's phone).
 */
export function tripDetailsForOffer(details: TripDetails | undefined): TripDetails | undefined {
  if (!details) return undefined;
  return { passengers: details.passengers, luggage: details.luggage, pet: details.pet };
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
