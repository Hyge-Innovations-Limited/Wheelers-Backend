import { prisma } from '../prisma';

const SECURITY_FIELDS = {
  id: true,
  name: true,
  phone: true,
  walletPinHash: true,
  walletPinSetAt: true,
  walletPinFailedAttempts: true,
  walletPinLockedUntil: true,
  withdrawalsFrozenUntil: true,
  withdrawalsFrozenReason: true,
  withdrawalsRestrictedUntil: true,
  recoveryEmail: true,
  recoveryEmailVerifiedAt: true,
} as const;

/**
 * Everything that decides whether a user may withdraw. One narrow SELECT by
 * primary key — this runs on every withdrawal and every wallet page open, so
 * it never touches a relation or a wide row.
 */
export const walletSecurityClient = {
  getState: (userId: string) =>
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: SECURITY_FIELDS }),

  /** A new PIN always starts with a clean attempt count and no lock. */
  setPin: (userId: string, pinHash: string) =>
    prisma.user.update({
      where: { id: userId },
      data: {
        walletPinHash: pinHash,
        walletPinSetAt: new Date(),
        walletPinFailedAttempts: 0,
        walletPinLockedUntil: null,
      },
      select: SECURITY_FIELDS,
    }),

  /**
   * One wrong PIN. The increment is a single atomic UPDATE, so ten parallel
   * guesses count as ten — a read-then-write would let them all see "4" and
   * slip under the limit together.
   */
  recordFailedAttempt: async (userId: string, maxAttempts: number, lockSeconds: number) => {
    const after = await prisma.user.update({
      where: { id: userId },
      data: { walletPinFailedAttempts: { increment: 1 } },
      select: { walletPinFailedAttempts: true },
    });
    if (after.walletPinFailedAttempts < maxAttempts) {
      return { attempts: after.walletPinFailedAttempts, lockedUntil: null as Date | null };
    }
    const lockedUntil = new Date(Date.now() + lockSeconds * 1000);
    await prisma.user.update({
      where: { id: userId },
      data: { walletPinLockedUntil: lockedUntil, walletPinFailedAttempts: 0 },
    });
    return { attempts: after.walletPinFailedAttempts, lockedUntil };
  },

  clearFailedAttempts: (userId: string) =>
    prisma.user.updateMany({
      where: { id: userId, walletPinFailedAttempts: { gt: 0 } },
      data: { walletPinFailedAttempts: 0 },
    }),

  /** Never shortens an existing freeze: the later of the two moments wins. */
  freezeWithdrawals: async (userId: string, until: Date, reason: string) => {
    const current = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { withdrawalsFrozenUntil: true },
    });
    if (current.withdrawalsFrozenUntil && current.withdrawalsFrozenUntil > until) return;
    await prisma.user.update({
      where: { id: userId },
      data: { withdrawalsFrozenUntil: until, withdrawalsFrozenReason: reason },
    });
  },

  unfreezeWithdrawals: (userId: string) =>
    prisma.user.update({
      where: { id: userId },
      data: { withdrawalsFrozenUntil: null, withdrawalsFrozenReason: null, withdrawalsRestrictedUntil: null },
    }),

  restrictDestinations: (userId: string, until: Date) =>
    prisma.user.update({ where: { id: userId }, data: { withdrawalsRestrictedUntil: until } }),

  /** Stored unverified; it only counts once `markRecoveryEmailVerified` runs. */
  setRecoveryEmail: (userId: string, email: string) =>
    prisma.user.update({
      where: { id: userId },
      data: { recoveryEmail: email, recoveryEmailVerifiedAt: null },
    }),

  markRecoveryEmailVerified: (userId: string, email: string) =>
    prisma.user.updateMany({
      where: { id: userId, recoveryEmail: email },
      data: { recoveryEmailVerifiedAt: new Date() },
    }),

  hasAnySettledWithdrawal: async (userId: string) => {
    const hit = await prisma.withdrawalRequest.findFirst({
      where: { userId, status: 'SETTLED' },
      select: { id: true },
    });
    return hit !== null;
  },

  /** Has this user already been PAID at this bank account? */
  hasWithdrawnTo: async (userId: string, bankCode: string, accountNumber: string) => {
    const hit = await prisma.withdrawalRequest.findFirst({
      where: { userId, status: 'SETTLED', bankNetworkId: bankCode, bankAccountNumber: accountNumber },
      select: { id: true },
    });
    return hit !== null;
  },
};
