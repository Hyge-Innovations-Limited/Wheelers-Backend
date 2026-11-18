import { z } from 'zod';

const BaseWalletEvent = z.object({
  walletId:  z.string().uuid(),
  userId:    z.string().uuid(),
  timestamp: z.string().datetime(),
});

// Fired by wallet-service after any credit operation.
// Consumed by: api-gateway (push updated balance to user's WebSocket).
export const WalletCreditedEvent = BaseWalletEvent.extend({
  eventType:     z.literal('WALLET_CREDITED'),
  amountNgn:     z.number(),
  newBalanceNgn: z.number(),
  creditType:    z.enum([
    'deposit',
    'driver_payout',
    'refund',
    'dispute_resolution',
  ]),
  referenceId: z.string(),
});

// Fired by wallet-service after any debit operation.
// Consumed by: api-gateway (push updated balance to user's WebSocket).
export const WalletDebitedEvent = BaseWalletEvent.extend({
  eventType:     z.literal('WALLET_DEBITED'),
  amountNgn:     z.number(),
  newBalanceNgn: z.number(),
  debitType:     z.enum([
    'ride_payment',
    'penalty',
    'withdrawal',
    // A cash ride: Wheelers' share, from the driver's wallet (it may go below zero).
    'cash_ride_fee',
  ]),
  referenceId: z.string(),
});

// Fired by wallet-service when ride fare is held (before trip starts).
// Consumed by: api-gateway (show "funds reserved" in UI).
export const WalletLockedEvent = BaseWalletEvent.extend({
  eventType:       z.literal('WALLET_LOCKED'),
  lockedAmountNgn: z.number(),
  rideId:          z.string().uuid(),
  reason:          z.literal('ride_fare_hold'),
});

// Fired by wallet-service after ride ends or dispute resolves.
// Consumed by: api-gateway (push balance update to WebSocket).
export const WalletUnlockedEvent = BaseWalletEvent.extend({
  eventType:         z.literal('WALLET_UNLOCKED'),
  unlockedAmountNgn: z.number(),
  rideId:            z.string().uuid(),
  reason:            z.enum([
    'ride_completed',
    'ride_cancelled',
    'dispute_resolved',
  ]),
});

export const WalletHoldAdjustedEvent = BaseWalletEvent.extend({
  eventType:                z.literal('WALLET_HOLD_ADJUSTED'),
  rideId:                   z.string().uuid(),
  previousLockedAmountNgn:  z.number(),
  lockedAmountNgn:          z.number(),
  reason:                   z.literal('ride_route_updated'),
});

export const WalletEvent = z.discriminatedUnion('eventType', [
  WalletCreditedEvent,
  WalletDebitedEvent,
  WalletLockedEvent,
  WalletUnlockedEvent,
  WalletHoldAdjustedEvent,
]);

export type WalletCreditedEvent     = z.infer<typeof WalletCreditedEvent>;
export type WalletDebitedEvent      = z.infer<typeof WalletDebitedEvent>;
export type WalletLockedEvent       = z.infer<typeof WalletLockedEvent>;
export type WalletUnlockedEvent     = z.infer<typeof WalletUnlockedEvent>;
export type WalletHoldAdjustedEvent = z.infer<typeof WalletHoldAdjustedEvent>;
export type WalletEvent             = z.infer<typeof WalletEvent>;
