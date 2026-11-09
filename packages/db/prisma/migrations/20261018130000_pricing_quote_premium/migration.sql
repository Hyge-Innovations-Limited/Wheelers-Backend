-- Each price shown keeps the trip's key (its ends and the half hour), the
-- premium over the other app it carried, where in the part of the day's range
-- that sat, and which part of the day it was: so a quote can be matched to the
-- ride it became (npm run pricing report) and the model learn from real trips.
ALTER TABLE "PricingQuote" ADD COLUMN "tripKey" TEXT;
ALTER TABLE "PricingQuote" ADD COLUMN "premiumNgn" DECIMAL(12,2);
ALTER TABLE "PricingQuote" ADD COLUMN "premiumPosition" DOUBLE PRECISION;
ALTER TABLE "PricingQuote" ADD COLUMN "dayPeriod" TEXT;
CREATE INDEX "PricingQuote_tripKey_idx" ON "PricingQuote"("tripKey");
