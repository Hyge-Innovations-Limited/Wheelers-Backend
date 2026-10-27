import { RIDE } from '@wheleers/config';
import type { RedisClient } from '../redis/client';

/**
 * The rider's waiting screen: how many drivers the request went out to, and
 * when the search closes. Kept in Redis per ride so both gateway processes,
 * the ride page and the app see the same figures:
 *
 *   ride:{rideId}:notified        SET    the drivers the request reached (a re-sent offer adds nobody)
 *   ride:{rideId}:bids-close-at   STRING when the search closes (ISO), the ride service's own clock
 *
 * A Kafka event delivered twice adds the same driver twice to a set: the count stays right.
 */

const KEEP_SECONDS = 2 * 60 * 60;
const notifiedKey = (rideId: string) => `ride:${rideId}:notified`;
const closeKey = (rideId: string) => `ride:${rideId}:bids-close-at`;

export interface SearchStatus {
  /** Drivers the request was sent to; null when none is known yet. */
  driversNotified: number | null;
  /** When the search closes (ISO); null when not known. */
  bidsCloseAt: string | null;
}

async function countOf(redis: RedisClient, rideId: string): Promise<number> {
  const count = await redis.send('SCARD', notifiedKey(rideId)).catch(() => 0);
  return typeof count === 'number' ? count : Number(count) || 0;
}

/** The request reached one more driver (or reached one again, with a new price or clock). Says whether anything the rider sees changed. */
export async function noteOfferSent(
  redis: RedisClient,
  rideId: string,
  driverId: string,
  bidsCloseAt: string | null | undefined,
): Promise<SearchStatus & { changed: boolean }> {
  const added = await redis.send('SADD', notifiedKey(rideId), driverId).catch(() => 0);
  await redis.send('EXPIRE', notifiedKey(rideId), String(KEEP_SECONDS)).catch(() => undefined);
  let closeChanged = false;
  if (bidsCloseAt) {
    const before = await redis.get(closeKey(rideId)).catch(() => null);
    if (before !== bidsCloseAt) {
      await redis.set(closeKey(rideId), bidsCloseAt, KEEP_SECONDS).catch(() => undefined);
      closeChanged = true;
    }
  }
  const count = await countOf(redis, rideId);
  const closes = bidsCloseAt ?? (await redis.get(closeKey(rideId)).catch(() => null));
  return { driversNotified: count > 0 ? count : null, bidsCloseAt: closes, changed: Number(added) === 1 || closeChanged };
}

/** The search's clock (re)started now: set when it is published or its price changes, until the ride service says otherwise. */
export async function startSearchClock(redis: RedisClient, rideId: string, now = Date.now()): Promise<string> {
  const at = new Date(now + RIDE.BID_TIMEOUT_SECONDS * 1000).toISOString();
  await redis.set(closeKey(rideId), at, KEEP_SECONDS).catch(() => undefined);
  return at;
}

export async function getSearchStatus(redis: RedisClient, rideId: string): Promise<SearchStatus> {
  const [count, closes] = await Promise.all([countOf(redis, rideId), redis.get(closeKey(rideId)).catch(() => null)]);
  return { driversNotified: count > 0 ? count : null, bidsCloseAt: closes };
}
