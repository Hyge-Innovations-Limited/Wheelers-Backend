import { randomUUID } from 'node:crypto';
import { calculateSuggestedFare, GROUP_RIDE_LIVE, groupSeatFloorNgn } from '@wheleers/config';
import { driverBidClient, driverClient, groupTripClient, prisma } from '@wheleers/db';
import { RideArrivedEvent, RideBidsDeclinedEvent, RideCancelledEvent, RideDriverAssignedEvent, RideOfferAcceptedEvent, RideRequestedEvent, RideRiderCounterOfferEvent, RideStartedEvent, GroupTripEndedEvent, GroupTripFormedEvent } from '@wheleers/kafka-schemas';
import type { RedisClient } from '../redis/client';
import type { GatewayPublisher } from '../websocket/publisher';
import { autoAcceptOffForChatPrice, autoAcceptOnAtStart, autoAcceptStatus } from './auto-accept';
import { isSearchEnded } from './booking-lock';
import { releaseFormedHold, type GroupLiveMember, type GroupLiveOffer } from './group-live';
import { areaOf, firstNameOf } from './group-people';

/**
 * Group ride, the booking (Timi, 17 Nov 2026). A formed group becomes a group trip: a TRIP ride (owned by the Wheelers
 * group account, never shown to a rider) that drivers see as one normal request (the first pickup, the stops, the
 * total), and the riders' own rides as its SEATS (each keeps its price, hold, code, waiting and receipt).
 *
 *   start     the seats are linked (all or none), their own driver offers end, auto-booking is off (kept, to come back),
 *             ride-service stops their searches (GROUP_TRIP_FORMED) and the trip's search starts (RIDE_REQUESTED)
 *   a bid     under the total: every seat a share cheaper; at the total: as agreed; a counter within +10% of every
 *             seat: taken; over that for some riders: only they are asked (never over +25%) — then booked, once:
 *             every seat held from its own wallet and assigned in one transaction, then the trip's accept goes out
 *   assigned  the trip has its driver: each seat is announced to its rider (RIDE_DRIVER_ASSIGNED, groupSeat)
 *   failed    the driver took another job in between: the seats and their money are let go, the next bid is tried
 *   leaving   a wallet short at booking or a rider who cancels: only they leave, the rest go out again as a group
 *   2 min     no driver: the group ends and every rider's own search goes on at their own price
 *
 * Booking and ending are claimed atomically (one Lua script each), and every deadline is kept in Redis (gt:due), run
 * by whichever gateway polls first (runDue), so a restart or a second gateway never loses or doubles one.
 */

export interface GroupTripDeps {
  redis: RedisClient;
  publisher: Pick<GatewayPublisher, 'publishRideEvent' | 'publishGroupRideEvent'>;
  /** Tell the riders (rides/group-live.ts's hook does it for the offer; this one for the trip). */
  tell?: (change: GroupTripChange) => Promise<void>;
  now?: () => number;
  /** Unused since the deadlines moved to Redis (kept so older callers still type-check). */
  schedule?: (fn: () => void, ms: number) => void;
}

let tripHook: ((change: GroupTripChange) => Promise<void>) | null = null;
/** The gateway's consumer tells riders (socket, page, chat); set once at start, used when a caller has no `tell`. */
export function setGroupTripHook(hook: ((change: GroupTripChange) => Promise<void>) | null): void {
  tripHook = hook;
}
const tellOf = (deps: GroupTripDeps) => deps.tell ?? tripHook;
const nowOf = (deps: GroupTripDeps) => (deps.now ?? Date.now)();

/** A rider in a group trip: their offer member, and their auto-booking price before the group (to restore it). */
export type GroupSeat = GroupLiveMember & { autoAcceptNgn?: number | null };

export type GroupTripChange =
  /** No driver in time: every rider's own search goes on. */
  | { kind: 'no_driver'; tripId: string; seats: GroupSeat[] }
  /** These riders' wallets could not cover their seats at booking: the group went on without them. */
  | { kind: 'wallet_short'; tripId: string; seats: GroupSeat[] }
  /** The others left and these riders are on their own again (their own search goes on). */
  | { kind: 'group_ended'; tripId: string; seats: GroupSeat[]; left: GroupSeat[] }
  /** The group goes on without the riders who left (a new trip, the same seats and prices). */
  | { kind: 'regrouped'; tripId: string; seats: GroupSeat[]; left: GroupSeat[] }
  /** A driver's counter is over +10% of these riders' seats: each is asked (COUNTER_ASK_SECONDS). */
  | { kind: 'counter_ask'; tripId: string; seats: GroupSeat[]; ask: CounterAsk }
  /**
   * That ask is over: every yes (booking), a No from someone, no answer in time, or the group booked another way.
   * `said`: the riders who had said yes.
   */
  | { kind: 'counter_closed'; tripId: string; seats: GroupSeat[]; ask: CounterAsk; outcome: 'yes' | 'no' | 'timeout' | 'other'; said: string[] };

/** A counter over +10% of some seats: those riders are asked. */
export interface CounterAsk {
  askId: string;
  tripId: string;
  bid: { bidId?: string; driverId: string; driverUserId: string; priceNgn: number };
  /** Every seat's price at this counter. */
  prices: Record<string, number>;
  /** The seats asked (over +10%). */
  over: string[];
  expiresAt: string;
}

export interface GroupTripRecord {
  tripId: string;
  seats: GroupSeat[];
  totalNgn: number;
  createdAt: string;
  /** No driver by then: the group ends. */
  deadline: string;
  /** The stops in order (a group re-formed without someone keeps the rest's order). Absent on older records. */
  stops?: GroupLiveOffer['stops'];
  /** The offer it came from (its seat holds are let go when the group ends). */
  offerId?: string;
}

/** How long the group waits for a driver before every rider goes back to their own search. */
export const GROUP_TRIP_SEARCH_SECONDS = 2 * 60;
/** A counter is taken without asking when each rider's share of it is within this of their seat. */
export const COUNTER_AUTO_SHARE = 0.10;
/** Over that, only the riders whose share is over are asked, up to this; more is never taken (Timi, 16 Nov). */
export const COUNTER_ASK_MAX_SHARE = 0.25;
/** How long an asked rider has to answer; silence is No. */
export const COUNTER_ASK_SECONDS = 20;
/** A rider who agreed a waiting price and still has not come: the driver may go on without them after this. */
export const GROUP_SKIP_AFTER_AGREED_MS = 10 * 60 * 1000;
const GROUP_RIDE_LIVE_FREE_WAIT_MS = 5 * 60 * 1000;

const tripKey = (tripId: string) => `gt:trip:${tripId}`;
const seatKey = (rideId: string) => `gt:seat:${rideId}`;
const bookingKey = (tripId: string) => `gt:booking:${tripId}`;
const bookedKey = (tripId: string) => `gt:booked:${tripId}`;
const endedKey = (tripId: string) => `gt:ended:${tripId}`;
const seatDoneKey = (rideId: string) => `gt:seatdone:${rideId}`;
const earnedKey = (rideId: string) => `gt:earned:${rideId}`;
const DUE_KEY = 'gt:due';
const KEEP_SECONDS = 6 * 60 * 60;

export { areaOf, firstNameOf } from './group-people';

/* ── the group account ─────────────────────────────────────────────────────────────────────────────────────────────── */

let groupAccount: string | null = null;
/** The Wheelers group account: owns every TRIP ride, so no rider ever sees one as theirs. */
export async function groupAccountId(): Promise<string> {
  if (groupAccount) return groupAccount;
  const user = await prisma.user.upsert({
    where: { privyDid: 'system:group-trips' },
    create: { privyDid: 'system:group-trips', role: 'RIDER', name: 'Group ride' },
    update: {},
    select: { id: true },
  });
  groupAccount = user.id;
  return user.id;
}

let groupAccountLookedUpAt = 0;
/**
 * The group account when it exists, never made here: for hot paths (every GPS point) that only ask "is this a group
 * trip". A miss is remembered a minute, so rides of one rider cost no lookup.
 */
export async function existingGroupAccountId(now: number = Date.now()): Promise<string | null> {
  if (groupAccount) return groupAccount;
  if (now - groupAccountLookedUpAt < 60_000) return null;
  groupAccountLookedUpAt = now;
  const user = await prisma.user.findUnique({ where: { privyDid: 'system:group-trips' }, select: { id: true } }).catch(() => null);
  if (user) groupAccount = user.id;
  return groupAccount;
}

/* ── which driver apps can drive a group trip ──────────────────────────────────────────────────────────────────────── */

const groupDriverKey = (driverUserId: string) => `gt:driverapp:${driverUserId}`;
/** The driver's app said it drives group trips (driver:online { groupTrips: true }); kept a day, renewed each time. */
export async function noteGroupTripDriver(redis: RedisClient, driverUserId: string): Promise<void> {
  await redis.set(groupDriverKey(driverUserId), '1', 24 * 60 * 60);
}
/** Only these drivers see a group trip or may bid on one: an app older than group trips cannot drive it. */
export async function drivesGroupTrips(redis: RedisClient, driverUserId: string): Promise<boolean> {
  return (await redis.get(groupDriverKey(driverUserId)).catch(() => null)) === '1';
}

/* ── records ───────────────────────────────────────────────────────────────────────────────────────────────────────── */

export async function readTrip(redis: RedisClient, tripId: string): Promise<GroupTripRecord | null> {
  const raw = await redis.get(tripKey(tripId)).catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw) as GroupTripRecord; } catch { return null; }
}

/** The group trip a ride is a seat of (while it lasts), or null. */
export async function tripOfSeat(redis: RedisClient, rideId: string): Promise<string | null> {
  return redis.get(seatKey(rideId)).catch(() => null);
}

/* ── atomic claims and durable deadlines ───────────────────────────────────────────────────────────────────────────── */

// A booking may start only while the trip is neither ended nor booked; the end only while it is neither booked nor
// being booked (-1: being booked, try again after it). One script each: no gap between the check and the claim.
const CLAIM_BOOKING = "if redis.call('exists', KEYS[2]) == 1 or redis.call('exists', KEYS[3]) == 1 then return 0 end if redis.call('set', KEYS[1], ARGV[1], 'NX', 'EX', 30) then return 1 end return 0";
const CLAIM_END = "if redis.call('exists', KEYS[2]) == 1 then return 0 end if redis.call('exists', KEYS[3]) == 1 then return -1 end if redis.call('set', KEYS[1], '1', 'NX', 'EX', ARGV[1]) then return 1 end return 0";

async function evalNumber(redis: RedisClient, script: string, keys: string[], args: string[]): Promise<number> {
  return Number(await redis.send('EVAL', script, String(keys.length), ...keys, ...args));
}
const claimBooking = (redis: RedisClient, tripId: string, driverId: string) => evalNumber(redis, CLAIM_BOOKING, [bookingKey(tripId), endedKey(tripId), bookedKey(tripId)], [driverId]);
const claimEnd = (redis: RedisClient, tripId: string) => evalNumber(redis, CLAIM_END, [endedKey(tripId), bookedKey(tripId), bookingKey(tripId)], [String(KEEP_SECONDS)]);

/** Run `member` at `atMs` (or later): kept in Redis, so a restart or another gateway runs it. Re-adding moves it. */
async function dueAt(redis: RedisClient, member: string, atMs: number): Promise<void> {
  await redis.send('ZADD', DUE_KEY, String(Math.round(atMs)), member).catch(() => undefined);
}

/**
 * Run every group deadline that is due (the 2-minute end, an ask's 20 s, a retry after a booking in flight). Each runs
 * once: whoever removes it from gt:due runs it. Called every few seconds by every gateway. Returns how many ran.
 */
export async function runDue(deps: GroupTripDeps, nowMs: number = nowOf(deps)): Promise<number> {
  const due = await deps.redis.send('ZRANGEBYSCORE', DUE_KEY, '-inf', String(nowMs), 'LIMIT', '0', '50').catch(() => []);
  let ran = 0;
  for (const member of Array.isArray(due) ? due : []) {
    if (typeof member !== 'string') continue;
    if (Number(await deps.redis.send('ZREM', DUE_KEY, member).catch(() => 0)) !== 1) continue;
    ran += 1;
    const [kind, a, b, c] = member.split(':');
    try {
      if (kind === 'end' && a) await endUnbookedTrip(deps, a);
      else if (kind === 'ask' && a && b) await resolveAsk(deps, a, b, 'timeout');
      else if (kind === 'regroup' && a && b && c) await regroupWithout(deps, a, c.split(','), b === 'wallet_short' ? 'wallet_short' : 'left');
      else if (kind === 'leave' && a) await seatLeftBeforeBooking(deps, a);
    } catch (error) {
      console.error('[group-trip] deadline failed', { member, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return ran;
}

/* ── the group's own search ────────────────────────────────────────────────────────────────────────────────────────── */

const kmBetween = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(toRad(b.lat - a.lat) / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(toRad(b.lng - a.lng) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

/**
 * A group the riders agreed to: the trip starts. Returns the trip id, or null when it could not (a seat moved on in
 * between, or something failed half way: every seat is let go again and every rider's search simply goes on).
 */
export async function startGroupTrip(deps: GroupTripDeps, offer: Pick<GroupLiveOffer, 'stops'> & { offerId?: string }, joined: GroupSeat[]): Promise<string | null> {
  const tripId = randomUUID();
  const seatIds = joined.map((m) => m.rideId);
  if (!(await groupTripClient.linkSeats(tripId, seatIds))) return null;
  try {
    // The trip: the joined riders' stops in the planned order, the total of their seats. Written before anything
    // points at it (a rider cancelling now finds the whole group).
    const stops = offer.stops.filter((s) => seatIds.includes(s.rideId));
    const totalNgn = joined.reduce((sum, m) => sum + m.seatPriceNgn, 0);
    let km = 0;
    for (let i = 1; i < stops.length; i += 1) km += kmBetween(stops[i - 1]!, stops[i]!) * GROUP_RIDE_LIVE.ROAD_FACTOR;
    const fare = calculateSuggestedFare(km);
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;
    const at = nowOf(deps);
    // Each rider's yes to auto-booking, kept: it comes back if the group ends and their own search goes on.
    const seats: GroupSeat[] = [];
    for (const m of joined) {
      const auto = m.autoAcceptNgn !== undefined ? { on: m.autoAcceptNgn != null, priceNgn: m.autoAcceptNgn } : await autoAcceptStatus(deps.redis, m.rideId).catch(() => ({ on: false, priceNgn: null }));
      seats.push({ ...m, autoAcceptNgn: auto.on ? auto.priceNgn : null });
    }
    const record: GroupTripRecord = {
      tripId,
      seats,
      totalNgn,
      createdAt: new Date(at).toISOString(),
      deadline: new Date(at + GROUP_TRIP_SEARCH_SECONDS * 1000).toISOString(),
      stops,
      ...(offer.offerId ? { offerId: offer.offerId } : {}),
    };
    await deps.redis.set(tripKey(tripId), JSON.stringify(record), KEEP_SECONDS);
    await dueAt(deps.redis, `end:${tripId}`, at + GROUP_TRIP_SEARCH_SECONDS * 1000 + 1000);

    // Their own searches end here: the drivers who offered are told, and nothing books a seat alone.
    for (const seat of joined) {
      await autoAcceptOffForChatPrice(deps.redis, seat.rideId).catch(() => undefined);
      const bids = await driverBidClient.findByRide(seat.rideId).catch(() => []);
      for (const bid of bids) if (bid.status === 'PENDING') await driverBidClient.markWithdrawn(seat.rideId, bid.driverId).catch(() => undefined);
      await deps.redis.set(seatKey(seat.rideId), tripId, KEEP_SECONDS);
    }
    await deps.publisher.publishGroupRideEvent(GroupTripFormedEvent.parse({ eventType: 'GROUP_TRIP_FORMED', groupId: tripId, seatRideIds: seatIds, timestamp: new Date(at).toISOString() }));
    await deps.publisher.publishRideEvent(RideRequestedEvent.parse({
      eventType: 'RIDE_REQUESTED',
      rideId: tripId,
      riderId: await groupAccountId(),
      pickup: { lat: first.lat, lng: first.lng, address: first.address },
      destination: { lat: last.lat, lng: last.lng, address: last.address },
      stops: stops.slice(1, -1).map((s) => ({ lat: s.lat, lng: s.lng, address: s.address })),
      plannedDistanceKm: Math.round(km * 10) / 10,
      fareEstimateNgn: totalNgn,
      // The trip moves no money itself: each seat is held from its own rider's wallet.
      paymentMethod: 'CASH',
      riderOfferNgn: totalNgn,
      // The total is the trip's price: a counter is measured against it (never against one rider's fare).
      suggestedFareNgn: totalNgn,
      minOfferNgn: Math.min(totalNgn, fare.minOfferNgn),
      ratePerKmNgn: km > 0 ? Math.round(totalNgn / km) : fare.ratePerKmNgn,
      channel: 'APP',
      groupTrip: { stops: stops.map((s) => ({ rideId: s.rideId, kind: s.kind, lat: s.lat, lng: s.lng, address: s.address })) },
      timestamp: new Date(at).toISOString(),
    }));
    return tripId;
  } catch (error) {
    // Half made: nothing of it stays (the seats unlinked, nothing points at the trip).
    console.error('[group-trip] not started', { tripId, error: error instanceof Error ? error.message : String(error) });
    await groupTripClient.unlinkSeats(tripId, undefined, { includeAssigned: true }).catch(() => 0);
    for (const id of seatIds) if ((await tripOfSeat(deps.redis, id)) === tripId) await deps.redis.del(seatKey(id)).catch(() => undefined);
    await deps.redis.set(endedKey(tripId), '1', KEEP_SECONDS).catch(() => undefined);
    await deps.redis.send('ZREM', DUE_KEY, `end:${tripId}`).catch(() => undefined);
    return null;
  }
}

const floor50 = (n: number) => Math.floor(n / 50) * 50;

/**
 * The seat prices for a driver's price on the trip (shares by each rider's own fare, to ₦50, the last seat taking what
 * is left so the seats add up to the driver's price): under the total, every seat a share cheaper (Timi, 17 Nov: the
 * riders pay less; never under the seat floor); at the total, as agreed; above it, a share of the extra each. `over`:
 * the seats whose share is more than +10% (their riders are asked). Null when any share is more than +25% (never).
 */
export function priceSeats(
  seats: Array<{ rideId: string; offerNgn: number; seatPriceNgn: number }>,
  driverPriceNgn: number,
): { prices: Map<string, number>; over: string[] } | null {
  const total = seats.reduce((s, m) => s + m.seatPriceNgn, 0);
  const weights = seats.reduce((s, m) => s + m.offerNgn, 0) || 1;
  const split = (amount: number) => {
    const shares = new Map<string, number>();
    let given = 0;
    seats.forEach((m, i) => {
      const share = i === seats.length - 1 ? amount - given : floor50((amount * m.offerNgn) / weights);
      given += share;
      shares.set(m.rideId, share);
    });
    return shares;
  };
  if (driverPriceNgn === total) return { prices: new Map(seats.map((m) => [m.rideId, m.seatPriceNgn])), over: [] };
  if (driverPriceNgn < total) {
    const off = split(total - driverPriceNgn);
    const floor = groupSeatFloorNgn();
    return { prices: new Map(seats.map((m) => [m.rideId, Math.max(Math.min(floor, m.seatPriceNgn), m.seatPriceNgn - off.get(m.rideId)!)])), over: [] };
  }
  const extra = split(driverPriceNgn - total);
  const prices = new Map(seats.map((m) => [m.rideId, m.seatPriceNgn + extra.get(m.rideId)!]));
  const over: string[] = [];
  for (const m of seats) {
    const price = prices.get(m.rideId)!;
    if (price > m.seatPriceNgn * (1 + COUNTER_ASK_MAX_SHARE) + 0.5) return null;
    if (price > m.seatPriceNgn * (1 + COUNTER_AUTO_SHARE) + 0.5) over.push(m.rideId);
  }
  return { prices, over };
}

/** The seat prices when a driver's price is taken without asking anyone; null otherwise. */
export function seatPricesFor(seats: Array<{ rideId: string; offerNgn: number; seatPriceNgn: number }>, driverPriceNgn: number): Map<string, number> | null {
  const priced = priceSeats(seats, driverPriceNgn);
  return priced && priced.over.length === 0 ? priced.prices : null;
}

/** A driver's price that is not taken: they hear it (Offer declined) and may send another. */
async function declineBid(deps: GroupTripDeps, tripId: string, driverId: string): Promise<void> {
  const declined = await driverBidClient.declineOne(tripId, driverId).catch(() => null);
  if (!declined) return;
  await deps.publisher.publishRideEvent(RideBidsDeclinedEvent.parse({
    eventType: 'RIDE_BIDS_DECLINED', rideId: tripId, riderId: await groupAccountId(), driverUserIds: [declined.driverUserId], remainingOffers: 0, timestamp: new Date().toISOString(),
  })).catch(() => undefined);
}

type Bid = { tripId: string; bidId?: string; driverId: string; driverUserId: string; priceNgn: number };

/**
 * A driver's price on a group trip (from their bid): booked when it can be taken, once. A price that is not taken (over
 * +25%, a wallet that cannot cover it, another ask open, the driver busy) is declined, so the driver hears it. Returns
 * what happened, for the logs and the tests.
 */
export async function onTripBid(
  deps: GroupTripDeps,
  bid: Bid,
): Promise<'booked' | 'not_taken' | 'busy' | 'booking' | 'ended' | 'driver_gone' | 'seats_moved' | 'asking' | 'regrouped'> {
  const trip = await readTrip(deps.redis, bid.tripId);
  if (!trip || (await deps.redis.get(endedKey(bid.tripId)).catch(() => null))) return 'ended';
  if (await deps.redis.get(bookedKey(bid.tripId)).catch(() => null)) return 'booking';
  if (!(await drivesGroupTrips(deps.redis, bid.driverUserId))) {
    await declineBid(deps, bid.tripId, bid.driverId);
    return 'not_taken';
  }
  const priced = priceSeats(trip.seats, bid.priceNgn);
  if (!priced) {
    await declineBid(deps, bid.tripId, bid.driverId);
    return 'not_taken';
  }
  if (priced.over.length > 0) {
    const asked = await askOverSeats(deps, trip, bid, priced);
    if (asked !== 'asking') await declineBid(deps, bid.tripId, bid.driverId);
    return asked === 'asking' ? 'asking' : 'not_taken';
  }
  const booked = await bookAt(deps, trip, bid, priced.prices);
  if (booked === 'busy') await declineBid(deps, bid.tripId, bid.driverId);
  return booked;
}

/**
 * Book every seat at these prices for this driver, once. A rider whose search ended (they cancelled), a wallet short
 * or a seat gone: only those riders leave, the rest go on as a group (or alone, if one is left). If the trip's accept
 * cannot be sent after the seats are booked, the seats and their money are let go again.
 */
async function bookAt(
  deps: GroupTripDeps,
  trip: GroupTripRecord,
  bid: Bid,
  prices: Map<string, number>,
): Promise<'booked' | 'busy' | 'booking' | 'driver_gone' | 'seats_moved' | 'regrouped'> {
  if ((await claimBooking(deps.redis, bid.tripId, bid.driverId)) !== 1) return 'booking';
  let leaving: { ids: string[]; why: 'wallet_short' | 'left' } | null = null;
  try {
    const driver = await driverClient.findById(bid.driverId).catch(() => null);
    const fresh = driver?.lastSeenAt != null && Date.now() - driver.lastSeenAt.getTime() < 2 * 60_000;
    if (!driver || driver.status !== 'ONLINE' || !fresh || driver.userId !== bid.driverUserId) return 'driver_gone';
    const cancelled: string[] = [];
    for (const m of trip.seats) if (await isSearchEnded(deps.redis, m.rideId).catch(() => false)) cancelled.push(m.rideId);
    if (cancelled.length) {
      leaving = { ids: cancelled, why: 'left' };
      return 'regrouped';
    }
    const result = await groupTripClient.bookSeats({
      tripId: bid.tripId,
      driverId: bid.driverId,
      driverUserId: bid.driverUserId,
      seats: trip.seats.map((m) => ({ rideId: m.rideId, riderId: m.riderId, seatPriceNgn: prices.get(m.rideId)! })),
    });
    if (!result.ok) {
      if (result.reason === 'busy') return 'busy';
      if (result.reason === 'trip_closed') return 'seats_moved';
      const gone = result.reason === 'short' ? result.shortRideIds : [result.rideId];
      if (gone.length === 0) return 'driver_gone'; // a balance moved during the hold: the 2 min end or the next price decides
      leaving = { ids: gone, why: result.reason === 'short' ? 'wallet_short' : 'left' };
      return 'regrouped';
    }
    // The seats' prices as booked, written before anyone is told (the announcements read them).
    const before = JSON.stringify(trip);
    const booked = { ...trip, seats: trip.seats.map((m) => ({ ...m, seatPriceNgn: prices.get(m.rideId)! })) };
    await deps.redis.set(tripKey(bid.tripId), JSON.stringify(booked), KEEP_SECONDS);
    await deps.redis.set(bookedKey(bid.tripId), bid.driverId, KEEP_SECONDS);
    try {
      // Every seat is held and assigned: now the trip itself (the driver's job), through the normal accept.
      await deps.publisher.publishRideEvent(RideOfferAcceptedEvent.parse({
        eventType: 'RIDE_OFFER_ACCEPTED',
        rideId: bid.tripId,
        riderId: await groupAccountId(),
        driverId: bid.driverId,
        driverUserId: bid.driverUserId,
        ...(bid.bidId ? { bidId: bid.bidId } : {}),
        agreedFareNgn: bid.priceNgn,
        paymentMethod: 'CASH',
        timestamp: new Date().toISOString(),
      }));
    } catch (error) {
      // Not sent: nothing is booked after all (the seats and their money let go, the trip searches on).
      console.error('[group-trip] accept not sent; seats let go', { tripId: bid.tripId, error: error instanceof Error ? error.message : String(error) });
      await groupTripClient.releaseSeats(bid.tripId, bid.driverId).catch(() => []);
      await deps.redis.set(tripKey(bid.tripId), before, KEEP_SECONDS).catch(() => undefined);
      await deps.redis.del(bookedKey(bid.tripId)).catch(() => undefined);
      await dueAt(deps.redis, `end:${bid.tripId}`, Math.max(nowOf(deps), Date.parse(trip.deadline)));
      return 'driver_gone';
    }
    // A rider being asked about another driver's counter: that ask is over.
    await closeAskOf(deps, bid.tripId, 'other');
    return 'booked';
  } finally {
    await deps.redis.del(bookingKey(bid.tripId)).catch(() => undefined);
    if (leaving) await regroupWithout(deps, bid.tripId, leaving.ids, leaving.why);
  }
}

/* ── a counter over +10% for some riders: only they are asked ─────────────────────────────────────────────────────── */

const askKey = (tripId: string) => `gt:ask:${tripId}`;
const askSeatKey = (rideId: string) => `gt:askseat:${rideId}`;
const askAnswerKey = (askId: string, rideId: string) => `gt:askans:${askId}:${rideId}`;

async function readAsk(redis: RedisClient, tripId: string): Promise<CounterAsk | null> {
  const raw = await redis.get(askKey(tripId)).catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw) as CounterAsk; } catch { return null; }
}

/**
 * Ask the riders whose share of a driver's counter is over +10% (never over +25%): one ask at a time on a trip, and
 * one per driver and price (a repeat or a redelivered counter is not asked again). Only riders whose wallet covers
 * their new price are asked; otherwise the counter is not taken.
 */
async function askOverSeats(
  deps: GroupTripDeps,
  trip: GroupTripRecord,
  bid: Bid,
  priced: { prices: Map<string, number>; over: string[] },
): Promise<'asking' | 'not_taken'> {
  const asked = trip.seats.filter((m) => priced.over.includes(m.rideId));
  const wallets = await Promise.all(asked.map((m) => prisma.wallet.findUnique({ where: { userId: m.riderId }, select: { balanceNgn: true } }).catch(() => null)));
  if (asked.some((m, i) => !wallets[i] || Number(wallets[i]!.balanceNgn) < priced.prices.get(m.rideId)!)) return 'not_taken';
  if (await deps.redis.get(askKey(bid.tripId)).catch(() => null)) return 'not_taken';
  if (!(await deps.redis.setIfNotExists(`gt:asked:${bid.tripId}:${bid.driverId}:${bid.priceNgn}`, '1', KEEP_SECONDS).catch(() => false))) return 'not_taken';
  const ask: CounterAsk = {
    askId: randomUUID(),
    tripId: bid.tripId,
    bid: { ...(bid.bidId ? { bidId: bid.bidId } : {}), driverId: bid.driverId, driverUserId: bid.driverUserId, priceNgn: bid.priceNgn },
    prices: Object.fromEntries(priced.prices),
    over: priced.over,
    expiresAt: new Date(nowOf(deps) + COUNTER_ASK_SECONDS * 1000).toISOString(),
  };
  if (!(await deps.redis.setIfNotExists(askKey(bid.tripId), JSON.stringify(ask), COUNTER_ASK_SECONDS + 30).catch(() => false))) return 'not_taken';
  for (const rideId of ask.over) await deps.redis.set(askSeatKey(rideId), `${bid.tripId}:${ask.askId}`, COUNTER_ASK_SECONDS + 30).catch(() => undefined);
  await dueAt(deps.redis, `ask:${bid.tripId}:${ask.askId}`, Date.parse(ask.expiresAt) + 500);
  await tellOf(deps)?.({ kind: 'counter_ask', tripId: bid.tripId, seats: asked, ask }).catch(() => undefined);
  return 'asking';
}

/** What an asked rider sees: their seat, the price asked, until when. Null: nothing asked of this seat now. */
export async function counterAskFor(redis: RedisClient, seatRideId: string): Promise<{ askId: string; seatPriceNgn: number; askNgn: number; expiresAt: string; answer: 'yes' | null } | null> {
  const pointer = await redis.get(askSeatKey(seatRideId)).catch(() => null);
  if (!pointer) return null;
  const [tripId, askId] = pointer.split(':');
  const ask = tripId ? await readAsk(redis, tripId) : null;
  if (!ask || ask.askId !== askId || !ask.over.includes(seatRideId) || Date.parse(ask.expiresAt) <= Date.now()) return null;
  const trip = await readTrip(redis, ask.tripId);
  const seat = trip?.seats.find((m) => m.rideId === seatRideId);
  if (!seat) return null;
  const answer = (await redis.get(askAnswerKey(ask.askId, seatRideId)).catch(() => null)) === 'yes' ? 'yes' : null;
  return { askId: ask.askId, seatPriceNgn: seat.seatPriceNgn, askNgn: ask.prices[seatRideId] ?? seat.seatPriceNgn, expiresAt: ask.expiresAt, answer };
}

/**
 * An asked rider's answer, for the ask they saw (`askId`; a stale button for an earlier ask is refused). One No ends
 * the ask; a yes waits for the others ('waiting'), the last yes books ('done').
 */
export async function answerCounter(deps: GroupTripDeps, riderId: string, seatRideId: string, answer: 'yes' | 'no', askId?: string): Promise<'no' | 'waiting' | 'done'> {
  const pointer = await deps.redis.get(askSeatKey(seatRideId)).catch(() => null);
  const [tripId, liveAskId] = pointer ? pointer.split(':') : [];
  const ask = tripId ? await readAsk(deps.redis, tripId) : null;
  if (!ask || ask.askId !== liveAskId || (askId && askId !== ask.askId) || !ask.over.includes(seatRideId) || Date.parse(ask.expiresAt) <= Date.now()) {
    throw new GroupTripError('This price has ended. Still finding your driver.', 'ASK_OVER');
  }
  const trip = await readTrip(deps.redis, ask.tripId);
  if (!trip?.seats.some((m) => m.rideId === seatRideId && m.riderId === riderId)) throw new GroupTripError('This price has ended. Still finding your driver.', 'ASK_OVER');
  if (answer === 'no') {
    await resolveAsk(deps, ask.tripId, ask.askId, 'no');
    return 'no';
  }
  await deps.redis.set(askAnswerKey(ask.askId, seatRideId), 'yes', COUNTER_ASK_SECONDS + 30).catch(() => undefined);
  const answers = await Promise.all(ask.over.map((id) => deps.redis.get(askAnswerKey(ask.askId, id)).catch(() => null)));
  if (!answers.every((a) => a === 'yes')) return 'waiting';
  await resolveAsk(deps, ask.tripId, ask.askId, 'yes');
  return 'done';
}

/** The ask is over, once. Every yes books at the counter (while the driver still offers it); otherwise declined. */
async function resolveAsk(deps: GroupTripDeps, tripId: string, askId: string, outcome: 'yes' | 'no' | 'timeout'): Promise<void> {
  const ask = await readAsk(deps.redis, tripId);
  if (!ask || ask.askId !== askId) return;
  if (!(await deps.redis.setIfNotExists(`gt:askdone:${askId}`, '1', KEEP_SECONDS).catch(() => false))) return;
  const said = await saidYes(deps.redis, ask);
  await deps.redis.del(askKey(tripId)).catch(() => undefined);
  for (const rideId of ask.over) await deps.redis.del(askSeatKey(rideId)).catch(() => undefined);
  await deps.redis.send('ZREM', DUE_KEY, `ask:${tripId}:${askId}`).catch(() => undefined);
  const trip = await readTrip(deps.redis, tripId);
  const asked = trip?.seats.filter((m) => ask.over.includes(m.rideId)) ?? [];
  if (outcome === 'yes' && trip && !(await deps.redis.get(endedKey(tripId)).catch(() => null))) {
    // The driver may have taken it back or changed it in the 20 s: only the price the riders said yes to books.
    const bids = await driverBidClient.findByRide(tripId).catch(() => []);
    const live = bids.find((b) => b.driverId === ask.bid.driverId);
    const stillOffered = live && live.status === 'PENDING' && Math.round(Number(live.amountNgn)) === Math.round(ask.bid.priceNgn);
    if (stillOffered) {
      await tellOf(deps)?.({ kind: 'counter_closed', tripId, seats: asked, ask, outcome: 'yes', said }).catch(() => undefined);
      const booked = await bookAt(deps, trip, { tripId, ...ask.bid }, new Map(Object.entries(ask.prices)));
      if (booked === 'booked' || booked === 'regrouped') return;
      await declineBid(deps, tripId, ask.bid.driverId);
      return;
    }
    await tellOf(deps)?.({ kind: 'counter_closed', tripId, seats: asked, ask, outcome: 'other', said }).catch(() => undefined);
    return;
  }
  await tellOf(deps)?.({ kind: 'counter_closed', tripId, seats: asked, ask, outcome, said }).catch(() => undefined);
  await declineBid(deps, tripId, ask.bid.driverId);
}

async function saidYes(redis: RedisClient, ask: CounterAsk): Promise<string[]> {
  const answers = await Promise.all(ask.over.map((id) => redis.get(askAnswerKey(ask.askId, id)).catch(() => null)));
  return ask.over.filter((_, i) => answers[i] === 'yes');
}

/** The trip was booked another way (or ended): an ask still open is over, its riders told; the driver hears it. */
async function closeAskOf(deps: GroupTripDeps, tripId: string, outcome: 'other'): Promise<void> {
  const ask = await readAsk(deps.redis, tripId);
  if (!ask) return;
  if (!(await deps.redis.setIfNotExists(`gt:askdone:${ask.askId}`, '1', KEEP_SECONDS).catch(() => false))) return;
  const said = await saidYes(deps.redis, ask);
  await deps.redis.del(askKey(tripId)).catch(() => undefined);
  for (const rideId of ask.over) await deps.redis.del(askSeatKey(rideId)).catch(() => undefined);
  await deps.redis.send('ZREM', DUE_KEY, `ask:${tripId}:${ask.askId}`).catch(() => undefined);
  const trip = await readTrip(deps.redis, tripId);
  const asked = trip?.seats.filter((m) => ask.over.includes(m.rideId)) ?? [];
  await tellOf(deps)?.({ kind: 'counter_closed', tripId, seats: asked, ask, outcome, said }).catch(() => undefined);
  await declineBid(deps, tripId, ask.bid.driverId);
}

/* ── a group that ends, or goes on without someone ─────────────────────────────────────────────────────────────────── */

/** Their own search again, at their own price, with their yes to auto-booking back (ride-service rebuilds it). */
async function ownSearch(deps: GroupTripDeps, members: GroupSeat[]): Promise<void> {
  for (const seat of members) {
    if (seat.autoAcceptNgn) await autoAcceptOnAtStart(deps.redis, seat.rideId, seat.riderId, seat.autoAcceptNgn).catch(() => undefined);
    await deps.publisher.publishRideEvent(RideRiderCounterOfferEvent.parse({
      eventType: 'RIDE_RIDER_COUNTER_OFFER', rideId: seat.rideId, riderId: seat.riderId, counterOfferNgn: seat.offerNgn, timestamp: new Date().toISOString(),
    })).catch(() => undefined);
  }
}

/** The trip has no driver and closes: its search, its bids, every seat out of it (and out of the offer's holds). */
async function closeTrip(deps: GroupTripDeps, trip: GroupTripRecord | null, tripId: string, seatsLeaving: GroupSeat[]): Promise<void> {
  await closeAskOf(deps, tripId, 'other');
  await groupTripClient.closeUnbooked(tripId).catch(() => false);
  await deps.publisher.publishGroupRideEvent(GroupTripEndedEvent.parse({ eventType: 'GROUP_TRIP_ENDED', groupId: tripId, timestamp: new Date().toISOString() }));
  const bids = await driverBidClient.findByRide(tripId).catch(() => []);
  for (const bid of bids) if (bid.status === 'PENDING') await driverBidClient.markWithdrawn(tripId, bid.driverId).catch(() => undefined);
  // Unbooked, so a seat with a driver here was booked alone in between: it leaves the group too.
  await groupTripClient.unlinkSeats(tripId, undefined, { includeAssigned: true });
  for (const seat of trip?.seats ?? []) if ((await tripOfSeat(deps.redis, seat.rideId)) === tripId) await deps.redis.del(seatKey(seat.rideId)).catch(() => undefined);
  if (trip?.offerId) for (const seat of seatsLeaving) await releaseFormedHold(deps.redis, seat.rideId, trip.offerId).catch(() => undefined);
  await deps.redis.send('ZREM', DUE_KEY, `end:${tripId}`).catch(() => undefined);
}

/**
 * Riders leave a group that has no driver yet (a wallet short at booking, or they cancelled): the others still
 * searching keep the group and their prices (a new trip with the rest's stops in the same order, a fresh 2 minutes for
 * a driver). With one left, the group ends and their own search goes on at their own price. Once per trip; a booked
 * trip is never re-formed; while a booking is in flight it is decided after it.
 */
export async function regroupWithout(deps: GroupTripDeps, tripId: string, leavingRideIds: string[], why: 'wallet_short' | 'left'): Promise<string | null> {
  const claim = await claimEnd(deps.redis, tripId);
  if (claim === -1) {
    await dueAt(deps.redis, `regroup:${tripId}:${why}:${leavingRideIds.join(',')}`, nowOf(deps) + 3000);
    return null;
  }
  if (claim !== 1) {
    // Ended another way at this same moment (another rider leaving): a leaving rider may be in the group it re-formed.
    if (why === 'left') for (const id of leavingRideIds) await dueAt(deps.redis, `leave:${id}`, nowOf(deps) + 2000);
    return null;
  }
  const trip = await readTrip(deps.redis, tripId);
  const seats = trip?.seats ?? [];
  // Only riders still searching stay: a rider who cancelled at this same moment leaves too.
  const rows = await prisma.ride.findMany({ where: { id: { in: seats.map((m) => m.rideId) } }, select: { id: true, status: true, driverId: true } }).catch(() => []);
  const searching = new Set(rows.filter((r) => (r.status === 'REQUESTED' || r.status === 'MATCHING') && !r.driverId).map((r) => r.id));
  const stays = async (m: GroupSeat) => !leavingRideIds.includes(m.rideId) && searching.has(m.rideId) && !(await isSearchEnded(deps.redis, m.rideId).catch(() => false));
  const rest: GroupSeat[] = [];
  const leaving: GroupSeat[] = [];
  for (const m of seats) ((await stays(m)) ? rest : leaving).push(m);
  const shortOnes = why === 'wallet_short' ? leaving.filter((m) => leavingRideIds.includes(m.rideId) && searching.has(m.rideId)) : [];
  await closeTrip(deps, trip, tripId, leaving);
  // A wallet short: their own search goes on at their own price. A rider who cancelled: nothing to go on.
  if (shortOnes.length) {
    await ownSearch(deps, shortOnes);
    await tellOf(deps)?.({ kind: 'wallet_short', tripId, seats: shortOnes }).catch(() => undefined);
  }
  let newTripId: string | null = null;
  if (rest.length >= 2) {
    const stops = trip?.stops ?? (await groupStopsOf(tripId));
    newTripId = stops.length ? await startGroupTrip(deps, { stops, ...(trip?.offerId ? { offerId: trip.offerId } : {}) }, rest) : null;
  }
  const left = leaving.filter((m) => !shortOnes.includes(m));
  if (newTripId) {
    await tellOf(deps)?.({ kind: 'regrouped', tripId: newTripId, seats: rest, left: [...left, ...shortOnes] }).catch(() => undefined);
  } else if (rest.length) {
    if (trip?.offerId) for (const seat of rest) await releaseFormedHold(deps.redis, seat.rideId, trip.offerId).catch(() => undefined);
    await ownSearch(deps, rest);
    await tellOf(deps)?.({ kind: 'group_ended', tripId, seats: rest, left: [...left, ...shortOnes] }).catch(() => undefined);
  }
  return newTripId;
}

/** A trip's stops from its row (records written before the stops were kept). */
async function groupStopsOf(tripId: string): Promise<GroupLiveOffer['stops']> {
  const trip = await groupTripClient.tripOf(tripId).catch(() => null);
  const raw = Array.isArray(trip?.groupStops) ? (trip!.groupStops as Array<Record<string, unknown>>) : [];
  return raw.flatMap((s) =>
    typeof s.rideId === 'string' && (s.kind === 'pickup' || s.kind === 'dropoff') && typeof s.lat === 'number' && typeof s.lng === 'number'
      ? [{ rideId: s.rideId, kind: s.kind, lat: s.lat, lng: s.lng, address: typeof s.address === 'string' ? s.address : '' }]
      : [],
  );
}

/** A seat's rider cancelled while the group had no driver yet: the group goes on without them. */
export async function seatLeftBeforeBooking(deps: GroupTripDeps, seatRideId: string): Promise<boolean> {
  const tripId = await tripOfSeat(deps.redis, seatRideId);
  if (!tripId || (await deps.redis.get(bookedKey(tripId)).catch(() => null))) return false;
  await regroupWithout(deps, tripId, [seatRideId], 'left');
  return true;
}

/** The trip has its driver (ride-service assigned it): each seat that is this driver's is announced to its rider, once. */
export async function onTripAssigned(deps: GroupTripDeps, event: RideDriverAssignedEvent): Promise<void> {
  const trip = await readTrip(deps.redis, event.rideId);
  if (!trip) return;
  const rows = new Map((await groupTripClient.seatsOf(event.rideId).catch(() => [])).map((r) => [r.id, r]));
  for (const seat of trip.seats) {
    const row = rows.get(seat.rideId);
    if (!row || row.driverId !== event.driverId || String(row.status) !== 'DRIVER_ASSIGNED') continue;
    if (!(await deps.redis.setIfNotExists(`gt:announced:${seat.rideId}`, '1', KEEP_SECONDS).catch(() => false))) continue;
    await deps.publisher.publishRideEvent(RideDriverAssignedEvent.parse({
      ...event,
      rideId: seat.rideId,
      riderId: seat.riderId,
      agreedFareNgn: seat.seatPriceNgn,
      lockedFareNgn: seat.seatPriceNgn,
      paymentMethod: 'WALLET',
      offeredDriverUserIds: undefined,
      groupSeat: true,
      timestamp: new Date().toISOString(),
    })).catch(async (error) => {
      await deps.redis.del(`gt:announced:${seat.rideId}`).catch(() => undefined);
      throw error;
    });
  }
}

/** The trip was not assigned after all (the driver took another job in between): seats and money let go. */
export async function onTripAssignmentFailed(deps: GroupTripDeps, event: { rideId: string; driverId: string }): Promise<void> {
  const trip = await readTrip(deps.redis, event.rideId);
  if (!trip) return;
  await groupTripClient.releaseSeats(event.rideId, event.driverId);
  if ((await deps.redis.get(bookedKey(event.rideId)).catch(() => null)) === event.driverId) await deps.redis.del(bookedKey(event.rideId)).catch(() => undefined);
  // The 2 minute end comes again (now, if it already passed while this was booked).
  await dueAt(deps.redis, `end:${event.rideId}`, Math.max(nowOf(deps), Date.parse(trip.deadline) + 1000));
}

/**
 * No driver (2 min, or the trip's search timed out): the group ends, once, unless it was booked. The trip closes,
 * ride-service lets its search go, each seat leaves the group and its own search goes on at the rider's own price.
 */
export async function endUnbookedTrip(deps: GroupTripDeps, tripId: string): Promise<boolean> {
  const claim = await claimEnd(deps.redis, tripId);
  if (claim === -1) {
    await dueAt(deps.redis, `end:${tripId}`, nowOf(deps) + 3000);
    return false;
  }
  if (claim !== 1) return false;
  const trip = await readTrip(deps.redis, tripId);
  const rows = await prisma.ride.findMany({ where: { id: { in: (trip?.seats ?? []).map((m) => m.rideId) } }, select: { id: true, status: true, driverId: true } }).catch(() => []);
  const searching = new Set(rows.filter((r) => (r.status === 'REQUESTED' || r.status === 'MATCHING') && !r.driverId).map((r) => r.id));
  await closeTrip(deps, trip, tripId, trip?.seats ?? []);
  const back = (trip?.seats ?? []).filter((m) => searching.has(m.rideId));
  await ownSearch(deps, back);
  if (back.length) await tellOf(deps)?.({ kind: 'no_driver', tripId, seats: back }).catch(() => undefined);
  return true;
}

/* ── the trip (stage 4): the driver drives the TRIP; each seat moves at its own pickup and drop-off ───────────────── */

const mirrorKey = (tripId: string, kind: string) => `gt:mirror:${tripId}:${kind}`;
const finishedKey = (tripId: string) => `gt:finished:${tripId}`;

/**
 * A seat's driver arrived or started it: the TRIP follows the first time (Arrived at the first pickup, Started with
 * the first code), so the driver's app and ride-service see the job move. Once each.
 */
export async function mirrorTrip(deps: GroupTripDeps, seatRideId: string, kind: 'arrived' | 'started', driverId: string): Promise<void> {
  const tripId = await tripOfSeat(deps.redis, seatRideId);
  if (!tripId || !(await deps.redis.get(bookedKey(tripId)).catch(() => null))) return;
  if (!(await deps.redis.setIfNotExists(mirrorKey(tripId, kind), '1', KEEP_SECONDS).catch(() => false))) return;
  const trip = await readTrip(deps.redis, tripId);
  const riderId = await groupAccountId();
  const timestamp = new Date().toISOString();
  if (kind === 'arrived') {
    await deps.publisher.publishRideEvent(RideArrivedEvent.parse({ eventType: 'RIDE_ARRIVED', rideId: tripId, riderId, driverId, timestamp }));
  } else {
    await deps.publisher.publishRideEvent(RideStartedEvent.parse({
      eventType: 'RIDE_STARTED', rideId: tripId, riderId, driverId,
      lockedFareNgn: trip?.seats.reduce((s, m) => s + m.seatPriceNgn, 0) ?? 0, paymentMethod: 'CASH', startedAt: timestamp, timestamp,
    }));
  }
}

export class GroupTripError extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}

/**
 * "Continue without them" (Timi, 17 Nov 2026): at a pickup, after the 5 free minutes, a rider who has not agreed a
 * waiting price can be left; one who agreed and still has not come, after 10 more minutes (a rider cannot hold the
 * whole car for ever). Their seat is cancelled free (their money goes back) and the others keep their price. Only the
 * trip's own driver, only an arrived seat.
 */
export async function skipSeat(deps: GroupTripDeps, driverId: string, seatRideId: string, now: Date = new Date()): Promise<void> {
  const tripId = await tripOfSeat(deps.redis, seatRideId);
  if (!tripId) throw new GroupTripError('This rider is not on your group trip.', 'NOT_SEAT');
  const seat = await prisma.ride.findUnique({ where: { id: seatRideId }, select: { riderId: true, driverId: true, status: true, arrivedAt: true, waitingRateNgn: true, waitingAgreedAt: true } });
  if (!seat || seat.driverId !== driverId) throw new GroupTripError('This rider is not on your group trip.', 'NOT_SEAT');
  if (String(seat.status) !== 'ARRIVED' || !seat.arrivedAt) throw new GroupTripError('Tap Arrived at their pickup first.', 'NOT_ARRIVED');
  if (now.getTime() - seat.arrivedAt.getTime() < GROUP_RIDE_LIVE_FREE_WAIT_MS) throw new GroupTripError('Their free waiting is not over yet.', 'STILL_FREE');
  if (seat.waitingRateNgn != null) {
    const agreedAt = seat.waitingAgreedAt?.getTime() ?? now.getTime();
    if (now.getTime() - agreedAt < GROUP_SKIP_AFTER_AGREED_MS) throw new GroupTripError('They agreed to pay for waiting: wait up to 10 minutes.', 'AGREED');
  }
  if (!(await deps.redis.setIfNotExists(`gt:skip:${seatRideId}`, '1', KEEP_SECONDS).catch(() => false))) return;
  await deps.publisher.publishRideEvent(RideCancelledEvent.parse({
    eventType: 'RIDE_CANCELLED', rideId: seatRideId, riderId: seat.riderId, driverId, cancelledBy: 'system',
    reason: 'Rider did not come: the group went on', timestamp: now.toISOString(),
  }));
}

/** What the driver got for a seat (its completion), for the trip's summary. */
export async function noteSeatEarnings(redis: RedisClient, seatRideId: string, earnedNgn: number): Promise<void> {
  await redis.set(earnedKey(seatRideId), String(Math.round(earnedNgn)), KEEP_SECONDS).catch(() => undefined);
}
export async function seatEarnings(redis: RedisClient, seatRideId: string): Promise<number | null> {
  const raw = await redis.get(earnedKey(seatRideId)).catch(() => null);
  return raw === null ? null : Number(raw);
}

/**
 * A seat is done (dropped off, or cancelled): when every seat is, the trip ends, once. The driver is freed in
 * ride-service and told (`ride:group_done`, with what they earned). Returns true when this call ended it.
 * `completed`: this seat was dropped off (its row may not say so yet).
 */
export async function seatFinished(
  deps: GroupTripDeps & { tellDriver?: (driverUserId: string, payload: Record<string, unknown>) => Promise<void> },
  seatRideId: string,
  opts: { completed?: boolean } = {},
): Promise<boolean> {
  const tripId = await tripOfSeat(deps.redis, seatRideId);
  if (!tripId) return false;
  // This seat is done, marked before anything is read: its row may not say so yet (ride-service writes a cancel from
  // the same event, at the same moment). Two seats finishing together: whichever reads second sees both marks.
  await deps.redis.set(seatDoneKey(seatRideId), opts.completed ? 'completed' : '1', KEEP_SECONDS).catch(() => undefined);
  const seats = await groupTripClient.seatsOf(tripId);
  const marks = await Promise.all(seats.map((s) => deps.redis.get(seatDoneKey(s.id)).catch(() => null)));
  const done = seats.map((s, i) => String(s.status) === 'COMPLETED' || String(s.status) === 'CANCELLED' || marks[i] !== null);
  if (!done.every(Boolean)) return false;
  if (!(await deps.redis.setIfNotExists(finishedKey(tripId), '1', KEEP_SECONDS).catch(() => false))) return false;
  const dropped = seats.filter((s, i) => String(s.status) === 'COMPLETED' || marks[i] === 'completed');
  await groupTripClient.endTrip(tripId, new Date(), dropped.length ? 'COMPLETED' : 'CANCELLED');
  await deps.publisher.publishGroupRideEvent(GroupTripEndedEvent.parse({ eventType: 'GROUP_TRIP_ENDED', groupId: tripId, timestamp: new Date().toISOString() }));
  const trip = await prisma.ride.findUnique({ where: { id: tripId }, select: { driver: { select: { userId: true } } } }).catch(() => null);
  const fares = dropped.reduce((sum, s) => sum + Number(s.agreedFareNgn ?? 0), 0);
  const earnings = await Promise.all(dropped.map((s) => seatEarnings(deps.redis, s.id)));
  const earnedNgn = earnings.every((e) => e !== null) ? earnings.reduce((sum: number, e) => sum + (e ?? 0), 0) : null;
  if (trip?.driver?.userId && deps.tellDriver) {
    await deps.tellDriver(trip.driver.userId, { tripId, ridersDropped: dropped.length, faresNgn: fares, ...(earnedNgn !== null ? { earnedNgn } : {}) }).catch(() => undefined);
  }
  return true;
}

/**
 * The driver cancels a group trip. With nobody in the car: they leave (a rider already dropped off keeps their
 * finished ride), the trip ends once (the same mark as every seat done), and each waiting seat is cancelled by the
 * driver the way any driver backing out is (ride-service reopens it without them, the money goes back, the rider is
 * told and searches on at their own price). With a rider in the car: refused (drop them first).
 */
export async function leaveTrip(deps: GroupTripDeps, driver: { driverId: string; driverUserId: string }, tripId: string): Promise<void> {
  const { driverId, driverUserId } = driver;
  const trip = await groupTripClient.tripOf(tripId);
  if (!trip || trip.driverId !== driverId) throw new GroupTripError('This ride is not assigned to you.', 'NOT_TRIP');
  const seats = await groupTripClient.seatsOf(tripId);
  if (seats.some((s) => String(s.status) === 'IN_PROGRESS')) throw new GroupTripError('A rider is in the car. Drop them first.', 'RIDING');
  if (!(await deps.redis.setIfNotExists(finishedKey(tripId), '1', KEEP_SECONDS).catch(() => false))) return;
  const unlinked = await groupTripClient.unlinkForLeave(tripId, driverId);
  const anyDropped = seats.some((s) => String(s.status) === 'COMPLETED');
  await groupTripClient.endTrip(tripId, new Date(), anyDropped ? 'COMPLETED' : 'CANCELLED', 'driver');
  await deps.publisher.publishGroupRideEvent(GroupTripEndedEvent.parse({ eventType: 'GROUP_TRIP_ENDED', groupId: tripId, timestamp: new Date().toISOString() }));
  for (const seat of unlinked) {
    // Out of the group first: the cancel below is a plain driver cancel to everyone who reads it.
    await deps.redis.del(seatKey(seat.id)).catch(() => undefined);
    // A rider who cancelled at this same moment is not told their driver left (nor searched again).
    const cancelledMeanwhile = await deps.redis.get(seatDoneKey(seat.id)).catch(() => null);
    // No more of this trip's car on their screen.
    await deps.redis.set(seatDoneKey(seat.id), '1', KEEP_SECONDS).catch(() => undefined);
    if (cancelledMeanwhile) continue;
    const event = RideCancelledEvent.parse({
      eventType: 'RIDE_CANCELLED', rideId: seat.id, riderId: seat.riderId, driverId, driverUserId, cancelledBy: 'driver',
      reason: 'The driver left the group', timestamp: new Date().toISOString(),
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await deps.publisher.publishRideEvent(event);
        break;
      } catch (error) {
        if (attempt === 2) console.error('[group-trip] seat cancel not sent after the driver left', { tripId, rideId: seat.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}

export interface RiderGroupView {
  /** The other riders still on the trip, first names. */
  others: string[];
  /** Every stop in order (riders who left are gone from it): theirs marked, others' by area only. */
  stops: Array<{ kind: 'pickup' | 'dropoff'; name: string; area: string; yours: boolean; done: boolean }>;
}

/**
 * A rider's own seat of a booked group trip, as they see it on their trip (Timi, plan step 8: the stops, theirs in
 * orange). Other riders by first name and the area of their stops only, never the address. Null: not a seat.
 */
export async function riderGroupView(redis: RedisClient, seatRideId: string): Promise<RiderGroupView | null> {
  const tripId = await tripOfSeat(redis, seatRideId);
  if (!tripId) return null;
  const [trip, seats] = await Promise.all([groupTripClient.tripOf(tripId), groupTripClient.seatsOf(tripId)]);
  if (!trip || !seats.some((s) => s.id === seatRideId)) return null;
  const users = await prisma.user.findMany({ where: { id: { in: seats.map((s) => s.riderId) } }, select: { id: true, name: true } }).catch(() => []);
  const first = new Map(users.map((u) => [u.id, firstNameOf(u.name)]));
  const byId = new Map(seats.map((s) => [s.id, s]));
  const raw = Array.isArray(trip.groupStops) ? (trip.groupStops as Array<{ rideId?: unknown; kind?: unknown; address?: unknown; lat?: unknown; lng?: unknown }>) : [];
  const stops: RiderGroupView['stops'] = [];
  for (const stop of raw) {
    const seat = typeof stop.rideId === 'string' ? byId.get(stop.rideId) : undefined;
    if (!seat || (stop.kind !== 'pickup' && stop.kind !== 'dropoff')) continue;
    const status = String(seat.status);
    if (status === 'CANCELLED') continue;
    const yours = seat.id === seatRideId;
    const address = typeof stop.address === 'string' ? stop.address : '';
    stops.push({
      kind: stop.kind,
      name: yours ? 'You' : first.get(seat.riderId) ?? 'Rider',
      // Yours as you know it (the first part); the others' as an area only.
      area: yours ? address.split(',')[0]?.trim() || address : areaOf(address, typeof stop.lat === 'number' ? stop.lat : undefined, typeof stop.lng === 'number' ? stop.lng : undefined),
      yours,
      done: status === 'COMPLETED' || (stop.kind === 'pickup' && status === 'IN_PROGRESS'),
    });
  }
  const others = seats.filter((s) => s.id !== seatRideId && String(s.status) !== 'CANCELLED').map((s) => first.get(s.riderId) ?? 'Rider');
  return { others, stops };
}

/* ── a one-time note for the ride page and the app (each shows it once) ─────────────────────────────────────────── */

const noteKey = (rideId: string) => `gt:note:${rideId}`;
export async function setGroupNote(redis: RedisClient, rideId: string, text: string): Promise<{ id: string; text: string }> {
  const note = { id: randomUUID(), text };
  await redis.set(noteKey(rideId), JSON.stringify(note), 120);
  return note;
}
export async function groupNoteFor(redis: RedisClient, rideId: string): Promise<{ id: string; text: string } | null> {
  const raw = await redis.get(noteKey(rideId)).catch(() => null);
  if (!raw) return null;
  try {
    const note = JSON.parse(raw) as { id?: unknown; text?: unknown };
    return typeof note.id === 'string' && typeof note.text === 'string' ? { id: note.id, text: note.text } : null;
  } catch { return null; }
}

/**
 * A seat's group while it looks for a driver, as its rider sees it: the seat, the others now (after anyone left), and
 * the rider's own price. Null: not in a group trip.
 */
export async function formedSeatView(redis: RedisClient, seatRideId: string): Promise<{ seatPriceNgn: number; others: string[]; ownPriceNgn: number } | null> {
  const tripId = await tripOfSeat(redis, seatRideId);
  const trip = tripId ? await readTrip(redis, tripId) : null;
  const me = trip?.seats.find((m) => m.rideId === seatRideId);
  if (!trip || !me) return null;
  const others = trip.seats.filter((m) => m.rideId !== seatRideId);
  const users = await prisma.user.findMany({ where: { id: { in: others.map((m) => m.riderId) } }, select: { id: true, name: true } }).catch(() => []);
  const first = new Map(users.map((u) => [u.id, firstNameOf(u.name)]));
  return { seatPriceNgn: me.seatPriceNgn, others: others.map((m) => first.get(m.riderId) ?? 'Rider'), ownPriceNgn: me.offerNgn };
}
