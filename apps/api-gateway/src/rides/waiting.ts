import { waitingCharge, waitingDealTerms, waitingTerms, WAITING_MAX_OFFERS, WAITING_RATES_NGN, type WaitingTerms } from '@wheleers/config';
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
    // Only from the moment the rider and the driver agreed a price (nothing before, nothing without one).
    const terms = waitingDealTerms(ride);
    const charge = waitingCharge(ride.arrivedAt, until, terms);
    if (charge.feeNgn <= 0) return null;

    const askedAlready = ride.waitingStoppedAt !== null;
    const allowUnpaid = payload['canConfirmWaiting'] !== true || payload['startAnyway'] === true || askedAlready;
    const result = await waitingClient.recordAtStart({ rideId, minutes: charge.chargedMinutes, feeNgn: charge.feeNgn, allowUnpaid });
    if (result.recorded) return { minutes: result.minutes, feeNgn: result.feeNgn, paid: result.paid };

    const stoppedAt = (await waitingClient.stopMeter(rideId, until)) ?? until;
    const stopped = waitingCharge(ride.arrivedAt, stoppedAt, terms);
    throw new WaitingUnpaidError({ minutes: stopped.chargedMinutes, amountNgn: stopped.feeNgn, stoppedAt: stoppedAt.toISOString() });
  } catch (error) {
    if (error instanceof WaitingUnpaidError) throw error;
    console.error('[waiting] fee not settled at start, the trip starts anyway', { rideId, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** The waiting price between the rider and the driver (Timi, 16 Nov 2026). */
export interface WaitingDeal {
  /** The prices a minute to pick from. */
  rates: readonly number[];
  /** The free minutes after Arrived, whatever was agreed. */
  baseFreeSeconds: number;
  /** Agreed: the price a minute, and when (the meter counts from then). */
  rateNgn: number | null;
  agreedAt: string | null;
  /** The offer waiting for an answer: from the rider or the driver. */
  offer: { by: 'rider' | 'driver'; ngn: number; at: string } | null;
  /** Offers still allowed on this ride, both sides together. */
  offersLeft: number;
}

/**
 * What the screens show while the driver waits, and after: the terms, the clock and, once written, the fee.
 * `freeSeconds`/`ngnPerMinute` are this ride's own (free until the agreement, then the agreed price; ₦0 until
 * then), so an app that knows nothing of `deal` still shows what will really be charged.
 */
export interface WaitingView extends WaitingTerms {
  /** The server's clock as this was read: a phone runs the meter from the difference, never its own clock. */
  now: string;
  arrivedAt: string;
  stoppedAt: string | null;
  minutes: number | null;
  feeNgn: number | null;
  paid: boolean | null;
  deal: WaitingDeal;
}

type WaitingRow = {
  arrivedAt?: Date | null;
  waitingStoppedAt?: Date | null;
  waitingMinutes?: number | null;
  waitingFeeNgn?: unknown;
  waitingPaid?: boolean | null;
  waitingRateNgn?: number | null;
  waitingAgreedAt?: Date | null;
  waitingOfferBy?: string | null;
  waitingOfferNgn?: number | null;
  waitingOfferAt?: Date | null;
  waitingOfferCount?: number | null;
};

export function waitingDeal(ride: WaitingRow): WaitingDeal {
  const offerBy = ride.waitingOfferBy === 'RIDER' ? 'rider' : ride.waitingOfferBy === 'DRIVER' ? 'driver' : null;
  return {
    rates: WAITING_RATES_NGN,
    baseFreeSeconds: waitingTerms().freeSeconds,
    rateNgn: ride.waitingRateNgn ?? null,
    agreedAt: ride.waitingRateNgn != null && ride.waitingAgreedAt ? ride.waitingAgreedAt.toISOString() : null,
    offer: offerBy && typeof ride.waitingOfferNgn === 'number' && ride.waitingRateNgn == null
      ? { by: offerBy, ngn: ride.waitingOfferNgn, at: (ride.waitingOfferAt ?? new Date()).toISOString() }
      : null,
    offersLeft: Math.max(0, WAITING_MAX_OFFERS - (ride.waitingOfferCount ?? 0)),
  };
}

export function waitingView(ride: WaitingRow | null | undefined): WaitingView | null {
  if (!ride?.arrivedAt) return null;
  return {
    ...waitingDealTerms(ride),
    now: new Date().toISOString(),
    arrivedAt: ride.arrivedAt.toISOString(),
    stoppedAt: ride.waitingStoppedAt ? ride.waitingStoppedAt.toISOString() : null,
    minutes: ride.waitingMinutes ?? null,
    feeNgn: ride.waitingFeeNgn != null ? Number(ride.waitingFeeNgn) : null,
    paid: ride.waitingPaid ?? null,
    deal: waitingDeal(ride),
  };
}

/** One line for the rider once the trip has started; null when no fee was due. */
export function waitingLineForRider(w: { minutes: number; feeNgn: number; paid: boolean } | null | undefined): string | null {
  if (!w || !(w.feeNgn > 0)) return null;
  return w.paid
    ? `Waiting time: ${w.minutes} min · ${naira(w.feeNgn)}, paid from your wallet.`
    : `Waiting time: ${w.minutes} min · ${naira(w.feeNgn)}. Your wallet couldn't cover it, so pay your driver.`;
}
