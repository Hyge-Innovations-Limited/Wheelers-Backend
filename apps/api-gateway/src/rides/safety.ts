import { SAFETY_GROUPS, safetyCard, safetyCardsFor, safetyTipsFor, type SafetyCard, type SafetyTrip } from '@wheleers/config';
import { prisma } from '@wheleers/db';

/**
 * Rider safety on the ride page and in the app (Timi, 14 Nov 2026): whether
 * the trip is recorded, and the three tips shown before it and after it.
 */
export function safetyView(ride: { id: string; recordingStartedAt?: Date | null }, details: SafetyTrip | string | null = {}) {
  // The plate alone (as callers before the cards passed it), or the trip's details.
  const trip: SafetyTrip = typeof details === 'string' ? { plate: details } : details ?? {};
  return {
    recorded: Boolean(ride.recordingStartedAt),
    // Plain sentences, for apps from before the cards.
    safety: { before: safetyTipsFor(ride.id, 'before', trip.plate), after: safetyTipsFor(ride.id, 'after') },
    // The playful cards (21 Nov 2026): the screen shows the one for where the ride is, and every one under See all.
    safetyCards: safetyCardsFor(trip),
  };
}

/** How long after the end a finished trip still shows its "Before you go" tips. */
export const JUST_FINISHED_MS = 15 * 60_000;

/** The rider's trip that completed in the last 15 minutes, with its "after" tips; null when none. */
export async function justFinishedFor(riderId: string, now = Date.now()): Promise<{ rideId: string; tips: string[]; cards: SafetyCard[] } | null> {
  const ride = await prisma.ride.findFirst({
    where: { riderId, status: 'COMPLETED', completedAt: { gte: new Date(now - JUST_FINISHED_MS) } },
    orderBy: { completedAt: 'desc' },
    select: { id: true },
  }).catch(() => null);
  // The cards for after a trip (phone, wallet, keys first), and the plain sentences for pages from before.
  const after = SAFETY_GROUPS.find((g) => g.keys.includes('keys'))?.keys ?? ['keys'];
  return ride ? { rideId: ride.id, tips: safetyTipsFor(ride.id, 'after'), cards: after.map((key) => safetyCard(key, {})) } : null;
}
