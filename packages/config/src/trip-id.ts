/**
 * The trip ID people use: WH- and the ride's number, at least five digits.
 * Ride 1234 is WH-01234; ride 123456 is WH-123456. The UUID stays the key
 * every table joins on; this is only for riders, drivers and support.
 */
export const TRIP_ID_PREFIX = 'WH-';

export function formatTripId(tripNumber: number | null | undefined): string | null {
  if (tripNumber == null || !Number.isInteger(tripNumber) || tripNumber <= 0) return null;
  return `${TRIP_ID_PREFIX}${String(tripNumber).padStart(5, '0')}`;
}

/**
 * The ride number in something a person typed: "WH-01234", "wh1234",
 * "#1234" or "01234". Null when it is not a trip ID.
 */
export function parseTripId(text: string | null | undefined): number | null {
  const match = /^\s*(?:wh[-\s]?|#)?0*(\d{1,9})\s*$/i.exec(text ?? '');
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}
