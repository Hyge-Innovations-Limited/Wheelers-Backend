-- Live map + dispatch. Additive only: no existing column or row changes meaning.

ALTER TABLE "Driver"
  ADD COLUMN "standbyEnabled"   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "standbyConsentAt" TIMESTAMP(3),
  ADD COLUMN "standbyLat"       DOUBLE PRECISION,
  ADD COLUMN "standbyLng"       DOUBLE PRECISION,
  ADD COLUMN "standbySeenAt"    TIMESTAMP(3);

CREATE TABLE "DriverLocationPoint" (
  "id"         BIGSERIAL NOT NULL,
  "driverId"   TEXT NOT NULL,
  "lat"        DOUBLE PRECISION NOT NULL,
  "lng"        DOUBLE PRECISION NOT NULL,
  "source"     TEXT NOT NULL DEFAULT 'online',
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DriverLocationPoint_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DriverLocationPoint_driverId_recordedAt_idx" ON "DriverLocationPoint"("driverId", "recordedAt");
CREATE INDEX "DriverLocationPoint_recordedAt_idx" ON "DriverLocationPoint"("recordedAt");
ALTER TABLE "DriverLocationPoint" ADD CONSTRAINT "DriverLocationPoint_driverId_fkey"
  FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "DispatchContact" (
  "id"        TEXT NOT NULL,
  "driverId"  TEXT NOT NULL,
  "rideId"    TEXT,
  "adminName" TEXT NOT NULL,
  "kind"      TEXT NOT NULL,
  "outcome"   TEXT NOT NULL,
  "note"      TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DispatchContact_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DispatchContact_driverId_createdAt_idx" ON "DispatchContact"("driverId", "createdAt");
CREATE INDEX "DispatchContact_rideId_createdAt_idx" ON "DispatchContact"("rideId", "createdAt");
ALTER TABLE "DispatchContact" ADD CONSTRAINT "DispatchContact_driverId_fkey"
  FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;
