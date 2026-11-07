-- What the rider told drivers about the trip: people, luggage, a pet, a note. Expand only, all nullable.
ALTER TABLE "Ride" ADD COLUMN "passengers" INTEGER;
ALTER TABLE "Ride" ADD COLUMN "hasLuggage" BOOLEAN;
ALTER TABLE "Ride" ADD COLUMN "hasPet" BOOLEAN;
ALTER TABLE "Ride" ADD COLUMN "riderNote" TEXT;
ALTER TABLE "ScheduledRide" ADD COLUMN "tripDetails" JSONB;
