import type { RedisClient } from '../redis/client';

/**
 * One booking at a time on a ride, whatever door it comes through: the app's
 * Accept, the chat's tap, the offers form, the ride page, a deposit landing,
 * auto-accept, the old WhatsApp form. Every one takes this lock for the ride
 * before it looks at holds and publishes, and lets go when it is done, booked
 * or not. (It is the key the WhatsApp accept always took, so a cancel on the
 * ride page still waits for a booking in progress.)
 *
 *   whatsapp:ride:{rideId}:confirming   the lock (20 s; a booking takes far less)
 *   ride:{rideId}:accept-sent           the driver an acceptance was published for: a repeat for
 *                                       the same driver is answered "done", another driver is refused,
 *                                       until that booking falls through (assignment failed, driver bailed)
 *   ride:{rideId}:search-ended          the search is over in the gateway's own eyes (rider cancelled,
 *                                       timed out), written before the ride service gets to the row
 */

const LOCK_SECONDS = 20;
const SENT_SECONDS = 15 * 60;
const ENDED_SECONDS = 6 * 60 * 60;

export const bookingLockKey = (rideId: string) => `whatsapp:ride:${rideId}:confirming`;
const acceptSentKey = (rideId: string) => `ride:${rideId}:accept-sent`;
const endedKey = (rideId: string) => `ride:${rideId}:search-ended`;

/** True when this caller now holds the ride's booking lock. Redis away: let it through (the hold and the claim still guard). */
export async function takeBookingLock(redis: RedisClient, rideId: string): Promise<boolean> {
  return redis.setIfNotExists(bookingLockKey(rideId), '1', LOCK_SECONDS).catch(() => true);
}

export async function releaseBookingLock(redis: RedisClient, rideId: string): Promise<void> {
  await redis.del(bookingLockKey(rideId)).catch(() => undefined);
}

/** An acceptance for this driver went out on the ride. */
export async function noteAcceptSent(redis: RedisClient, rideId: string, driverUserId: string): Promise<void> {
  await redis.set(acceptSentKey(rideId), driverUserId, SENT_SECONDS).catch(() => undefined);
}

/** The driver an acceptance went out for on this ride, if one is still standing. */
export async function acceptSentFor(redis: RedisClient, rideId: string): Promise<string | null> {
  return redis.get(acceptSentKey(rideId)).catch(() => null);
}

/** That booking fell through and the search goes on: another accept may go out. */
export async function clearAcceptSent(redis: RedisClient, rideId: string): Promise<void> {
  await redis.del(acceptSentKey(rideId)).catch(() => undefined);
}

/** The search is over (cancelled by the rider, or timed out): nothing books it automatically again. */
export async function markSearchEnded(redis: RedisClient, rideId: string): Promise<void> {
  await redis.set(endedKey(rideId), '1', ENDED_SECONDS).catch(() => undefined);
}

export async function isSearchEnded(redis: RedisClient, rideId: string): Promise<boolean> {
  return Boolean(await redis.get(endedKey(rideId)).catch(() => null));
}
