import { randomUUID } from 'crypto';
import { Account, BASE_FEE, Memo, Operation, StrKey, TransactionBuilder, Asset, type Keypair, type Transaction } from '@stellar/stellar-sdk';
import { stellarClient } from '@wheleers/db';
import { explorerAccount, explorerTx, type StellarConfig } from './config';
import { keypairAt } from './keys';
import { StellarSubmitError, type StellarNetwork } from './network';
import type { NgnRate, RateProvider } from './rates';

/**
 * Wheelers on Stellar Testnet (grant deliverable 3): its OWN ledger, in test
 * XLM, beside the naira one. Nothing naira is copied onto it.
 *
 *   ACCOUNT_OPEN  every rider and driver gets an address, opened by Friendbot
 *                 with free test XLM (operations opens it if Friendbot will not)
 *   FARE          when a wallet trip ends: rider → driver, the fare in XLM at
 *                 the live rate, memo = the trip ID
 *   COMMISSION    then driver → operations, the platform's share, same rate
 *   WITHDRAWAL    a driver sends test XLM to any testnet address
 *
 * A rider whose account has too little test XLM for a fare is SKIPPED, not
 * topped up: the trip itself is paid in naira as always. Operations pays
 * every fee (fee-bump). Each transfer keeps the naira rate it used. Transfers
 * are queued once (by reference) and sent by a background job, one at a
 * time, with the hash saved before sending: a send cut short is looked up,
 * never repeated.
 */

/** What an account keeps untouchable: Stellar's minimum balance, and a margin. */
export const RESERVE_XLM = 1.5;
const MAX_ATTEMPTS = 8;
/** A sent transaction not seen on Stellar after this long never will be (it has a 2-minute time limit). */
const LOST_AFTER_MS = 3 * 60 * 1000;
/** Who "sends" an account's opening XLM when Friendbot opens it. */
export const FRIENDBOT = 'FRIENDBOT';

export type StellarTransferRow = Awaited<ReturnType<typeof stellarClient.due>>[number];

export class StellarUserError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

export function xlm(amount: number): string {
  // Stellar takes at most 7 decimal places.
  return (Math.floor(amount * 1e7) / 1e7).toFixed(7).replace(/\.?0+$/, '') || '0';
}

export function createStellarService(deps: { config: StellarConfig; network: StellarNetwork; rates: RateProvider }) {
  const { config, network, rates } = deps;
  const keypair = (index: number): Keypair => keypairAt(config.masterSeed, index);

  /** Wheelers' own account, number 0: opened with Friendbot the first time. */
  async function ensureOperations() {
    const row = await stellarClient.operationsAccount()
      ?? await stellarClient.createAccount({ userId: null, role: 'operations', index: 0, derive: (i) => keypair(i).publicKey() });
    if (!row.openedAt) {
      if (!(await network.account(row.publicKey))) {
        await network.fund(row.publicKey);
        console.info('[stellar] operations account opened by Friendbot', { publicKey: row.publicKey });
      }
      await stellarClient.markOpened(row.publicKey);
    }
    return row;
  }

  /** A rider's or driver's address: recorded now, opened on Stellar (by Friendbot) by the job. */
  async function ensureUserAccount(userId: string) {
    const row = await stellarClient.accountForUser(userId)
      ?? await stellarClient.createAccount({ userId, role: 'user', derive: (i) => keypair(i).publicKey() });
    if (!row.openedAt) {
      await stellarClient.enqueue({
        kind: 'ACCOUNT_OPEN', reference: `open:${row.publicKey}`, userId,
        fromPublicKey: FRIENDBOT, toPublicKey: row.publicKey, amountXlm: config.friendbotXlm,
      });
    }
    return row;
  }

  const toXlm = (ngn: number, rate: NgnRate) => xlm(ngn / rate.ngnPerXlm);
  const ngnOf = (amountXlm: number, rate: NgnRate | null) => (rate ? Math.round(amountXlm * rate.ngnPerXlm * 100) / 100 : null);

  /** A finished trip: the fare rider → driver, then the commission driver → operations, both in XLM at the live rate. */
  async function settleRide(input: { rideId: string; tripId: string | null; riderId: string; driverUserId: string; fareNgn: number; commissionNgn: number }) {
    if (!(input.fareNgn > 0)) return;
    const ops = await ensureOperations();
    const rider = await ensureUserAccount(input.riderId);
    const driver = await ensureUserAccount(input.driverUserId);
    const memo = (input.tripId ?? input.rideId).slice(0, 28);
    const rate = await rates.current();
    const fare = await stellarClient.enqueue({
      kind: 'FARE', reference: `fare:${input.rideId}`, rideId: input.rideId, userId: input.riderId,
      fromPublicKey: rider.publicKey, toPublicKey: driver.publicKey,
      amountXlm: rate ? toXlm(input.fareNgn, rate) : '0', amountNgn: input.fareNgn, rateNgnPerXlm: rate?.ngnPerXlm ?? null, memo,
    });
    if (!rate) {
      if (fare.status === 'PENDING') await stellarClient.markSkipped(fare.id, 'no XLM price could be had to size the payment');
      return;
    }
    if (input.commissionNgn > 0) {
      await stellarClient.enqueue({
        kind: 'COMMISSION', reference: `commission:${input.rideId}`, rideId: input.rideId, userId: input.driverUserId,
        fromPublicKey: driver.publicKey, toPublicKey: ops.publicKey,
        amountXlm: toXlm(input.commissionNgn, rate), amountNgn: input.commissionNgn, rateNgnPerXlm: rate.ngnPerXlm, memo,
      });
    }
  }

  async function balanceOf(publicKey: string): Promise<number | null> {
    const account = await network.account(publicKey).catch(() => null);
    return account ? Number(account.balanceXlm) : null;
  }

  /** A driver sends test XLM out to an address of their choosing. */
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
    const rate = await rates.current().catch(() => null);
    return stellarClient.enqueue({
      kind: 'WITHDRAWAL', reference: `withdraw:${randomUUID()}`, userId: input.userId,
      fromPublicKey: account.publicKey, toPublicKey: destination,
      amountXlm: xlm(amount), amountNgn: ngnOf(amount, rate), rateNgnPerXlm: rate?.ngnPerXlm ?? null, memo: 'Wheelers withdrawal',
    });
  }

  /* ── the job ─────────────────────────────────────────────────────────── */

  async function signerFor(publicKey: string): Promise<Keypair> {
    const row = await stellarClient.accountByPublicKey(publicKey);
    if (!row) throw new Error(`No Wheelers account for ${publicKey}`);
    return keypair(row.derivationIndex);
  }

  /** Why this transfer cannot go yet (wait), or must not go at all (skip). */
  async function checkReady(t: StellarTransferRow): Promise<{ wait?: string; skip?: string }> {
    if (t.kind === 'ACCOUNT_OPEN') return {};
    const source = await stellarClient.accountByPublicKey(t.fromPublicKey);
    if (!source?.openedAt) return { wait: 'waiting for the paying account to open' };
    const dest = await stellarClient.accountByPublicKey(t.toPublicKey);
    if (dest && !dest.openedAt) return { wait: 'waiting for the receiving account to open' };
    if (t.kind === 'COMMISSION' && t.rideId) {
      const fare = await stellarClient.byReference(`fare:${t.rideId}`);
      if (fare?.status === 'SKIPPED' || fare?.status === 'FAILED') return { skip: 'the fare was not paid on Stellar' };
      if (fare && fare.status !== 'CONFIRMED') return { wait: 'waiting for the fare to land' };
    }
    if (t.kind === 'FARE') {
      const balance = await balanceOf(t.fromPublicKey);
      if (balance !== null && balance - RESERVE_XLM < Number(t.amountXlm)) {
        return { skip: `the rider's Stellar account had ${xlm(balance)} test XLM, not enough for ${String(t.amountXlm)} XLM` };
      }
    }
    return {};
  }

  async function build(t: Pick<StellarTransferRow, 'kind' | 'fromPublicKey' | 'toPublicKey' | 'amountXlm' | 'memo'>): Promise<Transaction | ReturnType<typeof TransactionBuilder.buildFeeBumpTransaction>> {
    const source = await network.account(t.fromPublicKey);
    if (!source) throw new StellarSubmitError('The paying account does not exist on Stellar', ['tx_no_source_account'], true);
    const signer = await signerFor(t.fromPublicKey);
    const ops = await ensureOperations();
    const opsSigner = keypair(ops.derivationIndex);
    const operation = t.kind === 'ACCOUNT_OPEN'
      ? Operation.createAccount({ destination: t.toPublicKey, startingBalance: String(t.amountXlm) })
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

  async function confirmed(t: StellarTransferRow, ledger: number | null, txHash?: string | null) {
    await stellarClient.markConfirmed(t.id, ledger, txHash);
    if (t.kind === 'ACCOUNT_OPEN') await stellarClient.markOpened(t.toPublicKey);
  }

  /** Friendbot opens the account; if it will not, operations does, with less. */
  async function openAccount(t: StellarTransferRow): Promise<'confirmed' | 'retry'> {
    try {
      const funded = await network.fund(t.toPublicKey);
      await confirmed(t, null, funded.hash);
      console.info('[stellar] account opened by Friendbot', { publicKey: t.toPublicKey });
      return 'confirmed';
    } catch (error) {
      console.warn('[stellar] Friendbot would not open an account; operations will', { error: error instanceof Error ? error.message : String(error) });
    }
    const ops = await ensureOperations();
    const tx = await build({ kind: 'ACCOUNT_OPEN', fromPublicKey: ops.publicKey, toPublicKey: t.toPublicKey, amountXlm: config.fallbackStartingXlm as never, memo: null });
    const hash = tx.hash().toString('hex');
    await stellarClient.markSubmitted(t.id, hash);
    try {
      const result = await network.submit(tx);
      await confirmed(t, result.ledger);
      return 'confirmed';
    } catch (error) {
      if (error instanceof StellarSubmitError && error.codes.includes('timeout')) return 'retry';
      await stellarClient.markRetry(t.id, error instanceof Error ? error.message : String(error));
      return 'retry';
    }
  }

  async function processOne(t: StellarTransferRow): Promise<'confirmed' | 'waiting' | 'retry' | 'failed' | 'skipped'> {
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

    if (t.kind === 'ACCOUNT_OPEN') {
      // Already open (a rerun): just note it.
      if (await network.account(t.toPublicKey)) { await confirmed(t, null); return 'confirmed'; }
      if (t.attempts >= MAX_ATTEMPTS) { await stellarClient.markFailed(t.id, t.lastError ?? 'too many attempts'); return 'failed'; }
      return openAccount(t);
    }

    const ready = await checkReady(t);
    if (ready.skip) { await stellarClient.markSkipped(t.id, ready.skip); return 'skipped'; }
    if (ready.wait) { await stellarClient.markWaiting(t.id, ready.wait); return 'waiting'; }

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

  function describe(t: { kind: string; status: string; amountXlm: unknown; amountNgn: unknown; rateNgnPerXlm?: unknown; memo: string | null; txHash: string | null; rideId: string | null; fromPublicKey: string; toPublicKey: string; createdAt: Date; confirmedAt: Date | null; lastError: string | null }) {
    return {
      kind: t.kind,
      status: t.status,
      amountXlm: String(t.amountXlm),
      amountNgn: t.amountNgn === null || t.amountNgn === undefined ? null : Number(t.amountNgn),
      rateNgnPerXlm: t.rateNgnPerXlm === null || t.rateNgnPerXlm === undefined ? null : Number(t.rateNgnPerXlm),
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
    rates,
    ensureOperations,
    ensureUserAccount,
    settleRide,
    requestWithdrawal,
    balanceOf,
    processDue,
    processOne,
    describe,
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
