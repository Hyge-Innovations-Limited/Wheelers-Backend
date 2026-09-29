import { randomUUID } from 'crypto';
import { Account, BASE_FEE, Memo, Operation, StrKey, TransactionBuilder, Asset, type Keypair, type Transaction } from '@stellar/stellar-sdk';
import { stellarClient } from '@wheleers/db';
import { explorerAccount, explorerTx, type StellarConfig } from './config';
import { keypairAt } from './keys';
import { StellarSubmitError, type StellarNetwork } from './network';

/**
 * Wheelers on Stellar Testnet (grant deliverable 3). The naira ledger stays
 * the truth; each money movement it makes is mirrored here in testnet XLM at
 * the demo rate, with the trip ID in the memo, so the whole flow can be
 * checked on a public explorer:
 *
 *   ACCOUNT_OPEN  operations → a new rider or driver account (its minimum balance)
 *   TOPUP         operations → rider, when a naira deposit lands
 *   FARE          rider → driver, when a trip ends (memo: the trip ID)
 *   COMMISSION    driver → operations, the platform's share of that fare
 *   WITHDRAWAL    driver → any testnet address they choose
 *
 * Operations pays every fee (fee-bump), so riders and drivers never need XLM
 * for fees. Each transfer is queued once (its reference), sent in the
 * background, one at a time, and its hash is saved before it is sent: a send
 * cut short is looked up on Stellar, never repeated blindly.
 */

/** What an account keeps untouchable: Stellar's minimum balance, and a margin for safety. */
export const RESERVE_XLM = 1.5;
const MAX_ATTEMPTS = 8;
/** A sent transaction not seen on Stellar after this long never will be (it has a 2-minute time limit). */
const LOST_AFTER_MS = 3 * 60 * 1000;

export type StellarTransferRow = Awaited<ReturnType<typeof stellarClient.due>>[number];

export class StellarUserError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

function xlm(amount: number): string {
  // Stellar takes at most 7 decimal places.
  return (Math.floor(amount * 1e7) / 1e7).toFixed(7).replace(/\.?0+$/, '') || '0';
}

export function createStellarService(deps: { config: StellarConfig; network: StellarNetwork }) {
  const { config, network } = deps;
  const keypair = (index: number): Keypair => keypairAt(config.masterSeed, index);
  const toXlm = (ngn: number) => xlm(ngn / config.ngnPerXlm);

  /** Wheelers' own account, number 0: opened with Friendbot the first time. */
  async function ensureOperations() {
    const row = await stellarClient.operationsAccount()
      ?? await stellarClient.createAccount({ userId: null, role: 'operations', index: 0, derive: (i) => keypair(i).publicKey() });
    if (!row.openedAt) {
      if (!(await network.account(row.publicKey))) {
        await network.fund(row.publicKey);
        console.info('[stellar] operations account funded by Friendbot', { publicKey: row.publicKey });
      }
      await stellarClient.markOpened(row.publicKey);
    }
    return row;
  }

  /** A rider's or driver's account: recorded now, opened on Stellar by the job. */
  async function ensureUserAccount(userId: string) {
    const ops = await ensureOperations();
    const row = await stellarClient.accountForUser(userId)
      ?? await stellarClient.createAccount({ userId, role: 'user', derive: (i) => keypair(i).publicKey() });
    if (!row.openedAt) {
      await stellarClient.enqueue({
        kind: 'ACCOUNT_OPEN', reference: `open:${row.publicKey}`, userId,
        fromPublicKey: ops.publicKey, toPublicKey: row.publicKey, amountXlm: config.startingXlm,
      });
    }
    return row;
  }

  async function mirrorTopup(input: { userId: string; reference: string; amountNgn: number }) {
    if (!(input.amountNgn > 0)) return null;
    const ops = await ensureOperations();
    const account = await ensureUserAccount(input.userId);
    return stellarClient.enqueue({
      kind: 'TOPUP', reference: `topup:${input.reference}`, userId: input.userId,
      fromPublicKey: ops.publicKey, toPublicKey: account.publicKey,
      amountXlm: toXlm(input.amountNgn), amountNgn: input.amountNgn, memo: 'Wheelers top-up',
    });
  }

  /** A finished trip: the fare from rider to driver, then the commission from driver to operations. */
  async function settleRide(input: { rideId: string; tripId: string | null; riderId: string; driverUserId: string; fareNgn: number; commissionNgn: number }) {
    if (!(input.fareNgn > 0)) return;
    const ops = await ensureOperations();
    const rider = await ensureUserAccount(input.riderId);
    const driver = await ensureUserAccount(input.driverUserId);
    const memo = (input.tripId ?? input.rideId).slice(0, 28);
    await stellarClient.enqueue({
      kind: 'FARE', reference: `fare:${input.rideId}`, rideId: input.rideId, userId: input.riderId,
      fromPublicKey: rider.publicKey, toPublicKey: driver.publicKey,
      amountXlm: toXlm(input.fareNgn), amountNgn: input.fareNgn, memo,
    });
    if (input.commissionNgn > 0) {
      await stellarClient.enqueue({
        kind: 'COMMISSION', reference: `commission:${input.rideId}`, rideId: input.rideId, userId: input.driverUserId,
        fromPublicKey: driver.publicKey, toPublicKey: ops.publicKey,
        amountXlm: toXlm(input.commissionNgn), amountNgn: input.commissionNgn, memo,
      });
    }
  }

  async function balanceOf(publicKey: string): Promise<number | null> {
    const account = await network.account(publicKey).catch(() => null);
    return account ? Number(account.balanceXlm) : null;
  }

  /** A driver sends testnet XLM out to an address of their choosing. */
  async function requestWithdrawal(input: { userId: string; destination: string; amountXlm: number }) {
    const destination = input.destination.trim();
    if (!StrKey.isValidEd25519PublicKey(destination)) {
      throw new StellarUserError('BAD_ADDRESS', 'That is not a Stellar address. It starts with G and is 56 characters long.');
    }
    const amount = Number(input.amountXlm);
    if (!Number.isFinite(amount) || amount <= 0) throw new StellarUserError('BAD_AMOUNT', 'Enter an amount of XLM.');
    const account = await stellarClient.accountForUser(input.userId);
    if (!account?.openedAt) throw new StellarUserError('NO_ACCOUNT', 'Your Stellar account is not open yet. It opens with your first trip.', 409);
    if (destination === account.publicKey) throw new StellarUserError('SAME_ADDRESS', 'That is your own Wheelers address.');
    const balance = await balanceOf(account.publicKey);
    const spendable = balance === null ? 0 : balance - RESERVE_XLM;
    if (amount > spendable) {
      throw new StellarUserError('TOO_MUCH', `You can send up to ${xlm(Math.max(0, spendable))} XLM (Stellar keeps ${RESERVE_XLM} XLM in every account).`, 409);
    }
    return stellarClient.enqueue({
      kind: 'WITHDRAWAL', reference: `withdraw:${randomUUID()}`, userId: input.userId,
      fromPublicKey: account.publicKey, toPublicKey: destination,
      amountXlm: xlm(amount), amountNgn: Math.round(amount * config.ngnPerXlm * 100) / 100, memo: 'Wheelers withdrawal',
    });
  }

  /* ── the job ─────────────────────────────────────────────────────────── */

  async function signerFor(publicKey: string): Promise<Keypair> {
    const row = await stellarClient.accountByPublicKey(publicKey);
    if (!row) throw new Error(`No Wheelers account for ${publicKey}`);
    return keypair(row.derivationIndex);
  }

  async function isOurs(publicKey: string) {
    return stellarClient.accountByPublicKey(publicKey);
  }

  /** Why this transfer cannot go yet, or null when it can. Waiting is not failing. */
  async function blockedBy(t: StellarTransferRow): Promise<string | null> {
    if (t.kind !== 'ACCOUNT_OPEN') {
      const source = await isOurs(t.fromPublicKey);
      if (!source?.openedAt) return 'waiting for the paying account to open';
      const dest = await isOurs(t.toPublicKey);
      if (dest && !dest.openedAt) return 'waiting for the receiving account to open';
    }
    if (t.kind === 'COMMISSION' && t.rideId) {
      const fare = await stellarClient.byReference(`fare:${t.rideId}`);
      if (fare && fare.status !== 'CONFIRMED') return 'waiting for the fare to land';
    }
    if (t.kind === 'FARE') {
      // Riders who deposited before Stellar was on have less XLM than naira: top them up first.
      const balance = await balanceOf(t.fromPublicKey);
      const needed = Number(t.amountXlm) + RESERVE_XLM;
      if (balance !== null && balance < needed) {
        const ops = await ensureOperations();
        const shortXlm = needed - balance + 1;
        const catchUp = await stellarClient.enqueue({
          kind: 'TOPUP', reference: `topup:catchup:${t.rideId ?? t.id}`, userId: t.userId,
          fromPublicKey: ops.publicKey, toPublicKey: t.fromPublicKey,
          amountXlm: xlm(shortXlm), amountNgn: Math.round(shortXlm * config.ngnPerXlm), memo: 'Wheelers top-up',
        });
        if (catchUp.status !== 'CONFIRMED') return 'waiting for a top-up to cover the fare';
      }
    }
    return null;
  }

  async function build(t: StellarTransferRow): Promise<Transaction | ReturnType<typeof TransactionBuilder.buildFeeBumpTransaction>> {
    const source = await network.account(t.fromPublicKey);
    if (!source) throw new StellarSubmitError('The paying account does not exist on Stellar', ['tx_no_source_account'], true);
    const signer = await signerFor(t.fromPublicKey);
    const ops = await ensureOperations();
    const opsSigner = keypair(ops.derivationIndex);
    const operation = t.kind === 'ACCOUNT_OPEN'
      ? Operation.createAccount({ destination: t.toPublicKey, startingBalance: t.amountXlm.toString() })
      : Operation.payment({ destination: t.toPublicKey, asset: Asset.native(), amount: xlm(Number(t.amountXlm)) });
    const builder = new TransactionBuilder(new Account(t.fromPublicKey, source.sequence), {
      fee: BASE_FEE,
      networkPassphrase: config.networkPassphrase,
    }).addOperation(operation).setTimeout(120);
    if (t.memo) builder.addMemo(Memo.text(t.memo.slice(0, 28)));
    const inner = builder.build();
    inner.sign(signer);
    // Operations' own transfers pay their own fee; a rider's or driver's are fee-bumped by operations.
    if (t.fromPublicKey === ops.publicKey) return inner;
    const bump = TransactionBuilder.buildFeeBumpTransaction(opsSigner, String(Number(BASE_FEE) * 10), inner, config.networkPassphrase);
    bump.sign(opsSigner);
    return bump;
  }

  async function confirmed(t: StellarTransferRow, ledger: number | null) {
    await stellarClient.markConfirmed(t.id, ledger);
    if (t.kind === 'ACCOUNT_OPEN') await stellarClient.markOpened(t.toPublicKey);
  }

  async function processOne(t: StellarTransferRow): Promise<'confirmed' | 'waiting' | 'retry' | 'failed'> {
    // Sent before: did it make it?
    if (t.status === 'SUBMITTED' && t.txHash) {
      const seen = await network.transaction(t.txHash).catch(() => undefined);
      if (seen === undefined) return 'waiting';
      if (seen?.successful) { await confirmed(t, seen.ledger); return 'confirmed'; }
      if (seen && !seen.successful) { await stellarClient.markRetry(t.id, 'failed on the network'); return 'retry'; }
      if (t.submittedAt && Date.now() - t.submittedAt.getTime() < LOST_AFTER_MS) return 'waiting';
      await stellarClient.markRetry(t.id, 'never reached the network');
      return 'retry';
    }

    // Opening an account that already exists (a rerun, a reset): just note it.
    if (t.kind === 'ACCOUNT_OPEN' && await network.account(t.toPublicKey)) {
      await confirmed(t, null);
      return 'confirmed';
    }

    const blocked = await blockedBy(t);
    if (blocked) { await stellarClient.markWaiting(t.id, blocked); return 'waiting'; }

    if (t.attempts >= MAX_ATTEMPTS) { await stellarClient.markFailed(t.id, t.lastError ?? 'too many attempts'); return 'failed'; }
    let tx;
    try {
      tx = await build(t);
    } catch (error) {
      await stellarClient.markRetry(t.id, error instanceof Error ? error.message : String(error));
      return 'retry';
    }
    const hash = tx.hash().toString('hex');
    await stellarClient.markSubmitted(t.id, hash);
    try {
      const result = await network.submit(tx);
      await confirmed(t, result.ledger);
      console.info('[stellar] confirmed', { kind: t.kind, reference: t.reference, hash });
      return 'confirmed';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof StellarSubmitError && !error.retryable && t.attempts + 1 >= 3) {
        await stellarClient.markFailed(t.id, message);
        console.warn('[stellar] failed', { kind: t.kind, reference: t.reference, message });
        return 'failed';
      }
      // A network hiccup: leave it SUBMITTED; the next pass looks the hash up.
      if (error instanceof StellarSubmitError && error.codes.includes('timeout')) return 'waiting';
      await stellarClient.markRetry(t.id, message);
      return 'retry';
    }
  }

  let running = false;
  /** One pass over the queue, oldest first, one at a time (so no two use the same sequence number). */
  async function processDue(): Promise<number> {
    if (running) return 0;
    running = true;
    let done = 0;
    try {
      for (const t of await stellarClient.due(20)) {
        const outcome = await processOne(t).catch((error) => {
          console.warn('[stellar] transfer step failed', { reference: t.reference, error: error instanceof Error ? error.message : String(error) });
          return 'retry' as const;
        });
        if (outcome === 'confirmed') done += 1;
      }
    } finally {
      running = false;
    }
    return done;
  }

  function describe(t: { kind: string; status: string; amountXlm: unknown; amountNgn: unknown; memo: string | null; txHash: string | null; rideId: string | null; fromPublicKey: string; toPublicKey: string; createdAt: Date; confirmedAt: Date | null; lastError: string | null }) {
    return {
      kind: t.kind,
      status: t.status,
      amountXlm: String(t.amountXlm),
      amountNgn: t.amountNgn === null ? null : Number(t.amountNgn),
      memo: t.memo,
      rideId: t.rideId,
      from: t.fromPublicKey,
      to: t.toPublicKey,
      txHash: t.status === 'CONFIRMED' ? t.txHash : null,
      explorerUrl: t.status === 'CONFIRMED' && t.txHash ? explorerTx(config, t.txHash) : null,
      createdAt: t.createdAt.toISOString(),
      confirmedAt: t.confirmedAt?.toISOString() ?? null,
      note: t.status === 'CONFIRMED' ? null : t.lastError,
    };
  }

  return {
    config,
    ensureOperations,
    ensureUserAccount,
    mirrorTopup,
    settleRide,
    requestWithdrawal,
    balanceOf,
    processDue,
    processOne,
    describe,
    toXlm,
    accountUrl: (publicKey: string) => explorerAccount(config, publicKey),
  };
}

export type StellarService = ReturnType<typeof createStellarService>;

/** The background job: every few seconds, on the one gateway process that runs jobs. */
export function startStellarJob(service: StellarService, shouldRun: () => Promise<boolean>, everyMs = 5_000): () => void {
  const timer = setInterval(() => {
    void (async () => {
      if (!(await shouldRun().catch(() => false))) return;
      await service.processDue().catch((error) => console.warn('[stellar] job failed', { error: error instanceof Error ? error.message : String(error) }));
    })();
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
