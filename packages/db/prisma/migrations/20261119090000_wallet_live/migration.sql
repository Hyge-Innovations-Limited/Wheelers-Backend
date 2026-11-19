-- Live wallet (Timi, 19 Nov 2026): the database says when a wallet changes, from every path that writes one, so the
-- app's balance and money history update by themselves (api-gateway src/wallet/live.ts LISTENs and pushes to the
-- person's open app). A balance or hold change, and every new transaction row: one pg_notify each, sent on commit
-- (never for a write that is rolled back). Additive only: no table or column changes.
CREATE OR REPLACE FUNCTION wheelers_wallet_live() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'Wallet' THEN
    IF NEW."balanceNgn" IS DISTINCT FROM OLD."balanceNgn" OR NEW."lockedNgn" IS DISTINCT FROM OLD."lockedNgn" THEN
      PERFORM pg_notify('wallet_live', json_build_object(
        'k', 'w', 'u', NEW."userId", 'b', NEW."balanceNgn", 'l', NEW."lockedNgn", 'at', NEW."updatedAt"
      )::text);
    END IF;
  ELSE
    PERFORM pg_notify('wallet_live', json_build_object(
      'k', 't',
      'u', (SELECT w."userId" FROM "Wallet" w WHERE w.id = NEW."walletId"),
      'id', NEW.id, 'type', NEW.type, 'd', NEW.direction, 'a', NEW."amountNgn", 'ba', NEW."balanceAfterNgn",
      'r', NEW."referenceId", 'at', NEW."createdAt",
      -- notify payloads stop at 8000 bytes: a large metadata is left out (the app fetches that row).
      'm', CASE WHEN NEW.metadata IS NULL OR octet_length(NEW.metadata::text) <= 2000 THEN NEW.metadata ELSE NULL END,
      'mx', (NEW.metadata IS NOT NULL AND octet_length(NEW.metadata::text) > 2000)
    )::text);
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wallet_live_wallet ON "Wallet";
CREATE TRIGGER wallet_live_wallet AFTER UPDATE ON "Wallet" FOR EACH ROW EXECUTE FUNCTION wheelers_wallet_live();

DROP TRIGGER IF EXISTS wallet_live_transaction ON "Transaction";
CREATE TRIGGER wallet_live_transaction AFTER INSERT ON "Transaction" FOR EACH ROW EXECUTE FUNCTION wheelers_wallet_live();
