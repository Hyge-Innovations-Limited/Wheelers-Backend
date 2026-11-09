import { RIDE, calculateSuggestedFare } from '@wheleers/config';
import type { RideEnv } from '@wheleers/config';
import type { MessageContext } from '@wheleers/kafka-client';
import {
  safeParseKafkaEvent,
  TOPICS,
  type GroupRideDriverDispatchRequestedEvent,
  type RideRequestedEvent,
} from '@wheleers/kafka-schemas';

import type { RideServiceState } from '../index';
import type { RideEventsProducer } from '../producers/ride-events.producer';
import { matchDriver } from '../handlers/match-driver.handler';

/** Same windows solo rides use, so a group offer behaves identically. */
const BID_TIMEOUT_MS = RIDE.BID_TIMEOUT_SECONDS * 1000;

export function createGroupRideDispatchConsumer(params: {
  state: RideServiceState;
  rideEnv: RideEnv;
  rideEventsProducer: RideEventsProducer;
}): { handle: (value: unknown, ctx: MessageContext) => Promise<void> } {
  const { state, rideEnv, rideEventsProducer } = params;

  // Kafka gives at-least-once delivery, so a rebalance or a retried batch can
  // hand us the same dispatch twice. Re-running it re-broadcasts the offer to
  // every nearby driver and resets the pending match under a ride that may
  // already have a driver on it.
  const dispatchedGroupIds = new Set<string>();
  const MAX_REMEMBERED_DISPATCHES = 1000;

  return {
    async handle(value, ctx) {
      if (ctx.topic !== TOPICS.GROUP_RIDE_EVENTS) return;
      const event = safeParseKafkaEvent(TOPICS.GROUP_RIDE_EVENTS, value);
      if (!event) return;

      if (event.eventType === 'GROUP_RIDE_DRIVER_DISPATCH_REQUESTED') {
        await handleDispatchRequested(event);
      }
    },
  };

  function rememberDispatch(groupId: string): void {
    dispatchedGroupIds.add(groupId);
    if (dispatchedGroupIds.size > MAX_REMEMBERED_DISPATCHES) {
      // Sets iterate in insertion order — drop the oldest.
      const oldest = dispatchedGroupIds.values().next();
      if (!oldest.done) dispatchedGroupIds.delete(oldest.value);
    }
  }

  async function handleDispatchRequested(
    event: GroupRideDriverDispatchRequestedEvent,
  ): Promise<void> {
    if (dispatchedGroupIds.has(event.groupId)) {
      console.log(
        `[ride-service] ignoring duplicate dispatch for group ${event.groupId}`,
      );
      return;
    }

    if (state.assignedDriversByRideId.has(event.anchorRideId)) {
      console.warn('[ride-service] group dispatch arrived after a driver was already assigned — ignored', {
        groupId: event.groupId,
        anchorRideId: event.anchorRideId,
      });
      return;
    }

    // Synthesise a RideRequestedEvent from the group dispatch event so we can
    // reuse the existing matchDriver() and offer pipeline.
    // Price the group leg through the shared fare function so the minimum fare
    // and the real per-km rate apply, instead of echoing the incoming estimate
    // back as its own floor.
    const pricing = calculateSuggestedFare(event.totalDistanceKm);

    // Give the driver the real shape of the job. Previously destination was set
    // to the pickup and stops to [], so the offer read "X to X, 0 stops" for a
    // multi-pickup trip and the driver accepted blind.
    const sequence = event.stops ?? [];
    const toLatLng = (s: { lat: number; lng: number; address: string }) => ({
      lat: s.lat,
      lng: s.lng,
      address: s.address,
    });

    // `stops` is optional on the wire, and the whole shape of the offer is
    // derived from it — pickup, destination, stop count, stop kinds. Without a
    // usable sequence the offer degrades to "first pickup → first pickup, 0
    // stops", which is what a driver would be accepting blind. Refuse to send
    // that rather than misrepresent the job.
    const firstStop = sequence[0];
    const finalStop = sequence[sequence.length - 1];
    const sequenceIsUsable =
      sequence.length >= 4 &&
      firstStop?.kind === 'pickup' &&
      finalStop?.kind === 'dropoff';

    if (!sequenceIsUsable) {
      console.error('[ride-service] group dispatch has no usable stop sequence — NOT dispatched', {
        groupId: event.groupId,
        anchorRideId: event.anchorRideId,
        stopCount: sequence.length,
        firstKind: firstStop?.kind ?? null,
        lastKind: finalStop?.kind ?? null,
      });
      return;
    }

    // Ride.stops is capped at 5 by the schema; the ends become pickup/destination.
    const middles = sequence.slice(1, -1);
    const intermediateStops = middles.slice(0, 5).map(toLatLng);

    if (middles.length > 5) {
      // Only reachable if GROUP_RIDE_MAX_SIZE grows past 3. Never drop stops
      // quietly — the driver would be routed past a passenger they never saw.
      console.error('[ride-service] group ride has more stops than the ride schema allows — TRUNCATED', {
        groupId: event.groupId,
        anchorRideId: event.anchorRideId,
        totalStops: sequence.length,
        droppedStops: middles.slice(5).map((s) => s.address),
      });
    }

    const syntheticRide: RideRequestedEvent = {
      eventType: 'RIDE_REQUESTED',
      rideId: event.anchorRideId,
      riderId: event.riderIds[0],
      // The sequence is what the driver actually drives, so it wins over
      // firstPickup if the two ever disagree.
      pickup: toLatLng(firstStop),
      destination: toLatLng(finalStop),
      stops: intermediateStops,
      fareEstimateNgn: event.fareEstimateNgn,
      // CASH until per-seat wallet settlement exists — each rider pays the
      // driver their own seat price; no single wallet must escrow the total.
      paymentMethod: 'CASH',
      riderOfferNgn: event.fareEstimateNgn,
      suggestedFareNgn: pricing.suggestedFareNgn,
      minOfferNgn: pricing.minOfferNgn,
      ratePerKmNgn: pricing.ratePerKmNgn,
      plannedDistanceKm: event.totalDistanceKm,
      plannedDurationSeconds: event.totalDurationSeconds,
      route: event.route,
      timestamp: event.timestamp,
    };

    const groupInfo = {
      groupId: event.groupId,
      riderCount: event.riderIds.length,
      // Kept parallel to `stops` above — same slice, same order.
      stopKinds: middles.slice(0, 5).map((s) => s.kind),
      rideIds: [...event.rideIds],
      riderIds: [...event.riderIds],
      members: event.members,
    };

    const result = await matchDriver({
      rideEnv,
      onlineDrivers: state.onlineDrivers,
      rideRequested: syntheticRide,
    });

    rememberDispatch(event.groupId);

    // Record every rider on the group, not just whichever one happened to be
    // last in a loop that kept overwriting the same key.
    state.rideParticipantsByRideId.set(event.anchorRideId, {
      riderId: event.riderIds[0]!,
      driverId: '',
      riderIds: [...event.riderIds],
    });

    // Set up the pending match so the existing offer → reject → retry loop works.
    const existing = state.pendingMatchesByRideId.get(event.anchorRideId);
    if (existing?.timeout) clearTimeout(existing.timeout);

    const pending = {
      rideRequested: syntheticRide,
      candidates: result.ok ? result.drivers : [],
      attemptedDriverIds: new Set<string>(),
      offeredDriverId: null,
      timeout: null as NodeJS.Timeout | null,
      // When this search closes: every offer of it, sent now or re-sent later, shows the same clock.
      closesAt: Date.now() + BID_TIMEOUT_MS,
      counterOfferDrivers: new Map(),
      group: groupInfo,
    };
    state.pendingMatchesByRideId.set(event.anchorRideId, pending);

    // Solo rides get a bid timeout whether or not a driver was found; group
    // rides got neither. With no driver nearby the group used to fall off the
    // end of this function in silence — nobody told the riders, and the entry
    // sat in pendingMatchesByRideId for the life of the process. Arming the
    // timeout first means the group is always resolved one way or the other.
    pending.timeout = startBidTimeout(event.anchorRideId, event.riderIds[0]!);

    if (!result.ok) {
      console.log(
        `[ride-service] no drivers for group ride ${event.groupId}: ${result.reason} — riders will get the bid timeout`,
      );
      return;
    }

    // Broadcast ride offer to ALL nearby drivers simultaneously
    const expiresAt = new Date(pending.closesAt);

    await rideEventsProducer.broadcastRideOffer({
      drivers: result.drivers,
      rideRequested: syntheticRide,
      expiresAt,
      group: groupInfo,
    });

    console.log(
      `[ride-service] broadcasted group ride ${event.groupId} (anchor=${event.anchorRideId}) to ${result.drivers.length} drivers`,
    );
  }

  function startBidTimeout(rideId: string, riderId: string): NodeJS.Timeout {
    const timeout = setTimeout(() => {
      void rideEventsProducer
        .rideBidTimeout({
          eventType: 'RIDE_BID_TIMEOUT',
          rideId,
          riderId,
          timestamp: new Date().toISOString(),
        })
        .catch((err) => {
          console.warn('[ride-service] group ride bid timeout publish failed:', (err as any)?.message ?? err);
        });
    }, BID_TIMEOUT_MS);
    timeout.unref();
    return timeout;
  }
}
