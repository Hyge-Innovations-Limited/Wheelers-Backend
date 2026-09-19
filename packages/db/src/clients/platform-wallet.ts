import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

type Db = Prisma.TransactionClient | typeof prisma;

export const PLATFORM_USER_ID = '00000000-0000-0000-0000-000000000001';

/** The platform wallet's id, creating the platform user + wallet on first use. */
export async function ensurePlatformWalletId(db: Db = prisma): Promise<string> {
  const existing = await db.wallet.findUnique({ where: { userId: PLATFORM_USER_ID } });
  if (existing) return existing.id;

  await db.user.upsert({
    where: { id: PLATFORM_USER_ID },
    create: {
      id: PLATFORM_USER_ID,
      privyDid: 'platform:wheelers',
      role: 'RIDER',
      name: 'Wheelers Platform',
    },
    update: {},
  });
  const wallet = await db.wallet.upsert({
    where: { userId: PLATFORM_USER_ID },
    create: { userId: PLATFORM_USER_ID },
    update: {},
  });
  return wallet.id;
}

/**
 * Book a payment-provider charge Wheelers absorbed. The platform wallet is
 * allowed to go negative: if fees earned do not cover fees paid, the ledger
 * must say so rather than quietly disagree with the bank.
 */
export async function bookProviderFee(
  tx: Prisma.TransactionClient,
  params: { amountNgn: number; referenceId: string; metadata?: Record<string, unknown> },
): Promise<void> {
  if (!(params.amountNgn > 0)) return;
  const platformWalletId = await ensurePlatformWalletId(tx);
  const wallet = await tx.wallet.update({
    where: { id: platformWalletId },
    data: { balanceNgn: { decrement: params.amountNgn } },
  });
  await tx.transaction.create({
    data: {
      walletId: platformWalletId,
      type: 'PROVIDER_FEE',
      direction: 'DEBIT',
      amountNgn: params.amountNgn,
      balanceAfterNgn: wallet.balanceNgn,
      referenceId: params.referenceId,
      metadata: (params.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}
