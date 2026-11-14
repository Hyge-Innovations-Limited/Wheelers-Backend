import { safetyTipsFor } from '@wheleers/config';
import { prisma } from '@wheleers/db';

/**
 * Rider safety on the ride page and in the app (Timi, 14 Nov 2026): whether
 * the trip is recorded, and the three tips shown before it and after it.
 */
export function safetyView(ride: { id: string; recordingStartedAt?: Date | null }, plate?: string | null) {
  return {
    recorded: Boolean(ride.recordingStartedAt),
    safety: { before: safetyTipsFor(ride.id, 'before', plate), after: safetyTipsFor(ride.id, 'after') },
  };
}

/** How long after the end a finished trip still shows its "Before you go" tips. */
export const JUST_FINISHED_MS = 15 * 60_000;

/** The rider's trip that completed in the last 15 minutes, with its "after" tips; null when none. */
export async function justFinishedFor(riderId: string, now = Date.now()): Promise<{ rideId: string; tips: string[] } | null> {
  const ride = await prisma.ride.findFirst({
    where: { riderId, status: 'COMPLETED', completedAt: { gte: new Date(now - JUST_FINISHED_MS) } },
    orderBy: { completedAt: 'desc' },
    select: { id: true },
  }).catch(() => null);
  return ride ? { rideId: ride.id, tips: safetyTipsFor(ride.id, 'after') } : null;
}
