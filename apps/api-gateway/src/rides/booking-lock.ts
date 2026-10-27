import { randomUUID } from 'node:crypto';
import { walletClient } from '@wheleers/db';
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
const LOCK_POLL_MS = 250;
const SENT_SECONDS = 15 * 60;
const ENDED_SECONDS = 6 * 60 * 60;

export const bookingLockKey = (rideId: string) => `whatsapp:ride:${rideId}:confirming`;
const acceptSentKey = (rideId: string) => `ride:${rideId}:accept-sent`;
const endedKey = (rideId: string) => `ride:${rideId}:search-ended`;

/** A lock this caller holds: its token, so only it can let go of it. */
export type BookingLock = { rideId: string; token: string };

/**
 * Take the ride's booking lock, waiting up to `waitMs` for a booking in
 * progress to finish. Null: still busy. Redis away: let it through (the hold
 * and the claim still guard).
 */
export async function takeBookingLock(redis: RedisClient, rideId: string, waitMs = 0): Promise<BookingLock | null> {
  const token = randomUUID();
  const until = Date.now() + waitMs;
  for (;;) {
    const mine = await redis.setIfNotExists(bookingLockKey(rideId), token, LOCK_SECONDS).catch(() => true);
    if (mine) return { rideId, token };
    if (Date.now() + LOCK_POLL_MS > until) return null;
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}

const RELEASE_IF_MINE = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

/** Let go of the lock, only if it is still this caller's: one held past its 20 s never deletes the next holder's. */
export async function releaseBookingLock(redis: RedisClient, lock: BookingLock | null): Promise<void> {
  if (!lock) return;
  const key = bookingLockKey(lock.rideId);
  const answer = await Promise.resolve().then(() => redis.send('EVAL', RELEASE_IF_MINE, '1', key, lock.token)).catch(() => undefined);
  if (typeof answer === 'number') return;
  // A Redis stand-in without scripting (tests): the same check, in two steps.
  if ((await redis.get(key).catch(() => null)) === lock.token) await redis.del(key).catch(() => undefined);
}

/** Wait this long for a booking in progress before saying "try again". */
export const BOOKING_LOCK_WAIT_MS = 2_500;

/**
 * Money held on the ride for ANOTHER driver, with no acceptance sent for
 * them: left by an accept that failed (its message never went out, or the
 * process died between the hold and the message). Once older than the lock
 * (so no booking is still on its way), it is let go so the search can go on.
 * Call inside the booking lock.
 *
 *   'none'     nothing held for another driver
 *   'released' a stale hold was let go: carry on
 *   'blocked'  another driver's booking is real or still in flight: refuse
 */
export async function releaseStaleHoldForOther(redis: RedisClient, rideId: string, driverUserId: string, now = Date.now()): Promise<'none' | 'released' | 'blocked'> {
  const hold = await walletClient.rideHoldOf(rideId).catch(() => null);
  if (!hold || hold.status !== 'ACTIVE' || !hold.driverUserId || hold.driverUserId === driverUserId) return 'none';
  if (await acceptSentFor(redis, rideId)) return 'blocked';
  const since = hold.updatedAt ?? hold.createdAt;
  if (!since || now - since.getTime() < LOCK_SECONDS * 1000) return 'blocked';
  const released = await walletClient.cancelRideHold(rideId, hold.driverUserId).catch(() => null);
  return released ? 'released' : 'blocked';
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
