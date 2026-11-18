-- Group ride trips (Timi, 17 Nov 2026): a ride's group trip and its role in it. Additive only.
ALTER TABLE "Ride" ADD COLUMN "groupTripId" TEXT;
ALTER TABLE "Ride" ADD COLUMN "groupRole" TEXT;
ALTER TABLE "Ride" ADD COLUMN "groupStops" JSONB;
CREATE INDEX "Ride_groupTripId_idx" ON "Ride"("groupTripId");
