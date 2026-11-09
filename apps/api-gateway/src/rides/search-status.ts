import { RIDE } from '@wheleers/config';
import type { RedisClient } from '../redis/client';

/**
 * The rider's waiting screen: how many drivers the request went out to, and
 * when the search closes. Kept in Redis per ride so both gateway processes,
 * the ride page and the app see the same figures:
 *
 *   ride:{rideId}:notified        SET    the drivers the request reached (a re-sent offer adds nobody)
 *   ride:{rideId}:bids-close-at   STRING when the search closes (ISO), the ride service's own clock
 *   ride:{rideId}:offered-users   SET    the driver accounts the request reached, told when the rider cancels
 *   driver:{userId}:offered-rides SET    the requests a driver was shown, checked when their app reconnects
 *
 * A Kafka event delivered twice adds the same driver twice to a set: the count stays right.
 */

const KEEP_SECONDS = 2 * 60 * 60;
const notifiedKey = (rideId: string) => `ride:${rideId}:notified`;
const closeKey = (rideId: string) => `ride:${rideId}:bids-close-at`;
const offeredUsersKey = (rideId: string) => `ride:${rideId}:offered-users`;
const offeredRidesKey = (userId: string) => `driver:${userId}:offered-rides`;

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

/** The driver account the request reached, so a cancelled search can be cleared from every screen it is on. */
export async function noteOfferedDriverUser(redis: RedisClient, rideId: string, driverUserId: string): Promise<void> {
  await redis.send('SADD', offeredUsersKey(rideId), driverUserId).catch(() => undefined);
  await redis.send('EXPIRE', offeredUsersKey(rideId), String(KEEP_SECONDS)).catch(() => undefined);
  await redis.send('SADD', offeredRidesKey(driverUserId), rideId).catch(() => undefined);
  await redis.send('EXPIRE', offeredRidesKey(driverUserId), String(KEEP_SECONDS)).catch(() => undefined);
}

/** The requests this driver was shown in the last two hours. */
export async function offeredRidesOf(redis: RedisClient, driverUserId: string): Promise<string[]> {
  const members = await redis.send('SMEMBERS', offeredRidesKey(driverUserId)).catch(() => null);
  return Array.isArray(members) ? members.filter((m): m is string => typeof m === 'string' && m.length > 0) : [];
}

/** Requests the driver has been told are over: not checked again. */
export async function forgetOfferedRides(redis: RedisClient, driverUserId: string, rideIds: string[]): Promise<void> {
  if (rideIds.length === 0) return;
  await redis.send('SREM', offeredRidesKey(driverUserId), ...rideIds).catch(() => undefined);
}

/** Every driver account the request reached (bidders or not). */
export async function offeredDriverUsers(redis: RedisClient, rideId: string): Promise<string[]> {
  const members = await redis.send('SMEMBERS', offeredUsersKey(rideId)).catch(() => null);
  return Array.isArray(members) ? members.filter((m): m is string => typeof m === 'string' && m.length > 0) : [];
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
