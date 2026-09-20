import { driverClient, driverLocationClient } from '@wheleers/db';
import {
  DriverOfflineEvent,
  DriverOnlineEvent,
  GpsUpdateEvent,
} from '@wheleers/kafka-schemas';
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
  const fromPayload = getString(payload, 'driverId');
  if (fromPayload) return fromPayload;

  if (auth.driverId) return auth.driverId;

  // Never fall back to auth.userId here: Driver.id is its own uuid and never
  // equals User.id, so doing so publishes an id that matches no Driver row and
  // every downstream persist silently no-ops.
  if (auth.role === 'DRIVER' || auth.role === 'BOTH') {
    throw new Error('No driver profile found for this account.');
  }

  throw new Error('driverId is required for driver events');
}

export async function handleDriverMessage(
  type: string,
  payload: Record<string, unknown>,
  auth: GatewayAuthContext,
  publisher: GatewayPublisher,
): Promise<HandlerResponse | null> {
  const timestamp = new Date().toISOString();

  if (type === 'driver:online') {
    const event = DriverOnlineEvent.parse({
      eventType: 'DRIVER_ONLINE',
      driverId: resolveDriverId(payload, auth),
      userId: auth.userId,
      lat: requireNumber(payload, 'lat'),
      lng: requireNumber(payload, 'lng'),
      vehiclePlate: getString(payload, 'vehiclePlate') ?? 'UNKNOWN',
      vehicleModel: getString(payload, 'vehicleModel') ?? 'UNKNOWN',
      timestamp,
    });

    await publisher.publishDriverEvent(event);

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
  }

  return null;
}
