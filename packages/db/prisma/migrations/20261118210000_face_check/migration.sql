-- The driver's face check before a ride (Timi, 18 Nov 2026). Additive only: two new tables.
CREATE TABLE "FaceCheck" (
  "id" TEXT NOT NULL,
  "rideId" TEXT NOT NULL,
  "driverId" TEXT NOT NULL,
  "driverUserId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "challenge" TEXT NOT NULL,
  "failedTries" INTEGER NOT NULL DEFAULT 0,
  "submits" INTEGER NOT NULL DEFAULT 0,
  "bestDistance" DOUBLE PRECISION,
  "lastReason" TEXT,
  "mode" TEXT NOT NULL,
  "frameKeys" JSONB,
  "framesDeletedAt" TIMESTAMP(3),
  "deadlineAt" TIMESTAMP(3) NOT NULL,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FaceCheck_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FaceCheck_rideId_driverId_key" ON "FaceCheck"("rideId", "driverId");
CREATE INDEX "FaceCheck_status_deadlineAt_idx" ON "FaceCheck"("status", "deadlineAt");
CREATE INDEX "FaceCheck_driverId_createdAt_idx" ON "FaceCheck"("driverId", "createdAt");
CREATE INDEX "FaceCheck_createdAt_idx" ON "FaceCheck"("createdAt");

CREATE TABLE "DriverFaceTemplate" (
  "driverId" TEXT NOT NULL,
  "selfieKey" TEXT NOT NULL,
  "descriptor" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DriverFaceTemplate_pkey" PRIMARY KEY ("driverId")
);
