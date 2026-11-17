import { meterLocation } from '../../health/location-meter';
import { driverClient, driverLocationClient, pinnedPosition, rideClient } from '@wheleers/db';
import type { RedisClient } from '../../redis/client';
import { noteGroupTripDriver } from '../../rides/group-trip';
import { LIVE_TRIP_STATUSES } from '../../rides/live-trip';
import {
  DriverOfflineEvent,
  DriverOnlineEvent,
  GpsUpdateEvent,
} from '@wheleers/kafka-schemas';
import { assertDriverApproved } from '../../rides/driver-kyc-gate';
import type { GatewayAuthContext } from '../../types';
import { getNumber, getString } from '../../utils/object';
import type { GatewayPublisher } from '../publisher';
import type { HandlerResponse } from './types';

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = getString(payload, key);
  if (!value) throw new Error(`Missing required field: ${key}`);
  return value;
}

function requireNumber(payload: Record<string, unknown>, key: string): number {
  const value = getNumber(payload, key);
  if (value === undefined) throw new Error(`Missing required field: ${key}`);
  return value;
}

function resolveDriverId(payload: Record<string, unknown>, auth: GatewayAuthContext): string {
  // The signed-in driver, always: a driverId in the message never makes this socket another driver.
  if (auth.driverId) return auth.driverId;
  const fromPayload = getString(payload, 'driverId');
  if (fromPayload && auth.role !== 'RIDER') return fromPayload;

  // Never fall back to auth.userId here: Driver.id is its own uuid and never
  // equals User.id, so doing so publishes an id that matches no Driver row and
  // every downstream persist silently no-ops.
  if (auth.role === 'DRIVER' || auth.role === 'BOTH') {
    throw new Error('No driver profile found for this account.');
  }

  throw new Error('driverId is required for driver events');
}

/** Is this ride this driver's, live right now? Remembered a minute (GPS comes every few seconds). */
async function drivesRideNow(redis: RedisClient | undefined, rideId: string, driverId: string): Promise<boolean> {
  const key = `gps:own:${rideId}:${driverId}`;
  const known = redis ? await redis.get(key).catch(() => null) : null;
  if (known !== null) return known === '1';
  const ride = await rideClient.findById(rideId).catch(() => null);
  const ok = Boolean(ride && ride.driverId === driverId && LIVE_TRIP_STATUSES.includes(String(ride.status)));
  if (redis) await redis.set(key, ok ? '1' : '0', 60).catch(() => undefined);
  return ok;
}

export async function handleDriverMessage(
  type: string,
  payload: Record<string, unknown>,
  auth: GatewayAuthContext,
  publisher: GatewayPublisher,
  redis?: RedisClient,
): Promise<HandlerResponse | null> {
  const timestamp = new Date().toISOString();

  if (type === 'driver:online') {
    // Not approved (KYC not done, in review or rejected): never on shift.
    await assertDriverApproved(auth.userId);
    // The car comes from the driver's profile when the app does not send it.
    // It used to default to "UNKNOWN", which rode all the way to the rider's
    // "Driver is here. Look for the UNKNOWN, plate UNKNOWN."
    const sentPlate = getString(payload, 'vehiclePlate');
    const sentModel = getString(payload, 'vehicleModel');
    const profile = sentPlate && sentModel ? null : await driverClient.findByUserId(auth.userId).catch(() => null);
    const event = DriverOnlineEvent.parse({
      eventType: 'DRIVER_ONLINE',
      driverId: resolveDriverId(payload, auth),
      userId: auth.userId,
      // A test driver held at a spot (DRIVER_TEST_PINS) goes online there.
      ...pinnedPosition(resolveDriverId(payload, auth), requireNumber(payload, 'lat'), requireNumber(payload, 'lng')),
      vehiclePlate: sentPlate ?? profile?.vehiclePlate ?? '',
      vehicleModel: sentModel ?? profile?.vehicleModel ?? '',
      timestamp,
    });

    await publisher.publishDriverEvent(event);
    // This app drives group trips (the group screen, a code per rider): it may be sent one.
    if (redis && payload['groupTrips'] === true) await noteGroupTripDriver(redis, auth.userId).catch(() => undefined);

    return {
      type: 'driver:online:accepted',
      payload: {
        driverId: event.driverId,
      },
    };
  }

  if (type === 'driver:offline') {
    const event = DriverOfflineEvent.parse({
      eventType: 'DRIVER_OFFLINE',
      driverId: resolveDriverId(payload, auth),
      reason: getString(payload, 'reason') === 'app_closed'
        ? 'app_closed'
        : getString(payload, 'reason') === 'inactivity'
          ? 'inactivity'
          : getString(payload, 'reason') === 'admin'
            ? 'admin'
            : 'manual',
      timestamp,
    });

    await publisher.publishDriverEvent(event);

    return {
      type: 'driver:offline:accepted',
      payload: {
        driverId: event.driverId,
      },
    };
  }

  if (type === 'driver:gps') {
    // Timed for the Health page (location pings: how many, and how long each takes).
    return meterLocation(async () => {
      // Without a rideId this is an idle position ping. The driver's row used to
      // be written only at go-online, so matching (and the pickup distance shown
      // to riders) worked off wherever the driver was when they came online —
      // hours stale by the afternoon. Idle pings refresh the row and stay off
      // the gps.stream topic, which is reserved for in-trip telemetry.
      const rideId = getString(payload, 'rideId');
      const driverId = resolveDriverId(payload, auth);
      const lat = requireNumber(payload, 'lat');
      const lng = requireNumber(payload, 'lng');

      if (!rideId) {
        await driverClient.updateLocation(driverId, lat, lng);
        return {
          type: 'driver:gps:accepted',
          payload: { rideId: null },
        };
      }

      // A position for a ride only from that ride's own driver, while it is live: never a fake car on someone's map.
      if (!auth.driverId || !(await drivesRideNow(redis, rideId, driverId))) {
        throw new Error('This ride is not assigned to you.');
      }

      const event = GpsUpdateEvent.parse({
        eventType: 'GPS_UPDATE',
        rideId,
        driverId,
        lat,
        lng,
        speedKmh: getNumber(payload, 'speedKmh'),
        headingDeg: getNumber(payload, 'headingDeg'),
        accuracyM: getNumber(payload, 'accuracyM'),
        timestamp,
      });

      await publisher.publishGpsEvent(event);
      // Keep the driver's own row and trail current too — see noteTripPosition.
      void driverLocationClient.noteTripPosition(driverId, lat, lng);

      return {
        type: 'driver:gps:accepted',
        payload: {
          rideId: event.rideId,
        },
      };
    });
  }

  return null;
}
