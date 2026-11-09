import { randomInt } from 'crypto';
import { prisma } from '../prisma';

/**
 * The trip code: 4 digits the rider gives the driver, who cannot start the
 * trip without them. Issued once per ride, when a driver is assigned; two
 * paths asking at the same moment get the same code. Shown only to the rider.
 */
export const tripCodeClient = {
  /** The ride's code, issuing it now if it has none. */
  async ensure(rideId: string): Promise<string | null> {
    const code = String(randomInt(0, 10_000)).padStart(4, '0');
    await prisma.ride.updateMany({ where: { id: rideId, tripCode: null }, data: { tripCode: code } });
    const ride = await prisma.ride.findUnique({ where: { id: rideId }, select: { tripCode: true } });
    return ride?.tripCode ?? null;
  },

  async state(rideId: string) {
    return prisma.ride.findUnique({
      where: { id: rideId },
      select: {
        id: true, riderId: true, driverId: true, status: true,
        tripCode: true, tripCodeVerifiedAt: true, tripCodeWrongTries: true, tripCodeUnlockedBy: true, tripCodeUnlockedAt: true,
      },
    });
  },

  async markVerified(rideId: string): Promise<void> {
    await prisma.ride.updateMany({ where: { id: rideId, tripCodeVerifiedAt: null }, data: { tripCodeVerifiedAt: new Date() } });
  },

  async addWrongTry(rideId: string): Promise<number> {
    const ride = await prisma.ride.update({ where: { id: rideId }, data: { tripCodeWrongTries: { increment: 1 } }, select: { tripCodeWrongTries: true } });
    return ride.tripCodeWrongTries;
  },

  /** Support lets the trip start without the code. Who and when are kept. */
  async unlock(rideId: string, by: string): Promise<boolean> {
    const result = await prisma.ride.updateMany({
      where: { id: rideId, tripCodeUnlockedAt: null },
      data: { tripCodeUnlockedBy: by, tripCodeUnlockedAt: new Date() },
    });
    return result.count > 0;
  },
};
