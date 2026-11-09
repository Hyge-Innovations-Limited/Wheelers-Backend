import { Prisma } from '@prisma/client';
import { formatTripId } from '@wheleers/config';
import { prisma } from '../prisma';

/** How long a trip's recording is kept, then its object goes and its row is marked deleted. */
export const TRIP_RECORDING_KEEP_DAYS = 30;

/**
 * Trip voice recordings: one row per uploaded 5-minute segment. A segment is
 * recorded once (rideId + segmentIndex): a repeated "uploaded" is the same
 * row, and a recorded segment is never given a new upload link.
 */
export const tripRecordingClient = {
  /** Records an uploaded segment; a repeat of the same segment returns the row already there. */
  async recordSegment(data: { rideId: string; driverId: string; segmentIndex: number; objectKey: string; bytes: number; etag?: string | null; durationSec?: number | null }) {
    return prisma.tripRecording.upsert({
      where: { rideId_segmentIndex: { rideId: data.rideId, segmentIndex: data.segmentIndex } },
      create: {
        rideId: data.rideId,
        driverId: data.driverId,
        segmentIndex: data.segmentIndex,
        objectKey: data.objectKey,
        bytes: data.bytes,
        etag: data.etag ?? null,
        durationSec: data.durationSec ?? null,
      },
      update: {},
    });
  },

  /** Was this segment ever recorded (kept or already deleted)? */
  async segmentExists(rideId: string, segmentIndex: number): Promise<boolean> {
    return (await prisma.tripRecording.count({ where: { rideId, segmentIndex } })) > 0;
  },

  /** The next segment the phone should use: one past the highest recorded. */
  async nextSegmentIndex(rideId: string): Promise<number> {
    const last = await prisma.tripRecording.findFirst({ where: { rideId }, orderBy: { segmentIndex: 'desc' }, select: { segmentIndex: true } });
    return last ? last.segmentIndex + 1 : 0;
  },

  async countForRide(rideId: string): Promise<number> {
    return prisma.tripRecording.count({ where: { rideId, deletedAt: null } });
  },

  /** A ride's segments still kept, in order. */
  async listForRide(rideId: string) {
    return prisma.tripRecording.findMany({
      where: { rideId, deletedAt: null },
      orderBy: { segmentIndex: 'asc' },
      select: { id: true, segmentIndex: true, objectKey: true, bytes: true, etag: true, durationSec: true, uploadedAt: true },
    });
  },

  /** Segments past the keep window, oldest first. */
  async listExpired(now = new Date(), limit = 200) {
    const before = new Date(now.getTime() - TRIP_RECORDING_KEEP_DAYS * 24 * 60 * 60 * 1000);
    return prisma.tripRecording.findMany({
      where: { deletedAt: null, createdAt: { lt: before } },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true, objectKey: true },
    });
  },

  async markDeleted(ids: string[], now = new Date()): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await prisma.tripRecording.updateMany({ where: { id: { in: ids }, deletedAt: null }, data: { deletedAt: now } });
    return result.count;
  },

  /** Marks the ride as recorded from now (uploads are accepted only after this). Returns true the first time. */
  async markRideRecording(rideId: string, now = new Date()): Promise<boolean> {
    const result = await prisma.ride.updateMany({ where: { id: rideId, recordingStartedAt: null }, data: { recordingStartedAt: now } });
    return result.count > 0;
  },

  /**
   * Admin list: one row per recorded trip, newest first, with every piece's
   * object key (to find it in R2). `from`/`to` are dates the pieces were
   * uploaded (to: up to the end of that day); `q` matches a ride ID, a trip
   * code (WH-01234 or 1234), or the driver's or rider's name or phone.
   */
  async listRides(input: { from?: Date | null; to?: Date | null; q?: string | null; limit?: number; offset?: number }) {
    const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 50)), 200);
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const q = (input.q ?? '').trim();
    const tripNumber = /^(?:WH-?)?0*(\d{1,9})$/i.exec(q)?.[1];
    const like = `%${q}%`;
    const where = Prisma.sql`WHERE TRUE
      ${input.from ? Prisma.sql`AND tr."uploadedAt" >= ${input.from}` : Prisma.empty}
      ${input.to ? Prisma.sql`AND tr."uploadedAt" < ${input.to}` : Prisma.empty}
      ${q ? Prisma.sql`AND (r.id = ${q} ${tripNumber ? Prisma.sql`OR r."tripNumber" = ${Number(tripNumber)}` : Prisma.empty}
        OR du.name ILIKE ${like} OR du.phone ILIKE ${like} OR ru.name ILIKE ${like} OR ru.phone ILIKE ${like})` : Prisma.empty}`;
    const rows = await prisma.$queryRaw<Array<{
      ride_id: string; trip_number: number | null; recording_started_at: Date | null; completed_at: Date | null; cancelled_at: Date | null;
      driver_name: string | null; driver_phone: string | null; rider_name: string | null; rider_phone: string | null;
      pieces: number; kept: number; bytes: bigint | number; seconds: bigint | number | null; first_at: Date; last_at: Date;
      keys: string[]; total: bigint | number;
    }>>`
      SELECT r.id AS ride_id, r."tripNumber" AS trip_number, r."recordingStartedAt" AS recording_started_at,
             r."completedAt" AS completed_at, r."cancelledAt" AS cancelled_at,
             du.name AS driver_name, du.phone AS driver_phone, ru.name AS rider_name, ru.phone AS rider_phone,
             count(*)::int AS pieces, count(*) FILTER (WHERE tr."deletedAt" IS NULL)::int AS kept,
             sum(tr.bytes) AS bytes, sum(tr."durationSec") AS seconds,
             min(tr."uploadedAt") AS first_at, max(tr."uploadedAt") AS last_at,
             array_agg(tr."objectKey" ORDER BY tr."segmentIndex") AS keys,
             count(*) OVER () AS total
      FROM "TripRecording" tr
      JOIN "Ride" r ON r.id = tr."rideId"
      LEFT JOIN "Driver" d ON d.id = tr."driverId"
      LEFT JOIN "User" du ON du.id = d."userId"
      LEFT JOIN "User" ru ON ru.id = r."riderId"
      ${where}
      GROUP BY r.id, du.name, du.phone, ru.name, ru.phone
      ORDER BY max(tr."uploadedAt") DESC, r.id
      LIMIT ${limit} OFFSET ${offset}`;
    const iso = (value: Date | null) => (value ? value.toISOString() : null);
    return {
      total: rows.length ? Number(rows[0]!.total) : 0,
      items: rows.map((row) => ({
        rideId: row.ride_id,
        tripId: formatTripId(row.trip_number),
        recordingStartedAt: iso(row.recording_started_at),
        endedAt: iso(row.completed_at ?? row.cancelled_at),
        ended: row.completed_at ? 'completed' as const : row.cancelled_at ? 'cancelled' as const : null,
        driverName: row.driver_name,
        driverPhone: row.driver_phone,
        riderName: row.rider_name,
        riderPhone: row.rider_phone,
        pieces: row.pieces,
        kept: row.kept,
        bytes: Number(row.bytes),
        seconds: row.seconds == null ? null : Number(row.seconds),
        firstUploadAt: row.first_at.toISOString(),
        lastUploadAt: row.last_at.toISOString(),
        /** The 30-day sweep deletes the pieces from this moment on. */
        deletesFrom: new Date(row.first_at.getTime() + TRIP_RECORDING_KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString(),
        objectKeys: row.keys,
      })),
    };
  },
};
