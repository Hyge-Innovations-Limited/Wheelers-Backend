import { randomUUID } from 'crypto';
import { prisma } from '../prisma';

/**
 * When drivers went on shift and came off: the record behind "hours online"
 * and "drivers on at each hour" in the admin analytics.
 *
 * A shift opens when a driver goes ONLINE (or is put ON_RIDE) and closes when
 * they go OFFLINE. The app announces "online" again on every reconnect, so
 * opening is idempotent: a driver who is already on shift keeps the shift they
 * have. The database allows one open shift per driver, so two processes
 * hearing the same driver cannot open two.
 *
 * Nothing here throws. A driver must be able to go online even if this table
 * cannot be written.
 */

/** An open shift whose driver has been silent this long is over; coming online starts a new one. */
export const SHIFT_STALE_AFTER_MS = 10 * 60_000;

export type ShiftEndReason = 'manual' | 'app_closed' | 'inactivity' | 'admin' | 'stale';

interface Before {
  /** The driver's status before this change, if known. */
  status?: string | null;
  /** When the driver was last heard from before this change. */
  seenAt?: Date | null;
}

const onShift = (status: string | null | undefined) => status === 'ONLINE' || status === 'ON_RIDE';

export const driverShiftClient = {
  /** The driver is on shift as of `now`. Opens a shift unless they are already in one. */
  async open(driverId: string, before: Before = {}, now = new Date()): Promise<void> {
    try {
      const current = await prisma.driverShift.findFirst({
        where: { driverId, endedAt: null },
        select: { id: true, startedAt: true },
      });
      if (current) {
        const heardRecently = before.seenAt != null && now.getTime() - before.seenAt.getTime() < SHIFT_STALE_AFTER_MS;
        if (onShift(before.status) && heardRecently) return; // same shift, still going
        // The old shift never heard its end (a crash, a dead phone). It ended when the driver was last heard from.
        const endedAt = before.seenAt && before.seenAt > current.startedAt ? before.seenAt : current.startedAt;
        await prisma.driverShift.update({ where: { id: current.id }, data: { endedAt, endReason: 'stale' } });
      }
      await prisma.$executeRaw`
        INSERT INTO "DriverShift" ("id", "driverId", "startedAt")
        VALUES (${randomUUID()}, ${driverId}, ${now})
        ON CONFLICT ("driverId") WHERE "endedAt" IS NULL DO NOTHING`;
    } catch (error) {
      console.warn('[driver-shift] could not open a shift', {
        driverId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  /** The driver is off shift. `endedAt` is when they were last really there, which for a dead phone is before now. */
  async close(driverId: string, reason: ShiftEndReason, endedAt = new Date()): Promise<void> {
    try {
      await prisma.$executeRaw`
        UPDATE "DriverShift"
        SET "endedAt" = GREATEST("startedAt", ${endedAt}), "endReason" = ${reason}
        WHERE "driverId" = ${driverId} AND "endedAt" IS NULL`;
    } catch (error) {
      console.warn('[driver-shift] could not close a shift', {
        driverId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  /** A driver's shifts, newest first. */
  list: (driverId: string, since: Date, limit = 200) =>
    prisma.driverShift.findMany({
      where: { driverId, startedAt: { gte: since } },
      orderBy: { startedAt: 'desc' },
      take: limit,
    }),
};
