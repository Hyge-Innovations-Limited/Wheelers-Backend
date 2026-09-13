import { prisma }   from '../prisma';
import { Prisma }   from '@prisma/client';
import type { TransactionType } from '@prisma/client';
import { calculateRideFees } from '@wheleers/config';

// The type of the transactional client Prisma passes into $transaction callbacks
type TxClient = Prisma.TransactionClient;

interface WalletMutationResult {
  wallet: Awaited<ReturnType<typeof prisma.wallet.update>>;
  transaction: Awaited<ReturnType<typeof prisma.transaction.create>>;
  applied: boolean;
}

interface RideHoldMutationResult {
  wallet: Awaited<ReturnType<typeof prisma.wallet.update>>;
  holdAmountNgn: number;
  applied: boolean;
}

interface RideHoldWithPayoutResult {
  riderWallet: Awaited<ReturnType<typeof prisma.wallet.update>>;
  driverWallet: Awaited<ReturnType<typeof prisma.wallet.update>>;
  riderTransaction: Awaited<ReturnType<typeof prisma.transaction.create>>;
  driverTransaction: Awaited<ReturnType<typeof prisma.transaction.create>>;
  holdAmountNgn: number;
  platformFeeNgn: number;
  applied: boolean;
}

const PLATFORM_USER_ID = '00000000-0000-0000-0000-000000000001';

async function ensurePlatformWallet(): Promise<string> {
  const existing = await prisma.wallet.findUnique({ where: { userId: PLATFORM_USER_ID } });
  if (existing) return existing.id;

  // Create the platform user + wallet if they don't exist
  await prisma.user.upsert({
    where: { id: PLATFORM_USER_ID },
    create: {
      id: PLATFORM_USER_ID,
      privyDid: 'platform:wheelers',
      role: 'RIDER',
      name: 'Wheelers Platform',
    },
    update: {},
  });

  const wallet = await prisma.wallet.create({
    data: { userId: PLATFORM_USER_ID },
  });

  return wallet.id;
}

export const walletClient = {

  // ── Reads ──────────────────────────────────────────────────────────────────

  findByUserId: (userId: string) =>
    prisma.wallet.findUnique({ where: { userId } }),

  findByUserIdOrThrow: (userId: string) =>
    prisma.wallet.findUniqueOrThrow({ where: { userId } }),

  // Driver payouts within a period, queried by date rather than by slicing the
  // N most recent transactions — a busy driver's payouts are interleaved with
  // deposits and withdrawals, so a fixed window silently drops earnings.
  findDriverPayoutsSince: (walletId: string, since: Date) =>
    prisma.transaction.findMany({
      where: {
        walletId,
        type:      'DRIVER_PAYOUT',
        direction: 'CREDIT',
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
    }),

  findTransactions: (walletId: string, limit = 30, cursor?: string) =>
    prisma.transaction.findMany({
      where:   { walletId },
      orderBy: { createdAt: 'desc' },
      take:    limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  create: (userId: string) =>
    prisma.wallet.upsert({
      where: { userId },
      update: {},
      create: { userId },
    }),

  // ── Atomic balance operations ──────────────────────────────────────────────

  credit: async (params: {
    walletId:    string;
    amountNgn:   number;
    type:        TransactionType;
    referenceId: string;
    metadata?:   Record<string, unknown>;
  }): Promise<WalletMutationResult> => {
    const { walletId, amountNgn, type, referenceId, metadata } = params;

    try {
      const result = await prisma.$transaction(async (tx: TxClient) => {
        const wallet = await tx.wallet.update({
          where: { id: walletId },
          data:  { balanceNgn: { increment: amountNgn } },
        });

        const txn = await tx.transaction.create({
          data: {
            walletId,
            type,
            direction:      'CREDIT',
            amountNgn,
            balanceAfterNgn: wallet.balanceNgn,
            referenceId,
            metadata:       (metadata ?? undefined) as Prisma.InputJsonValue | undefined,
          },
        });

        return { wallet, transaction: txn, applied: true as const };
      });

      return result;
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      const existing = await findExistingTransaction(walletId, type, 'CREDIT', referenceId);
      const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });

      return {
        wallet,
        transaction: existing,
        applied: false,
      };
    }
  },

  debit: async (params: {
    walletId:    string;
    amountNgn:   number;
    type:        TransactionType;
    referenceId: string;
    metadata?:   Record<string, unknown>;
  }): Promise<WalletMutationResult> => {
    const { walletId, amountNgn, type, referenceId, metadata } = params;

    try {
      const result = await prisma.$transaction(async (tx: TxClient) => {
        const current = await tx.wallet.findUniqueOrThrow({
          where: { id: walletId },
        });

        const available = Number(current.balanceNgn);
        if (available < amountNgn) {
          throw new Error(
            `Insufficient balance on wallet ${walletId}: ` +
            `has ${available} NGN, needs ${amountNgn} NGN`,
          );
        }

        const wallet = await tx.wallet.update({
          where: { id: walletId },
          data:  { balanceNgn: { decrement: amountNgn } },
        });

        const txn = await tx.transaction.create({
          data: {
            walletId,
            type,
            direction:      'DEBIT',
            amountNgn,
            balanceAfterNgn: wallet.balanceNgn,
            referenceId,
            metadata:       (metadata ?? undefined) as Prisma.InputJsonValue | undefined,
          },
        });

        return { wallet, transaction: txn, applied: true as const };
      });

      return result;
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      const existing = await findExistingTransaction(walletId, type, 'DEBIT', referenceId);
      const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });

      return {
        wallet,
        transaction: existing,
        applied: false,
      };
    }
  },

  lockFunds: (walletId: string, amountNgn: number) =>
    prisma.$transaction(async (tx: TxClient) => {
      const current = await tx.wallet.findUniqueOrThrow({
        where: { id: walletId },
      });

      if (Number(current.balanceNgn) < amountNgn) {
        throw new Error(
          `Cannot lock ${amountNgn} NGN on wallet ${walletId}: ` +
          `only ${current.balanceNgn} available`,
        );
      }

      return tx.wallet.update({
        where: { id: walletId },
        data: {
          balanceNgn: { decrement: amountNgn },
          lockedNgn:  { increment: amountNgn },
        },
      });
    }),

  unlockFunds: (walletId: string, amountNgn: number) =>
    prisma.wallet.update({
      where: { id: walletId },
      data: {
        lockedNgn:  { decrement: amountNgn },
        balanceNgn: { increment: amountNgn },
      },
    }),

  // ── Ride Hold Operations ──────────────────────────────────────────────────

  createRideHold: async (params: {
    rideId: string;
    walletId: string;
    riderId: string;
    driverUserId?: string;
    amountNgn: number;
  }): Promise<RideHoldMutationResult> => {
    const { rideId, walletId, riderId, driverUserId, amountNgn } = params;

    try {
      return await prisma.$transaction(async (tx: TxClient) => {
        // Duplicate-hold check MUST come before the balance check: the first
        // hold locks the funds, so a second attempt (gateway pre-holds, the
        // wallet-service consumer re-holds on RIDE_OFFER_ACCEPTED) fails the
        // balance check and throws before the unique constraint could catch
        // it — surfacing as a fake CRITICAL 'ride running unsecured'.
        const existing = await tx.rideHold.findUnique({ where: { rideId } });
        if (existing && existing.status !== 'RELEASED') {
          const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } });
          return { wallet, holdAmountNgn: Number(existing.amountNgn), applied: false as const };
        }
        // A RELEASED row means an earlier driver dropped and the ride was
        // re-matched. Treating it as "already held" let the new match run
        // with nothing locked and settlement then found no ACTIVE hold.
        const rearm = existing?.status === 'RELEASED';

        const current = await tx.wallet.findUniqueOrThrow({
          where: { id: walletId },
        });

        if (Number(current.balanceNgn) < amountNgn) {
          throw new Error(
            `Cannot lock ${amountNgn} NGN on wallet ${walletId}: ` +
            `only ${current.balanceNgn} available`,
          );
        }

        const wallet = await tx.wallet.update({
          where: { id: walletId },
          data: {
            balanceNgn: { decrement: amountNgn },
            lockedNgn: { increment: amountNgn },
          },
        });

        if (rearm) {
          const reclaimed = await tx.rideHold.updateMany({
            where: { rideId, status: 'RELEASED' },
            data: { status: 'ACTIVE', walletId, riderId, driverUserId, amountNgn, settledAt: null, settledAmountNgn: null },
          });
          if (reclaimed.count === 0) {
            throw new Error(`Ride hold for ${rideId} changed state while being re-armed`);
          }
        } else {
          await tx.rideHold.create({
            data: {
              rideId,
              walletId,
              riderId,
              driverUserId,
              amountNgn,
            },
          });
        }

        return { wallet, holdAmountNgn: amountNgn, applied: true as const };
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
      const hold = await prisma.rideHold.findUniqueOrThrow({ where: { rideId } });
      return { wallet, holdAmountNgn: Number(hold.amountNgn), applied: false };
    }
  },

  /**
   * Complete a ride hold: unlock rider's hold, debit rider, credit driver.
   * This is the core ride settlement operation.
   */
  completeRideHoldWithDriverPayout: async (params: {
    rideId: string;
    fareNgn: number;
    driverUserId: string;
  }): Promise<RideHoldWithPayoutResult | null> => {
    const { rideId, fareNgn, driverUserId } = params;

    try {
      // Ensure platform wallet exists before entering the transaction
      await ensurePlatformWallet();

      return await prisma.$transaction(async (tx: TxClient) => {
        const hold = await tx.rideHold.findUnique({ where: { rideId } });
        if (!hold) return null;

        // ATOMIC CLAIM — same race as cancelRideHold: a redelivered or
        // concurrent RIDE_COMPLETED must not settle (and pay the driver)
        // twice. Claiming the ACTIVE→CHARGED flip first makes every money
        // move below exactly-once.
        const claimed = await tx.rideHold.updateMany({
          where: { rideId, status: 'ACTIVE' },
          data: {
            status: 'CHARGED',
            settledAmountNgn: fareNgn,
            settledAt: new Date(),
          },
        });
        if (claimed.count === 0) {
          throw new Error(`Ride hold for ${rideId} is not ACTIVE (already settled or released)`);
        }

        // 1. Unlock rider's hold
        const unlockedRiderWallet = await tx.wallet.update({
          where: { id: hold.walletId },
          data: {
            lockedNgn: { decrement: hold.amountNgn },
            balanceNgn: { increment: hold.amountNgn },
          },
        });

        // 2. Calculate fees — rider's offer is inclusive of all fees. If the
        // fare came in above what was held and the rider has nothing else,
        // settle for what is there rather than throwing: a throw rolled the
        // claim back and left the money locked and the driver unpaid forever.
        const availableNgn = Number(unlockedRiderWallet.balanceNgn);
        const effectiveFareNgn = Math.min(fareNgn, Math.max(availableNgn, Number(hold.amountNgn)));
        if (effectiveFareNgn < fareNgn) {
          console.error('[wallet] ride settled below fare — rider short after hold', {
            rideId,
            fareNgn,
            heldNgn: Number(hold.amountNgn),
            availableNgn,
            settledNgn: effectiveFareNgn,
          });
          await tx.rideHold.update({ where: { rideId }, data: { settledAmountNgn: effectiveFareNgn } });
        }
        const fees = calculateRideFees(effectiveFareNgn);
        const riderTotalNgn = fees.totalNgn;
        const platformFeeNgn = fees.platformTotalNgn;
        const driverPayoutNgn = fees.driverPayoutNgn;

        // 3. Debit rider (their offer amount)
        if (availableNgn < riderTotalNgn) {
          throw new Error(
            `Insufficient balance on rider wallet ${hold.walletId} after unlocking: ` +
            `has ${unlockedRiderWallet.balanceNgn} NGN, needs ${riderTotalNgn} NGN`,
          );
        }

        const riderWallet = await tx.wallet.update({
          where: { id: hold.walletId },
          data: { balanceNgn: { decrement: riderTotalNgn } },
        });

        const riderTransaction = await tx.transaction.create({
          data: {
            walletId: hold.walletId,
            type: 'RIDE_PAYMENT',
            direction: 'DEBIT',
            amountNgn: riderTotalNgn,
            balanceAfterNgn: riderWallet.balanceNgn,
            referenceId: rideId,
          },
        });

        // 4. Credit driver (fare minus all deductions).
        // Upsert rather than update: a driver with no wallet row would otherwise
        // abort the whole transaction, leaving the rider's funds locked forever.
        const driverWallet = await tx.wallet.upsert({
          where:  { userId: driverUserId },
          create: { userId: driverUserId, balanceNgn: driverPayoutNgn },
          update: { balanceNgn: { increment: driverPayoutNgn } },
        });

        const driverTransaction = await tx.transaction.create({
          data: {
            walletId: driverWallet.id,
            type: 'DRIVER_PAYOUT',
            direction: 'CREDIT',
            amountNgn: driverPayoutNgn,
            balanceAfterNgn: driverWallet.balanceNgn,
            referenceId: rideId,
          },
        });

        // 5. Credit platform wallet with all fees
        const platformWallet = await tx.wallet.update({
          where: { userId: PLATFORM_USER_ID },
          data: { balanceNgn: { increment: platformFeeNgn } },
        });

        await tx.transaction.create({
          data: {
            walletId: platformWallet.id,
            type: 'PLATFORM_FEE',
            direction: 'CREDIT',
            amountNgn: platformFeeNgn,
            balanceAfterNgn: platformWallet.balanceNgn,
            referenceId: rideId,
          },
        });

        // 6. Update driver earnings.
        // updateMany, not update: a missing Driver row is a stats problem, and
        // must not roll back a settlement that has already moved real money.
        const earningsUpdate = await tx.driver.updateMany({
          where: { userId: driverUserId },
          data:  { totalEarningsNgn: { increment: driverPayoutNgn } },
        });

        if (earningsUpdate.count === 0) {
          console.warn(
            '[wallet-client] settled a ride for a user with no Driver row — earnings stat not updated',
            { rideId, driverUserId, driverPayoutNgn },
          );
        }

        // 7. Store platform fee on the ride record
        await tx.ride.update({
          where: { id: rideId },
          data: { platformFeeNgn: platformFeeNgn },
        });

        return {
          riderWallet,
          driverWallet,
          riderTransaction,
          driverTransaction,
          holdAmountNgn: Number(hold.amountNgn),
          platformFeeNgn: Number(platformFeeNgn),
          applied: true as const,
        };
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      const hold = await prisma.rideHold.findUniqueOrThrow({ where: { rideId } });
      const riderWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: hold.walletId } });
      const driverWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: driverUserId } });
      const riderTxn = await findExistingTransaction(hold.walletId, 'RIDE_PAYMENT', 'DEBIT', rideId);
      const driverTxn = await findExistingTransaction(driverWallet.id, 'DRIVER_PAYOUT', 'CREDIT', rideId);

      const fees = calculateRideFees(Number(hold.settledAmountNgn ?? hold.amountNgn));
      return {
        riderWallet,
        driverWallet,
        riderTransaction: riderTxn,
        driverTransaction: driverTxn,
        holdAmountNgn: Number(hold.amountNgn),
        platformFeeNgn: fees.platformTotalNgn,
        applied: false,
      };
    }
  },

  adjustRideHold: async (params: {
    rideId: string;
    targetAmountNgn: number;
  }): Promise<(RideHoldMutationResult & { previousHoldAmountNgn: number }) | null> => {
    const { rideId, targetAmountNgn } = params;

    return prisma.$transaction(async (tx: TxClient) => {
      const hold = await tx.rideHold.findUnique({ where: { rideId } });

      if (!hold || hold.status !== 'ACTIVE') {
        if (!hold) return null;
        const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: hold.walletId } });
        return {
          wallet,
          holdAmountNgn: Number(hold.amountNgn),
          previousHoldAmountNgn: Number(hold.amountNgn),
          applied: false as const,
        };
      }

      const currentAmountNgn = Number(hold.amountNgn);
      const normalizedTarget = Math.max(0, targetAmountNgn);
      const deltaNgn = normalizedTarget - currentAmountNgn;

      if (Math.abs(deltaNgn) < 0.01) {
        const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: hold.walletId } });
        return {
          wallet,
          holdAmountNgn: currentAmountNgn,
          previousHoldAmountNgn: currentAmountNgn,
          applied: false as const,
        };
      }

      if (deltaNgn > 0) {
        const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: hold.walletId } });
        if (Number(wallet.balanceNgn) < deltaNgn) {
          throw new Error(
            `Insufficient balance on wallet ${hold.walletId} to adjust ride hold by ${deltaNgn} NGN`,
          );
        }
      }

      const wallet = await tx.wallet.update({
        where: { id: hold.walletId },
        data: {
          balanceNgn: { increment: -deltaNgn },
          lockedNgn: { increment: deltaNgn },
        },
      });

      await tx.rideHold.update({
        where: { rideId },
        data: { amountNgn: normalizedTarget },
      });

      return {
        wallet,
        holdAmountNgn: normalizedTarget,
        previousHoldAmountNgn: currentAmountNgn,
        applied: true as const,
      };
    });
  },

  cancelRideHold: async (rideId: string): Promise<RideHoldMutationResult | null> => {
    return prisma.$transaction(async (tx: TxClient) => {
      const hold = await tx.rideHold.findUnique({ where: { rideId } });
      if (!hold) return null;

      // ATOMIC CLAIM. Both the gateway and wallet-service release holds on
      // RIDE_CANCELLED, and the old read-then-write check let them race:
      // both read ACTIVE, both credited the wallet — riders were refunded
      // TWICE and lockedNgn went negative. The conditional update is the
      // gate: Postgres row-locks the hold, the loser re-evaluates after the
      // winner commits, matches zero rows, and moves no money.
      const claimed = await tx.rideHold.updateMany({
        where: { rideId, status: 'ACTIVE' },
        data: { status: 'RELEASED', settledAt: new Date() },
      });

      if (claimed.count === 0) {
        const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: hold.walletId } });
        return { wallet, holdAmountNgn: Number(hold.amountNgn), applied: false as const };
      }

      const wallet = await tx.wallet.update({
        where: { id: hold.walletId },
        data: {
          lockedNgn: { decrement: hold.amountNgn },
          balanceNgn: { increment: hold.amountNgn },
        },
      });

      return { wallet, holdAmountNgn: Number(hold.amountNgn), applied: true as const };
    });
  },
};

async function findExistingTransaction(
  walletId: string,
  type: TransactionType,
  direction: 'CREDIT' | 'DEBIT',
  referenceId: string,
) {
  return prisma.transaction.findFirstOrThrow({
    where: {
      walletId,
      type,
      direction,
      referenceId,
    },
  });
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
