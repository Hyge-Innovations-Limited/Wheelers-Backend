import type { RedisClient } from '../redis/client';
import { isRidePageOpen } from './bid-state';

/**
 * While the rider is on the ride page, the chat stays quiet: what it would
 * have said waits here. When they leave (the page has stopped asking for
 * news), the chat gets ONE message, and only what is still true by then — a
 * search that ended is not announced, a booking that fell through is not.
 *
 * Shared by both gateway processes through Redis: whichever sweeps first
 * takes a rider (removing them from the due set is the claim). Adding an item
 * and taking the list are each one Redis step (a script), so nothing added
 * while a sweep takes the list is lost.
 */

export type CatchupItem =
  /** "Your bid is in", with the button back into the page. */
  | { kind: 'search_started'; rideId: string; event: Record<string, unknown> }
  /** "Your ride is booked": the card the trip's chat, calls and SOS hang on. */
  | { kind: 'ride_confirmed'; rideId: string; event: Record<string, unknown> }
  /** The driver is outside: the car, the plate, the trip code. */
  | { kind: 'arrived'; rideId: string; driverId?: string }
  /** The booked driver pulled out and the search goes on: the one message with "See driver offers". */
  | { kind: 'driver_cancelled'; rideId: string; details: Record<string, unknown> }
  /** The number of offers on "Your bid is in" (a reaction: silent, and not the one message). */
  | { kind: 'offer_count'; rideId: string };

/**
 * Which message is said when several waited, highest first: the driver
 * outside, then the booking, then a driver pulling out, then the search.
 */
export const CATCHUP_PRIORITY: ReadonlyArray<CatchupItem['kind']> = ['arrived', 'ride_confirmed', 'driver_cancelled', 'search_started'];

const DUE_KEY = 'ride_page:catchup_due';
const KEEP_SECONDS = 3 * 60 * 60;
/** The page asks every 3–5 s and counts as gone after 25 s of silence: look a little after that. */
const FIRST_LOOK_MS = 30_000;
const LOOK_AGAIN_MS = 10_000;
const SWEEP_EVERY_MS = 5_000;
const SWEEP_BATCH = 50;

/** Before: a JSON array in one string (still read, so nothing left by the last version is lost). */
function itemsKey(userId: string): string {
  return `whatsapp:user:${userId}:page_catchup`;
}
/** Now: a Redis list, one JSON item per entry, appended in one step (RPUSH). */
function listKey(userId: string): string {
  return `whatsapp:user:${userId}:page_catchup_list`;
}

function parseArray(raw: unknown): CatchupItem[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as CatchupItem[]) : [];
  } catch {
    return [];
  }
}

function parseOne(raw: unknown): CatchupItem[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw) as CatchupItem;
    return parsed && typeof parsed === 'object' && typeof parsed.kind === 'string' ? [parsed] : [];
  } catch {
    return [];
  }
}

/** One of each kind per ride: the newest wins (items are oldest first). */
function newestOfEach(items: CatchupItem[]): CatchupItem[] {
  const seen = new Set<string>();
  const out: CatchupItem[] = [];
  for (const item of [...items].reverse()) {
    const id = `${item.kind}:${item.rideId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.unshift(item);
  }
  return out;
}

const OLD_MARK = '__array__';
/** Take the list (and any array the last version left) and empty both — in one step. */
const TAKE = `
local out = redis.call('LRANGE', KEYS[1], 0, -1)
redis.call('DEL', KEYS[1])
local old = redis.call('GET', KEYS[2])
if old then
  redis.call('DEL', KEYS[2])
  table.insert(out, 1, ARGV[1] .. old)
end
return out`;

function parseTaken(entries: unknown[]): CatchupItem[] {
  return entries.flatMap((entry) => {
    const text = typeof entry === 'string' ? entry : Buffer.isBuffer(entry) ? entry.toString('utf8') : '';
    return text.startsWith(OLD_MARK) ? parseArray(text.slice(OLD_MARK.length)) : parseOne(text);
  });
}

/** Keep this for when the rider leaves the page. One of each kind per ride: the newest wins. */
export async function deferUntilPageLeft(redis: RedisClient, userId: string, item: CatchupItem, now = Date.now()): Promise<void> {
  const length = await Promise.resolve().then(() => redis.send('RPUSH', listKey(userId), JSON.stringify(item))).catch(() => undefined);
  if (typeof length === 'number') {
    await redis.send('EXPIRE', listKey(userId), String(KEEP_SECONDS)).catch(() => undefined);
  } else {
    // A Redis stand-in without lists (tests): the array in one string.
    const items = parseArray(await redis.get(itemsKey(userId)).catch(() => null)).filter((kept) => !(kept.kind === item.kind && kept.rideId === item.rideId));
    items.push(item);
    await redis.set(itemsKey(userId), JSON.stringify(items), KEEP_SECONDS);
  }
  await redis.send('ZADD', DUE_KEY, String(now + FIRST_LOOK_MS), userId);
}

/** Everything waiting for this rider, taken (empty afterwards). */
async function takeItems(redis: RedisClient, userId: string): Promise<CatchupItem[]> {
  const taken = await Promise.resolve().then(() => redis.send('EVAL', TAKE, '2', listKey(userId), itemsKey(userId), OLD_MARK)).catch(() => undefined);
  if (Array.isArray(taken)) return newestOfEach(parseTaken(taken));
  // A stand-in without scripting (tests): read and delete.
  const items = parseArray(await redis.get(itemsKey(userId)).catch(() => null));
  if (items.length) await redis.del(itemsKey(userId)).catch(() => undefined);
  return newestOfEach(items);
}

/** What is waiting for this rider (tests). */
export async function pendingCatchup(redis: RedisClient, userId: string): Promise<CatchupItem[]> {
  const listed = await Promise.resolve().then(() => redis.send('LRANGE', listKey(userId), '0', '-1')).catch(() => undefined);
  const old = parseArray(await redis.get(itemsKey(userId)).catch(() => null));
  return newestOfEach([...old, ...(Array.isArray(listed) ? parseTaken(listed) : [])]);
}

export interface PageCatchupDeps {
  redis: RedisClient;
  /** Says one waiting thing in the chat if it is still true; true when it was said. */
  deliver: (userId: string, item: CatchupItem) => Promise<boolean | void>;
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
    const items = await takeItems(redis, userId);
    const tell = async (item: CatchupItem): Promise<boolean> => {
      try {
        return (await deps.deliver(userId, item)) !== false;
      } catch (error) {
        console.warn('[page-catchup] could not tell the chat', { userId, kind: item.kind, error: error instanceof Error ? error.message : String(error) });
        return false;
      }
    };
    // Silent updates first (the offer count's reaction), then ONE message: the most
    // important still true. The newest of a kind first.
    for (const item of items.filter((i) => i.kind === 'offer_count')) await tell(item);
    for (const kind of CATCHUP_PRIORITY) {
      const ofKind = items.filter((i) => i.kind === kind).reverse();
      for (const item of ofKind) {
        if (await tell(item)) return;
      }
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
