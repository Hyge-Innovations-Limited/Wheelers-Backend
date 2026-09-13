import { randomUUID } from 'crypto';
import {
  GoogleMapsRoutePlanner,
  RIDE,
  calculateSuggestedFare,
  validateDriverOffer,
  validateRiderOffer,
} from '@wheleers/config';
import { chatClient, driverClient, groupRideClient, referralClient, rideClient, driverBidClient, walletClient } from '@wheleers/db';
import {
  ChatMessageSentEvent,
  DisputeOpenedEvent,
  FeedbackLoggedEvent,
  RideCancelledEvent,
  RideCompletionRequestedEvent,
  RideCounterOfferEvent,
  RideDriverRejectedEvent,
  RideOfferAcceptedEvent,
  RideRiderCounterOfferEvent,
  RideArrivedEvent,
  RideRouteUpdateRequestedEvent,
  RideRequestedEvent,
  RideStopConfirmedEvent,
  RideStartedEvent,
  WalletLockedEvent,
} from '@wheleers/kafka-schemas';
import type { GatewayAuthContext } from '../../types';
import { getBoolean, getNumber, getRecord, getString } from '../../utils/object';
import { estimateEtaSeconds, haversineKm } from '../../utils/geo';
import { findGroupRideSuggestion } from '../../group-ride/suggestion';
import type { GatewayPublisher } from '../publisher';
import type { HandlerResponse } from './types';
import { buildRideEstimatePricing } from '../../pricing/ride-estimate';

interface LatLngAddress {
  lat: number;
  lng: number;
  address: string;
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = getString(payload, key);
  if (!value) throw new Error(`Missing required field: ${key}`);
  return value;
}

/**
 * Counter-offers re-open the price after the initial offer was validated, so
 * they have to clear the same bar — otherwise either side can haggle a ride
 * below the minimum fare and the floor only applies to the first offer.
 *
 * A driver additionally has a CEILING (₦500/km): the rider names the price on
 * Wheelers, so a driver may haggle upward but not without limit.
 */
/**
 * The trip belongs to one driver. Without this any driver who ever saw the
 * request could start, arrive, or COMPLETE someone else's ride — and be paid
 * for it, because settlement trusted the driver id on the event.
 */
async function assertDriverOwnsRide(rideId: string, auth: { driverId?: string | null }) {
  const ride = await rideClient.findById(rideId).catch(() => null);
  if (!ride) throw new Error('This ride no longer exists.');
  if (!auth.driverId || ride.driverId !== auth.driverId) {
    throw new Error('This ride is not assigned to you.');
  }
  return ride;
}

async function assertRideOpenForBids(rideId: string) {
  const ride = await rideClient.findById(rideId).catch(() => null);
  if (!ride) throw new Error('This request no longer exists.');
  if (ride.status !== 'REQUESTED' && ride.status !== 'MATCHING') {
    throw new Error('This request is no longer open.');
  }
  return ride;
}

async function assertOfferWithinBand(
  rideId: string,
  offerNgn: number,
  who: 'rider' | 'driver',
): Promise<void> {
  const context = await resolveFareContext(rideId);

  // Unknown ride: bidding must not be blocked by a lookup we could not resolve.
  if (context === null) {
    console.warn('[api-gateway][ride] could not resolve a fare to validate the counter-offer against', {
      rideId,
      who,
      offerNgn,
    });
    return;
  }

  const { suggestedFareNgn, distanceKm } = context;
  const validation =
    who === 'driver'
      ? validateDriverOffer(offerNgn, suggestedFareNgn, distanceKm)
      : validateRiderOffer(offerNgn, suggestedFareNgn);

  if (!validation.valid) {
    console.warn('[api-gateway][ride] counter-offer rejected outside the fare band', {
      rideId,
      who,
      offerNgn,
      minOfferNgn: validation.minOfferNgn,
      maxOfferNgn: 'maxOfferNgn' in validation ? validation.maxOfferNgn : undefined,
      suggestedFareNgn,
      distanceKm,
    });
    throw new Error(validation.reason ?? `Offer must be at least ${validation.minOfferNgn} NGN.`);
  }
}

/**
 * A group ride's rideId is a GroupRideMatchRequest id, not a Ride id — no Ride
 * row exists for it, so looking only in `Ride` throws and kills bidding on
 * every group ride. Check both, and return null when neither knows the ride.
 */
async function resolveFareContext(
  rideId: string,
): Promise<{ suggestedFareNgn: number; distanceKm?: number } | null> {
  const ride = await rideClient.findById(rideId).catch(() => null);
  if (ride) {
    return {
      suggestedFareNgn:
        ride.fareEstimateNgn !== null && ride.fareEstimateNgn !== undefined
          ? Number(ride.fareEstimateNgn)
          : 0,
      distanceKm:
        ride.distanceKm !== null && ride.distanceKm !== undefined
          ? Number(ride.distanceKm)
          : undefined,
    };
  }

  const groupRequest = await groupRideClient.findMatchRequestById(rideId).catch(() => null);
  if (groupRequest) {
    // fareEstimateNgn on a match request is the rider's OWN seat offer — the
    // price actually being negotiated. Validating a seat bid against the solo
    // fare for the same leg rejected every legitimately-cheap seat (a seat is
    // deliberately cheaper than riding alone).
    const seatOfferNgn =
      groupRequest.fareEstimateNgn !== null && groupRequest.fareEstimateNgn !== undefined
        ? Number(groupRequest.fareEstimateNgn)
        : 0;
    // A seat's share of one leg is not the leg itself, so the per-km ceiling
    // does not apply to seat bids — distance stays undefined here.
    if (seatOfferNgn > 0) return { suggestedFareNgn: seatOfferNgn };

    if (groupRequest.plannedDistanceKm) {
      return {
        suggestedFareNgn: calculateSuggestedFare(groupRequest.plannedDistanceKm).suggestedFareNgn,
      };
    }
    return { suggestedFareNgn: 0 };
  }

  return null;
}

/**
 * Driver apps used to hardcode etaSeconds on every bid, so riders saw the
 * same "5 min away" for every driver. Recompute distance and ETA from the
 * driver's last known position and the ride's pickup; fall back to the
 * client-supplied value only when either side is missing.
 */
async function computeBidProximity(
  driverUserId: string,
  rideId: string,
  fallbackEtaSeconds: number,
): Promise<{ etaSeconds: number; distanceKm?: number }> {
  try {
    const [driver, ride] = await Promise.all([
      driverClient.findByUserId(driverUserId),
      rideClient.findById(rideId),
    ]);
    if (driver && driver.lat != null && driver.lng != null && ride) {
      const distanceKm =
        Math.round(haversineKm(driver.lat, driver.lng, ride.pickupLat, ride.pickupLng) * 100) / 100;
      return { etaSeconds: estimateEtaSeconds(distanceKm), distanceKm };
    }
  } catch {
    // fall through to the client value
  }
  return { etaSeconds: fallbackEtaSeconds };
}

function requireNumber(payload: Record<string, unknown>, key: string): number {
  const value = getNumber(payload, key);
  if (value === undefined) throw new Error(`Missing required field: ${key}`);
  return value;
}

function parseLatLng(payload: Record<string, unknown>, key: string): LatLngAddress {
  const value = getRecord(payload, key);
  if (!value) {
    throw new Error(`Missing required field: ${key}`);
  }

  const lat = getNumber(value, 'lat');
  const lng = getNumber(value, 'lng');
  const address = getString(value, 'address');

  if (lat === undefined || lng === undefined || !address) {
    throw new Error(`Invalid ${key} payload`);
  }

  return { lat, lng, address };
}

function parseStopList(payload: Record<string, unknown>, key: string): LatLngAddress[] {
  const value = payload[key];
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${key} payload`);
  }

  return value.map((item, index) => {
    if (!getRecord({ item }, 'item')) {
      throw new Error(`Invalid ${key}[${index}] payload`);
    }

    return parseLatLng({ [key]: item }, key);
  });
}

function parsePaymentMethod(value: unknown): 'CASH' | 'WALLET' {
  const upper = typeof value === 'string' ? value.toUpperCase() : value;
  if (upper === 'CASH') return 'CASH';
  return 'WALLET';
}

function normalizeEndedBy(value: unknown): 'both_confirmed' | 'auto_gps' | 'admin' {
  if (value === 'auto_gps' || value === 'admin') return value;
  return 'both_confirmed';
}

function normalizeReviewerRole(value: unknown): 'rider' | 'driver' {
  if (value === 'driver') return 'driver';
  return 'rider';
}

function normalizeOpenedByRole(value: unknown): 'rider' | 'driver' {
  if (value === 'driver') return 'driver';
  return 'rider';
}

export async function handleRideMessage(
  type: string,
  payload: Record<string, unknown>,
  auth: GatewayAuthContext,
  publisher: GatewayPublisher,
  routePlanner: GoogleMapsRoutePlanner,
): Promise<HandlerResponse | null> {
  const timestamp = new Date().toISOString();

  if (type === 'ride:request') {
    const rideId = getString(payload, 'rideId') ?? randomUUID();
    const pickup = parseLatLng(payload, 'pickup');
    const destination = parseLatLng(payload, 'destination');
    const stops = parseStopList(payload, 'stops');
    const paymentMethod = parsePaymentMethod(payload['paymentMethod']);
    const plannedRoute = await routePlanner.planRoute({
      origin: pickup,
      stops,
      destination,
    });

    const suggestedFareNgn = plannedRoute.suggestedFareNgn;
    const minOfferNgn = plannedRoute.minOfferNgn;
    const ratePerKmNgn = plannedRoute.ratePerKmNgn;

    // Rider's offer — defaults to suggested fare if not provided
    let riderOfferNgn = getNumber(payload, 'offerNgn') ?? suggestedFareNgn;

    // Validate rider's offer
    const validation = validateRiderOffer(riderOfferNgn, suggestedFareNgn);
    if (!validation.valid) {
      return {
        type: 'ride:request:rejected',
        payload: {
          rideId,
          error: validation.reason,
          suggestedFareNgn,
          minOfferNgn: validation.minOfferNgn,
        },
      };
    }

    const useReferralCashback =
      getBoolean(payload, 'useReferralCashback') ?? false;
    const requestedReferralCashbackNgn = getNumber(
      payload,
      'requestedReferralCashbackNgn',
    );
    let referralCashbackAppliedNgn = 0;
    let fareEstimateNgn = suggestedFareNgn;

    if (useReferralCashback) {
      const reservation = await referralClient.reserveRideCashback({
        userId: auth.userId,
        rideId,
        fareNgn: suggestedFareNgn,
        requestedAmountNgn: requestedReferralCashbackNgn,
      });
      referralCashbackAppliedNgn = reservation.reservedCashbackNgn;
      fareEstimateNgn = Math.max(
        0,
        suggestedFareNgn - referralCashbackAppliedNgn,
      );
    }

    const event = RideRequestedEvent.parse({
      eventType: 'RIDE_REQUESTED',
      rideId,
      riderId: auth.userId,
      pickup,
      destination,
      stops,
      plannedDistanceKm: plannedRoute.distanceKm,
      plannedDurationSeconds: plannedRoute.durationSeconds,
      fareEstimateNgn,
      paymentMethod,
      riderOfferNgn,
      suggestedFareNgn,
      minOfferNgn,
      ratePerKmNgn,
      fareBeforeCashbackNgn:
        referralCashbackAppliedNgn > 0
          ? suggestedFareNgn
          : undefined,
      referralCashbackAppliedNgn:
        referralCashbackAppliedNgn > 0 ? referralCashbackAppliedNgn : undefined,
      route: plannedRoute.geometry,
      timestamp,
    });

    try {
      await publisher.publishRideEvent(event);
    } catch (error) {
      if (referralCashbackAppliedNgn > 0) {
        await referralClient.releaseRideCashback(rideId).catch((releaseError) => {
          console.warn('[referrals] cashback release after publish failure failed', {
            rideId,
            error:
              releaseError instanceof Error
                ? releaseError.message
                : String(releaseError),
          });
        });
      }
      throw error;
    }

    // Every normal booking is a potential group ride — if open group requests
    // share this corridor, surface it. Never blocks or fails the booking.
    const groupSuggestion = await findGroupRideSuggestion(auth.userId, pickup, destination).catch(
      () => null,
    );

    return {
      type: 'ride:request:accepted',
      payload: {
        rideId: event.rideId,
        status: 'bidding',
        pickup,
        destination,
        stops,
        route: plannedRoute.geometry,
        groupSuggestion: groupSuggestion ?? undefined,
        plannedDistanceKm: event.plannedDistanceKm,
        plannedDurationSeconds: event.plannedDurationSeconds,
        paymentMethod,
        riderOfferNgn,
        suggestedFareNgn,
        minOfferNgn,
        ratePerKmNgn,
        // When bidding closes. Sent as an absolute instant so the rider's
        // countdown is right even if they leave the screen and come back —
        // a client-side timer started at mount would quietly reset.
        bidsCloseAt: new Date(Date.now() + RIDE.BID_TIMEOUT_SECONDS * 1000).toISOString(),
        fareEstimateNgn: event.fareEstimateNgn,
        fareBeforeCashbackNgn: event.fareBeforeCashbackNgn,
        referralCashbackAppliedNgn,
        pricingCurrency: 'NGN',
      },
    };
  }

  if (type === 'ride:counter_offer') {
    const counterRideId = requireString(payload, 'rideId');
    const proximity = await computeBidProximity(
      auth.userId,
      counterRideId,
      requireNumber(payload, 'etaSeconds'),
    );
    const event = RideCounterOfferEvent.parse({
      eventType: 'RIDE_COUNTER_OFFER',
      rideId: counterRideId,
      riderId: requireString(payload, 'riderId'),
      driverId: getString(payload, 'driverId') ?? auth.driverId ?? auth.userId,
      driverUserId: auth.userId,
      counterOfferNgn: requireNumber(payload, 'counterOfferNgn'),
      driverName: requireString(payload, 'driverName'),
      driverRating: requireNumber(payload, 'driverRating'),
      vehiclePlate: requireString(payload, 'vehiclePlate'),
      vehicleModel: requireString(payload, 'vehicleModel'),
      etaSeconds: proximity.etaSeconds,
      distanceKm: proximity.distanceKm,
      timestamp,
    });

    await assertOfferWithinBand(event.rideId, event.counterOfferNgn, 'driver');

    await publisher.publishRideEvent(event);

    return {
      type: 'ride:counter_offer:accepted',
      payload: {
        rideId: event.rideId,
        counterOfferNgn: event.counterOfferNgn,
      },
    };
  }

  if (type === 'ride:accept_offer') {
    const rideId = requireString(payload, 'rideId');
    const driverId = requireString(payload, 'driverId');
    const driverUserId = requireString(payload, 'driverUserId');
    const bidId = getString(payload, 'bidId');
    const paymentMethod = parsePaymentMethod(payload['paymentMethod']);

    // A second accept on a ride that already has a driver (double-tap on two
    // offers) must not publish a second assignment.
    const acceptingRide = await rideClient.findById(rideId).catch(() => null);
    if (acceptingRide && acceptingRide.riderId !== auth.userId) {
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
      await driverBidClient.markWithdrawn(rideId, driverId).catch(() => {});
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

    // ── Price truth: when the bid's identity is given, the bid ROW is the
    // price — a stale card on the rider's screen can never set the amount.
    let agreedFareNgn = requireNumber(payload, 'agreedFareNgn');
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
    }

    // ── No hold, no match. WhatsApp riders were already checked at "pay";
    // app riders could book with an empty wallet and the ride ran unsecured.
    if (paymentMethod !== 'CASH') {
      const wallet = await walletClient.findByUserId(auth.userId).catch(() => null);
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
      if (!wallet || balanceNgn < agreedFareNgn) return insufficient();
      try {
        const hold = await walletClient.createRideHold({
          rideId,
          walletId: wallet.id,
          riderId: auth.userId,
          driverUserId,
          amountNgn: agreedFareNgn,
        });
        if (hold.applied) {
          // The lock used to be wallet-service's to announce; now that the
          // hold happens here, the announcement moves here with it — the
          // rider's app shows locked funds immediately, not on next refresh.
          await publisher.publishWalletEvent(
            WalletLockedEvent.parse({
              eventType: 'WALLET_LOCKED',
              userId: auth.userId,
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
        return insufficient();
      }
    }

    const event = RideOfferAcceptedEvent.parse({
      eventType: 'RIDE_OFFER_ACCEPTED',
      rideId,
      riderId: auth.userId,
      driverId,
      driverUserId,
      bidId,
      agreedFareNgn,
      paymentMethod,
      timestamp,
    });

    await publisher.publishRideEvent(event);

    return {
      type: 'ride:accept_offer:accepted',
      payload: {
        rideId: event.rideId,
        driverId: event.driverId,
        agreedFareNgn: event.agreedFareNgn,
      },
    };
  }

  if (type === 'ride:rider_counter_offer') {
    // driverId is optional by design: with one, the rider is haggling with a
    // single driver; without one, they have moved their own price and every
    // candidate driver should see the new number. The schema has always
    // allowed both — this handler used to reject the second form.
    const event = RideRiderCounterOfferEvent.parse({
      eventType: 'RIDE_RIDER_COUNTER_OFFER',
      rideId: requireString(payload, 'rideId'),
      riderId: auth.userId,
      driverId: getString(payload, 'driverId'),
      counterOfferNgn: requireNumber(payload, 'counterOfferNgn'),
      timestamp,
    });

    await assertOfferWithinBand(event.rideId, event.counterOfferNgn, 'rider');

    await publisher.publishRideEvent(event);

    return {
      type: 'ride:rider_counter_offer:accepted',
      payload: {
        rideId: event.rideId,
        driverId: event.driverId,
        counterOfferNgn: event.counterOfferNgn,
      },
    };
  }

  if (type === 'ride:route:update') {
    const riderId = getString(payload, 'riderId') ?? auth.userId;
    const origin = getRecord(payload, 'origin') ? parseLatLng(payload, 'origin') : undefined;
    const destination = parseLatLng(payload, 'destination');
    const stops = parseStopList(payload, 'stops');
    const plannedRoute = origin
      ? await routePlanner.planRoute({
          origin,
          stops,
          destination,
        })
      : null;
    const event = RideRouteUpdateRequestedEvent.parse({
      eventType: 'RIDE_ROUTE_UPDATE_REQUESTED',
      rideId: requireString(payload, 'rideId'),
      riderId,
      driverId: getString(payload, 'driverId'),
      destination,
      stops,
      plannedDistanceKm: plannedRoute?.distanceKm,
      plannedDurationSeconds: plannedRoute?.durationSeconds,
      fareEstimateNgn: plannedRoute?.suggestedFareNgn,
      route: plannedRoute?.geometry,
      updatedBy: auth.driverId ? 'driver' : 'rider',
      timestamp,
    });

    await publisher.publishRideEvent(event);
    return {
      type: 'ride:route:update:accepted',
      payload: {
        rideId: event.rideId,
        destination,
        stops,
        route: plannedRoute?.geometry,
        plannedDistanceKm: event.plannedDistanceKm,
        plannedDurationSeconds: event.plannedDurationSeconds,
        ...buildRideEstimatePricing(event.plannedDistanceKm),
      },
    };
  }

  if (type === 'ride:stop:confirm') {
    if (auth.driverId) await assertDriverOwnsRide(requireString(payload, 'rideId'), auth);
    const driverId = getString(payload, 'driverId') ?? auth.driverId ?? auth.userId;
    const event = RideStopConfirmedEvent.parse({
      eventType: 'RIDE_STOP_CONFIRMED',
      rideId: requireString(payload, 'rideId'),
      riderId: requireString(payload, 'riderId'),
      driverId,
      confirmedBy: auth.driverId ? 'driver' : 'rider',
      timestamp,
    });

    await publisher.publishRideEvent(event);

    return {
      type: 'ride:stop:confirm:accepted',
      payload: { rideId: event.rideId },
    };
  }

  if (type === 'ride:cancel') {
    const rideId = requireString(payload, 'rideId');
    const cancelledBy: 'rider' | 'driver' = auth.driverId ? 'driver' : 'rider';

    // riderId must be the RIDER, not whoever sent the message. This was
    // auth.userId, so a driver-initiated cancel published the driver's own id
    // as riderId — the gateway then sent "ride cancelled" back to the driver
    // and the rider, the one person who needed to know, was never told.
    const ride = await rideClient.findById(rideId).catch(() => null);
    const riderId = ride?.riderId ?? (cancelledBy === 'rider' ? auth.userId : undefined);
    if (!riderId) {
      throw new Error('Could not resolve the rider for this ride.');
    }
    if (ride) {
      const isParty = cancelledBy === 'driver'
        ? ride.driverId === auth.driverId
        : ride.riderId === auth.userId;
      if (!isParty) throw new Error('This ride is not yours to cancel.');
    }

    const event = RideCancelledEvent.parse({
      eventType: 'RIDE_CANCELLED',
      rideId,
      riderId,
      driverId: getString(payload, 'driverId') ?? ride?.driverId ?? auth.driverId,
      reason: getString(payload, 'reason'),
      cancelledBy,
      driverUserId: cancelledBy === 'driver' ? auth.userId : undefined,
      timestamp,
    });

    await publisher.publishRideEvent(event);

    return {
      type: 'ride:cancel:accepted',
      payload: { rideId: event.rideId },
    };
  }

  if (type === 'ride:start') {
    await assertDriverOwnsRide(requireString(payload, 'rideId'), auth);
    const driverId = auth.driverId;
    if (!driverId) throw new Error('Missing required field: driverId');

    const event = RideStartedEvent.parse({
      eventType: 'RIDE_STARTED',
      rideId: requireString(payload, 'rideId'),
      riderId: requireString(payload, 'riderId'),
      driverId,
      lockedFareNgn: requireNumber(payload, 'lockedFareNgn'),
      paymentMethod: parsePaymentMethod(payload['paymentMethod']),
      startedAt: getString(payload, 'startedAt') ?? timestamp,
      timestamp,
    });

    await publisher.publishRideEvent(event);

    return {
      type: 'ride:start:accepted',
      payload: { rideId: event.rideId },
    };
  }

  if (type === 'ride:end') {
    await assertDriverOwnsRide(requireString(payload, 'rideId'), auth);
    const endDriverId = auth.driverId;
    if (!endDriverId) throw new Error('Missing required field: driverId');

    const event = RideCompletionRequestedEvent.parse({
      eventType: 'RIDE_COMPLETION_REQUESTED',
      rideId: requireString(payload, 'rideId'),
      riderId: requireString(payload, 'riderId'),
      driverId: endDriverId,
      fareNgn: getNumber(payload, 'fareNgn'),
      endedBy: normalizeEndedBy(payload['endedBy']),
      completedAt: getString(payload, 'completedAt'),
      timestamp,
    });

    await publisher.publishRideEvent(event);

    return {
      type: 'ride:end:accepted',
      payload: { rideId: event.rideId },
    };
  }

  if (type === 'ride:arrived') {
    const rideId = requireString(payload, 'rideId');

    // This used to ack the driver and publish nothing — so the rider was
    // never told the car was outside. The app only sends rideId, so resolve
    // the rider from the ride row.
    const ride = await assertDriverOwnsRide(rideId, auth);
    const riderId = ride.riderId;
    const driverId = auth.driverId ?? ride.driverId;

    if (riderId && driverId) {
      const event = RideArrivedEvent.parse({
        eventType: 'RIDE_ARRIVED',
        rideId,
        riderId,
        driverId,
        timestamp,
      });
      await publisher.publishRideEvent(event);
    } else {
      console.warn('[api-gateway][ride] arrival could not be attributed — rider not notified', {
        rideId,
        hasRider: Boolean(riderId),
        hasDriver: Boolean(driverId),
      });
    }

    return {
      type: 'ride:arrived:ack',
      payload: { rideId },
    };
  }

  if (type === 'driver:accept') {
    // Driver accepts / bids — look up real driver profile from DB
    const driverId = getString(payload, 'driverId') ?? auth.driverId ?? auth.userId;

    let driverName = getString(payload, 'driverName') ?? 'Driver';
    let driverRating = getNumber(payload, 'driverRating') ?? 5.0;
    let vehiclePlate = getString(payload, 'vehiclePlate') ?? '';
    let vehicleModel = getString(payload, 'vehicleModel') ?? '';
    let driverRowId: string | null = null;
    let bidRowId: string | undefined;

    try {
      const driver = await driverClient.findByUserId(auth.userId);
      if (driver) {
        driverRowId = driver.id;
        driverName = driver.user.name ?? driver.user.phone ?? driverName;
        driverRating = driver.rating ?? driverRating;
        vehiclePlate = driver.vehiclePlate ?? vehiclePlate;
        vehicleModel = driver.vehicleModel ?? vehicleModel;
      }
    } catch {
      // Use client-provided fallbacks
    }

    const acceptRideId = requireString(payload, 'rideId');
    // The rider's id normally rides in the payload — but a bid card rebuilt
    // from history may not know it. The ride row always does; a missing or
    // empty riderId must not kill a legitimate bid.
    let bidRiderId = getString(payload, 'riderId');
    if (!bidRiderId) {
      bidRiderId = (await rideClient.findById(acceptRideId).catch(() => null))?.riderId;
    }
    if (!bidRiderId) {
      throw new Error('This request no longer exists.');
    }
    // The request must still be taking bids, and the bid must sit inside
    // the fare band (₦500/km ceiling, rider floor). The app's +100/+500
    // chips and "change bid" never checked the cap; the server must.
    await assertRideOpenForBids(acceptRideId);
    await assertOfferWithinBand(acceptRideId, requireNumber(payload, 'agreedFareNgn'), 'driver');

    const proximity = await computeBidProximity(
      auth.userId,
      acceptRideId,
      requireNumber(payload, 'etaSeconds'),
    );

    // A driver already on a trip is not in the market.
    if (driverRowId) {
      const busy = await rideClient.findActiveByDriver(driverRowId).catch(() => null);
      if (busy) {
        throw new Error('Finish your current trip before bidding on new requests.');
      }
    }

    // Record the bid FIRST so its durable id travels with the offer — the
    // rider's acceptance can then name this exact bid and price.
    if (driverRowId) {
      try {
        const bidRow = await driverBidClient.record({
          rideId: acceptRideId,
          driverId: driverRowId,
          driverUserId: auth.userId,
          riderId: bidRiderId,
          amountNgn: requireNumber(payload, 'agreedFareNgn'),
          etaSeconds: proximity.etaSeconds,
          distanceKm: proximity.distanceKm,
        });
        bidRowId = bidRow.id;
      } catch (error) {
        console.warn('[gateway] could not record driver bid', {
          rideId: acceptRideId,
          driverId: driverRowId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const counterOfferEvent = RideCounterOfferEvent.parse({
      eventType: 'RIDE_COUNTER_OFFER',
      rideId: acceptRideId,
      bidId: bidRowId,
      riderId: bidRiderId,
      driverId,
      driverUserId: auth.userId,
      counterOfferNgn: requireNumber(payload, 'agreedFareNgn'),
      driverName,
      driverRating,
      vehiclePlate,
      vehicleModel,
      etaSeconds: proximity.etaSeconds,
      distanceKm: proximity.distanceKm,
      timestamp,
    });

    await publisher.publishRideEvent(counterOfferEvent);

    return {
      type: 'driver:accept:accepted',
      payload: {
        rideId: counterOfferEvent.rideId,
        riderId: counterOfferEvent.riderId,
      },
    };
  }

  if (type === 'driver:reject') {
    const event = RideDriverRejectedEvent.parse({
      eventType: 'RIDE_DRIVER_REJECTED',
      rideId: requireString(payload, 'rideId'),
      riderId: requireString(payload, 'riderId'),
      driverId: getString(payload, 'driverId') ?? auth.driverId ?? auth.userId,
      reason: getString(payload, 'reason') === 'manual_reject' ? 'manual_reject' : 'timeout',
      timestamp,
    });

    await publisher.publishRideEvent(event);

    return {
      type: 'driver:reject:accepted',
      payload: {
        rideId: event.rideId,
      },
    };
  }

  if (type === 'feedback:submit') {
    const event = FeedbackLoggedEvent.parse({
      eventType: 'FEEDBACK_LOGGED',
      feedbackId: getString(payload, 'feedbackId') ?? randomUUID(),
      rideId: requireString(payload, 'rideId'),
      reviewerId: auth.userId,
      reviewerRole: normalizeReviewerRole(payload['reviewerRole']),
      revieweeId: requireString(payload, 'revieweeId'),
      rating: requireNumber(payload, 'rating'),
      comment: getString(payload, 'comment'),
      timestamp,
    });

    await publisher.publishComplianceEvent(event);

    return {
      type: 'feedback:submit:accepted',
      payload: {
        feedbackId: event.feedbackId,
        rideId: event.rideId,
      },
    };
  }

  if (type === 'chat:send') {
    const rideId = requireString(payload, 'rideId');
    const content = requireString(payload, 'content');
    if (content.length > 1000) throw new Error('Message too long (max 1000 chars).');

    const senderRole = auth.driverId ? 'DRIVER' : 'RIDER';
    const message = await chatClient.create({
      rideId,
      senderId: auth.userId,
      senderRole: senderRole as 'RIDER' | 'DRIVER',
      content,
    });

    const event = ChatMessageSentEvent.parse({
      eventType: 'CHAT_MESSAGE_SENT',
      rideId,
      messageId: message.id,
      senderId: auth.userId,
      senderRole,
      content,
      timestamp,
    });

    await publisher.publishRideEvent(event);

    return {
      type: 'chat:send:accepted',
      payload: {
        messageId: message.id,
        rideId,
      },
    };
  }

  if (type === 'dispute:open') {
    const event = DisputeOpenedEvent.parse({
      eventType: 'DISPUTE_OPENED',
      disputeId: getString(payload, 'disputeId') ?? randomUUID(),
      rideId: requireString(payload, 'rideId'),
      openedBy: auth.userId,
      openedByRole: normalizeOpenedByRole(payload['openedByRole']),
      againstId: requireString(payload, 'againstId'),
      reason: requireString(payload, 'reason'),
      timestamp,
    });

    await publisher.publishComplianceEvent(event);

    return {
      type: 'dispute:open:accepted',
      payload: {
        disputeId: event.disputeId,
        rideId: event.rideId,
      },
    };
  }

  return null;
}
