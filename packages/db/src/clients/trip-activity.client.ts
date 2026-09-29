import { prisma } from '../prisma';

/**
 * What happened around each trip, for the admin export: the chat, the calls,
 * the trip code, and its Stellar Testnet transfers. Loaded for many trips at
 * once (a query per kind of thing per thousand trips, not per trip).
 */

export interface TripActivity {
  riderMessages: number;
  driverMessages: number;
  calls: number;
  callsAnswered: number;
  callsMissed: number;
  callSeconds: number;
  /** none: no code was issued (a group seat, or before codes). */
  tripCode: 'none' | 'waiting' | 'verified' | 'unlocked';
  wrongCodes: number;
  unlockedBy: string | null;
  stellarFareTx: string | null;
  stellarCommissionTx: string | null;
}

const empty = (): TripActivity => ({
  riderMessages: 0, driverMessages: 0, calls: 0, callsAnswered: 0, callsMissed: 0, callSeconds: 0,
  tripCode: 'none', wrongCodes: 0, unlockedBy: null, stellarFareTx: null, stellarCommissionTx: null,
});

function chunks<T>(items: T[], size = 1000): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const tripActivityClient = {
  async forRides(rideIds: string[]): Promise<Map<string, TripActivity>> {
    const byRide = new Map<string, TripActivity>();
    const get = (id: string) => byRide.get(id) ?? (byRide.set(id, empty()), byRide.get(id)!);
    for (const ids of chunks([...new Set(rideIds)])) {
      const [messages, calls, codes, stellar] = await Promise.all([
        prisma.chatMessage.groupBy({ by: ['rideId', 'senderRole'], where: { rideId: { in: ids }, kind: 'text' }, _count: { _all: true } }),
        prisma.tripCall.findMany({ where: { rideId: { in: ids } }, select: { rideId: true, status: true, durationSeconds: true, answeredAt: true } }),
        prisma.ride.findMany({
          where: { id: { in: ids }, tripCode: { not: null } },
          select: { id: true, tripCodeVerifiedAt: true, tripCodeUnlockedAt: true, tripCodeUnlockedBy: true, tripCodeWrongTries: true },
        }),
        prisma.stellarTransfer.findMany({
          where: { rideId: { in: ids }, kind: { in: ['FARE', 'COMMISSION'] }, status: 'CONFIRMED' },
          select: { rideId: true, kind: true, txHash: true },
        }),
      ]);
      for (const m of messages) {
        const a = get(m.rideId);
        if (m.senderRole === 'DRIVER') a.driverMessages = m._count._all;
        else a.riderMessages = m._count._all;
      }
      for (const c of calls) {
        const a = get(c.rideId);
        a.calls += 1;
        if (c.answeredAt) a.callsAnswered += 1;
        if (c.status === 'MISSED' || c.status === 'CANCELLED') a.callsMissed += 1;
        a.callSeconds += c.durationSeconds ?? 0;
      }
      for (const r of codes) {
        const a = get(r.id);
        a.tripCode = r.tripCodeUnlockedAt ? 'unlocked' : r.tripCodeVerifiedAt ? 'verified' : 'waiting';
        a.wrongCodes = r.tripCodeWrongTries;
        a.unlockedBy = r.tripCodeUnlockedBy;
      }
      for (const t of stellar) {
        if (!t.rideId) continue;
        const a = get(t.rideId);
        if (t.kind === 'FARE') a.stellarFareTx = t.txHash;
        else a.stellarCommissionTx = t.txHash;
      }
    }
    return byRide;
  },

  /** Every call on these trips, oldest first, with the trip's number. */
  async callsForRides(rideIds: string[]) {
    const rows = [];
    for (const ids of chunks([...new Set(rideIds)])) {
      rows.push(...await prisma.tripCall.findMany({
        where: { rideId: { in: ids } },
        orderBy: { createdAt: 'asc' },
        include: { ride: { select: { tripNumber: true } } },
      }));
    }
    return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  },

  /** Every Stellar Testnet transfer made in a period, oldest first. */
  stellarBetween(from: Date, to: Date) {
    return prisma.stellarTransfer.findMany({
      where: { createdAt: { gte: from, lt: to } },
      orderBy: { createdAt: 'asc' },
      take: 50_000,
    });
  },
};
