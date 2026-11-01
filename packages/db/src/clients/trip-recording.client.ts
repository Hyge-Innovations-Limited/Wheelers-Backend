import { prisma } from '../prisma';

/** How long a trip's recording is kept, then its objects and rows go. */
export const TRIP_RECORDING_KEEP_DAYS = 30;

/**
 * Trip voice recordings: one row per uploaded 5-minute segment. A segment is
 * recorded once (rideId + segmentIndex), so a repeated "uploaded" is the same
 * row, never a second one.
 */
export const tripRecordingClient = {
  /** Records an uploaded segment; a repeat of the same segment returns the row already there. */
  async recordSegment(data: { rideId: string; driverId: string; segmentIndex: number; objectKey: string; bytes: number; durationSec?: number | null }) {
    return prisma.tripRecording.upsert({
      where: { rideId_segmentIndex: { rideId: data.rideId, segmentIndex: data.segmentIndex } },
      create: {
        rideId: data.rideId,
        driverId: data.driverId,
        segmentIndex: data.segmentIndex,
        objectKey: data.objectKey,
        bytes: data.bytes,
        durationSec: data.durationSec ?? null,
      },
      update: {},
    });
  },

  async countForRide(rideId: string): Promise<number> {
    return prisma.tripRecording.count({ where: { rideId, deletedAt: null } });
  },

  /** A ride's segments still kept, in order. */
  async listForRide(rideId: string) {
    return prisma.tripRecording.findMany({
      where: { rideId, deletedAt: null },
      orderBy: { segmentIndex: 'asc' },
      select: { id: true, segmentIndex: true, objectKey: true, bytes: true, durationSec: true, uploadedAt: true },
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

  /** Marks the ride as recorded (the rider is told). Returns true the first time. */
  async markRideRecording(rideId: string): Promise<boolean> {
    const result = await prisma.ride.updateMany({ where: { id: rideId, recordingId: null }, data: { recordingId: rideId } });
    return result.count > 0;
  },
};
