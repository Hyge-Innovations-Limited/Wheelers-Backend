-- The km of the route as last priced (STOP_FIXED_PRICE_ENABLED): the baseline an unpriced change may not stretch past. Nullable, additive.
ALTER TABLE "Ride" ADD COLUMN "pricedPlannedKm" DOUBLE PRECISION;
