import { withdrawalClient } from '@wheleers/db';
import { classifyPayoutStatus, transferFeeNgn, type PaymentsClient } from '@wheleers/payments';

const TAG = '[payout-reconciliation]';

const SWEEP_INTERVAL_MS = Number(process.env['PAYOUT_RECONCILE_INTERVAL_MS'] ?? 5 * 60 * 1000);
const STALE_AFTER_MS = Number(process.env['PAYOUT_RECONCILE_STALE_MS'] ?? 10 * 60 * 1000);

export type PayoutResolution = 'settled' | 'released' | 'processing' | 'unknown';

/**
 * Ask the provider what became of one withdrawal and make the ledger agree.
 * The reference is the withdrawal request id, so this works for a payout we
 * recorded AND for one whose create call timed out before we recorded
 * anything.
 *
 * `neverRecorded` = the row is still FUNDS_RESERVED. Only then is "the
 * provider has never heard of it" proof that no transfer exists, and only
 * then is the reservation released on a not-found.
 */
export async function resolvePayout(
  paymentsClient: PaymentsClient,
  request: { id: string; amountNgn: number; neverRecorded: boolean },
  context: string,
): Promise<PayoutResolution> {
  const payout = await paymentsClient.getPayout(request.id);

  if (!payout) {
    if (request.neverRecorded) {
      await withdrawalClient.releaseFailedRequest({
        withdrawalRequestId: request.id,
        failureReason: `Transfer never reached the provider (${context})`,
        status: 'FAILED',
      });
      console.warn(`${TAG} released ${request.id} — provider has no such transfer`);
      return 'released';
    }
    console.error(`${TAG} CRITICAL: ${request.id} was recorded as created but the provider cannot find it`);
    return 'unknown';
  }

  const outcome = classifyPayoutStatus(payout.status);
  if (outcome === 'settled') {
    await withdrawalClient.settle(request.id, {
      providerFeeNgn: payout.feeNgn ?? transferFeeNgn(request.amountNgn),
    });
    console.log(`${TAG} settled ${request.id} (provider: ${payout.status}, ${context})`);
    return 'settled';
  }
  if (outcome === 'failed') {
    await withdrawalClient.releaseFailedRequest({
      providerReference: request.id,
      failureReason: payout.failureReason ?? `Payout ${(payout.status || 'failed').toLowerCase()} (${context})`,
      status: 'FAILED',
    });
    console.warn(`${TAG} refunded ${request.id} (provider: ${payout.status}, ${context})`);
    return 'released';
  }
  await withdrawalClient.markProcessing(request.id);
  return 'processing';
}

/**
 * Webhooks get lost — a transfer.failed that arrives before attachPayout, a
 * provider retry dropped by dedup, an outage — and a create call can time out
 * after the provider took it. Either strands a withdrawal with the user's
 * money locked. This sweep re-checks every quiet in-flight row.
 */
export function startPayoutReconciliation(paymentsClient: PaymentsClient): () => void {
  let running = false;

  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      const stale = await withdrawalClient.findStaleInFlight(new Date(Date.now() - STALE_AFTER_MS));
      if (stale.length > 0) {
        console.log(`${TAG} checking ${stale.length} stale in-flight withdrawal(s)`);
      }
      for (const request of stale) {
        try {
          await resolvePayout(
            paymentsClient,
            {
              id: request.id,
              amountNgn: Number(request.requestedAmountNgn),
              neverRecorded: request.status === 'FUNDS_RESERVED',
            },
            'reconciliation',
          );
        } catch (error) {
          console.warn(`${TAG} could not reconcile ${request.id}:`, error instanceof Error ? error.message : String(error));
        }
      }
    } catch (error) {
      console.error(`${TAG} sweep failed:`, error instanceof Error ? error.message : String(error));
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  timer.unref?.();
  void sweep();

  return () => clearInterval(timer);
}
