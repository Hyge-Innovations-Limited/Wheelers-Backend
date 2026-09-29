import { timingSafeEqual } from 'crypto';
import { tripCodeClient } from '@wheleers/db';
import type { RedisClient } from '../redis/client';
import { overLimit } from '../trip-chat/limits';

/**
 * The trip code at the start of a trip. The rider has 4 digits (on the
 * WhatsApp ride card, the Trip chat page, or the rider app); the driver enters
 * them to start. Checked here, on the server, so no app can skip it.
 *
 * Asked for only when TRIP_CODE_REQUIRED is on and the rider was actually
 * given a code: a ride with none (group rides) starts as before. Once the
 * right code is in, or support has unlocked the trip, it is not asked again.
 */

export const TRIP_CODE_TRIES = 5;
export const TRIP_CODE_LOCK_SECONDS = 120;

export function tripCodeRequired(): boolean {
  return process.env.TRIP_CODE_REQUIRED === 'true';
}

export class TripCodeError extends Error {
  constructor(readonly code: 'TRIP_CODE_REQUIRED' | 'TRIP_CODE_WRONG' | 'TRIP_CODE_LOCKED', message: string) {
    super(message);
  }
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Does this driver still have to enter the code before starting? For the driver app's Start button. */
export async function tripCodeStillNeeded(rideId: string): Promise<boolean> {
  if (!tripCodeRequired()) return false;
  const state = await tripCodeClient.state(rideId).catch(() => null);
  return Boolean(state?.tripCode && !state.tripCodeVerifiedAt && !state.tripCodeUnlockedAt);
}

/**
 * Throws when this trip may not start with what the driver entered. With the
 * switch off, a code sent anyway is still recorded when it is right, and
 * never blocks.
 */
export async function checkTripCodeAtStart(rideId: string, entered: unknown, redis: RedisClient | undefined): Promise<void> {
  const state = await tripCodeClient.state(rideId);
  if (!state?.tripCode) return;
  if (state.tripCodeVerifiedAt || state.tripCodeUnlockedAt) return;

  const code = typeof entered === 'string' ? entered.replace(/\D/g, '') : typeof entered === 'number' ? String(entered).padStart(4, '0') : '';
  if (!tripCodeRequired()) {
    if (code && same(code, state.tripCode)) await tripCodeClient.markVerified(rideId).catch(() => undefined);
    return;
  }

  if (!code) throw new TripCodeError('TRIP_CODE_REQUIRED', "Ask the rider for their 4-digit trip code.");
  const lockKey = `tripcode:tries:${rideId}`;
  if (redis && Number(await redis.get(lockKey).catch(() => null)) >= TRIP_CODE_TRIES) {
    throw new TripCodeError('TRIP_CODE_LOCKED', 'Too many wrong codes. Wait 2 minutes, then ask the rider for the code again.');
  }
  if (same(code, state.tripCode)) {
    await tripCodeClient.markVerified(rideId);
    if (redis) await redis.del(lockKey).catch(() => undefined);
    return;
  }

  await tripCodeClient.addWrongTry(rideId).catch(() => 0);
  const locked = redis ? await overLimit(redis, lockKey, TRIP_CODE_TRIES - 1, TRIP_CODE_LOCK_SECONDS) : false;
  throw new TripCodeError(
    locked ? 'TRIP_CODE_LOCKED' : 'TRIP_CODE_WRONG',
    locked ? 'Too many wrong codes. Wait 2 minutes, then ask the rider for the code again.' : 'Wrong code. Ask the rider again.',
  );
}
