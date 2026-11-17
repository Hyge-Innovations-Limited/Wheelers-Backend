-- The rider's group ride selfie, taken once and reused (Timi, 17 Nov 2026). Additive only.
ALTER TABLE "User" ADD COLUMN "groupSelfieKey" TEXT;
ALTER TABLE "User" ADD COLUMN "groupSelfieAt" TIMESTAMP(3);
