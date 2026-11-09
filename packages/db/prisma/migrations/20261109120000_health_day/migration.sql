-- One row per Lagos day for the Health page's long-term lines. A new table only: nothing else changes.
CREATE TABLE "HealthDay" (
    "day" TEXT NOT NULL,
    "apiRequests" INTEGER NOT NULL,
    "apiErrors" INTEGER NOT NULL,
    "apiP95Ms" INTEGER,
    "dbQueries" INTEGER NOT NULL,
    "dbP95Ms" INTEGER,
    "locPings" INTEGER NOT NULL,
    "locP95Ms" INTEGER,
    "maxLoopP99Ms" INTEGER,
    "maxCpuPct" DOUBLE PRECISION,
    "maxRssMb" INTEGER,
    "maxKafkaLag" INTEGER,
    "searches" INTEGER NOT NULL,
    "trips" INTEGER NOT NULL,
    "activeRiders" INTEGER NOT NULL,
    "activeDrivers" INTEGER NOT NULL,
    "slowRoutes" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HealthDay_pkey" PRIMARY KEY ("day")
);
