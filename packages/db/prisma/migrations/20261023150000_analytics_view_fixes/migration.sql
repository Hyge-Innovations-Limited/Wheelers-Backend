-- Fixes to two analytics views; same columns, same order.
--
-- ride_funnel: a search stopped to change the trip on the WhatsApp page
-- ("Changed the trip on the offers page") is not a loss: the rider searches
-- again with the changed trip, so it counts with replaced_by_new_request.
--
-- ride_page_sessions:
--  - most_offers_seen reads "count" only when it is a number. Any rider can
--    send a step, and one "count":"abc" made every query on the view fail.
--  - driver_confirmed (and so outcome 'booked') only when the page moved to
--    the confirmed screen from another one. Opening the link again during a
--    trip shows that screen first ("from": "none"): looking at the map is not
--    a booking.

-- ── ride_funnel ──
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

-- ── ride_page_sessions ──
CREATE OR REPLACE VIEW ride_page_sessions AS
WITH s AS (
  SELECT
    e."sessionId" AS session_id,
    min(e."userId") AS user_id,
    min(e."createdAt") AS started_at,
    max(e."createdAt") AS last_event_at,
    count(*) AS events,
    bool_or(e."event" = 'phase_shown' AND e."phase" = 'price') AS saw_price,
    count(*) FILTER (WHERE e."event" = 'price_changed') AS price_changes,
    bool_or(e."event" = 'trip_edit_opened') AS opened_trip_edit,
    bool_or(e."event" = 'trip_saved') AS changed_trip,
    bool_or(e."event" = 'find_tapped') AS tapped_find_drivers,
    count(*) FILTER (WHERE e."event" = 'find_failed') AS find_failures,
    bool_or(e."event" = 'phase_shown' AND e."phase" = 'offers') AS searched,
    bool_or(e."event" = 'offer_received') AS got_offers,
    max(CASE WHEN jsonb_typeof(e."props"->'count') = 'number' THEN floor((e."props"->>'count')::numeric)::int END) FILTER (WHERE e."event" = 'offer_received') AS most_offers_seen,
    count(*) FILTER (WHERE e."event" = 'raise_tapped') AS raises_tapped,
    count(*) FILTER (WHERE e."event" = 'price_updated') AS price_updates,
    count(*) FILTER (WHERE e."event" = 'offer_declined') AS offers_declined,
    bool_or(e."event" = 'decline_all') AS declined_all,
    bool_or(e."event" = 'accept_tapped') AS tapped_accept,
    bool_or(e."event" = 'wallet_short_shown') AS wallet_was_short,
    bool_or(e."event" = 'phase_shown' AND e."phase" = 'confirmed' AND e."props"->>'from' IS DISTINCT FROM 'none') AS driver_confirmed,
    bool_or(e."event" = 'edit_trip_back_confirmed') AS went_back_to_edit,
    bool_or(e."event" = 'cancel_opened') AS opened_cancel,
    bool_or(e."event" = 'cancel_confirmed') AS cancelled,
    max(e."props"->>'reason') FILTER (WHERE e."event" = 'cancel_confirmed') AS cancel_reason,
    max(e."props"->>'detail') FILTER (WHERE e."event" = 'cancel_confirmed') AS cancel_detail,
    min(e."createdAt") FILTER (WHERE e."event" = 'find_tapped') AS find_tapped_at,
    min(e."createdAt") FILTER (WHERE e."event" = 'offer_received') AS first_offer_at,
    min(e."createdAt") FILTER (WHERE e."event" = 'accept_tapped') AS accept_tapped_at,
    (array_agg(e."event" ORDER BY e."seq" DESC))[1] AS last_event,
    (array_agg(e."phase" ORDER BY e."seq" DESC))[1] AS last_phase,
    (array_agg(e."rideId" ORDER BY e."seq" DESC) FILTER (WHERE e."rideId" IS NOT NULL))[1] AS ride_id
  FROM "RidePageEvent" e
  GROUP BY e."sessionId"
)
SELECT
  s.*,
  round(extract(epoch FROM (s.last_event_at - s.started_at))::numeric, 0) AS seconds_on_page,
  round(extract(epoch FROM (s.first_offer_at - s.find_tapped_at)) / 60.0, 2) AS minutes_to_first_offer,
  round(extract(epoch FROM (s.accept_tapped_at - s.first_offer_at)) / 60.0, 2) AS minutes_offer_to_accept,
  CASE
    WHEN s.driver_confirmed THEN '5_driver_confirmed'
    WHEN s.tapped_accept THEN '4_tapped_accept'
    WHEN s.got_offers THEN '3_got_offers'
    WHEN s.tapped_find_drivers OR s.searched THEN '2_searched'
    WHEN s.saw_price THEN '1_saw_price'
    ELSE '0_opened'
  END AS furthest_step,
  CASE
    WHEN s.driver_confirmed THEN 'booked'
    WHEN s.cancelled THEN 'cancelled'
    WHEN s.went_back_to_edit THEN 'went_back_to_edit'
    ELSE 'left'
  END AS outcome,
  ((s.started_at AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos')::date AS day,
  extract(hour FROM ((s.started_at AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos'))::int AS hour
FROM s;
