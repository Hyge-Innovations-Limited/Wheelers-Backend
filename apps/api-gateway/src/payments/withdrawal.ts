import { withdrawalClient } from '@wheleers/db';
import { MIN_WITHDRAWAL_NGN } from '@wheleers/config';
import {
  OTP_REQUIRED_MESSAGE,
  classifyPayoutStatus,
  isOtpRequired,
  transferFeeNgn,
  type PaymentsClient,
} from '@wheleers/payments';
import type { PayoutCreatedEvent } from '@wheleers/kafka-schemas';
import type { GatewayPublisher } from '../websocket/publisher';
import { assertMayWithdraw, type PinPolicy } from '../wallet-security/wallet-pin';

const TAG = '[api-gateway][withdrawal]';

export type WithdrawalErrorCode =
  | 'BELOW_MINIMUM'
  | 'FLOAT_SHORT'   // no longer thrown: a short float queues the withdrawal
  | 'PAYOUTS_NOT_ENABLED'
  | 'PAYOUT_REJECTED'
  | 'PENDING_CONFIRMATION'
  | 'WITHDRAWAL_FAILED';

/** A withdrawal failure whose message is safe to show the user as-is. */
export class WithdrawalError extends Error {
  constructor(
    message: string,
    readonly code: WithdrawalErrorCode,
    /** True when the user's money is STILL reserved (the payout may exist). */
    readonly fundsStillReserved = false,
  ) {
    super(message);
    this.name = 'WithdrawalError';
  }
}

export type PayoutMode = 'auto' | 'manual';
let payoutMode: PayoutMode = 'auto';
/** Set once at boot from PAYOUT_MODE. "manual": every withdrawal is queued for an admin. */
export function configurePayouts(config: { mode: PayoutMode }): void {
  payoutMode = config.mode;
}
export function currentPayoutMode(): PayoutMode {
  return payoutMode;
}

export const WITHDRAWAL_QUEUED_MESSAGE =
  'Your withdrawal is in the queue. The money is set aside from your balance and is sent to your bank as soon as it can be — usually within a day. You can see it under your withdrawals.';

export const WITHDRAWAL_PENDING_CONFIRMATION_MESSAGE =
  'Your withdrawal was submitted but the bank has not confirmed it yet. Your money stays reserved until it does, and your wallet balance is safe.';

export interface SubmitWithdrawalInput {
  userId: string;
  walletId: string;
  amountNgn: number;
  bankCode: string;
  accountNumber: string;
  accountName: string;
  /** The wallet PIN as typed. Never logged, never stored. */
  pin?: unknown;
  /** Defaults to 'required': a caller must opt OUT of the PIN, never into it. */
  pinPolicy?: PinPolicy;
}

/**
 * The one place a withdrawal moves money — the app route and the WhatsApp
 * flow both end here, so they cannot drift apart again.
 *
 *   reserve funds → create transfer (reference = request id) → record it
 *
 * Failure handling turns on one question: could the transfer exist?
 *   • No  (a clear 4xx, a rejected status)      → release the reservation.
 *   • Maybe (timeout, 5xx, dropped connection)  → KEEP it reserved. The
 *     reconciler asks the provider by reference and settles or releases.
 *     Releasing on a maybe is how a user gets paid twice.
 */
export async function submitWithdrawal(
  deps: { paymentsClient: PaymentsClient; publisher: GatewayPublisher },
  input: SubmitWithdrawalInput,
): Promise<{ requestId: string; queued: boolean }> {
  const { paymentsClient, publisher } = deps;
  const { userId, walletId, amountNgn, bankCode, accountNumber, accountName } = input;

  if (!(amountNgn > 0) || amountNgn < MIN_WITHDRAWAL_NGN) {
    throw new WithdrawalError(
      `The smallest amount you can withdraw is ₦${MIN_WITHDRAWAL_NGN.toLocaleString('en-NG')}.`,
      'BELOW_MINIMUM',
    );
  }

  // PIN, freeze and destination rules — checked here, inside the executor, so
  // no route (present or future) can reach the money around them. A refusal
  // throws WalletSecurityError before anything is reserved.
  await assertMayWithdraw({
    userId,
    pin: input.pin,
    policy: input.pinPolicy ?? 'required',
    bankCode,
    accountNumber,
  });

  // Every transfer draws on ONE pooled provider balance. If that float cannot
  // cover this payout plus its fee, say so before touching the ledger. An
  // unreadable balance is not a reason to block — the provider will refuse a
  // transfer it cannot fund, and that refusal releases the reservation.
  const floatNgn = payoutMode === 'manual' ? null : await paymentsClient.getBalanceNgn().catch(() => null);
  const neededNgn = amountNgn + transferFeeNgn(amountNgn);
  const floatShort = floatNgn !== null && floatNgn < neededNgn;

  const reserved = await withdrawalClient.reserve({
    userId,
    walletId,
    amountNgn,
    bankAccountNumber: accountNumber,
    bankAccountName: accountName,
    bankNetworkId: bankCode,
  });
  const requestId = reserved.request.id;

  // No transfer today: payouts are manual, or the pooled Paystack float cannot cover this
  // one (deposits settle to the business bank account, not to that balance). Refusing used
  // to send the rider away with "try again later"; now the money is set aside and the
  // request waits its turn — the queue sweep sends it when the float allows, or an admin
  // pays it by hand and marks it paid.
  if (payoutMode === 'manual' || floatShort) {
    await withdrawalClient.queue(requestId);
    console.warn(`${TAG} withdrawal QUEUED`, { requestId, userId, amountNgn, neededNgn, floatNgn, mode: payoutMode });
    return { requestId, queued: true as const };
  }

  return dispatchPayout({ paymentsClient, publisher }, { id: requestId, userId, amountNgn, bankCode, accountNumber, accountName });
}

/**
 * Create the bank transfer for a reserved request and record it. The one place
 * a transfer is made — the fresh withdrawal, the queue sweep and "send now" from
 * the admin panel all come here. Failure handling turns on one question: could
 * the transfer exist? No → release the reservation. Maybe → keep it for the
 * reconciler.
 */
export async function dispatchPayout(
  deps: { paymentsClient: PaymentsClient; publisher: GatewayPublisher },
  request: { id: string; userId: string; amountNgn: number; bankCode: string; accountNumber: string; accountName: string },
): Promise<{ requestId: string; queued: false }> {
  const { paymentsClient, publisher } = deps;
  const { id: requestId, userId, amountNgn, bankCode, accountNumber, accountName } = request;

  const release = async (reason: string) => {
    await withdrawalClient
      .releaseFailedRequest({ withdrawalRequestId: requestId, failureReason: reason, status: 'FAILED' })
      .catch((releaseError) => {
        console.error(`${TAG} CRITICAL: could not release reservation`, {
          requestId,
          error: releaseError instanceof Error ? releaseError.message : String(releaseError),
        });
      });
  };

  let payout;
  try {
    payout = await paymentsClient.createPayout({
      reference: requestId,
      amountNgn,
      accountNumber,
      bankCode,
      accountName,
      narration: 'Wheelers withdrawal',
    });
  } catch (error) {
    const status = (error as { status?: unknown })?.status;
    const ambiguous = typeof status !== 'number' || status >= 500 || status === 408 || status === 429;
    if (ambiguous) {
      console.error(`${TAG} transfer outcome unknown — reservation kept for reconciliation`, {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new WithdrawalError(WITHDRAWAL_PENDING_CONFIRMATION_MESSAGE, 'PENDING_CONFIRMATION', true);
    }
    const reason = error instanceof Error ? error.message : 'Transfer could not be created';
    await release(reason);
    console.warn(`${TAG} transfer refused by provider`, { requestId, reason, code: (error as { code?: string })?.code ?? null });
    throw new WithdrawalError(
      `${reason}. Your balance has not been deducted — please check the account details and try again.`,
      'PAYOUT_REJECTED',
    );
  }

  if (classifyPayoutStatus(payout.status) === 'failed') {
    const otp = isOtpRequired(payout.status);
    if (otp) {
      console.error(
        `${TAG} CRITICAL: Paystack wants an OTP for every transfer. Turn OFF "Confirm transfers before sending" ` +
        '(Paystack dashboard → Settings → Preferences). Do NOT finalise this transfer by hand — its funds were released.',
        { requestId, transferId: payout.id },
      );
    }
    await release(otp ? 'Provider requires manual OTP confirmation' : `Transfer ${payout.status}`);
    throw new WithdrawalError(
      otp
        ? OTP_REQUIRED_MESSAGE
        : `The bank transfer was rejected (${payout.status}). Your balance has not been deducted — please check the account details and try again.`,
      otp ? 'PAYOUTS_NOT_ENABLED' : 'PAYOUT_REJECTED',
    );
  }

  // From here the transfer EXISTS. Nothing below may release the funds.
  try {
    await withdrawalClient.attachPayout({
      withdrawalRequestId: requestId,
      providerPayoutId: payout.id,
      providerReference: payout.reference,
    });

    const event: PayoutCreatedEvent = {
      eventType: 'PAYOUT_CREATED',
      userId,
      providerPayoutId: payout.id,
      withdrawalId: requestId,
      amountNgn,
      bankAccountNumber: accountNumber,
      bankAccountName: accountName,
      bankNetworkId: bankCode,
      timestamp: new Date().toISOString(),
    };
    await publisher.publishPaymentEvent(event);
  } catch (error) {
    // Bookkeeping failed after the money started moving. The reconciler
    // finds the row by reference (= request id) and finishes the job.
    console.error(`${TAG} transfer created but could not be recorded — reconciler will pick it up`, {
      requestId,
      transferId: payout.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  console.log(`${TAG} transfer created`, { requestId, transferId: payout.id, amountNgn, status: payout.status });
  return { requestId, queued: false as const };
}

/* ── the queue ──────────────────────────────────────────────────────────── */

const QUEUE_TAG = '[api-gateway][payout-queue]';

/**
 * Send what the float can cover, oldest first. Stops at the first request the
 * float cannot pay, so a big one does not starve the small ones behind it out
 * of order — the queue is paid in the order it was asked. Does nothing in
 * manual mode: those are an admin's to send.
 */
export async function runPayoutQueueOnce(deps: { paymentsClient: PaymentsClient; publisher: GatewayPublisher }): Promise<{ sent: number; waiting: number }> {
  if (payoutMode === 'manual') return { sent: 0, waiting: (await withdrawalClient.listQueued(1)).length };
  const queued = await withdrawalClient.listQueued();
  if (queued.length === 0) return { sent: 0, waiting: 0 };
  let floatNgn = await deps.paymentsClient.getBalanceNgn().catch(() => null);
  if (floatNgn === null) return { sent: 0, waiting: queued.length };
  let sent = 0;
  for (const request of queued) {
    const amountNgn = Number(request.requestedAmountNgn);
    const neededNgn = amountNgn + transferFeeNgn(amountNgn);
    if (floatNgn < neededNgn) break;
    const claimed = await withdrawalClient.dequeue(request.id);
    if (claimed.count === 0) continue;   // another sweep or an admin got here first
    try {
      await dispatchPayout(deps, { id: request.id, userId: request.userId, amountNgn, bankCode: request.bankNetworkId, accountNumber: request.bankAccountNumber, accountName: request.bankAccountName });
      floatNgn -= neededNgn;
      sent += 1;
    } catch (error) {
      // dispatchPayout released the money on a definite refusal, or kept it for the
      // reconciler on an unknown outcome. Either way this request is no longer queued.
      console.warn(`${QUEUE_TAG} queued withdrawal could not be sent`, { requestId: request.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const waiting = queued.length - sent;
  if (sent > 0 || waiting > 0) console.info(`${QUEUE_TAG} sweep`, { sent, waiting, floatNgn });
  return { sent, waiting };
}

export function startPayoutQueue(deps: { paymentsClient: PaymentsClient; publisher: GatewayPublisher }, intervalMs = 2 * 60_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runPayoutQueueOnce(deps); } catch (error) { console.error(`${QUEUE_TAG} sweep failed`, error instanceof Error ? error.message : String(error)); } finally { running = false; }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}

/* ── what an admin can do with a queued withdrawal ─────────────────────── */

/** The admin sent the money by hand (Paystack dashboard, bank app): record it as paid. */
export async function markQueuedPaid(requestId: string, reference?: string) {
  const request = await withdrawalClient.findById(requestId);
  if (!request) throw new WithdrawalError('No such withdrawal.', 'WITHDRAWAL_FAILED');
  if (request.status !== 'QUEUED') throw new WithdrawalError(`This withdrawal is ${request.status}, not queued.`, 'WITHDRAWAL_FAILED');
  const providerReference = reference?.trim() || `manual:${requestId}`;
  await withdrawalClient.dequeue(requestId);
  await withdrawalClient.attachPayout({ withdrawalRequestId: requestId, providerPayoutId: providerReference, providerReference, providerPayload: { manual: true } });
  const settled = await withdrawalClient.settle(providerReference);
  console.info(`${QUEUE_TAG} queued withdrawal marked paid by an admin`, { requestId, providerReference });
  return settled;
}

/** Send a queued withdrawal through Paystack now, float permitting or not — the provider has the final word. */
export async function sendQueuedNow(deps: { paymentsClient: PaymentsClient; publisher: GatewayPublisher }, requestId: string) {
  const request = await withdrawalClient.findById(requestId);
  if (!request) throw new WithdrawalError('No such withdrawal.', 'WITHDRAWAL_FAILED');
  if (request.status !== 'QUEUED') throw new WithdrawalError(`This withdrawal is ${request.status}, not queued.`, 'WITHDRAWAL_FAILED');
  const claimed = await withdrawalClient.dequeue(requestId);
  if (claimed.count === 0) throw new WithdrawalError('This withdrawal was just taken by the queue.', 'WITHDRAWAL_FAILED');
  return dispatchPayout(deps, { id: requestId, userId: request.userId, amountNgn: Number(request.requestedAmountNgn), bankCode: request.bankNetworkId, accountNumber: request.bankAccountNumber, accountName: request.bankAccountName });
}

/** Give the money back: the queued request is cancelled and the wallet balance restored. */
export async function cancelQueued(requestId: string, reason = 'Cancelled by an admin') {
  const request = await withdrawalClient.findById(requestId);
  if (!request) throw new WithdrawalError('No such withdrawal.', 'WITHDRAWAL_FAILED');
  if (request.status !== 'QUEUED') throw new WithdrawalError(`This withdrawal is ${request.status}, not queued.`, 'WITHDRAWAL_FAILED');
  await withdrawalClient.dequeue(requestId);
  return withdrawalClient.releaseFailedRequest({ withdrawalRequestId: requestId, failureReason: reason, status: 'CANCELLED' });
}
