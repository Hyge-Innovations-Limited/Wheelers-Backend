-- Each price shown keeps the hour's multiplier and the live surge it carried,
-- so the nightly curve can tell a surge from the usual price for that hour.
ALTER TABLE "PricingQuote" ADD COLUMN "hourFactor" DOUBLE PRECISION;
ALTER TABLE "PricingQuote" ADD COLUMN "surgeFactor" DOUBLE PRECISION NOT NULL DEFAULT 1;
