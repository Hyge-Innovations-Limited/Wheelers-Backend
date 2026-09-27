import { prisma }   from '../prisma';
import { driverLocationClient } from './driver-location.client';
import { DB_FLUSH_SECONDS, driverPresence } from './driver-presence';
import type { DriverStatus, KycStatus } from '@prisma/client';

interface NearbyRow {
  id:           string;
  userId:       string;
  lat:          number;
  lng:          number;
  rating:       number;
  vehiclePlate: string | null;
  vehicleModel: string | null;
  distanceKm:   number;
}

/** Matching has always required a driver to have been heard from this recently. */
const LIVE_WINDOW_SECONDS = 90;

// Haversine inside raw SQL: ONLINE, approved drivers within radiusKm, heard
// from inside the window, nearest first. This is how matching worked before
// presence moved to Redis, and it is what answers when Redis cannot.
const findNearbyInPostgres = (lat: number, lng: number, radiusKm: number, limit: number, windowSeconds: number) =>
  prisma.$queryRaw<NearbyRow[]>`
    SELECT
      d.id,
      d."userId",
      d.lat,
      d.lng,
      d.rating,
      d."vehiclePlate",
      d."vehicleModel",
      ROUND(CAST(
        6371 * acos(
          cos(radians(${lat})) * cos(radians(d.lat)) *
          cos(radians(d.lng) - radians(${lng})) +
          sin(radians(${lat})) * sin(radians(d.lat))
        )
      AS numeric), 3) AS "distanceKm"
    FROM "Driver" d
    JOIN "User" u ON u.id = d."userId"
    WHERE
      d.status    = 'ONLINE'
      AND d."kycStatus" = 'APPROVED'
      AND d.lat   IS NOT NULL
      AND d.lng   IS NOT NULL
      -- Liveness: ONLINE in the DB means nothing once the phone goes dark.
      -- Ghost drivers absorbed candidate slots and swallowed offers into
      -- dead sockets while live drivers saw silence.
      AND d."lastSeenAt" > now() - (${windowSeconds} * interval '1 second')
      AND (
        6371 * acos(
          cos(radians(${lat})) * cos(radians(d.lat)) *
          cos(radians(d.lng) - radians(${lng})) +
          sin(radians(${lat})) * sin(radians(d.lat))
        )
      ) <= ${radiusKm}
    ORDER BY "distanceKm" ASC
    LIMIT ${limit}
  `;

export const driverClient = {

  // ── Reads ──────────────────────────────────────────────────────────────────

  // The row as the system should see it: lastSeenAt and position come from
  // Redis when it heard from the driver more recently than the row was written.
  findById: async (driverId: string) => {
    const driver = await prisma.driver.findUniqueOrThrow({
      where:   { id: driverId },
      include: { user: true },
    });
    return (await driverPresence.overlay(driver))!;
  },

  findByUserId: (userId: string) =>
    prisma.driver.findUnique({
      where:   { userId },
      include: { user: true },
    }),

  // Live drivers near a pickup, nearest first. ride-service calls this during
  // matching after a RIDE_REQUESTED event.
  //
  // Redis answers "who is near, and heard from in the last 90 seconds"; Postgres
  // then says which of those are ONLINE and approved, by primary key. When Redis
  // cannot answer, Postgres does the whole job the old way. In that case the
  // rows may be up to one flush window old, so the window is widened by it.
  findNearby: async (lat: number, lng: number, radiusKm: number, limit = 10): Promise<NearbyRow[]> => {
    if (!driverPresence.configured) {
      return findNearbyInPostgres(lat, lng, radiusKm, limit, LIVE_WINDOW_SECONDS);
    }
    // Ask for more than needed: some of the nearest may be on a trip or not approved.
    const near = await driverPresence.nearby(lat, lng, radiusKm, Math.max(limit * 5, 25));
    if (near === null) {
      return findNearbyInPostgres(lat, lng, radiusKm, limit, LIVE_WINDOW_SECONDS + DB_FLUSH_SECONDS);
    }
    if (near.length === 0) return [];

    const rows = await prisma.driver.findMany({
      where: { id: { in: near.map((n) => n.driverId) }, status: 'ONLINE', kycStatus: 'APPROVED' },
      select: { id: true, userId: true, rating: true, vehiclePlate: true, vehicleModel: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const result: NearbyRow[] = [];
    for (const n of near) {
      const row = byId.get(n.driverId);
      if (!row) continue;
      result.push({
        id: row.id,
        userId: row.userId,
        lat: n.lat,
        lng: n.lng,
        rating: Number(row.rating),
        vehiclePlate: row.vehiclePlate,
        vehicleModel: row.vehicleModel,
        distanceKm: n.distanceKm,
      });
      if (result.length >= limit) break;
    }
    return result;
  },

  /**
   * Drivers who are ON A TRIP but nearly done with it, whose drop-off is near
   * this pickup — a driver already heading to Ikeja can take an Ikeja job next.
   *
   * Deliberately NOT part of findNearby, which is ONLINE only and must stay so:
   * a driver carrying a passenger is not available for a job across town. Two
   * gates make them eligible, and the ranking is by distance from where they
   * will BE (their destination), not where they are now.
   */
  findFinishingNearby: (
    lat: number,
    lng: number,
    radiusKm: number,
    limit: number,
    /** How close to their own drop-off counts as "nearly done". */
    finishingWithinKm: number,
  ) =>
    prisma.$queryRaw<Array<{
      id: string;
      userId: string;
      lat: number;
      lng: number;
      vehiclePlate: string | null;
      vehicleModel: string | null;
      distanceKm: number;
    }>>`
      SELECT
        d.id, d."userId", d.lat, d.lng, d."vehiclePlate", d."vehicleModel",
        ROUND(CAST(
          6371 * acos(
            cos(radians(${lat})) * cos(radians(r."destLat")) *
            cos(radians(r."destLng") - radians(${lng})) +
            sin(radians(${lat})) * sin(radians(r."destLat"))
          )
        AS numeric), 3) AS "distanceKm"
      FROM "Driver" d
      JOIN "Ride" r ON r."driverId" = d.id AND r.status = 'IN_PROGRESS'
      WHERE
        d.status = 'ON_RIDE'
        AND d."kycStatus" = 'APPROVED'
        AND d.lat IS NOT NULL
        AND d.lng IS NOT NULL
        AND r."destLat" IS NOT NULL
        AND r."destLng" IS NOT NULL
        -- Same liveness rule as findNearby: ONLINE in the DB means nothing
        -- once the phone goes dark.
        AND d."lastSeenAt" > now() - interval '90 seconds'
        -- 1. Nearly there: the car is this close to its own drop-off.
        AND (
          6371 * acos(
            cos(radians(d.lat)) * cos(radians(r."destLat")) *
            cos(radians(r."destLng") - radians(d.lng)) +
            sin(radians(d.lat)) * sin(radians(r."destLat"))
          )
        ) <= ${finishingWithinKm}
        -- 2. On their way: the new pickup is near where they are dropping off.
        AND (
          6371 * acos(
            cos(radians(${lat})) * cos(radians(r."destLat")) *
            cos(radians(r."destLng") - radians(${lng})) +
            sin(radians(${lat})) * sin(radians(r."destLat"))
          )
        ) <= ${radiusKm}
      ORDER BY "distanceKm" ASC
      LIMIT ${limit}
    `,

  // ── Writes ─────────────────────────────────────────────────────────────────

  create: (userId: string) =>
    prisma.driver.create({
      data: { userId },
    }),

  // Idempotent variant of create — safe to call on signup retries or when a
  // user's role is upgraded to DRIVER/BOTH more than once.
  ensure: (userId: string) =>
    prisma.driver.upsert({
      where:  { userId },
      create: { userId },
      update: {},
    }),

  updateStatus: (driverId: string, status: DriverStatus) =>
    prisma.driver.update({
      where: { id: driverId },
      data:  { status, lastSeenAt: new Date() },
    }),

  // Going on shift is a change of status, so the row is always written; the
  // position also goes to Redis so matching can see the driver at once.
  markOnline: async (driverId: string, lat: number, lng: number) => {
    const driver = await prisma.driver.update({
      where: { id: driverId },
      data:  { status: 'ONLINE', lat, lng, lastSeenAt: new Date() },
    });
    await driverPresence.noteLocation(driverId, lat, lng);
    return driver;
  },

  markOffline: async (driverId: string) => {
    const driver = await prisma.driver.update({
      where: { id: driverId },
      data:  { status: 'OFFLINE', lastSeenAt: new Date() },
    });
    await driverPresence.remove(driverId);
    return driver;
  },

  /**
   * "Still here": a driver ON SHIFT whose socket just answered a ping. Presence
   * must not depend on the phone producing a GPS fix or on a JS timer firing —
   * a parked driver with the app open was shown as "signal lost" and dropped
   * from matching while their connection was perfectly alive. Off-shift rows
   * are never touched (see standby: it must not look like being online).
   */
  touchOnShift: (userId: string) =>
    prisma.driver.updateMany({
      where: { userId, status: { in: ['ONLINE', 'ON_RIDE'] } },
      data: { lastSeenAt: new Date() },
    }),

  /**
   * "Still here", from the socket's pong. Redis hears every one; the row is
   * touched at most once per flush window.
   */
  noteAlive: async (userId: string, driverId: string): Promise<void> => {
    const { flushDb, lat, lng } = await driverPresence.noteAlive(driverId);
    if (!flushDb) return;
    await prisma.driver.updateMany({
      where: { userId, status: { in: ['ONLINE', 'ON_RIDE'] } },
      data: lat !== null && lng !== null ? { lat, lng, lastSeenAt: new Date() } : { lastSeenAt: new Date() },
    });
  },

  // Called every time a driver sends a position while available. Live ride GPS
  // is handled separately — this is just "driver is at this location".
  // Both callers (socket ping, HTTP heartbeat) come through here. Redis hears
  // every one; the row is written at most once per flush window, and the admin
  // map's trail is fed from here by its own rules. recordPoint never throws.
  updateLocation: async (driverId: string, lat: number, lng: number): Promise<void> => {
    const { flushDb } = await driverPresence.noteLocation(driverId, lat, lng);
    if (flushDb) {
      await prisma.driver.update({
        where: { id: driverId },
        data:  { lat, lng, lastSeenAt: new Date() },
      });
    }
    await driverLocationClient.recordPoint(driverId, lat, lng, 'online');
  },

  updateKycStatus: (driverId: string, kycStatus: KycStatus) =>
    prisma.driver.update({
      where: { id: driverId },
      data:  { kycStatus },
    }),

  updateVehicle: (driverId: string, data: {
    vehicleMake?:  string;
    vehicleModel?: string;
    vehiclePlate?: string;
    vehicleYear?:  number;
    licenceCid?:   string;
    insuranceCid?: string;
    selfieHash?:   string;
  }) =>
    prisma.driver.update({
      where: { id: driverId },
      data,
    }),


  incrementTotalRides: (driverId: string) =>
    prisma.driver.update({
      where: { id: driverId },
      data:  { totalRides: { increment: 1 } },
    }),

  updateRating: async (driverId: string) => {
    // Recalculate average from all feedback for this driver.
    // Called by compliance-worker after each FEEDBACK_LOGGED event.
    const result = await prisma.feedback.aggregate({
      where:   { revieweeId: driverId },
      _avg:    { rating: true },
      _count:  { rating: true },
    });

    if (result._avg.rating === null) return;

    return prisma.driver.update({
      where: { id: driverId },
      data:  { rating: result._avg.rating },
    });
  },

  // ── KYC submissions ────────────────────────────────────────────────────────

  upsertKycSubmission: (driverId: string, data: {
    ninImageKey?:      string;
    licenceImageKey?:  string;
    selfieKey?:        string;
    vehicleImageKeys?: string[];
    vehicleMake?:      string;
    vehicleModel?:     string;
    vehiclePlate?:     string;
    vehicleYear?:      number;
  }) =>
    prisma.driverKycSubmission.upsert({
      where:  { driverId },
      create: { driverId, ...data },
      update: data,
    }),

  submitKyc: (driverId: string) =>
    prisma.driverKycSubmission.update({
      where: { driverId },
      data:  { status: 'SUBMITTED', submittedAt: new Date() },
    }),

  findKycSubmission: (driverId: string) =>
    prisma.driverKycSubmission.findUnique({
      where: { driverId },
    }),

  findPendingKycSubmissions: () =>
    prisma.driverKycSubmission.findMany({
      where:   { status: 'SUBMITTED' },
      include: { driver: { include: { user: true } } },
      orderBy: { submittedAt: 'asc' },
    }),

  approveKycSubmission: (driverId: string, reviewedBy: string) =>
    prisma.driverKycSubmission.update({
      where: { driverId },
      data:  { status: 'APPROVED', reviewedAt: new Date(), reviewedBy },
    }),

  rejectKycSubmission: (driverId: string, reviewedBy: string, rejectionReason: string, rejectedFields?: string[]) =>
    prisma.driverKycSubmission.update({
      where: { driverId },
      data:  { status: 'REJECTED', reviewedAt: new Date(), reviewedBy, rejectionReason, rejectedFields: rejectedFields ?? [] },
    }),

  updateFieldStatuses: (driverId: string, fieldStatuses: Record<string, string>) =>
    prisma.driverKycSubmission.update({
      where: { driverId },
      data: { fieldStatuses },
    }),

  // ── KYC reviews ────────────────────────────────────────────────────────────

  createKycReview: (data: {
    driverId:   string;
    outcome:    KycStatus;
    reviewedBy: string;
    notes?:     string;
  }) =>
    prisma.driverKycReview.create({
      data: {
        ...data,
        reviewedAt: new Date(),
      },
    }),

  findKycHistory: (driverId: string) =>
    prisma.driverKycReview.findMany({
      where:   { driverId },
      orderBy: { submittedAt: 'desc' },
    }),
};
