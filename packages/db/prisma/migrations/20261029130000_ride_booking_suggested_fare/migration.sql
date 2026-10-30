-- Our suggested fare for the route at booking (STOP_FIXED_PRICE_ENABLED): the base of the ride's negotiated rate. Nullable, additive.
ALTER TABLE "Ride" ADD COLUMN "bookingSuggestedFareNgn" DECIMAL(18,2);
