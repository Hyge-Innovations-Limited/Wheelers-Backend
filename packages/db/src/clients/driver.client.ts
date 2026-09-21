import { prisma }   from '../prisma';
import { driverLocationClient } from './driver-location.client';
import type { DriverStatus, KycStatus } from '@prisma/client';

export const driverClient = {

  // ── Reads ──────────────────────────────────────────────────────────────────

  findById: (driverId: string) =>
    prisma.driver.findUniqueOrThrow({
      where:   { id: driverId },
      include: { user: true },
    }),

  findByUserId: (userId: string) =>
    prisma.driver.findUnique({
      where:   { userId },
      include: { user: true },
    }),

  // Haversine formula inside raw SQL to find online drivers within radiusKm.
  // Returns up to limit drivers, ordered by distance ascending.
  // ride-service calls this during matching after a RIDE_REQUESTED event.
  findNearby: (lat: number, lng: number, radiusKm: number, limit = 10) =>
    prisma.$queryRaw<Array<{
      id:           string;
      userId:       string;
      lat:          number;
      lng:          number;
      rating:       number;
      vehiclePlate: string | null;
      vehicleModel: string | null;
      distanceKm:   number;
    }>>`
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
        AND d."lastSeenAt" > now() - interval '90 seconds'
        AND (
          6371 * acos(
            cos(radians(${lat})) * cos(radians(d.lat)) *
            cos(radians(d.lng) - radians(${lng})) +
            sin(radians(${lat})) * sin(radians(d.lat))
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

  markOnline: (driverId: string, lat: number, lng: number) =>
    prisma.driver.update({
      where: { id: driverId },
      data:  { status: 'ONLINE', lat, lng, lastSeenAt: new Date() },
    }),

  markOffline: (driverId: string) =>
    prisma.driver.update({
      where: { id: driverId },
      data:  { status: 'OFFLINE', lastSeenAt: new Date() },
    }),

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

  // Called every time driver goes online or sends a GPS ping during availability.
  // Live ride GPS is handled separately — this is just "driver is at this location".
  // Both callers (socket ping, HTTP heartbeat) come through here, so the admin
  // map's trail is fed from this one place. recordPoint never throws.
  updateLocation: async (driverId: string, lat: number, lng: number) => {
    const driver = await prisma.driver.update({
      where: { id: driverId },
      data:  { lat, lng, lastSeenAt: new Date() },
    });
    await driverLocationClient.recordPoint(driverId, lat, lng, 'online');
    return driver;
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
