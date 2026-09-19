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
  | 'FLOAT_SHORT'
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
): Promise<{ requestId: string }> {
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
  const floatNgn = await paymentsClient.getBalanceNgn().catch(() => null);
  const neededNgn = amountNgn + transferFeeNgn(amountNgn);
  if (floatNgn !== null && floatNgn < neededNgn) {
    // Deposits do NOT land in this balance: Paystack holds them as pending
    // settlement and pays them out to the business bank account. The transfer
    // balance only grows when it is topped up (or when settlements are
    // pointed at it), so an empty float is an operations task, not a bug.
    console.error(`${TAG} CRITICAL: Paystack transfer balance cannot cover this withdrawal — top it up (dashboard → Transfers → Top up)`, {
      userId,
      amountNgn,
      neededNgn,
      floatNgn,
    });
    throw new WithdrawalError(
      'Withdrawals are temporarily unavailable. Your wallet balance is untouched — please try again shortly.',
      'FLOAT_SHORT',
    );
  }

  const reserved = await withdrawalClient.reserve({
    userId,
    walletId,
    amountNgn,
    bankAccountNumber: accountNumber,
    bankAccountName: accountName,
    bankNetworkId: bankCode,
  });
  const requestId = reserved.request.id;

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
  return { requestId };
}
