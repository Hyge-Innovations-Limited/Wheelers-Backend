import { driverBidClient, rideClient, walletClient } from '@wheleers/db';
import type { RedisClient } from '../redis/client';
import type { GatewayPublisher } from '../websocket/publisher';
import { logActivity } from '../analytics/log-activity';
import { getActiveRide, getBids, getGroupSeat, getPendingAccept, getRideMeta, getRideState, getSearchTimedOut, isRidePageOpen } from '../whatsapp-flows/bid-state';
import { isSearchEnded } from './booking-lock';
import { deferUntilPageLeft } from '../whatsapp-flows/page-catchup';
import type { RidePageChatEvent } from '../http/ride-page.route';
import { acceptOfferInApp } from './app-accept';
import { confirmRideWithOffer, offerKey } from './whatsapp-ride.service';

/**
 * Auto-accept, only for a search the rider said yes to when they started it
 * (autoAccept: true on ride:request or POST /ride-page/find; asked once, at
 * Find), or switched on for it since (ride:auto_accept, POST /ride-page/auto-accept).
 * Every other search — the WhatsApp chat's price, the offers form, an app that
 * never sends the field, a ride for later — never books by itself. Then: the first
 * driver whose offer is at or below the rider's current price and who is at
 * most 10 minutes away is booked and paid from the wallet — if the wallet
 * covers that offer at that moment. When it does not, nothing is booked and
 * the rider chooses as before.
 *
 * It books through the very accepts a tap uses — confirmRideWithOffer for a
 * search begun on WhatsApp or the ride page, acceptOfferInApp for the app —
 * so every guard is the same: the driver online, fresh and free, the bid still
 * open, one rider per driver, one booking per ride, the hold before anything
 * is published.
 *
 *   ride:{rideId}:auto-accept        { off?, riderId?, offerNgn? }   an explicit "off" (ride:auto_accept / POST /ride-page/auto-accept),
 *                                    and the app's latest price (the database lags a change)
 *   ride:{rideId}:auto-accept:lock   one booking attempt at a time, across both gateway processes
 *   ride:{rideId}:auto-accept:booked it has booked this ride: never again (Kafka redelivery)
 *
 * Nothing is tried while the rider's money is already held for the ride (a
 * booking going through, by a tap or by this).
 */

export const AUTO_ACCEPT_MAX_ETA_SECONDS = 10 * 60;
const RECORD_TTL_SECONDS = 2 * 60 * 60;
const LOCK_SECONDS = 30;
const recordKey = (rideId: string) => `ride:${rideId}:auto-accept`;
const lockKey = (rideId: string) => `ride:${rideId}:auto-accept:lock`;
/** Set once auto-accept has booked a driver for the ride: a redelivered offer finds it and does nothing. */
const bookedKey = (rideId: string) => `ride:${rideId}:auto-accept:booked`;
/** Its booking was said in the chat ("Your ride is booked"), not held for the page: a booking that falls through must be unsaid. */
const toldKey = (rideId: string) => `ride:${rideId}:auto-accept:told-chat`;

interface AutoAcceptRecord {
  riderId?: string;
  /** The rider switched it off for this search. */
  off?: boolean;
  /** The rider's price when it was last changed (the app's price lags in the database). */
  offerNgn?: number;
}

export interface AutoAcceptDeps {
  redisClient: RedisClient;
  publisher: GatewayPublisher;
  /** The rider's app is told when auto-accept books. Absent (the ride page): the page reads it from its state. */
  registry?: { sendToUser(userId: string, type: string, payload: Record<string, unknown>): Promise<unknown> | unknown };
  /** "Your ride is booked" in the chat now, for a WhatsApp rider not on the ride page. Absent: it waits for the page catch-up. */
  tellChat?: (event: RidePageChatEvent) => Promise<void>;
}

export type AutoAcceptSwitch =
  | { ok: true; on: boolean; booked?: boolean }
  | { ok: false; reason: 'not_searching'; message: string };

async function readRecord(redis: RedisClient, rideId: string): Promise<AutoAcceptRecord | null> {
  const raw = await redis.get(recordKey(rideId)).catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AutoAcceptRecord;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function writeRecord(redis: RedisClient, rideId: string, record: AutoAcceptRecord): Promise<void> {
  await redis.set(recordKey(rideId), JSON.stringify(record), RECORD_TTL_SECONDS).catch(() => undefined);
}

/** Is auto-accept on for this search? Only when the rider said yes to it (off: false on the record). */
export async function isAutoAcceptOn(redis: RedisClient, rideId: string): Promise<boolean> {
  return (await readRecord(redis, rideId))?.off === false;
}

async function balanceOf(riderId: string): Promise<number> {
  const wallet = await walletClient.findByUserId(riderId).catch(() => null);
  return wallet ? Number(wallet.balanceNgn) : 0;
}

type Search = { kind: 'whatsapp' | 'app'; riderId: string; offerNgn: number };

/**
 * The search, if it is still looking for a driver: whose, where it began, and
 * the price offered now. The ride row is written by the ride service a moment
 * after a cancel or a timeout, so the gateway's own view must agree too: the
 * search not ended here, and for WhatsApp the rider's live search, not timed out.
 */
async function openSearch(redis: RedisClient, rideId: string, expectRiderId?: string, offerHint?: number): Promise<Search | null> {
  if (await isSearchEnded(redis, rideId)) return null;
  if (await getGroupSeat(redis, rideId).catch(() => null)) return null;
  const [meta, ride] = await Promise.all([
    getRideMeta(redis, rideId).catch(() => null),
    rideClient.findById(rideId).catch(() => null),
  ]);
  const riderId = expectRiderId ?? meta?.riderId ?? ride?.riderId;
  if (!riderId) return null;
  if (ride && ride.riderId !== riderId) return null;
  if (ride && ride.status !== 'REQUESTED' && ride.status !== 'MATCHING') return null;
  if (meta) {
    if (meta.riderId !== riderId) return null;
    const state = await getRideState(redis, rideId).catch(() => null);
    if (state === 'confirmed' || state === 'in_progress') return null;
    if ((await getActiveRide(redis, riderId).catch(() => null)) !== rideId) return null;
    if ((await getSearchTimedOut(redis, riderId).catch(() => null))?.rideId === rideId) return null;
    return { kind: 'whatsapp', riderId, offerNgn: meta.offerNgn };
  }
  // A WhatsApp search whose state is gone (cancelled, timed out) is never booked as an app ride.
  if (!ride || ride.channel === 'WHATSAPP') return null;
  const offerNgn = offerHint ?? Number(ride.riderOfferNgn ?? ride.fareEstimateNgn ?? 0);
  return offerNgn > 0 ? { kind: 'app', riderId, offerNgn } : null;
}

/** Is this the rider's own search (by its ride row, or its WhatsApp state)? */
async function ownsSearch(redis: RedisClient, riderId: string, rideId: string): Promise<boolean> {
  const [meta, ride] = await Promise.all([
    getRideMeta(redis, rideId).catch(() => null),
    rideClient.findById(rideId).catch(() => null),
  ]);
  if (ride) return ride.riderId === riderId;
  return meta?.riderId === riderId;
}

/**
 * The rider's explicit switch (ride:auto_accept, POST /ride-page/auto-accept):
 * off is kept for this search; on is their yes, and books any offer on the
 * table that qualifies.
 */
export async function switchAutoAccept(deps: AutoAcceptDeps, riderId: string, rideId: string, on: boolean): Promise<AutoAcceptSwitch> {
  // Only the rider whose search it is: nobody switches it for someone else's ride.
  if (!(await ownsSearch(deps.redisClient, riderId, rideId))) return { ok: false, reason: 'not_searching', message: 'This search has ended.' };
  const record = (await readRecord(deps.redisClient, rideId)) ?? {};
  if (record.riderId && record.riderId !== riderId) return { ok: false, reason: 'not_searching', message: 'This search has ended.' };
  if (!on) {
    await writeRecord(deps.redisClient, rideId, { ...record, riderId, off: true });
    return { ok: true, on: false };
  }
  const search = await openSearch(deps.redisClient, rideId, riderId, record.offerNgn);
  if (!search) return { ok: false, reason: 'not_searching', message: 'This search has ended.' };
  await writeRecord(deps.redisClient, rideId, { ...record, riderId, off: false });
  const { booked } = await tryAutoAccept(deps, rideId);
  return booked ? { ok: true, on: false, booked: true } : { ok: true, on: true };
}

/** Off for a search the rider is starting right now (a ride for later; off is also what no record means). */
export async function autoAcceptOffAtStart(redis: RedisClient, rideId: string, riderId: string): Promise<void> {
  await writeRecord(redis, rideId, { riderId, off: true });
}

/** On for a search the rider is starting right now and said yes to (autoAccept: true): theirs by construction. */
export async function autoAcceptOnAtStart(redis: RedisClient, rideId: string, riderId: string): Promise<void> {
  const record = (await readRecord(redis, rideId)) ?? {};
  await writeRecord(redis, rideId, { ...record, riderId, off: false });
}

/** The driver auto-accept booked on this ride, if it did (its booking was nobody's tap). */
export async function autoBookedDriver(redis: RedisClient, rideId: string): Promise<string | null> {
  return redis.get(bookedKey(rideId)).catch(() => null);
}

/** The search goes on after a booking fell through (the driver bailed, or was busy): auto-accept may book again. */
export async function clearAutoAcceptBooked(redis: RedisClient, rideId: string): Promise<void> {
  await redis.del(bookedKey(rideId)).catch(() => undefined);
  await redis.del(toldKey(rideId)).catch(() => undefined);
}

/** Did auto-accept say its booking in the chat (rather than hold the card for the page)? */
export async function autoAcceptToldChat(redis: RedisClient, rideId: string): Promise<boolean> {
  return Boolean(await redis.get(toldKey(rideId)).catch(() => null));
}

/** The rider changed their price: an offer now at or under it may be booked. */
export async function autoAcceptPriceChanged(deps: AutoAcceptDeps, rideId: string, offerNgn: number): Promise<void> {
  const record = (await readRecord(deps.redisClient, rideId)) ?? {};
  await writeRecord(deps.redisClient, rideId, { ...record, offerNgn });
  await tryAutoAccept(deps, rideId);
}

interface Candidate {
  driverId: string;
  driverUserId: string;
  bidId?: string;
  /** The page's handle for a WhatsApp search's offer. */
  key?: string;
  priceNgn: number;
  etaSeconds: number;
  /** Driver→pickup km from the driver's position on the server; absent: the ETA is the app's own word. */
  distanceKm?: number | null;
}

/** Offers on the table that may be booked: open, at or under the price, at most 10 minutes away. Cheapest, then nearest, first. */
async function candidatesFor(redis: RedisClient, search: Search, rideId: string, priceNgn: number): Promise<Candidate[]> {
  const rows = await driverBidClient.findByRide(rideId).catch(() => []);
  let list: Candidate[];
  if (search.kind === 'whatsapp') {
    const bids = await getBids(redis, rideId).catch(() => []);
    list = bids.flatMap((bid) => {
      // The bid row says whether it is still open: withdrawn, declined or lost is not booked.
      const row = bid.bidId ? rows.find((r) => r.id === bid.bidId) : undefined;
      const theirs = rows.filter((r) => r.driverId === bid.driverId);
      const open = row ? row.status === 'PENDING' : theirs.length === 0 || theirs.some((r) => r.status === 'PENDING');
      return open ? [{ driverId: bid.driverId, driverUserId: bid.driverUserId, bidId: bid.bidId, key: offerKey(bid), priceNgn: bid.counterOfferNgn, etaSeconds: bid.etaSeconds, distanceKm: row?.distanceKm ?? bid.distanceKm ?? null }] : [];
    });
  } else {
    list = rows
      .filter((row) => row.status === 'PENDING')
      .map((row) => ({ driverId: row.driverId, driverUserId: row.driverUserId, bidId: row.id, priceNgn: Number(row.amountNgn), etaSeconds: row.etaSeconds, distanceKm: row.distanceKm }));
  }
  return list
    // The 10 minutes must be ours to vouch for: a bid whose ETA came only from the driver's app (no position on
    // the server) is left for the rider to choose.
    .filter((c) => c.distanceKm != null && Number.isFinite(c.distanceKm))
    .filter((c) => Number.isFinite(c.priceNgn) && c.priceNgn > 0 && c.priceNgn <= priceNgn && c.etaSeconds <= AUTO_ACCEPT_MAX_ETA_SECONDS)
    .sort((a, b) => a.priceNgn - b.priceNgn || a.etaSeconds - b.etaSeconds);
}

type Attempt = 'booked' | 'stop' | 'next';

async function bookOne(deps: AutoAcceptDeps, search: Search, rideId: string, candidate: Candidate): Promise<Attempt> {
  const riderId = search.riderId;
  if (search.kind === 'whatsapp') {
    const result = await confirmRideWithOffer(deps, riderId, rideId, candidate.key!, { method: 'NGN', auto: true, expectedFareNgn: candidate.priceNgn });
    if (result.ok) {
      logActivity({ userId: riderId, eventType: 'ride_offer_accepted', source: 'auto_accept', rideId, metadata: { fareNgn: result.ride.fareNgn, driverId: result.ride.driverId } });
      // "Your ride is booked" in the chat: now when the rider is not on the ride page, else once they leave it.
      const meta = await getRideMeta(deps.redisClient, rideId).catch(() => null);
      if (meta?.phone) {
        const event: RidePageChatEvent = { kind: 'ride_confirmed', userId: riderId, phone: meta.phone, ride: result.ride };
        const onPage = await isRidePageOpen(deps.redisClient, riderId).catch(() => true);
        const toldNow = !onPage && deps.tellChat ? await deps.tellChat(event).then(() => true, () => false) : false;
        if (toldNow) await deps.redisClient.set(toldKey(rideId), '1', RECORD_TTL_SECONDS).catch(() => undefined);
        if (!toldNow) {
          await deferUntilPageLeft(deps.redisClient, riderId, { kind: 'ride_confirmed', rideId, event: event as unknown as Record<string, unknown> }).catch(() => undefined);
        }
      }
      return 'booked';
    }
    // The wallet no longer covers it, the search is gone, a booking is already going through, or the
    // money or the message could not be handled: stop here (a failed acceptance has let go of its hold).
    if (['WALLET_SHORT', 'RIDE_GONE', 'ALREADY_CONFIRMING', 'ALREADY_BOOKED', 'CONFIRM_FAILED', 'HOLD_FAILED'].includes(result.code)) return 'stop';
    return 'next';
  }
  const reply = await acceptOfferInApp({ publisher: deps.publisher, redis: deps.redisClient }, riderId, {
    rideId,
    driverId: candidate.driverId,
    driverUserId: candidate.driverUserId,
    bidId: candidate.bidId,
    paymentMethod: 'WALLET',
    agreedFareNgn: candidate.priceNgn,
    auto: true,
  }).catch(() => null);
  // Not sent (it lets go of its claim and its hold when it throws): stop.
  if (!reply) return 'stop';
  if (reply.type === 'ride:accept_offer:accepted') {
    logActivity({ userId: riderId, eventType: 'ride_offer_accepted', source: 'auto_accept', rideId, metadata: { fareNgn: candidate.priceNgn, driverId: candidate.driverId } });
    return 'booked';
  }
  const reason = reply.payload['reason'];
  if (reason === 'insufficient_funds' || reason === 'already_matched' || reason === 'busy' || reason === 'search_ended') return 'stop';
  return 'next';
}

/**
 * Book the best qualifying offer the wallet covers. Called when an offer
 * arrives (a counter-offer, or a driver taking the rider's price) and when the
 * rider changes their price. Never throws.
 */
export async function tryAutoAccept(deps: AutoAcceptDeps, rideId: string): Promise<{ booked: boolean }> {
  const record = await readRecord(deps.redisClient, rideId);
  // Only with the rider's yes: a search they did not say yes to never books by itself.
  if (record?.off !== false) return { booked: false };
  if (await deps.redisClient.get(bookedKey(rideId)).catch(() => null)) return { booked: false };
  // One attempt at a time, whichever gateway process the offer reached.
  const mine = await deps.redisClient.setIfNotExists(lockKey(rideId), '1', LOCK_SECONDS).catch(() => false);
  if (!mine) return { booked: false };
  try {
    const search = await openSearch(deps.redisClient, rideId, record?.riderId, record?.offerNgn);
    if (!search) return { booked: false };
    // The rider chose a driver and is adding money for them: that choice stands.
    const paying = await getPendingAccept(deps.redisClient, search.riderId).catch(() => null);
    if (paying?.rideId === rideId) return { booked: false };
    // Money already held on the ride is the accepts' to judge, under the booking lock: a booking
    // still going through is refused there, and a stale hold from a failed accept is let go.
    // The app's price in the database lags a change; the record has the latest.
    const priceNgn = search.kind === 'whatsapp' ? search.offerNgn : record?.offerNgn ?? search.offerNgn;
    const tried = new Set<string>();
    // A second look: an offer that landed while the first was being tried.
    for (let pass = 0; pass < 2; pass++) {
      // Only what the wallet covers now: otherwise the rider chooses, as before.
      const balanceNgn = await balanceOf(search.riderId);
      const candidates = (await candidatesFor(deps.redisClient, search, rideId, priceNgn))
        .filter((c) => !tried.has(c.driverId) && c.priceNgn <= balanceNgn);
      if (candidates.length === 0) break;
      for (const candidate of candidates) {
        tried.add(candidate.driverId);
        // Switched off meanwhile: stop.
        if ((await readRecord(deps.redisClient, rideId))?.off) return { booked: false };
        const outcome = await bookOne(deps, search, rideId, candidate).catch((): Attempt => 'stop');
        if (outcome === 'booked') {
          await deps.redisClient.set(bookedKey(rideId), candidate.driverId, RECORD_TTL_SECONDS).catch(() => undefined);
          await Promise.resolve()
            .then(() => deps.registry?.sendToUser(search.riderId, 'ride:auto_accept:done', { rideId, on: false, reason: 'booked', driverId: candidate.driverId, agreedFareNgn: candidate.priceNgn }))
            .catch(() => undefined);
          return { booked: true };
        }
        if (outcome === 'stop') return { booked: false };
      }
    }
    return { booked: false };
  } catch (error) {
    console.warn('[auto-accept] attempt failed', { rideId, error: error instanceof Error ? error.message : String(error) });
    return { booked: false };
  } finally {
    await deps.redisClient.del(lockKey(rideId)).catch(() => undefined);
  }
}
