import { rideClient, userClient } from '@wheleers/db';
import { validateRiderOffer } from '@wheleers/config';
import type { RideRequestedEvent } from '@wheleers/kafka-schemas';
import type { RedisClient } from '../redis/client';
import type { RidePageChatEvent } from '../http/ride-page.route';
import {
  clearBookingStage,
  clearPendingRoute,
  clearSearchTimedOut,
  getActiveRide,
  getRideState,
  isRidePageOpen,
  lookupPhoneByUserId,
  setActiveRide,
  setPhoneLookup,
  storeLastRoute,
  storeWhatsappRide,
} from '../whatsapp-flows/bid-state';
import { bookingLockKey } from './booking-lock';
import { startSearchClock } from './search-status';
import { deferUntilPageLeft } from '../whatsapp-flows/page-catchup';

/**
 * A ride for later booked on the WhatsApp ride page has just started its
 * search (the scheduler sent RIDE_REQUESTED with channel WHATSAPP). It becomes
 * a WhatsApp search, as if the rider had named the price on the page now: the
 * same Redis state publishWhatsappRide leaves (so offers, accept, auto-accept,
 * the timeout and the ride page all treat it as theirs), and the chat's one
 * "Your bid is in" — held for the catch-up while the rider is on the page.
 *
 * Returns false when it cannot be one, and the search stays the app's (as every
 * scheduled search was before): no phone on the account, or the rider is on a
 * trip or having a driver confirmed right now (their chat pointer belongs to
 * that ride). True also when it was already done (Kafka delivered it again).
 */
export async function startScheduledWhatsappSearch(
  deps: { redisClient: RedisClient; ridePageChat?: (event: RidePageChatEvent) => Promise<void> },
  event: RideRequestedEvent,
): Promise<boolean> {
  const redis = deps.redisClient;
  const doneKey = `ride:${event.rideId}:wa-scheduled`;
  if (await redis.get(doneKey).catch(() => null)) return true;

  const user = await userClient.findById(event.riderId).catch(() => null);
  const found = (await lookupPhoneByUserId(redis, event.riderId).catch(() => null)) ?? user?.phone ?? null;
  if (!found) return false;
  const phone: string = found;

  // On a trip (or a driver being confirmed): that ride keeps the chat.
  const current = await getActiveRide(redis, event.riderId).catch(() => null);
  if (current && current !== event.rideId) {
    const state = await getRideState(redis, current).catch(() => null);
    if (state === 'confirmed' || state === 'in_progress') return false;
    if (await redis.get(bookingLockKey(current)).catch(() => null)) return false;
  }
  const live = await rideClient.findActiveByRider(event.riderId).catch(() => null);
  if (live && live.id !== event.rideId && live.driverId) return false;

  // Once per search, however often it is delivered.
  const first = await redis.setIfNotExists(doneKey, '1', 2 * 60 * 60).catch(() => true);
  if (!first) return true;

  const offerNgn = Math.round(event.riderOfferNgn ?? event.fareEstimateNgn);
  const suggestedFareNgn = Math.round(event.suggestedFareNgn ?? offerNgn);
  const stops = event.stops ?? [];
  const trip = {
    pickupLat: event.pickup.lat, pickupLng: event.pickup.lng, pickupAddress: event.pickup.address,
    destLat: event.destination.lat, destLng: event.destination.lng, destAddress: event.destination.address,
    stops,
    distanceKm: event.plannedDistanceKm ?? 0,
    durationSeconds: event.plannedDurationSeconds ?? 0,
    suggestedFareNgn,
    minOfferNgn: event.minOfferNgn ?? validateRiderOffer(0, suggestedFareNgn).minOfferNgn,
    ratePerKmNgn: event.ratePerKmNgn ?? 0,
    priceReason: null,
    route: event.route,
  };

  try {
    await setUp();
  } catch (error) {
    // Not set up: Kafka's retry (or the app's path) gets another go.
    await redis.del(doneKey).catch(() => undefined);
    console.warn('[gateway] scheduled ride: WhatsApp search not set up', { rideId: event.rideId, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
  return true;

  async function setUp(): Promise<void> {
    // What publishWhatsappRide leaves behind once drivers are asked.
    await clearPendingRoute(redis, event.riderId).catch(() => undefined);
    await clearBookingStage(redis, event.riderId).catch(() => undefined);
    await storeWhatsappRide(redis, event.rideId, {
      riderId: event.riderId,
      phone,
      pickupAddress: trip.pickupAddress,
      pickupLat: trip.pickupLat,
      pickupLng: trip.pickupLng,
      destinationAddress: trip.destAddress,
      destinationLat: trip.destLat,
      destinationLng: trip.destLng,
      stops,
      distanceKm: trip.distanceKm,
      durationSeconds: trip.durationSeconds,
      offerNgn,
      suggestedFareNgn,
      priceReason: null,
      paymentMethod: 'WALLET',
      createdAt: new Date().toISOString(),
    });
    await setActiveRide(redis, event.riderId, event.rideId);
    // The consumer finds the chat by this (it lapses a day after the rider's last message).
    if (!(await lookupPhoneByUserId(redis, event.riderId).catch(() => null))) {
      await setPhoneLookup(redis, event.riderId, phone).catch(() => undefined);
    }
    await startSearchClock(redis, event.rideId);
    await storeLastRoute(redis, event.riderId, { ...trip, offerNgn });
    await clearSearchTimedOut(redis, event.riderId);

    // "Your bid is in", with the way to the offers. On the page: when they leave, if still searching.
    const said: RidePageChatEvent = {
      kind: 'search_started', userId: event.riderId, phone, rideId: event.rideId, offerNgn,
      pickupAddress: trip.pickupAddress, destAddress: trip.destAddress,
      stopAddresses: stops.map((stop) => stop.address),
      scheduled: true,
    };
    if (await isRidePageOpen(redis, event.riderId).catch(() => false)) {
      await deferUntilPageLeft(redis, event.riderId, { kind: 'search_started', rideId: event.rideId, event: said as unknown as Record<string, unknown> }).catch(() => undefined);
    } else {
      await deps.ridePageChat?.(said).catch((error) =>
        console.warn('[gateway] scheduled ride: chat message failed', { rideId: event.rideId, error: error instanceof Error ? error.message : String(error) }));
    }
  }
}
