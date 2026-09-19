import type { PaymentsClient } from '@wheleers/payments';
import { resolvePayout } from './payout-reconciliation';
import type {
  VirtualAccountCreditedEvent,
  PayoutCreatedEvent,
  PayoutCompletedEvent,
  PayoutFailedEvent,
} from '@wheleers/kafka-schemas';

const TAG = '[payment-events-handler]';

export interface PaymentEventsHandlerDeps {
  paymentsClient: PaymentsClient;
  serviceId?: string;
}

export function createPaymentEventsHandler(deps: PaymentEventsHandlerDeps) {
  const { paymentsClient, serviceId = 'payment-service' } = deps;

  return {
    /**
     * Deposit received via bank transfer.
     * The actual wallet credit is handled by wallet-service — here we just
     * log for audit and could trigger fraud checks in the future.
     */
    async handleVirtualAccountCredited(event: VirtualAccountCreditedEvent): Promise<void> {
      console.log(
        `${TAG} DEPOSIT userId=${event.userId} amount=NGN${event.amountNgn} ` +
        `ref=${event.providerReference} account=${event.providerAccountId} providerFee=NGN${event.providerFeeNgn ?? 0}`,
      );

      if (event.bankName) {
        console.log(
          `${TAG} deposit source: ${event.senderAccountName ?? 'unknown'} ` +
          `(${event.senderAccountNumber ?? 'N/A'}) via ${event.bankName}`,
        );
      }
    },

    /**
     * Payout created — ask the provider straight away. A transfer can finish
     * (or be refused) before its webhook arrives; syncing now means the user
     * sees the true state on their very next status check.
     */
    async handlePayoutCreated(event: PayoutCreatedEvent): Promise<void> {
      console.log(
        `${TAG} PAYOUT_CREATED userId=${event.userId} ` +
        `payoutId=${event.providerPayoutId} withdrawal=${event.withdrawalId} ` +
        `amount=NGN${event.amountNgn} → ${event.bankAccountName} (${event.bankAccountNumber})`,
      );

      try {
        const resolution = await resolvePayout(
          paymentsClient,
          { id: event.withdrawalId, amountNgn: event.amountNgn, neverRecorded: false },
          'at creation',
        );
        console.log(`${TAG} payout ${event.providerPayoutId} → ${resolution}`);
      } catch (error) {
        // Non-critical — the webhook and the reconciler both still run.
        console.warn(
          `${TAG} could not verify payout ${event.providerPayoutId}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    },

    /**
     * Payout completed — log for audit. The webhook handler has already
     * settled the withdrawal and updated the wallet.
     */
    async handlePayoutCompleted(event: PayoutCompletedEvent): Promise<void> {
      console.log(
        `${TAG} PAYOUT_COMPLETED userId=${event.userId} ` +
        `payoutId=${event.providerPayoutId} amount=NGN${event.amountNgn} ` +
        `ref=${event.providerReference}`,
      );
    },

    /**
     * Payout failed — log for audit. The webhook handler has already
     * released the reserved funds.
     */
    async handlePayoutFailed(event: PayoutFailedEvent): Promise<void> {
      console.error(
        `${TAG} PAYOUT_FAILED userId=${event.userId} ` +
        `payoutId=${event.providerPayoutId} reason=${event.failureReason} ` +
        `ref=${event.providerReference}`,
      );
    },
  };
}

export type PaymentEventsHandler = ReturnType<typeof createPaymentEventsHandler>;
