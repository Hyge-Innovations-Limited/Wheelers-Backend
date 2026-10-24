-- Rain in pricing: each zone's weather every 15 minutes, and the rain each quote was priced with.
-- A new table and two columns with defaults; nothing existing changes.

-- AlterTable
ALTER TABLE "PricingQuote" ADD COLUMN     "rain" TEXT,
ADD COLUMN     "rainFactor" DOUBLE PRECISION NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "WeatherReading" (
    "id" TEXT NOT NULL,
    "zone" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rain" TEXT NOT NULL,
    "mm" DOUBLE PRECISION,
    "condition" TEXT,

    CONSTRAINT "WeatherReading_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WeatherReading_at_idx" ON "WeatherReading"("at");

-- CreateIndex
CREATE INDEX "WeatherReading_zone_at_idx" ON "WeatherReading"("zone", "at");

