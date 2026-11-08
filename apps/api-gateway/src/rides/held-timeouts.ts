import type { RedisClient } from '../redis/client';

/**
 * A search whose clock ran out while the rider was paying for a chosen driver
 * (a bank top-up) is held, not ended: the deposit landing still books that
 * driver. If the rider never pays, nothing else would end it, so the hold is
 * noted here with when to look again (when the rider's choice lapses), and
 * the gateway's sweep runs the end of the search then. In Redis, so a restart
 * keeps it; taken by one gateway only (ZREM), so it is never ended twice.
 */
const KEY = 'wheelers:held-bid-timeouts';

export async function noteHeldTimeout(redis: RedisClient, rideId: string, riderId: string, dueMs: number): Promise<void> {
  await redis.send('ZADD', KEY, String(Math.round(dueMs)), `${rideId}|${riderId}`);
}

/** The held searches due a second look, each handed to one caller only. */
export async function takeDueHeldTimeouts(redis: RedisClient, now = Date.now()): Promise<Array<{ rideId: string; riderId: string }>> {
  const due = await redis.send('ZRANGEBYSCORE', KEY, '-inf', String(now), 'LIMIT', '0', '50');
  if (!Array.isArray(due)) return [];
  const taken: Array<{ rideId: string; riderId: string }> = [];
  for (const member of due) {
    if (typeof member !== 'string') continue;
    // Another gateway took it first: not ours.
    if ((await redis.send('ZREM', KEY, member)) !== 1) continue;
    const [rideId, riderId] = member.split('|');
    if (rideId && riderId) taken.push({ rideId, riderId });
  }
  return taken;
}
