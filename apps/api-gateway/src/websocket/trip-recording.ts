import { rideClient, tripRecordingClient } from '@wheleers/db';
import type { GatewayAuthContext } from '../types';
import type { SocketRegistry } from './registry';

export interface TripRecordingWsDeps {
  /** Does this driver's phone record trips (the flag and the pilot list)? */
  recordsFor(driverId: string): boolean;
  registry: Pick<SocketRegistry, 'sendToUser'>;
}

/**
 * `ride:recording:started {rideId}`, from the driver's phone once the
 * recorder is running: the ride is marked as recorded and the rider is told
 * (`ride:recording`), once per ride. Anything else: not ours (null).
 */
export async function handleTripRecordingMessage(
  type: string,
  payload: Record<string, unknown>,
  auth: GatewayAuthContext,
  deps: TripRecordingWsDeps,
): Promise<{ type: string; payload: Record<string, unknown> } | null> {
  if (type !== 'ride:recording:started') return null;
  const rideId = typeof payload.rideId === 'string' ? payload.rideId : '';
  const reply = (ok: boolean, error?: string) => ({ type: 'ride:recording:started:ok', payload: { rideId, ok, ...(error ? { error } : {}) } });
  if (!rideId || !auth.driverId) return reply(false, 'Only a driver can do that.');
  if (!deps.recordsFor(auth.driverId)) return reply(false, 'Trip recording is off.');
  const ride = await rideClient.findById(rideId).catch(() => null);
  if (!ride || ride.driverId !== auth.driverId) return reply(false, 'This trip is not yours.');
  if (String(ride.status) !== 'IN_PROGRESS') return reply(false, 'This trip is not running.');
  const first = await tripRecordingClient.markRideRecording(rideId).catch(() => false);
  if (first && ride.riderId) {
    await deps.registry.sendToUser(ride.riderId, 'ride:recording', { rideId }).catch(() => undefined);
  }
  return reply(true);
}
