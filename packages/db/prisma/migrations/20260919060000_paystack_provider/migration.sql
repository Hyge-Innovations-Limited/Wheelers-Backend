-- Pouch → Paystack. The payment columns lose their vendor name, and nothing
-- that pointed at a Pouch object survives as a live reference.

-- A provider charge Wheelers absorbs is its own ledger row type, so it can
-- never be mistaken for revenue.
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'PROVIDER_FEE';

-- User.pouchCustomerId → providerCustomerId. Every stored value is a Pouch
-- customer id, meaningless to Paystack: clear them so each user is registered
-- afresh on their next provision.
ALTER TABLE "User" RENAME COLUMN "pouchCustomerId" TO "providerCustomerId";
ALTER INDEX "User_pouchCustomerId_key" RENAME TO "User_providerCustomerId_key";
ALTER INDEX "User_pouchCustomerId_idx" RENAME TO "User_providerCustomerId_idx";
UPDATE "User" SET "providerCustomerId" = NULL;

-- VirtualAccount: neutral names plus the issuing provider. Existing rows are
-- Rubies accounts from Pouch — kept, marked, and replaced in place the next
-- time that user is provisioned.
ALTER TABLE "VirtualAccount" RENAME COLUMN "pouchCustomerId" TO "providerCustomerId";
ALTER TABLE "VirtualAccount" RENAME COLUMN "pouchVirtualAccountId" TO "providerAccountId";
ALTER INDEX "VirtualAccount_pouchVirtualAccountId_key" RENAME TO "VirtualAccount_providerAccountId_key";
ALTER INDEX "VirtualAccount_pouchVirtualAccountId_idx" RENAME TO "VirtualAccount_providerAccountId_idx";
ALTER TABLE "VirtualAccount" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'paystack';
UPDATE "VirtualAccount" SET "provider" = 'pouch', "status" = 'retired';

-- WithdrawalRequest: past payout ids stay as history under the neutral name.
ALTER TABLE "WithdrawalRequest" RENAME COLUMN "pouchPayoutId" TO "providerPayoutId";
ALTER INDEX "WithdrawalRequest_pouchPayoutId_key" RENAME TO "WithdrawalRequest_providerPayoutId_key";
ALTER TABLE "WithdrawalRequest" ADD COLUMN "providerFeeNgn" DECIMAL(18,2);
