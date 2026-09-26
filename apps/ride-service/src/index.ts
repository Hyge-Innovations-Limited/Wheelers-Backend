import { GoogleMapsRoutePlanner, RIDE, loadWorkspaceEnv, validateRideEnv, validateSharedEnv } from '@wheleers/config';
import { createConsumer, createProducer, onShutdown } from '@wheleers/kafka-client';
import { TOPICS } from '@wheleers/kafka-schemas';

import { createRideEventsProducer } from './producers/ride-events.producer';
import { createGpsProcessedProducer } from './producers/gps-processed.producer';

import { createDriverEventsConsumer } from './consumers/driver-events.consumer';
import { createRideRequestedConsumer } from './consumers/ride-requested.consumer';
import { createGpsUpdateConsumer } from './consumers/gps-update.consumer';
import { createGroupRideDispatchConsumer } from './consumers/group-ride-dispatch.consumer';

import { startGpsMonitor } from './handlers/gps-monitor.handler';
import { startStaleRideSweep } from './handlers/stale-rides.handler';
import { startScheduledRideDispatcher } from './handlers/scheduled-rides.handler';
import { createTripLifecycleHandler } from './handlers/trip-lifecycle.handler';
import type { RideRequestedEvent } from '@wheleers/kafka-schemas';

export type OnlineDriver = {
  driverId: string;
  userId: string;
  lat: number;
  lng: number;
  vehiclePlate: string;
  vehicleModel: string;
  /** Driver→pickup at match time, when the match query computed it. */
  distanceKm?: number;
  /**
   * They are still carrying a passenger, and were matched because this pickup
   * is near where they are dropping off. Their app labels the card so nobody
   * abandons a rider for it; distanceKm is measured from that drop-off.
   */
  afterCurrentTrip?: boolean;
};

export type RideGpsState = {
  rideId: string;
  driverId: string;
  totalDistanceKm: number;
  lastLat: number;
  lastLng: number;
  lastUpdateAt: Date;
  lastMovementAt: Date;
  lastSnapshotAt: Date;
  lastStaleWarningAt: Date | null;
};

export type RideRouteStopState = {
  stopId?: string;
  stopOrder: number;
  type: 'intermediate' | 'final';
  status: 'pending' | 'completed' | 'skipped';
  lat: number;
  lng: number;
  address: string;
  completedAt?: string;
};

export type CounterOfferDriverInfo = {
  driverName: string;
  driverRating: number;
  vehiclePlate: string;
  vehicleModel: string;
  etaSeconds: number;
};

/**
 * Group badge + per-stop kinds for an offer. Held on the pending match because
 * a group ride is offered more than once: to newly-online drivers, and again
 * on every rider counter-offer. Rebuilding it from the event is impossible by
 * then, so a re-send without it showed a shared multi-pickup trip as a plain
 * solo ride.
 */
export type GroupRideMemberSeatInfo = {
  rideId: string;
  riderId: string;
  pickup: { lat: number; lng: number; address: string };
  dropoff: { lat: number; lng: number; address: string };
  offerNgn: number;
};

export type PendingRideGroupInfo = {
  groupId: string;
  riderCount: number;
  stopKinds: Array<'pickup' | 'dropoff'>;
  /** Per-seat legs and offers — drivers bid with each rider individually. */
  members?: GroupRideMemberSeatInfo[];
  /** Every member, so driver assignment can notify the whole group. */
  rideIds: string[];
  riderIds: string[];
};

export type PendingRideMatch = {
  rideRequested: RideRequestedEvent;
  candidates: OnlineDriver[];
  attemptedDriverIds: Set<string>;
  offeredDriverId: string | null;
  timeout: NodeJS.Timeout | null;
  counterOfferDrivers: Map<string, CounterOfferDriverInfo>;
  /** Only set for group rides. */
  group?: PendingRideGroupInfo;
};

export type RideParticipantState = {
  /** Primary rider — the anchor rider on a group ride. */
  riderId: string;
  driverId: string;
  /**
   * Every rider on this ride, anchor included. Solo rides have exactly one.
   * Group rides used to keep only the anchor, so the other members received no
   * GPS relay and no stale-movement warnings.
   */
  riderIds?: string[];
};

/** All riders on a ride, tolerant of entries written before riderIds existed. */
export function participantRiderIds(participants: RideParticipantState): string[] {
  return participants.riderIds?.length ? participants.riderIds : [participants.riderId];
}

export type RideServiceState = {
  onlineDrivers: Map<string, OnlineDriver>;
  assignedDriversByRideId: Map<string, OnlineDriver>;
  rideParticipantsByRideId: Map<string, RideParticipantState>;
  gpsByRideId: Map<string, RideGpsState>;
  routeByRideId: Map<string, RideRouteStopState[]>;
  pendingMatchesByRideId: Map<string, PendingRideMatch>;
};

const SERVICE_ID = 'ride-service';

bootstrap().catch((err) => {
  console.error(`[${SERVICE_ID}] fatal`, err);
  process.exit(1);
});

async function bootstrap(): Promise<void> {
  loadWorkspaceEnv();
  process.env['NODE_ENV'] ??= 'development';
  process.env['KAFKA_CLIENT_ID'] ??= SERVICE_ID;
  // Default local Kafka broker for host-managed development.
  process.env['KAFKA_BROKERS'] ??= 'localhost:29092';
  process.env['DATABASE_URL'] ??= 'postgresql://postgres:postgres@localhost:5432/wheelers';
  process.env['REDIS_URL'] ??= 'redis://localhost:6379';

  validateSharedEnv();
  const rideEnv = validateRideEnv();

  const producer = await createProducer({ serviceId: SERVICE_ID });
  const consumer = await createConsumer({ groupId: SERVICE_ID, concurrency: 1 });
  const routePlanner = new GoogleMapsRoutePlanner(
    rideEnv.GOOGLE_MAPS_BASE_URL,
    rideEnv.GOOGLE_MAPS_API_KEY,
  );

  const state: RideServiceState = {
    onlineDrivers: new Map(),
    assignedDriversByRideId: new Map(),
    rideParticipantsByRideId: new Map(),
    gpsByRideId: new Map(),
    routeByRideId: new Map(),
    pendingMatchesByRideId: new Map(),
  };

  const rideEventsProducer = createRideEventsProducer(producer);
  const gpsProcessedProducer = createGpsProcessedProducer(producer);

  const tripLifecycle = createTripLifecycleHandler({
    state,
    rideEventsProducer,
    routePlanner,
  });

  const driverEventsConsumer = createDriverEventsConsumer({
    state,
    onDriverOnline: async (event) => {
      // Check pending ride searches and send offers to this newly-online driver
      const radiusKm = Number(rideEnv.MATCH_RADIUS_KM);
      const driver = state.onlineDrivers.get(event.driverId);
      if (!driver) return;

      for (const [rideId, pending] of state.pendingMatchesByRideId) {
        // A group ride whose driver already accepted is not still "pending" —
        // re-offering it to a late joiner would put two drivers on one trip.
        if (state.assignedDriversByRideId.has(rideId)) continue;

        // Skip drivers who rejected this ride or were already assigned one.
        // Being in `candidates` is deliberately NOT a skip: a driver whose
        // socket blipped re-announces driver:online on reconnect, and the
        // offer they missed during the gap must be re-sent — the app replaces
        // offer cards by rideId, so a re-send is harmless when they saw it.
        if (pending.attemptedDriverIds.has(event.driverId)) continue;

        const dist = haversineKm(
          pending.rideRequested.pickup.lat,
          pending.rideRequested.pickup.lng,
          driver.lat,
          driver.lng,
        );
        if (dist <= radiusKm) {
          if (!pending.candidates.some((c) => c.driverId === event.driverId)) {
            pending.candidates.push(driver);
          }
          const expiresAt = new Date(Date.now() + RIDE.OFFER_TTL_SECONDS * 1000);
          await rideEventsProducer.broadcastRideOffer({
            drivers: [driver],
            rideRequested: pending.rideRequested,
            expiresAt,
            // Without this the late joiner is the only driver who cannot see
            // that the job is a shared ride with someone else's stops on it.
            group: pending.group,
          });
          console.log(`[ride-service] sent pending ride ${pending.rideRequested.rideId} to newly online driver ${event.driverId} (${dist.toFixed(1)}km away)`);
        }
      }
    },
    onDriverOffline: async ({ driverId }) => {
      void driverId;
    },
  });

  const rideRequestedConsumer = createRideRequestedConsumer({
    state,
    rideEnv,
    rideEventsProducer,
  });

  const gpsUpdateConsumer = createGpsUpdateConsumer({
    state,
    gpsProcessedProducer,
    rideEventsProducer,
  });

  const groupRideDispatchConsumer = createGroupRideDispatchConsumer({
    state,
    rideEnv,
    rideEventsProducer,
  });

  await consumer.subscribe(
    [TOPICS.DRIVER_EVENTS, TOPICS.RIDE_EVENTS, TOPICS.GPS_STREAM, TOPICS.GROUP_RIDE_EVENTS],
    async (value, ctx) => {
      if (ctx.topic === TOPICS.DRIVER_EVENTS) {
        await driverEventsConsumer.handle(value, ctx);
        return;
      }

      if (ctx.topic === TOPICS.RIDE_EVENTS) {
        await rideRequestedConsumer.handle(value, ctx);
        await tripLifecycle.handleRideEvent(value, ctx);
        return;
      }

      if (ctx.topic === TOPICS.GPS_STREAM) {
        await gpsUpdateConsumer.handle(value, ctx);
        return;
      }

      if (ctx.topic === TOPICS.GROUP_RIDE_EVENTS) {
        await groupRideDispatchConsumer.handle(value, ctx);
      }
    },
  );

  // A deploy mid-search must not lose the auction: rebuild every open one from the database.
  void rideRequestedConsumer.rehydrate().catch((err) => {
    console.error(`[${SERVICE_ID}] rehydrating open searches failed`, (err as any)?.message ?? err);
  });

  startGpsMonitor({
    state,
    rideEnv,
    rideEventsProducer,
  });

  const staleRideSweep = startStaleRideSweep({ rideEventsProducer });


   const dispatcher = startScheduledRideDispatcher({
   rideEnv,
    rideEventsProducer,
    redisUrl: process.env.REDIS_URL,       // add REDIS_URL to validateSharedEnv if not already there
  });

  onShutdown(async () => {
    staleRideSweep.stop();
    await dispatcher.shutdown();
    await consumer.disconnect();
    await producer.disconnect();
  });

  console.log(`[${SERVICE_ID}] consuming (matchRadiusKm=${rideEnv.MATCH_RADIUS_KM})`);
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
