import { GoogleMapsRoutePlanner } from '@wheleers/config';
import { DriverStatus, driverClient, rideClient } from '@wheleers/db';
import type { MessageContext } from '@wheleers/kafka-client';
import { safeParseKafkaEvent, TOPICS } from '@wheleers/kafka-schemas';

import type { RideRouteStopState, RideServiceState } from '../index';
import type { RideEventsProducer } from '../producers/ride-events.producer';

export type TripLifecycleHandler = {
  handleRideEvent(value: unknown, ctx: MessageContext): Promise<void>;
};

export function createTripLifecycleHandler(params?: {
  state?: RideServiceState;
  rideEventsProducer?: RideEventsProducer;
  routePlanner?: GoogleMapsRoutePlanner;
}): TripLifecycleHandler {
  const state = params?.state;
  const rideEventsProducer = params?.rideEventsProducer;
  const routePlanner = params?.routePlanner;

  return {
    async handleRideEvent(value, ctx) {
      if (ctx.topic !== TOPICS.RIDE_EVENTS) return;
      const event = safeParseKafkaEvent(TOPICS.RIDE_EVENTS, value);
      if (!event) return;

      if (event.eventType === 'RIDE_DRIVER_ASSIGNED') {
        // Merge, never replace — see the note in ride-requested.consumer.ts:
        // replacing drops a group ride's non-anchor riders.
        state?.rideParticipantsByRideId.set(event.rideId, {
          ...state.rideParticipantsByRideId.get(event.rideId),
          riderId: event.riderId,
          driverId: event.driverId,
        });

        try {
          const assigned = await rideClient.assignDriver(event.rideId, event.driverId, {
            agreedFareNgn: event.agreedFareNgn,
            paymentMethod: event.paymentMethod,
          });
          if (assigned.count === 0) {
            // Already assigned (a second accept raced this one) or no longer
            // open. The first driver keeps the trip; this one is not marked
            // ON_RIDE for a ride they did not get.
            console.warn('[ride-service] assignment skipped — ride already assigned or closed', {
              rideId: event.rideId,
              driverId: event.driverId,
            });
            return;
          }
          await driverClient.updateStatus(event.driverId, DriverStatus.ON_RIDE);
        } catch (err) {
          // agreedFareNgn is written here and read back at completion. If this
          // fails the ride settles on fareEstimateNgn — the suggested fare, not
          // the negotiated one — while escrow still holds the agreed amount.
          console.error('[ride-service] CRITICAL: ride assignment persistence FAILED — settlement may use the wrong fare', {
            rideId: event.rideId,
            driverId: event.driverId,
            agreedFareNgn: event.agreedFareNgn,
            error: (err as any)?.message ?? err,
          });
        }
      }

      if (event.eventType === 'RIDE_ARRIVED') {
        try {
          await rideClient.markArrived(event.rideId);
        } catch (err) {
          console.warn(`[ride-service] ride arrival persistence skipped:`, (err as any)?.message ?? err);
        }
      }

      if (event.eventType === 'RIDE_STARTED') {
        state?.rideParticipantsByRideId.set(event.rideId, {
          ...state.rideParticipantsByRideId.get(event.rideId),
          riderId: event.riderId,
          driverId: event.driverId,
        });

        try {
          await rideClient.start(event.rideId);
        } catch (err) {
          console.warn(`[ride-service] ride start skipped:`, (err as any)?.message ?? err);
        }
      }

      if (event.eventType === 'RIDE_ROUTE_UPDATE_REQUESTED') {
        try {
          const plannedRoute =
            event.plannedDistanceKm !== undefined &&
            event.plannedDurationSeconds !== undefined &&
            event.fareEstimateNgn !== undefined
              ? {
                  distanceKm: event.plannedDistanceKm,
                  durationSeconds: event.plannedDurationSeconds,
                  fareEstimateNgn: event.fareEstimateNgn,
                  geometry: event.route,
                }
              : await planUpdatedRoute(event.rideId, event.destination, event.stops);

          const routeStops = await rideClient.syncRouteStops(event.rideId, {
            destination: event.destination,
            stops: event.stops,
            fareEstimateNgn: plannedRoute?.fareEstimateNgn ?? event.fareEstimateNgn,
          });
          syncRouteState(event.rideId, routeStops);
          await publishRouteUpdatedSnapshot({
            rideId: event.rideId,
            riderId: event.riderId,
            driverId: event.driverId,
            plannedDistanceKm: plannedRoute?.distanceKm ?? event.plannedDistanceKm,
            plannedDurationSeconds: plannedRoute?.durationSeconds ?? event.plannedDurationSeconds,
            fareEstimateNgn: plannedRoute?.fareEstimateNgn ?? event.fareEstimateNgn,
            route: plannedRoute?.geometry ?? event.route,
            updatedBy: event.updatedBy,
            routeStops,
          });
        } catch (err) {
          console.warn(`[ride-service] route update skipped:`, (err as any)?.message ?? err);
        }
      }

      if (event.eventType === 'RIDE_STOP_CONFIRMED') {
        try {
          const result = await rideClient.completeNextStop(event.rideId);
          if (!result) {
            return;
          }

          syncRouteState(event.rideId, result.routeStops);
          await publishRouteUpdatedSnapshot({
            rideId: event.rideId,
            riderId: event.riderId,
            driverId: event.driverId,
            updatedBy: event.confirmedBy,
            routeStops: result.routeStops,
          });
        } catch (err) {
          console.warn(`[ride-service] stop confirmation skipped:`, (err as any)?.message ?? err);
        }
      }

      if (event.eventType === 'RIDE_COMPLETION_REQUESTED') {
        if (!rideEventsProducer) {
          return;
        }

        try {
          const ride = await rideClient.findById(event.rideId);
          if (ride.status === 'COMPLETED' || ride.status === 'CANCELLED') {
            return;
          }

          const completedAt = resolveCompletedAt(event.completedAt, event.timestamp);
          const gpsState = state?.gpsByRideId.get(event.rideId);
          const distanceKm = round3(
            gpsState?.totalDistanceKm ?? (await estimateDistanceFromGpsLogs(event.rideId)),
          );
          const durationSeconds = resolveDurationSeconds(ride.startedAt, completedAt);
          const fareNgn = resolveFareNgn({
            requestedFareNgn: event.fareNgn,
            estimatedFareNgn:
              ride.fareEstimateNgn !== null && ride.fareEstimateNgn !== undefined
                ? Number(ride.fareEstimateNgn)
                : undefined,
            agreedFareNgn:
              ride.agreedFareNgn !== null && ride.agreedFareNgn !== undefined
                ? Number(ride.agreedFareNgn)
                : undefined,
          });

          const routeStops = await rideClient.completeFinalStop(event.rideId, completedAt);
          syncRouteState(event.rideId, routeStops);

          const driverUserId = await resolveDriverUserId(event.driverId);

          await rideEventsProducer.rideCompleted({
            eventType: 'RIDE_COMPLETED',
            rideId: event.rideId,
            riderId: event.riderId,
            driverId: event.driverId,
            driverUserId,
            fareNgn,
            distanceKm,
            durationSeconds,
            endedBy: event.endedBy,
            completedAt: completedAt.toISOString(),
            paymentMethod: ride.paymentMethod ?? 'WALLET',
            timestamp: new Date().toISOString(),
          });
        } catch (err) {
          // Nothing downstream runs without RIDE_COMPLETED: the rider's fare
          // stays locked in escrow and the driver is never credited.
          console.error('[ride-service] CRITICAL: ride completion FAILED — no RIDE_COMPLETED published, fare still held', {
            rideId: event.rideId,
            riderId: event.riderId,
            driverId: event.driverId,
            error: (err as any)?.message ?? err,
          });
        }
      }

      if (event.eventType === 'RIDE_COMPLETED') {
        state?.rideParticipantsByRideId.delete(event.rideId);
        state?.gpsByRideId.delete(event.rideId);
        state?.routeByRideId.delete(event.rideId);

        try {
          await rideClient.complete(event.rideId, {
            fareFinalNgn: event.fareNgn,
            distanceKm: event.distanceKm,
            durationSeconds: event.durationSeconds,
            paymentMethod: event.paymentMethod,
          });
          await Promise.all([
            driverClient.updateStatus(event.driverId, DriverStatus.ONLINE),
            driverClient.incrementTotalRides(event.driverId),
          ]);
        } catch (err) {
          console.warn(`[ride-service] ride completion persistence skipped:`, (err as any)?.message ?? err);
        }
      }

      if (event.eventType === 'RIDE_CANCELLED') {
        state?.gpsByRideId.delete(event.rideId);
        state?.routeByRideId.delete(event.rideId);

        // A driver walking away does NOT end the ride — ride-service puts it
        // straight back into matching for another driver. Writing CANCELLED
        // here would bury a ride that is actively being re-broadcast, and it
        // would show up in history as cancelled while the rider is still
        // waiting. Only a rider (or the system) cancelling truly ends it.
        const ridePutBackIntoMatching = event.cancelledBy === 'driver';

        try {
          if (ridePutBackIntoMatching) {
            // Hand the driver back to the pool; the ride itself lives on.
            if (event.driverId) {
              await driverClient.updateStatus(event.driverId, DriverStatus.ONLINE);
            }
            return;
          }

          state?.rideParticipantsByRideId.delete(event.rideId);
          await rideClient.cancel(event.rideId, {
            cancelReason: event.reason,
          });
          if (event.driverId) {
            await driverClient.updateStatus(event.driverId, DriverStatus.ONLINE);
          }
        } catch (err) {
          console.warn(`[ride-service] ride cancel skipped:`, (err as any)?.message ?? err);
        }
      }
    },
  };

  async function publishRouteUpdatedSnapshot(params: {
    rideId: string;
    riderId: string;
    driverId?: string;
    plannedDistanceKm?: number;
    plannedDurationSeconds?: number;
    fareEstimateNgn?: number;
    route?: {
      coordinates: Array<{ lat: number; lng: number }>;
      bounds: {
        northEast: { lat: number; lng: number };
        southWest: { lat: number; lng: number };
      };
    };
    updatedBy: 'rider' | 'driver' | 'system';
    routeStops: Array<{
      id: string;
      stopOrder: number;
      type: 'INTERMEDIATE' | 'FINAL';
      status: 'PENDING' | 'COMPLETED' | 'SKIPPED';
      lat: number;
      lng: number;
      address: string;
      completedAt: Date | null;
    }>;
  }): Promise<void> {
    if (!rideEventsProducer) {
      return;
    }

    let driverId = params.driverId;
    if (!driverId) {
      try {
        const ride = await rideClient.findById(params.rideId);
        driverId = ride.driverId ?? undefined;
      } catch {
        driverId = undefined;
      }
    }

    const finalStop = params.routeStops.find((stop) => stop.type === 'FINAL');
    if (!finalStop) {
      return;
    }

    await rideEventsProducer.rideRouteUpdated({
      eventType: 'RIDE_ROUTE_UPDATED',
      rideId: params.rideId,
      riderId: params.riderId,
      driverId,
      destination: {
        lat: finalStop.lat,
        lng: finalStop.lng,
        address: finalStop.address,
      },
      stops: params.routeStops.map((stop) => ({
        stopId: stop.id,
        stopOrder: stop.stopOrder,
        type: stop.type === 'FINAL' ? 'final' : 'intermediate',
        status: stop.status.toLowerCase() as 'pending' | 'completed' | 'skipped',
        lat: stop.lat,
        lng: stop.lng,
        address: stop.address,
        ...(stop.completedAt ? { completedAt: stop.completedAt.toISOString() } : {}),
      })),
      plannedDistanceKm: params.plannedDistanceKm,
      plannedDurationSeconds: params.plannedDurationSeconds,
      fareEstimateNgn: params.fareEstimateNgn,
      route: params.route,
      updatedBy: params.updatedBy,
      timestamp: new Date().toISOString(),
    });
  }

  async function planUpdatedRoute(
    rideId: string,
    destination: { lat: number; lng: number },
    stops: Array<{ lat: number; lng: number }>,
  ): Promise<{
    distanceKm: number;
    durationSeconds: number;
    fareEstimateNgn: number;
    geometry: {
      coordinates: Array<{ lat: number; lng: number }>;
      bounds: {
        northEast: { lat: number; lng: number };
        southWest: { lat: number; lng: number };
      };
    };
  } | null> {
    if (!routePlanner) {
      return null;
    }

    const ride = await rideClient.findById(rideId);
    const gpsState = state?.gpsByRideId.get(rideId);
    const origin = gpsState
      ? { lat: gpsState.lastLat, lng: gpsState.lastLng }
      : { lat: ride.pickupLat, lng: ride.pickupLng };

    return routePlanner.planRoute({
      origin,
      stops,
      destination,
    });
  }

  function syncRouteState(
    rideId: string,
    routeStops: Array<{
      id: string;
      stopOrder: number;
      type: 'INTERMEDIATE' | 'FINAL';
      status: 'PENDING' | 'COMPLETED' | 'SKIPPED';
      lat: number;
      lng: number;
      address: string;
      completedAt: Date | null;
    }>,
  ): void {
    state?.routeByRideId.set(
      rideId,
      routeStops.map<RideRouteStopState>((stop) => ({
        stopId: stop.id,
        stopOrder: stop.stopOrder,
        type: stop.type === 'FINAL' ? 'final' : 'intermediate',
        status: stop.status.toLowerCase() as RideRouteStopState['status'],
        lat: stop.lat,
        lng: stop.lng,
        address: stop.address,
        ...(stop.completedAt ? { completedAt: stop.completedAt.toISOString() } : {}),
      })),
    );
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}


function resolveCompletedAt(completedAt: string | undefined, fallbackTimestamp: string): Date {
  const source = completedAt ?? fallbackTimestamp;
  const parsed = new Date(source);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function resolveDurationSeconds(startedAt: Date | null, completedAt: Date): number {
  if (!startedAt) {
    return 0;
  }

  const deltaMs = completedAt.getTime() - startedAt.getTime();
  return Math.max(0, Math.round(deltaMs / 1000));
}

function resolveFareNgn(params: {
  requestedFareNgn?: number;
  estimatedFareNgn?: number;
  agreedFareNgn?: number;
}): number {
  // Use the agreed fare (from bidding) if available, otherwise fall back to estimate
  const sourceFare = params.agreedFareNgn ?? params.estimatedFareNgn ?? params.requestedFareNgn ?? 0;
  return round2(Math.max(sourceFare, 0));
}

async function resolveDriverUserId(driverId: string): Promise<string> {
  try {
    const driver = await driverClient.findById(driverId);
    return driver.userId;
  } catch (err) {
    // Never fall back to driverId here. Driver.id is not User.id, so a made-up
    // userId rides along on RIDE_COMPLETED into wallet settlement, where it
    // matches no wallet — the rider's funds stay locked and the driver is not
    // paid. Failing loudly leaves the event un-acked and retryable instead.
    console.error('[ride-service] CRITICAL: cannot resolve driver userId — completion aborted', {
      driverId,
      error: (err as any)?.message ?? err,
    });
    throw new Error(`Cannot resolve userId for driver ${driverId}; refusing to complete ride.`);
  }
}

async function estimateDistanceFromGpsLogs(rideId: string): Promise<number> {
  const logs = await rideClient.findGpsLogs(rideId);
  let distanceKm = 0;

  for (let i = 1; i < logs.length; i += 1) {
    const previous = logs[i - 1];
    const current = logs[i];
    if (!previous || !current) continue;
    distanceKm += haversineKm(previous.lat, previous.lng, current.lat, current.lng);
  }

  return distanceKm;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (n: number) => (n * Math.PI) / 180;
  const r = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return r * c;
}
