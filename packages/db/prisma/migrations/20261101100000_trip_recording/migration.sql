-- CreateTable: trip voice recording segments (expand only; nothing existing changes)
CREATE TABLE "TripRecording" (
    "id" TEXT NOT NULL,
    "rideId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "segmentIndex" INTEGER NOT NULL,
    "objectKey" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "durationSec" INTEGER,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "TripRecording_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TripRecording_rideId_segmentIndex_key" ON "TripRecording"("rideId", "segmentIndex");
CREATE INDEX "TripRecording_rideId_idx" ON "TripRecording"("rideId");
CREATE INDEX "TripRecording_createdAt_idx" ON "TripRecording"("createdAt");
