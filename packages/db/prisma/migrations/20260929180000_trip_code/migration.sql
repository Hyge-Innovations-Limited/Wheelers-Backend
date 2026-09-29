-- The trip code: 4 digits the rider gives the driver, who cannot start the
-- trip without them. Issued when a driver is assigned, shown only to the
-- rider. Support can start a trip without it (the rider's phone died); who
-- did, and when, is kept.

ALTER TABLE "Ride" ADD COLUMN "tripCode" TEXT;
ALTER TABLE "Ride" ADD COLUMN "tripCodeVerifiedAt" TIMESTAMP(3);
ALTER TABLE "Ride" ADD COLUMN "tripCodeWrongTries" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Ride" ADD COLUMN "tripCodeUnlockedBy" TEXT;
ALTER TABLE "Ride" ADD COLUMN "tripCodeUnlockedAt" TIMESTAMP(3);
