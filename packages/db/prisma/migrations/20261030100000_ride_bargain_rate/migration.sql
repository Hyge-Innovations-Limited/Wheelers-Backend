-- The ride negotiated rate (agreed fare / our suggested fare at booking), fixed when the driver is matched (STOP_FIXED_PRICE_ENABLED). Nullable, additive.
ALTER TABLE "Ride" ADD COLUMN "bargainRate" DOUBLE PRECISION;
