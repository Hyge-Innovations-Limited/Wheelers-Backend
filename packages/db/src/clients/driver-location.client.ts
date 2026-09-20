import { prisma } from '../prisma';

/**
 * Where drivers are and where they have been — the data behind the admin live
 * map and the dispatch panel.
 *
 * Two kinds of position, deliberately kept apart:
 *   online  — Driver.lat/lng/lastSeenAt. Matching reads these as "available now".
 *   standby — Driver.standbyLat/standbyLng/standbySeenAt. A rough fix sent while
 *             the driver is signed in but OFF shift, only after they switched
 *             "Nearby ride alerts" on. Matching must never see it, so nothing
 *             here writes lastSeenAt on a standby ping.
 */

export type LocationSource = 'online' | 'standby';

/** In-trip pings arrive every few seconds; the driver's row needs far fewer writes. */
const TRIP_ROW_INTERVAL_MS = 15_000;
const lastTripRowWrite = new Map<string, number>();

/** A new history row needs this much time OR this much movement since the last. */
const MIN_INTERVAL_MS = 30_000;
const MIN_MOVE_METRES = 50;
/** Without movement we still write occasionally, so a parked driver has a trail. */
const STATIONARY_INTERVAL_MS = 5 * 60_000;
const MAX_TRACKED_DRIVERS = 20_000;

interface LastPoint { lat: number; lng: number; at: number }

// Last written point per driver. In-process on purpose: it saves a read on every
// ping, and losing it (restart, second instance) costs one extra row, nothing else.
const lastWritten = new Map<string, LastPoint>();

function metresBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

export function shouldRecordPoint(
  last: LastPoint | undefined,
  lat: number,
  lng: number,
  now: number,
): boolean {
  if (!last) return true;
  const elapsed = now - last.at;
  if (elapsed < MIN_INTERVAL_MS) return false;
  if (elapsed >= STATIONARY_INTERVAL_MS) return true;
  return metresBetween(last.lat, last.lng, lat, lng) >= MIN_MOVE_METRES;
}

const driverForMap = {
  id: true,
  userId: true,
  status: true,
  kycStatus: true,
  lat: true,
  lng: true,
  lastSeenAt: true,
  standbyEnabled: true,
  standbyLat: true,
  standbyLng: true,
  standbySeenAt: true,
  vehicleMake: true,
  vehicleModel: true,
  vehiclePlate: true,
  rating: true,
  totalRides: true,
  user: { select: { name: true, phone: true, photoUrl: true } },
} as const;

const activeRideSelect = {
  id: true,
  driverId: true,
  status: true,
  pickupAddress: true,
  destAddress: true,
  destLat: true,
  destLng: true,
} as const;

const ACTIVE_RIDE_STATUSES = ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'] as const;
const UNMATCHED_RIDE_STATUSES = ['REQUESTED', 'MATCHING'] as const;

export const driverLocationClient = {
  /**
   * Add a point to the driver's trail if it is worth keeping. Never throws — a
   * history hiccup must not fail the heartbeat that keeps a driver matchable.
   */
  recordPoint: async (
    driverId: string,
    lat: number,
    lng: number,
    source: LocationSource,
  ): Promise<boolean> => {
    const now = Date.now();
    if (!shouldRecordPoint(lastWritten.get(driverId), lat, lng, now)) return false;

    if (lastWritten.size >= MAX_TRACKED_DRIVERS) lastWritten.clear();
    lastWritten.set(driverId, { lat, lng, at: now });
    try {
      await prisma.driverLocationPoint.create({ data: { driverId, lat, lng, source } });
      return true;
    } catch (error) {
      console.warn('[driver-location] could not record history point', {
        driverId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  },

  /**
   * A GPS ping sent DURING a trip. Those go to the trip telemetry stream, which
   * never touched the driver's own row — so a driver on a trip looked like a
   * dead signal on the map, trips left no trail, and lastSeenAt was stale the
   * moment the trip ended. Throttled, and never throws: trip telemetry must not
   * wait on, or fail because of, the admin map.
   */
  noteTripPosition: async (driverId: string, lat: number, lng: number): Promise<void> => {
    const now = Date.now();
    if (now - (lastTripRowWrite.get(driverId) ?? 0) < TRIP_ROW_INTERVAL_MS) return;
    if (lastTripRowWrite.size >= MAX_TRACKED_DRIVERS) lastTripRowWrite.clear();
    lastTripRowWrite.set(driverId, now);
    try {
      await prisma.driver.update({ where: { id: driverId }, data: { lat, lng, lastSeenAt: new Date(now) } });
      await driverLocationClient.recordPoint(driverId, lat, lng, 'online');
    } catch (error) {
      console.warn('[driver-location] could not note trip position', {
        driverId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  /** Test hook: forget what was written so throttling starts fresh. */
  resetThrottle: (): void => {
    lastWritten.clear();
    lastTripRowWrite.clear();
  },

  // ── Standby ("Nearby ride alerts") ─────────────────────────────────────────

  getStandby: (driverId: string) =>
    prisma.driver.findUnique({
      where: { id: driverId },
      select: { standbyEnabled: true, standbyConsentAt: true, standbySeenAt: true },
    }),

  /**
   * Switching it off also erases the stored standby position — the driver
   * withdrew consent, so we stop holding where they were off shift.
   */
  setStandby: (driverId: string, enabled: boolean) =>
    prisma.driver.update({
      where: { id: driverId },
      data: enabled
        ? { standbyEnabled: true, standbyConsentAt: new Date() }
        : { standbyEnabled: false, standbyLat: null, standbyLng: null, standbySeenAt: null },
      select: { standbyEnabled: true, standbyConsentAt: true, standbySeenAt: true },
    }),

  /**
   * Store an off-shift position. Returns false when the driver has not opted
   * in — the caller tells the app to stop sending.
   */
  updateStandbyLocation: async (driverId: string, lat: number, lng: number): Promise<boolean> => {
    const { count } = await prisma.driver.updateMany({
      where: { id: driverId, standbyEnabled: true },
      data: { standbyLat: lat, standbyLng: lng, standbySeenAt: new Date() },
    });
    if (count === 0) return false;
    await driverLocationClient.recordPoint(driverId, lat, lng, 'standby');
    return true;
  },

  // ── Admin map ──────────────────────────────────────────────────────────────

  /** Every driver that has ever reported a position, with who they are. */
  listForMap: () =>
    prisma.driver.findMany({
      where: {
        // Deleted accounts are anonymised in place; this prefix is their marker.
        user: { NOT: { privyDid: { startsWith: 'deleted:' } } },
        OR: [{ lat: { not: null } }, { standbyLat: { not: null } }],
      },
      select: driverForMap,
    }),

  findForMap: (driverId: string) =>
    prisma.driver.findUnique({ where: { id: driverId }, select: driverForMap }),

  /** The ride each of these drivers is on right now, keyed by driver id. */
  activeRidesByDriver: async (driverIds: string[]) => {
    if (driverIds.length === 0) return new Map<string, ActiveRide>();
    const rides = await prisma.ride.findMany({
      where: { driverId: { in: driverIds }, status: { in: [...ACTIVE_RIDE_STATUSES] } },
      orderBy: { createdAt: 'desc' },
      select: activeRideSelect,
    });
    const byDriver = new Map<string, ActiveRide>();
    for (const ride of rides) {
      if (ride.driverId && !byDriver.has(ride.driverId)) byDriver.set(ride.driverId, ride);
    }
    return byDriver;
  },

  trail: (driverId: string, since: Date, limit = 2_000) =>
    prisma.driverLocationPoint.findMany({
      where: { driverId, recordedAt: { gte: since } },
      orderBy: { recordedAt: 'asc' },
      take: limit,
      select: { lat: true, lng: true, source: true, recordedAt: true },
    }),

  /** Rides still looking for a driver — the dispatch panel's work queue. */
  unmatchedRides: (since: Date) =>
    prisma.ride.findMany({
      where: { status: { in: [...UNMATCHED_RIDE_STATUSES] }, createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: {
        id: true,
        status: true,
        pickupLat: true,
        pickupLng: true,
        pickupAddress: true,
        destAddress: true,
        riderOfferNgn: true,
        fareEstimateNgn: true,
        distanceKm: true,
        createdAt: true,
        _count: { select: { bids: true } },
      },
    }),

  pruneOlderThan: async (cutoff: Date): Promise<number> => {
    const { count } = await prisma.driverLocationPoint.deleteMany({
      where: { recordedAt: { lt: cutoff } },
    });
    return count;
  },

  // ── Dispatch contact log ───────────────────────────────────────────────────

  logContact: (input: {
    driverId: string;
    rideId?: string | null;
    adminName: string;
    kind: 'call' | 'nudge';
    outcome: string;
    note?: string | null;
  }) =>
    prisma.dispatchContact.create({
      data: {
        driverId: input.driverId,
        rideId: input.rideId ?? null,
        adminName: input.adminName,
        kind: input.kind,
        outcome: input.outcome,
        note: input.note ?? null,
      },
    }),

  lastNudgeAt: async (driverId: string): Promise<Date | null> => {
    const row = await prisma.dispatchContact.findFirst({
      where: { driverId, kind: 'nudge' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return row?.createdAt ?? null;
  },

  contactsForDriver: (driverId: string, limit = 20) =>
    prisma.dispatchContact.findMany({
      where: { driverId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),

  contactsSince: (since: Date) =>
    prisma.dispatchContact.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    }),
};

export interface ActiveRide {
  id: string;
  driverId: string | null;
  status: string;
  pickupAddress: string;
  destAddress: string;
  destLat: number;
  destLng: number;
}

export type MapDriverRow = NonNullable<Awaited<ReturnType<typeof driverLocationClient.findForMap>>>;
