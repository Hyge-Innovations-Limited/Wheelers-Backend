import { driverBidClient, driverPresence, PRESENCE_FRESH_MS } from '@wheleers/db';
import { DriverOfflineEvent } from '@wheleers/kafka-schemas';
import type { RedisClient } from '../redis/client';
import type { GatewayPublisher } from './publisher';
import type { SocketRegistry } from './registry';

/**
 * A driver whose socket died gets a short grace to reconnect (network blips
 * are normal); after it, they are OFF the market: marked offline and their
 * open bids withdrawn, each affected rider told. Without this, dead phones
 * stayed ONLINE in the DB forever — ghost drivers absorbed candidate slots
 * and riders paid for drivers who no longer existed.
 *
 * The grace used to be a setTimeout in the memory of the process that held the
 * socket. That had two holes: a restart forgot every pending grace, and with
 * more than one gateway the timer could not see a driver who had reconnected
 * to a different process. It is now a list in Redis that every gateway process
 * sweeps:
 *
 *   gateway:driver-offline:due    ZSET  driverId, scored by when the grace ends
 *   gateway:driver-offline:meta   HASH  driverId -> { userId, since, extended }
 *
 * Whichever process removes a due driver from the list owns that check, so a
 * driver is only ever processed once.
 */

export const DRIVER_OFFLINE_GRACE_MS = 45_000;
const SWEEP_EVERY_MS = 5_000;
const SWEEP_BATCH = 100;
/** After a restart thousands fall due together; one pass takes this many and leaves the rest to the next. */
const SWEEP_MAX_PER_PASS = 2_000;
const DUE_KEY = 'gateway:driver-offline:due';
const META_KEY = 'gateway:driver-offline:meta';

interface GraceDeps {
  redis: RedisClient;
  registry: SocketRegistry;
  publisher: GatewayPublisher;
  /** A line per driver. Off, each pass says once how many it kept and how many it took offline. */
  verbose?: boolean;
}

interface GraceMeta {
  userId: string;
  since: number;
  extended: boolean;
}

export async function withdrawDriverFromMarket(registry: SocketRegistry, driverUserId: string): Promise<void> {
  const affected = await driverBidClient.withdrawAllPendingForDriver(driverUserId).catch(() => []);
  for (const bid of affected) {
    void registry.sendToUser(bid.riderId, 'ride:driver_rejected', {
      rideId: bid.rideId,
      driverId: bid.driverId,
      reason: 'driver_unavailable',
    });
    // The driver was never told their bid was pulled; the app showed
    // "waiting on rider" for half an hour.
    void registry.sendToUser(driverUserId, 'ride:bid_withdrawn', {
      rideId: bid.rideId,
      reason: 'driver_offline',
    });
  }
}

export function createDriverOfflineGrace(deps: GraceDeps) {
  const { redis, registry, publisher } = deps;
  const verbose = deps.verbose === true;
  const tally = { keptOnline: 0, takenOffline: 0 };

  /** The socket closed: start (or restart) the grace. */
  async function schedule(auth: { userId: string; driverId: string }, now = Date.now()): Promise<void> {
    try {
      const meta: GraceMeta = { userId: auth.userId, since: now, extended: false };
      await Promise.all([
        redis.send('ZADD', DUE_KEY, String(now + DRIVER_OFFLINE_GRACE_MS), auth.driverId),
        redis.send('HSET', META_KEY, auth.driverId, JSON.stringify(meta)),
      ]);
    } catch (error) {
      console.warn('[ws] could not schedule the offline grace', {
        driverId: auth.driverId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** The driver reconnected, or went offline on purpose: nothing left to check. */
  async function cancel(driverId: string): Promise<void> {
    try {
      await Promise.all([redis.send('ZREM', DUE_KEY, driverId), redis.send('HDEL', META_KEY, driverId)]);
    } catch {
      /* the sweep finds them connected and drops it */
    }
  }

  async function check(driverId: string, now: number): Promise<void> {
    const raw = await redis.send('HGET', META_KEY, driverId);
    if (typeof raw !== 'string') return;
    let meta: GraceMeta;
    try {
      meta = JSON.parse(raw) as GraceMeta;
    } catch {
      await redis.send('HDEL', META_KEY, driverId);
      return;
    }

    if (await registry.isUserConnected(meta.userId)) {
      await redis.send('HDEL', META_KEY, driverId); // reconnected in time
      return;
    }

    // The socket is not the only heartbeat: driver apps POST their location
    // over HTTP from the background. A driver heard from recently is sitting
    // right there behind a flapping WebSocket — do NOT pull their bids
    // mid-negotiation; give them another grace window instead.
    const presence = await driverPresence.get(driverId);
    if (presence && now - presence.seenAt < PRESENCE_FRESH_MS) {
      if (!meta.extended) {
        // Counted once per disconnect, not every 45 seconds for as long as it lasts.
        tally.keptOnline += 1;
        if (verbose) {
          console.info('[ws] socket gone but driver alive via HTTP — keeping online', {
            driverId,
            seenMsAgo: now - presence.seenAt,
          });
        }
      }
      await Promise.all([
        redis.send('ZADD', DUE_KEY, String(now + DRIVER_OFFLINE_GRACE_MS), driverId),
        redis.send('HSET', META_KEY, driverId, JSON.stringify({ ...meta, extended: true })),
      ]);
      return;
    }

    await redis.send('HDEL', META_KEY, driverId);
    tally.takenOffline += 1;
    if (verbose) {
      console.info('[ws] driver offline after disconnect grace', {
        driverId,
        userId: meta.userId,
        offlineForMs: now - meta.since,
      });
    }
    void publisher
      .publishDriverEvent(
        DriverOfflineEvent.parse({
          eventType: 'DRIVER_OFFLINE',
          driverId,
          reason: 'inactivity',
          timestamp: new Date().toISOString(),
        }),
      )
      .catch(() => undefined);
    void driverPresence.remove(driverId);
    void withdrawDriverFromMarket(registry, meta.userId);
  }

  /** One pass: every grace that has run out, claimed and checked. Returns how many this process handled. */
  let sweeping = false;
  async function sweep(now = Date.now()): Promise<number> {
    // A pass that is still working through a long list is not joined by a second one.
    if (sweeping) return 0;
    sweeping = true;
    let handled = 0;
    try {
      while (handled < SWEEP_MAX_PER_PASS) {
        const due = await redis.send('ZRANGEBYSCORE', DUE_KEY, '-inf', String(now), 'LIMIT', '0', String(SWEEP_BATCH));
        if (!Array.isArray(due) || due.length === 0) break;
        for (const entry of due) {
          const driverId = String(entry);
          // Removing it is the claim: only one process gets a 1 back.
          const claimed = await redis.send('ZREM', DUE_KEY, driverId);
          if (claimed !== 1) continue;
          handled += 1;
          await check(driverId, now).catch((error) => {
            console.warn('[ws] offline grace check failed', {
              driverId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      }
    } catch {
      /* Redis is away; the next pass tries again */
    } finally {
      sweeping = false;
    }
    if (tally.keptOnline + tally.takenOffline > 0) {
      console.info('[ws] disconnect grace', { ...tally });
      tally.keptOnline = 0;
      tally.takenOffline = 0;
    }
    return handled;
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  function start(): void {
    if (timer) return;
    timer = setInterval(() => void sweep(), SWEEP_EVERY_MS);
    timer.unref?.();
  }
  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { schedule, cancel, sweep, start, stop };
}

export type DriverOfflineGrace = ReturnType<typeof createDriverOfflineGrace>;
