-- Wallet PIN + recovery email. All nullable / defaulted: no existing row changes
-- meaning, and nobody has a PIN until they set one on their next withdrawal.
ALTER TABLE "User"
  ADD COLUMN "walletPinHash"              TEXT,
  ADD COLUMN "walletPinSetAt"             TIMESTAMP(3),
  ADD COLUMN "walletPinFailedAttempts"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "walletPinLockedUntil"       TIMESTAMP(3),
  ADD COLUMN "withdrawalsFrozenUntil"     TIMESTAMP(3),
  ADD COLUMN "withdrawalsFrozenReason"    TEXT,
  ADD COLUMN "withdrawalsRestrictedUntil" TIMESTAMP(3),
  ADD COLUMN "recoveryEmail"              TEXT,
  ADD COLUMN "recoveryEmailVerifiedAt"    TIMESTAMP(3);
