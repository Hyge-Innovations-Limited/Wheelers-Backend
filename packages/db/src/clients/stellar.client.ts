import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

/**
 * Stellar Testnet accounts and the queue of transfers on them. Public
 * addresses only: secrets are derived on the server and never stored.
 */

export type StellarTransferKind = 'ACCOUNT_OPEN' | 'OPS_REFILL' | 'RESET' | 'TOPUP' | 'FARE' | 'COMMISSION' | 'WITHDRAWAL';
export type StellarTransferStatus = 'PENDING' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'SKIPPED';

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export const stellarClient = {
  operationsAccount() {
    return prisma.stellarAccount.findFirst({ where: { role: 'operations' } });
  },

  accountForUser(userId: string) {
    return prisma.stellarAccount.findUnique({ where: { userId } });
  },

  accountByPublicKey(publicKey: string) {
    return prisma.stellarAccount.findUnique({ where: { publicKey } });
  },

  /** The next unused derivation index. Operations is always 0. */
  async nextIndex(): Promise<number> {
    const top = await prisma.stellarAccount.aggregate({ _max: { derivationIndex: true } });
    return (top._max.derivationIndex ?? 0) + 1;
  },

  /**
   * Record an account. `derive(index)` gives the public key for an index; on
   * a clash (two processes picking the same index) the next one is tried.
   */
  async createAccount(params: { userId: string | null; role: 'operations' | 'user'; derive: (index: number) => string; index?: number }) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const index = params.index ?? await this.nextIndex();
      try {
        return await prisma.stellarAccount.create({
          data: { userId: params.userId, role: params.role, derivationIndex: index, publicKey: params.derive(index) },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const existing = params.userId
          ? await prisma.stellarAccount.findUnique({ where: { userId: params.userId } })
          : await this.operationsAccount();
        if (existing) return existing;
        if (params.index !== undefined) throw error;
      }
    }
    throw new Error('Could not allocate a Stellar account index.');
  },

  /**
   * Riders and drivers who have no Stellar address yet: drivers first, then
   * the newest. `among` narrows it to some users (tests).
   */
  async usersWithoutAccount(limit: number, among?: string[]): Promise<string[]> {
    if (limit <= 0 || (among && among.length === 0)) return [];
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT u.id FROM "User" u
      LEFT JOIN "StellarAccount" s ON s."userId" = u.id
      WHERE s.id IS NULL ${among ? Prisma.sql`AND u.id IN (${Prisma.join(among)})` : Prisma.empty}
      ORDER BY (u.role = 'RIDER') ASC, u."createdAt" DESC
      LIMIT ${limit}`;
    return rows.map((row) => row.id);
  },

  /** An opening queued under the earlier design (by Friendbot, 10,000 XLM): now operations, with the starting amount. */
  async reshapeOpen(id: string, fromPublicKey: string, amountXlm: string): Promise<void> {
    await prisma.stellarTransfer.update({ where: { id }, data: { fromPublicKey, amountXlm: new Prisma.Decimal(amountXlm) } });
  },

  /** Account openings still in the queue. */
  pendingOpens(): Promise<number> {
    return prisma.stellarTransfer.count({ where: { kind: 'ACCOUNT_OPEN', status: { in: ['PENDING', 'SUBMITTED'] } } });
  },

  /** Every rider's and driver's account that is open on the network. */
  openedUserAccounts() {
    return prisma.stellarAccount.findMany({ where: { role: 'user', openedAt: { not: null } }, orderBy: { derivationIndex: 'asc' } });
  },

  async markOpened(publicKey: string): Promise<void> {
    await prisma.stellarAccount.updateMany({ where: { publicKey, openedAt: null }, data: { openedAt: new Date() } });
  },

  /** Queue a transfer. Asking twice for the same reference gives the first one back. */
  async enqueue(params: {
    kind: StellarTransferKind;
    reference: string;
    rideId?: string | null;
    userId?: string | null;
    fromPublicKey: string;
    toPublicKey: string;
    amountXlm: string;
    amountNgn?: number | null;
    rateNgnPerXlm?: number | null;
    memo?: string | null;
  }) {
    try {
      return await prisma.stellarTransfer.create({
        data: {
          kind: params.kind,
          reference: params.reference,
          rideId: params.rideId ?? null,
          userId: params.userId ?? null,
          fromPublicKey: params.fromPublicKey,
          toPublicKey: params.toPublicKey,
          amountXlm: new Prisma.Decimal(params.amountXlm),
          amountNgn: params.amountNgn === undefined || params.amountNgn === null ? null : new Prisma.Decimal(params.amountNgn),
          rateNgnPerXlm: params.rateNgnPerXlm === undefined || params.rateNgnPerXlm === null ? null : new Prisma.Decimal(params.rateNgnPerXlm),
          memo: params.memo ?? null,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return prisma.stellarTransfer.findUniqueOrThrow({ where: { reference: params.reference } });
    }
  },

  byReference(reference: string) {
    return prisma.stellarTransfer.findUnique({ where: { reference } });
  },

  /** What the job should look at next: waiting ones, and sent ones not yet confirmed. Oldest first. */
  due(limit = 20) {
    return prisma.stellarTransfer.findMany({
      where: { status: { in: ['PENDING', 'SUBMITTED'] } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  },

  async markSubmitted(id: string, txHash: string): Promise<void> {
    await prisma.stellarTransfer.update({ where: { id }, data: { status: 'SUBMITTED', txHash, submittedAt: new Date(), attempts: { increment: 1 } } });
  },

  async markConfirmed(id: string, ledger: number | null, txHash?: string | null): Promise<void> {
    await prisma.stellarTransfer.update({
      where: { id },
      data: { status: 'CONFIRMED', ledger, confirmedAt: new Date(), lastError: null, ...(txHash ? { txHash } : {}) },
    });
  },

  /** Not done, on purpose (the rider's account had too little test XLM). The trip itself is unaffected. */
  async markSkipped(id: string, reason: string): Promise<void> {
    await prisma.stellarTransfer.update({ where: { id }, data: { status: 'SKIPPED', lastError: reason.slice(0, 500) } });
  },

  /** Try again later from scratch: a new transaction, a new hash. */
  async markRetry(id: string, error: string): Promise<void> {
    await prisma.stellarTransfer.update({ where: { id }, data: { status: 'PENDING', txHash: null, submittedAt: null, lastError: error.slice(0, 500) } });
  },

  /** Waiting on something else (an account to open, a fare to land): not a failure. */
  async markWaiting(id: string, reason: string): Promise<void> {
    await prisma.stellarTransfer.update({ where: { id }, data: { lastError: reason.slice(0, 500) } });
  },

  async markFailed(id: string, error: string): Promise<void> {
    await prisma.stellarTransfer.update({ where: { id }, data: { status: 'FAILED', lastError: error.slice(0, 500) } });
  },

  listForRide(rideId: string) {
    return prisma.stellarTransfer.findMany({ where: { rideId }, orderBy: { createdAt: 'asc' } });
  },

  /** Everything into or out of one address, newest first. */
  listForAccount(publicKey: string, limit = 20) {
    return prisma.stellarTransfer.findMany({
      where: { OR: [{ fromPublicKey: publicKey }, { toPublicKey: publicKey }] },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  },

  list(params: { limit?: number; kind?: string | null; status?: string | null; before?: Date | null } = {}) {
    return prisma.stellarTransfer.findMany({
      where: {
        ...(params.kind ? { kind: params.kind } : {}),
        ...(params.status ? { status: params.status } : {}),
        ...(params.before ? { createdAt: { lt: params.before } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(200, params.limit ?? 50),
    });
  },

  async counts() {
    const rows = await prisma.stellarTransfer.groupBy({ by: ['kind', 'status'], _count: { _all: true } });
    return rows.map((row) => ({ kind: row.kind, status: row.status, count: row._count._all }));
  },
};
