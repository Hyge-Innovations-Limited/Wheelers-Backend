import { GoogleMapsRoutePlanner } from '@wheleers/config';
import { DriverStatus, PRICE_CHANGEABLE_STATUSES, driverClient, rideClient } from '@wheleers/db';
import type { MessageContext } from '@wheleers/kafka-client';
import { safeParseKafkaEvent, TOPICS } from '@wheleers/kafka-schemas';

import type { RideRouteStopState, RideServiceState } from '../index';
import type { RideEventsProducer } from '../producers/ride-events.producer';

export type TripLifecycleHandler = {
  handleRideEvent(value: unknown, ctx: MessageContext): Promise<void>;
};

/** A trip still running and, for a driver's action, still that driver's (a bail or completion may have come between). */
function isLiveFor(ride: { status: unknown; driverId: string | null } | null | undefined, driverId: string | undefined): boolean {
  if (!ride || !PRICE_CHANGEABLE_STATUSES.includes(ride.status as never)) return false;
  return driverId === undefined || ride.driverId === driverId;
}

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
            riderId: event.riderId,
          });
          if (assigned.count === 0) {
            // We did not write it. Either another driver won the race — they
            // keep the trip and this one must NOT be marked ON_RIDE — or this
            // very driver already holds it (a redelivered event). Ask.
            const ride = await rideClient.findById(event.rideId).catch(() => null);
            if (ride?.driverId !== event.driverId) {
              console.warn('[ride-service] assignment skipped — the ride belongs to someone else, or is closed', {
                rideId: event.rideId,
                driverId: event.driverId,
                actualDriverId: ride?.driverId ?? null,
                status: ride?.status ?? null,
              });
              // The gateway has already told this driver they won: say it did not hold.
              await rideEventsProducer?.rideAssignmentFailed({
                eventType: 'RIDE_ASSIGNMENT_FAILED',
                rideId: event.rideId,
                riderId: event.riderId,
                driverId: event.driverId,
                driverUserId: event.driverUserId,
                reason: 'ride_closed',
                timestamp: new Date().toISOString(),
              }).catch(() => undefined);
              return;
            }
          }
          // This driver owns the trip, so they are off the market. Marking it
          // used to be skipped whenever the write above wrote nothing, and a
          // driver left ONLINE keeps being offered other people's rides while
          // carrying a passenger.
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
          // The ride is read again here: a trip that has ended, or a driver who is no longer its driver, changes nothing.
          const current = await rideClient.findById(event.rideId);
          if (!isLiveFor(current, event.updatedBy === 'driver' ? event.driverId : undefined)) return;
          // STOP_FIXED_PRICE_ENABLED: only the rider's accepted fare can become the agreed fare. Anything else
          // (an older app, the driver) moves the route but never the fare: the trip keeps the agreed price,
          // so the hold cannot be lowered by re-planning the rest of it.
          const formulaPriced = event.acceptedFareNgn !== undefined && event.updatedBy === 'rider';
          const acceptedFareNgn = formulaPriced ? Math.round(event.acceptedFareNgn as number) : undefined;
          const agreedFareNgn = current?.agreedFareNgn != null ? Number(current.agreedFareNgn) : undefined;
          const unpricedFare = agreedFareNgn !== undefined && agreedFareNgn > 0 ? agreedFareNgn : undefined;
          // The stops as they were, only to say what a priced change did.
          const before = formulaPriced ? await rideClient.findRouteStops(event.rideId).catch(() => []) : [];
          const planned =
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
          const plannedRoute = planned && unpricedFare !== undefined ? { ...planned, fareEstimateNgn: Math.max(planned.fareEstimateNgn, unpricedFare) } : planned;
          const keepFare = unpricedFare !== undefined ? Math.max(unpricedFare, event.fareEstimateNgn ?? 0) : event.fareEstimateNgn;
          // A priced change stores exactly the fare the rider accepted (it may be lower: a stop removed).
          // STOP_FIXED_PRICE_ENABLED marks an unpriced rider change by carrying plannedTotalKm: it keeps the agreed fare
          // whatever the replanned route would cost (an older app sends no plan, so ride-service would plan it itself).
          const keepsAgreed = acceptedFareNgn === undefined && event.plannedTotalKm !== undefined && event.updatedBy === 'rider';
          const fareOut = acceptedFareNgn !== undefined ? acceptedFareNgn : (keepsAgreed ? keepFare : (plannedRoute?.fareEstimateNgn ?? keepFare));

          const routeStops = await rideClient.syncRouteStops(event.rideId, {
            destination: event.destination,
            stops: event.stops,
            fareEstimateNgn: fareOut,
            ...(acceptedFareNgn !== undefined ? { agreedFareNgn: acceptedFareNgn } : {}),
            // Priced: the km the new fare is for. Unpriced (STOP_FIXED_PRICE_ENABLED): the planned km moved by the change in the road
            // left, so the distance already driven is kept.
            ...(event.plannedTotalKm !== undefined && (acceptedFareNgn !== undefined || event.updatedBy === 'rider') ? { plannedDistanceKm: event.plannedTotalKm } : {}),
            ...(event.baseAgreedFareNgn !== undefined
              ? { base: { agreedFareNgn: event.baseAgreedFareNgn, plannedDistanceKm: event.basePlannedKm ?? null, doneStops: event.baseDoneStops } }
              : {}),
          });
          if (!routeStops) {
            const now = await rideClient.findById(event.rideId).catch(() => null);
            // The same change delivered again after it was made: the ride already has this fare and km (priced), or this
            // route and planned km (unpriced). It is done.
            const at6 = (p: { lat: number; lng: number }) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
            const routeNow = (now?.routeStops ?? []).filter((st) => st.status === 'PENDING').sort((x, y) => x.stopOrder - y.stopOrder).map(at6).join('|');
            const sameKm = event.plannedTotalKm === undefined || Math.abs(Number(now?.plannedDistanceKm) - event.plannedTotalKm) < 1e-6;
            const alreadyMade = acceptedFareNgn !== undefined
              ? !!now && Math.round(Number(now.agreedFareNgn)) === acceptedFareNgn && sameKm
              : !!now && event.plannedTotalKm !== undefined && sameKm && routeNow === [...event.stops, event.destination].map(at6).join('|');
            if (now && alreadyMade) {
              console.info('[ride-service] priced route change already made: sending its update again', { rideId: event.rideId });
              // The first delivery may have died between the commit and the publish: say it again (consumers cope with a repeat).
              await publishRouteUpdatedSnapshot({
                rideId: event.rideId, riderId: event.riderId, driverId: event.driverId,
                fareEstimateNgn: acceptedFareNgn ?? Number(now.agreedFareNgn ?? now.fareEstimateNgn), agreedFareNgn: acceptedFareNgn ?? Number(now.agreedFareNgn ?? now.fareEstimateNgn), priced: acceptedFareNgn !== undefined,
                updatedBy: event.updatedBy, routeStops: now.routeStops,
              });
              return;
            }
            console.warn('[ride-service] priced route change skipped: the ride changed since it was priced', { rideId: event.rideId });
            // The gateway may already have raised the hold for it: say how the ride really stands, so the hold
            // goes back to the agreed fare and the rider's screen to the real route.
            const agreed = now?.agreedFareNgn ?? now?.fareEstimateNgn;
            if (now) {
              await publishRouteUpdatedSnapshot({
                rideId: event.rideId,
                riderId: event.riderId,
                driverId: event.driverId,
                updatedBy: 'system',
                routeStops: now.routeStops,
                ...(agreed != null ? { fareEstimateNgn: Number(agreed), agreedFareNgn: Number(agreed) } : {}),
                reverted: true,
              });
            }
            return;
          }
          syncRouteState(event.rideId, routeStops);
          await publishRouteUpdatedSnapshot({
            rideId: event.rideId,
            riderId: event.riderId,
            driverId: event.driverId,
            plannedDistanceKm: plannedRoute?.distanceKm ?? event.plannedDistanceKm,
            plannedDurationSeconds: plannedRoute?.durationSeconds ?? event.plannedDurationSeconds,
            fareEstimateNgn: fareOut,
            priced: event.priced === true || acceptedFareNgn !== undefined,
            route: plannedRoute?.geometry ?? event.route,
            updatedBy: event.updatedBy,
            routeStops,
            ...(acceptedFareNgn !== undefined ? { agreedFareNgn: acceptedFareNgn } : {}),
            ...(acceptedFareNgn !== undefined ? { change: describeRouteChange(before, routeStops) } : {}),
          });
        } catch (err) {
          console.warn(`[ride-service] route update skipped:`, (err as any)?.message ?? err);
        }
      }

      if (event.eventType === 'RIDE_STOP_CONFIRMED') {
        try {
          const current = await rideClient.findById(event.rideId);
          if (!isLiveFor(current, event.confirmedBy === 'driver' ? event.driverId : undefined)) return;
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
    priced?: boolean;
    updatedBy: 'rider' | 'driver' | 'system';
    agreedFareNgn?: number;
    change?: 'stop_added' | 'stop_removed' | 'destination_changed' | 'route_changed';
    reverted?: boolean;
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
      ...(params.agreedFareNgn !== undefined ? { agreedFareNgn: params.agreedFareNgn } : {}),
      ...(params.change ? { change: params.change } : {}),
      ...(params.reverted ? { reverted: true } : {}),
      priced: params.priced,
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

type StopRow = { type: string; status: string; lat: number; lng: number };

/** What a route change did, for the driver's "new stop" line: stops still ahead, before and after. */
function describeRouteChange(before: StopRow[], after: StopRow[]): 'stop_added' | 'stop_removed' | 'destination_changed' | 'route_changed' {
  const ahead = (rows: StopRow[]) => rows.filter((s) => s.status === 'PENDING');
  const b = ahead(before);
  const a = ahead(after);
  if (a.length > b.length) return 'stop_added';
  if (a.length < b.length) return 'stop_removed';
  const fin = (rows: StopRow[]) => rows.find((s) => s.type === 'FINAL');
  const fb = fin(b);
  const fa = fin(a);
  if (fb && fa && (fb.lat !== fa.lat || fb.lng !== fa.lng)) return 'destination_changed';
  return 'route_changed';
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
