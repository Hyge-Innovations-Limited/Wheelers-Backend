import { randomUUID } from 'crypto';
import { checkTripCodeAtStart } from '../../rides/trip-code';
import type { RedisClient } from '../../redis/client';
import {
  GoogleMapsRoutePlanner,
  RIDE,
  calculateSuggestedFare,
  validateDriverOffer, fareFromRatePerKmNgn,
  validateRiderOffer,
} from '@wheleers/config';
import { driverClient, groupRideClient, referralClient, rideClient, driverBidClient } from '@wheleers/db';
import {
  DisputeOpenedEvent,
  FeedbackLoggedEvent,
  RideCancelledEvent,
  RideCompletionRequestedEvent,
  RideCounterOfferEvent,
  RideDriverRejectedEvent,
  RideRiderCounterOfferEvent,
  RideArrivedEvent,
  RideRouteUpdateRequestedEvent,
  RideRequestedEvent,
  RideStopConfirmedEvent,
  RideStartedEvent,
} from '@wheleers/kafka-schemas';
import type { GatewayAuthContext } from '../../types';
import { getBoolean, getNumber, getRecord, getString } from '../../utils/object';
import { estimateEtaSeconds, haversineKm } from '../../utils/geo';
import { findGroupRideSuggestion } from '../../group-ride/suggestion';
import type { GatewayPublisher } from '../publisher';
import type { HandlerResponse } from './types';
import { buildRideEstimatePricing } from '../../pricing/ride-estimate';
import { assertDriverApproved } from '../../rides/driver-kyc-gate';
import { declineOneOffer } from '../../rides/whatsapp-ride.service';
import { acceptOfferInApp } from '../../rides/app-accept';
import { autoAcceptOnAtStart, switchAutoAccept } from '../../rides/auto-accept';
import { forgetTripRouteQuote, quoteTripRoute } from '../../rides/trip-route-quote';
import { clearSearchEnded, markSearchEnded } from '../../rides/booking-lock';
import { closePayingUnlessBooking, openPaying, payingStatusEnabled, readPaying, withinPayingRate } from '../../rides/paying-status';
import { assertInServiceArea } from '../../utils/service-area';
import { LIVE_TRIP_STATUSES } from '../../rides/live-trip';
import { overLimit } from '../../trip-chat/limits';

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

/**
 * Who may change a live trip: the ride's own rider, or the driver assigned to it. Decided by the
 * RIDE's ids, never the payload and never by whether the sender also has a driver record (a user
 * who is both is the rider on their own ride). Returns the ride and the sender's role.
 */
async function assertPartyToLiveRide(
  rideId: string,
  auth: { userId: string; driverId?: string | null },
) {
  const ride = await rideClient.findById(rideId).catch(() => null);
  if (!ride) throw new Error('This ride is not yours.');
  const isRider = ride.riderId === auth.userId;
  const isDriver = !isRider && Boolean(auth.driverId) && ride.driverId === auth.driverId;
  if (!isRider && !isDriver) throw new Error('This ride is not yours.');
  if (!LIVE_TRIP_STATUSES.includes(String(ride.status))) {
    throw new Error('This trip is not running, so its route cannot be changed.');
  }
  return { ride, role: isRider ? ('rider' as const) : ('driver' as const) };
}

async function assertRideOpenForBids(rideId: string) {
  const ride = await rideClient.findById(rideId).catch(() => null);
  if (!ride) throw new Error('This request no longer exists.');
  if (ride.status !== 'REQUESTED' && ride.status !== 'MATCHING') {
    throw new Error('This request is no longer open.');
  }
  return ride;
}

export async function assertOfferWithinBand(
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

  const { suggestedFareNgn, distanceKm, riderOfferNgn } = context;
  // A driver taking the rider's own price is never refused, however high: the
  // typo guard below is for a counter-bid the driver typed, not for yes.
  if (who === 'driver' && riderOfferNgn !== undefined && offerNgn === riderOfferNgn) return;
  // A driver is measured against what the rider is offering, never the suggested fare:
  // any amount is a bid, and accepting a rider's generous price must always go through.
  // The ceiling (the fare at 150% of the recommended rate) is for a trip with
  // a known distance. A group seat has none: only a typo is refused there.
  const validation =
    who === 'driver'
      ? validateDriverOffer(offerNgn, riderOfferNgn ?? suggestedFareNgn, distanceKm !== undefined ? suggestedFareNgn : undefined)
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
 * A driver bids per km: the app sends `ratePerKmNgn`, and the fare the rider
 * would pay (trip fare + VAT + booking fee, rounded up to ₦50) is worked out
 * here from the ride's own distance, never trusted from the phone. An older
 * app that sends only a total keeps working. Returns the fare to use.
 */
async function resolveDriverBidFareNgn(rideId: string, payload: Record<string, unknown>, fareKey: string): Promise<number> {
  const rate = getNumber(payload, 'ratePerKmNgn');
  if (rate !== undefined && Number.isFinite(rate) && rate > 0) {
    const context = await resolveFareContext(rideId);
    if (context?.distanceKm && context.distanceKm > 0) {
      const fare = fareFromRatePerKmNgn(rate, context.distanceKm);
      payload[fareKey] = fare;
      return fare;
    }
  }
  return requireNumber(payload, fareKey);
}

/**
 * A group ride's rideId is a GroupRideMatchRequest id, not a Ride id — no Ride
 * row exists for it, so looking only in `Ride` throws and kills bidding on
 * every group ride. Check both, and return null when neither knows the ride.
 */
async function resolveFareContext(
  rideId: string,
): Promise<{ suggestedFareNgn: number; distanceKm?: number; riderOfferNgn?: number } | null> {
  const ride = await rideClient.findById(rideId).catch(() => null);
  if (ride) {
    return {
      riderOfferNgn: ride.riderOfferNgn !== null && ride.riderOfferNgn !== undefined ? Number(ride.riderOfferNgn) : undefined,
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
  // The driver app sends 'DRIVER'. Compared case-sensitively, that became
  // 'rider', and every driver's rating of a rider was recorded as a rider's.
  if (typeof value === 'string' && value.trim().toLowerCase() === 'driver') return 'driver';
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
  /** For the trip code's wrong-try limit, shared by every gateway process. */
  redis?: RedisClient,
): Promise<HandlerResponse | null> {
  const timestamp = new Date().toISOString();

  if (type === 'ride:request') {
    const rideId = getString(payload, 'rideId') ?? randomUUID();
    // A client-chosen id must be a new v4 UUID: no ride row and no group match request has it.
    // Real clients never reuse an id, so a reused one is only ever an attack on someone's ride.
    if (getString(payload, 'rideId')) {
      const refuse = (error: string): HandlerResponse => {
        console.warn('[ride:request] refused: bad or used ride id', { rideId, userId: auth.userId });
        return { type: 'ride:request:rejected', payload: { rideId, error } };
      };
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rideId)) {
        return refuse('Invalid ride id.');
      }
      try {
        const [standing, groupRequest] = await Promise.all([
          rideClient.findStanding(rideId),
          groupRideClient.findMatchRequestById(rideId),
        ]);
        if (standing || groupRequest) return refuse('This ride id is already in use.');
      } catch {
        return refuse('Could not start the search. Please try again.');
      }
    }
    const pickup = parseLatLng(payload, 'pickup');
    const destination = parseLatLng(payload, 'destination');
    const stops = parseStopList(payload, 'stops');
    const paymentMethod = parsePaymentMethod(payload['paymentMethod']);
    assertInServiceArea([pickup, destination, ...stops]);
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
      channel: auth.client === 'mcp' ? 'MCP' : 'APP',
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

    // Auto-accept only with the rider's yes (asked once, at Find): autoAccept: true. An app
    // that sends false, or nothing (an older app), never has a driver booked for it.
    let autoAccept = false;
    if (getBoolean(payload, 'autoAccept') === true && redis) {
      // The yes is for this price: nothing is booked above it.
      await autoAcceptOnAtStart(redis, rideId, auth.userId, riderOfferNgn);
      autoAccept = true;
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
        // Why the price is up, for the line under it (null: nothing notable).
        priceReason: plannedRoute.priceReason ?? null,
        // Auto-accept: on only when the request said autoAccept: true.
        autoAccept,
      },
    };
  }

  if (type === 'ride:auto_accept') {
    // The rider's switch for this search: on is their yes (at priceNgn, the price they
    // were asked about; absent: the search's price now), off keeps it off.
    const rideId = requireString(payload, 'rideId');
    const on = getBoolean(payload, 'on') === true;
    const priceNgn = getNumber(payload, 'priceNgn');
    if (!redis) {
      return { type: 'ride:auto_accept:rejected', payload: { rideId, reason: 'not_searching', message: 'Auto-accept is not available right now.' } };
    }
    const result = await switchAutoAccept({ redisClient: redis, publisher }, auth.userId, rideId, on, priceNgn);
    if (result.ok) {
      return { type: 'ride:auto_accept:done', payload: { rideId, on: result.on, ...(result.booked ? { reason: 'booked' } : {}) } };
    }
    return { type: 'ride:auto_accept:rejected', payload: { rideId, reason: result.reason, message: result.message } };
  }

  if (type === 'ride:counter_offer') {
    // Legacy and unguarded (identity and rider came from the payload). Drivers bid with driver:accept.
    return { type: 'ride:counter_offer:rejected', payload: { rideId: getString(payload, 'rideId'), error: 'Use driver:accept' } };
  }

  if (type === 'ride:accept_offer') {
    // The tap in the app and auto-accept book through the same function (rides/app-accept.ts).
    return acceptOfferInApp({ publisher, redis }, auth.userId, {
      rideId: requireString(payload, 'rideId'),
      driverId: requireString(payload, 'driverId'),
      driverUserId: requireString(payload, 'driverUserId'),
      bidId: getString(payload, 'bidId'),
      paymentMethod: parsePaymentMethod(payload['paymentMethod']),
      agreedFareNgn: getNumber(payload, 'agreedFareNgn'),
    }, timestamp);
  }

  if (type === 'ride:decline_offer') {
    // One driver's offer, declined: they are told and can send a new price.
    const rideId = requireString(payload, 'rideId');
    const driverId = requireString(payload, 'driverId');
    const ride = await rideClient.findById(rideId).catch(() => null);
    if (ride && ride.riderId !== auth.userId) throw new Error('This ride is not yours.');
    const open = ride?.status === 'REQUESTED' || ride?.status === 'MATCHING';
    const { declined } = open && redis
      ? await declineOneOffer({ redisClient: redis, publisher }, auth.userId, rideId, driverId)
      : { declined: false };
    return { type: 'ride:decline_offer:done', payload: { rideId, driverId, declined } };
  }

  if (type === 'ride:pay_sheet') {
    // The rider opened or closed the pay sheet for one driver. Off, an unknown message as before.
    if (!payingStatusEnabled()) return null;
    const open = payload['open'];
    if (typeof open !== 'boolean') throw new Error('Missing required field: open');
    const rideId = requireString(payload, 'rideId');
    const driverId = requireString(payload, 'driverId');
    if (!redis) throw new Error('Not available right now.');
    const ride = await rideClient.findById(rideId).catch(() => null);
    if (!ride || ride.riderId !== auth.userId) throw new Error('This ride is not yours.');
    const bid = (await driverBidClient.findByRide(rideId).catch(() => [])).find((row) => row.driverId === driverId);
    if (open) {
      if (ride.status !== 'REQUESTED' && ride.status !== 'MATCHING') throw new Error('This search has ended.');
      if (!bid || bid.status !== 'PENDING') throw new Error('That offer is no longer open.');
      if (!(await withinPayingRate(redis, auth.userId))) throw new Error('Too many tries. Wait a minute.');
      const opened = await openPaying({ redisClient: redis, publisher }, rideId, auth.userId, bid.driverUserId);
      if (opened.result === 'refused') throw new Error('Too many tries for this driver.');
      return { type: 'ride:pay_sheet:ok', payload: { rideId, driverId, open, payingUntil: opened.payingUntil } };
    } else if (bid) {
      // Only a live offer, or one that is being paid for, can be closed.
      const holding = (await readPaying(redis, rideId))?.driverUserId === bid.driverUserId;
      if (bid.status === 'PENDING' || holding) {
        if (!(await withinPayingRate(redis, auth.userId))) throw new Error('Too many tries. Wait a minute.');
        await closePayingUnlessBooking({ redisClient: redis, publisher }, rideId, bid.driverUserId);
      }
    }
    return { type: 'ride:pay_sheet:ok', payload: { rideId, driverId, open } };
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
        // A rider's new price restarts the search's clock (ride-service
        // starts the bid timeout again): this is when it now closes.
        bidsCloseAt: new Date(Date.now() + RIDE.BID_TIMEOUT_SECONDS * 1000).toISOString(),
      },
    };
  }

  if (type === 'ride:route:quote') {
    // What a route change would cost, before it is made (nothing moves): the
    // trip's new price and how much more the wallet would hold for it.
    const rideId = requireString(payload, 'rideId');
    const destination = parseLatLng(payload, 'destination');
    const stops = parseStopList(payload, 'stops');
    assertInServiceArea([destination, ...stops]);
    if (!redis) throw new Error('Route prices are not available right now.');
    // Each quote is a Maps call: only the rider, only while the trip runs, and a few a minute.
    const { role } = await assertPartyToLiveRide(rideId, auth);
    if (role !== 'rider') throw new Error('This ride is not yours.');
    if (await overLimit(redis, `ride-route-quote:${auth.userId}`, 10, 60)) throw new Error('Too many price checks. Try again in a minute.');
    const quote = await quoteTripRoute({ redis, routePlanner }, rideId, destination, stops);
    return { type: 'ride:route:quote:result', payload: { rideId, fareNgn: quote.fareNgn, extraNgn: quote.extraNgn } };
  }

  if (type === 'ride:route:update') {
    const rideId = requireString(payload, 'rideId');
    // Whose ride this is comes from the ride itself. The payload's riderId / driverId never
    // decide it, and nothing in the payload can move money.
    const { ride, role } = await assertPartyToLiveRide(rideId, auth);
    const riderId = ride.riderId;
    const driverId = ride.driverId ?? undefined;
    // Only used to draw the road for navigation; the fare of an unpriced change is ignored downstream.
    const origin = getRecord(payload, 'origin') ? parseLatLng(payload, 'origin') : undefined;
    const destination = parseLatLng(payload, 'destination');
    const stops = parseStopList(payload, 'stops');
    // A new destination or stop mid-trip stays in Lagos too; where the car is now does not matter.
    assertInServiceArea([destination, ...stops]);
    // The price the rider was shown for this route (ride:route:quote): the change goes ahead only
    // at that price, and the wallet's hold moves to exactly it. Absent (an older app, or the
    // driver): the route moves but the money held does not (ride-service and wallet-service keep it).
    const acceptedFareNgn = getNumber(payload, 'acceptedFareNgn');
    let quotedRoute: Awaited<ReturnType<typeof quoteTripRoute>>['planned'] | null = null;
    if (acceptedFareNgn !== undefined && role === 'rider') {
      if (!redis) throw new Error('Route changes are not available right now.');
      const quote = await quoteTripRoute({ redis, routePlanner }, rideId, destination, stops);
      if (Math.round(acceptedFareNgn) !== quote.fareNgn) {
        return {
          type: 'ride:route:update:rejected',
          payload: { rideId, reason: 'PRICE_CHANGED', fareNgn: quote.fareNgn, extraNgn: quote.extraNgn, message: `The price is now ₦${quote.fareNgn.toLocaleString('en-NG')}.` },
        };
      }
      quotedRoute = quote.planned;
    }
    const plannedRoute = quotedRoute ?? (origin
      ? await routePlanner.planRoute({
          origin,
          stops,
          destination,
        })
      : null);
    const event = RideRouteUpdateRequestedEvent.parse({
      eventType: 'RIDE_ROUTE_UPDATE_REQUESTED',
      rideId,
      riderId,
      driverId,
      destination,
      stops,
      plannedDistanceKm: plannedRoute?.distanceKm,
      plannedDurationSeconds: plannedRoute?.durationSeconds,
      fareEstimateNgn: plannedRoute?.suggestedFareNgn,
      route: plannedRoute?.geometry,
      priced: quotedRoute !== null,
      updatedBy: role,
      timestamp,
    });

    await publisher.publishRideEvent(event);
    if (quotedRoute && redis) await forgetTripRouteQuote(redis, event.rideId);
    return {
      type: 'ride:route:update:accepted',
      payload: {
        rideId: event.rideId,
        destination,
        stops,
        route: plannedRoute?.geometry,
        plannedDistanceKm: event.plannedDistanceKm,
        plannedDurationSeconds: event.plannedDurationSeconds,
        // Mid-trip the car is the start; only where the trip now ends decides an area factor.
        ...buildRideEstimatePricing(event.plannedDistanceKm, event.plannedDurationSeconds, { destination }),
      },
    };
  }

  if (type === 'ride:stop:confirm') {
    const rideId = requireString(payload, 'rideId');
    const { ride, role } = await assertPartyToLiveRide(rideId, auth);
    if (!ride.driverId) throw new Error('This ride has no driver yet.');
    const event = RideStopConfirmedEvent.parse({
      eventType: 'RIDE_STOP_CONFIRMED',
      rideId,
      riderId: ride.riderId,
      driverId: ride.driverId,
      confirmedBy: role,
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

    // A rider ending their search: over in the gateway's eyes now, before the ride service writes the row.
    if (cancelledBy === 'rider' && redis) await markSearchEnded(redis, rideId);

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

    try {
      await publisher.publishRideEvent(event);
    } catch (error) {
      // Not cancelled after all: the search is not over.
      if (cancelledBy === 'rider' && redis) await clearSearchEnded(redis, rideId);
      throw error;
    }

    return {
      type: 'ride:cancel:accepted',
      payload: { rideId: event.rideId },
    };
  }

  if (type === 'ride:start') {
    await assertDriverOwnsRide(requireString(payload, 'rideId'), auth);
    const driverId = auth.driverId;
    if (!driverId) throw new Error('Missing required field: driverId');
    // The rider's 4-digit trip code, checked here so no app can skip it.
    await checkTripCodeAtStart(requireString(payload, 'rideId'), payload['tripCode'], redis);

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
    // Only an approved driver may bid on or take a request.
    await assertDriverApproved(auth.userId);
    // The driver is whoever is signed in. Identity, name, rating and car come from the
    // database only, never the payload.
    const driver = await driverClient.findByUserId(auth.userId).catch(() => null);
    if (!driver) throw new Error('Only a driver can do that.');
    const driverId = driver.id;
    const driverRowId: string = driver.id;
    const driverName = driver.user.name ?? driver.user.phone ?? 'Driver';
    const driverRating = driver.rating ?? 5.0;
    const vehiclePlate = driver.vehiclePlate ?? '';
    const vehicleModel = driver.vehicleModel ?? '';
    let bidRowId: string | undefined;

    const acceptRideId = requireString(payload, 'rideId');
    // The rider is the ride's own, never the payload's.
    const bidRide = await rideClient.findById(acceptRideId).catch(() => null);
    const bidRiderId = bidRide?.riderId;
    if (!bidRiderId) {
      throw new Error('This request no longer exists.');
    }
    const claimedRiderId = getString(payload, 'riderId');
    if (claimedRiderId && claimedRiderId !== bidRiderId) {
      throw new Error('This request no longer exists.');
    }
    // The request must still be taking bids, and the bid must sit inside
    // the fare band (₦500/km ceiling, rider floor). The app's +100/+500
    // chips and "change bid" never checked the cap; the server must.
    await assertRideOpenForBids(acceptRideId);
    await assertOfferWithinBand(acceptRideId, await resolveDriverBidFareNgn(acceptRideId, payload, 'agreedFareNgn'), 'driver');

    const proximity = await computeBidProximity(
      auth.userId,
      acceptRideId,
      requireNumber(payload, 'etaSeconds'),
    );

    // A driver already on a trip is not in the market.
    {
      const busy = await rideClient.findActiveByDriver(driverRowId).catch(() => null);
      if (busy) {
        throw new Error('Finish your current trip before bidding on new requests.');
      }
    }

    // Record the bid FIRST so its durable id travels with the offer — the
    // rider's acceptance can then name this exact bid and price.
    {
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
    // The rider is the ride's: the app fills riderId from whatever offer is on
    // its screen, which can be another ride's (or empty, which used to refuse it).
    const rejectRideId = requireString(payload, 'rideId');
    const rejectedRide = await rideClient.findById(rejectRideId).catch(() => null);
    // The driver is whoever is signed in: a driver can only withdraw their own bid.
    const rejectingDriverId = auth.driverId ?? (await driverClient.findByUserId(auth.userId).catch(() => null))?.id;
    if (!rejectingDriverId) throw new Error('Only a driver can do that.');
    const event = RideDriverRejectedEvent.parse({
      eventType: 'RIDE_DRIVER_REJECTED',
      rideId: rejectRideId,
      riderId: rejectedRide?.riderId ?? requireString(payload, 'riderId'),
      driverId: rejectingDriverId,
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

  // chat:send is answered by the trip chat (src/trip-chat), before this handler is asked.

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
