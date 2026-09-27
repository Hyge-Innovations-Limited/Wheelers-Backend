-- Driver shifts: when each driver went on shift and when they came off.
--
-- Until now the system only knew whether a driver was online at this moment.
-- "How many hours was this driver online last week" and "how many drivers are
-- on at 8 in the morning" had no answer, because nothing was written down when
-- a shift began or ended. One row per shift; an open shift has no end yet.

CREATE TABLE "DriverShift" (
  "id"        TEXT NOT NULL,
  "driverId"  TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt"   TIMESTAMP(3),
  -- manual | app_closed | inactivity | admin | stale
  "endReason" TEXT,
  CONSTRAINT "DriverShift_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DriverShift_driverId_startedAt_idx" ON "DriverShift"("driverId", "startedAt");
CREATE INDEX "DriverShift_startedAt_idx" ON "DriverShift"("startedAt");
CREATE INDEX "DriverShift_endedAt_idx" ON "DriverShift"("endedAt");

-- A driver has at most one open shift, however many processes hear them come online.
CREATE UNIQUE INDEX "DriverShift_one_open_per_driver" ON "DriverShift"("driverId") WHERE "endedAt" IS NULL;

ALTER TABLE "DriverShift"
  ADD CONSTRAINT "DriverShift_driverId_fkey"
  FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Drivers who are on shift at the moment this is applied: their shift is
-- counted from now. When it really began was never recorded.
INSERT INTO "DriverShift" ("id", "driverId", "startedAt")
SELECT md5(random()::text || d."id" || clock_timestamp()::text), d."id", CURRENT_TIMESTAMP
FROM "Driver" d
WHERE d."status" IN ('ONLINE', 'ON_RIDE') AND d."lastSeenAt" > CURRENT_TIMESTAMP - interval '10 minutes';
