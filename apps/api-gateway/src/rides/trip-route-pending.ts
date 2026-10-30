import { RouteChangeRefused } from './route-refused';
import { createHash } from 'node:crypto';
import { calculateRideFees } from '@wheleers/config';
import type { PlannedRouteMetrics } from '@wheleers/config';
import { RideRouteUpdateRequestedEvent } from '@wheleers/kafka-schemas';
import { walletClient } from '@wheleers/db';
import type { RedisClient } from '../redis/client';

/**
 * A priced route change the rider accepted but the wallet could not fund yet
 * (STOP_FIXED_PRICE_ENABLED, wallet rides). Nothing moves until the money
 * lands: the change waits here, and is published when a deposit covers it or
 * the rider tries again. Backing out deletes it and the trip stays as it was.
 *
 *   ride:{rideId}:route-pending     the change, PENDING_TTL_SECONDS
 *   user:{riderId}:route-pending    the ride it belongs to (a deposit knows the user, not the ride)
 *
 * Taking it off is one atomic GETDEL: only the caller that gets it back (deposit, retry or cancel) acts on it.
 * A separate short-lived key (claimPublish) stops the same priced change going out twice.
 */
export const PENDING_TTL_SECONDS = 5 * 60;
const pendingKey = (rideId: string) => `ride:${rideId}:route-pending`;
const pointerKey = (riderId: string) => `user:${riderId}:route-pending`;

type Place = { lat: number; lng: number; address?: string };

/** What the price was set against. The change is applied only while the ride still looks like this. */
export interface RouteBase {
  baseAgreedFareNgn?: number;
  basePlannedKm?: number | null;
  baseDoneStops?: number;
  /** When the price was set (ISO). Not part of "the ride is still as priced": it only says how old the price is. */
  pricedAt?: string;
  /** Where the car was when it was priced (during the trip). A car that has moved far makes the price old. */
  car?: { lat: number; lng: number };
  /** The km driven that the price counted. */
  kmDriven?: number;
}

export interface PendingRouteChange extends RouteBase {
  rideId: string;
  riderId: string;
  driverId?: string;
  destination: Place;
  stops: Place[];
  /** The exact fare the rider accepted (whole naira). */
  fareNgn: number;
  plannedTotalKm?: number;
  planned: PlannedRouteMetrics;
  /** The route as one string, to tell a retry of the same change from another change. */
  routeKey: string;
  expiresAt: string;
}

/** The ride as the price saw it. */
export function routeBaseOf(ride: { agreedFareNgn: unknown; plannedDistanceKm?: number | null; routeStops?: Array<{ status: string }> }): RouteBase {
  return {
    ...(ride.agreedFareNgn !== null && ride.agreedFareNgn !== undefined ? { baseAgreedFareNgn: Number(ride.agreedFareNgn) } : {}),
    basePlannedKm: ride.plannedDistanceKm ?? null,
    baseDoneStops: (ride.routeStops ?? []).filter((stop) => stop.status === 'COMPLETED').length,
  };
}

/** True when the ride is still as the change was priced against (the age and car position are not compared here). */
export function sameBase(a: RouteBase, b: RouteBase): boolean {
  return a.baseAgreedFareNgn === b.baseAgreedFareNgn
    && (a.basePlannedKm ?? null) === (b.basePlannedKm ?? null)
    && a.baseDoneStops === b.baseDoneStops;
}

/** A cancel this recent is not undone by a new save of the same change. */
const CANCEL_STANDS_MS = 5000;
const cancelledKey = (rideId: string) => `ride:${rideId}:route-cancelled`;

/** Set the pending change only if no cancel marker stands (one Lua step), and its pointer with it. 1 = saved, 0 = the rider backed out. */
const SAVE_BACK_LUA = `if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
redis.call('SET', KEYS[3], ARGV[2], 'EX', ARGV[3])
return 1`;

/**
 * Keep a change waiting. A NEW change (no keepExpiry) clears any cancel marker and starts a new wait.
 * Putting a change back (keepExpiry: a deposit or retry that took it and found the wallet still short, or a
 * publish that failed) keeps its first expiry and is dropped, atomically, if the rider cancelled in the gap:
 * then null is returned and nothing is waiting.
 */
export async function savePendingRoute(redis: RedisClient, pending: Omit<PendingRouteChange, 'expiresAt'>, keepExpiry?: string): Promise<PendingRouteChange | null> {
  const existing = keepExpiry ? null : await readPendingRoute(redis, pending.rideId);
  const sameChange = existing && existing.routeKey === pending.routeKey && existing.fareNgn === pending.fareNgn;
  const expiresAt = keepExpiry ?? (sameChange ? existing.expiresAt : new Date(Date.now() + PENDING_TTL_SECONDS * 1000).toISOString());
  const left = Math.max(1, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000));
  const full: PendingRouteChange = { ...pending, expiresAt };
  if (keepExpiry) {
    const saved = await redis.send('EVAL', SAVE_BACK_LUA, '3', pendingKey(pending.rideId), cancelledKey(pending.rideId), pointerKey(pending.riderId), JSON.stringify(full), pending.rideId, String(left));
    return saved === 1 || saved === '1' ? full : null;
  }
  // The rider backed out a moment ago (a double tap and a cancel racing): that cancel stands, this save is dropped.
  const markedAt = Number(await redis.get(cancelledKey(pending.rideId)).catch(() => null));
  if (Number.isFinite(markedAt) && Date.now() - markedAt >= 0 && Date.now() - markedAt < CANCEL_STANDS_MS) return null;
  await redis.del(cancelledKey(pending.rideId)).catch(() => undefined);
  await redis.set(pendingKey(pending.rideId), JSON.stringify(full), left);
  await redis.set(pointerKey(pending.riderId), pending.rideId, left);
  return full;
}

/** The rider backed out: take the waiting change off and leave a marker so a change being put back right now is dropped. */
export async function cancelPendingRoute(redis: RedisClient, rideId: string, riderId: string): Promise<boolean> {
  const withdrawn = await takePendingRoute(redis, rideId, riderId);
  const left = withdrawn ? Math.max(1, Math.ceil((new Date(withdrawn.expiresAt).getTime() - Date.now()) / 1000)) : PENDING_TTL_SECONDS;
  await redis.set(cancelledKey(rideId), String(Date.now()), left).catch(() => undefined);
  return !!withdrawn;
}

function parsePending(raw: unknown, rideId: string): PendingRouteChange | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as PendingRouteChange;
    return parsed && parsed.rideId === rideId && Number.isFinite(parsed.fareNgn) ? parsed : null;
  } catch {
    return null;
  }
}

export async function readPendingRoute(redis: RedisClient, rideId: string): Promise<PendingRouteChange | null> {
  return parsePending(await redis.get(pendingKey(rideId)).catch(() => null), rideId);
}

/** The ride this rider's waiting change belongs to (a deposit knows the user, not the ride). */
export async function pendingRideOf(redis: RedisClient, riderId: string): Promise<string | null> {
  return redis.get(pointerKey(riderId)).catch(() => null);
}

/**
 * Take the waiting change: ONE atomic GETDEL. Only the caller that gets it back (a deposit, a retry
 * or a cancel) may act on it; everyone else sees nothing, so it is published or dropped exactly once.
 */
export async function takePendingRoute(redis: RedisClient, rideId: string, riderId?: string): Promise<PendingRouteChange | null> {
  const raw = await redis.send('GETDEL', pendingKey(rideId)).catch(() => null);
  if (riderId) await redis.del(pointerKey(riderId)).catch(() => undefined);
  return parsePending(raw, rideId);
}

/** Drop the waiting change (the caller does not need to know whether there was one). */
export async function clearPendingRoute(redis: RedisClient, rideId: string, riderId?: string): Promise<void> {
  await takePendingRoute(redis, rideId, riderId);
}

/**
 * The same priced change (route, fare, and the ride it was priced against) goes out once: whoever sets this
 * short-lived key publishes, the other (a deposit and a retry together) reports it as already made.
 * Not a claim on the waiting change (that is the atomic take): a duplicate guard that a failed publish releases.
 */
export async function claimPublish(redis: RedisClient, p: { rideId: string; routeKey: string; fareNgn: number } & RouteBase): Promise<string | null> {
  const digest = createHash('sha1').update([p.routeKey, p.fareNgn, p.baseAgreedFareNgn, p.basePlannedKm ?? 'n', p.baseDoneStops].join('#')).digest('hex');
  const key = `ride:${p.rideId}:route-publish:${digest}`;
  return (await redis.setIfNotExists(key, '1', 30).catch(() => true)) ? key : null;
}
export async function releasePublish(redis: RedisClient, key: string | null): Promise<void> {
  if (key) await redis.del(key).catch(() => undefined);
}

export type HoldFunding =
  | { ok: true; previousHoldNgn: number | null; applied: boolean; walletId?: string; userId?: string; newHoldNgn: number }
  | { ok: false; extraNgn: number; balanceNgn: number; neededNgn: number };

/**
 * Where the money moves: raise the ride's hold to the new fare, here, before the change is
 * published. A wallet that cannot cover it refuses (the hold is untouched); wallet-service's own
 * adjustment on RIDE_ROUTE_UPDATED then finds nothing to do. The balance is compared as it is, to the kobo.
 */
export async function fundRouteHold(rideId: string, riderId: string, fareNgn: number): Promise<HoldFunding> {
  const target = calculateRideFees(fareNgn).totalNgn;
  // The hold can change under us (a withdrawal, another change): adjustRideHold writes only if the hold is
  // still what it read, and says applied:false when it lost. Look again, up to three times.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Only RAISE here. A cheaper change leaves the hold alone: wallet-service lowers it on RIDE_ROUTE_UPDATED,
    // after ride-service has applied the change, so a hold never drops for a change that was not made.
    const current = await walletClient.rideHoldOf(rideId).catch(() => null);
    // A wallet ride with no live hold has nothing paying for the new route: it does not go ahead.
    if (!current || current.status !== 'ACTIVE') throw new RouteChangeRefused('No money is held for this trip, so its route cannot be changed.');
    if (target <= Number(current.amountNgn)) {
      return { ok: true, previousHoldNgn: null, applied: false, newHoldNgn: target };
    }
    try {
      const held = await walletClient.adjustRideHold({ rideId, targetAmountNgn: target });
      if (!held) return { ok: true, previousHoldNgn: null, applied: false, newHoldNgn: target };
      if (held.applied) {
        return { ok: true, previousHoldNgn: held.previousHoldAmountNgn, applied: true, walletId: held.wallet.id, userId: held.wallet.userId, newHoldNgn: held.holdAmountNgn };
      }
      if (held.holdAmountNgn >= target) return { ok: true, previousHoldNgn: null, applied: false, walletId: held.wallet.id, userId: held.wallet.userId, newHoldNgn: held.holdAmountNgn };
      // Lost a race: the hold moved between the read and the write. Try again from what it is now.
    } catch (error) {
      if (!/insufficient balance/i.test(error instanceof Error ? error.message : String(error))) throw error;
      const short = await walletShortfall(rideId, riderId, fareNgn);
      // Whatever the numbers say now, the hold refused: ask for at least ₦1.
      return { ok: false, extraNgn: short.extraNgn, balanceNgn: short.balanceNgn, neededNgn: Math.max(1, short.neededNgn) };
    }
  }
  throw new Error('The wallet hold kept changing, so the route was not changed. Please try again.');
}

/** Put the hold back where it was (the change could not be published after the hold had moved). Best effort. */
export async function restoreRouteHold(rideId: string, funded: Extract<HoldFunding, { ok: true }>): Promise<void> {
  if (!funded.applied || funded.previousHoldNgn === null) return;
  await walletClient.adjustRideHold({ rideId, targetAmountNgn: funded.previousHoldNgn, expectedAmountNgn: funded.newHoldNgn }).catch((error) => {
    console.error('[route-change] CRITICAL: hold could not be put back after a failed publish', { rideId, error: error instanceof Error ? error.message : String(error) });
  });
}

/** What the wallet must add before this fare can be held, for the answer shown to the rider. Whole naira, rounded up. */
export async function walletShortfall(rideId: string, riderId: string, fareNgn: number): Promise<{ extraNgn: number; balanceNgn: number; neededNgn: number }> {
  const hold = await walletClient.rideHoldOf(rideId).catch(() => null);
  if (!hold || hold.status !== 'ACTIVE') return { extraNgn: 0, balanceNgn: 0, neededNgn: 0 };
  const extraNgn = Math.round(calculateRideFees(fareNgn).totalNgn - Number(hold.amountNgn));
  const wallet = await walletClient.findByUserId(riderId).catch(() => null);
  const balanceNgn = Number(wallet?.balanceNgn ?? 0);
  return { extraNgn, balanceNgn, neededNgn: extraNgn > balanceNgn ? Math.ceil(extraNgn - balanceNgn) : 0 };
}

/** The Kafka event that makes the change (the one the app's ride:route:update publishes). */
export function buildPricedRouteEvent(p: PendingRouteChange, timestamp: string) {
  return RideRouteUpdateRequestedEvent.parse({
    eventType: 'RIDE_ROUTE_UPDATE_REQUESTED',
    rideId: p.rideId,
    riderId: p.riderId,
    driverId: p.driverId,
    destination: p.destination,
    stops: p.stops,
    plannedDistanceKm: p.planned.distanceKm,
    plannedDurationSeconds: p.planned.durationSeconds,
    // The trip's whole fare, not the rest: the wallet holds it and settlement charges it.
    fareEstimateNgn: p.fareNgn,
    acceptedFareNgn: p.fareNgn,
    plannedTotalKm: p.plannedTotalKm,
    baseAgreedFareNgn: p.baseAgreedFareNgn,
    basePlannedKm: p.basePlannedKm,
    baseDoneStops: p.baseDoneStops,
    route: p.planned.geometry,
    updatedBy: 'rider',
    timestamp,
  });
}
