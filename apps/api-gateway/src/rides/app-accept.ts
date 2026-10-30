import { driverBidClient, driverClient, groupRideClient, rideClient, walletClient } from '@wheleers/db';
import { RideOfferAcceptedEvent, WalletLockedEvent } from '@wheleers/kafka-schemas';
import type { RedisClient } from '../redis/client';
import type { GatewayPublisher } from '../websocket/publisher';
import type { HandlerResponse } from '../websocket/handlers/types';
import { acceptSentFor, BOOKING_LOCK_WAIT_MS, clearPublishing, isSearchEnded, notePublishing, noteAcceptSent, releaseBookingLock, releaseStaleHoldForOther, takeBookingLock } from './booking-lock';

export interface AppAcceptInput {
  rideId: string;
  driverId: string;
  driverUserId: string;
  bidId?: string;
  paymentMethod: 'CASH' | 'WALLET';
  /** The price the app showed: it must still be the driver's price. */
  agreedFareNgn?: number;
  /** Auto-accept, not a tap: a search the rider has just ended is never booked. */
  auto?: boolean;
}

/**
 * The app's accept (ride:accept_offer), as one function: the tap in the app
 * and auto-accept book through exactly the same guards, in the same order.
 *
 *   the ride is the rider's and still open → the driver is online, fresh and
 *   free → the bid row is the price → one booking per ride (the hold) → one
 *   rider per driver (the 60-second claim) → the hold → RIDE_OFFER_ACCEPTED.
 *
 * Answers with the reply the app has always had (ride:accept_offer:accepted
 * or ride:accept_offer:rejected); throws where the handler used to throw.
 */
export async function acceptOfferInApp(
  deps: { publisher: GatewayPublisher; redis?: RedisClient },
  riderId: string,
  input: AppAcceptInput,
  timestamp: string = new Date().toISOString(),
): Promise<HandlerResponse> {
  const { redis } = deps;
  // One booking at a time on the ride, whichever door it came through (rides/booking-lock.ts).
  // A booking in progress gets a moment to finish; still busy, the app is told to try again
  // ('busy': an app that does not know it goes back to the offers, which stay).
  const lock = redis ? await takeBookingLock(redis, input.rideId, BOOKING_LOCK_WAIT_MS) : null;
  if (redis && !lock) {
    return {
      type: 'ride:accept_offer:rejected',
      payload: { rideId: input.rideId, driverId: input.driverId, reason: 'busy', message: 'Try again.' },
    };
  }
  try {
    return await acceptOnce(deps, riderId, input, timestamp);
  } finally {
    if (redis) await releaseBookingLock(redis, lock);
  }
}

async function acceptOnce(
  deps: { publisher: GatewayPublisher; redis?: RedisClient },
  riderId: string,
  input: AppAcceptInput,
  timestamp: string,
): Promise<HandlerResponse> {
  const { publisher, redis } = deps;
  const { rideId, driverId, bidId, paymentMethod } = input;
  // The driver's own user id comes from their record once it is read (never trusted from the app).
  let driverUserId = input.driverUserId;
  if (input.auto && redis && await isSearchEnded(redis, rideId)) {
    return { type: 'ride:accept_offer:rejected', payload: { rideId, driverId, reason: 'search_ended', message: 'This search has ended.' } };
  }

  // A second accept on a ride that already has a driver (double-tap on two
  // offers) must not publish a second assignment.
  // Fails closed: a lookup that errors is 'busy' (try again); a ride that does not exist is refused
  // unless it is a group match request of this caller.
  let acceptingRide: Awaited<ReturnType<typeof rideClient.findStanding>>;
  try {
    acceptingRide = await rideClient.findStanding(rideId);
  } catch {
    return { type: 'ride:accept_offer:rejected', payload: { rideId, driverId, reason: 'busy', message: 'Try again.' } };
  }
  if (!acceptingRide) {
    let groupMember: unknown = null;
    try {
      groupMember = await groupRideClient.findMatchRequestByIdForUser(rideId, riderId);
    } catch {
      return { type: 'ride:accept_offer:rejected', payload: { rideId, driverId, reason: 'busy', message: 'Try again.' } };
    }
    if (!groupMember) throw new Error('This ride is not yours.');
  }
  if (acceptingRide && acceptingRide.riderId !== riderId) {
    throw new Error('This ride is not yours.');
  }
  if (acceptingRide && acceptingRide.status !== 'REQUESTED' && acceptingRide.status !== 'MATCHING') {
    return {
      type: 'ride:accept_offer:rejected',
      payload: {
        rideId,
        driverId,
        reason: 'already_matched',
        message: 'This ride already has a driver.',
      },
    };
  }

  // ── The moment of commitment. The driver must still exist in the
  // market: online, recently seen, not already on a trip. Without this a
  // rider could pay for a driver who won another ride minutes ago or
  // whose phone died — one driver sold twice.
  const driver = await driverClient.findById(driverId).catch(() => null);
  const seenRecently =
    driver?.lastSeenAt != null && Date.now() - driver.lastSeenAt.getTime() < 2 * 60_000;
  const busyRide = driver
    ? await rideClient.findActiveByDriver(driverId).catch(() => null)
    : null;
  if (!driver || driver.status !== 'ONLINE' || !seenRecently || busyRide) {
    // Gone or on another trip: their bid is over. Only stepped away (app in
    // the background): it stays held — their open bids wait for them.
    const away = Boolean(driver) && !busyRide;
    if (!away) await driverBidClient.markWithdrawn(rideId, driverId).catch(() => {});
    if (away) {
      return {
        type: 'ride:accept_offer:rejected',
        payload: {
          rideId,
          driverId,
          reason: 'driver_away',
          message: "That driver's app is closed for a moment. Try again in a minute, or pick another offer.",
        },
      };
    }
    return {
      type: 'ride:accept_offer:rejected',
      payload: {
        rideId,
        driverId,
        reason: 'driver_unavailable',
        message: 'That driver just became unavailable. Please pick another offer.',
      },
    };
  }

  driverUserId = driver.userId;

  // ── Price truth: the bid ROW is the price, and it must be the price the
  // rider saw. A driver who changed their price just before the tap (or while
  // the accept waited) is never booked at a price the app did not show: the
  // rider is told the offer changed, and nothing is held.
  if (input.agreedFareNgn === undefined) throw new Error('Missing required field: agreedFareNgn');
  let agreedFareNgn = input.agreedFareNgn;
  const shownNgn = input.agreedFareNgn;
  // currentFareNgn: the driver's price now, so the app can show it.
  // counterOffer: the offer as it stands, in the shape of ride:counter_offer — the server sends it
  // on after this refusal, so an app that keeps the old price updates its card instead of retrying it.
  const offerChanged = (currentFareNgn: number, row: { id: string; etaSeconds: number; distanceKm: number | null }): HandlerResponse => ({
    type: 'ride:accept_offer:rejected',
    payload: {
      rideId, driverId, reason: 'offer_changed', currentFareNgn, message: 'That offer has changed — check the latest price and try again.',
      counterOffer: {
        rideId, bidId: row.id, driverId, driverUserId, counterOfferNgn: currentFareNgn,
        driverName: driver.user?.name ?? 'Driver', driverRating: driver.rating ?? 5,
        vehiclePlate: driver.vehiclePlate ?? '', vehicleModel: driver.vehicleModel ?? '',
        etaSeconds: row.etaSeconds, distanceKm: row.distanceKm ?? undefined,
      },
    },
  });
  if (bidId) {
    const bid = await driverBidClient.findById(bidId).catch(() => null);
    if (!bid || bid.rideId !== rideId || bid.driverId !== driverId || bid.status !== 'PENDING') {
      return {
        type: 'ride:accept_offer:rejected',
        payload: {
          rideId,
          driverId,
          reason: 'offer_changed',
          message: 'That offer has changed — check the latest price and try again.',
        },
      };
    }
    agreedFareNgn = Number(bid.amountNgn);
    if (Math.abs(agreedFareNgn - shownNgn) >= 0.5) return offerChanged(agreedFareNgn, bid);
  } else {
    // The app names the driver, not the bid: their bid on this ride is
    // still the price truth, and one they withdrew or the rider declined
    // can no longer be booked.
    const bids = await driverBidClient.findByRide(rideId).catch(() => []);
    const theirs = bids.filter((b) => b.driverId === driverId);
    const open = theirs.find((b) => b.status === 'PENDING');
    // A ride with a row needs that driver's open bid: no bid, no booking at a price the app names.
    // (A group seat's ride has no row and keeps the app's price.)
    if ((theirs.length > 0 || acceptingRide) && !open) {
      return {
        type: 'ride:accept_offer:rejected',
        payload: { rideId, driverId, reason: 'offer_changed', message: 'That offer is no longer open.' },
      };
    }
    if (open) {
      agreedFareNgn = Number(open.amountNgn);
      if (Math.abs(agreedFareNgn - shownNgn) >= 0.5) return offerChanged(agreedFareNgn, open);
    }
  }

  // ── Already accepted: for this driver, it is done (a repeat publishes
  // nothing); for another, the ride is being booked.
  const sent = redis ? await acceptSentFor(redis, rideId) : null;
  if (sent === driverUserId) {
    return { type: 'ride:accept_offer:accepted', payload: { rideId, driverId, agreedFareNgn } };
  }
  if (sent) {
    return {
      type: 'ride:accept_offer:rejected',
      payload: { rideId, driverId, reason: 'already_matched', message: 'Your ride is already being booked.' },
    };
  }

  // ── One booking at a time on a ride: while the rider's money is held for
  // another driver, a second accept would book two drivers. The app fetches
  // where the booking stands instead. The same driver's hold is adopted: a
  // retry after an accept that did not go out.
  // A stale one (an accept that failed, no acceptance sent, older than the lock) is let go instead.
  const heldFor = await walletClient.rideHoldOf(rideId).catch(() => null);
  const otherDriversHold = heldFor?.status === 'ACTIVE' && Boolean(heldFor.driverUserId) && heldFor.driverUserId !== driverUserId;
  if (otherDriversHold && (!redis || (await releaseStaleHoldForOther(redis, rideId, driverUserId)) === 'blocked')) {
    return {
      type: 'ride:accept_offer:rejected',
      payload: { rideId, driverId, reason: 'already_matched', message: 'Your ride is already being booked.' },
    };
  }

  // ── One driver, one rider: the same claim the WhatsApp accept takes, so
  // two riders (app or chat) cannot book the same driver at the same moment.
  // Let go of it whenever this accept does not go through.
  const claimKey = `whatsapp:driver:${driverId}:accepting`;
  let claimedNow = false;
  const releaseClaim = async () => { if (claimedNow && redis) await redis.del(claimKey).catch(() => undefined); };
  if (redis) {
    claimedNow = await redis.setIfNotExists(claimKey, rideId, 60).catch(() => false);
    const owner = claimedNow ? rideId : await redis.get(claimKey).catch(() => null);
    if (!claimedNow && owner !== null && owner !== rideId) {
      return {
        type: 'ride:accept_offer:rejected',
        payload: { rideId, driverId, reason: 'driver_unavailable', message: 'That driver is no longer available.' },
      };
    }
  }

  // ── No hold, no match. WhatsApp riders were already checked at "pay";
  // app riders could book with an empty wallet and the ride ran unsecured.
  if (paymentMethod !== 'CASH') {
    const wallet = await walletClient.findByUserId(riderId).catch(() => null);
    const balanceNgn = wallet ? Number(wallet.balanceNgn) : 0;
    const insufficient = () => ({
      type: 'ride:accept_offer:rejected',
      payload: {
        rideId,
        driverId,
        reason: 'insufficient_funds',
        requiredNgn: agreedFareNgn,
        balanceNgn,
        message: `You need ₦${Math.max(0, agreedFareNgn - balanceNgn).toLocaleString()} more in your wallet to book this ride.`,
      },
    });
    if (!wallet || balanceNgn < agreedFareNgn) {
      await releaseClaim();
      return insufficient();
    }
    try {
      const hold = await walletClient.createRideHold({
        rideId,
        walletId: wallet.id,
        riderId,
        driverUserId,
        amountNgn: agreedFareNgn,
      });
      if (!hold.applied) {
        // A hold already there must be this driver's: another driver's is another booking.
        const existing = await walletClient.rideHoldOf(rideId).catch(() => null);
        if (existing?.status === 'ACTIVE' && existing.driverUserId && existing.driverUserId !== driverUserId) {
          await releaseClaim();
          return {
            type: 'ride:accept_offer:rejected',
            payload: { rideId, driverId, reason: 'already_matched', message: 'Your ride is already being booked.' },
          };
        }
        // A hold left by an earlier attempt on this ride may carry a different fare.
        if (hold.holdAmountNgn !== agreedFareNgn) {
          const adjusted = await walletClient.adjustRideHold({ rideId, targetAmountNgn: agreedFareNgn });
          if (!adjusted) throw new Error('hold could not be adjusted');
        }
      }
      if (hold.applied) {
        // The lock used to be wallet-service's to announce; now that the
        // hold happens here, the announcement moves here with it — the
        // rider's app shows locked funds immediately, not on next refresh.
        await publisher.publishWalletEvent(
          WalletLockedEvent.parse({
            eventType: 'WALLET_LOCKED',
            userId: riderId,
            walletId: wallet.id,
            rideId,
            lockedAmountNgn: agreedFareNgn,
            reason: 'ride_fare_hold',
            timestamp: new Date().toISOString(),
          }),
        ).catch(() => undefined);
      }
    } catch {
      // Race between the balance check and the hold — same honest answer.
      await releaseClaim();
      return insufficient();
    }
  }

  const event = RideOfferAcceptedEvent.parse({
    eventType: 'RIDE_OFFER_ACCEPTED',
    rideId,
    riderId,
    driverId,
    driverUserId,
    bidId,
    agreedFareNgn,
    paymentMethod,
    timestamp,
  });

  if (redis) await notePublishing(redis, rideId, driverUserId);
  try {
    await publisher.publishRideEvent(event);
  } catch (error) {
    if (redis) await clearPublishing(redis, rideId);
    // Not sent: nothing will book this driver, so neither the claim nor the money stays.
    await releaseClaim();
    if (paymentMethod !== 'CASH') await walletClient.cancelRideHold(rideId, driverUserId).catch(() => undefined);
    throw error;
  }
  if (redis) await noteAcceptSent(redis, rideId, driverUserId);
  if (redis) await clearPublishing(redis, rideId);

  return {
    type: 'ride:accept_offer:accepted',
    payload: {
      rideId: event.rideId,
      driverId: event.driverId,
      agreedFareNgn: event.agreedFareNgn,
    },
  };
}
