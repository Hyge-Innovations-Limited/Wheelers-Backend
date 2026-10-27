import { rideClient, scheduledRideClient, userClient } from '@wheleers/db';
import { validateRiderOffer } from '@wheleers/config';
import { RideCancelledEvent, type RideRequestedEvent } from '@wheleers/kafka-schemas';
import type { RedisClient } from '../redis/client';
import type { RidePageChatEvent } from '../http/ride-page.route';
import type { GatewayPublisher } from '../websocket/publisher';
import {
  clearActiveRideIfMatches,
  clearBookingStage,
  clearPendingRoute,
  clearSearchTimedOut,
  cleanupRideKeys,
  getActiveRide,
  getRideMeta,
  getRideState,
  isRidePageOpen,
  lookupPhoneByUserId,
  setActiveRide,
  setPhoneLookup,
  storeLastRoute,
  storeWhatsappRide,
} from '../whatsapp-flows/bid-state';
import { startSearchClock } from './search-status';
import { autoAcceptOffAtStart } from './auto-accept';
import { deferUntilPageLeft } from '../whatsapp-flows/page-catchup';

/** Kafka may deliver a start again long after (a rebalance, a restart): it is done once. */
const DONE_TTL_SECONDS = 7 * 24 * 60 * 60;
/** A search of the rider's own this young, not yet in the database, is theirs to keep. */
const FRESH_SEARCH_MS = 2 * 60_000;
const SET_UP_ATTEMPTS = 3;

/**
 * A ride for later that could not become a WhatsApp search and was put back
 * to wait: its search is ended quietly (the chat says nothing; it starts again
 * when the scheduler next finds the rider free).
 */
export const SCHEDULED_START_HELD_REASON = 'Ride for later waits for the rider';

export type ScheduledStart = 'started' | 'held' | 'app';

/**
 * A ride for later booked on the WhatsApp ride page has just started its
 * search (the scheduler sent RIDE_REQUESTED with channel WHATSAPP). It becomes
 * a WhatsApp search, as if the rider had named the price on the page now: the
 * same Redis state publishWhatsappRide leaves (so offers, accept, the timeout
 * and the ride page all treat it as theirs), auto-accept off (the rider picks
 * the driver), and the chat's one "Your bid is in" — held for the catch-up
 * while the rider is on the page.
 *
 *   started  it is a WhatsApp search now (or was already: delivered again)
 *   held     the rider is busy (searching, a driver being confirmed, on a trip):
 *            nothing is touched; ride-service puts it back to wait and the
 *            scheduler starts it once they are free
 *   app      no phone on the account: the app's path is the only way to reach them
 */
export async function startScheduledWhatsappSearch(
  deps: { redisClient: RedisClient; publisher?: Pick<GatewayPublisher, 'publishRideEvent'>; ridePageChat?: (event: RidePageChatEvent) => Promise<void> },
  event: RideRequestedEvent,
): Promise<ScheduledStart> {
  const redis = deps.redisClient;
  const doneKey = `ride:${event.rideId}:wa-scheduled`;
  if (await redis.get(doneKey).catch(() => null)) return 'started';

  const user = await userClient.findById(event.riderId).catch(() => null);
  const found = (await lookupPhoneByUserId(redis, event.riderId).catch(() => null)) ?? user?.phone ?? null;
  if (!found) return 'app';
  const phone: string = found;

  // Busy: the same question ride-service asks (the database), so both hold it together.
  if (await rideClient.findOtherLiveRide(event.riderId, event.rideId).catch(() => null)) return 'held';
  // A search they started a moment ago, not in the database yet: theirs. ride-service puts this one back when it replaces it.
  const current = await getActiveRide(redis, event.riderId).catch(() => null);
  if (current && current !== event.rideId) {
    const [state, meta] = await Promise.all([getRideState(redis, current).catch(() => null), getRideMeta(redis, current).catch(() => null)]);
    const started = meta?.createdAt ? Date.parse(meta.createdAt) : NaN;
    const searching = state === null || state === 'setup' || state === 'searching' || state === 'bidding';
    if (meta?.riderId === event.riderId && searching && Number.isFinite(started) && Date.now() - started < FRESH_SEARCH_MS) return 'held';
  }

  // Once per search, however often it is delivered.
  const first = await redis.setIfNotExists(doneKey, '1', DONE_TTL_SECONDS).catch(() => true);
  if (!first) return 'started';

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

  // Redis refusing a step: tried again here (Kafka does not retry a failed handler).
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= SET_UP_ATTEMPTS; attempt++) {
    try {
      await setUp();
      await tellChat();
      return 'started';
    } catch (error) {
      lastError = error;
      if (attempt < SET_UP_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }

  // Never half a WhatsApp search and half the app's: what was set up is undone, the
  // search ride-service started is ended quietly, and the ride for later waits again.
  console.warn('[gateway] scheduled ride: WhatsApp search not set up, put back to wait', { rideId: event.rideId, error: lastError instanceof Error ? lastError.message : String(lastError) });
  await clearActiveRideIfMatches(redis, event.riderId, event.rideId).catch(() => undefined);
  await cleanupRideKeys(redis, event.rideId).catch(() => undefined);
  await redis.del(doneKey).catch(() => undefined);
  await scheduledRideClient.requeueDispatched(event.rideId).catch(() => false);
  await deps.publisher?.publishRideEvent(RideCancelledEvent.parse({
    eventType: 'RIDE_CANCELLED',
    rideId: event.rideId,
    riderId: event.riderId,
    cancelledBy: 'system',
    reason: SCHEDULED_START_HELD_REASON,
    timestamp: new Date().toISOString(),
  })).catch((error) => console.warn('[gateway] scheduled ride: search not ended', { rideId: event.rideId, error: error instanceof Error ? error.message : String(error) }));
  return 'held';

  async function setUp(): Promise<void> {
    // The rider picks the driver: auto-accept is off for every ride for later. First,
    // before any offer can arrive.
    await autoAcceptOffAtStart(redis, event.rideId, event.riderId);
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
  }

  /** "Your bid is in", with the way to the offers. On the page: when they leave, if still searching. */
  async function tellChat(): Promise<void> {
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
