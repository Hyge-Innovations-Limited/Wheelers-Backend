import { driverClient } from '@wheleers/db';

import type { RideEnv } from '@wheleers/config';
import type { RideRequestedEvent } from '@wheleers/kafka-schemas';

import type { OnlineDriver } from '../index';
import { haversineKm } from '../utils/geo';

/**
 * How close a driver must be to their own drop-off before another rider's
 * request is offered to them. Small on purpose: far enough out and they are
 * simply busy.
 */
const FINISHING_WITHIN_KM = 2;

export type MatchDriverResult =
  | { ok: true; drivers: OnlineDriver[] }
  | { ok: false; reason: 'no_drivers_online' | 'no_drivers_in_radius' };

export async function matchDriver(params: {
  rideEnv: RideEnv;
  onlineDrivers: Map<string, OnlineDriver>;
  rideRequested: RideRequestedEvent;
}): Promise<MatchDriverResult> {
  const { rideEnv, onlineDrivers, rideRequested } = params;

  const radiusKm = Number(rideEnv.MATCH_RADIUS_KM);
  const limit = Number(rideEnv.MAX_MATCH_ATTEMPTS);

  // DB is the source of truth — find all ONLINE drivers nearby,
  // regardless of whether they're in the in-memory map.
  try {
    const candidates = await driverClient.findNearby(
      rideRequested.pickup.lat,
      rideRequested.pickup.lng,
      radiusKm,
      limit,
    );

    const toDriver = (
      d: { id: string; userId: string; lat: number; lng: number; vehiclePlate: string | null; vehicleModel: string | null; distanceKm: number },
      afterCurrentTrip: boolean,
    ): OnlineDriver => {
      const inMemory = onlineDrivers.get(d.id);
      const base = inMemory ?? {
        driverId: d.id,
        userId: d.userId,
        lat: d.lat,
        lng: d.lng,
        vehiclePlate: d.vehiclePlate ?? '',
        vehicleModel: d.vehicleModel ?? '',
      };
      return { ...base, distanceKm: d.distanceKm, ...(afterCurrentTrip ? { afterCurrentTrip } : {}) };
    };

    const drivers = candidates.map((d) => toDriver(d, false));

    // Nobody free nearby, or not enough of them? A driver already dropping off
    // in this area can queue it — their card says so, and a free driver is
    // always ranked first because they can come NOW.
    if (drivers.length < limit) {
      const finishing = await driverClient
        .findFinishingNearby(
          rideRequested.pickup.lat,
          rideRequested.pickup.lng,
          radiusKm,
          limit - drivers.length,
          FINISHING_WITHIN_KM,
        )
        .catch(() => []);
      for (const d of finishing) drivers.push(toDriver(d, true));
    }

    if (drivers.length > 0) return { ok: true, drivers };
  } catch {
    // ignore and fall back to in-memory pool
  }

  // Fallback: nearest in-memory drivers inside the configured radius.
  if (onlineDrivers.size === 0) return { ok: false, reason: 'no_drivers_online' };

  const drivers = Array.from(onlineDrivers.values())
    .map((driver) => ({
      driver,
      distanceKm: haversineKm(
        rideRequested.pickup.lat,
        rideRequested.pickup.lng,
        driver.lat,
        driver.lng,
      ),
    }))
    .filter(({ distanceKm }) => distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit)
    .map(({ driver, distanceKm }) => ({ ...driver, distanceKm }));

  if (drivers.length === 0) return { ok: false, reason: 'no_drivers_in_radius' };
  return { ok: true, drivers };
}
