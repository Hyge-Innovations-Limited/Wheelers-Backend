import { randomUUID } from 'node:crypto';
import IORedis from 'ioredis';
import { ScheduledRideStatus, referralClient, rideClient, scheduledRideClient } from '@wheleers/db';
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

/** What a dispatch needs besides the ride: Kafka, and Redis (the gateway's keys, read only, and the hold's once-mark). */
type DispatchContext = {
  rideEventsProducer: RideEventsProducer;
  redis: Pick<IORedis, 'get' | 'set' | 'ttl' | 'del'>;
};

/** Meta's customer-service window: plain messages reach a rider this long after their last message to us. */
const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Can a WhatsApp ride for later start now? Its start message must reach the
 * rider: inside their 24 h window (the gateway keeps their last message's time),
 * or as the approved template when one is set (WHATSAPP_SCHEDULED_TEMPLATE).
 * Before the gateway kept that time, the phone lookup it renews on every message
 * (24 h) says the same.
 */
async function whatsappStartCanReachRider(redis: DispatchContext['redis'], riderId: string): Promise<boolean> {
  if (process.env['WHATSAPP_SCHEDULED_TEMPLATE']?.trim()) return true;
  const lastIn = await redis.get(`whatsapp:user:${riderId}:last_in`).catch(() => null);
  const at = lastIn ? Date.parse(lastIn) : NaN;
  if (Number.isFinite(at)) return Date.now() < at + WHATSAPP_WINDOW_MS;
  const ttl = await redis.ttl(`whatsapp:phone_by_user:${riderId}`).catch(() => -2);
  return ttl > 0;
}

/**
 * A WhatsApp ride for later due while its rider is busy (searching, a driver
 * being confirmed, on a trip) waits: back to SCHEDULED, tried again by the next
 * scan, and the rider is told once. Their current search is never replaced.
 * True when it was held.
 */
async function holdWhileBusy(
  claimed: NonNullable<Awaited<ReturnType<typeof scheduledRideClient.claimForDispatch>>>,
  ctx: DispatchContext,
): Promise<boolean> {
  const busy = await rideClient.findOtherLiveRide(claimed.riderId).catch(() => null);
  if (!busy) return false;
  await scheduledRideClient.releaseClaim(claimed.id);
  // Once per ride for later, however many scans find it still waiting.
  const onceKey = `scheduled-ride:${claimed.id}:held-told`;
  const first = await ctx.redis.set(onceKey, '1', 'EX', 3 * 24 * 60 * 60, 'NX').then((ok) => ok === 'OK').catch(() => false);
  if (first) {
    await ctx.rideEventsProducer.scheduledRideHeld({
      eventType: 'SCHEDULED_RIDE_HELD',
      rideId: claimed.id,
      riderId: claimed.riderId,
      scheduledFor: claimed.scheduledFor.toISOString(),
      pickupAddress: claimed.pickupAddress,
      timestamp: new Date().toISOString(),
    }).catch(async (error) => {
      // Not said: the next scan says it.
      await ctx.redis.del(onceKey).catch(() => undefined);
      console.warn('[ride-service:dispatcher] held notice not published', { scheduledRideId: claimed.id, error: error instanceof Error ? error.message : String(error) });
    });
  }
  console.info('[ride-service:dispatcher] rider busy, ride for later waits', { scheduledRideId: claimed.id, busyWith: busy.id });
  return true;
}

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
  const ctx: DispatchContext = { rideEventsProducer: params.rideEventsProducer, redis: queueConn };
  const { worker, connection: workerConn } = createDispatcherWorker(
    params.redisUrl,
    async (job) => {
      await dispatchSingleRide(job.data.scheduledRideId, ctx);
    },
  );

  // Recovery + stuck-ride scanner.
  const fallbackTimer = setInterval(() => {
    void runRecoveryScanner(ctx, leadTimeMs).catch((err) =>
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
  ctx: DispatchContext,
  leadTimeMs: number,
): Promise<void> {
  // Step 1 — release stuck DISPATCHING rides.
  await scheduledRideClient.releaseStuckDispatching(60_000);

  // Step 2 — expire very old SCHEDULED rides.
  await scheduledRideClient.expireMissed(
    new Date(Date.now() - 24 * 60 * 60 * 1_000),
  );

  // Step 3 — dispatch due-but-missed rides (BullMQ job was lost), and the ones
  // waiting for their rider to be free (they stay SCHEDULED, so they are here too).
  const dispatchBefore = new Date(Date.now() + leadTimeMs);
  const dueRides = await scheduledRideClient.findDueForDispatch(dispatchBefore, 50);

  for (const ride of dueRides) {
    await dispatchSingleRide(ride.id, ctx);
  }
}

// ─── Core dispatch logic ──────────────────────────────────────────────────────

/**
 * Claims a single scheduled ride and writes the outbox event.
 *
 * Idempotent: if the ride is already DISPATCHED (e.g. scanner + BullMQ race),
 * claimForDispatch returns null and we exit immediately.
 */
export async function dispatchSingleRide(
  scheduledRideId: string,
  ctx: DispatchContext,
): Promise<void> {
  // Atomic claim: SCHEDULED → DISPATCHING (only one worker wins).
  const claimed = await scheduledRideClient.claimForDispatch(scheduledRideId);
  if (!claimed || claimed.status !== ScheduledRideStatus.DISPATCHING) {
    // Already dispatched, cancelled, or expired.
    return;
  }

  if (claimed.channel === 'WHATSAPP') {
    // Busy now: it waits for them (never replacing what they are doing).
    if (await holdWhileBusy(claimed, ctx)) return;
    // Its start must reach them in the chat: outside their 24 h window, with no
    // approved template to say it, it does not start (drivers are not called to nobody).
    if (!(await whatsappStartCanReachRider(ctx.redis, claimed.riderId))) {
      await scheduledRideClient.cancel(claimed.id, claimed.riderId, 'whatsapp_window_closed');
      await referralClient.releaseRideCashback(claimed.id).catch(() => undefined);
      console.info('[ride-service:dispatcher] ride for later not started: outside the WhatsApp window', { scheduledRideId: claimed.id });
      return;
    }
  }

  await doDispatch(claimed, ctx.rideEventsProducer);
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
  const pricing = calculateSuggestedFare(claimed.plannedDistanceKm ?? 0, {
    durationSeconds: claimed.plannedDurationSeconds ?? undefined,
    origin: { lat: claimed.pickupLat, lng: claimed.pickupLng },
    destination: { lat: claimed.destLat, lng: claimed.destLng },
  });

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
    // Where it was booked: a ride for later from the WhatsApp ride page searches as a
    // WhatsApp search (offers on the page and in the chat); everything else is the app's.
    channel: claimed.channel === 'WHATSAPP' ? 'WHATSAPP' : 'APP',
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