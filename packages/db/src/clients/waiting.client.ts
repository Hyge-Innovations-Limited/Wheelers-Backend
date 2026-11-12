import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { takeFromBalance } from './wallet-balance';

type TxClient = Prisma.TransactionClient;

/** The wallet reservation that holds a ride's waiting fee between the start and the end of the trip. */
export const waitingReference = (rideId: string): string => `waiting:${rideId}`;

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface WaitingRecord {
  minutes: number;
  feeNgn: number;
  /** True: taken from the rider's wallet (held now, paid to the driver when the trip ends). */
  paid: boolean;
}

/**
 * Waiting time on a ride (packages/config waiting.ts has the rule): the meter
 * stop, the fee written once at the start, the rider's money held for it, and
 * that money paid to the driver at the end (or given back if the trip is
 * cancelled). Every step that moves money claims a row first, so a retried
 * start or a redelivered event never moves it twice.
 */
export const waitingClient = {
  async state(rideId: string) {
    return prisma.ride.findUnique({
      where: { id: rideId },
      select: {
        id: true, riderId: true, status: true, paymentMethod: true,
        arrivedAt: true, waitingStoppedAt: true, waitingMinutes: true, waitingFeeNgn: true, waitingPaid: true, startedAt: true,
      },
    });
  },

  /**
   * Rides whose free waiting ran out between `from` and `to` while the driver still waits (for the one
   * "free waiting is over" message). Few rows: only rides in ARRIVED, and only a short window of them.
   */
  async freeTimeEnded(from: Date, to: Date, freeSeconds: number, limit = 200) {
    return prisma.ride.findMany({
      where: {
        status: 'ARRIVED',
        waitingStoppedAt: null,
        arrivedAt: { gte: new Date(from.getTime() - freeSeconds * 1000), lte: new Date(to.getTime() - freeSeconds * 1000) },
      },
      select: { id: true, riderId: true, arrivedAt: true },
      take: limit,
    });
  },

  /** Stops the meter at `at`, once, while the driver is still waiting. The time it stopped (this one or an earlier one). */
  async stopMeter(rideId: string, at: Date): Promise<Date | null> {
    await prisma.ride.updateMany({ where: { id: rideId, status: 'ARRIVED', waitingStoppedAt: null }, data: { waitingStoppedAt: at } });
    const ride = await prisma.ride.findUnique({ where: { id: rideId }, select: { waitingStoppedAt: true } });
    return ride?.waitingStoppedAt ?? null;
  },

  /**
   * At the start: the fee is held from a wallet rider's balance when it covers it, and written on the ride.
   * When it does not cover it (or the ride is cash), it is written as not paid only with `allowUnpaid`;
   * otherwise nothing is written and `recorded` is false (the driver is asked first).
   * Written once: a second call gives back what the first wrote.
   */
  async recordAtStart(params: { rideId: string; minutes: number; feeNgn: number; allowUnpaid: boolean }): Promise<{ recorded: boolean } & WaitingRecord> {
    const feeNgn = round2(params.feeNgn);
    return prisma.$transaction(async (tx: TxClient) => {
      const ride = await tx.ride.findUnique({
        where: { id: params.rideId },
        select: { riderId: true, paymentMethod: true, waitingFeeNgn: true, waitingMinutes: true, waitingPaid: true },
      });
      if (!ride) return { recorded: false, minutes: params.minutes, feeNgn, paid: false };
      if (ride.waitingFeeNgn !== null) {
        return { recorded: true, minutes: ride.waitingMinutes ?? 0, feeNgn: Number(ride.waitingFeeNgn), paid: ride.waitingPaid === true };
      }

      let paid = false;
      if (ride.paymentMethod === 'WALLET' && feeNgn > 0) {
        const wallet = await tx.wallet.findUnique({ where: { userId: ride.riderId }, select: { id: true } });
        // Taken only if the balance covers all of it, in one statement that checks as it subtracts.
        const held = wallet ? await takeFromBalance(tx, wallet.id, feeNgn, { lock: true }) : null;
        if (held && wallet) {
          await tx.walletReservation.create({
            data: { walletId: wallet.id, userId: ride.riderId, kind: 'WAITING_FEE', status: 'ACTIVE', amountNgn: feeNgn, referenceId: waitingReference(params.rideId), metadata: { rideId: params.rideId, minutes: params.minutes } },
          });
          paid = true;
        }
      }
      if (!paid && !params.allowUnpaid) return { recorded: false, minutes: params.minutes, feeNgn, paid: false };

      // Written only if nothing was written in between; otherwise this whole transaction is undone (the hold too).
      const wrote = await tx.ride.updateMany({
        where: { id: params.rideId, waitingFeeNgn: null },
        data: { waitingMinutes: params.minutes, waitingFeeNgn: feeNgn, waitingPaid: paid },
      });
      if (wrote.count === 0) throw new Error(`Waiting fee for ${params.rideId} was written at the same moment`);
      return { recorded: true, minutes: params.minutes, feeNgn, paid };
    }).catch(async (error: unknown) => {
      // The other writer won: what it wrote stands.
      const ride = await prisma.ride.findUnique({ where: { id: params.rideId }, select: { waitingFeeNgn: true, waitingMinutes: true, waitingPaid: true } });
      if (ride?.waitingFeeNgn != null) return { recorded: true, minutes: ride.waitingMinutes ?? 0, feeNgn: Number(ride.waitingFeeNgn), paid: ride.waitingPaid === true };
      throw error;
    });
  },

  /** The trip ended: the held fee goes to the driver, all of it. Null when nothing was held (or it was already settled). */
  async payDriver(rideId: string, driverUserId: string): Promise<{ amountNgn: number } | null> {
    return prisma.$transaction(async (tx: TxClient) => {
      const reservation = await tx.walletReservation.findUnique({ where: { referenceId: waitingReference(rideId) } });
      if (!reservation || reservation.kind !== 'WAITING_FEE') return null;
      const claimed = await tx.walletReservation.updateMany({
        where: { id: reservation.id, status: 'ACTIVE' },
        data: { status: 'CONSUMED', consumedAt: new Date() },
      });
      if (claimed.count === 0) return null;

      const amountNgn = Number(reservation.amountNgn);
      const rider = await tx.wallet.update({ where: { id: reservation.walletId }, data: { lockedNgn: { decrement: amountNgn } } });
      await tx.transaction.create({
        data: { walletId: rider.id, type: 'WAITING_FEE', direction: 'DEBIT', amountNgn, balanceAfterNgn: rider.balanceNgn, referenceId: rideId },
      });
      const driver = await tx.wallet.upsert({
        where: { userId: driverUserId },
        create: { userId: driverUserId, balanceNgn: amountNgn },
        update: { balanceNgn: { increment: amountNgn } },
      });
      await tx.transaction.create({
        data: { walletId: driver.id, type: 'WAITING_FEE', direction: 'CREDIT', amountNgn, balanceAfterNgn: driver.balanceNgn, referenceId: rideId },
      });
      await tx.driver.updateMany({ where: { userId: driverUserId }, data: { totalEarningsNgn: { increment: amountNgn } } });
      return { amountNgn };
    });
  },

  /** The trip was cancelled after it started: the held fee goes back to the rider. Null when nothing was held. */
  async giveBack(rideId: string): Promise<{ amountNgn: number } | null> {
    return prisma.$transaction(async (tx: TxClient) => {
      const reservation = await tx.walletReservation.findUnique({ where: { referenceId: waitingReference(rideId) } });
      if (!reservation || reservation.kind !== 'WAITING_FEE') return null;
      const claimed = await tx.walletReservation.updateMany({
        where: { id: reservation.id, status: 'ACTIVE' },
        data: { status: 'RELEASED', releasedAt: new Date() },
      });
      if (claimed.count === 0) return null;
      const amountNgn = Number(reservation.amountNgn);
      await tx.wallet.update({
        where: { id: reservation.walletId },
        data: { balanceNgn: { increment: amountNgn }, lockedNgn: { decrement: amountNgn } },
      });
      await tx.ride.update({ where: { id: rideId }, data: { waitingPaid: false } });
      return { amountNgn };
    });
  },
};
