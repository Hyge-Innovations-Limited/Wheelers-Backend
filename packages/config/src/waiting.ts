/**
 * Waiting time (Timi, 12 Nov 2026): once the driver taps Arrived the rider has
 * 5 minutes free, then pays ₦70 for every full minute after that, until the
 * trip starts (the code is entered) or the meter is stopped (the driver said No
 * to starting a trip whose waiting could not be collected).
 *
 * The server's clock only: the phones show what the server says.
 * WAITING_FREE_MINUTES and WAITING_NGN_PER_MINUTE override the numbers.
 */

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

export const WAITING_FREE_MINUTES = envNumber('WAITING_FREE_MINUTES', 5, 0, 60);
export const WAITING_NGN_PER_MINUTE = envNumber('WAITING_NGN_PER_MINUTE', 70, 0, 5_000);

/** What the screens need to run the meter themselves between updates. */
export interface WaitingTerms {
  freeSeconds: number;
  ngnPerMinute: number;
}

export function waitingTerms(): WaitingTerms {
  return { freeSeconds: Math.round(WAITING_FREE_MINUTES * 60), ngnPerMinute: WAITING_NGN_PER_MINUTE };
}

export interface WaitingCharge {
  /** From Arrived to the end of the meter, whole seconds. */
  waitedSeconds: number;
  /** Full minutes past the free ones: what is paid for. */
  chargedMinutes: number;
  feeNgn: number;
}

/** The waiting fee between the driver's arrival and `until` (the start, or the moment the meter stopped). */
export function waitingCharge(arrivedAt: Date | string | null | undefined, until: Date | string, terms: WaitingTerms = waitingTerms()): WaitingCharge {
  const from = arrivedAt ? new Date(arrivedAt).getTime() : NaN;
  const to = new Date(until).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return { waitedSeconds: 0, chargedMinutes: 0, feeNgn: 0 };
  const waitedSeconds = Math.floor((to - from) / 1000);
  const chargedMinutes = Math.max(0, Math.floor((waitedSeconds - terms.freeSeconds) / 60));
  return { waitedSeconds, chargedMinutes, feeNgn: chargedMinutes * terms.ngnPerMinute };
}
