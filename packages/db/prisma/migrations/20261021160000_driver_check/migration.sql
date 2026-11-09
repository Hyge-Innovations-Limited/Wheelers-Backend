-- A check of a driver's licence or car: one Prembly ran from the admin
-- (licence, licence with face, plate, insurance), or one an admin did by hand
-- on a government site (AutoReg, DVIS, NIID) and recorded. What came back is
-- kept as key fields only: never the licence photo.
CREATE TABLE "DriverCheck" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "paperType" TEXT,
    "source" TEXT NOT NULL,
    "input" TEXT,
    "outcome" TEXT NOT NULL,
    "mismatches" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "found" JSONB,
    "reference" TEXT,
    "note" TEXT,
    "byId" TEXT,
    "byName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverCheck_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DriverCheck_driverId_createdAt_idx" ON "DriverCheck"("driverId", "createdAt");
CREATE INDEX "DriverCheck_source_createdAt_idx" ON "DriverCheck"("source", "createdAt");

ALTER TABLE "DriverCheck" ADD CONSTRAINT "DriverCheck_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;
