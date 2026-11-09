-- Analytics facts recorded on the ride itself: how it was booked, its launch zone,
-- and the platform fee split. One view reads them for every dashboard number.

CREATE TYPE "RideChannel" AS ENUM ('APP', 'WHATSAPP', 'MCP', 'UNKNOWN');

ALTER TABLE "Ride"
  ADD COLUMN "commissionNgn" DECIMAL(18,2),
  ADD COLUMN "serviceFeeNgn" DECIMAL(18,2),
  ADD COLUMN "stateLevyNgn" DECIMAL(18,2),
  ADD COLUMN "feeSplitEstimated" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "channel" "RideChannel" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "pickupZone" TEXT,
  ADD COLUMN "destZone" TEXT;

CREATE INDEX "Ride_createdAt_idx" ON "Ride"("createdAt");
CREATE INDEX "Ride_completedAt_idx" ON "Ride"("completedAt");
CREATE INDEX "Ride_channel_idx" ON "Ride"("channel");
CREATE INDEX "Ride_pickupZone_idx" ON "Ride"("pickupZone");

-- The one definition of a ride for analytics. Times are stored as UTC without a
-- zone; the *_day columns are the Lagos calendar day. A group ride is one whose
-- id is a group request's anchor or listed in its matched rides.
CREATE VIEW ride_facts AS
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
  -- IS NOT DISTINCT FROM, not =: a ride with no cancel reason is "not superseded", never "unknown".
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
  ((r."cancelledAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos')::date AS cancelled_day
FROM "Ride" r;
