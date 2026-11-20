-- One NIN, one account (Timi, 20 Nov 2026): a keyed hash of a verified NIN, never the number itself. Additive only.
ALTER TABLE "User" ADD COLUMN "ninHash" TEXT;
CREATE INDEX "User_ninHash_idx" ON "User"("ninHash");
