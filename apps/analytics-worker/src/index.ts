import { loadWorkspaceEnv, startAlerts, validateSharedEnv } from '@wheleers/config';
import { activityClient, driverClient, type ActivityEventInput } from '@wheleers/db';
import { createConsumer, onShutdown, registerShutdownHandlers } from '@wheleers/kafka-client';
import { safeParseKafkaEvent, TOPICS } from '@wheleers/kafka-schemas';

const SERVICE_ID = 'analytics-worker';

/**
 * Durable per-user activity sink. Kafka retention is 1–7 days, so anything
 * not written down here is gone — this worker archives every event on the
 * firehose into UserActivityEvent rows keyed by User.id.
 *
 * gps.stream is skipped on purpose: raw in-trip GPS already persists to
 * GpsLog, and duplicating a per-second stream into the activity table would
 * drown every other signal.
 */
const SINK_TOPICS = [
  TOPICS.USER_EVENTS,
  TOPICS.DRIVER_EVENTS,
  TOPICS.RIDE_EVENTS,
  TOPICS.PAYMENT_EVENTS,
  TOPICS.WALLET_EVENTS,
  TOPICS.GPS_PROCESSED,
  TOPICS.GROUP_RIDE_EVENTS,
  TOPICS.COMPLIANCE_EVENTS,
  TOPICS.NOTIFICATION_EVENTS,
  TOPICS.CRYPTO_WALLET_EVENTS,
];

/** Payload keys too bulky to archive per-row. */
const STRIPPED_KEYS = new Set(['route', 'stops', 'legs', 'coordinates', 'members']);

const FLUSH_INTERVAL_MS = 2000;
const FLUSH_BATCH_SIZE = 200;

bootstrap().catch((err) => {
  console.error(`[${SERVICE_ID}] fatal`, err);
  process.exit(1);
});

// driverId (Driver.id) → userId (User.id), cached — driver.events don't carry userId.
const driverUserIdCache = new Map<string, string>();

async function resolveDriverUserId(driverId: string): Promise<string | null> {
  const cached = driverUserIdCache.get(driverId);
  if (cached) return cached;
  try {
    const driver = await driverClient.findById(driverId);
    if (driver?.userId) {
      driverUserIdCache.set(driverId, driver.userId);
      if (driverUserIdCache.size > 10_000) driverUserIdCache.clear();
      return driver.userId;
    }
  } catch {
    // resolution failure — skip the row rather than mis-attribute it
  }
  return null;
}

function compactMetadata(event: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (STRIPPED_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Every User.id an event is about — one activity row per user. */
async function extractUserIds(topic: string, event: Record<string, unknown>): Promise<string[]> {
  const ids = new Set<string>();

  if (typeof event['userId'] === 'string') ids.add(event['userId']);
  if (typeof event['riderId'] === 'string') ids.add(event['riderId']);
  if (typeof event['driverUserId'] === 'string') ids.add(event['driverUserId']);
  if (Array.isArray(event['riderIds'])) {
    for (const riderId of event['riderIds']) {
      if (typeof riderId === 'string') ids.add(riderId);
    }
  }

  // driver.events and gps.processed carry only Driver.id
  if (ids.size === 0 && typeof event['driverId'] === 'string') {
    const userId = await resolveDriverUserId(event['driverId']);
    if (userId) ids.add(userId);
  }

  return [...ids];
}

async function bootstrap(): Promise<void> {
  loadWorkspaceEnv();
  startAlerts();
  process.env['NODE_ENV'] ??= 'development';
  process.env['KAFKA_CLIENT_ID'] ??= SERVICE_ID;
  process.env['KAFKA_BROKERS'] ??= 'localhost:9092';
  process.env['DATABASE_URL'] ??= 'postgresql://postgres:postgres@localhost:5432/wheelers';
  process.env['REDIS_URL'] ??= 'redis://localhost:6379';

  validateSharedEnv();
  registerShutdownHandlers(SERVICE_ID);

  const buffer: ActivityEventInput[] = [];
  let flushing = false;

  const flush = async () => {
    if (flushing || buffer.length === 0) return;
    flushing = true;
    const batch = buffer.splice(0, buffer.length);
    try {
      await activityClient.recordMany(batch);
    } catch (error) {
      console.error(`[${SERVICE_ID}] flush failed — ${batch.length} rows dropped`, {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      flushing = false;
    }
  };

  const flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
  flushTimer.unref?.();

  const consumer = await createConsumer({ groupId: SERVICE_ID });

  onShutdown(async () => {
    clearInterval(flushTimer);
    await flush();
    await consumer.disconnect();
  });

  await consumer.subscribe(SINK_TOPICS, async (value, ctx) => {
    const event = safeParseKafkaEvent(ctx.topic as (typeof SINK_TOPICS)[number], value);
    if (!event) return;

    const record = event as unknown as Record<string, unknown>;
    const eventType = typeof record['eventType'] === 'string' ? record['eventType'] : ctx.topic;
    const userIds = await extractUserIds(ctx.topic, record);
    if (userIds.length === 0) return;

    const occurredAt =
      typeof record['timestamp'] === 'string' && !Number.isNaN(Date.parse(record['timestamp']))
        ? new Date(record['timestamp'])
        : new Date();
    const rideId = typeof record['rideId'] === 'string' ? record['rideId'] : null;
    const metadata = compactMetadata(record);

    for (const userId of userIds) {
      buffer.push({
        userId,
        eventType,
        source: ctx.topic,
        rideId,
        metadata,
        dedupKey: `${ctx.topic}:${ctx.partition}:${ctx.offset}:${userId}`,
        occurredAt,
      });
    }

    if (buffer.length >= FLUSH_BATCH_SIZE) {
      await flush();
    }
  });

  console.log(`[${SERVICE_ID}] consuming ${SINK_TOPICS.length} topics`);
}
