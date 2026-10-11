-- The other app's figures were first seeded from one quote and a guessed trip
-- time. A second real quote (15.5 km in 23 minutes on a clear road, N5,800)
-- and the first one's real trip time (16 km in 33 minutes, N7,200) give
-- better ones, and the pricing model was trained with these. Only a row
-- still holding the first guess is changed: figures an owner has typed in
-- are left alone.
UPDATE "PricingSettings"
SET "data" = jsonb_set(
      jsonb_set("data", '{quiet}', '{"baseNgn": 500, "perKmNgn": 268, "perMinuteNgn": 50}'::jsonb),
      '{rush}', '{"baseNgn": 575, "perKmNgn": 308, "perMinuteNgn": 58}'::jsonb),
    "updatedBy" = 'migration',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'current'
  AND "data"->'quiet' = '{"baseNgn": 500, "perKmNgn": 290, "perMinuteNgn": 50}'::jsonb
  AND "data"->'rush' = '{"baseNgn": 600, "perKmNgn": 350, "perMinuteNgn": 60}'::jsonb;
