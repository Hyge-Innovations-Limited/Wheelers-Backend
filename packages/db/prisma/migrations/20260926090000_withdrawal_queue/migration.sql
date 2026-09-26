-- A withdrawal whose transfer is not created yet: the float was short, or payouts are manual.
-- Sent by the payout queue sweep when the float allows, or marked paid by an admin.
ALTER TYPE "WithdrawalRequestStatus" ADD VALUE IF NOT EXISTS 'QUEUED';
