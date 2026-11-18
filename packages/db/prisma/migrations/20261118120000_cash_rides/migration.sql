-- Pay with cash (Timi, 18 Nov 2026). The rider pays the driver in the car; Wheelers'
-- share of the fare is then taken from the driver's wallet, below zero if it has to be
-- (what they owe). Only a wallet marked mayOwe may go below zero (besides Wheelers' own);
-- walletClient.takeCashRideFees marks it in the same write that takes the fee.
-- Additive only: every wallet starts mayOwe = false, so nothing changes for anyone today.

ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'CASH_RIDE_FEE';

ALTER TABLE "Wallet" ADD COLUMN "mayOwe" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Wallet" DROP CONSTRAINT "Wallet_balance_not_negative";
ALTER TABLE "Wallet"
  ADD CONSTRAINT "Wallet_balance_not_negative"
  CHECK ("balanceNgn" >= 0 OR "userId" = '00000000-0000-0000-0000-000000000001' OR "mayOwe");
