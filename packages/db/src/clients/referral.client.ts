import {
  Prisma,
  ReferralCashbackStatus,
  ReferralCashbackType,
  ReferralCashbackUsageStatus,
  ReferralStatus,
} from '@prisma/client';
import { prisma } from '../prisma';

const RIDE_QUALIFIED_REWARD_NGN = new Prisma.Decimal(1000);
const NO_RIDE_EXPIRED_REWARD_NGN = new Prisma.Decimal(500);
const CASHBACK_FREEZE_DAYS = 30;
const REFERRAL_REWARD_DAYS = 30;
const REFERRAL_CLOSE_DAYS = 60;

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function decimalToNumber(value: Prisma.Decimal | null | undefined): number {
  if (!value) return 0;
  return Number(value.toString());
}

function normalizeReferralCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export const CUSTOM_CODE_MIN = 4;
export const CUSTOM_CODE_MAX = 12;

function toNgnDecimal(value: number): Prisma.Decimal {
  if (!Number.isFinite(value) || value <= 0) {
    return new Prisma.Decimal(0);
  }

  return new Prisma.Decimal(Math.round(value * 100)).div(100);
}

async function sumAvailableCashbackNgn(
  tx: Pick<typeof prisma, 'referralCashback'>,
  userId: string,
  now: Date,
): Promise<Prisma.Decimal> {
  const result = await tx.referralCashback.aggregate({
    where: {
      userId,
      status: ReferralCashbackStatus.AVAILABLE,
      remainingAmountNgn: { gt: new Prisma.Decimal(0) },
      freezesAt: { gt: now },
    },
    _sum: { remainingAmountNgn: true },
  });

  return result._sum.remainingAmountNgn ?? new Prisma.Decimal(0);
}

async function createCashback(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    sourceReferralId: string;
    type: ReferralCashbackType;
    amountNgn: Prisma.Decimal;
    now: Date;
  },
) {
  return tx.referralCashback.create({
    data: {
      userId: input.userId,
      sourceReferralId: input.sourceReferralId,
      type: input.type,
      amountNgn: input.amountNgn,
      remainingAmountNgn: input.amountNgn,
      status: ReferralCashbackStatus.AVAILABLE,
      freezesAt: addDays(input.now, CASHBACK_FREEZE_DAYS),
    },
  });
}

async function settleReferralWithReward(
  tx: Prisma.TransactionClient,
  input: {
    referralId: string;
    status: 'QUALIFIED_RIDE' | 'EXPIRED_NO_RIDE';
    firstRideId?: string;
    amountNgn: Prisma.Decimal;
    type: ReferralCashbackType;
    now: Date;
  },
): Promise<boolean> {
  const referral = await tx.referral.findUnique({
    where: { id: input.referralId },
  });

  if (!referral || referral.status !== ReferralStatus.PENDING) {
    return false;
  }

  const existingCashback = await tx.referralCashback.findFirst({
    where: { sourceReferralId: referral.id },
    select: { id: true },
  });

  if (existingCashback) {
    await tx.referral.update({
      where: { id: referral.id },
      data: {
        status: input.status,
        firstRideId: input.firstRideId ?? referral.firstRideId,
        qualifiedAt:
          input.status === ReferralStatus.QUALIFIED_RIDE
            ? input.now
            : referral.qualifiedAt,
        settledAt: input.now,
      },
    });
    return false;
  }

  await createCashback(tx, {
    userId: referral.referrerId,
    sourceReferralId: referral.id,
    type: input.type,
    amountNgn: input.amountNgn,
    now: input.now,
  });

  await tx.referral.update({
    where: { id: referral.id },
    data: {
      status: input.status,
      firstRideId: input.firstRideId ?? referral.firstRideId,
      qualifiedAt:
        input.status === ReferralStatus.QUALIFIED_RIDE
          ? input.now
          : referral.qualifiedAt,
      settledAt: input.now,
    },
  });

  return true;
}

export const referralClient = {
  normalizeCode: normalizeReferralCode,

  async findSummary(userId: string) {
    const [code, referrals, cashbackGroups, settledUsages, reservedUsages] =
      await Promise.all([
        prisma.referralCode.findUnique({ where: { userId } }),
        prisma.referral.groupBy({
          by: ['status'],
          where: { referrerId: userId },
          _count: { _all: true },
        }),
        prisma.referralCashback.groupBy({
          by: ['status'],
          where: { userId },
          _sum: { remainingAmountNgn: true },
          _count: { _all: true },
        }),
        prisma.referralCashbackUsage.aggregate({
          where: {
            status: ReferralCashbackUsageStatus.SETTLED,
            cashback: { userId },
          },
          _sum: { amountNgn: true },
        }),
        prisma.referralCashbackUsage.aggregate({
          where: {
            status: ReferralCashbackUsageStatus.RESERVED,
            cashback: { userId },
          },
          _sum: { amountNgn: true },
        }),
      ]);

    const referralCount = (status: ReferralStatus) =>
      referrals.find((group) => group.status === status)?._count._all ?? 0;
    const cashbackAmount = (status: ReferralCashbackStatus) =>
      decimalToNumber(
        cashbackGroups.find((group) => group.status === status)?._sum
          .remainingAmountNgn,
      );

    return {
      // Null until the person has created their code: nobody is handed one.
      code: code?.code ?? null,
      availableCashbackNgn: cashbackAmount(ReferralCashbackStatus.AVAILABLE),
      frozenCashbackNgn: cashbackAmount(ReferralCashbackStatus.FROZEN),
      reservedCashbackNgn: decimalToNumber(reservedUsages._sum.amountNgn),
      usedCashbackNgn: decimalToNumber(settledUsages._sum.amountNgn),
      pendingReferrals: referralCount(ReferralStatus.PENDING),
      qualifiedReferrals: referralCount(ReferralStatus.QUALIFIED_RIDE),
      expiredNoRideReferrals: referralCount(ReferralStatus.EXPIRED_NO_RIDE),
      closedReferrals: referralCount(ReferralStatus.CLOSED),
    };
  },

  /**
   * The referral code a person creates for themselves: "TIMI", "RIDEWITHADA".
   * Nobody is handed one. Four to twelve letters and digits, and nobody
   * else's. Creating another replaces the first, which stops working; people
   * who already used it stay referred. Throws a sentence the person can read
   * when it is refused.
   */
  async setCustomCode(userId: string, wanted: string) {
    const code = normalizeReferralCode(wanted);
    if (code.length < CUSTOM_CODE_MIN || code.length > CUSTOM_CODE_MAX) {
      throw new Error(`A referral code is ${CUSTOM_CODE_MIN} to ${CUSTOM_CODE_MAX} letters or numbers.`);
    }
    try {
      return await prisma.referralCode.upsert({
        where: { userId },
        create: { userId, code },
        update: { code, isActive: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // The same person asking twice at once lands here too, with their own code.
        const mine = await prisma.referralCode.findUnique({ where: { userId } });
        if (mine?.code === code) return mine;
        throw new Error('That code is taken. Try another one.');
      }
      throw error;
    }
  },

  /** The code this person created for themselves; null until they create one. */
  async findOwnCode(userId: string): Promise<string | null> {
    const row = await prisma.referralCode.findUnique({ where: { userId }, select: { code: true } });
    return row?.code ?? null;
  },

  /** Has this person already had a referral code added to their account? */
  async hasAppliedCode(userId: string): Promise<boolean> {
    return (await prisma.referral.count({ where: { referredUserId: userId } })) > 0;
  },

  async applyCode(input: { referredUserId: string; code: string; now?: Date }) {
    const now = input.now ?? new Date();
    const code = normalizeReferralCode(input.code);
    if (!code) {
      throw new Error('Referral code is required.');
    }

    return prisma.$transaction(async (tx) => {
      const referralCode = await tx.referralCode.findFirst({
        where: { code, isActive: true },
      });

      if (!referralCode) {
        throw new Error('Referral code was not found.');
      }

      if (referralCode.userId === input.referredUserId) {
        throw new Error('You cannot use your own referral code.');
      }

      const existingReferral = await tx.referral.findUnique({
        where: { referredUserId: input.referredUserId },
      });

      if (existingReferral) {
        throw new Error('A referral code has already been applied.');
      }

      const frozenCashback = await tx.referralCashback.findFirst({
        where: {
          userId: referralCode.userId,
          status: ReferralCashbackStatus.FROZEN,
          remainingAmountNgn: { gt: new Prisma.Decimal(0) },
        },
        orderBy: [{ frozenAt: 'asc' }, { createdAt: 'asc' }],
      });

      const referral = await tx.referral.create({
        data: {
          referrerId: referralCode.userId,
          referredUserId: input.referredUserId,
          code: referralCode.code,
          appliedAt: now,
          expiresAt: addDays(now, REFERRAL_REWARD_DAYS),
          closesAt: addDays(now, REFERRAL_CLOSE_DAYS),
          usedToUnlockCashbackId: frozenCashback?.id,
          unlockedAmountNgn: frozenCashback?.remainingAmountNgn,
        },
      });

      if (frozenCashback) {
        await tx.referralCashback.update({
          where: { id: frozenCashback.id },
          data: {
            status: ReferralCashbackStatus.AVAILABLE,
            frozenAt: null,
            freezesAt: addDays(now, CASHBACK_FREEZE_DAYS),
          },
        });

        await tx.referralCashbackUnlock.create({
          data: {
            referralId: referral.id,
            cashbackId: frozenCashback.id,
            amountNgn: frozenCashback.remainingAmountNgn,
          },
        });
      }

      return {
        referral,
        unlockedCashback: frozenCashback
          ? {
              id: frozenCashback.id,
              amountNgn: decimalToNumber(frozenCashback.remainingAmountNgn),
            }
          : null,
      };
    });
  },

  listReferrals(userId: string, limit = 30) {
    return prisma.referral.findMany({
      where: { referrerId: userId },
      orderBy: { appliedAt: 'desc' },
      take: limit,
      include: {
        referredUser: {
          select: {
            id: true,
            username: true,
            name: true,
            phone: true,
            email: true,
          },
        },
      },
    });
  },

  listCashback(userId: string, limit = 50) {
    return prisma.referralCashback.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        sourceReferral: {
          select: {
            id: true,
            status: true,
            referredUserId: true,
            appliedAt: true,
          },
        },
      },
    });
  },

  async previewRideCashback(input: {
    userId: string;
    fareNgn: number;
    requestedAmountNgn?: number;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const fareNgn = toNgnDecimal(input.fareNgn);
    const requestedAmountNgn =
      input.requestedAmountNgn === undefined
        ? fareNgn
        : toNgnDecimal(input.requestedAmountNgn);
    const available = await sumAvailableCashbackNgn(prisma, input.userId, now);
    const discount = Prisma.Decimal.min(fareNgn, requestedAmountNgn, available);

    return {
      availableCashbackNgn: decimalToNumber(available),
      discountNgn: decimalToNumber(discount),
      payableNgn: decimalToNumber(Prisma.Decimal.max(fareNgn.minus(discount), 0)),
    };
  },

  async reserveRideCashback(input: {
    userId: string;
    rideId: string;
    fareNgn: number;
    requestedAmountNgn?: number;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const fareNgn = toNgnDecimal(input.fareNgn);
    const requestedAmountNgn =
      input.requestedAmountNgn === undefined
        ? fareNgn
        : toNgnDecimal(input.requestedAmountNgn);

    if (fareNgn.lte(0) || requestedAmountNgn.lte(0)) {
      return {
        reservedCashbackNgn: 0,
        payableNgn: decimalToNumber(fareNgn),
        alreadyReserved: false,
      };
    }

    return prisma.$transaction(async (tx) => {
      const existingUsages = await tx.referralCashbackUsage.findMany({
        where: {
          rideId: input.rideId,
          status: {
            in: [
              ReferralCashbackUsageStatus.RESERVED,
              ReferralCashbackUsageStatus.SETTLED,
            ],
          },
        },
        select: { amountNgn: true },
      });

      if (existingUsages.length > 0) {
        const existingAmount = existingUsages.reduce(
          (total, usage) => total.plus(usage.amountNgn),
          new Prisma.Decimal(0),
        );
        return {
          reservedCashbackNgn: decimalToNumber(existingAmount),
          payableNgn: decimalToNumber(Prisma.Decimal.max(fareNgn.minus(existingAmount), 0)),
          alreadyReserved: true,
        };
      }

      const cashbacks = await tx.referralCashback.findMany({
        where: {
          userId: input.userId,
          status: ReferralCashbackStatus.AVAILABLE,
          remainingAmountNgn: { gt: new Prisma.Decimal(0) },
          freezesAt: { gt: now },
        },
        orderBy: [{ freezesAt: 'asc' }, { createdAt: 'asc' }],
      });

      let remainingToReserve = Prisma.Decimal.min(fareNgn, requestedAmountNgn);
      let reservedCashbackNgn = new Prisma.Decimal(0);

      for (const cashback of cashbacks) {
        if (remainingToReserve.lte(0)) break;

        const amountToUse = Prisma.Decimal.min(
          cashback.remainingAmountNgn,
          remainingToReserve,
        );
        if (amountToUse.lte(0)) continue;

        const nextRemaining = cashback.remainingAmountNgn.minus(amountToUse);

        await tx.referralCashbackUsage.create({
          data: {
            cashbackId: cashback.id,
            rideId: input.rideId,
            amountNgn: amountToUse,
            status: ReferralCashbackUsageStatus.RESERVED,
          },
        });

        await tx.referralCashback.update({
          where: { id: cashback.id },
          data: {
            remainingAmountNgn: { decrement: amountToUse },
            status: nextRemaining.lte(0)
              ? ReferralCashbackStatus.USED
              : ReferralCashbackStatus.AVAILABLE,
            usedAt: nextRemaining.lte(0) ? now : cashback.usedAt,
          },
        });

        reservedCashbackNgn = reservedCashbackNgn.plus(amountToUse);
        remainingToReserve = remainingToReserve.minus(amountToUse);
      }

      return {
        reservedCashbackNgn: decimalToNumber(reservedCashbackNgn),
        payableNgn: decimalToNumber(Prisma.Decimal.max(fareNgn.minus(reservedCashbackNgn), 0)),
        alreadyReserved: false,
      };
    });
  },

  async releaseRideCashback(rideId: string, now = new Date()) {
    return prisma.$transaction(async (tx) => {
      const usages = await tx.referralCashbackUsage.findMany({
        where: {
          rideId,
          status: ReferralCashbackUsageStatus.RESERVED,
        },
        include: { cashback: true },
      });

      let releasedCashbackNgn = new Prisma.Decimal(0);

      for (const usage of usages) {
        await tx.referralCashback.update({
          where: { id: usage.cashbackId },
          data: {
            remainingAmountNgn: { increment: usage.amountNgn },
            status: ReferralCashbackStatus.AVAILABLE,
            usedAt: null,
          },
        });
        await tx.referralCashbackUsage.update({
          where: { id: usage.id },
          data: {
            status: ReferralCashbackUsageStatus.RELEASED,
            releasedAt: now,
          },
        });
        releasedCashbackNgn = releasedCashbackNgn.plus(usage.amountNgn);
      }

      return {
        releasedCount: usages.length,
        releasedCashbackNgn: decimalToNumber(releasedCashbackNgn),
      };
    });
  },

  async settleRideCashback(rideId: string, now = new Date()) {
    const result = await prisma.referralCashbackUsage.updateMany({
      where: {
        rideId,
        status: ReferralCashbackUsageStatus.RESERVED,
      },
      data: {
        status: ReferralCashbackUsageStatus.SETTLED,
        settledAt: now,
      },
    });

    return result.count;
  },

  async freezeExpiredCashbacks(now = new Date()) {
    const result = await prisma.referralCashback.updateMany({
      where: {
        status: ReferralCashbackStatus.AVAILABLE,
        remainingAmountNgn: { gt: new Prisma.Decimal(0) },
        freezesAt: { lte: now },
      },
      data: {
        status: ReferralCashbackStatus.FROZEN,
        frozenAt: now,
      },
    });

    return result.count;
  },

  async settleQualifiedRideRewards(now = new Date(), limit = 100) {
    const referrals = await prisma.referral.findMany({
      where: {
        status: ReferralStatus.PENDING,
        appliedAt: { lte: now },
      },
      orderBy: { appliedAt: 'asc' },
      take: limit,
    });

    let settledCount = 0;
    for (const referral of referrals) {
      const ride = await prisma.ride.findFirst({
        where: {
          riderId: referral.referredUserId,
          status: 'COMPLETED',
          completedAt: {
            gte: referral.appliedAt,
            lte: referral.expiresAt,
          },
        },
        orderBy: { completedAt: 'asc' },
        select: { id: true },
      });

      if (!ride) continue;

      const settled = await prisma.$transaction((tx) =>
        settleReferralWithReward(tx, {
          referralId: referral.id,
          status: ReferralStatus.QUALIFIED_RIDE,
          firstRideId: ride.id,
          amountNgn: RIDE_QUALIFIED_REWARD_NGN,
          type: ReferralCashbackType.RIDE_QUALIFIED,
          now,
        }),
      );

      if (settled) settledCount += 1;
    }

    return settledCount;
  },

  async settleExpiredNoRideRewards(now = new Date(), limit = 100) {
    const referrals = await prisma.referral.findMany({
      where: {
        status: ReferralStatus.PENDING,
        expiresAt: { lte: now },
      },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });

    let settledCount = 0;
    for (const referral of referrals) {
      const qualifyingRide = await prisma.ride.findFirst({
        where: {
          riderId: referral.referredUserId,
          status: 'COMPLETED',
          completedAt: {
            gte: referral.appliedAt,
            lte: referral.expiresAt,
          },
        },
        select: { id: true },
      });

      if (qualifyingRide) continue;

      const settled = await prisma.$transaction((tx) =>
        settleReferralWithReward(tx, {
          referralId: referral.id,
          status: ReferralStatus.EXPIRED_NO_RIDE,
          amountNgn: NO_RIDE_EXPIRED_REWARD_NGN,
          type: ReferralCashbackType.NO_RIDE_EXPIRED,
          now,
        }),
      );

      if (settled) settledCount += 1;
    }

    return settledCount;
  },

  async closeStaleReferrals(now = new Date()) {
    const result = await prisma.referral.updateMany({
      where: {
        status: ReferralStatus.PENDING,
        closesAt: { lte: now },
      },
      data: {
        status: ReferralStatus.CLOSED,
        settledAt: now,
      },
    });

    return result.count;
  },
};
