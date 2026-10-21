-- Pricing version 3, from 2026-10-21: the driver gives up 5% commission
-- (was 10%), a flat ₦300 WhatsApp fee and the ₦30 levy. The WhatsApp fee is
-- recorded at settlement beside the other lines; rides settled before have
-- none (null, never a guess). New rides are version 3; old ones keep theirs.

ALTER TABLE "Ride" ADD COLUMN "whatsappFeeNgn" DECIMAL(18,2);
ALTER TABLE "Ride" ALTER COLUMN "pricingVersion" SET DEFAULT 3;

-- The analytics view carries it too. Added at the end: a view may only grow.
CREATE OR REPLACE VIEW ride_facts AS
SELECT
  r."id",
  r."riderId"            AS rider_id,
  r."driverId"           AS driver_id,
  r."status"::text       AS status,
  r."paymentMethod"::text AS payment_method,
  r."channel"::text      AS channel,
  r."pickupZone"         AS pickup_zone,
  r."destZone"           AS dest_zone,
  r."pickupAddress"      AS pickup_address,
  r."destAddress"        AS dest_address,
  r."distanceKm"         AS distance_km,
  r."durationSeconds"    AS duration_seconds,
  r."fareEstimateNgn"    AS fare_estimate_ngn,
  r."riderOfferNgn"      AS rider_offer_ngn,
  COALESCE(r."fareFinalNgn", r."agreedFareNgn") AS fare_ngn,
  r."platformFeeNgn"     AS platform_total_ngn,
  r."commissionNgn"      AS commission_ngn,
  r."serviceFeeNgn"      AS service_fee_ngn,
  r."stateLevyNgn"       AS state_levy_ngn,
  r."feeSplitEstimated"  AS fee_split_estimated,
  r."cancelStage"::text  AS cancel_stage,
  r."cancelReason"       AS cancel_reason,
  (r."cancelReason" IS NOT DISTINCT FROM 'Replaced by a newer request') AS superseded,
  (r."cancelReason" IS NOT DISTINCT FROM 'No driver accepted in time')  AS no_driver,
  EXISTS (
    SELECT 1 FROM "GroupRideMatchRequest" g
    WHERE g."id" = r."id" OR g."matchedRideIds" @> to_jsonb(r."id")
  ) AS is_group,
  r."createdAt"   AS created_at,
  r."matchedAt"   AS matched_at,
  r."completedAt" AS completed_at,
  r."cancelledAt" AS cancelled_at,
  ((r."createdAt"   AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos')::date AS created_day,
  ((r."completedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos')::date AS completed_day,
  ((r."cancelledAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos')::date AS cancelled_day,
  r."tripNumber"  AS trip_number,
  r."startedAt"   AS started_at,
  r."agreedFareNgn" AS agreed_fare_ngn,
  r."vatNgn"        AS vat_ngn,
  r."whatsappFeeNgn" AS whatsapp_fee_ngn
FROM "Ride" r;
