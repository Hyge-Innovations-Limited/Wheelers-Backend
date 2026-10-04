import type { Prisma, Wallet } from '@prisma/client';

/**
 * Takes money out of a wallet only if it is there, in one statement: the
 * database checks the balance and subtracts as a single step, one writer at a
 * time per wallet. Reading the balance first and subtracting after let two
 * payments in the same instant both pass the check and drive the balance
 * below zero. With `lock`, the money moves to lockedNgn (a hold) instead of
 * leaving. Null when the balance does not cover it; nothing changed then.
 */
export async function takeFromBalance(
  tx: Prisma.TransactionClient,
  walletId: string,
  amountNgn: number,
  options: { lock?: boolean } = {},
): Promise<Wallet | null> {
  const moved = await tx.wallet.updateMany({
    where: { id: walletId, balanceNgn: { gte: amountNgn } },
    data: options.lock
      ? { balanceNgn: { decrement: amountNgn }, lockedNgn: { increment: amountNgn } }
      : { balanceNgn: { decrement: amountNgn } },
  });
  if (moved.count === 0) return null;
  return tx.wallet.findUniqueOrThrow({ where: { id: walletId } });
}
