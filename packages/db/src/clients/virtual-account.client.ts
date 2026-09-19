import { prisma } from '../prisma';

/** The provider whose accounts are live. Anything else is a retired leftover. */
export const ACTIVE_PAYMENT_PROVIDER = 'paystack';

interface VirtualAccountDetails {
  providerCustomerId: string;
  providerAccountId: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  currency?: string;
  country?: string;
}

export const virtualAccountClient = {
  /**
   * The user's LIVE deposit account. A row left over from the retired Pouch
   * integration is invisible here — showing a rider a dead account number is
   * how money gets sent into the void.
   */
  findByUserId: (userId: string) =>
    prisma.virtualAccount.findFirst({
      where: { userId, provider: ACTIVE_PAYMENT_PROVIDER },
    }),

  findByProviderAccountId: (providerAccountId: string) =>
    prisma.virtualAccount.findFirst({
      where: { providerAccountId, provider: ACTIVE_PAYMENT_PROVIDER },
    }),

  findByAccountNumber: (accountNumber: string) =>
    prisma.virtualAccount.findFirst({
      where: { accountNumber, provider: ACTIVE_PAYMENT_PROVIDER },
    }),

  /**
   * Save the user's deposit account. One row per user: a retired row is
   * overwritten in place, a live one is refreshed.
   */
  upsertForUser: (userId: string, data: VirtualAccountDetails) => {
    const fields = {
      provider: ACTIVE_PAYMENT_PROVIDER,
      providerCustomerId: data.providerCustomerId,
      providerAccountId: data.providerAccountId,
      bankName: data.bankName,
      accountNumber: data.accountNumber,
      accountName: data.accountName,
      currency: data.currency ?? 'NGN',
      country: data.country ?? 'NG',
      status: 'active',
    };
    return prisma.virtualAccount.upsert({
      where: { userId },
      create: { userId, ...fields },
      update: fields,
    });
  },

  updateStatus: (userId: string, status: string) =>
    prisma.virtualAccount.update({
      where: { userId },
      data: { status },
    }),
};
