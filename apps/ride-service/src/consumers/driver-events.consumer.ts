import { driverClient, rideClient } from '@wheleers/db';
import { safeParseKafkaEvent, TOPICS, type DriverOnlineEvent, type DriverOfflineEvent } from '@wheleers/kafka-schemas';
import type { MessageContext } from '@wheleers/kafka-client';

import type { RideServiceState } from '../index';

export function createDriverEventsConsumer(params: {
  state: RideServiceState;
  onDriverOnline?: (event: DriverOnlineEvent) => Promise<void>;
  onDriverOffline?: (event: DriverOfflineEvent) => Promise<void>;
}): { handle: (value: unknown, ctx: MessageContext) => Promise<void> } {
  const { state, onDriverOnline, onDriverOffline } = params;

  return {
    async handle(value, ctx) {
      if (ctx.topic !== TOPICS.DRIVER_EVENTS) return;
      const event = safeParseKafkaEvent(TOPICS.DRIVER_EVENTS, value);
      if (!event) return;

      if (event.eventType === 'DRIVER_ONLINE') {
        // The app re-announces online on every reconnect, including mid-trip.
        // A driver on a trip is not in the market: putting them back in the
        // pool re-broadcast every pending ride to them and flipped their
        // status from ON_RIDE to ONLINE.
        const onTrip = await rideClient.findActiveByDriver(event.driverId).catch(() => null);
        if (onTrip) {
          console.info('[ride-service] driver online ignored — on a trip', {
            driverId: event.driverId,
            rideId: onTrip.id,
          });
          return;
        }
        state.onlineDrivers.set(event.driverId, {
          driverId: event.driverId,
          userId: event.userId,
          lat: event.lat,
          lng: event.lng,
          vehiclePlate: event.vehiclePlate,
          vehicleModel: event.vehicleModel,
        });
        try {
          await driverClient.markOnline(event.driverId, event.lat, event.lng);
        } catch (err) {
          console.error('[ride-service] driver online persistence FAILED — driver is live in memory only', {
            driverId: event.driverId,
            userId: event.userId,
            error: (err as any)?.message ?? err,
          });
        }
        if (onDriverOnline) await onDriverOnline(event);
      }

      if (event.eventType === 'DRIVER_OFFLINE') {
        state.onlineDrivers.delete(event.driverId);

        // Drop them from every ride still taking bids. Leaving them in
        // `candidates` meant an offline driver kept receiving rider
        // counter-offers and updated fares, and could still be picked as the
        // match for a ride they were no longer available for.
        for (const [rideId, pending] of state.pendingMatchesByRideId) {
          const before = pending.candidates.length;
          pending.candidates = pending.candidates.filter(
            (candidate) => candidate.driverId !== event.driverId,
          );
          if (pending.candidates.length !== before) {
            // Deliberately NOT added to attemptedDriverIds. That set means
            // "already offered this, or turned it down", and onDriverOnline
            // skips anyone in it. Going offline is neither — marking them here
            // meant a driver who dipped offline and came straight back was
            // never re-sent a request that was still live.
            console.log(
              `[ride-service] driver ${event.driverId} went offline — removed from bidding on ride ${rideId}`,
            );
          }
        }

        // A driver mid-trip keeps their assignment. Clearing it here meant the
        // trip lost its driver mapping, so completion could not return them to
        // the pool and GPS state for the ride was orphaned.
        for (const [rideId, driver] of state.assignedDriversByRideId) {
          if (driver.driverId === event.driverId) {
            console.warn('[ride-service] driver went offline while assigned to a ride', {
              rideId,
              driverId: event.driverId,
            });
          }
        }
        try {
          await driverClient.markOffline(event.driverId);
        } catch (err) {
          console.error('[ride-service] driver offline persistence FAILED', {
            driverId: event.driverId,
            error: (err as any)?.message ?? err,
          });
        }
        if (onDriverOffline) await onDriverOffline(event);
      }
    },
  };
}
