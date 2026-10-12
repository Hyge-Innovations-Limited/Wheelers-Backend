import { randomUUID } from 'node:crypto';
import { ScheduledRideStatus, scheduledRideClient } from '@wheleers/db';
import { TOPICS } from '@wheleers/kafka-schemas';
import { calculateSuggestedFare, type RideEnv } from '@wheleers/config';
import type { RideRequestedEvent } from '@wheleers/kafka-schemas';
import type { RideEventsProducer } from '../producers/ride-events.producer';
import {
  createDispatcherQueue,
  createDispatcherWorker,
  SCHEDULED_RIDE_QUEUE,
  type ScheduledRideJobData,
} from '../queue/dispatcher.queue';

export type ScheduledRideDispatcher = {
  shutdown(): Promise<void>;
};

/**
 * Starts the BullMQ-backed scheduled ride dispatcher.
 *
 * Architecture:
 *   - DB is the single source of truth (ScheduledRide.status state machine).
 *   - BullMQ fires a job at ~leadTime before the ride — it is a hint, not a guarantee.
 *   - doDispatch writes the RIDE_REQUESTED event to the outbox table in the same
 *     DB transaction that marks the ride DISPATCHED. The outbox publisher delivers
 *     it to Kafka independently.
 *   - A recovery scanner runs every `fallbackIntervalMs` to catch rides whose
 *     BullMQ job was lost (Redis restart, worker downtime, etc.).
 *   - Stuck DISPATCHING rides (worker crash mid-flight) are reset to SCHEDULED
 *     by the scanner so they can be re-dispatched.
 */
export function startScheduledRideDispatcher(params: {
  rideEnv: RideEnv;
  rideEventsProducer: RideEventsProducer;
  redisUrl: string;
}): ScheduledRideDispatcher {
  const leadTimeMs =
    Number(params.rideEnv.SCHEDULED_RIDE_DISPATCH_LEAD_TIME_S) * 1_000;

  // Recovery scanner runs every 2× the lead time — well within acceptable drift.
  const fallbackIntervalMs =
    Number(params.rideEnv.SCHEDULED_RIDE_DISPATCH_INTERVAL_S) * 1_000 * 2;

  const { queue, connection: queueConn } = createDispatcherQueue(params.redisUrl);
  const { worker, connection: workerConn } = createDispatcherWorker(
    params.redisUrl,
    async (job) => {
      await dispatchSingleRide(job.data.scheduledRideId, params.rideEventsProducer);
    },
  );

  // Recovery + stuck-ride scanner.
  const fallbackTimer = setInterval(() => {
    void runRecoveryScanner(params.rideEventsProducer, leadTimeMs).catch((err) =>
      console.warn('[ride-service:dispatcher] recovery scanner error:', err),
    );
  }, fallbackIntervalMs);
  fallbackTimer.unref();

  console.log(
    `[ride-service:dispatcher] started — queue=${SCHEDULED_RIDE_QUEUE}, ` +
      `leadTimeMs=${leadTimeMs}, fallbackEvery=${fallbackIntervalMs}ms`,
  );

  return {
    async shutdown() {
      clearInterval(fallbackTimer);
      await worker.close();
      await queue.close();
      await workerConn.quit();
      await queueConn.quit();
    },
  };
}

// ─── Recovery scanner ─────────────────────────────────────────────────────────

/**
 * 1. Release rides that have been stuck in DISPATCHING for > 60 s (worker crash).
 * 2. Expire rides that were never dispatched and are now > 24 h past scheduledFor.
 * 3. Dispatch any rides that are due but still SCHEDULED (BullMQ job was lost).
 */
async function runRecoveryScanner(
  rideEventsProducer: RideEventsProducer,
  leadTimeMs: number,
): Promise<void> {
  // Step 1 — release stuck DISPATCHING rides.
  await scheduledRideClient.releaseStuckDispatching(60_000);

  // Step 2 — expire very old SCHEDULED rides.
  await scheduledRideClient.expireMissed(
    new Date(Date.now() - 24 * 60 * 60 * 1_000),
  );

  // Step 3 — dispatch due-but-missed rides (BullMQ job was lost).
  const dispatchBefore = new Date(Date.now() + leadTimeMs);
  const dueRides = await scheduledRideClient.findDueForDispatch(dispatchBefore, 10);

  for (const ride of dueRides) {
    await dispatchSingleRide(ride.id, rideEventsProducer);
  }
}

// ─── Core dispatch logic ──────────────────────────────────────────────────────

/**
 * Claims a single scheduled ride and writes the outbox event.
 *
 * Idempotent: if the ride is already DISPATCHED (e.g. scanner + BullMQ race),
 * claimForDispatch returns null and we exit immediately.
 */
async function dispatchSingleRide(
  scheduledRideId: string,
  rideEventsProducer: RideEventsProducer,
): Promise<void> {
  // Atomic claim: SCHEDULED → DISPATCHING (only one worker wins).
  const claimed = await scheduledRideClient.claimForDispatch(scheduledRideId);
  if (!claimed || claimed.status !== ScheduledRideStatus.DISPATCHING) {
    // Already dispatched, cancelled, or expired.
    return;
  }

  await doDispatch(claimed, rideEventsProducer);
}

async function doDispatch(
  claimed: NonNullable<Awaited<ReturnType<typeof scheduledRideClient.claimForDispatch>>>,
  rideEventsProducer: RideEventsProducer,
): Promise<void> {
  // Use a stable rideId: if this is a retry (previous run crashed before commit),
  // requestedRideId would still be null here because markDispatchedWithOutbox
  // never completed. Generate a fresh one.
  const rideId = randomUUID();
  const stops = scheduledRideClient.parseStops(claimed.stops);

  const fareEstimateNgn = Number(claimed.fareEstimateNgn ?? 0);
  const pricing = calculateSuggestedFare(claimed.plannedDistanceKm ?? 0, { durationSeconds: claimed.plannedDurationSeconds ?? undefined });

  const event: RideRequestedEvent = {
    eventType: 'RIDE_REQUESTED',
    rideId,
    riderId: claimed.riderId,
    pickup: {
      lat: claimed.pickupLat,
      lng: claimed.pickupLng,
      address: claimed.pickupAddress,
    },
    destination: {
      lat: claimed.destLat,
      lng: claimed.destLng,
      address: claimed.destAddress,
    },
    stops,
    plannedDistanceKm: claimed.plannedDistanceKm ?? undefined,
    plannedDurationSeconds: claimed.plannedDurationSeconds ?? undefined,
    fareEstimateNgn: fareEstimateNgn || pricing.suggestedFareNgn,
    paymentMethod: 'WALLET',
    // The price shown when it was booked, unless today's minimum for the
    // trip is now above it: drivers are never offered less than the minimum.
    riderOfferNgn: Math.max(fareEstimateNgn || pricing.suggestedFareNgn, pricing.minOfferNgn),
    suggestedFareNgn: pricing.suggestedFareNgn,
    minOfferNgn: pricing.minOfferNgn,
    ratePerKmNgn: pricing.ratePerKmNgn,
    // Scheduling exists only in the app, and the rider is not watching it now.
    channel: 'APP',
    scheduled: true,
    timestamp: new Date().toISOString(),
  };

  try {
    // ── Single atomic DB transaction ──────────────────────────────────────────
    // 1. ScheduledRide: DISPATCHING → DISPATCHED  (sets requestedRideId)
    // 2. OutboxEvent: insert RIDE_REQUESTED payload
    //
    // If this transaction fails, the ride stays DISPATCHING.
    // releaseStuckDispatching() will reset it to SCHEDULED within 60 s.
    await scheduledRideClient.markDispatchedWithOutbox({
      id: claimed.id,
      rideId,
      outbox: {
        topic: TOPICS.RIDE_EVENTS,
        key: rideId,
        payload: event,
      },
    });

    console.log(
      `[ride-service:dispatcher] dispatched ${claimed.id} → live ride ${rideId}`,
    );
  } catch (error) {
    // Transaction failed. Reset claim so the recovery scanner can retry.
    await scheduledRideClient.releaseClaim(claimed.id).catch((releaseErr) =>
      console.error(
        '[ride-service:dispatcher] releaseClaim failed after dispatch error:',
        releaseErr,
      ),
    );
    // Re-throw so BullMQ retries via its backoff config.
    throw error;
  }
}