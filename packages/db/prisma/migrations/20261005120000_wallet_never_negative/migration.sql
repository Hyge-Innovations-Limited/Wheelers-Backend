-- A wallet's spendable and locked money can never go below zero. The
-- platform wallet is the one exception: it books the provider fees Wheelers
-- absorbs, and its balance must show it when fees paid exceed fees earned.
--
-- The code already takes money only when it is there; this is the backstop
-- if anything ever tries otherwise. If a wallet is already negative the
-- migration stops here and changes nothing: fix that wallet first.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Wallet"
    WHERE "lockedNgn" < 0
       OR ("balanceNgn" < 0 AND "userId" <> '00000000-0000-0000-0000-000000000001')
  ) THEN
    RAISE EXCEPTION 'A wallet is already below zero. Fix it, then deploy again (see the deploy notes).';
  END IF;
END $$;

ALTER TABLE "Wallet"
  ADD CONSTRAINT "Wallet_balance_not_negative"
  CHECK ("balanceNgn" >= 0 OR "userId" = '00000000-0000-0000-0000-000000000001');

ALTER TABLE "Wallet"
  ADD CONSTRAINT "Wallet_locked_not_negative"
  CHECK ("lockedNgn" >= 0);
