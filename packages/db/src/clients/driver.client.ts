import { prisma }   from '../prisma';
import { driverLocationClient } from './driver-location.client';
import { DB_FLUSH_SECONDS, driverPresence } from './driver-presence';
import { driverShiftClient, type ShiftEndReason } from './driver-shift.client';
import { Prisma } from '@prisma/client';
import type { DriverStatus, KycStatus } from '@prisma/client';

type KycDocumentKeys = {
  ninImageKey?:      string;
  licenceImageKey?:  string;
  selfieKey?:        string;
  vehicleImageKeys?: string[];
};

type KycVehicleDetails = {
  vehicleMake?:  string;
  vehicleModel?: string;
  vehiclePlate?: string;
  vehicleYear?:  number;
};

class KycStateChanged extends Error {}

function vehicleOf(data: KycVehicleDetails): KycVehicleDetails {
  const out: KycVehicleDetails = {};
  if (data.vehicleMake !== undefined) out.vehicleMake = data.vehicleMake;
  if (data.vehicleModel !== undefined) out.vehicleModel = data.vehicleModel;
  if (data.vehiclePlate !== undefined) out.vehiclePlate = data.vehiclePlate;
  if (data.vehicleYear !== undefined) out.vehicleYear = data.vehicleYear;
  return out;
}

async function decidePendingKyc(
  driverId: string,
  reviewedBy: string,
  outcome: 'APPROVED' | 'REJECTED',
  rejection: { rejectionReason?: string; rejectedFields?: string[] },
): Promise<{ userId: string } | null> {
  return prisma.$transaction(async (tx) => {
    const submission = await tx.driverKycSubmission.findUnique({ where: { driverId } });
    if (!submission || submission.status !== 'SUBMITTED') return null;
    const reviewedAt = new Date();
    const decided = await tx.driverKycSubmission.updateMany({
      where: { driverId, status: 'SUBMITTED' },
      data:  { status: outcome, reviewedAt, reviewedBy, ...rejection },
    });
    if (decided.count === 0) return null;
    const driver = await tx.driver.update({ where: { id: driverId }, data: { kycStatus: outcome }, select: { userId: true } });
    await tx.driverKycReview.create({
      data: {
        driverId, outcome, reviewedBy, reviewedAt,
        submittedAt: submission.submittedAt ?? reviewedAt,
        notes: outcome === 'REJECTED'
          ? JSON.stringify({ reason: rejection.rejectionReason ?? null, fields: rejection.rejectedFields ?? [] })
          : null,
      },
    });
    return driver;
  });
}

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

/**
 * The driver as they were just before a change of status: what they were, and
 * when they were last heard from (Redis or the row, whichever is later). The
 * shift record needs it to tell "still on the same shift" from "back after
 * being gone".
 */
async function stateBefore(driverId: string): Promise<{ status: string | null; seenAt: Date | null }> {
  const [row, presence] = await Promise.all([
    prisma.driver.findUnique({ where: { id: driverId }, select: { status: true, lastSeenAt: true } }).catch(() => null),
    driverPresence.get(driverId),
  ]);
  const fromRow = row?.lastSeenAt?.getTime() ?? 0;
  const fromRedis = presence?.seenAt ?? 0;
  const latest = Math.max(fromRow, fromRedis);
  return { status: row?.status ?? null, seenAt: latest > 0 ? new Date(latest) : null };
}

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

  // A change of status is also where a shift begins or ends: ONLINE and
  // ON_RIDE are on shift, OFFLINE is off.
  updateStatus: async (driverId: string, status: DriverStatus) => {
    const before = await stateBefore(driverId);
    const driver = await prisma.driver.update({
      where: { id: driverId },
      data:  { status, lastSeenAt: new Date() },
    });
    if (status === 'ONLINE' || status === 'ON_RIDE') await driverShiftClient.open(driverId, before);
    else if (status === 'OFFLINE') await driverShiftClient.close(driverId, 'manual');
    return driver;
  },

  // Going on shift is a change of status, so the row is always written; the
  // position also goes to Redis so matching can see the driver at once.
  markOnline: async (driverId: string, lat: number, lng: number) => {
    const before = await stateBefore(driverId);
    const driver = await prisma.driver.update({
      where: { id: driverId },
      data:  { status: 'ONLINE', lat, lng, lastSeenAt: new Date() },
    });
    await driverPresence.noteLocation(driverId, lat, lng);
    // The app says "online" again on every reconnect; a driver already on shift keeps their shift.
    await driverShiftClient.open(driverId, before);
    return driver;
  },

  // `reason` is why the shift ended. A driver taken offline for silence was
  // last really there when they were last heard from, not now: the 45 seconds
  // of grace and more are not time on shift.
  markOffline: async (driverId: string, reason: ShiftEndReason = 'manual') => {
    const before = await stateBefore(driverId);
    const driver = await prisma.driver.update({
      where: { id: driverId },
      data:  { status: 'OFFLINE', lastSeenAt: new Date() },
    });
    await driverPresence.remove(driverId);
    await driverShiftClient.close(driverId, reason, reason === 'inactivity' && before.seenAt ? before.seenAt : new Date());
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

  /** The admin queue by status: SUBMITTED oldest first, REJECTED newest decision first. */
  findKycSubmissionsByStatus: (status: 'SUBMITTED' | 'REJECTED') =>
    prisma.driverKycSubmission.findMany({
      where:   { status },
      include: { driver: { include: { user: true } } },
      orderBy: status === 'SUBMITTED' ? { submittedAt: 'asc' } : { reviewedAt: 'desc' },
      take:    200,
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

  /**
   * A whole application: a new driver's first, or an app that resends
   * everything. Starts a clean review (the last one's decisions no longer
   * describe these documents). Never for an approved driver: the guard is the
   * first write, so an approved record is left exactly as it was. False when
   * refused.
   */
  submitFullKyc: (driverId: string, data: KycDocumentKeys & KycVehicleDetails & {
    ninImageKey: string; licenceImageKey: string; selfieKey: string; vehicleImageKeys: string[];
  }) =>
    prisma.$transaction(async (tx) => {
      const vehicle = vehicleOf(data);
      const moved = await tx.driver.updateMany({
        where: { id: driverId, kycStatus: { not: 'APPROVED' } },
        data:  { kycStatus: 'SUBMITTED', ...vehicle },
      });
      if (moved.count === 0) return false;
      const submittedAt = new Date();
      await tx.driverKycSubmission.upsert({
        where:  { driverId },
        create: { driverId, ...data, status: 'SUBMITTED', submittedAt },
        update: {
          ...data, status: 'SUBMITTED', submittedAt,
          reviewedAt: null, reviewedBy: null, rejectionReason: null, rejectedFields: [], fieldStatuses: Prisma.DbNull,
        },
      });
      return true;
    }),

  /**
   * A rejected driver sends back only what was rejected. Everything approved
   * stays as it was, documents and the admin's per-item decisions alike;
   * `rejectedFields` now names what was resent, so the reviewer knows what to
   * look at. Only from REJECTED, checked in the same writes: false when the
   * application is no longer rejected (a double tap, an admin in between).
   */
  resubmitKycFields: (driverId: string, fields: string[], data: KycDocumentKeys & KycVehicleDetails) =>
    prisma.$transaction(async (tx) => {
      const submission = await tx.driverKycSubmission.findUnique({ where: { driverId } });
      if (!submission || submission.status !== 'REJECTED') return false;

      const previous = (submission.fieldStatuses && typeof submission.fieldStatuses === 'object' && !Array.isArray(submission.fieldStatuses))
        ? submission.fieldStatuses as Record<string, Prisma.JsonValue>
        : {};
      const kept = Object.fromEntries(Object.entries(previous).filter(([field]) => !fields.includes(field)));

      const moved = await tx.driverKycSubmission.updateMany({
        where: { driverId, status: 'REJECTED' },
        data:  {
          ...data,
          status: 'SUBMITTED', submittedAt: new Date(), reviewedAt: null, reviewedBy: null,
          rejectedFields: fields,
          fieldStatuses: Object.keys(kept).length > 0 ? kept as Prisma.InputJsonObject : Prisma.DbNull,
        },
      });
      if (moved.count === 0) return false;

      const driver = await tx.driver.updateMany({
        where: { id: driverId, kycStatus: 'REJECTED' },
        data:  { kycStatus: 'SUBMITTED', ...vehicleOf(data) },
      });
      // The driver row says otherwise (approved meanwhile?): undo, change nothing.
      if (driver.count === 0) throw new KycStateChanged();
      return true;
    }).catch((error) => {
      if (error instanceof KycStateChanged) return false;
      throw error;
    }),

  /**
   * The admin's decisions, each only while the application is under review
   * (so two admins, or a double click, decide once). Each is kept in the
   * review history. Null when there was nothing under review.
   */
  approvePendingKyc: (driverId: string, reviewedBy: string) =>
    decidePendingKyc(driverId, reviewedBy, 'APPROVED', {}),

  rejectPendingKyc: (driverId: string, reviewedBy: string, rejectionReason: string, rejectedFields: string[]) =>
    decidePendingKyc(driverId, reviewedBy, 'REJECTED', { rejectionReason, rejectedFields }),

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
