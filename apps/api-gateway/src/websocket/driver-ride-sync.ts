import { formatTripId } from '@wheleers/config';
import { tripCodeStillNeeded } from '../rides/trip-code';
import type WebSocket from 'ws';
import { rideClient, userClient } from '@wheleers/db';
import type { SocketRegistry } from './registry';

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
};

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
    riderOfferNgn: decimalToNumber(ride.riderOfferNgn),
    riderPaid: ride.paymentMethod === 'WALLET',
    riderPhone: rider?.phone ?? null,
    riderName: rider?.name?.trim().split(/\s+/)[0] || null,
    tripCodeRequired: await tripCodeStillNeeded(ride.id).catch(() => false),
    matchedAt: ride.matchedAt?.toISOString() ?? null,
    arrivedAt: ride.arrivedAt?.toISOString() ?? null,
    startedAt: ride.startedAt?.toISOString() ?? null,
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
