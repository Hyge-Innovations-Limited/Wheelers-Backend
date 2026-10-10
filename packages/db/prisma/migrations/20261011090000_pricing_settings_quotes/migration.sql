-- CreateTable
CREATE TABLE "PricingSettings" (
    "id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingQuote" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "originLat" DOUBLE PRECISION NOT NULL,
    "originLng" DOUBLE PRECISION NOT NULL,
    "destLat" DOUBLE PRECISION NOT NULL,
    "destLng" DOUBLE PRECISION NOT NULL,
    "pickupZone" TEXT,
    "distanceKm" DOUBLE PRECISION NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "trafficRatio" DOUBLE PRECISION,
    "demandFactor" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "rush" BOOLEAN NOT NULL DEFAULT false,
    "marketFareNgn" DECIMAL(12,2),
    "floorFareNgn" DECIMAL(12,2),
    "rulesFareNgn" DECIMAL(12,2) NOT NULL,
    "modelFareNgn" DECIMAL(12,2),
    "suggestedFareNgn" DECIMAL(12,2) NOT NULL,
    "minOfferNgn" DECIMAL(12,2) NOT NULL,
    "setBy" TEXT NOT NULL,

    CONSTRAINT "PricingQuote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PricingQuote_createdAt_idx" ON "PricingQuote"("createdAt");

-- Pricing starts as agreed: never under the other app's fare + N300, lifted
-- by traffic and a busy area; the model only watches until an owner turns it
-- on. The other app's figures are a first guess from one quote (16 km,
-- N7,200): owners replace them on the admin's Pricing page.
INSERT INTO "PricingSettings" ("id", "data", "updatedBy", "updatedAt") VALUES (
  'current',
  '{"marketFloorOn": true, "premiumNgn": 300, "quiet": {"baseNgn": 500, "perKmNgn": 290, "perMinuteNgn": 50}, "rush": {"baseNgn": 600, "perKmNgn": 350, "perMinuteNgn": 60}, "trafficOn": true, "demandOn": true, "modelOn": false, "model": null, "liftCap": 1.5}',
  'migration',
  CURRENT_TIMESTAMP
);
