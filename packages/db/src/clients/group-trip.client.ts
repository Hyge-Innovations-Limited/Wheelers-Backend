import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { createRideHoldIn, walletClient } from './wallet.client';

type TxClient = Prisma.TransactionClient;

/**
 * Group ride trips (Timi, 17 Nov 2026). A group trip is a TRIP ride (the one the driver bids on and drives, owned by
 * the Wheelers group account) and the riders' own rides as its SEATS. Every step that touches more than one seat is
 * one transaction: all the seats or none.
 */

/**
 * Every ride but a group TRIP (the driver's job; its riders' seats are the rides), for counts and lists. Rides with no
 * group role are kept: `groupRole <> 'TRIP'` alone would drop them (NULL), so both are said. Wrapped in AND so it
 * spreads into a where that has its own OR.
 */
export const NOT_GROUP_TRIP = { AND: [{ OR: [{ groupRole: null }, { groupRole: { not: 'TRIP' } }] }] } satisfies Prisma.RideWhereInput;

const LIVE = ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'] as const;
const SEARCHING = ['REQUESTED', 'MATCHING'] as const;

export interface SeatToBook {
  rideId: string;
  riderId: string;
  seatPriceNgn: number;
}

export type BookSeatsResult =
  | { ok: true }
  | { ok: false; reason: 'busy' }
  | { ok: false; reason: 'short'; shortRideIds: string[] }
  | { ok: false; reason: 'seat_moved'; rideId: string };

export const groupTripClient = {
  /** The riders' searches become the trip's seats: every one still searching and in no other group, or none. */
  async linkSeats(tripId: string, seatRideIds: string[]): Promise<boolean> {
    return prisma.$transaction(async (tx: TxClient) => {
      for (const id of seatRideIds) {
        const wrote = await tx.ride.updateMany({
          where: { id, status: { in: [...SEARCHING] }, driverId: null, groupTripId: null },
          data: { groupTripId: tripId, groupRole: 'SEAT' },
        });
        if (wrote.count === 0) throw new Error('seat moved on');
      }
      return true;
    }).catch(() => false);
  },

  /** These seats leave the trip (still searching on their own). Returns the seats let go. */
  async unlinkSeats(tripId: string, seatRideIds?: string[]): Promise<number> {
    const wrote = await prisma.ride.updateMany({
      where: { groupTripId: tripId, groupRole: 'SEAT', driverId: null, ...(seatRideIds ? { id: { in: seatRideIds } } : {}) },
      data: { groupTripId: null, groupRole: null },
    });
    return wrote.count;
  },

  seatsOf(tripId: string) {
    return prisma.ride.findMany({
      where: { groupTripId: tripId, groupRole: 'SEAT' },
      select: { id: true, riderId: true, status: true, driverId: true, agreedFareNgn: true, pickupAddress: true, destAddress: true, pickupLat: true, pickupLng: true, destLat: true, destLng: true, arrivedAt: true, startedAt: true, completedAt: true, cancelledAt: true },
      orderBy: { createdAt: 'asc' },
    });
  },

  tripOf(tripId: string) {
    return prisma.ride.findFirst({ where: { id: tripId, groupRole: 'TRIP' } });
  },

  /**
   * Book every seat to the driver, at once: the driver row locked (one driver, one job: their other live rides may
   * only be this group's), each seat's price held from that rider's own wallet, each seat assigned. A wallet that is
   * short books nothing and says which; a seat that moved on (cancelled, booked alone) books nothing either.
   */
  async bookSeats(params: { tripId: string; driverId: string; driverUserId: string; seats: SeatToBook[] }): Promise<BookSeatsResult> {
    const { tripId, driverId, driverUserId, seats } = params;
    try {
      return await prisma.$transaction(async (tx: TxClient): Promise<BookSeatsResult> => {
        await tx.$queryRaw`SELECT id FROM "Driver" WHERE id = ${driverId} FOR UPDATE`;
        const other = await tx.ride.findFirst({
          where: { driverId, status: { in: [...LIVE] }, OR: [{ groupTripId: null }, { groupTripId: { not: tripId } }] },
          select: { id: true },
        });
        if (other) return { ok: false, reason: 'busy' };

        // Every wallet first: nothing is held unless every seat can be.
        const wallets = await Promise.all(seats.map((s) => tx.wallet.findUnique({ where: { userId: s.riderId } })));
        const short = seats.filter((s, i) => !wallets[i] || Number(wallets[i]!.balanceNgn) < s.seatPriceNgn).map((s) => s.rideId);
        if (short.length > 0) return { ok: false, reason: 'short', shortRideIds: short };

        for (const [i, seat] of seats.entries()) {
          const assigned = await tx.ride.updateMany({
            where: { id: seat.rideId, riderId: seat.riderId, groupTripId: tripId, groupRole: 'SEAT', status: { in: [...SEARCHING] }, driverId: null },
            data: { driverId, status: 'DRIVER_ASSIGNED', matchedAt: new Date(), agreedFareNgn: new Prisma.Decimal(seat.seatPriceNgn), paymentMethod: 'WALLET' },
          });
          if (assigned.count === 0) throw Object.assign(new Error('seat moved on'), { seatMoved: seat.rideId });
          await createRideHoldIn(tx, { rideId: seat.rideId, walletId: wallets[i]!.id, riderId: seat.riderId, driverUserId, amountNgn: seat.seatPriceNgn });
        }
        return { ok: true };
      }, { maxWait: 10_000, timeout: 15_000 });
    } catch (error) {
      const moved = (error as { seatMoved?: string }).seatMoved;
      if (moved) return { ok: false, reason: 'seat_moved', rideId: moved };
      // A balance that changed between the read and the hold (the hold checks again): short, nothing held.
      if (error instanceof Error && /Cannot lock/.test(error.message)) return { ok: false, reason: 'short', shortRideIds: [] };
      throw error;
    }
  },

  /**
   * The trip was not assigned after all (the driver took another job in between): every seat goes back to searching
   * in the group and its money is let go. Seats a driver already has are only those of this trip and this driver.
   */
  async releaseSeats(tripId: string, driverId: string): Promise<string[]> {
    const seats = await prisma.ride.findMany({ where: { groupTripId: tripId, groupRole: 'SEAT', driverId, status: 'DRIVER_ASSIGNED' }, select: { id: true } });
    const released: string[] = [];
    for (const seat of seats) {
      const wrote = await prisma.ride.updateMany({
        where: { id: seat.id, driverId, status: 'DRIVER_ASSIGNED' },
        data: { driverId: null, status: 'MATCHING', matchedAt: null, agreedFareNgn: null },
      });
      if (wrote.count === 0) continue;
      await walletClient.cancelRideHold(seat.id).catch(() => undefined);
      released.push(seat.id);
    }
    return released;
  },

  /**
   * The driver leaves the trip before anyone got in: each seat they have (not started) leaves the group, its arrival
   * and waiting cleared (a next driver starts fresh). The driver stays on the row: their cancel of each seat then goes
   * the way any driver backing out does (ride-service reopens it without them, the money goes back, the rider hears).
   * Returns the seats unlinked.
   */
  async unlinkForLeave(tripId: string, driverId: string): Promise<Array<{ id: string; riderId: string }>> {
    const pre = ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED'] as const;
    const seats = await prisma.ride.findMany({ where: { groupTripId: tripId, groupRole: 'SEAT', driverId, status: { in: [...pre] } }, select: { id: true, riderId: true } });
    const unlinked: Array<{ id: string; riderId: string }> = [];
    for (const seat of seats) {
      const wrote = await prisma.ride.updateMany({
        where: { id: seat.id, groupTripId: tripId, driverId, status: { in: [...pre] } },
        data: {
          groupTripId: null, groupRole: null, arrivedAt: null,
          waitingStoppedAt: null, waitingRateNgn: null, waitingAgreedAt: null, waitingOfferBy: null, waitingOfferNgn: null, waitingOfferAt: null, waitingOfferCount: 0,
        },
      });
      if (wrote.count > 0) unlinked.push(seat);
    }
    return unlinked;
  },

  /** The trip is over (every seat done or gone, or the driver left before anyone got in): written once. */
  async endTrip(tripId: string, at: Date = new Date(), status: 'COMPLETED' | 'CANCELLED' = 'COMPLETED', by: 'system' | 'driver' = 'system'): Promise<boolean> {
    const wrote = await prisma.ride.updateMany({
      where: { id: tripId, groupRole: 'TRIP', status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      data: status === 'COMPLETED'
        ? { status, completedAt: at }
        : { status, cancelledAt: at, cancelledBy: by, cancelReason: by === 'driver' ? 'The driver left before anyone got in' : 'Every rider in the group cancelled' },
    });
    return wrote.count > 0;
  },

  /** A trip that never got a driver is closed (its seats were let go first). */
  async closeUnbooked(tripId: string, at: Date = new Date()): Promise<boolean> {
    const wrote = await prisma.ride.updateMany({
      where: { id: tripId, groupRole: 'TRIP', driverId: null, status: { in: [...SEARCHING] } },
      data: { status: 'CANCELLED', cancelledAt: at, cancelStage: 'BEFORE_MATCH', cancelReason: 'Group trip without a driver' },
    });
    return wrote.count > 0;
  },
};
