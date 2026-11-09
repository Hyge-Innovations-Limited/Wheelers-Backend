-- The km of the route the agreed fare was set for (STOP_FIXED_PRICE_ENABLED). Nullable, additive.
ALTER TABLE "Ride" ADD COLUMN "plannedDistanceKm" DOUBLE PRECISION;
