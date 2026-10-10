-- Which pricing rules a ride settles by. Every ride that exists now was
-- priced under version 1, so the column arrives as 1 for them; from here on
-- new rides are version 2 (VAT and the booking fee in the rider's fare, 10%
-- commission from the driver).
ALTER TABLE "Ride" ADD COLUMN "pricingVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Ride" ALTER COLUMN "pricingVersion" SET DEFAULT 2;
