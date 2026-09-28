import type { RedisClient } from '../redis/client';

/**
 * One more event in a fixed window. True when this one is over `max`.
 * Shared by every gateway process, since the counter is in Redis. If Redis
 * cannot answer, nothing is refused: a limit is not worth an outage.
 */
export async function overLimit(redis: RedisClient, key: string, max: number, windowSeconds: number): Promise<boolean> {
  try {
    const count = Number(await redis.send('INCR', key));
    if (count === 1) await redis.send('EXPIRE', key, String(windowSeconds));
    return count > max;
  } catch {
    return false;
  }
}
