import type { RedisClient } from '../redis/client';

/**
 * Which gateway process runs the jobs that must run once.
 *
 * Some background work is not safe to do twice at the same moment: publishing
 * the outbox (every event would go out twice), settling referral rewards. With
 * one gateway process that was free. With two, exactly one of them must do it.
 *
 * The lock is a key in Redis that names its holder and expires in 30 seconds.
 * The holder renews it every time it asks; if that process dies, the key runs
 * out and the other takes over within half a minute.
 *
 * If Redis cannot be reached the answer is "yes, run": that is what a lone
 * process did before this existed, and every consumer of these jobs already
 * tolerates a repeat.
 */
const LOCK_TTL_SECONDS = 30;

export function createLeaderLock(redis: RedisClient, instanceId: string, name = 'jobs') {
  const key = `gateway:leader:${name}`;
  let wasLeader = false;

  async function isLeader(): Promise<boolean> {
    try {
      const claimed = await redis.send('SET', key, instanceId, 'EX', String(LOCK_TTL_SECONDS), 'NX');
      let mine = claimed === 'OK';
      if (!mine) {
        mine = (await redis.get(key)) === instanceId;
        if (mine) await redis.send('EXPIRE', key, String(LOCK_TTL_SECONDS));
      }
      if (mine !== wasLeader) {
        console.info(mine ? '[cluster] this process now runs the background jobs' : '[cluster] another process runs the background jobs', { instanceId });
        wasLeader = mine;
      }
      return mine;
    } catch {
      return true;
    }
  }

  /** Hand the lock back at once on a clean stop, so the other process need not wait for it to expire. */
  async function release(): Promise<void> {
    try {
      if ((await redis.get(key)) === instanceId) await redis.del(key);
    } catch {
      /* it expires by itself */
    }
  }

  return { isLeader, release };
}

export type LeaderLock = ReturnType<typeof createLeaderLock>;
