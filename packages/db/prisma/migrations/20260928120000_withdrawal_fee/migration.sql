-- A flat Wheelers fee on every withdrawal, taken from the amount.
--
-- requestedAmountNgn stays what the user typed and what leaves their wallet.
-- These two record how it was split: the fee Wheelers kept, and what the bank
-- received. Both are null on withdrawals made before the fee; for those the
-- bank received the whole amount.
ALTER TABLE "WithdrawalRequest" ADD COLUMN "feeNgn" DECIMAL(18,2);
ALTER TABLE "WithdrawalRequest" ADD COLUMN "payoutAmountNgn" DECIMAL(18,2);
