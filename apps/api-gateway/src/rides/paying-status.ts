import type { RedisClient } from '../redis/client';
import type { GatewayPublisher } from '../websocket/publisher';
import { acceptSentFor, BOOKING_LOCK_WAIT_MS, releaseBookingLock, takeBookingLock } from './booking-lock';
import { getRideState } from '../whatsapp-flows/bid-state';

/**
 * "Rider accepted · paying now" (DRIVER_PAYING_STATUS_ENABLED).
 *
 * One key per ride: ride:{rideId}:paying = {driverUserId, since}. One driver
 * at a time: opening for driver B ends it for A. The key expires after
 * PAYING_TTL_SECONDS; no sweep tells the driver then, their app stops waiting
 * at payingUntil on its own and a reconnect reads no state.
 */
export const PAYING_TTL_SECONDS = 10 * 60;
/** A repeat open that moves the end time by more than this is sent to the driver again. */
export const REPEAT_OPEN_NOTIFY_MS = 2 * 60 * 1000;
/** However often it is re-opened, one spell for one driver ends this long after it began. */
export const PAYING_MAX_SPELL_MS = 20 * 60 * 1000;
/** Spells (an open that starts afresh) allowed per ride and driver, counted for this long. */
export const PAYING_MAX_SPELLS = 2;
export const PAYING_SPELLS_TTL_SECONDS = 2 * 60 * 60;
/** Opens and closes together, per rider per minute. */
export const PAYING_RATE_PER_MINUTE = 20;

let enabled = false;
/** Set once at start-up from the env flag. Off, every function here is a no-op. */
export function setPayingStatusEnabled(value: boolean): void { enabled = value; }
export function payingStatusEnabled(): boolean { return enabled; }

export function payingKey(rideId: string): string { return `ride:${rideId}:paying`; }
export function payingLastKey(rideId: string, driverUserId: string): string { return `ride:${rideId}:paying:last:${driverUserId}`; }
export function payingSpellsKey(rideId: string, driverUserId: string): string { return `ride:${rideId}:paying:spells:${driverUserId}`; }

export interface PayingState { driverUserId: string; since: number; /** When the card stops waiting; refreshed by a repeat open. Absent: since + the TTL. */ untilMs?: number }
export interface PayingDeps { redisClient: RedisClient; publisher: Pick<GatewayPublisher, 'publishRideEvent'> }
export type PayingEndReason = 'closed' | 'declined' | 'other_chosen' | 'switched' | 'cancelled' | 'search_ended' | 'failed';

function parseState(raw: string | null): PayingState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PayingState>;
    if (typeof parsed.driverUserId !== 'string' || typeof parsed.since !== 'number') return null;
    return { driverUserId: parsed.driverUserId, since: parsed.since, ...(typeof parsed.untilMs === 'number' ? { untilMs: parsed.untilMs } : {}) };
  } catch {
    return null;
  }
}

/** The state; null when there is none; undefined when Redis could not say (callers treat that as "unknown", not "empty"). */
export async function readPaying(redis: Pick<RedisClient, 'get'>, rideId: string): Promise<PayingState | null | undefined> {
  try {
    return parseState(await redis.get(payingKey(rideId)));
  } catch {
    return undefined;
  }
}

export function payingWindow(state: PayingState): { payingSince: string; payingUntil: string } {
  return { payingSince: new Date(state.since).toISOString(), payingUntil: new Date(state.untilMs ?? state.since + PAYING_TTL_SECONDS * 1000).toISOString() };
}

/**
 * Take the key for a driver in one step (Redis runs a script alone). Returns [kind, previous raw value]:
 * 'same' (the same driver again: only the end time is moved), 'switched' (another driver held it), 'opened'.
 */
export const OPEN_SCRIPT = `
local old = redis.call('GET', KEYS[1])
local now = tonumber(ARGV[7])
local ttl = tonumber(ARGV[2])
local maxMs = tonumber(ARGV[6])
if old then
  local ok, o = pcall(cjson.decode, old)
  if ok and type(o) == 'table' and o.driverUserId == ARGV[3] then
    -- One spell lasts at most MAX from its start, however often it is re-opened.
    local capMs = o.since + maxMs
    -- The end time moves only when the move is big enough to be told to the driver, so the stored
    -- one is always the last one told. The key's own life is renewed every time, never past the cap.
    local told = o.untilMs or (o.since + ttl * 1000)
    local want = math.min(tonumber(ARGV[4]), capMs)
    local fresh = old
    if want - told > tonumber(ARGV[5]) then
      o.untilMs = want
      fresh = cjson.encode(o)
    end
    local ex = math.min(ttl, math.floor((capMs - now) / 1000))
    if ex > 0 then redis.call('SET', KEYS[1], fresh, 'EX', ex) end
    return {'same', fresh, old}
  end
end
-- Back to a spell that was closed or switched away from, still inside its 20 minutes: it resumes (same start, no new spell).
local startSince = now
local resumed = false
local lastRaw = redis.call('GET', KEYS[3])
if lastRaw then
  local s = tonumber(lastRaw)
  if s and (s + maxMs - now) > 1000 then startSince = s; resumed = true end
end
if not resumed then
  -- A genuinely new spell for this driver on this ride: only so many.
  local spells = redis.call('INCR', KEYS[2])
  if spells == 1 then redis.call('EXPIRE', KEYS[2], ARGV[8]) end
  if spells > tonumber(ARGV[9]) then return {'refused', old or ''} end
end
-- Another driver was being paid: their spell is remembered, to resume if the rider goes back.
if old then
  local ok, o = pcall(cjson.decode, old)
  if ok and type(o) == 'table' and o.driverUserId and o.since then
    local lex = math.floor((o.since + maxMs - now) / 1000)
    if lex > 0 then redis.call('SET', ARGV[10] .. o.driverUserId, tostring(o.since), 'EX', lex) end
  end
end
local st = cjson.decode(ARGV[1])
st.since = startSince
st.untilMs = math.min(tonumber(ARGV[4]), startSince + maxMs)
local ex = math.min(ttl, math.floor((startSince + maxMs - now) / 1000))
local fresh = cjson.encode(st)
redis.call('SET', KEYS[1], fresh, 'EX', ex)
redis.call('DEL', KEYS[3])
if old then return {'switched', old, fresh} end
return {'opened', '', fresh}`;
/** Delete only if the value is still the one read: a newer open is never undone by an older close. The spell is remembered for a resume. */
export const CLOSE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  local removed = redis.call('DEL', KEYS[1])
  if tonumber(ARGV[3]) > 0 then redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3]) else redis.call('DEL', KEYS[2]) end
  return removed
end
return 0`;
export const RATE_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`;

/**
 * The rider is paying for this driver. The same driver again: the clock is refreshed, no event.
 * Another driver: the first is told it ended, the new one is told it began.
 */
export async function openPaying(deps: PayingDeps, rideId: string, riderId: string, driverUserId: string): Promise<{ result: 'opened' | 'unchanged' | 'switched' | 'refused'; payingUntil: string | null }> {
  const now = Date.now();
  const state: PayingState = { driverUserId, since: now, untilMs: now + PAYING_TTL_SECONDS * 1000 };
  const reply = await deps.redisClient.send('EVAL', OPEN_SCRIPT, '3', payingKey(rideId), payingSpellsKey(rideId, driverUserId), payingLastKey(rideId, driverUserId), JSON.stringify(state), String(PAYING_TTL_SECONDS), driverUserId, String(state.untilMs), String(REPEAT_OPEN_NOTIFY_MS), String(PAYING_MAX_SPELL_MS), String(now), String(PAYING_SPELLS_TTL_SECONDS), String(PAYING_MAX_SPELLS), payingLastKey(rideId, '')) as [string, string, string?];
  const [kind, previousRaw, beforeRaw] = Array.isArray(reply) ? reply : ['opened', ''];
  if (kind === 'refused') return { result: 'refused', payingUntil: null };
  if (kind === 'same') {
    const kept = parseState(previousRaw) ?? state;
    const before = parseState(beforeRaw ?? null);
    const window = payingWindow(kept);
    // The clock moved a good way: the driver's app is told, so its own expiry moves too (the push is deduped, so no second banner).
    const movedMs = Date.parse(window.payingUntil) - (before ? Date.parse(payingWindow(before).payingUntil) : 0);
    if (before && movedMs > REPEAT_OPEN_NOTIFY_MS) {
      await deps.publisher.publishRideEvent({ eventType: 'RIDE_RIDER_PAYING', rideId, riderId, driverUserId, timestamp: new Date().toISOString(), ...window });
    }
    return { result: 'unchanged', payingUntil: window.payingUntil };
  }
  const stored = parseState(reply[2] ?? null) ?? state;
  let result: 'opened' | 'switched' = 'opened';
  const previous = kind === 'switched' ? parseState(previousRaw) : null;
  if (previous && previous.driverUserId !== driverUserId) {
    await deps.publisher.publishRideEvent({ eventType: 'RIDE_RIDER_PAYING_ENDED', rideId, driverUserId: previous.driverUserId, reason: 'switched', timestamp: new Date().toISOString() });
    result = 'switched';
  }
  // (A resumed spell keeps its start: the push is named by it, so there is no second banner.)
  const window = payingWindow(stored);
  await deps.publisher.publishRideEvent({ eventType: 'RIDE_RIDER_PAYING', rideId, riderId, driverUserId, timestamp: new Date().toISOString(), ...window });
  return { result, payingUntil: window.payingUntil };
}

/** Ends it if it is open (for `only`, if given); the driver is told once. Nothing open: nothing happens. */
export async function closePaying(deps: PayingDeps, rideId: string, reason: PayingEndReason, only?: string): Promise<boolean> {
  // A repeat open can move the value between the read and the delete: read again (a few times) before giving up.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const raw = await deps.redisClient.get(payingKey(rideId)).catch(() => null);
    const current = parseState(raw);
    if (!raw || !current || (only && current.driverUserId !== only)) return false;
    // Only a rider's own Back (or a switch) can be resumed; a decline, failure, cancel or end starts a fresh spell next time.
    const resumeSeconds = reason === 'closed' || reason === 'switched' ? Math.floor((current.since + PAYING_MAX_SPELL_MS - Date.now()) / 1000) : 0;
    const removed = await deps.redisClient.send('EVAL', CLOSE_SCRIPT, '2', payingKey(rideId), payingLastKey(rideId, current.driverUserId), raw, String(current.since), String(Math.max(0, resumeSeconds))).catch(() => null);
    if (removed === 1) {
      await deps.publisher.publishRideEvent({ eventType: 'RIDE_RIDER_PAYING_ENDED', rideId, driverUserId: current.driverUserId, reason, timestamp: new Date().toISOString() });
      return true;
    }
  }
  return false;
}

/**
 * The rider closed the pay sheet. A booking may be under way (a deposit landing, an accept already sent):
 * the close waits for the booking lock and does nothing if the ride is booked or an accept has gone out,
 * so a driver being booked never flashes back to "waiting". No lock in time: no close (the booking or the TTL ends it).
 */
export async function closePayingUnlessBooking(deps: PayingDeps, rideId: string, only: string): Promise<'closed' | 'nothing' | 'booking' | 'busy'> {
  // Nothing open for this driver: nothing to close, and no reason to queue behind a booking for the lock.
  if ((await readPaying(deps.redisClient, rideId))?.driverUserId !== only) return 'nothing';
  const lock = await takeBookingLock(deps.redisClient, rideId, BOOKING_LOCK_WAIT_MS).catch(() => null);
  if (!lock) return 'busy';
  try {
    const state = await getRideState(deps.redisClient, rideId).catch(() => null);
    // The accept marker holds the driver's user id: only an accept for THIS driver stops the close.
    if (state === 'confirmed' || state === 'in_progress' || (await acceptSentFor(deps.redisClient, rideId).catch(() => null)) === only) return 'booking';
    return (await closePaying(deps, rideId, 'closed', only)) ? 'closed' : 'nothing';
  } finally {
    await releaseBookingLock(deps.redisClient, lock).catch(() => undefined);
  }
}

/** The booked driver's own state is just cleared (ride:offer_accepted ends the card); anyone else's is ended. */
export async function clearForBooking(deps: PayingDeps, rideId: string, bookedDriverUserId: string): Promise<void> {
  const current = await readPaying(deps.redisClient, rideId);
  if (!current) return;
  if (current.driverUserId === bookedDriverUserId) await deps.redisClient.del(payingKey(rideId)).catch(() => undefined);
  else await closePaying(deps, rideId, 'other_chosen', current.driverUserId);
}

/** At most `limit` opens and closes together a minute per rider (count and expiry set in one step). */
export async function withinPayingRate(redis: Pick<RedisClient, 'send'>, riderId: string, limit = PAYING_RATE_PER_MINUTE): Promise<boolean> {
  const count = await redis.send('EVAL', RATE_SCRIPT, '1', `ratelimit:paying:${riderId}`, '60').catch(() => null);
  return typeof count === 'number' ? count <= limit : true;
}
