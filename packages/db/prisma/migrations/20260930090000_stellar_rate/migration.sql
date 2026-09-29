-- Stellar Testnet as its own ledger: each transfer keeps the live naira-per-XLM
-- rate it used, so its naira equivalent can always be checked. Adds a column;
-- nothing existing changes.

ALTER TABLE "StellarTransfer" ADD COLUMN "rateNgnPerXlm" DECIMAL(18,4);
