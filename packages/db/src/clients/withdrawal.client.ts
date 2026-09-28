import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { bookPlatformFee, bookProviderFee, ensurePlatformWalletId } from './platform-wallet';

/**
 * Our payout reference IS the withdrawal request id, so a webhook or a
 * reconciler can find the row before attachPayout has written anything.
 */
const byReference = (reference: string) => ({
  OR: [{ providerReference: reference }, { id: reference }],
});

type TxClient = Prisma.TransactionClient;

function asJson(value: Record<string, unknown> | undefined) {
  return (value ?? undefined) as Prisma.InputJsonValue | undefined;
}

/** What went (or goes) to the bank. Before the fee existed, that was the whole amount. */
export function payoutAmountOf(request: { payoutAmountNgn?: unknown; requestedAmountNgn: unknown }): number {
  return Number(request.payoutAmountNgn ?? request.requestedAmountNgn);
}

export const withdrawalClient = {
  reserve: async (input: {
    userId: string;
    walletId: string;
    amountNgn: number;
    bankAccountNumber: string;
    bankAccountName: string;
    bankNetworkId: string;
    /** Wheelers' fee, taken from amountNgn. The bank is sent amountNgn less this. */
    feeNgn?: number;
  }) =>
    prisma.$transaction(async (tx: TxClient) => {
      const wallet = await tx.wallet.findUniqueOrThrow({
        where: { id: input.walletId },
      });

      const availableNgn = Number(wallet.balanceNgn);
      if (availableNgn < input.amountNgn) {
        throw new Error('You have insufficient balance for this withdrawal.');
      }

      const withdrawalId = randomUUID();
      const reservationId = randomUUID();

      const updatedWallet = await tx.wallet.update({
        where: { id: input.walletId },
        data: {
          balanceNgn: { decrement: input.amountNgn },
          lockedNgn: { increment: input.amountNgn },
        },
      });

      const reservation = await tx.walletReservation.create({
        data: {
          id: reservationId,
          walletId: input.walletId,
          userId: input.userId,
          kind: 'WITHDRAWAL',
          status: 'ACTIVE',
          amountNgn: input.amountNgn,
          referenceId: withdrawalId,
        },
      });

      const request = await tx.withdrawalRequest.create({
        data: {
          id: withdrawalId,
          userId: input.userId,
          walletId: input.walletId,
          reservationId,
          status: 'FUNDS_RESERVED',
          requestedAmountNgn: input.amountNgn,
          reservedAmountNgn: input.amountNgn,
          feeNgn: input.feeNgn ?? 0,
          payoutAmountNgn: Math.round((input.amountNgn - (input.feeNgn ?? 0)) * 100) / 100,
          bankAccountNumber: input.bankAccountNumber,
          bankAccountName: input.bankAccountName,
          bankNetworkId: input.bankNetworkId,
        },
      });

      return {
        wallet: updatedWallet,
        reservation,
        request,
      };
    }),

  attachPayout: async (input: {
    withdrawalRequestId: string;
    providerPayoutId: string;
    providerReference: string;
    providerPayload?: Record<string, unknown>;
    expiresAt?: Date;
  }) => {
    // A payout.failed webhook can land before this write — never resurrect a
    // request that has already reached a terminal state; only record the
    // provider identifiers on it.
    const advanced = await prisma.withdrawalRequest.updateMany({
      where: {
        id: input.withdrawalRequestId,
        status: { in: ['PENDING', 'FUNDS_RESERVED'] },
      },
      data: {
        providerPayoutId: input.providerPayoutId,
        providerReference: input.providerReference,
        providerPayload: asJson(input.providerPayload),
        expiresAt: input.expiresAt,
        status: 'PAYOUT_CREATED',
      },
    });

    if (advanced.count === 0) {
      await prisma.withdrawalRequest.updateMany({
        where: { id: input.withdrawalRequestId },
        data: {
          providerPayoutId: input.providerPayoutId,
          providerReference: input.providerReference,
          providerPayload: asJson(input.providerPayload),
          expiresAt: input.expiresAt,
        },
      });
    }

    return prisma.withdrawalRequest.findUnique({
      where: { id: input.withdrawalRequestId },
    });
  },

  markProcessing: async (providerReference: string) =>
    prisma.withdrawalRequest.updateMany({
      where: {
        ...byReference(providerReference),
        status: {
          in: ['FUNDS_RESERVED', 'PAYOUT_CREATED', 'PENDING'],
        },
      },
      data: {
        status: 'PROCESSING',
      },
    }),

  releaseFailedRequest: async (params: {
    withdrawalRequestId?: string;
    providerReference?: string;
    failureReason: string;
    status: 'FAILED' | 'EXPIRED' | 'CANCELLED';
  }) =>
    prisma.$transaction(async (tx: TxClient) => {
      const request = await tx.withdrawalRequest.findFirst({
        where: params.withdrawalRequestId
          ? { id: params.withdrawalRequestId }
          : byReference(params.providerReference ?? ''),
        include: {
          reservation: true,
          wallet: true,
        },
      });

      if (!request) {
        return null;
      }

      if (request.status === 'SETTLED') {
        return request;
      }

      // ATOMIC CLAIM. The webhook, the status poll, payment-service and the
      // reconciler can all release the same request; a read-then-write let
      // two of them each credit the wallet. Only the claimer moves money.
      const claimed = await tx.walletReservation.updateMany({
        where: { id: request.reservationId, status: 'ACTIVE' },
        data: { status: 'RELEASED', releasedAt: new Date() },
      });
      if (claimed.count === 1) {
        await tx.wallet.update({
          where: { id: request.walletId },
          data: {
            balanceNgn: { increment: Number(request.reservedAmountNgn) },
            lockedNgn: { decrement: Number(request.reservedAmountNgn) },
          },
        });
      }

      return tx.withdrawalRequest.update({
        where: { id: request.id },
        data: {
          status: params.status,
          failureReason: params.failureReason,
          failedAt: new Date(),
          releasedAt: new Date(),
        },
      });
    }),

  /**
   * `providerFeeNgn` is what the provider charged Wheelers for the transfer.
   * It comes out of the platform wallet in the same transaction, so the
   * ledger falls by exactly what the provider balance fell by.
   */
  settle: async (providerReference: string, opts: { providerFeeNgn?: number } = {}) => {
    try {
      return await prisma.$transaction(async (tx: TxClient) => {
        const request = await tx.withdrawalRequest.findFirst({
          where: byReference(providerReference),
          include: {
            reservation: true,
            wallet: true,
          },
        });

        if (!request) {
          return null;
        }

        if (request.status === 'SETTLED') {
          return request;
        }

        // Same atomic claim as release: settle ∥ release used to pay out AND
        // refund, and lockedNgn went negative.
        const claimed = await tx.walletReservation.updateMany({
          where: { id: request.reservationId, status: 'ACTIVE' },
          data: { status: 'CONSUMED', consumedAt: new Date() },
        });
        if (claimed.count === 0) {
          throw new Error('Withdrawal reservation is not active.');
        }

        const wallet = await tx.wallet.update({
          where: { id: request.walletId },
          data: {
            lockedNgn: { decrement: request.reservedAmountNgn },
          },
        });

        await tx.transaction.create({
          data: {
            walletId: request.walletId,
            type: 'WITHDRAWAL',
            direction: 'DEBIT',
            amountNgn: request.reservedAmountNgn,
            balanceAfterNgn: wallet.balanceNgn,
            referenceId: request.id,
            metadata: asJson({
              providerReference: request.providerReference,
              providerPayoutId: request.providerPayoutId,
              bankNetworkId: request.bankNetworkId,
            }),
          },
        });

        // The fee is earned only when the money has left: a failed withdrawal
        // is released whole, fee included, and never reaches this line.
        await bookPlatformFee(tx, {
          amountNgn: Number(request.feeNgn ?? 0),
          referenceId: request.id,
          metadata: { kind: 'withdrawal_fee', withdrawalId: request.id },
        });

        const providerFeeNgn = Math.max(0, Number(opts.providerFeeNgn ?? 0));
        await bookProviderFee(tx, {
          amountNgn: providerFeeNgn,
          referenceId: request.id,
          metadata: { kind: 'transfer_fee', withdrawalId: request.id },
        });

        return tx.withdrawalRequest.update({
          where: { id: request.id },
          data: {
            status: 'SETTLED',
            settledAt: new Date(),
            failureReason: null,
            providerReference: request.providerReference ?? request.id,
            providerFeeNgn,
          },
      });
      });
    } catch (error) {
      // Concurrent settle race: another call already settled this withdrawal.
      // Return the settled request instead of crashing.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const settled = await prisma.withdrawalRequest.findFirst({
          where: byReference(providerReference),
        });
        if (settled?.status === 'SETTLED') return settled;
      }
      throw error;
    }
  },

  /**
   * In-flight withdrawals that have gone quiet. Two kinds of row end up here:
   * a payout whose webhook was lost, and a reservation whose create-payout
   * call timed out before anything was recorded (FUNDS_RESERVED, no payout
   * id). Both lock the user's money until someone asks the provider what
   * really happened — the reference is the request id, so both can be asked.
   */
  /**
   * A withdrawal that was paid, then sent back by the bank. The money is in
   * Wheelers' Paystack balance again, so the user gets back all of it, fee
   * included (the withdrawal never happened), and the fee Wheelers booked at
   * settlement is taken back out of the platform wallet. Both in one step,
   * once: a second webhook for the same reversal changes nothing.
   */
  refundReversed: async (withdrawalId: string, reason: string): Promise<{ applied: boolean }> => {
    const referenceId = `withdrawal-reversed-${withdrawalId}`;
    try {
      await prisma.$transaction(async (tx: TxClient) => {
        const request = await tx.withdrawalRequest.findUniqueOrThrow({ where: { id: withdrawalId } });
        const amountNgn = Number(request.requestedAmountNgn);
        const wallet = await tx.wallet.update({
          where: { id: request.walletId },
          data: { balanceNgn: { increment: amountNgn } },
        });
        await tx.transaction.create({
          data: {
            walletId: request.walletId,
            type: 'REFUND',
            direction: 'CREDIT',
            amountNgn,
            balanceAfterNgn: wallet.balanceNgn,
            referenceId,
            metadata: asJson({ withdrawalId, reason }),
          },
        });

        const feeNgn = Number(request.feeNgn ?? 0);
        if (feeNgn > 0) {
          const platformWalletId = await ensurePlatformWalletId(tx);
          const platform = await tx.wallet.update({
            where: { id: platformWalletId },
            data: { balanceNgn: { decrement: feeNgn } },
          });
          await tx.transaction.create({
            data: {
              walletId: platformWalletId,
              type: 'PLATFORM_FEE',
              direction: 'DEBIT',
              amountNgn: feeNgn,
              balanceAfterNgn: platform.balanceNgn,
              referenceId,
              metadata: asJson({ kind: 'withdrawal_fee', withdrawalId, reversed: true }),
            },
          });
        }
      });
      return { applied: true };
    } catch (error) {
      // Already refunded: the ledger's (wallet, type, direction, reference) rule refused the copy.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return { applied: false };
      throw error;
    }
  },

  findStaleInFlight: (olderThan: Date, limit = 50) =>
    prisma.withdrawalRequest.findMany({
      where: {
        status: { in: ['FUNDS_RESERVED', 'PAYOUT_CREATED', 'PROCESSING'] },
        updatedAt: { lt: olderThan },
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    }),

  listByUser: (userId: string, limit = 20, cursor?: string) =>
    prisma.withdrawalRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),

  findById: (id: string) =>
    prisma.withdrawalRequest.findUnique({
      where: { id },
    }),

  findByProviderReference: (providerReference: string) =>
    prisma.withdrawalRequest.findFirst({
      where: byReference(providerReference),
    }),

  /**
   * The account this person last withdrew to: the one that paid out, or,
   * failing that, one still on its way (its account was checked with the bank
   * when it was entered). A failed withdrawal's account is not offered again:
   * it may be the reason it failed.
   */
  lastPayoutAccount: async (userId: string) => {
    const pick = (statuses: Array<'SETTLED' | 'PROCESSING' | 'PAYOUT_CREATED' | 'FUNDS_RESERVED'>) => prisma.withdrawalRequest.findFirst({
      where: { userId, status: { in: statuses } },
      orderBy: { createdAt: 'desc' },
      select: { bankNetworkId: true, bankAccountNumber: true, bankAccountName: true, createdAt: true },
    });
    return (await pick(['SETTLED'])) ?? (await pick(['PROCESSING', 'PAYOUT_CREATED', 'FUNDS_RESERVED']));
  },
};
