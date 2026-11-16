-- Waiting price agreed between rider and driver, and the rider's NIN check at sign-up. Additive only.
ALTER TABLE "Ride" ADD COLUMN "waitingRateNgn" INTEGER;
ALTER TABLE "Ride" ADD COLUMN "waitingAgreedAt" TIMESTAMP(3);
ALTER TABLE "Ride" ADD COLUMN "waitingOfferBy" TEXT;
ALTER TABLE "Ride" ADD COLUMN "waitingOfferNgn" INTEGER;
ALTER TABLE "Ride" ADD COLUMN "waitingOfferAt" TIMESTAMP(3);
ALTER TABLE "Ride" ADD COLUMN "waitingOfferCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "User" ADD COLUMN "ninLast4" TEXT;
ALTER TABLE "User" ADD COLUMN "ninStatus" TEXT;
ALTER TABLE "User" ADD COLUMN "ninCheckedAt" TIMESTAMP(3);
