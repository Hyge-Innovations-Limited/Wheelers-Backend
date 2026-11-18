-- Group ride (17 Nov 2026): a group trip is one TRIP ride (the driver's job, owned by the group account) and the
-- riders' own rides as its SEATS. The dashboards count the seats (each a rider's ride, fare and fees) and never the
-- TRIP, which would count every group ride twice. Same columns, same order; seats count as group rides.
-- Views only: no table changes, safe before or after the code.

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
  ), false) OR r."groupRole" IS NOT DISTINCT FROM 'SEAT' AS is_group,
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
  r."whatsappFeeNgn" AS whatsapp_fee_ngn,
  -- Appended (never inserted): a view keeps its columns by position.
  r."arrivedAt"                AS arrived_at,
  r."bookingSuggestedFareNgn"  AS booking_suggested_fare_ngn,
  r."plannedDistanceKm"        AS planned_distance_km,
  r."bargainRate"              AS bargain_rate,
  r."cancelledBy"              AS cancelled_by,
  r."firstRiderOfferNgn"       AS first_rider_offer_ngn,
  r."riderOfferChanges"        AS rider_offer_changes
FROM "Ride" r
-- A group trip (groupRole TRIP) is the driver's job, not a ride of its own: its riders' seats are the rides.
WHERE r."groupRole" IS DISTINCT FROM 'TRIP';

CREATE OR REPLACE VIEW ride_funnel AS
WITH bids AS (
  SELECT
    b."rideId",
    count(*)                    AS offers,
    count(DISTINCT b."driverId") AS drivers_offering,
    min(b."createdAt")          AS first_offer_at,
    min(b."amountNgn")          AS lowest_offer_ngn,
    max(b."amountNgn")          AS highest_offer_ngn
  FROM "DriverBid" b
  GROUP BY b."rideId"
), stages AS (
  SELECT
    r.*,
    COALESCE(bids.offers, 0) AS offers,
    COALESCE(bids.drivers_offering, 0) AS drivers_offering,
    bids.first_offer_at,
    bids.lowest_offer_ngn,
    bids.highest_offer_ngn,
    -- The furthest of what the times say and what the status says (older rides have the status without every time).
    GREATEST(
      CASE
        WHEN r."completedAt" IS NOT NULL THEN 6
        WHEN r."startedAt"   IS NOT NULL THEN 5
        WHEN r."arrivedAt"   IS NOT NULL THEN 4
        WHEN r."matchedAt"   IS NOT NULL THEN 3
        WHEN COALESCE(bids.offers, 0) > 0 THEN 2
        ELSE 1
      END,
      CASE r."status"
        WHEN 'COMPLETED' THEN 6
        WHEN 'IN_PROGRESS' THEN 5
        WHEN 'ARRIVED' THEN 4
        WHEN 'DRIVER_ASSIGNED' THEN 3
        WHEN 'DRIVER_EN_ROUTE' THEN 3
        ELSE 1
      END
    ) AS stage_reached
  FROM "Ride" r
  LEFT JOIN bids ON bids."rideId" = r."id"
  WHERE r."groupRole" IS DISTINCT FROM 'TRIP'
)
SELECT
  s."id"                     AS ride_id,
  s."tripNumber"             AS trip_number,
  s."riderId"                AS rider_id,
  s."driverId"               AS driver_id,
  s."channel"::text          AS channel,
  s."pickupZone"             AS pickup_zone,
  s."destZone"               AS dest_zone,
  s."distanceKm"             AS distance_km,
  round(s."durationSeconds" / 60.0, 1) AS planned_minutes,
  s."pricingVersion"         AS pricing_version,
  s."fareEstimateNgn"        AS suggested_fare_ngn,
  s."riderOfferNgn"          AS rider_offer_ngn,
  s."agreedFareNgn"          AS agreed_fare_ngn,
  s."fareFinalNgn"           AS final_fare_ngn,
  s."paymentMethod"::text    AS payment_method,
  s.offers,
  s.drivers_offering,
  s.lowest_offer_ngn,
  s.highest_offer_ngn,
  s."status"::text           AS status,
  CASE
    WHEN s."status" = 'COMPLETED' THEN 'completed'
    WHEN s."cancelReason" IN ('Replaced by a newer request', 'Changed the trip on the offers page') THEN 'replaced_by_new_request'
    WHEN s."cancelReason" IS NOT DISTINCT FROM 'No driver accepted in time' THEN 'no_driver'
    WHEN s."status" = 'CANCELLED' THEN 'cancelled'
    WHEN s."status" = 'DISPUTED' THEN 'disputed'
    ELSE 'open'
  END                        AS outcome,
  s.stage_reached,
  (ARRAY['1_searching', '2_offers_received', '3_driver_assigned', '4_driver_arrived', '5_trip_started', '6_completed'])[s.stage_reached] AS furthest_stage,
  -- Where a ride that did not finish stopped: the stage it was at when it ended.
  CASE WHEN s."status" IN ('CANCELLED', 'DISPUTED')
       THEN (ARRAY['1_searching', '2_offers_received', '3_driver_assigned', '4_driver_arrived', '5_trip_started', '6_completed'])[s.stage_reached]
  END                        AS stopped_at_stage,
  s."cancelStage"::text      AS cancel_stage,
  s."cancelReason"           AS cancel_reason,
  s."createdAt"              AS requested_at,
  s.first_offer_at,
  s."matchedAt"              AS driver_assigned_at,
  s."arrivedAt"              AS driver_arrived_at,
  s."startedAt"              AS trip_started_at,
  s."completedAt"            AS completed_at,
  s."cancelledAt"            AS cancelled_at,
  round(extract(epoch FROM (s.first_offer_at - s."createdAt")) / 60.0, 2)   AS minutes_to_first_offer,
  round(extract(epoch FROM (s."matchedAt" - s."createdAt")) / 60.0, 2)      AS minutes_to_driver_assigned,
  round(extract(epoch FROM (s."arrivedAt" - s."matchedAt")) / 60.0, 2)      AS minutes_driver_to_pickup,
  round(extract(epoch FROM (s."startedAt" - s."arrivedAt")) / 60.0, 2)      AS minutes_waiting_at_pickup,
  round(extract(epoch FROM (s."completedAt" - s."startedAt")) / 60.0, 2)    AS minutes_in_trip,
  round(extract(epoch FROM (s."cancelledAt" - s."createdAt")) / 60.0, 2)    AS minutes_until_cancelled,
  ((s."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos')::date    AS requested_day,
  extract(hour FROM ((s."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos'))::int AS requested_hour,
  to_char(((s."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos'), 'Dy') AS requested_weekday
FROM stages s;
