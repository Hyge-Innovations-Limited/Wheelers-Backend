/**
 * The driver's face check before every ride (Timi, 18 Nov 2026). When a driver is booked their app asks for a face
 * scan (camera only, three frames with a head turn); the server compares it with the driver's KYC selfie using a
 * free face library we run ourselves (@vladmandic/face-api). A match: the trip goes on. No match after the tries, or
 * no scan in time: the ride goes back to the search for the rider. The check itself broken (or the driver's selfie
 * unusable): that driver takes no rides until it works, and the team is told on Telegram. Scan frames are kept 30 days.
 *
 *   FACE_CHECK                off | shadow | on (default off). shadow: drivers scan and every result is recorded and
 *                             alerted, but no ride is cancelled and no driver is held back (to set the match line on
 *                             real faces first). on: enforced.
 *   FACE_MATCH_MAX_DISTANCE   how close two faces must be to be one person (default 0.55; lower is stricter).
 */
export type FaceCheckMode = 'off' | 'shadow' | 'on';

export function faceCheckMode(): FaceCheckMode {
  const raw = String((typeof process !== 'undefined' ? process.env?.FACE_CHECK : '') ?? '').trim().toLowerCase();
  return raw === 'on' || raw === 'shadow' ? raw : 'off';
}

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

export const FACE_MATCH_MAX_DISTANCE = envNumber('FACE_MATCH_MAX_DISTANCE', 0.55, 0.3, 0.8);
/** Seconds the driver has to pass, from the booking. */
export const FACE_CHECK_SECONDS = 120;
/** Scans that did not match before the ride goes back to the search. */
export const FACE_CHECK_TRIES = 3;
/** Scans in all (unclear ones too) before it counts as failed. */
export const FACE_CHECK_MAX_SUBMITS = 6;
/** How far the head must turn between frames (nose against the eyes, as a share of the eye width). */
export const FACE_TURN_MIN_DELTA = 0.12;
export const FACE_FRAMES_KEEP_DAYS = 30;
/** A driver held back because the check could not run: for this long, then they may try again. */
export const FACE_BLOCK_MINUTES = 30;
