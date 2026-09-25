import { randomUUID } from 'crypto';
import { driverClient, rideClient, walletClient } from '@wheleers/db';
import { depositNeededFor, validateRiderOffer } from '@wheleers/config';
import { RideCancelledEvent, RideOfferAcceptedEvent, RideRequestedEvent } from '@wheleers/kafka-schemas';
import type { RedisClient } from '../redis/client';
import type { GatewayPublisher } from '../websocket/publisher';
import {
  clearActiveRide,
  clearBookingStage,
  clearPendingAccept,
  clearPendingRoute,
  cleanupRideKeys,
  getBids,
  getRideMeta,
  setActiveRide,
  setRideState,
  storeAcceptedBid,
  storeLastRoute,
  storeWhatsappRide,
  clearSearchTimedOut,
} from '../whatsapp-flows/bid-state';
import type { PendingRouteData, WhatsappBid } from '../whatsapp-flows/bid-state';

/**
 * What a WhatsApp rider can DO to their booking, as plain functions with plain
 * results — no chat replies in here.
 *
 * The chat used to be the only door, so these steps lived inside its message
 * handler, tangled with the text of each reply. The bidding page is a second
 * door onto the same booking: it needs the same rules (the minimum fare, the
 * driver-still-there checks, one rider per driver, hold before confirm) without
 * the chat's wording. Both doors read and write the same Redis state, so a
 * rider can start in one and finish in the other.
 */

export interface RideServiceDeps {
  redisClient: RedisClient;
  publisher: GatewayPublisher;
}

/** The handle the page uses for an offer: the durable bid id when there is one. */
export function offerKey(bid: WhatsappBid): string {
  return bid.bidId ?? `driver:${bid.driverId}`;
}

/* ── start the search ───────────────────────────────────────────────────── */

export type PublishResult =
  | { ok: true; rideId: string }
  | { ok: false; code: 'BELOW_MINIMUM'; minOfferNgn: number }
  | { ok: false; code: 'ALREADY_PUBLISHING' | 'PUBLISH_FAILED' };

/** Name a price → the ride goes out to drivers. */
export async function publishWhatsappRide(
  deps: RideServiceDeps,
  rider: { id: string; phone: string },
  pendingRoute: PendingRouteData,
  offerNgn: number,
): Promise<PublishResult> {
  if (!(offerNgn >= pendingRoute.minOfferNgn)) {
    return { ok: false, code: 'BELOW_MINIMUM', minOfferNgn: pendingRoute.minOfferNgn };
  }

  // Two taps, or a tap and a typed price in the same second, must not become two rides.
  const claimKey = `whatsapp:user:${rider.id}:publishing`;
  const claimed = await deps.redisClient.setIfNotExists(claimKey, '1', 30).catch(() => true);
  if (!claimed) return { ok: false, code: 'ALREADY_PUBLISHING' };

  const rideId = randomUUID();
  const event = RideRequestedEvent.parse({
    eventType: 'RIDE_REQUESTED',
    rideId,
    riderId: rider.id,
    pickup: { lat: pendingRoute.pickupLat, lng: pendingRoute.pickupLng, address: pendingRoute.pickupAddress },
    destination: { lat: pendingRoute.destLat, lng: pendingRoute.destLng, address: pendingRoute.destAddress },
    stops: pendingRoute.stops ?? [],
    plannedDistanceKm: pendingRoute.distanceKm,
    plannedDurationSeconds: pendingRoute.durationSeconds,
    fareEstimateNgn: offerNgn,
    paymentMethod: 'WALLET',
    riderOfferNgn: offerNgn,
    suggestedFareNgn: pendingRoute.suggestedFareNgn,
    minOfferNgn: pendingRoute.minOfferNgn,
    ratePerKmNgn: pendingRoute.ratePerKmNgn,
    route: pendingRoute.route,
    timestamp: new Date().toISOString(),
  });

  try {
    await deps.publisher.publishRideEvent(event);
  } catch (error) {
    console.error('[ride-service] ride publish FAILED — quote kept', {
      rideId,
      riderId: rider.id,
      error: error instanceof Error ? error.message : String(error),
    });
    await deps.redisClient.del(claimKey).catch(() => undefined);
    return { ok: false, code: 'PUBLISH_FAILED' };
  }

  await clearPendingRoute(deps.redisClient, rider.id);
  await clearBookingStage(deps.redisClient, rider.id);
  await storeWhatsappRide(deps.redisClient, rideId, {
    riderId: rider.id,
    phone: rider.phone,
    pickupAddress: pendingRoute.pickupAddress,
    pickupLat: pendingRoute.pickupLat,
    pickupLng: pendingRoute.pickupLng,
    destinationAddress: pendingRoute.destAddress,
    destinationLat: pendingRoute.destLat,
    destinationLng: pendingRoute.destLng,
    stops: pendingRoute.stops,
    distanceKm: pendingRoute.distanceKm,
    durationSeconds: pendingRoute.durationSeconds,
    offerNgn,
    suggestedFareNgn: pendingRoute.suggestedFareNgn,
    paymentMethod: 'WALLET',
    createdAt: new Date().toISOString(),
  });
  await setActiveRide(deps.redisClient, rider.id, rideId);
  await storeLastRoute(deps.redisClient, rider.id, { ...pendingRoute, offerNgn });
  await clearSearchTimedOut(deps.redisClient, rider.id);
  // The claim only had to cover the moment of publishing. Left to expire on its
  // own it blocked a rider who cancelled and searched again within 30 seconds;
  // a late second tap is harmless now — the quote it needs is already spent.
  await deps.redisClient.del(claimKey).catch(() => undefined);
  return { ok: true, rideId };
}

/* ── change the bid ─────────────────────────────────────────────────────── */

export type ChangeOfferResult =
  | { ok: true; offerNgn: number }
  | { ok: false; code: 'RIDE_GONE' }
  | { ok: false; code: 'BELOW_MINIMUM'; minOfferNgn: number };

/** A new price from the rider, shown to every driver looking at the request. */
export async function changeRiderOffer(
  deps: RideServiceDeps,
  riderId: string,
  rideId: string,
  amountNgn: number,
): Promise<ChangeOfferResult> {
  const meta = await getRideMeta(deps.redisClient, rideId);
  if (!meta || meta.riderId !== riderId) return { ok: false, code: 'RIDE_GONE' };

  // The first offer cleared the minimum fare; a later one has to as well, or
  // the floor is bypassed by simply lowering the price once bidding starts.
  const validation = validateRiderOffer(amountNgn, meta.suggestedFareNgn);
  if (!validation.valid) return { ok: false, code: 'BELOW_MINIMUM', minOfferNgn: validation.minOfferNgn };

  meta.offerNgn = amountNgn;
  await deps.redisClient.set(`whatsapp:ride:${rideId}:meta`, JSON.stringify(meta), 900);
  await deps.publisher.publishRideEvent({
    eventType: 'RIDE_RIDER_COUNTER_OFFER',
    rideId,
    riderId,
    counterOfferNgn: amountNgn,
    timestamp: new Date().toISOString(),
  });
  return { ok: true, offerNgn: amountNgn };
}

/* ── accept an offer ────────────────────────────────────────────────────── */

export interface ConfirmedRide {
  rideId: string;
  fareNgn: number;
  driverId: string;
  driverName: string;
  driverPhone: string;
  driverRating: number;
  totalRides: number;
  vehicleModel: string;
  vehiclePlate: string;
  etaSeconds: number;
  pickupAddress: string;
  destAddress: string;
  stopAddresses: string[];
}

export type ConfirmResult =
  | { ok: true; ride: ConfirmedRide }
  | { ok: false; code: 'RIDE_GONE' | 'OFFER_GONE' | 'DRIVER_UNAVAILABLE' | 'DRIVER_TAKEN' | 'HOLD_FAILED' | 'CONFIRM_FAILED' | 'ALREADY_CONFIRMING' }
  | { ok: false; code: 'WALLET_SHORT'; balanceNgn: number; fareNgn: number; shortNgn: number; sendNgn: number };

/**
 * Accept one driver's offer: hold the fare, then tell everyone.
 *
 * The order is the whole point, and it is the chat's order: the wallet is
 * checked FIRST (a rider who cannot pay must hear "add money", not "driver
 * unavailable"); the driver must still be online, fresh and free; one rider
 * per driver; the hold is taken BEFORE the acceptance is published, so a ride
 * is never confirmed on money that is not there.
 */
export async function confirmRideWithOffer(
  deps: RideServiceDeps,
  riderId: string,
  rideId: string,
  key: string,
): Promise<ConfirmResult> {
  // One confirmation at a time per ride. A deposit landing can finish the ride
  // in the same second the rider taps Accept again; without this both would
  // publish the acceptance and the rider would be told twice.
  const confirmingKey = `whatsapp:ride:${rideId}:confirming`;
  const mine = await deps.redisClient.setIfNotExists(confirmingKey, '1', 20).catch(() => true);
  if (!mine) return { ok: false, code: 'ALREADY_CONFIRMING' };
  try {
    return await confirmOnce(deps, riderId, rideId, key);
  } finally {
    await deps.redisClient.del(confirmingKey).catch(() => undefined);
  }
}

async function confirmOnce(
  deps: RideServiceDeps,
  riderId: string,
  rideId: string,
  key: string,
): Promise<ConfirmResult> {
  const meta = await getRideMeta(deps.redisClient, rideId);
  if (!meta || meta.riderId !== riderId) return { ok: false, code: 'RIDE_GONE' };

  const bid = (await getBids(deps.redisClient, rideId)).find((candidate) => offerKey(candidate) === key);
  if (!bid) return { ok: false, code: 'OFFER_GONE' };
  const fareNgn = bid.counterOfferNgn;

  const wallet = await walletClient.findByUserId(riderId);
  const balanceNgn = wallet ? Number(wallet.balanceNgn) : 0;
  if (!wallet || balanceNgn < fareNgn) {
    const shortNgn = Math.ceil(fareNgn - balanceNgn);
    return { ok: false, code: 'WALLET_SHORT', balanceNgn, fareNgn, shortNgn, sendNgn: depositNeededFor(shortNgn) };
  }

  const driver = await driverClient.findById(bid.driverId).catch(() => null);
  const fresh = driver?.lastSeenAt != null && Date.now() - driver.lastSeenAt.getTime() < 2 * 60_000;
  const busy = driver ? await rideClient.findActiveByDriver(bid.driverId).catch(() => null) : null;
  if (!driver || driver.status !== 'ONLINE' || !fresh || busy) return { ok: false, code: 'DRIVER_UNAVAILABLE' };

  const driverClaimKey = `whatsapp:driver:${bid.driverId}:accepting`;
  const claimed = await deps.redisClient.setIfNotExists(driverClaimKey, rideId, 60).catch(() => true);
  const claimOwner = claimed ? rideId : await deps.redisClient.get(driverClaimKey).catch(() => null);
  if (!claimed && claimOwner !== rideId) return { ok: false, code: 'DRIVER_TAKEN' };

  try {
    const hold = await walletClient.createRideHold({
      rideId,
      walletId: wallet.id,
      riderId,
      driverUserId: bid.driverUserId,
      amountNgn: fareNgn,
    });
    // A hold left by an earlier attempt on this ride may carry a different fare.
    if (!hold.applied && hold.holdAmountNgn !== fareNgn) {
      const adjusted = await walletClient.adjustRideHold({ rideId, targetAmountNgn: fareNgn });
      if (!adjusted) throw new Error(`existing hold of ₦${hold.holdAmountNgn} could not be adjusted to ₦${fareNgn}`);
    }
  } catch (error) {
    console.error('[ride-service] ride hold FAILED — rider could not pay', {
      rideId, riderId, fareNgn, balanceNgn,
      error: error instanceof Error ? error.message : String(error),
    });
    await deps.redisClient.del(driverClaimKey).catch(() => undefined);
    return { ok: false, code: 'HOLD_FAILED' };
  }

  try {
    await deps.publisher.publishRideEvent(RideOfferAcceptedEvent.parse({
      eventType: 'RIDE_OFFER_ACCEPTED',
      rideId,
      riderId,
      driverId: bid.driverId,
      driverUserId: bid.driverUserId,
      bidId: bid.bidId,
      agreedFareNgn: fareNgn,
      paymentMethod: 'WALLET',
      timestamp: new Date().toISOString(),
    }));
  } catch (error) {
    // The hold stays: accepting again adopts it, and a cancel releases it.
    console.error('[ride-service] accept publish FAILED — hold kept', {
      rideId, riderId,
      error: error instanceof Error ? error.message : String(error),
    });
    await deps.redisClient.del(driverClaimKey).catch(() => undefined);
    return { ok: false, code: 'CONFIRM_FAILED' };
  }

  const ride: ConfirmedRide = {
    rideId,
    fareNgn,
    driverId: bid.driverId,
    driverName: bid.driverName,
    driverPhone: driver.user?.phone ?? '',
    driverRating: bid.driverRating,
    totalRides: driver.totalRides ?? 0,
    vehicleModel: bid.vehicleModel,
    vehiclePlate: bid.vehiclePlate,
    etaSeconds: bid.etaSeconds,
    pickupAddress: meta.pickupAddress,
    destAddress: meta.destinationAddress,
    stopAddresses: (meta.stops ?? []).map((stop) => stop.address),
  };
  await clearPendingAccept(deps.redisClient, riderId);
  await setRideState(deps.redisClient, rideId, 'confirmed');
  await storeAcceptedBid(deps.redisClient, rideId, {
    driverName: ride.driverName,
    driverPhone: ride.driverPhone,
    driverUserId: bid.driverUserId,
    vehicleModel: ride.vehicleModel,
    vehiclePlate: ride.vehiclePlate,
    vehicleColor: '',
    driverRating: ride.driverRating,
    totalRides: ride.totalRides,
    etaSeconds: ride.etaSeconds,
    fareNgn,
  });
  return { ok: true, ride };
}

/* ── give up the search ─────────────────────────────────────────────────── */

/** Cancel before a driver is assigned. Anything held for the ride is released downstream. */
export async function cancelWhatsappRide(
  deps: RideServiceDeps,
  riderId: string,
  rideId: string,
  reason: string,
): Promise<{ ok: boolean }> {
  const meta = await getRideMeta(deps.redisClient, rideId);
  if (meta && meta.riderId !== riderId) return { ok: false };

  const ride = await rideClient.findById(rideId).catch(() => null);
  await deps.publisher.publishRideEvent(RideCancelledEvent.parse({
    eventType: 'RIDE_CANCELLED',
    rideId,
    riderId,
    driverId: ride?.driverId ?? undefined,
    cancelledBy: 'rider',
    reason,
    timestamp: new Date().toISOString(),
  }));
  await clearActiveRide(deps.redisClient, riderId);
  await cleanupRideKeys(deps.redisClient, rideId);
  await clearPendingAccept(deps.redisClient, riderId);
  return { ok: true };
}
