-- Analytics capture for the Studio (Timi, 18 Nov 2026). Additive only: a nullable column and two new tables.
ALTER TABLE "Ride" ADD COLUMN "driversFoundAtSearch" INTEGER;

CREATE TABLE "SearchPing" (
  "id" TEXT NOT NULL,
  "rideId" TEXT NOT NULL,
  "driverId" TEXT NOT NULL,
  "round" INTEGER NOT NULL,
  "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "response" TEXT,
  "respondedAt" TIMESTAMP(3),
  CONSTRAINT "SearchPing_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SearchPing_rideId_driverId_round_key" ON "SearchPing"("rideId", "driverId", "round");
CREATE INDEX "SearchPing_rideId_idx" ON "SearchPing"("rideId");
CREATE INDEX "SearchPing_driverId_sentAt_idx" ON "SearchPing"("driverId", "sentAt");
CREATE INDEX "SearchPing_sentAt_idx" ON "SearchPing"("sentAt");

CREATE TABLE "RidePriceChange" (
  "id" TEXT NOT NULL,
  "rideId" TEXT NOT NULL,
  "fromNgn" INTEGER NOT NULL,
  "toNgn" INTEGER NOT NULL,
  "offersOpen" INTEGER NOT NULL,
  "lowestOfferNgn" INTEGER,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RidePriceChange_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RidePriceChange_rideId_idx" ON "RidePriceChange"("rideId");
CREATE INDEX "RidePriceChange_at_idx" ON "RidePriceChange"("at");
