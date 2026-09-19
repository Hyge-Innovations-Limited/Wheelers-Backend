import { z } from 'zod';

const BasePaymentEvent = z.object({
  userId:    z.string().uuid(),
  timestamp: z.string().datetime(),
});

// Fired by the api-gateway webhook handler when a user's dedicated deposit
// account receives a bank transfer. Both figures were read back from the
// provider, never taken from the webhook body.
// Consumed by: wallet-service (split the deposit and credit the ledger).
export const VirtualAccountCreditedEvent = BasePaymentEvent.extend({
  eventType:              z.literal('VIRTUAL_ACCOUNT_CREDITED'),
  providerAccountId:      z.string(),
  /** Gross amount the sender transferred. */
  amountNgn:              z.number(),
  /** What the provider kept before the cash reached our balance. */
  providerFeeNgn:         z.number().nonnegative().default(0),
  bankName:               z.string().optional(),
  senderAccountNumber:    z.string().optional(),
  senderAccountName:      z.string().optional(),
  providerReference:      z.string(),
});

// Fired by api-gateway when a provider transfer is created for a user withdrawal.
// Consumed by: payment-service (track payout lifecycle).
export const PayoutCreatedEvent = BasePaymentEvent.extend({
  eventType:         z.literal('PAYOUT_CREATED'),
  providerPayoutId:    z.string(),
  withdrawalId:      z.string().uuid(),
  amountNgn:         z.number(),
  bankAccountNumber: z.string(),
  bankAccountName:   z.string(),
  bankNetworkId:     z.string(),
});

// Fired by webhook handler when the provider confirms payout success.
// Consumed by: wallet-service (settle withdrawal, create transaction).
export const PayoutCompletedEvent = BasePaymentEvent.extend({
  eventType:          z.literal('PAYOUT_COMPLETED'),
  providerPayoutId:     z.string(),
  providerReference:  z.string(),
  amountNgn:          z.number(),
});

// Fired by webhook handler when the provider reports payout failure.
// Consumed by: wallet-service (release reserved funds back to user).
export const PayoutFailedEvent = BasePaymentEvent.extend({
  eventType:          z.literal('PAYOUT_FAILED'),
  providerPayoutId:     z.string(),
  providerReference:  z.string(),
  failureReason:      z.string(),
});

export const PaymentEvent = z.discriminatedUnion('eventType', [
  VirtualAccountCreditedEvent,
  PayoutCreatedEvent,
  PayoutCompletedEvent,
  PayoutFailedEvent,
]);

export type VirtualAccountCreditedEvent = z.infer<typeof VirtualAccountCreditedEvent>;
export type PayoutCreatedEvent          = z.infer<typeof PayoutCreatedEvent>;
export type PayoutCompletedEvent        = z.infer<typeof PayoutCompletedEvent>;
export type PayoutFailedEvent           = z.infer<typeof PayoutFailedEvent>;
export type PaymentEvent                = z.infer<typeof PaymentEvent>;
