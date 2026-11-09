-- Analytics for where riders stop. Two parts:
--
-- 1. RidePageEvent: what a rider does on the WhatsApp ride page, step by step
--    (opened it, saw the price, changed it, found drivers, offers came, raised,
--    accepted, paid, cancelled and why, changed the trip, left), sent by the
--    page itself. One row per thing done, numbered within the page visit.
--
-- 2. Views for analysts (Power BI, Python, Excel), snake_case, one fact each:
--      ride_funnel          one row per ride, every channel: each stage's time, how far it got, where it stopped
--      ride_page_sessions   one row per visit to the WhatsApp ride page: what they did and where they left
--      ride_page_events     the page's raw steps
--      ride_bids            every driver offer on every ride
--      rider_events         everything else recorded about riders and drivers (quotes, sign-ins, searches...)
--      price_quotes         every price the app or WhatsApp showed (no user: the price side)
--    Lagos days and hours are worked out in the views; times are UTC.

CREATE TABLE "RidePageEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rideId" TEXT,
    "event" TEXT NOT NULL,
    "phase" TEXT,
    "seq" INTEGER NOT NULL,
    "props" JSONB,
    "clientAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RidePageEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RidePageEvent_sessionId_seq_key" ON "RidePageEvent"("sessionId", "seq");
CREATE INDEX "RidePageEvent_createdAt_idx" ON "RidePageEvent"("createdAt");
CREATE INDEX "RidePageEvent_userId_createdAt_idx" ON "RidePageEvent"("userId", "createdAt");
CREATE INDEX "RidePageEvent_event_createdAt_idx" ON "RidePageEvent"("event", "createdAt");
CREATE INDEX "RidePageEvent_rideId_idx" ON "RidePageEvent"("rideId");
CREATE INDEX "DriverBid_rideId_createdAt_idx" ON "DriverBid"("rideId", "createdAt");

-- ── ride_funnel ────────────────────────────────────────────────────────────
CREATE VIEW ride_funnel AS
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
    WHEN s."cancelReason" IS NOT DISTINCT FROM 'Replaced by a newer request' THEN 'replaced_by_new_request'
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

-- ── ride_page_events ───────────────────────────────────────────────────────
CREATE VIEW ride_page_events AS
SELECT
  e."id"         AS event_id,
  e."sessionId"  AS session_id,
  e."userId"     AS user_id,
  e."rideId"     AS ride_id,
  e."seq"        AS step,
  e."event"      AS event,
  e."phase"      AS phase,
  e."props"::text AS props,
  e."clientAt"   AS client_at,
  e."createdAt"  AS recorded_at,
  ((e."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos')::date AS day
FROM "RidePageEvent" e;

-- ── ride_page_sessions ─────────────────────────────────────────────────────
CREATE VIEW ride_page_sessions AS
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
    max((e."props"->>'count')::int) FILTER (WHERE e."event" = 'offer_received') AS most_offers_seen,
    count(*) FILTER (WHERE e."event" = 'raise_tapped') AS raises_tapped,
    count(*) FILTER (WHERE e."event" = 'price_updated') AS price_updates,
    count(*) FILTER (WHERE e."event" = 'offer_declined') AS offers_declined,
    bool_or(e."event" = 'decline_all') AS declined_all,
    bool_or(e."event" = 'accept_tapped') AS tapped_accept,
    bool_or(e."event" = 'wallet_short_shown') AS wallet_was_short,
    bool_or(e."event" = 'phase_shown' AND e."phase" = 'confirmed') AS driver_confirmed,
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

-- ── ride_bids ──────────────────────────────────────────────────────────────
CREATE VIEW ride_bids AS
SELECT
  b."id"           AS bid_id,
  b."rideId"       AS ride_id,
  b."driverId"     AS driver_id,
  b."riderId"      AS rider_id,
  b."amountNgn"    AS amount_ngn,
  r."riderOfferNgn" AS rider_offer_ngn,
  CASE WHEN r."riderOfferNgn" > 0 THEN round((b."amountNgn" / r."riderOfferNgn")::numeric, 3) END AS ratio_to_rider_offer,
  b."etaSeconds"   AS eta_seconds,
  b."distanceKm"   AS distance_km_to_pickup,
  b."status"::text AS status,
  b."createdAt"    AS offered_at,
  b."resolvedAt"   AS resolved_at,
  round(extract(epoch FROM (b."createdAt" - r."createdAt")) / 60.0, 2) AS minutes_after_request,
  ((b."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos')::date AS day
FROM "DriverBid" b
JOIN "Ride" r ON r."id" = b."rideId";

-- ── rider_events ───────────────────────────────────────────────────────────
CREATE VIEW rider_events AS
SELECT
  a."id"         AS event_id,
  a."userId"     AS user_id,
  a."eventType"  AS event,
  a."source"     AS source,
  a."rideId"     AS ride_id,
  a."metadata"::text AS metadata,
  a."occurredAt" AS occurred_at,
  ((a."occurredAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos')::date AS day,
  extract(hour FROM ((a."occurredAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos'))::int AS hour
FROM "UserActivityEvent" a;

-- ── price_quotes ───────────────────────────────────────────────────────────
CREATE VIEW price_quotes AS
SELECT
  q."id"               AS quote_id,
  q."createdAt"        AS quoted_at,
  q."pickupZone"       AS pickup_zone,
  q."distanceKm"       AS distance_km,
  round(q."durationSeconds" / 60.0, 1) AS planned_minutes,
  q."suggestedFareNgn" AS suggested_fare_ngn,
  q."minOfferNgn"      AS min_offer_ngn,
  q."marketFareNgn"    AS market_fare_ngn,
  q."floorFareNgn"     AS floor_fare_ngn,
  q."setBy"            AS set_by,
  q."rush"             AS rush,
  q."dayPeriod"        AS day_period,
  q."hourFactor"       AS hour_factor,
  q."surgeFactor"      AS surge_factor,
  q."demandFactor"     AS demand_factor,
  q."trafficRatio"     AS traffic_ratio,
  ((q."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos')::date AS day,
  extract(hour FROM ((q."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos'))::int AS hour
FROM "PricingQuote" q;
