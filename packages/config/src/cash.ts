/**
 * Pay with cash (Timi, 18 Nov 2026). Any rider may pay the driver in cash once
 * the price is agreed (never a group ride). Nothing is held from the rider; at
 * the end Wheelers' share of the fare (the same lines as a wallet ride) is taken
 * from the driver's wallet, below zero if it has to be. A driver who owes more
 * than CASH_OWED_LIMIT_NGN gets no new requests until a deposit brings it back.
 * A trip already running always finishes.
 *
 * CASH_RIDES_ENABLED=false turns cash off for new bookings (rides already booked
 * with cash still settle).
 */

/** Owing up to this is fine; more than this and requests stop. */
export const CASH_OWED_LIMIT_NGN = 1_000;

export function cashRidesEnabled(): boolean {
  const raw = typeof process !== 'undefined' ? process.env?.CASH_RIDES_ENABLED : undefined;
  return String(raw ?? '').trim().toLowerCase() !== 'false';
}

/** What a driver owes Wheelers: the part of the balance below zero. */
export function cashOwedNgn(balanceNgn: number): number {
  return Number.isFinite(balanceNgn) && balanceNgn < 0 ? Math.round(-balanceNgn * 100) / 100 : 0;
}

/** Owes more than the limit: no new requests. */
export function owesPastLimit(balanceNgn: number): boolean {
  return cashOwedNgn(balanceNgn) > CASH_OWED_LIMIT_NGN;
}
