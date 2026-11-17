import { randomUUID } from 'node:crypto';
import { calculateSuggestedFare, GROUP_RIDE_LIVE } from '@wheleers/config';
import { driverBidClient, driverClient, groupTripClient, prisma } from '@wheleers/db';
import { RideArrivedEvent, RideBidsDeclinedEvent, RideCancelledEvent, RideDriverAssignedEvent, RideOfferAcceptedEvent, RideRequestedEvent, RideRiderCounterOfferEvent, RideStartedEvent, GroupTripEndedEvent, GroupTripFormedEvent } from '@wheleers/kafka-schemas';
import type { RedisClient } from '../redis/client';
import type { GatewayPublisher } from '../websocket/publisher';
import { autoAcceptOffForChatPrice } from './auto-accept';
import type { GroupLiveMember, GroupLiveOffer } from './group-live';

/**
 * Group ride, the booking (Timi, 17 Nov 2026). A formed group becomes a group trip: a TRIP ride (owned by the Wheelers
 * group account, never shown to a rider) that drivers see as one normal request (the first pickup, the stops, the
 * total), and the riders' own rides as its SEATS (each keeps its price, hold, code, waiting and receipt).
 *
 *   start     the seats are linked (all or none), their own driver offers end, auto-booking is off, ride-service stops
 *             their searches (GROUP_TRIP_FORMED) and the trip's search starts (RIDE_REQUESTED with groupTrip)
 *   a bid     at or under the total, or a counter whose share is within +10% of every seat: booked, once — every seat
 *             held from its own wallet and assigned in one transaction, then the trip's accept goes out
 *   assigned  the trip has its driver: each seat is announced to its rider (RIDE_DRIVER_ASSIGNED, groupSeat)
 *   failed    the driver took another job in between: the seats and their money are let go, the next bid is tried
 *   2 min     no driver: the group ends and every rider's own search goes on at their own price
 */

export interface GroupTripDeps {
  redis: RedisClient;
  publisher: Pick<GatewayPublisher, 'publishRideEvent' | 'publishGroupRideEvent'>;
  /** Tell the riders (rides/group-live.ts's hook does it for the offer; this one for the trip). */
  tell?: (change: GroupTripChange) => Promise<void>;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => void;
}

let tripHook: ((change: GroupTripChange) => Promise<void>) | null = null;
/** The gateway's consumer tells riders (socket, page, chat); set once at start, used when a caller has no `tell`. */
export function setGroupTripHook(hook: ((change: GroupTripChange) => Promise<void>) | null): void {
  tripHook = hook;
}
const tellOf = (deps: GroupTripDeps) => deps.tell ?? tripHook;
const laterOf = (deps: GroupTripDeps) => deps.schedule ?? ((fn: () => void, ms: number) => { setTimeout(fn, ms).unref(); });

export type GroupTripChange =
  /** No driver in time: every rider's own search goes on. */
  | { kind: 'no_driver'; tripId: string; seats: GroupLiveMember[] }
  /** These riders' wallets could not cover their seats at booking: the group went on without them. */
  | { kind: 'wallet_short'; tripId: string; seats: GroupLiveMember[] }
  /** The others left and these riders are on their own again (their own search goes on). */
  | { kind: 'group_ended'; tripId: string; seats: GroupLiveMember[]; left: GroupLiveMember[] }
  /** The group goes on without the riders who left (a new trip, the same seats and prices). */
  | { kind: 'regrouped'; tripId: string; seats: GroupLiveMember[]; left: GroupLiveMember[] }
  /** A driver's counter is over +10% of these riders' seats: each is asked (COUNTER_ASK_SECONDS). */
  | { kind: 'counter_ask'; tripId: string; seats: GroupLiveMember[]; ask: CounterAsk }
  /** That ask is over (a yes from all, a no, silence, or the group booked another way). */
  | { kind: 'counter_closed'; tripId: string; seats: GroupLiveMember[]; ask: CounterAsk; outcome: 'yes' | 'no' };

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
  seats: GroupLiveMember[];
  totalNgn: number;
  createdAt: string;
  /** No driver by then: the group ends. */
  deadline: string;
  /** The stops in order (a group re-formed without someone keeps the rest's order). Absent on older records. */
  stops?: GroupLiveOffer['stops'];
}

/** How long the group waits for a driver before every rider goes back to their own search. */
export const GROUP_TRIP_SEARCH_SECONDS = 2 * 60;
/** A counter is taken without asking when each rider's share of it is within this of their seat. */
export const COUNTER_AUTO_SHARE = 0.10;
/** Over that, only the riders whose share is over are asked, up to this; more is never taken (Timi, 16 Nov). */
export const COUNTER_ASK_MAX_SHARE = 0.25;
/** How long an asked rider has to answer; silence is No. */
export const COUNTER_ASK_SECONDS = 20;

const tripKey = (tripId: string) => `gt:trip:${tripId}`;
const seatKey = (rideId: string) => `gt:seat:${rideId}`;
const bookingKey = (tripId: string) => `gt:booking:${tripId}`;
const bookedKey = (tripId: string) => `gt:booked:${tripId}`;
const endedKey = (tripId: string) => `gt:ended:${tripId}`;
const KEEP_SECONDS = 6 * 60 * 60;

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

export async function readTrip(redis: RedisClient, tripId: string): Promise<GroupTripRecord | null> {
  const raw = await redis.get(tripKey(tripId)).catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw) as GroupTripRecord; } catch { return null; }
}

/** The group trip a ride is a seat of (while it lasts), or null. */
export async function tripOfSeat(redis: RedisClient, rideId: string): Promise<string | null> {
  return redis.get(seatKey(rideId)).catch(() => null);
}

const kmBetween = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(toRad(b.lat - a.lat) / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(toRad(b.lng - a.lng) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

/**
 * A group the riders agreed to: the trip starts. Returns the trip id, or null when it could not (a seat moved on in
 * between: every rider's search simply goes on).
 */
export async function startGroupTrip(deps: GroupTripDeps, offer: Pick<GroupLiveOffer, 'stops'>, joined: GroupLiveMember[]): Promise<string | null> {
  const now = deps.now ?? Date.now;
  const tripId = randomUUID();
  const seatIds = joined.map((m) => m.rideId);
  if (!(await groupTripClient.linkSeats(tripId, seatIds))) return null;

  // Their own searches end here: the drivers who offered are told, and nothing books a seat alone.
  for (const seat of joined) {
    await autoAcceptOffForChatPrice(deps.redis, seat.rideId).catch(() => undefined);
    const bids = await driverBidClient.findByRide(seat.rideId).catch(() => []);
    for (const bid of bids) if (bid.status === 'PENDING') await driverBidClient.markWithdrawn(seat.rideId, bid.driverId).catch(() => undefined);
    await deps.redis.set(seatKey(seat.rideId), tripId, KEEP_SECONDS).catch(() => undefined);
  }
  await deps.publisher.publishGroupRideEvent(GroupTripFormedEvent.parse({ eventType: 'GROUP_TRIP_FORMED', groupId: tripId, seatRideIds: seatIds, timestamp: new Date(now()).toISOString() }));

  // The trip: the joined riders' stops in the planned order, the total of their seats.
  const stops = offer.stops.filter((s) => seatIds.includes(s.rideId));
  const totalNgn = joined.reduce((sum, m) => sum + m.seatPriceNgn, 0);
  let km = 0;
  for (let i = 1; i < stops.length; i += 1) km += kmBetween(stops[i - 1]!, stops[i]!) * GROUP_RIDE_LIVE.ROAD_FACTOR;
  const fare = calculateSuggestedFare(km);
  const first = stops[0]!;
  const last = stops[stops.length - 1]!;
  const at = now();
  const record: GroupTripRecord = {
    tripId,
    seats: joined,
    totalNgn,
    createdAt: new Date(at).toISOString(),
    deadline: new Date(at + GROUP_TRIP_SEARCH_SECONDS * 1000).toISOString(),
    stops,
  };
  await deps.redis.set(tripKey(tripId), JSON.stringify(record), KEEP_SECONDS);
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
  const schedule = deps.schedule ?? ((fn, ms) => { setTimeout(fn, ms).unref(); });
  schedule(() => void endUnbookedTrip(deps, tripId).catch(() => undefined), GROUP_TRIP_SEARCH_SECONDS * 1000 + 1000);
  return tripId;
}

/**
 * The seat prices for a driver's price on the trip: at or under the total, each seat as agreed; above it, the extra
 * shared by each rider's own fare. `over`: the seats whose share is more than +10% (their riders are asked). Null when
 * any share is more than +25% (never taken).
 */
export function priceSeats(
  seats: Array<{ rideId: string; offerNgn: number; seatPriceNgn: number }>,
  driverPriceNgn: number,
): { prices: Map<string, number>; over: string[] } | null {
  const total = seats.reduce((s, m) => s + m.seatPriceNgn, 0);
  if (driverPriceNgn <= total) return { prices: new Map(seats.map((m) => [m.rideId, m.seatPriceNgn])), over: [] };
  const extra = driverPriceNgn - total;
  const weights = seats.reduce((s, m) => s + m.offerNgn, 0);
  const prices = new Map<string, number>();
  let given = 0;
  seats.forEach((m, i) => {
    // The last seat takes what rounding left, so the seats add up to the driver's price exactly.
    const share = i === seats.length - 1 ? extra - given : Math.round((extra * m.offerNgn) / weights / 50) * 50;
    given += share;
    prices.set(m.rideId, m.seatPriceNgn + share);
  });
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

/**
 * A driver's price on a group trip (from their bid): booked when it can be taken, once. Returns what happened, for
 * the logs and the tests.
 */
export async function onTripBid(
  deps: GroupTripDeps,
  bid: { tripId: string; bidId?: string; driverId: string; driverUserId: string; priceNgn: number },
): Promise<'booked' | 'not_taken' | 'busy' | 'booking' | 'ended' | 'driver_gone' | 'seats_moved' | 'asking' | 'regrouped'> {
  const trip = await readTrip(deps.redis, bid.tripId);
  if (!trip || (await deps.redis.get(endedKey(bid.tripId)).catch(() => null))) return 'ended';
  if (await deps.redis.get(bookedKey(bid.tripId)).catch(() => null)) return 'booking';
  const priced = priceSeats(trip.seats, bid.priceNgn);
  if (!priced) return 'not_taken';
  if (priced.over.length > 0) return askOverSeats(deps, trip, bid, priced);
  return bookAt(deps, trip, bid, priced.prices);
}

/** Book every seat at these prices for this driver, once; a short wallet or a seat gone drops only those riders. */
async function bookAt(
  deps: GroupTripDeps,
  trip: GroupTripRecord,
  bid: { tripId: string; bidId?: string; driverId: string; driverUserId: string; priceNgn: number },
  prices: Map<string, number>,
): Promise<'booked' | 'busy' | 'booking' | 'driver_gone' | 'seats_moved' | 'regrouped'> {
  // One booking at a time on the trip.
  if (!(await deps.redis.setIfNotExists(bookingKey(bid.tripId), bid.driverId, 30).catch(() => false))) return 'booking';
  try {
    if (await deps.redis.get(bookedKey(bid.tripId)).catch(() => null)) return 'booking';
    const driver = await driverClient.findById(bid.driverId).catch(() => null);
    const fresh = driver?.lastSeenAt != null && Date.now() - driver.lastSeenAt.getTime() < 2 * 60_000;
    if (!driver || driver.status !== 'ONLINE' || !fresh || driver.userId !== bid.driverUserId) return 'driver_gone';
    const result = await groupTripClient.bookSeats({
      tripId: bid.tripId,
      driverId: bid.driverId,
      driverUserId: bid.driverUserId,
      seats: trip.seats.map((m) => ({ rideId: m.rideId, riderId: m.riderId, seatPriceNgn: prices.get(m.rideId)! })),
    });
    if (!result.ok) {
      if (result.reason === 'busy') return 'busy';
      // A wallet short or a seat gone: only those riders leave; the rest go on as a group (or alone, if one is left).
      const gone = result.reason === 'short' ? result.shortRideIds : [result.rideId];
      if (gone.length === 0) {
        await endUnbookedTrip(deps, bid.tripId);
        return 'seats_moved';
      }
      await deps.redis.del(bookingKey(bid.tripId)).catch(() => undefined);
      await regroupWithout(deps, bid.tripId, gone, result.reason === 'short' ? 'wallet_short' : 'left');
      return 'regrouped';
    }
    await deps.redis.set(bookedKey(bid.tripId), bid.driverId, KEEP_SECONDS);
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
    // The seats' prices as booked (a counter moved them), for the announcements.
    trip.seats = trip.seats.map((m) => ({ ...m, seatPriceNgn: prices.get(m.rideId)! }));
    await deps.redis.set(tripKey(bid.tripId), JSON.stringify(trip), KEEP_SECONDS);
    // A rider being asked about another driver's counter: that ask is over.
    await closeAskOf(deps, bid.tripId, 'no');
    return 'booked';
  } finally {
    await deps.redis.del(bookingKey(bid.tripId)).catch(() => undefined);
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
 * Ask the riders whose share of a driver's counter is over +10% (never over +25%), one ask at a time on a trip.
 * Only riders whose wallet covers their new price are asked; otherwise the counter is not taken.
 */
async function askOverSeats(
  deps: GroupTripDeps,
  trip: GroupTripRecord,
  bid: { tripId: string; bidId?: string; driverId: string; driverUserId: string; priceNgn: number },
  priced: { prices: Map<string, number>; over: string[] },
): Promise<'asking' | 'not_taken' | 'booking'> {
  const asked = trip.seats.filter((m) => priced.over.includes(m.rideId));
  const wallets = await Promise.all(asked.map((m) => prisma.wallet.findUnique({ where: { userId: m.riderId }, select: { balanceNgn: true } }).catch(() => null)));
  if (asked.some((m, i) => !wallets[i] || Number(wallets[i]!.balanceNgn) < priced.prices.get(m.rideId)!)) return 'not_taken';
  const now = deps.now ?? Date.now;
  const ask: CounterAsk = {
    askId: randomUUID(),
    tripId: bid.tripId,
    bid: { ...(bid.bidId ? { bidId: bid.bidId } : {}), driverId: bid.driverId, driverUserId: bid.driverUserId, priceNgn: bid.priceNgn },
    prices: Object.fromEntries(priced.prices),
    over: priced.over,
    expiresAt: new Date(now() + COUNTER_ASK_SECONDS * 1000).toISOString(),
  };
  if (!(await deps.redis.setIfNotExists(askKey(bid.tripId), JSON.stringify(ask), COUNTER_ASK_SECONDS + 10).catch(() => false))) return 'booking';
  for (const rideId of ask.over) await deps.redis.set(askSeatKey(rideId), `${bid.tripId}:${ask.askId}`, COUNTER_ASK_SECONDS + 10).catch(() => undefined);
  await tellOf(deps)?.({ kind: 'counter_ask', tripId: bid.tripId, seats: asked, ask }).catch(() => undefined);
  const schedule = deps.schedule ?? ((fn, ms) => { setTimeout(fn, ms).unref(); });
  schedule(() => void resolveAsk(deps, bid.tripId, ask.askId, 'no').catch(() => undefined), COUNTER_ASK_SECONDS * 1000 + 500);
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

/** An asked rider's answer. Yes from every asked rider books at the counter; one No ends the ask. */
export async function answerCounter(deps: GroupTripDeps, riderId: string, seatRideId: string, answer: 'yes' | 'no'): Promise<'yes' | 'no'> {
  const pointer = await deps.redis.get(askSeatKey(seatRideId)).catch(() => null);
  const [tripId, askId] = pointer ? pointer.split(':') : [];
  const ask = tripId ? await readAsk(deps.redis, tripId) : null;
  if (!ask || ask.askId !== askId || !ask.over.includes(seatRideId) || Date.parse(ask.expiresAt) <= Date.now()) {
    throw new GroupTripError('This price has ended.', 'ASK_OVER');
  }
  const trip = await readTrip(deps.redis, ask.tripId);
  if (!trip?.seats.some((m) => m.rideId === seatRideId && m.riderId === riderId)) throw new GroupTripError('This price has ended.', 'ASK_OVER');
  if (answer === 'no') {
    await resolveAsk(deps, ask.tripId, ask.askId, 'no');
    return 'no';
  }
  await deps.redis.set(askAnswerKey(ask.askId, seatRideId), 'yes', COUNTER_ASK_SECONDS + 10).catch(() => undefined);
  const answers = await Promise.all(ask.over.map((id) => deps.redis.get(askAnswerKey(ask.askId, id)).catch(() => null)));
  if (answers.every((a) => a === 'yes')) await resolveAsk(deps, ask.tripId, ask.askId, 'yes');
  return 'yes';
}

/** The ask is over, once: every yes books at the counter; otherwise the driver hears their price was declined. */
async function resolveAsk(deps: GroupTripDeps, tripId: string, askId: string, outcome: 'yes' | 'no'): Promise<void> {
  const ask = await readAsk(deps.redis, tripId);
  if (!ask || ask.askId !== askId) return;
  if (!(await deps.redis.setIfNotExists(`gt:askdone:${askId}`, '1', KEEP_SECONDS).catch(() => false))) return;
  await deps.redis.del(askKey(tripId)).catch(() => undefined);
  for (const rideId of ask.over) await deps.redis.del(askSeatKey(rideId)).catch(() => undefined);
  const trip = await readTrip(deps.redis, tripId);
  const asked = trip?.seats.filter((m) => ask.over.includes(m.rideId)) ?? [];
  await tellOf(deps)?.({ kind: 'counter_closed', tripId, seats: asked, ask, outcome }).catch(() => undefined);
  if (outcome === 'yes' && trip && !(await deps.redis.get(endedKey(tripId)).catch(() => null))) {
    const booked = await bookAt(deps, trip, { tripId, ...ask.bid }, new Map(Object.entries(ask.prices)));
    if (booked === 'booked' || booked === 'regrouped') return;
  }
  // Not taken: the driver hears it (Offer declined) and may send another price.
  const declined = await driverBidClient.declineOne(tripId, ask.bid.driverId).catch(() => null);
  if (declined) {
    await deps.publisher.publishRideEvent(RideBidsDeclinedEvent.parse({
      eventType: 'RIDE_BIDS_DECLINED', rideId: tripId, riderId: await groupAccountId(), driverUserIds: [declined.driverUserId], remainingOffers: 0, timestamp: new Date().toISOString(),
    })).catch(() => undefined);
  }
}

/** The trip was booked another way (or ended): an ask still open is over, its riders told. */
async function closeAskOf(deps: GroupTripDeps, tripId: string, outcome: 'yes' | 'no'): Promise<void> {
  const ask = await readAsk(deps.redis, tripId);
  if (!ask) return;
  if (!(await deps.redis.setIfNotExists(`gt:askdone:${ask.askId}`, '1', KEEP_SECONDS).catch(() => false))) return;
  await deps.redis.del(askKey(tripId)).catch(() => undefined);
  for (const rideId of ask.over) await deps.redis.del(askSeatKey(rideId)).catch(() => undefined);
  const trip = await readTrip(deps.redis, tripId);
  const asked = trip?.seats.filter((m) => ask.over.includes(m.rideId)) ?? [];
  await tellOf(deps)?.({ kind: 'counter_closed', tripId, seats: asked, ask, outcome }).catch(() => undefined);
}

/* ── a rider leaves before the booking: the group goes on without them ────────────────────────────────────────────── */

/**
 * Riders leave a group that has no driver yet (a wallet short at booking, or they cancelled): the others keep the group
 * and their prices (a new trip with the rest's stops in the same order, a fresh 2 minutes for a driver). With one left,
 * the group ends and their own search goes on at their own price. Once per trip; a booked trip is never re-formed.
 */
export async function regroupWithout(deps: GroupTripDeps, tripId: string, leavingRideIds: string[], why: 'wallet_short' | 'left'): Promise<string | null> {
  if (await deps.redis.get(bookedKey(tripId)).catch(() => null)) return null;
  // A booking in flight: decided after it (booked, the rider who left is a seat like any other; not, this runs then).
  if (await deps.redis.get(bookingKey(tripId)).catch(() => null)) {
    laterOf(deps)(() => void regroupWithout(deps, tripId, leavingRideIds, why).catch(() => undefined), 3000);
    return null;
  }
  if (!(await deps.redis.setIfNotExists(endedKey(tripId), '1', KEEP_SECONDS).catch(() => false))) return null;
  const trip = await readTrip(deps.redis, tripId);
  await closeAskOf(deps, tripId, 'no');
  await groupTripClient.closeUnbooked(tripId).catch(() => false);
  await deps.publisher.publishGroupRideEvent(GroupTripEndedEvent.parse({ eventType: 'GROUP_TRIP_ENDED', groupId: tripId, timestamp: new Date().toISOString() }));
  const bids = await driverBidClient.findByRide(tripId).catch(() => []);
  for (const bid of bids) if (bid.status === 'PENDING') await driverBidClient.markWithdrawn(tripId, bid.driverId).catch(() => undefined);
  await groupTripClient.unlinkSeats(tripId);
  const seats = trip?.seats ?? [];
  for (const seat of seats) await deps.redis.del(seatKey(seat.rideId)).catch(() => undefined);
  const leaving = seats.filter((m) => leavingRideIds.includes(m.rideId));
  const rest = seats.filter((m) => !leavingRideIds.includes(m.rideId));
  const ownSearch = async (members: GroupLiveMember[]) => {
    for (const seat of members) {
      await deps.publisher.publishRideEvent(RideRiderCounterOfferEvent.parse({
        eventType: 'RIDE_RIDER_COUNTER_OFFER', rideId: seat.rideId, riderId: seat.riderId, counterOfferNgn: seat.offerNgn, timestamp: new Date().toISOString(),
      })).catch(() => undefined);
    }
  };
  // A wallet short: their own search goes on at their own price. A rider who cancelled: nothing to go on.
  if (why === 'wallet_short') {
    await ownSearch(leaving);
    if (leaving.length) await tellOf(deps)?.({ kind: 'wallet_short', tripId, seats: leaving }).catch(() => undefined);
  }
  let newTripId: string | null = null;
  if (rest.length >= 2) {
    const stops = trip?.stops ?? (await groupStopsOf(tripId));
    newTripId = stops.length ? await startGroupTrip(deps, { stops }, rest).catch(() => null) : null;
  }
  if (newTripId) {
    await tellOf(deps)?.({ kind: 'regrouped', tripId: newTripId, seats: rest, left: leaving }).catch(() => undefined);
  } else if (rest.length) {
    await ownSearch(rest);
    await tellOf(deps)?.({ kind: 'group_ended', tripId, seats: rest, left: leaving }).catch(() => undefined);
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

/** The trip has its driver (ride-service assigned it): each seat is announced to its rider, once. */
export async function onTripAssigned(deps: GroupTripDeps, event: RideDriverAssignedEvent): Promise<void> {
  const trip = await readTrip(deps.redis, event.rideId);
  if (!trip) return;
  if (!(await deps.redis.setIfNotExists(`gt:announced:${event.rideId}`, '1', KEEP_SECONDS).catch(() => false))) return;
  for (const seat of trip.seats) {
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
    }));
  }
}

/** The trip was not assigned after all (the driver took another job in between): seats and money let go. */
export async function onTripAssignmentFailed(deps: GroupTripDeps, event: { rideId: string; driverId: string }): Promise<void> {
  const trip = await readTrip(deps.redis, event.rideId);
  if (!trip) return;
  await groupTripClient.releaseSeats(event.rideId, event.driverId);
  if ((await deps.redis.get(bookedKey(event.rideId)).catch(() => null)) === event.driverId) await deps.redis.del(bookedKey(event.rideId)).catch(() => undefined);
}

/**
 * No driver (2 min, or a seat gone): the group ends, once, unless it was booked. The trip closes, ride-service lets
 * its search go, each seat leaves the group and its own search goes on at the rider's own price.
 */
export async function endUnbookedTrip(deps: GroupTripDeps, tripId: string): Promise<boolean> {
  if (await deps.redis.get(bookedKey(tripId)).catch(() => null)) return false;
  // A booking in flight: decided after it.
  if (await deps.redis.get(bookingKey(tripId)).catch(() => null)) {
    laterOf(deps)(() => void endUnbookedTrip(deps, tripId).catch(() => undefined), 3000);
    return false;
  }
  if (!(await deps.redis.setIfNotExists(endedKey(tripId), '1', KEEP_SECONDS).catch(() => false))) return false;
  const trip = await readTrip(deps.redis, tripId);
  await closeAskOf(deps, tripId, 'no');
  await groupTripClient.closeUnbooked(tripId).catch(() => false);
  await deps.publisher.publishGroupRideEvent(GroupTripEndedEvent.parse({ eventType: 'GROUP_TRIP_ENDED', groupId: tripId, timestamp: new Date().toISOString() }));
  const bids = await driverBidClient.findByRide(tripId).catch(() => []);
  for (const bid of bids) if (bid.status === 'PENDING') await driverBidClient.markWithdrawn(tripId, bid.driverId).catch(() => undefined);
  await groupTripClient.unlinkSeats(tripId);
  for (const seat of trip?.seats ?? []) {
    await deps.redis.del(seatKey(seat.rideId)).catch(() => undefined);
    // Their own search again, at their own price (ride-service rebuilds it and restarts its clock).
    await deps.publisher.publishRideEvent(RideRiderCounterOfferEvent.parse({
      eventType: 'RIDE_RIDER_COUNTER_OFFER', rideId: seat.rideId, riderId: seat.riderId, counterOfferNgn: seat.offerNgn, timestamp: new Date().toISOString(),
    })).catch(() => undefined);
  }
  if (trip) await tellOf(deps)?.({ kind: 'no_driver', tripId, seats: trip.seats }).catch(() => undefined);
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
 * waiting price can be left; their seat is cancelled free (their money goes back) and the others keep their price.
 * Only the trip's own driver, only an arrived seat.
 */
export async function skipSeat(deps: GroupTripDeps, driverId: string, seatRideId: string, now: Date = new Date()): Promise<void> {
  const tripId = await tripOfSeat(deps.redis, seatRideId);
  if (!tripId) throw new GroupTripError('This rider is not on your group trip.', 'NOT_SEAT');
  const seat = await prisma.ride.findUnique({ where: { id: seatRideId }, select: { riderId: true, driverId: true, status: true, arrivedAt: true, waitingRateNgn: true } });
  if (!seat || seat.driverId !== driverId) throw new GroupTripError('This rider is not on your group trip.', 'NOT_SEAT');
  if (String(seat.status) !== 'ARRIVED' || !seat.arrivedAt) throw new GroupTripError('Tap Arrived at their pickup first.', 'NOT_ARRIVED');
  if (now.getTime() - seat.arrivedAt.getTime() < GROUP_RIDE_LIVE_FREE_WAIT_MS) throw new GroupTripError('Their free waiting is not over yet.', 'STILL_FREE');
  if (seat.waitingRateNgn != null) throw new GroupTripError('They agreed to pay for waiting: wait for them.', 'AGREED');
  if (!(await deps.redis.setIfNotExists(`gt:skip:${seatRideId}`, '1', KEEP_SECONDS).catch(() => false))) return;
  await deps.publisher.publishRideEvent(RideCancelledEvent.parse({
    eventType: 'RIDE_CANCELLED', rideId: seatRideId, riderId: seat.riderId, driverId, cancelledBy: 'system',
    reason: 'Rider did not come: the group went on', timestamp: now.toISOString(),
  }));
}

/**
 * A seat is done (dropped off, or cancelled): when every seat is, the trip ends, once. The driver is freed in
 * ride-service and told (`ride:group_done`). Returns true when this call ended it.
 */
export async function seatFinished(deps: GroupTripDeps & { tellDriver?: (driverUserId: string, payload: Record<string, unknown>) => Promise<void> }, seatRideId: string): Promise<boolean> {
  const tripId = await tripOfSeat(deps.redis, seatRideId);
  if (!tripId) return false;
  // This seat is done, marked before anything is read: its row may not say so yet (ride-service writes a cancel from
  // the same event, at the same moment). Two seats finishing together: whichever reads second sees both marks.
  await deps.redis.set(`gt:seatdone:${seatRideId}`, '1', KEEP_SECONDS).catch(() => undefined);
  const seats = await groupTripClient.seatsOf(tripId);
  const marks = await Promise.all(seats.map((s) => deps.redis.get(`gt:seatdone:${s.id}`).catch(() => null)));
  const done = seats.map((s, i) => String(s.status) === 'COMPLETED' || String(s.status) === 'CANCELLED' || marks[i] === '1');
  if (!done.every(Boolean)) return false;
  if (!(await deps.redis.setIfNotExists(finishedKey(tripId), '1', KEEP_SECONDS).catch(() => false))) return false;
  const anyRode = seats.some((s) => String(s.status) === 'COMPLETED' || String(s.status) === 'IN_PROGRESS');
  await groupTripClient.endTrip(tripId, new Date(), anyRode ? 'COMPLETED' : 'CANCELLED');
  await deps.publisher.publishGroupRideEvent(GroupTripEndedEvent.parse({ eventType: 'GROUP_TRIP_ENDED', groupId: tripId, timestamp: new Date().toISOString() }));
  const trip = await prisma.ride.findUnique({ where: { id: tripId }, select: { driver: { select: { userId: true } } } }).catch(() => null);
  const earned = seats.filter((s) => String(s.status) === 'COMPLETED').reduce((sum, s) => sum + Number(s.agreedFareNgn ?? 0), 0);
  if (trip?.driver?.userId && deps.tellDriver) await deps.tellDriver(trip.driver.userId, { tripId, ridersDropped: seats.filter((s) => String(s.status) === 'COMPLETED').length, faresNgn: earned }).catch(() => undefined);
  return true;
}

const GROUP_RIDE_LIVE_FREE_WAIT_MS = 5 * 60 * 1000;

/**
 * The driver cancels a group trip. Before anyone is in the car: they leave, the trip ends once (the same mark as every
 * seat done), and each seat is cancelled by the driver the way any driver backing out is (rides/ride-service: reopened
 * without them, the money goes back, the rider is told and searches on at their own price). With a rider in the car:
 * refused (drop them first). A rider cancelling at the same moment: whichever ends the trip first.
 */
export async function leaveTrip(deps: GroupTripDeps, driver: { driverId: string; driverUserId: string }, tripId: string): Promise<void> {
  const { driverId, driverUserId } = driver;
  const trip = await groupTripClient.tripOf(tripId);
  if (!trip || trip.driverId !== driverId) throw new GroupTripError('This ride is not assigned to you.', 'NOT_TRIP');
  const seats = await groupTripClient.seatsOf(tripId);
  if (seats.some((s) => String(s.status) === 'IN_PROGRESS' || String(s.status) === 'COMPLETED')) {
    throw new GroupTripError('A rider is in the car. Drop them first.', 'RIDING');
  }
  if (!(await deps.redis.setIfNotExists(finishedKey(tripId), '1', KEEP_SECONDS).catch(() => false))) return;
  const unlinked = await groupTripClient.unlinkForLeave(tripId, driverId);
  await groupTripClient.endTrip(tripId, new Date(), 'CANCELLED', 'driver');
  await deps.publisher.publishGroupRideEvent(GroupTripEndedEvent.parse({ eventType: 'GROUP_TRIP_ENDED', groupId: tripId, timestamp: new Date().toISOString() }));
  for (const seat of unlinked) {
    // Out of the group first: the cancel below is a plain driver cancel to everyone who reads it.
    await deps.redis.del(seatKey(seat.id)).catch(() => undefined);
    // A rider who cancelled at this same moment is not told their driver left (nor searched again).
    if (await deps.redis.get(`gt:seatdone:${seat.id}`).catch(() => null)) continue;
    await deps.publisher.publishRideEvent(RideCancelledEvent.parse({
      eventType: 'RIDE_CANCELLED', rideId: seat.id, riderId: seat.riderId, driverId, driverUserId, cancelledBy: 'driver',
      reason: 'The driver left the group', timestamp: new Date().toISOString(),
    }));
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
 * orange). Other riders by first name and the area of their stops only, never the full address. Null: not a seat.
 */
export async function riderGroupView(redis: RedisClient, seatRideId: string): Promise<RiderGroupView | null> {
  const tripId = await tripOfSeat(redis, seatRideId);
  if (!tripId) return null;
  const [trip, seats] = await Promise.all([groupTripClient.tripOf(tripId), groupTripClient.seatsOf(tripId)]);
  if (!trip || !seats.some((s) => s.id === seatRideId)) return null;
  const users = await prisma.user.findMany({ where: { id: { in: seats.map((s) => s.riderId) } }, select: { id: true, name: true } }).catch(() => []);
  const first = new Map(users.map((u) => [u.id, (u.name ?? '').trim().split(/\s+/)[0] || 'Rider']));
  const byId = new Map(seats.map((s) => [s.id, s]));
  const raw = Array.isArray(trip.groupStops) ? (trip.groupStops as Array<{ rideId?: unknown; kind?: unknown; address?: unknown }>) : [];
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
      area: address.split(',')[0]?.trim() || address,
      yours,
      done: status === 'COMPLETED' || (stop.kind === 'pickup' && status === 'IN_PROGRESS'),
    });
  }
  const others = seats.filter((s) => s.id !== seatRideId && String(s.status) !== 'CANCELLED').map((s) => first.get(s.riderId) ?? 'Rider');
  return { others, stops };
}

/* ── a one-time note for the ride page (it shows it once, as a toast) ────────────────────────────────────────────── */

const noteKey = (rideId: string) => `gt:note:${rideId}`;
export async function setGroupNote(redis: RedisClient, rideId: string, text: string): Promise<void> {
  await redis.set(noteKey(rideId), JSON.stringify({ id: randomUUID(), text }), 120);
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
  const first = new Map(users.map((u) => [u.id, (u.name ?? '').trim().split(/\s+/)[0] || 'Rider']));
  return { seatPriceNgn: me.seatPriceNgn, others: others.map((m) => first.get(m.riderId) ?? 'Rider'), ownPriceNgn: me.offerNgn };
}
