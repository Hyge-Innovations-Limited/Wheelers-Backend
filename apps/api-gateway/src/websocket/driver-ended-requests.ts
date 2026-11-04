import { rideClient } from '@wheleers/db';
import type WebSocket from 'ws';
import type { RedisClient } from '../redis/client';
import { forgetOfferedRides, offeredRidesOf } from '../rides/search-status';
import type { SocketRegistry } from './registry';

/**
 * A driver's app that was closed or in the background when a request ended
 * never heard it: the request stayed on screen (restored from the phone)
 * until it expired. On every reconnect the requests this driver was shown
 * are checked, and each one that is over is told, in the same words the
 * live socket uses (ride:bid_timeout / ride:bid_lost with the reason), so
 * every app version already takes it off the screen.
 */

const OPEN = new Set(['REQUESTED', 'MATCHING']);
/** ride-service's reason when a rider's new search replaces their old one: the rider ended it. */
const SUPERSEDED_REASON = 'Replaced by a newer request';
/** At most this many checked per reconnect. */
const MAX_CHECKED = 50;

type RideEndState = { id: string; status: string; driverId: string | null; cancelledBy: string | null; cancelReason: string | null };
export type EndedNotice = {
  type: 'ride:bid_timeout' | 'ride:bid_lost';
  payload: { rideId: string; reason: 'rider_cancelled' | 'timed_out' | 'booked_other' };
};

/** What to tell this driver about a request they were shown; null while it is open, or when the trip is theirs. */
export function endedNoticeOf(ride: RideEndState, driverId: string): EndedNotice | null {
  if (OPEN.has(ride.status)) return null;
  if (ride.status === 'CANCELLED') {
    const byRider = ride.cancelledBy === 'rider' || ride.cancelReason === SUPERSEDED_REASON;
    return { type: 'ride:bid_timeout', payload: { rideId: ride.id, reason: byRider ? 'rider_cancelled' : 'timed_out' } };
  }
  // Booked: the trip is theirs (the active-ride resync brings it back) or another driver's.
  if (ride.driverId === driverId) return null;
  return { type: 'ride:bid_lost', payload: { rideId: ride.id, reason: 'booked_other' } };
}

export async function tellEndedRequests(
  registry: SocketRegistry,
  socket: WebSocket,
  redis: RedisClient,
  driverUserId: string,
  driverId: string,
): Promise<void> {
  try {
    const rideIds = (await offeredRidesOf(redis, driverUserId)).slice(0, MAX_CHECKED);
    if (rideIds.length === 0) return;
    const rides = await rideClient.endStates(rideIds);
    const told: string[] = [];
    for (const ride of rides) {
      const notice = endedNoticeOf(ride, driverId);
      if (!notice) continue;
      registry.sendToSocket(socket, notice.type, notice.payload);
      told.push(ride.id);
    }
    // Rides gone from the database are over too: nothing to tell, nothing to check again.
    const missing = rideIds.filter((id) => !rides.some((ride) => ride.id === id));
    await forgetOfferedRides(redis, driverUserId, [...told, ...missing]);
  } catch (error) {
    console.warn('[ws] ended requests not checked', { driverUserId, error: error instanceof Error ? error.message : String(error) });
  }
}
