import { randomUUID } from 'node:crypto';
import { calculateSuggestedFare, GROUP_RIDE_LIVE } from '@wheleers/config';
import { driverBidClient, driverClient, groupTripClient, prisma } from '@wheleers/db';
import { RideDriverAssignedEvent, RideOfferAcceptedEvent, RideRequestedEvent, RideRiderCounterOfferEvent, GroupTripEndedEvent, GroupTripFormedEvent } from '@wheleers/kafka-schemas';
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

export type GroupTripChange = { kind: 'no_driver'; tripId: string; seats: GroupLiveMember[] };

export interface GroupTripRecord {
  tripId: string;
  seats: GroupLiveMember[];
  totalNgn: number;
  createdAt: string;
  /** No driver by then: the group ends. */
  deadline: string;
}

/** How long the group waits for a driver before every rider goes back to their own search. */
export const GROUP_TRIP_SEARCH_SECONDS = 2 * 60;
/** A counter is taken without asking when each rider's share of it is within this of their seat. */
export const COUNTER_AUTO_SHARE = 0.10;

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
export async function startGroupTrip(deps: GroupTripDeps, offer: GroupLiveOffer, joined: GroupLiveMember[]): Promise<string | null> {
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
 * shared by each rider's own fare, taken only if every share is within +10% of that seat. Null: not taken.
 */
export function seatPricesFor(seats: Array<{ rideId: string; offerNgn: number; seatPriceNgn: number }>, driverPriceNgn: number): Map<string, number> | null {
  const total = seats.reduce((s, m) => s + m.seatPriceNgn, 0);
  if (driverPriceNgn <= total) return new Map(seats.map((m) => [m.rideId, m.seatPriceNgn]));
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
  for (const m of seats) if (prices.get(m.rideId)! > m.seatPriceNgn * (1 + COUNTER_AUTO_SHARE) + 0.5) return null;
  return prices;
}

/**
 * A driver's price on a group trip (from their bid): booked when it can be taken, once. Returns what happened, for
 * the logs and the tests.
 */
export async function onTripBid(
  deps: GroupTripDeps,
  bid: { tripId: string; bidId?: string; driverId: string; driverUserId: string; priceNgn: number },
): Promise<'booked' | 'not_taken' | 'busy' | 'booking' | 'ended' | 'driver_gone' | 'seats_moved'> {
  const trip = await readTrip(deps.redis, bid.tripId);
  if (!trip || (await deps.redis.get(endedKey(bid.tripId)).catch(() => null))) return 'ended';
  if (await deps.redis.get(bookedKey(bid.tripId)).catch(() => null)) return 'booking';
  const prices = seatPricesFor(trip.seats, bid.priceNgn);
  if (!prices) return 'not_taken';
  // One booking at a time on the trip.
  if (!(await deps.redis.setIfNotExists(bookingKey(bid.tripId), bid.driverId, 30).catch(() => false))) return 'booking';
  try {
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
      // A seat short or gone (both checked at the offer, so rare): the group ends, every search goes on.
      await endUnbookedTrip(deps, bid.tripId);
      return 'seats_moved';
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
    return 'booked';
  } finally {
    await deps.redis.del(bookingKey(bid.tripId)).catch(() => undefined);
  }
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
  if (!(await deps.redis.setIfNotExists(endedKey(tripId), '1', KEEP_SECONDS).catch(() => false))) return false;
  const trip = await readTrip(deps.redis, tripId);
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
  if (trip && deps.tell) await deps.tell({ kind: 'no_driver', tripId, seats: trip.seats }).catch(() => undefined);
  return true;
}
