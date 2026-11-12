import { waitingCharge, waitingTerms, type WaitingTerms } from '@wheleers/config';
import { waitingClient } from '@wheleers/db';

const naira = (n: number): string => `₦${Math.round(n).toLocaleString('en-NG')}`;

/**
 * The rider's wallet could not cover the waiting fee: the driver is asked
 * before the trip starts. The meter has stopped (it never runs on after this).
 */
export class WaitingUnpaidError extends Error {
  readonly code = 'WAITING_UNPAID';
  constructor(readonly details: { minutes: number; amountNgn: number; stoppedAt: string }) {
    super(`This rider owes ${naira(details.amountNgn)} waiting time (${details.minutes} min). It could not be collected.`);
  }
}

export interface WaitingAtStart {
  minutes: number;
  feeNgn: number;
  paid: boolean;
}

/**
 * Run when the driver starts the trip (after the code). The waiting fee is
 * taken from the rider's wallet when it covers it. When it does not:
 * - an app that can ask (`canConfirmWaiting`) gets WAITING_UNPAID the first
 *   time and the meter stops there; its "Yes, start" (`startAnyway`), or any
 *   later Start, goes through with the fee written as not paid;
 * - an older app is never stopped: the fee is written as not paid.
 * A failure here never blocks the trip.
 */
export async function settleWaitingAtStart(rideId: string, payload: Record<string, unknown>, now: Date = new Date()): Promise<WaitingAtStart | null> {
  try {
    const ride = await waitingClient.state(rideId);
    if (!ride?.arrivedAt) return null;
    if (ride.waitingFeeNgn !== null) {
      return { minutes: ride.waitingMinutes ?? 0, feeNgn: Number(ride.waitingFeeNgn), paid: ride.waitingPaid === true };
    }
    if (ride.status !== 'ARRIVED') return null;

    const until = ride.waitingStoppedAt ?? now;
    const charge = waitingCharge(ride.arrivedAt, until);
    if (charge.feeNgn <= 0) return null;

    const askedAlready = ride.waitingStoppedAt !== null;
    const allowUnpaid = payload['canConfirmWaiting'] !== true || payload['startAnyway'] === true || askedAlready;
    const result = await waitingClient.recordAtStart({ rideId, minutes: charge.chargedMinutes, feeNgn: charge.feeNgn, allowUnpaid });
    if (result.recorded) return { minutes: result.minutes, feeNgn: result.feeNgn, paid: result.paid };

    const stoppedAt = (await waitingClient.stopMeter(rideId, until)) ?? until;
    const stopped = waitingCharge(ride.arrivedAt, stoppedAt);
    throw new WaitingUnpaidError({ minutes: stopped.chargedMinutes, amountNgn: stopped.feeNgn, stoppedAt: stoppedAt.toISOString() });
  } catch (error) {
    if (error instanceof WaitingUnpaidError) throw error;
    console.error('[waiting] fee not settled at start, the trip starts anyway', { rideId, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** What the screens show while the driver waits, and after: the terms, the clock and, once written, the fee. */
export interface WaitingView extends WaitingTerms {
  /** The server's clock as this was read: a phone runs the meter from the difference, never its own clock. */
  now: string;
  arrivedAt: string;
  stoppedAt: string | null;
  minutes: number | null;
  feeNgn: number | null;
  paid: boolean | null;
}

export function waitingView(ride: {
  arrivedAt?: Date | null;
  waitingStoppedAt?: Date | null;
  waitingMinutes?: number | null;
  waitingFeeNgn?: unknown;
  waitingPaid?: boolean | null;
} | null | undefined): WaitingView | null {
  if (!ride?.arrivedAt) return null;
  return {
    ...waitingTerms(),
    now: new Date().toISOString(),
    arrivedAt: ride.arrivedAt.toISOString(),
    stoppedAt: ride.waitingStoppedAt ? ride.waitingStoppedAt.toISOString() : null,
    minutes: ride.waitingMinutes ?? null,
    feeNgn: ride.waitingFeeNgn != null ? Number(ride.waitingFeeNgn) : null,
    paid: ride.waitingPaid ?? null,
  };
}

/** One line for the rider once the trip has started; null when no fee was due. */
export function waitingLineForRider(w: { minutes: number; feeNgn: number; paid: boolean } | null | undefined): string | null {
  if (!w || !(w.feeNgn > 0)) return null;
  return w.paid
    ? `Waiting time: ${w.minutes} min · ${naira(w.feeNgn)}, paid from your wallet.`
    : `Waiting time: ${w.minutes} min · ${naira(w.feeNgn)}. Your wallet couldn't cover it, so pay your driver.`;
}
