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

// A link or a phone number in the note would take the trip off the app.
const LINK = /\b(?:https?:\/\/|www\.)\S+|\b\S+\.(?:com|ng|net|org|io|me|co|app|link|ly)(?:\/\S*)?\b/gi;
const PHONE = /\+?\d[\d\s().-]{5,}\d/g;

/** The note as drivers may see it: one line, no links or phone numbers, at most 60 characters. */
export function cleanTripNote(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Cut first: the filters below must never run over a long string sent to slow the server.
  const note = value
    .slice(0, TRIP_NOTE_MAX * 4)
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ')
    .replace(LINK, ' ')
    .replace(PHONE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TRIP_NOTE_MAX)
    .trim();
  return note || undefined;
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
