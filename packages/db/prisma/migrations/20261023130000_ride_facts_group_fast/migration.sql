-- The dashboard's rides view, faster: is_group no longer searches every group
-- request again for each ride (3.6 s for a year of rides on 19,000; every
-- dashboard number reads this view). Same columns, same answers.
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
  -- Every group ride's id, worked out once per query (a hashed list), not once per ride:
  -- the old per-ride search of every group request took 3.6 s over 19,000 rides.
  -- Same answer: the request's own ride, and each ride listed in matchedRideIds.
  COALESCE(r."id" IN (
    SELECT g."id" FROM "GroupRideMatchRequest" g
    UNION
    SELECT m.ride_id
    FROM "GroupRideMatchRequest" g,
      LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(g."matchedRideIds") = 'array' THEN g."matchedRideIds" ELSE '[]'::jsonb END) AS m(ride_id)
    WHERE m.ride_id IS NOT NULL
  ), false) AS is_group,
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
