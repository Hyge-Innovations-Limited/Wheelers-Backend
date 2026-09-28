import { randomUUID } from 'crypto';
import type { RedisClient } from '../redis/client';
import type { TripRole } from './access';

/**
 * A Live call while it rings and while it is on, kept in Redis so that either
 * gateway process can take any step of it: the caller may be connected to one
 * process and the person they call to the other.
 *
 *   tripcall:call:<id>   the call itself (JSON)
 *   tripcall:ride:<id>   the call on that ride right now: one at a time
 *   tripcall:ringing     calls ringing, scored by when they stop ringing
 *   tripcall:active      calls on, scored by when they are cut off
 *   tripcall:lock:<id>   held for the moment one step of a call is taken
 *
 * Postgres (TripCall) keeps the record; this is only the live state.
 */

export type CallState = 'ringing' | 'active' | 'ended';
export type CalleeChannel = 'app' | 'whatsapp';

export interface LiveCall {
  callId: string;
  rideId: string;
  tripId: string | null;
  callerId: string;
  callerRole: TripRole;
  callerName: string;
  calleeId: string;
  calleeRole: TripRole;
  calleeName: string;
  calleeChannel: CalleeChannel;
  state: CallState;
  createdAt: number;
  ringDeadline: number;
  answeredAt?: number;
  endedAt?: number;
  endReason?: string;
}

const CALL_TTL_SECONDS = 2 * 60 * 60;
/** An ended call is kept a little while, so a late "hang up" is answered "already ended", not "no such call". */
const ENDED_TTL_SECONDS = 10 * 60;
const RINGING = 'tripcall:ringing';
const ACTIVE = 'tripcall:active';

const callKey = (callId: string) => `tripcall:call:${callId}`;
const rideKey = (rideId: string) => `tripcall:ride:${rideId}`;
const lockKey = (callId: string) => `tripcall:lock:${callId}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

export function createCallStore(redis: RedisClient) {
  async function get(callId: string): Promise<LiveCall | null> {
    if (!callId) return null;
    const raw = await redis.get(callKey(callId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as LiveCall;
    } catch {
      return null;
    }
  }

  return {
    get,

    async save(call: LiveCall): Promise<void> {
      await redis.set(callKey(call.callId), JSON.stringify(call), call.state === 'ended' ? ENDED_TTL_SECONDS : CALL_TTL_SECONDS);
    },

    /** Take the ride's one line. False when a call already holds it. */
    async claimRide(rideId: string, callId: string): Promise<boolean> {
      return redis.setIfNotExists(rideKey(rideId), callId, CALL_TTL_SECONDS);
    },

    /** The call on this ride right now. A leftover pointing at an ended or vanished call is cleared. */
    async currentForRide(rideId: string): Promise<LiveCall | null> {
      const callId = await redis.get(rideKey(rideId));
      if (!callId) return null;
      const call = await get(callId);
      if (!call || call.state === 'ended') {
        await this.releaseRide(rideId, callId);
        return null;
      }
      return call;
    },

    async releaseRide(rideId: string, callId: string): Promise<void> {
      if ((await redis.get(rideKey(rideId))) === callId) await redis.del(rideKey(rideId));
    },

    async ringUntil(callId: string, deadline: number): Promise<void> {
      await redis.send('ZADD', RINGING, String(deadline), callId);
    },

    async activeUntil(callId: string, cutOffAt: number): Promise<void> {
      await redis.send('ZREM', RINGING, callId);
      await redis.send('ZADD', ACTIVE, String(cutOffAt), callId);
    },

    async clearRinging(callId: string): Promise<void> {
      await redis.send('ZREM', RINGING, callId);
    },

    async clearTimers(callId: string): Promise<void> {
      await redis.send('ZREM', RINGING, callId);
      await redis.send('ZREM', ACTIVE, callId);
    },

    /** Calls that should have stopped ringing, and calls past the longest a call may last. */
    async due(now: number): Promise<{ ringing: string[]; active: string[] }> {
      const [ringing, active] = await Promise.all([
        redis.send('ZRANGEBYSCORE', RINGING, '-inf', String(now), 'LIMIT', '0', '100'),
        redis.send('ZRANGEBYSCORE', ACTIVE, '-inf', String(now), 'LIMIT', '0', '100'),
      ]);
      return { ringing: strings(ringing), active: strings(active) };
    },

    /**
     * One step of a call at a time, across every process: "answer" and "stopped
     * ringing" arriving together must not both win. Waits up to about a second.
     */
    async withLock<T>(callId: string, step: () => Promise<T>): Promise<T> {
      const token = randomUUID();
      let held = false;
      for (let attempt = 0; attempt < 40 && !held; attempt += 1) {
        held = await redis.setIfNotExists(lockKey(callId), token, 5).catch(() => false);
        if (!held) await sleep(25);
      }
      // Redis is slow or gone: better to take the step than to leave a phone ringing forever.
      try {
        return await step();
      } finally {
        if (held && (await redis.get(lockKey(callId)).catch(() => null)) === token) {
          await redis.del(lockKey(callId)).catch(() => undefined);
        }
      }
    },
  };
}

export type CallStore = ReturnType<typeof createCallStore>;
