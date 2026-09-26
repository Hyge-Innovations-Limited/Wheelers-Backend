import { driverClient, rideClient } from '@wheleers/db';
import { RIDE, calculateSuggestedFare } from '@wheleers/config';
import type { RideEnv } from '@wheleers/config';
import type { MessageContext } from '@wheleers/kafka-client';
import {
  safeParseKafkaEvent,
  TOPICS,
  type RideCancelledEvent,
  type RideCounterOfferEvent,
  type RideRiderCounterOfferEvent,
  type RideDriverRejectedEvent,
  type RideOfferAcceptedEvent,
  type RideRouteUpdateRequestedEvent,
  type RideRequestedEvent,
} from '@wheleers/kafka-schemas';

import type { PendingRideMatch, RideServiceState } from '../index';
import type { RideEventsProducer } from '../producers/ride-events.producer';
import { matchDriver } from '../handlers/match-driver.handler';

/** How long one offer card rings on a driver's phone. */
const OFFER_TTL_MS = RIDE.OFFER_TTL_SECONDS * 1000;
/** How long the whole search runs before it gives up. A driver's bid does not shorten it: the rider reads offers in the form when they like. */
const BID_TIMEOUT_MS = RIDE.BID_TIMEOUT_SECONDS * 1000;
/** A rebuilt auction (after a restart) gets at least this long, whatever is left of its window. */
const REBUILT_MIN_WINDOW_MS = 60_000;
/** A rider has one search at a time: a new request ends the older one, wherever it came from. */
const SUPERSEDED_REASON = 'Replaced by a newer request';

export function createRideRequestedConsumer(params: {
  state: RideServiceState;
  rideEnv: RideEnv;
  rideEventsProducer: RideEventsProducer;
}): { handle: (value: unknown, ctx: MessageContext) => Promise<void>; rehydrate: () => Promise<number> } {
  const { state, rideEnv, rideEventsProducer } = params;

  return {
    rehydrate: rehydrateOpenSearches,
    async handle(value, ctx) {
      if (ctx.topic !== TOPICS.RIDE_EVENTS) return;
      const event = safeParseKafkaEvent(TOPICS.RIDE_EVENTS, value);
      if (!event) return;

      if (event.eventType === 'RIDE_REQUESTED') {
        await handleRideRequested(event);
        return;
      }

      if (event.eventType === 'RIDE_COUNTER_OFFER') {
        await handleCounterOffer(event);
        return;
      }

      if (event.eventType === 'RIDE_RIDER_COUNTER_OFFER') {
        await handleRiderCounterOffer(event);
        return;
      }

      if (event.eventType === 'RIDE_OFFER_ACCEPTED') {
        await handleOfferAccepted(event);
        return;
      }

      if (event.eventType === 'RIDE_DRIVER_REJECTED') {
        handleDriverRejected(event);
        return;
      }

      if (event.eventType === 'RIDE_ROUTE_UPDATE_REQUESTED') {
        handleRouteUpdateRequested(event);
        return;
      }

      if (event.eventType === 'RIDE_DRIVER_ASSIGNED') {
        clearPendingMatch(event.rideId);
        // Keep the full rider list. A blind overwrite here dropped every
        // non-anchor member of a group the instant a driver accepted, so from
        // that point on only the anchor got GPS relay and stale-movement
        // warnings — the other riders' apps went silent for the whole trip.
        state.rideParticipantsByRideId.set(event.rideId, {
          ...state.rideParticipantsByRideId.get(event.rideId),
          riderId: event.riderId,
          driverId: event.driverId,
        });

        const assignedDriver = state.onlineDrivers.get(event.driverId);
        if (assignedDriver) {
          state.assignedDriversByRideId.set(event.rideId, assignedDriver);
          state.onlineDrivers.delete(event.driverId);
        }
        return;
      }

      if (event.eventType === 'RIDE_CANCELLED') {
        clearPendingMatch(event.rideId);
        state.routeByRideId.delete(event.rideId);
        returnAssignedDriverToPool(event.rideId);

        // A driver bailing after they accepted is not the end of the ride —
        // the rider is still standing there waiting. Previously the ride just
        // died here and the rider was left with nothing. Put it back into
        // matching and offer it to every nearby driver except the one who left.
        if (event.cancelledBy === 'driver') {
          await redispatchAfterDriverCancel(event);
        }
        return;
      }

      if (event.eventType === 'RIDE_COMPLETED') {
        state.routeByRideId.delete(event.rideId);
        returnAssignedDriverToPool(event.rideId);
        return;
      }

      if (event.eventType === 'RIDE_BID_TIMEOUT') {
        // The pending entry used to survive the timeout forever — one leaked
        // Map entry per abandoned ride, for the life of the process. Dropping
        // it is safe now: a late accept rebuilds what it needs from the DB.
        clearPendingMatch(event.rideId);
        state.routeByRideId.delete(event.rideId);

        // Persist it. Rides used to stay MATCHING in the DB forever after a
        // timeout, so every unmatched request ever made counted as "active"
        // and blocked the rider's next booking. Guarded: a driver who was
        // assigned in the meantime keeps the trip.
        await rideClient
          .cancelIfUnmatched(event.rideId)
          .then((result) => {
            if (result.count > 0) {
              console.info('[ride-service] unmatched ride expired', { rideId: event.rideId });
            }
          })
          .catch((err) => {
            console.warn('[ride-service] could not persist bid timeout', {
              rideId: event.rideId,
              error: (err as any)?.message ?? err,
            });
          });
        return;
      }
    },
  };

  async function supersedeOlderSearches(event: RideRequestedEvent): Promise<void> {
    const older = await rideClient.findOpenSearches(BID_TIMEOUT_MS + 5 * 60_000, event.riderId, event.rideId).catch(() => []);
    for (const ride of older) {
      clearPendingMatch(ride.id);
      state.routeByRideId.delete(ride.id);
      // A driver may have been assigned between the lookup and this update; then the
      // trip is theirs and nothing is cancelled or announced.
      const cancelled = await rideClient.cancelIfUnmatched(ride.id, SUPERSEDED_REASON).catch(() => ({ count: 0 }));
      if (cancelled.count === 0) {
        console.info('[ride-service] older search already matched, left alone', { rideId: ride.id, by: event.rideId });
        continue;
      }
      // The gateway hears this: the fare hold goes back, drivers with bids are told, the
      // rider is not (they asked for the new search; this is housekeeping).
      await rideEventsProducer.rideCancelled({
        eventType: 'RIDE_CANCELLED',
        rideId: ride.id,
        riderId: ride.riderId,
        reason: SUPERSEDED_REASON,
        cancelledBy: 'system',
        timestamp: new Date().toISOString(),
      }).catch((err) => console.warn('[ride-service] could not cancel a superseded search', { rideId: ride.id, error: (err as any)?.message ?? err }));
      console.info('[ride-service] older search superseded', { rideId: ride.id, by: event.rideId, riderId: event.riderId });
    }
  }

  async function handleRideRequested(event: RideRequestedEvent): Promise<void> {
    await supersedeOlderSearches(event);
    state.routeByRideId.set(event.rideId, [
      ...event.stops.map((stop, index) => ({
        stopOrder: index,
        type: 'intermediate' as const,
        status: 'pending' as const,
        lat: stop.lat,
        lng: stop.lng,
        address: stop.address,
      })),
      {
        stopOrder: event.stops.length,
        type: 'final' as const,
        status: 'pending' as const,
        lat: event.destination.lat,
        lng: event.destination.lng,
        address: event.destination.address,
      },
    ]);

    // Persist ride (best-effort)
    try {
      await rideClient.create({
        id: event.rideId,
        riderId: event.riderId,
        pickupLat: event.pickup.lat,
        pickupLng: event.pickup.lng,
        pickupAddress: event.pickup.address,
        destLat: event.destination.lat,
        destLng: event.destination.lng,
        destAddress: event.destination.address,
        stops: event.stops,
        fareEstimateNgn: event.fareEstimateNgn,
        paymentMethod: event.paymentMethod,
        riderOfferNgn: event.riderOfferNgn,
        status: 'MATCHING',
      });
    } catch (err) {
      console.warn(`[ride-service] ride create skipped:`, (err as any)?.message ?? err);
      try {
        await rideClient.markMatching(event.rideId);
      } catch (markErr) {
        console.warn(`[ride-service] ride matching persistence skipped:`, (markErr as any)?.message ?? markErr);
      }
    }

    // Find nearby drivers
    const result = await matchDriver({
      rideEnv,
      onlineDrivers: state.onlineDrivers,
      rideRequested: event,
    });

    if (!result.ok) {
      console.log(`[ride-service] no matching drivers for ride ${event.rideId}: ${result.reason}`);
      // Don't cancel — start the bid timeout instead
      startBidTimeout(event);
      return;
    }

    // Clear any existing pending match
    const existing = state.pendingMatchesByRideId.get(event.rideId);
    if (existing?.timeout) clearTimeout(existing.timeout);

    state.pendingMatchesByRideId.set(event.rideId, {
      rideRequested: event,
      candidates: result.drivers,
      attemptedDriverIds: new Set(),
      offeredDriverId: null,
      timeout: null,
      counterOfferDrivers: new Map(),
    });

    // Broadcast to ALL nearby drivers simultaneously
    const expiresAt = new Date(Date.now() + OFFER_TTL_MS);

    await rideEventsProducer.broadcastRideOffer({
      drivers: result.drivers,
      rideRequested: event,
      expiresAt,
    });

    console.log(`[ride-service] broadcasted ride ${event.rideId} to ${result.drivers.length} drivers`);

    // Start bid timeout
    startBidTimeout(event);
  }

  /**
   * A seat bid arrives on the MEMBER's ride id, but the group's pending match
   * lives under the anchor id — resolve it so driver details and timeout
   * resets land where assignment reads them.
   */
  function findPendingForRideId(rideId: string): PendingRideMatch | undefined {
    const direct = state.pendingMatchesByRideId.get(rideId);
    if (direct) return direct;
    for (const pending of state.pendingMatchesByRideId.values()) {
      if (pending.group?.members?.some((member) => member.rideId === rideId)) {
        return pending;
      }
    }
    return undefined;
  }

  async function handleCounterOffer(event: RideCounterOfferEvent): Promise<void> {
    const pending = findPendingForRideId(event.rideId) ?? await rebuildPending(event.rideId);
    if (!pending) return;

    // The auction's clock is untouched by a bid. It used to shrink to a ten-minute
    // "decision window" here — fine when the rider sat watching the chat, wrong now
    // that offers wait in a form the rider opens when they like: a bid at minute 5
    // closed the search at minute 15, and a rider looking at minute 20 was told no
    // driver had come. The search runs its full window; a bid is simply on the table.

    // Store driver info so we can use it when the rider accepts
    pending.counterOfferDrivers.set(event.driverId, {
      driverName: event.driverName,
      driverRating: event.driverRating,
      vehiclePlate: event.vehiclePlate,
      vehicleModel: event.vehicleModel,
      etaSeconds: event.etaSeconds,
    });

    // Group rides negotiate like solo rides: bids are forwarded to the
    // anchor rider, who picks the driver for the group. The gateway sets up
    // the anchor's WhatsApp bid state at dispatch time so this works even
    // when the anchor booked over WhatsApp.
    // Counter-offer is forwarded to rider via gateway Kafka consumer → WebSocket
    console.log(`[ride-service] counter-offer on ride ${event.rideId} from driver ${event.driverId}: ₦${event.counterOfferNgn}`);
  }

  async function handleRiderCounterOffer(event: RideRiderCounterOfferEvent): Promise<void> {
    // No auction in memory for a live ride means the service restarted mid-search.
    // Rebuild it from the database — silently dropping the new price left drivers
    // on the old one while the rider's form said "Bid updated".
    const pending = findPendingForRideId(event.rideId) ?? await rebuildPending(event.rideId);
    if (!pending) return;

    // A group member countering on THEIR seat: update that seat's offer and
    // re-broadcast so every driver's card shows the new per-seat price. The
    // headline total becomes the sum of current seat offers.
    const seatMember = pending.group?.members?.find((m) => m.rideId === event.rideId);
    if (seatMember && pending.group?.members) {
      seatMember.offerNgn = event.counterOfferNgn;
      const seatTotal = pending.group.members.reduce((sum, m) => sum + m.offerNgn, 0);
      pending.rideRequested = {
        ...pending.rideRequested,
        riderOfferNgn: seatTotal,
      };
    } else {
      // Update the rider's offer amount for this ride
      pending.rideRequested = {
        ...pending.rideRequested,
        riderOfferNgn: event.counterOfferNgn,
      };
    }

    // Reset bid timeout since there's activity
    if (pending.timeout) {
      clearTimeout(pending.timeout);
      pending.timeout = null;
    }
    startBidTimeout(pending.rideRequested);

    const expiresAt = new Date(Date.now() + OFFER_TTL_MS);
    // For a seat counter, the card's headline number is the updated TOTAL —
    // the per-seat change itself travels in group.members.
    const broadcastOfferNgn = seatMember
      ? pending.rideRequested.riderOfferNgn
      : event.counterOfferNgn;

    if (event.driverId) {
      // Targeted counter-offer to a specific driver
      const driver = pending.candidates.find((d) => d.driverId === event.driverId)
        ?? state.onlineDrivers.get(event.driverId);

      if (!driver) {
        console.warn(`[ride-service] rider counter-offer: driver ${event.driverId} not found for ride ${event.rideId}`);
        return;
      }

      await rideEventsProducer.sendUpdatedOfferToDriver({
        driver,
        rideRequested: pending.rideRequested,
        updatedOfferNgn: broadcastOfferNgn,
        expiresAt,
        group: pending.group,
      });

      console.log(`[ride-service] rider counter-offer on ride ${event.rideId} to driver ${event.driverId}: ₦${event.counterOfferNgn}`);
    } else {
      // Send updated offer to ALL candidate drivers (WhatsApp flow — no specific driver targeted)
      if (pending.candidates.length > 0) {
        await Promise.all(
          pending.candidates.map((driver) =>
            rideEventsProducer.sendUpdatedOfferToDriver({
              driver,
              rideRequested: pending.rideRequested,
              updatedOfferNgn: broadcastOfferNgn,
              expiresAt,
              group: pending.group,
            }),
          ),
        );
        console.log(`[ride-service] rider counter-offer on ride ${event.rideId} sent to ${pending.candidates.length} drivers: ₦${event.counterOfferNgn}`);
      }
    }
  }

  async function handleOfferAccepted(event: RideOfferAcceptedEvent): Promise<void> {
    const pending = state.pendingMatchesByRideId.get(event.rideId);

    // One driver, one trip. Two riders accepting the same driver inside the
    // Kafka lag both passed the gateway's busy check; the second assignment
    // used to go through and overwrite the first on the driver's app.
    const busyWith = await rideClient.findActiveByDriver(event.driverId).catch(() => null);
    if (busyWith && busyWith.id !== event.rideId) {
      console.warn('[ride-service] offer accepted for a driver already on a trip — cancelling this ride', {
        rideId: event.rideId,
        driverId: event.driverId,
        busyRideId: busyWith.id,
      });
      await rideEventsProducer.rideCancelled({
        eventType: 'RIDE_CANCELLED',
        rideId: event.rideId,
        riderId: event.riderId,
        reason: 'driver_unavailable',
        cancelledBy: 'system',
        timestamp: new Date().toISOString(),
      }).catch((err) => {
        console.error('[ride-service] could not cancel double-booked ride', {
          rideId: event.rideId,
          error: (err as any)?.message ?? err,
        });
      });
      return;
    }

    // Pending match state is in-memory only, so a restart or a consumer-group
    // rebalance between RIDE_REQUESTED and the rider accepting wipes it. This
    // used to `return` silently — and on the WhatsApp path the rider's fare is
    // already held by then, so the money sat locked with no driver assigned and
    // nothing logged. Rebuild what we can from the database and go on: the
    // accept has to survive, everything below it is presentation detail.
    if (!pending) {
      console.warn('[ride-service] offer accepted with no pending match — rebuilding from DB', {
        rideId: event.rideId,
        riderId: event.riderId,
        driverId: event.driverId,
      });
    }

    // Clear timeout
    if (pending?.timeout) clearTimeout(pending.timeout);

    // Look up stored counter-offer driver info, fallback to in-memory pool for vehicle details
    const counterOfferInfo = pending?.counterOfferDrivers.get(event.driverId);
    const poolDriver = pending?.candidates.find((d) => d.driverId === event.driverId)
      ?? state.onlineDrivers.get(event.driverId);

    // Only hit the DB when memory could not supply the driver's details.
    const dbDriver =
      counterOfferInfo || poolDriver
        ? null
        : await driverClient.findById(event.driverId).catch((err) => {
            console.warn('[ride-service] driver lookup failed while rebuilding assignment', {
              rideId: event.rideId,
              driverId: event.driverId,
              error: (err as any)?.message ?? err,
            });
            return null;
          });

    // Publish RIDE_DRIVER_ASSIGNED
    await rideEventsProducer.rideDriverAssigned({
      eventType: 'RIDE_DRIVER_ASSIGNED',
      rideId: event.rideId,
      riderId: event.riderId,
      driverId: event.driverId,
      driverUserId: event.driverUserId,
      driverName: counterOfferInfo?.driverName ?? dbDriver?.user?.name ?? 'Driver',
      driverRating: counterOfferInfo?.driverRating ?? Number(dbDriver?.rating ?? 5.0),
      vehiclePlate: counterOfferInfo?.vehiclePlate ?? poolDriver?.vehiclePlate ?? dbDriver?.vehiclePlate ?? '',
      vehicleModel: counterOfferInfo?.vehicleModel ?? poolDriver?.vehicleModel ?? dbDriver?.vehicleModel ?? '',
      etaSeconds: counterOfferInfo?.etaSeconds ?? 0,
      agreedFareNgn: event.agreedFareNgn,
      lockedFareNgn: event.agreedFareNgn,
      paymentMethod: event.paymentMethod,
      timestamp: new Date().toISOString(),
    });

    // Group rides: the solo RIDE_DRIVER_ASSIGNED above is keyed to the anchor
    // rideId only, so the other members would never hear a driver was found.
    // Tell the whole group.
    if (pending?.group) {
      await rideEventsProducer.groupRideDriverAssigned({
        eventType: 'GROUP_RIDE_DRIVER_ASSIGNED',
        groupId: pending.group.groupId,
        rideIds: pending.group.rideIds,
        riderIds: pending.group.riderIds,
        driverId: event.driverId,
        driverUserId: event.driverUserId,
        driverName: counterOfferInfo?.driverName ?? dbDriver?.user?.name ?? 'Driver',
        driverRating: counterOfferInfo?.driverRating ?? Number(dbDriver?.rating ?? 5.0),
        vehiclePlate: counterOfferInfo?.vehiclePlate ?? poolDriver?.vehiclePlate ?? dbDriver?.vehiclePlate ?? '',
        vehicleModel: counterOfferInfo?.vehicleModel ?? poolDriver?.vehicleModel ?? dbDriver?.vehicleModel ?? '',
        etaSeconds: counterOfferInfo?.etaSeconds ?? 0,
        timestamp: new Date().toISOString(),
      }).catch((err) => {
        console.warn('[ride-service] failed to publish GROUP_RIDE_DRIVER_ASSIGNED', {
          groupId: pending.group?.groupId,
          error: (err as any)?.message ?? err,
        });
      });
    }

    // Clean up pending state
    state.pendingMatchesByRideId.delete(event.rideId);
  }

  function handleDriverRejected(event: RideDriverRejectedEvent): void {
    const pending = state.pendingMatchesByRideId.get(event.rideId);
    if (!pending) return;

    // Remove driver from candidates
    pending.candidates = pending.candidates.filter((d) => d.driverId !== event.driverId);
    pending.attemptedDriverIds.add(event.driverId);
  }

  function handleRouteUpdateRequested(event: RideRouteUpdateRequestedEvent): void {
    const pending = state.pendingMatchesByRideId.get(event.rideId);
    if (!pending) return;

    pending.rideRequested = {
      ...pending.rideRequested,
      destination: event.destination,
      stops: event.stops,
      plannedDistanceKm: event.plannedDistanceKm ?? pending.rideRequested.plannedDistanceKm,
      plannedDurationSeconds:
        event.plannedDurationSeconds ?? pending.rideRequested.plannedDurationSeconds,
      fareEstimateNgn: event.fareEstimateNgn ?? pending.rideRequested.fareEstimateNgn,
      timestamp: event.timestamp,
    };
  }

  function startBidTimeout(event: RideRequestedEvent, windowMs: number = BID_TIMEOUT_MS): void {
    const pending = state.pendingMatchesByRideId.get(event.rideId);

    const timeout = setTimeout(() => {
      void rideEventsProducer.rideBidTimeout({
        eventType: 'RIDE_BID_TIMEOUT',
        rideId: event.rideId,
        riderId: event.riderId,
        timestamp: new Date().toISOString(),
      }).catch((err) => {
        console.warn(`[ride-service] bid timeout publish failed:`, (err as any)?.message ?? err);
      });
    }, windowMs);
    timeout.unref();

    if (pending) {
      pending.timeout = timeout;
    } else {
      // No drivers found — create a minimal pending entry for the timeout
      state.pendingMatchesByRideId.set(event.rideId, {
        rideRequested: event,
        candidates: [],
        attemptedDriverIds: new Set(),
        offeredDriverId: null,
        timeout,
        counterOfferDrivers: new Map(),
      });
    }
  }

  /** The ride row as the event that started it — for auctions the service has to rebuild. */
  function rideRequestedFromRow(
    ride: NonNullable<Awaited<ReturnType<typeof rideClient.findById>>>,
  ): RideRequestedEvent {
    const stops = ride.routeStops
      .filter((stop) => stop.type === 'INTERMEDIATE' && stop.status !== 'COMPLETED')
      .map((stop) => ({ lat: stop.lat, lng: stop.lng, address: stop.address }));
    const distanceKm = ride.distanceKm ?? 0;
    const pricing = calculateSuggestedFare(distanceKm);
    const riderOfferNgn =
      ride.riderOfferNgn !== null && ride.riderOfferNgn !== undefined
        ? Number(ride.riderOfferNgn)
        : pricing.suggestedFareNgn;
    return {
      eventType: 'RIDE_REQUESTED',
      rideId: ride.id,
      riderId: ride.riderId,
      pickup: { lat: ride.pickupLat, lng: ride.pickupLng, address: ride.pickupAddress },
      destination: { lat: ride.destLat, lng: ride.destLng, address: ride.destAddress },
      stops: stops.slice(0, 5),
      fareEstimateNgn:
        ride.fareEstimateNgn !== null && ride.fareEstimateNgn !== undefined
          ? Number(ride.fareEstimateNgn)
          : pricing.suggestedFareNgn,
      paymentMethod: ride.paymentMethod === 'CASH' ? 'CASH' : 'WALLET',
      riderOfferNgn,
      suggestedFareNgn: pricing.suggestedFareNgn,
      minOfferNgn: pricing.minOfferNgn,
      ratePerKmNgn: pricing.ratePerKmNgn,
      plannedDistanceKm: ride.distanceKm ?? undefined,
      plannedDurationSeconds: ride.durationSeconds ?? undefined,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Put a live search back into memory from its ride row: re-run matching, offer
   * it to every nearby driver (their apps replace cards by ride id, so a driver
   * who already has it sees nothing new), and arm what is left of its window.
   * Null when the ride is not open any more. `excludeDriverId` keeps a driver
   * who just walked away from being offered the same job again.
   */
  async function rebuildPending(
    rideId: string,
    options: { excludeDriverId?: string; resetStatus?: boolean } = {},
  ): Promise<PendingRideMatch | null> {
    const ride = await rideClient.findById(rideId).catch((err) => {
      console.error('[ride-service] cannot rebuild search — ride lookup failed', {
        rideId,
        error: (err as any)?.message ?? err,
      });
      return null;
    });
    if (!ride) return null;
    if (ride.status === 'COMPLETED' || ride.status === 'CANCELLED') return null;
    if (options.resetStatus) {
      await rideClient.markMatching(rideId).catch((err) => {
        console.warn('[ride-service] could not reset ride to MATCHING', { rideId, error: (err as any)?.message ?? err });
      });
    } else if (ride.status !== 'REQUESTED' && ride.status !== 'MATCHING') {
      return null;
    }

    const rideRequested = rideRequestedFromRow(ride);
    state.routeByRideId.set(ride.id, [
      ...rideRequested.stops.map((stop, index) => ({ stopOrder: index, type: 'intermediate' as const, status: 'pending' as const, lat: stop.lat, lng: stop.lng, address: stop.address })),
      { stopOrder: rideRequested.stops.length, type: 'final' as const, status: 'pending' as const, lat: ride.destLat, lng: ride.destLng, address: ride.destAddress },
    ]);

    const result = await matchDriver({ rideEnv, onlineDrivers: state.onlineDrivers, rideRequested });
    const drivers = result.ok
      ? result.drivers.filter((driver) => driver.driverId !== options.excludeDriverId)
      : [];

    const attemptedDriverIds = new Set<string>();
    if (options.excludeDriverId) attemptedDriverIds.add(options.excludeDriverId);

    const existing = state.pendingMatchesByRideId.get(ride.id);
    if (existing?.timeout) clearTimeout(existing.timeout);
    const pending: PendingRideMatch = {
      rideRequested,
      candidates: drivers,
      attemptedDriverIds,
      offeredDriverId: null,
      timeout: null,
      counterOfferDrivers: new Map(),
    };
    state.pendingMatchesByRideId.set(ride.id, pending);

    // What is left of the window, never less than a minute: the rider is told either
    // way, and a re-match with no drivers left must not strand them in a silent search.
    const elapsedMs = Date.now() - ride.createdAt.getTime();
    startBidTimeout(rideRequested, options.resetStatus ? BID_TIMEOUT_MS : Math.max(REBUILT_MIN_WINDOW_MS, BID_TIMEOUT_MS - elapsedMs));

    if (drivers.length > 0) {
      await rideEventsProducer.broadcastRideOffer({
        drivers,
        rideRequested,
        expiresAt: new Date(Date.now() + OFFER_TTL_MS),
      });
    }
    console.info('[ride-service] search rebuilt from the database', {
      rideId: ride.id,
      drivers: drivers.length,
      ageSeconds: Math.round(elapsedMs / 1000),
      reason: options.excludeDriverId ? 'driver cancelled' : 'not in memory',
    });
    return pending;
  }

  /**
   * On start: every solo search still inside its window goes back into memory.
   * The auction used to live in this process only, so a deploy mid-search left
   * riders changing their price into the void and late drivers offered nothing,
   * until the stale sweep closed the ride. Group seats are the group dispatcher's.
   */
  async function rehydrateOpenSearches(): Promise<number> {
    const open = await rideClient.findOpenSearches(BID_TIMEOUT_MS).catch((err) => {
      console.error('[ride-service] could not load open searches on start', { error: (err as any)?.message ?? err });
      return [];
    });
    let rebuilt = 0;
    for (const ride of open) {
      if (state.pendingMatchesByRideId.has(ride.id)) continue;
      if (await rebuildPending(ride.id)) rebuilt += 1;
    }
    if (open.length > 0) console.info('[ride-service] open searches on start', { found: open.length, rebuilt });
    return rebuilt;
  }

  /**
   * A driver bailing after they accepted is not the end of the ride — the rider
   * is still standing there. Put it back into matching and offer it to every
   * nearby driver except the one who left.
   */
  async function redispatchAfterDriverCancel(event: RideCancelledEvent): Promise<void> {
    const pending = await rebuildPending(event.rideId, { excludeDriverId: event.driverId ?? undefined, resetStatus: true });
    if (!pending) return;
    if (pending.candidates.length === 0) {
      console.log(`[ride-service] driver ${event.driverId} cancelled ride ${event.rideId}; no other drivers available`);
      return;
    }
    console.log(`[ride-service] driver ${event.driverId} cancelled ride ${event.rideId} — re-broadcast to ${pending.candidates.length} drivers`);
  }

  function clearPendingMatch(rideId: string): void {
    const pending = state.pendingMatchesByRideId.get(rideId);
    if (pending?.timeout) clearTimeout(pending.timeout);
    state.pendingMatchesByRideId.delete(rideId);
  }

  function returnAssignedDriverToPool(rideId: string): void {
    const assignedDriver = state.assignedDriversByRideId.get(rideId);
    state.rideParticipantsByRideId.delete(rideId);
    if (!assignedDriver) return;

    const gps = state.gpsByRideId.get(rideId);
    state.onlineDrivers.set(assignedDriver.driverId, {
      ...assignedDriver,
      lat: gps?.lastLat ?? assignedDriver.lat,
      lng: gps?.lastLng ?? assignedDriver.lng,
    });
    state.assignedDriversByRideId.delete(rideId);
  }
}
