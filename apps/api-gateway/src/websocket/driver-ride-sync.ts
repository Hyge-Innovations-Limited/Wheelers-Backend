import { formatTripId, tripDetailsFromRow } from '@wheleers/config';
import type { TripDetails } from '@wheleers/config';
import { tripCodeStillNeeded } from '../rides/trip-code';
import type WebSocket from 'ws';
import { prisma, rideClient, userClient } from '@wheleers/db';
import type { SocketRegistry } from './registry';
import { waitingView, type WaitingView } from '../rides/waiting';
import { firstNameOf } from '../rides/group-people';

/**
 * The driver app's picture of an assigned ride.
 *
 * `ride:matched` used to carry only ids and money, which was fine while the
 * app still had the offer card it bid from — but that card lives 30s and the
 * rider has minutes to pay. Once the offer is gone (or the app restarted, or
 * the socket was down when the match fired) the driver could not rebuild the
 * ride and the match was silently dropped. Everything the app needs to draw
 * the trip travels here instead.
 */
export type DriverRideSnapshot = {
  rideId: string;
  /** The short trip ID people use, e.g. WH-01234. */
  tripId: string | null;
  riderId: string;
  driverId: string | null;
  rideStatus: string;
  paymentMethod: string;
  pickup: { lat: number; lng: number; address: string };
  destination: { lat: number; lng: number; address: string };
  stops: Array<{ lat: number; lng: number; address: string }>;
  agreedFareNgn: number;
  /** Which rules the fare was agreed under: the app works the driver's pay out from it. */
  pricingVersion: number;
  riderOfferNgn: number | null;
  /** Wallet rides are held before a driver is assigned — the fare is secured. */
  riderPaid: boolean;
  riderPhone: string | null;
  /** The rider's first name: what the driver's chat says ("Chat with Ada"). */
  riderName: string | null;
  /** Start trip asks for the rider's 4-digit code. The code itself never goes to the driver. */
  tripCodeRequired: boolean;
  matchedAt: string | null;
  arrivedAt: string | null;
  startedAt: string | null;
  /** Waiting time: the free minutes, when the driver arrived, and whether the meter was stopped. Null: not arrived. */
  waiting: WaitingView | null;
  /** People, luggage, pet and the rider's note. Absent: booked without them. */
  tripDetails?: TripDetails;
  /** A group trip (Timi, 17 Nov 2026): its stops in order and each rider's seat. Absent: any other ride. */
  group?: DriverGroupTrip;
};

export type DriverGroupSeat = {
  rideId: string;
  riderId: string;
  riderName: string;
  riderPhone: string | null;
  status: string;
  seatPriceNgn: number;
  pickup: { lat: number; lng: number; address: string };
  dropoff: { lat: number; lng: number; address: string };
  /** Their 4-digit code is still to be given at their pickup. */
  tripCodeRequired: boolean;
  /** Their waiting at their pickup (5 free minutes, then a price they agree). Null: not arrived. */
  waiting: WaitingView | null;
};

export type DriverGroupTrip = {
  seats: DriverGroupSeat[];
  /** Every stop in order: whose, pickup or drop-off, and whether it is behind the driver. */
  stops: Array<{ rideId: string; kind: 'pickup' | 'dropoff'; address: string; lat: number; lng: number; done: boolean }>;
};

/** The group block for a TRIP ride: its seats and its stops, as they stand. */
async function groupTripFor(ride: { id: string; groupRole?: string | null; groupStops?: unknown }): Promise<DriverGroupTrip | null> {
  if (ride.groupRole !== 'TRIP') return null;
  const seatRows = await prisma.ride.findMany({ where: { groupTripId: ride.id, groupRole: 'SEAT' } }).catch(() => []);
  const users = await prisma.user.findMany({ where: { id: { in: seatRows.map((r) => r.riderId) } }, select: { id: true, name: true, phone: true } }).catch(() => []);
  const byUser = new Map(users.map((u) => [u.id, u]));
  const seats: DriverGroupSeat[] = await Promise.all(seatRows.map(async (r) => ({
    rideId: r.id,
    riderId: r.riderId,
    riderName: firstNameOf(byUser.get(r.riderId)?.name),
    // A rider no longer on the trip (dropped off, cancelled, left behind): their number is not the driver's to keep.
    riderPhone: ['COMPLETED', 'CANCELLED'].includes(String(r.status)) ? null : byUser.get(r.riderId)?.phone ?? null,
    status: String(r.status),
    seatPriceNgn: decimalToNumber(r.agreedFareNgn) ?? 0,
    pickup: { lat: r.pickupLat, lng: r.pickupLng, address: r.pickupAddress },
    dropoff: { lat: r.destLat, lng: r.destLng, address: r.destAddress },
    tripCodeRequired: await tripCodeStillNeeded(r.id).catch(() => false),
    waiting: waitingView(r),
  })));
  const status = new Map(seats.map((s) => [s.rideId, s.status]));
  const planned = Array.isArray(ride.groupStops) ? (ride.groupStops as Array<{ rideId: string; kind: 'pickup' | 'dropoff'; address: string; lat: number; lng: number }>) : [];
  const stops = planned.map((p) => {
    const st = status.get(p.rideId) ?? 'CANCELLED';
    const done = st === 'CANCELLED' || st === 'COMPLETED' || (p.kind === 'pickup' && st === 'IN_PROGRESS');
    return { rideId: p.rideId, kind: p.kind, address: p.address, lat: p.lat, lng: p.lng, done };
  });
  return { seats, stops };
}

function decimalToNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'object' && 'toNumber' in value && typeof (value as { toNumber: unknown }).toNumber === 'function') {
    const parsed = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export async function loadDriverRideSnapshot(rideId: string): Promise<DriverRideSnapshot | null> {
  const ride = await rideClient.findById(rideId).catch(() => null);
  if (!ride) return null;

  const rider = await userClient.findById(ride.riderId).catch(() => null);

  return {
    rideId: ride.id,
    tripId: formatTripId(ride.tripNumber),
    riderId: ride.riderId,
    driverId: ride.driverId ?? null,
    rideStatus: ride.status,
    paymentMethod: ride.paymentMethod,
    pickup: { lat: ride.pickupLat, lng: ride.pickupLng, address: ride.pickupAddress },
    destination: { lat: ride.destLat, lng: ride.destLng, address: ride.destAddress },
    // Pickup and destination are on the ride row itself; only the in-between
    // waypoints are stops as far as the driver app is concerned.
    stops: ride.routeStops
      .filter((stop) => stop.type === 'INTERMEDIATE')
      .map((stop) => ({ lat: stop.lat, lng: stop.lng, address: stop.address })),
    agreedFareNgn:
      decimalToNumber(ride.agreedFareNgn) ??
      decimalToNumber(ride.riderOfferNgn) ??
      decimalToNumber(ride.fareEstimateNgn) ??
      0,
    pricingVersion: ride.pricingVersion,
    riderOfferNgn: decimalToNumber(ride.riderOfferNgn),
    riderPaid: ride.paymentMethod === 'WALLET',
    riderPhone: rider?.phone ?? null,
    riderName: rider?.name?.trim().split(/\s+/)[0] || null,
    tripCodeRequired: await tripCodeStillNeeded(ride.id).catch(() => false),
    matchedAt: ride.matchedAt?.toISOString() ?? null,
    arrivedAt: ride.arrivedAt?.toISOString() ?? null,
    startedAt: ride.startedAt?.toISOString() ?? null,
    waiting: waitingView(ride),
    ...(tripDetailsFromRow(ride) ? { tripDetails: tripDetailsFromRow(ride) } : {}),
    ...(await groupTripFor(ride).then((group) => (group ? { group } : {})).catch(() => ({}))),
  };
}

/** The ride this driver is currently assigned to, if any. */
export async function loadDriverActiveRideSnapshot(driverId: string): Promise<DriverRideSnapshot | null> {
  const active = await rideClient.findActiveByDriver(driverId).catch(() => null);
  if (!active) return null;
  return loadDriverRideSnapshot(active.id);
}

/**
 * A driver whose socket was down when their bid was accepted never got
 * `ride:matched` — sendToUser is fire-and-forget, and the ride-service forgets
 * the pending match the moment it publishes the assignment. Re-send it on
 * every (re)connect so the app catches up instead of showing "waiting for
 * rider" forever on a ride the rider already paid for.
 */
export async function resyncDriverActiveRide(
  registry: SocketRegistry,
  socket: WebSocket,
  driverId: string,
): Promise<void> {
  const snapshot = await loadDriverActiveRideSnapshot(driverId).catch((error) => {
    console.warn('[ws] active ride resync failed', {
      driverId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  if (!snapshot) return;

  console.info('[ws] resyncing active ride to driver', {
    driverId,
    rideId: snapshot.rideId,
    rideStatus: snapshot.rideStatus,
  });

  registry.sendToSocket(socket, 'ride:matched', {
    ...snapshot,
    resync: true,
  });
}
