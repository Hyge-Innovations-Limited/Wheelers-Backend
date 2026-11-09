import type { walletClient } from '@wheleers/db';

export type WalletRepository = Pick<
  typeof walletClient,
  | 'create'
  | 'findByUserId'
  | 'createRideHold'
  | 'adjustRideHold'
  | 'completeRideHoldWithDriverPayout'
  | 'cancelRideHold'
  | 'credit'
  | 'creditDeposit'
  | 'debit'
>;
