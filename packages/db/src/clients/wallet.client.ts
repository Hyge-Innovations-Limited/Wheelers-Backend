import { prisma }   from '../prisma';
import { Prisma }   from '@prisma/client';
import type { TransactionType } from '@prisma/client';
import { calculateRideFees, pricingVersionOf, splitDeposit } from '@wheleers/config';
import { PLATFORM_USER_ID, bookProviderFee, ensurePlatformWalletId } from './platform-wallet';
import { takeFromBalance } from './wallet-balance';

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

/** walletClient.takeCashRideFees: taken now (applied), or why not. */
export type CashRideFeesResult =
  | { applied: true; driverUserId: string; driverWalletId: string; owedNgn: number; driverBalanceAfterNgn: number; driverPayoutNgn: number }
  | { applied: false; reason: 'no_ride' | 'not_cash' | 'not_finished' | 'no_driver' | 'already_taken' };

const ensurePlatformWallet = (): Promise<string> => ensurePlatformWalletId();
void PLATFORM_USER_ID;

/**
 * The hold itself, inside a transaction the caller owns (walletClient.createRideHold runs it in its own; a group ride
 * runs every seat's in one, so either every seat is held or none is). Throws when the balance does not cover it.
 */
export async function createRideHoldIn(
  tx: TxClient,
  params: { rideId: string; walletId: string; riderId: string; driverUserId?: string; amountNgn: number },
): Promise<RideHoldMutationResult> {
  const { rideId, walletId, riderId, driverUserId, amountNgn } = params;
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

  const wallet = await takeFromBalance(tx, walletId, amountNgn, { lock: true });
  if (!wallet) {
    throw new Error(`Cannot lock ${amountNgn} NGN on wallet ${walletId}: not enough available`);
  }

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

  /**
   * A bank deposit, booked in full and in one transaction:
   *
   *   user wallet      + (amount − Wheelers fee [− provider fee])   DEPOSIT
   *   platform wallet  + Wheelers fee                               PLATFORM_FEE
   *   platform wallet  − provider fee Wheelers absorbs              PROVIDER_FEE
   *
   * The three always sum to the cash that actually reached the provider
   * balance, so ledger and bank cannot drift. Idempotent on the provider's
   * transaction reference: the DEPOSIT row's unique key is the claim, and a
   * replay changes nothing.
   */
  creditDeposit: async (params: {
    walletId:        string;
    amountNgn:       number;
    providerFeeNgn:  number;
    referenceId:     string;
    metadata?:       Record<string, unknown>;
  }): Promise<WalletMutationResult & { split: ReturnType<typeof splitDeposit> }> => {
    const { walletId, amountNgn, providerFeeNgn, referenceId, metadata } = params;
    const split = splitDeposit(amountNgn, providerFeeNgn);

    try {
      const result = await prisma.$transaction(async (tx: TxClient) => {
        const wallet = await tx.wallet.update({
          where: { id: walletId },
          data:  { balanceNgn: { increment: split.userCreditNgn } },
        });
        const txn = await tx.transaction.create({
          data: {
            walletId,
            type:            'DEPOSIT',
            direction:       'CREDIT',
            amountNgn:       split.userCreditNgn,
            balanceAfterNgn: wallet.balanceNgn,
            referenceId,
            metadata: {
              ...(metadata ?? {}),
              grossAmountNgn: amountNgn,
              wheelersFeeNgn: split.platformFeeNgn,
              providerFeeNgn,
            } as Prisma.InputJsonValue,
          },
        });

        if (split.platformFeeNgn > 0) {
          const platformWalletId = await ensurePlatformWalletId(tx);
          const platform = await tx.wallet.update({
            where: { id: platformWalletId },
            data:  { balanceNgn: { increment: split.platformFeeNgn } },
          });
          await tx.transaction.create({
            data: {
              walletId:        platformWalletId,
              type:            'PLATFORM_FEE',
              direction:       'CREDIT',
              amountNgn:       split.platformFeeNgn,
              balanceAfterNgn: platform.balanceNgn,
              referenceId,
              metadata: { kind: 'deposit_fee', depositWalletId: walletId } as Prisma.InputJsonValue,
            },
          });
        }

        await bookProviderFee(tx, {
          amountNgn: split.platformAbsorbsNgn,
          referenceId,
          metadata: { kind: 'deposit_provider_fee', depositWalletId: walletId },
        });

        return { wallet, transaction: txn, applied: true as const };
      });

      return { ...result, split };
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      const existing = await findExistingTransaction(walletId, 'DEPOSIT', 'CREDIT', referenceId);
      const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
      return { wallet, transaction: existing, applied: false, split };
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

        // Checked again as it is taken: a payment in the same instant may have spent it.
        const wallet = await takeFromBalance(tx, walletId, amountNgn);
        if (!wallet) {
          throw new Error(`Insufficient balance on wallet ${walletId}: needs ${amountNgn} NGN`);
        }

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

      const locked = await takeFromBalance(tx, walletId, amountNgn, { lock: true });
      if (!locked) {
        throw new Error(`Cannot lock ${amountNgn} NGN on wallet ${walletId}: not enough available`);
      }
      return locked;
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

  /**
   * Holds still locking money on a ride that ended (cancelled) before
   * `endedBefore`: nothing will ever settle them. The sweeper releases them.
   * (A rider paying for a chosen driver after a search timed out revives the
   * ride within minutes, so the cut-off leaves that window alone.)
   */
  strandedRideHolds: async (endedBefore: Date, limit = 50): Promise<Array<{ rideId: string; riderId: string; amountNgn: number }>> => {
    const rows = await prisma.$queryRaw<Array<{ rideId: string; riderId: string; amountNgn: unknown }>>`
      SELECT h."rideId", h."riderId", h."amountNgn"
      FROM "RideHold" h
      JOIN "Ride" r ON r.id = h."rideId"
      WHERE h.status = 'ACTIVE' AND r.status = 'CANCELLED' AND r."updatedAt" < ${endedBefore}
      ORDER BY r."updatedAt" ASC
      LIMIT ${limit}`;
    return rows.map((row) => ({ rideId: row.rideId, riderId: row.riderId, amountNgn: Number(row.amountNgn) }));
  },

  createRideHold: async (params: {
    rideId: string;
    walletId: string;
    riderId: string;
    driverUserId?: string;
    amountNgn: number;
  }): Promise<RideHoldMutationResult> => {
    const { rideId, walletId } = params;
    // A seat of a group trip is held only by the group's own booking (createRideHoldIn, every seat at once): never
    // by a rider booking a driver alone on it.
    const seat = await prisma.ride.findUnique({ where: { id: rideId }, select: { groupRole: true } }).catch(() => null);
    if (seat?.groupRole === 'SEAT') {
      // Already held by its group's booking: the same as a duplicate (nothing new, nothing wrong).
      const existing = await prisma.rideHold.findUnique({ where: { rideId } }).catch(() => null);
      if (existing && existing.status === 'ACTIVE') {
        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
        return { applied: false, holdAmountNgn: Number(existing.amountNgn), wallet };
      }
      throw new Error(`Ride ${rideId} is a group ride seat: booked by its group only`);
    }

    try {
      return await prisma.$transaction((tx: TxClient) => createRideHoldIn(tx, params));
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
        // By the rules the ride was priced under: a ride agreed before the
        // pricing change still pays its driver what was agreed then.
        const priced = await tx.ride.findUnique({ where: { id: rideId }, select: { pricingVersion: true } });
        const fees = calculateRideFees(effectiveFareNgn, pricingVersionOf(priced?.pricingVersion));
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
            // Tells ride fees apart from deposit fees (kind 'deposit_fee') in the same ledger type,
            // with every line of it: booking fee, commission, WhatsApp fee, VAT, levy.
            metadata: {
              kind: 'ride_fee',
              pricingVersion: fees.pricingVersion,
              bookingFeeNgn: fees.bookingFeeNgn,
              commissionNgn: fees.commissionNgn,
              whatsappFeeNgn: fees.whatsappFeeNgn,
              vatNgn: fees.vatNgn,
              stateLevyNgn: fees.stateLevyNgn,
              // Old name of the booking fee, for readers of older rows.
              serviceFeeNgn: fees.bookingFeeNgn,
            },
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

        // 7. Store the platform's total on the ride record, and every line of it for the dashboard.
        await tx.ride.update({
          where: { id: rideId },
          data: {
            platformFeeNgn: platformFeeNgn,
            commissionNgn: fees.commissionNgn,
            serviceFeeNgn: fees.bookingFeeNgn,
            vatNgn: fees.vatNgn,
            stateLevyNgn: fees.stateLevyNgn,
            whatsappFeeNgn: fees.pricingVersion >= 3 ? fees.whatsappFeeNgn : null,
            feeSplitEstimated: false,
          },
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

      const priced = await prisma.ride.findUnique({ where: { id: rideId }, select: { pricingVersion: true } });
      const fees = calculateRideFees(Number(hold.settledAmountNgn ?? hold.amountNgn), pricingVersionOf(priced?.pricingVersion));
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

  /**
   * A cash ride, finished (Timi, 18 Nov 2026): the rider paid the driver the whole fare in the car, so Wheelers'
   * share (every line a wallet ride pays: WhatsApp fee, VAT, levy, commission, by the ride's pricing version) comes
   * out of the driver's wallet, below zero if it has to. Once per ride: the driver's CASH_RIDE_FEE row is unique per
   * ride, so a redelivered event changes nothing.
   *
   * Only a ride that is really cash and really the driver's: paymentMethod CASH on the row, no group role (a group
   * trip's row is CASH only so no money moves on it; its seats settle by wallet), started (IN_PROGRESS, or COMPLETED
   * when the ride service wrote it first), and the driver is the ride's own, never one named by the caller.
   */
  takeCashRideFees: async (params: { rideId: string; fareNgn: number }): Promise<CashRideFeesResult> => {
    const { rideId, fareNgn } = params;
    try {
      await ensurePlatformWallet();
      return await prisma.$transaction(async (tx: TxClient): Promise<CashRideFeesResult> => {
        const ride = await tx.ride.findUnique({
          where: { id: rideId },
          select: {
            status: true, paymentMethod: true, groupRole: true, groupTripId: true, pricingVersion: true,
            driver: { select: { userId: true } },
          },
        });
        if (!ride) return { applied: false, reason: 'no_ride' };
        if (ride.paymentMethod !== 'CASH' || ride.groupRole !== null || ride.groupTripId !== null) return { applied: false, reason: 'not_cash' };
        if (ride.status !== 'IN_PROGRESS' && ride.status !== 'COMPLETED') return { applied: false, reason: 'not_finished' };
        const driverUserId = ride.driver?.userId;
        if (!driverUserId) return { applied: false, reason: 'no_driver' };

        const fees = calculateRideFees(Math.max(0, fareNgn), pricingVersionOf(ride.pricingVersion));
        const owedNgn = fees.platformTotalNgn;

        // The one write that may take a wallet below zero, and the only one that marks it as allowed to (mayOwe).
        const driverWallet = await tx.wallet.upsert({
          where:  { userId: driverUserId },
          create: { userId: driverUserId, balanceNgn: -owedNgn, mayOwe: true },
          update: { balanceNgn: { decrement: owedNgn }, mayOwe: true },
        });
        await tx.transaction.create({
          data: {
            walletId: driverWallet.id,
            type: 'CASH_RIDE_FEE',
            direction: 'DEBIT',
            amountNgn: owedNgn,
            balanceAfterNgn: driverWallet.balanceNgn,
            referenceId: rideId,
            metadata: { fareNgn: fees.fareNgn, collectedInCashNgn: fees.fareNgn } as Prisma.InputJsonValue,
          },
        });

        if (owedNgn > 0) {
          const platformWallet = await tx.wallet.update({
            where: { userId: PLATFORM_USER_ID },
            data: { balanceNgn: { increment: owedNgn } },
          });
          await tx.transaction.create({
            data: {
              walletId: platformWallet.id,
              type: 'PLATFORM_FEE',
              direction: 'CREDIT',
              amountNgn: owedNgn,
              balanceAfterNgn: platformWallet.balanceNgn,
              referenceId: rideId,
              // A ride fee like a wallet ride's (kind 'ride_fee', so every fee report counts it), marked as owed by the
              // driver from a cash trip (it was not held from a rider).
              metadata: {
                kind: 'ride_fee',
                paidInCash: true,
                pricingVersion: fees.pricingVersion,
                bookingFeeNgn: fees.bookingFeeNgn,
                commissionNgn: fees.commissionNgn,
                whatsappFeeNgn: fees.whatsappFeeNgn,
                vatNgn: fees.vatNgn,
                stateLevyNgn: fees.stateLevyNgn,
                serviceFeeNgn: fees.bookingFeeNgn,
                driverWalletId: driverWallet.id,
              } as Prisma.InputJsonValue,
            },
          });
        }

        // The driver earned the fare less the fees, in cash: the earnings stat counts it as a wallet ride's would.
        await tx.driver.updateMany({
          where: { userId: driverUserId },
          data:  { totalEarningsNgn: { increment: fees.driverPayoutNgn } },
        });
        await tx.ride.update({
          where: { id: rideId },
          data: {
            platformFeeNgn: owedNgn,
            commissionNgn: fees.commissionNgn,
            serviceFeeNgn: fees.bookingFeeNgn,
            vatNgn: fees.vatNgn,
            stateLevyNgn: fees.stateLevyNgn,
            whatsappFeeNgn: fees.pricingVersion >= 3 ? fees.whatsappFeeNgn : null,
            feeSplitEstimated: false,
          },
        });

        return {
          applied: true,
          driverUserId,
          driverWalletId: driverWallet.id,
          owedNgn,
          driverBalanceAfterNgn: Number(driverWallet.balanceNgn),
          driverPayoutNgn: fees.driverPayoutNgn,
        };
      });
    } catch (error) {
      // Taken already (the driver's CASH_RIDE_FEE row for this ride exists): nothing new.
      if (isUniqueConstraintError(error)) return { applied: false, reason: 'already_taken' };
      throw error;
    }
  },

  adjustRideHold: async (params: {
    rideId: string;
    targetAmountNgn: number;
    /** Change the hold only if it is exactly this now (an undo must not overwrite what happened since). */
    expectedAmountNgn?: number;
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
      // To the kobo, so the guarded subtract never works on a float tail.
      const deltaNgn = Math.round((normalizedTarget - currentAmountNgn) * 100) / 100;

      if (params.expectedAmountNgn !== undefined && Math.abs(currentAmountNgn - params.expectedAmountNgn) >= 0.01) {
        const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: hold.walletId } });
        return { wallet, holdAmountNgn: currentAmountNgn, previousHoldAmountNgn: currentAmountNgn, applied: false as const };
      }

      if (Math.abs(deltaNgn) < 0.01) {
        const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: hold.walletId } });
        return {
          wallet,
          holdAmountNgn: currentAmountNgn,
          previousHoldAmountNgn: currentAmountNgn,
          applied: false as const,
        };
      }

      // Safe against a withdrawal, a charge or another change at the same moment. The hold is changed only
      // if it is still ACTIVE and still the amount just read (one guarded update: a hold that was charged or
      // moved changes zero rows, and nothing is written). A raise then takes the money from the wallet's balance
      // in one statement that checks the balance as it subtracts, so the balance can never go below zero.
      const moved = await tx.rideHold.updateMany({
        where: { rideId, status: 'ACTIVE', amountNgn: hold.amountNgn },
        data: { amountNgn: normalizedTarget },
      });
      if (moved.count === 0) {
        const fresh = await tx.rideHold.findUnique({ where: { rideId } });
        const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: hold.walletId } });
        return {
          wallet,
          holdAmountNgn: fresh ? Number(fresh.amountNgn) : currentAmountNgn,
          previousHoldAmountNgn: currentAmountNgn,
          applied: false as const,
        };
      }

      let wallet;
      if (deltaNgn > 0) {
        wallet = await takeFromBalance(tx, hold.walletId, deltaNgn, { lock: true });
        if (!wallet) {
          // Throwing undoes the hold update above: nothing changed.
          throw new Error(
            `Insufficient balance on wallet ${hold.walletId} to adjust ride hold by ${deltaNgn} NGN`,
          );
        }
      } else {
        const back = -deltaNgn;
        const released = await tx.wallet.updateMany({
          where: { id: hold.walletId, lockedNgn: { gte: back } },
          data: { balanceNgn: { increment: back }, lockedNgn: { decrement: back } },
        });
        if (released.count === 0) {
          throw new Error(`Wallet ${hold.walletId} has less locked than the ride hold to release by ${back} NGN`);
        }
        wallet = await tx.wallet.findUniqueOrThrow({ where: { id: hold.walletId } });
      }

      return {
        wallet,
        holdAmountNgn: normalizedTarget,
        previousHoldAmountNgn: currentAmountNgn,
        applied: true as const,
      };
    });
  },

  /** The ride's hold as it stands: whose driver it is for, and whether it still holds money. */
  rideHoldOf: (rideId: string) =>
    prisma.rideHold.findUnique({ where: { rideId }, select: { status: true, driverUserId: true, amountNgn: true, createdAt: true, updatedAt: true } }),

  /**
   * `forDriverUserId`: release only a hold taken for that driver. A late
   * "that driver was busy" must never release the hold of the driver the
   * rider chose after them.
   */
  cancelRideHold: async (rideId: string, forDriverUserId?: string): Promise<RideHoldMutationResult | null> => {
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
        where: { rideId, status: 'ACTIVE', ...(forDriverUserId ? { OR: [{ driverUserId: forDriverUserId }, { driverUserId: null }] } : {}) },
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
