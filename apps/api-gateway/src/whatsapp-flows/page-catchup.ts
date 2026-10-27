import type { RedisClient } from '../redis/client';
import { isRidePageOpen } from './bid-state';

/**
 * While the rider is on the ride page, the chat stays quiet: what it would
 * have said waits here. When they leave (the page has stopped asking for
 * news), the chat gets it, once, and only what is still true by then — a
 * search that ended is not announced, a booking that fell through is not.
 *
 * Shared by both gateway processes through Redis: whichever sweeps first
 * takes a rider (removing them from the due set is the claim).
 */

export type CatchupItem =
  /** "Your bid is in", with the button back into the page. */
  | { kind: 'search_started'; rideId: string; event: Record<string, unknown> }
  /** "Your ride is booked": the card the trip's chat, calls and SOS hang on. */
  | { kind: 'ride_confirmed'; rideId: string; event: Record<string, unknown> }
  /** The driver is outside: the car, the plate, the trip code. */
  | { kind: 'arrived'; rideId: string; driverId?: string };

const DUE_KEY = 'ride_page:catchup_due';
const KEEP_SECONDS = 3 * 60 * 60;
/** The page asks every 3–5 s and counts as gone after 25 s of silence: look a little after that. */
const FIRST_LOOK_MS = 30_000;
const LOOK_AGAIN_MS = 10_000;
const SWEEP_EVERY_MS = 5_000;
const SWEEP_BATCH = 50;

function itemsKey(userId: string): string {
  return `whatsapp:user:${userId}:page_catchup`;
}

async function readItems(redis: RedisClient, userId: string): Promise<CatchupItem[]> {
  const raw = await redis.get(itemsKey(userId)).catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as CatchupItem[]) : [];
  } catch {
    return [];
  }
}

/** Keep this for when the rider leaves the page. One of each kind per ride: the newest wins. */
export async function deferUntilPageLeft(redis: RedisClient, userId: string, item: CatchupItem, now = Date.now()): Promise<void> {
  const items = (await readItems(redis, userId)).filter((kept) => !(kept.kind === item.kind && kept.rideId === item.rideId));
  items.push(item);
  await redis.set(itemsKey(userId), JSON.stringify(items), KEEP_SECONDS);
  await redis.send('ZADD', DUE_KEY, String(now + FIRST_LOOK_MS), userId);
}

/** What is waiting for this rider (tests, and the sweep). */
export async function pendingCatchup(redis: RedisClient, userId: string): Promise<CatchupItem[]> {
  return readItems(redis, userId);
}

export interface PageCatchupDeps {
  redis: RedisClient;
  /** Says one waiting thing in the chat, if it is still true. */
  deliver: (userId: string, item: CatchupItem) => Promise<void>;
}

export function createPageCatchup(deps: PageCatchupDeps) {
  const { redis } = deps;
  let sweeping = false;

  async function check(userId: string, now: number): Promise<void> {
    if (await isRidePageOpen(redis, userId)) {
      // Still there: look again shortly.
      await redis.send('ZADD', DUE_KEY, String(now + LOOK_AGAIN_MS), userId);
      return;
    }
    const items = await readItems(redis, userId);
    await redis.del(itemsKey(userId));
    for (const item of items) {
      await deps.deliver(userId, item).catch((error) => {
        console.warn('[page-catchup] could not tell the chat', {
          userId,
          kind: item.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  async function sweep(now = Date.now()): Promise<number> {
    if (sweeping) return 0;
    sweeping = true;
    let handled = 0;
    try {
      const due = await redis.send('ZRANGEBYSCORE', DUE_KEY, '-inf', String(now), 'LIMIT', '0', String(SWEEP_BATCH));
      if (Array.isArray(due)) {
        for (const entry of due) {
          const userId = String(entry);
          // Removing it is the claim: only one process gets a 1 back.
          if ((await redis.send('ZREM', DUE_KEY, userId)) !== 1) continue;
          handled += 1;
          await check(userId, now).catch(() => undefined);
        }
      }
    } catch {
      /* Redis is away; the next pass tries again */
    } finally {
      sweeping = false;
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

  return { sweep, start, stop };
}
