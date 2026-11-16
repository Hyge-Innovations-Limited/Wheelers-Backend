import { isWaitingRate, waitingTerms, WAITING_MAX_OFFERS } from '@wheleers/config';
import { prisma, waitingClient } from '@wheleers/db';
import { waitingView, type WaitingView } from './waiting';

/**
 * Waiting price (Timi, 16 Nov 2026). When the free minutes are over the rider
 * is asked: cancel, or keep the driver waiting at a price a minute (₦40–100).
 * The driver accepts it or counters with another price; the rider accepts the
 * counter, offers again, or cancels. Nothing is charged until one side takes
 * the other's price; from then the meter runs at it (rides/waiting.ts).
 *
 *   rider   offer <₦>   any time after the free minutes, until agreed
 *   driver  offer <₦>   only to answer an offer on the table (a counter)
 *   either  accept <₦>  the other side's offer, exactly that price
 *
 * Offering the other side's own price is taking it. Cancelling is the usual
 * cancel, free for both. The bot, the ride page and both apps all come here.
 */

export type WaitingSide = 'rider' | 'driver';
export type WaitingAction = { action: 'offer' | 'accept'; ngn: number };

export class WaitingDealError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

/** What changed, for whoever tells the other side (kafka/consumer.ts). */
export type WaitingDealChange = { rideId: string; riderId: string; driverUserId: string | null; by: WaitingSide; kind: 'offer' | 'agreed'; ngn: number; waiting: WaitingView | null };

type Hook = (change: WaitingDealChange) => Promise<void>;
let hook: Hook | undefined;

export function setWaitingDealHook(next: Hook | undefined): void {
  hook = next;
}

/** The body of a request: { action: 'offer' | 'accept', ngn }. Throws a 400 for anything else. */
export function readWaitingAction(body: unknown): WaitingAction {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const action = b.action === 'offer' || b.action === 'accept' ? b.action : null;
  const ngn = typeof b.ngn === 'number' ? b.ngn : typeof b.ngn === 'string' ? Number(b.ngn) : NaN;
  if (!action) throw new WaitingDealError('Pick an offer or accept.', 400, 'BAD_ACTION');
  if (!isWaitingRate(ngn)) throw new WaitingDealError('Pick a price from ₦40 to ₦100 a minute.', 400, 'BAD_RATE');
  return { action, ngn };
}

async function rideFor(rideId: string) {
  return prisma.ride.findUnique({
    where: { id: rideId },
    select: {
      id: true, riderId: true, status: true, arrivedAt: true, waitingStoppedAt: true, waitingMinutes: true, waitingFeeNgn: true, waitingPaid: true,
      waitingRateNgn: true, waitingAgreedAt: true, waitingOfferBy: true, waitingOfferNgn: true, waitingOfferAt: true, waitingOfferCount: true,
      driver: { select: { userId: true } },
    },
  });
}

/** Why an offer or an acceptance could not go through, in the words the screens show. */
function refusal(ride: NonNullable<Awaited<ReturnType<typeof rideFor>>>, side: WaitingSide, act: WaitingAction, now: Date): WaitingDealError {
  if (String(ride.status) !== 'ARRIVED' || ride.waitingStoppedAt) return new WaitingDealError('The driver is no longer waiting.', 409, 'NOT_WAITING');
  if (ride.waitingRateNgn != null) return new WaitingDealError(`₦${ride.waitingRateNgn}/min is already agreed.`, 409, 'AGREED');
  const freeEnds = (ride.arrivedAt?.getTime() ?? 0) + waitingTerms().freeSeconds * 1000;
  if (now.getTime() < freeEnds) return new WaitingDealError('Waiting is still free.', 409, 'STILL_FREE');
  if ((ride.waitingOfferCount ?? 0) >= WAITING_MAX_OFFERS) return new WaitingDealError('No more offers on this trip. Accept the last one or cancel.', 409, 'TOO_MANY');
  if (act.action === 'accept') return new WaitingDealError('That price has changed.', 409, 'OFFER_CHANGED');
  if (side === 'driver') return new WaitingDealError('Wait for the rider’s price.', 409, 'NO_OFFER');
  return new WaitingDealError('Could not send that. Try again.', 409, 'NOT_SENT');
}

/**
 * The rider or the assigned driver of `rideId` (`userId`) offers or accepts a price.
 * Returns the ride's waiting block after it; throws WaitingDealError when it cannot be done.
 */
export async function actOnWaiting(rideId: string, userId: string, act: WaitingAction, now: Date = new Date()): Promise<WaitingView | null> {
  const ride = await rideFor(rideId);
  if (!ride) throw new WaitingDealError('Trip not found.', 404, 'NO_RIDE');
  const side: WaitingSide | null = ride.riderId === userId ? 'rider' : ride.driver?.userId === userId ? 'driver' : null;
  if (!side) throw new WaitingDealError('This is not your trip.', 403, 'NOT_YOURS');
  const by = side === 'rider' ? 'RIDER' : 'DRIVER';
  const other = side === 'rider' ? 'DRIVER' : 'RIDER';

  // Offering exactly the other side's price is taking it.
  const takes = act.action === 'accept' || (ride.waitingOfferBy === other && ride.waitingOfferNgn === act.ngn);
  const done = takes
    ? await waitingClient.accept({ rideId, by, ngn: act.ngn, now })
    : ride.waitingOfferBy === by && ride.waitingOfferNgn === act.ngn
      ? true // the same offer again: nothing new to send
      : await waitingClient.offer({ rideId, by, ngn: act.ngn, now, freeSeconds: waitingTerms().freeSeconds, maxOffers: WAITING_MAX_OFFERS });
  if (!done) {
    const fresh = await rideFor(rideId);
    throw refusal(fresh ?? ride, side, act, now);
  }
  const repeated = !takes && ride.waitingOfferBy === by && ride.waitingOfferNgn === act.ngn;
  const after = await rideFor(rideId);
  const view = waitingView(after);
  if (!repeated && hook) {
    const change: WaitingDealChange = { rideId, riderId: ride.riderId, driverUserId: ride.driver?.userId ?? null, by: side, kind: takes ? 'agreed' : 'offer', ngn: act.ngn, waiting: view };
    void hook(change).catch((error) => console.warn('[waiting-deal] could not tell the other side', { rideId, error: error instanceof Error ? error.message : String(error) }));
  }
  return view;
}
