import { prisma } from '../prisma';

/**
 * Analytics capture for the Studio (Timi, 18 Nov 2026): who a search was sent to and what they did, every rider price
 * change with what was on the table, and how many free drivers the search found. All of it is beside the ride flow,
 * never in it: every write here swallows its own error (a lost analytics row, never a lost request), and callers do
 * not wait on it.
 */
const quiet = (what: string) => (error: unknown) => {
  console.warn(`[studio-capture] ${what} not recorded`, { error: error instanceof Error ? error.message : String(error) });
};

export const studioCaptureClient = {
  /** The search went out (round 1) or out again (each price change): one row per driver per round. */
  notePings(rideId: string, driverIds: string[], round: number): Promise<void> {
    if (driverIds.length === 0) return Promise.resolve();
    return prisma.searchPing
      .createMany({ data: [...new Set(driverIds)].map((driverId) => ({ rideId, driverId, round })), skipDuplicates: true })
      .then(() => undefined, quiet('pings'));
  },

  /** The latest round sent to this ride so far (0: none recorded). */
  async lastRound(rideId: string): Promise<number> {
    const row = await prisma.searchPing.findFirst({ where: { rideId }, orderBy: { round: 'desc' }, select: { round: true } }).catch(() => null);
    return row?.round ?? 0;
  },

  /** A driver answered: their latest unanswered ping on this ride takes the answer. */
  noteResponse(rideId: string, driverId: string, response: 'bid' | 'declined'): Promise<void> {
    return prisma.searchPing
      .findFirst({ where: { rideId, driverId, response: null }, orderBy: { round: 'desc' }, select: { id: true } })
      .then((row) => (row ? prisma.searchPing.update({ where: { id: row.id }, data: { response, respondedAt: new Date() } }) : null))
      .then(() => undefined, quiet('ping answer'));
  },

  /** The rider moved their price, with the open offers at that moment. */
  async notePriceChange(rideId: string, fromNgn: number, toNgn: number): Promise<void> {
    if (!Number.isFinite(fromNgn) || !Number.isFinite(toNgn) || Math.round(fromNgn) === Math.round(toNgn)) return;
    try {
      const open = await prisma.driverBid.findMany({ where: { rideId, status: 'PENDING' }, select: { amountNgn: true } });
      const lowest = open.length ? Math.min(...open.map((b) => Number(b.amountNgn))) : null;
      await prisma.ridePriceChange.create({
        data: { rideId, fromNgn: Math.round(fromNgn), toNgn: Math.round(toNgn), offersOpen: open.length, lowestOfferNgn: lowest === null ? null : Math.round(lowest) },
      });
    } catch (error) {
      quiet('price change')(error);
    }
  },

  /**
   * The rider's device the request came from (written once): the latest of that kind seen for them, the app for an
   * app request, the ride page (else the WhatsApp row) for a WhatsApp one.
   */
  async noteRideDevice(rideId: string, riderId: string, channel: string | undefined): Promise<void> {
    try {
      const sources = channel === 'APP' ? ['app'] : channel === 'WHATSAPP' ? ['web', 'whatsapp'] : [];
      for (const source of sources) {
        const device = await prisma.userDevice.findFirst({ where: { userId: riderId, source }, orderBy: { lastSeenAt: 'desc' }, select: { id: true } });
        if (!device) continue;
        await prisma.ride.updateMany({ where: { id: rideId, deviceId: null }, data: { deviceId: device.id } });
        return;
      }
    } catch (error) {
      quiet('ride device')(error);
    }
  },

  /** The driver's phone a bid came from: their latest app device. */
  noteBidDevice(bidId: string, driverUserId: string): Promise<void> {
    return prisma.userDevice
      .findFirst({ where: { userId: driverUserId, source: 'app' }, orderBy: { lastSeenAt: 'desc' }, select: { id: true } })
      .then((device) => (device ? prisma.driverBid.updateMany({ where: { id: bidId, deviceId: null }, data: { deviceId: device.id } }) : null))
      .then(() => undefined, quiet('bid device'));
  },

  /** How many free drivers the search found at its start (written once). */
  noteDriversFound(rideId: string, count: number): Promise<void> {
    return prisma.ride
      .updateMany({ where: { id: rideId, driversFoundAtSearch: null }, data: { driversFoundAtSearch: count } })
      .then(() => undefined, quiet('drivers found'));
  },
};
