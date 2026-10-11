-- CreateTable
CREATE TABLE "MarketSample" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "app" TEXT NOT NULL DEFAULT 'indrive',
    "km" DOUBLE PRECISION NOT NULL,
    "minutes" DOUBLE PRECISION NOT NULL,
    "priceNgn" DECIMAL(12,2) NOT NULL,
    "rush" BOOLEAN NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL,
    "addedBy" TEXT,

    CONSTRAINT "MarketSample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketSample_takenAt_idx" ON "MarketSample"("takenAt");

-- The one price read off the other app whose day and time are known (a clear
-- Sunday midday). The earlier one (16 km in 33 minutes, N7,200) is left for
-- whoever took it to add with the right hours: npm run pricing sample.
INSERT INTO "MarketSample" ("id", "app", "km", "minutes", "priceNgn", "rush", "takenAt", "addedBy") VALUES
  ('seed-sample-1', 'indrive', 15.511, 23, 5800, false, '2026-10-11 11:00:00', 'migration');
