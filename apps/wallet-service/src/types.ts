import type { walletClient } from '@wheleers/db';

export type WalletRepository = Pick<
  typeof walletClient,
  | 'create'
  | 'findByUserId'
  | 'createRideHold'
  | 'adjustRideHold'
  | 'completeRideHoldWithDriverPayout'
  | 'takeCashRideFees'
  | 'cancelRideHold'
  | 'credit'
  | 'creditDeposit'
  | 'debit'
>;
