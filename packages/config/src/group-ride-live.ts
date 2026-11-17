import { MIN_FARE_NGN } from './pricing';

/**
 * Group ride on live searches (Timi, 16–17 Nov 2026). Nobody switches it on: while riders search for a driver,
 * those heading along the same road are offered to ride together, 25% off each seat. The rules live here so the
 * group-ride service (matching), the gateway (offers, booking) and the screens agree.
 *
 * GROUP_RIDE_LIVE: off (default), dryrun (match and log what would be offered, offer nothing), on.
 */

export type GroupRideLiveMode = 'off' | 'dryrun' | 'on';

export function groupRideLiveMode(env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {}): GroupRideLiveMode {
  const raw = (env['GROUP_RIDE_LIVE'] ?? '').trim().toLowerCase();
  return raw === 'on' || raw === 'dryrun' ? raw : 'off';
}

export const GROUP_RIDE_LIVE = {
  /** Off each rider's own price when they ride together. */
  SEAT_DISCOUNT: 0.25,
  /** People in the car, all riders together (the People chip counts). */
  MAX_PEOPLE: 3,
  /** Riders in one group. */
  MAX_RIDERS: 3,
  /** How long riders have to say Ride together. */
  OFFER_SECONDS: 20,
  /** A ride is in one offer at a time, for this long at most. */
  HOLD_SECONDS: 45,
  /** No rider spends more than the bigger of these extra in the car. */
  MAX_EXTRA_MINUTES: 8,
  MAX_EXTRA_SHARE: 0.25,
  /** Riders must head the same way, within this many degrees. */
  MAX_HEADING_DEGREES: 40,
  /** The map grid: squares about 700 m wide (Lagos is near the equator, so degrees are near square). */
  CELL_DEGREES: 0.0065,
  /** A route is filed under the squares of points this far apart. */
  SAMPLE_METRES: 200,
  /** Estimated driving: straight line times this, at this speed (Lagos traffic). Used for every option alike. */
  ROAD_FACTOR: 1.4,
  AVERAGE_KMH: 20,
  /** A group must save at least this much driving against everyone riding alone. */
  MIN_SAVED_MINUTES: 5,
  /** Matching rounds. */
  ROUND_SECONDS: 5,
} as const;

const roundTo50 = (n: number) => Math.round(n / 50) * 50;

/** The lowest a seat goes: the 25% off the lowest fare (₦1,950 when the lowest fare is ₦2,600). */
export function groupSeatFloorNgn(minFareNgn: number = MIN_FARE_NGN): number {
  return roundTo50(minFareNgn * (1 - GROUP_RIDE_LIVE.SEAT_DISCOUNT));
}

/** A rider's seat: their own price less 25%, to ₦50, never under the seat floor and never above their own price. */
export function groupSeatPriceNgn(ownPriceNgn: number, minFareNgn: number = MIN_FARE_NGN): number {
  if (!(ownPriceNgn > 0)) return 0;
  const seat = Math.max(groupSeatFloorNgn(minFareNgn), roundTo50(ownPriceNgn * (1 - GROUP_RIDE_LIVE.SEAT_DISCOUNT)));
  return Math.min(ownPriceNgn, seat);
}
