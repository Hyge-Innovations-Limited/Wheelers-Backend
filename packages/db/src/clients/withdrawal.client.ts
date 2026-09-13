import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

type TxClient = Prisma.TransactionClient;

function asJson(value: Record<string, unknown> | undefined) {
  return (value ?? undefined) as Prisma.InputJsonValue | undefined;
}

export const withdrawalClient = {
  reserve: async (input: {
    userId: string;
    walletId: string;
    amountNgn: number;
    bankAccountNumber: string;
    bankAccountName: string;
    bankNetworkId: string;
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
    pouchPayoutId: string;
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
        pouchPayoutId: input.pouchPayoutId,
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
          pouchPayoutId: input.pouchPayoutId,
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
        providerReference,
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
          : { providerReference: params.providerReference },
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

  settle: async (providerReference: string) => {
    try {
      return await prisma.$transaction(async (tx: TxClient) => {
        const request = await tx.withdrawalRequest.findFirst({
          where: { providerReference },
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
              pouchPayoutId: request.pouchPayoutId,
              bankNetworkId: request.bankNetworkId,
            }),
          },
        });

        return tx.withdrawalRequest.update({
          where: { id: request.id },
          data: {
            status: 'SETTLED',
            settledAt: new Date(),
            failureReason: null,
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
          where: { providerReference },
        });
        if (settled?.status === 'SETTLED') return settled;
      }
      throw error;
    }
  },

  /**
   * In-flight withdrawals that have gone quiet — payout created or processing
   * with no status change for a while. These are the rows a lost webhook
   * leaves behind (rider's money locked, no resolution), so a periodic
   * reconciliation sweep re-checks them against the provider.
   */
  findStaleInFlight: (olderThan: Date, limit = 50) =>
    prisma.withdrawalRequest.findMany({
      where: {
        status: { in: ['PAYOUT_CREATED', 'PROCESSING'] },
        updatedAt: { lt: olderThan },
        pouchPayoutId: { not: null },
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
    prisma.withdrawalRequest.findUnique({
      where: { providerReference },
    }),
};
