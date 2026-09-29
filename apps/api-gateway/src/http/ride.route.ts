import type { IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "crypto";
import {
  referralClient,
  scheduledRideClient,
  rideClient,
  tripCodeClient,
} from "@wheleers/db";
import { GoogleMapsRoutePlanner, formatTripId } from "@wheleers/config";
import { Queue } from "bullmq";
import { authenticateHttpUser, HttpAuthError } from "./authenticate";
import { runIdempotentJsonRequest } from "./idempotency";
import { readJsonBody, sendJson } from "./utils";
import { getBoolean, getNumber, getRecord, getString, isRecord } from "../utils/object";
import { buildRideEstimatePricing } from "../pricing/ride-estimate";
import { logActivity } from "../analytics/log-activity";
import type { RedisClient } from "../redis/client";

interface RideRouteDeps {
  jwtSecret: string;
  routePlanner: GoogleMapsRoutePlanner;
}

interface RideHistoryRouteDeps {
  jwtSecret: string;
}

interface ScheduledRideRouteDeps {
  jwtSecret: string;
  routePlanner: GoogleMapsRoutePlanner;
  dispatcherQueue: Queue;
  leadTimeMs: number;
  redisClient: RedisClient;
}

type LatLngAddress = {
  lat: number;
  lng: number;
  address: string;
};

function buildScheduledRideJobId(scheduledRideId: string): string {
  return `scheduled-ride-${scheduledRideId}`;
}

function parseWaypoint(
  record: Record<string, unknown>,
  key: string,
): LatLngAddress {
  const value = getRecord(record, key);
  if (!value) {
    throw new Error(`Missing required field: ${key}`);
  }

  const lat = getNumber(value, "lat");
  const lng = getNumber(value, "lng");
  const address = getString(value, "address");

  if (lat === undefined || lng === undefined || !address) {
    throw new Error(`Invalid ${key} payload`);
  }

  return { lat, lng, address };
}

function parseStops(
  record: Record<string, unknown>,
  key: string,
): LatLngAddress[] {
  const value = record[key];
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${key} payload`);
  }

  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`Invalid ${key}[${index}] payload`);
    }

    const lat = getNumber(item, "lat");
    const lng = getNumber(item, "lng");
    const address = getString(item, "address");

    if (lat === undefined || lng === undefined || !address) {
      throw new Error(`Invalid ${key}[${index}] payload`);
    }

    return { lat, lng, address };
  });
}

function parseLimit(value: string | null): number {
  if (!value) {
    return 20;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 20;
  }

  return Math.min(parsed, 50);
}

function decimalToNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (
    value &&
    typeof value === "object" &&
    "toString" in value &&
    typeof value.toString === "function"
  ) {
    const parsed = Number(value.toString());
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function resolveNetFareNgn(params: {
  grossFareNgn: number;
  discountNgn: number;
}): number {
  if (params.discountNgn <= 0 || params.grossFareNgn <= 0) {
    return params.grossFareNgn;
  }

  return Math.max(0, params.grossFareNgn - params.discountNgn);
}

function parseScheduledFor(value: unknown): Date {
  if (typeof value !== "string") {
    throw new Error("scheduledFor must be an ISO datetime string");
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("scheduledFor must be a valid ISO datetime string");
  }

  return parsed;
}

function mapScheduledRideItem(
  ride: Awaited<ReturnType<typeof scheduledRideClient.findByRider>>[number],
) {
  const pricing = buildRideEstimatePricing(ride.plannedDistanceKm ?? null);
  return {
    id: ride.id,
    status: ride.status,
    scheduledFor: ride.scheduledFor.toISOString(),
    paymentMethod: "wallet_balance" as const,
    pickupAddress: ride.pickupAddress,
    destAddress: ride.destAddress,
    plannedDistanceKm: ride.plannedDistanceKm ?? null,
    plannedDurationSeconds: ride.plannedDurationSeconds ?? null,
    fareEstimateNgn: decimalToNumber(ride.fareEstimateNgn) ?? pricing.fareEstimateNgn,
    pricingCurrency: pricing.pricingCurrency,
    pricingBreakdown: pricing.pricingBreakdown,
    requestedRideId: ride.requestedRideId ?? null,
    createdAt: ride.createdAt.toISOString(),
  };
}

export async function handleRideEstimateRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RideRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);

    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: "Body must be a JSON object" });
      return;
    }

    const pickup = parseWaypoint(rawBody, "pickup");
    const destination = parseWaypoint(rawBody, "destination");
    const stops = parseStops(rawBody, "stops");
    const plannedRoute = await deps.routePlanner.planRoute({
      origin: pickup,
      stops,
      destination,
    });

    logActivity({
      userId: user.id,
      eventType: "ride_estimate_requested",
      metadata: { distanceKm: plannedRoute.distanceKm },
    });

    sendJson(res, 200, {
      pickup,
      destination,
      stops,
      route: plannedRoute.geometry,
      plannedDistanceKm: plannedRoute.distanceKm,
      plannedDurationSeconds: plannedRoute.durationSeconds,
      suggestedFareNgn: plannedRoute.suggestedFareNgn,
      minOfferNgn: plannedRoute.minOfferNgn,
      ratePerKmNgn: plannedRoute.ratePerKmNgn,
      fareEstimateNgn: plannedRoute.suggestedFareNgn,
      pricingCurrency: "NGN",
      pricingBreakdown: plannedRoute.ridePrice,
    });
  } catch (error) {
    sendJson(res, 400, {
      error:
        error instanceof Error
          ? error.message
          : "Could not estimate ride route",
    });
  }
}

export async function handleRiderRideHistoryRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RideHistoryRouteDeps,
  url: URL,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const limit = parseLimit(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const rides = await rideClient.findRiderHistory(user.id, limit, cursor);

    sendJson(res, 200, {
      items: rides.map((ride) => ({
        id: ride.id,
        tripId: formatTripId(ride.tripNumber),
        status: ride.status,
        pickupAddress: ride.pickupAddress,
        destAddress: ride.destAddress,
        fareEstimateNgn: decimalToNumber(ride.fareEstimateNgn),
        fareFinalNgn: decimalToNumber(ride.fareFinalNgn),
        distanceKm: ride.distanceKm ?? null,
        durationSeconds: ride.durationSeconds ?? null,
        cancelReason: ride.cancelReason ?? null,
        matchedAt: ride.matchedAt?.toISOString() ?? null,
        startedAt: ride.startedAt?.toISOString() ?? null,
        completedAt: ride.completedAt?.toISOString() ?? null,
        cancelledAt: ride.cancelledAt?.toISOString() ?? null,
        createdAt: ride.createdAt.toISOString(),
      })),
      nextCursor:
        rides.length === limit ? (rides[rides.length - 1]?.id ?? null) : null,
    });
  } catch (error) {
    sendJson(res, 401, {
      error:
        error instanceof Error ? error.message : "Could not load ride history",
    });
  }
}

export async function handleCreateScheduledRideRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ScheduledRideRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);

    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: "Body must be a JSON object" });
      return;
    }

    const result = await runIdempotentJsonRequest({
      req,
      redisClient: deps.redisClient,
      userId: user.id,
      routeKey: "scheduled-rides:create",
      requestBody: rawBody,
      execute: async () => {
        const scheduledFor = parseScheduledFor(rawBody["scheduledFor"]);
        const pickup = parseWaypoint(rawBody, "pickup");
        const destination = parseWaypoint(rawBody, "destination");
        const stops = parseStops(rawBody, "stops");
        const plannedRoute = await deps.routePlanner.planRoute({
          origin: pickup,
          stops,
          destination,
        });
        const scheduledRideId = randomUUID();
        const useReferralCashback =
          getBoolean(rawBody, "useReferralCashback") ?? false;
        const requestedReferralCashbackNgn = getNumber(
          rawBody,
          "requestedReferralCashbackNgn",
        );
        let referralCashbackAppliedNgn = 0;
        let fareEstimateNgn = plannedRoute.suggestedFareNgn;

        if (useReferralCashback) {
          const reservation = await referralClient.reserveRideCashback({
            userId: user.id,
            rideId: scheduledRideId,
            fareNgn: plannedRoute.suggestedFareNgn,
            requestedAmountNgn: requestedReferralCashbackNgn,
          });
          referralCashbackAppliedNgn = reservation.reservedCashbackNgn;
          fareEstimateNgn = resolveNetFareNgn({
            grossFareNgn: plannedRoute.suggestedFareNgn,
            discountNgn: referralCashbackAppliedNgn,
          });
        }

        const scheduledRide = await scheduledRideClient
          .create({
            id: scheduledRideId,
            riderId: user.id,
            scheduledFor,
            paymentMethod: "WALLET_BALANCE",
            pickupLat: pickup.lat,
            pickupLng: pickup.lng,
            pickupAddress: pickup.address,
            destLat: destination.lat,
            destLng: destination.lng,
            destAddress: destination.address,
            stops,
            plannedDistanceKm: plannedRoute.distanceKm,
            plannedDurationSeconds: plannedRoute.durationSeconds,
            fareEstimateNgn,
          })
          .catch(async (error) => {
            if (referralCashbackAppliedNgn > 0) {
              await referralClient.releaseRideCashback(scheduledRideId).catch(
                (releaseError) =>
                  console.warn(
                    "[referrals] scheduled cashback release after create failure failed",
                    {
                      scheduledRideId,
                      error:
                        releaseError instanceof Error
                          ? releaseError.message
                          : String(releaseError),
                    },
                  ),
              );
            }
            throw error;
          });

        const delayMs = Math.max(
          0,
          scheduledRide.scheduledFor.getTime() - deps.leadTimeMs - Date.now(),
        );

        deps.dispatcherQueue
          .add(
            "dispatch",
            {
              scheduledRideId: scheduledRide.id,
              scheduledFor: scheduledRide.scheduledFor.toISOString(),
            },
            {
              delay: delayMs,
              jobId: buildScheduledRideJobId(scheduledRide.id),
            },
          )
          .catch((err) =>
            console.warn(
              `[api-gateway] BullMQ enqueue failed for ${scheduledRide.id} (recovery scanner will catch it):`,
              err,
            ),
          );

        return {
          statusCode: 201,
          body: {
            item: mapScheduledRideItem(scheduledRide),
            referralCashbackAppliedNgn,
            fareBeforeCashbackNgn: plannedRoute.suggestedFareNgn,
          },
        };
      },
    });

    logActivity({
      userId: user.id,
      eventType: "scheduled_ride_created",
      metadata: {},
    });

    sendJson(res, result.statusCode, result.body);
  } catch (error) {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : "Could not schedule ride",
    });
  }
}

export async function handleListScheduledRidesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ScheduledRideRouteDeps,
  url: URL,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const limit = parseLimit(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const rides = await scheduledRideClient.findByRider(user.id, limit, cursor);

    sendJson(res, 200, {
      items: rides.map((ride) => mapScheduledRideItem(ride)),
      nextCursor:
        rides.length === limit ? (rides[rides.length - 1]?.id ?? null) : null,
    });
  } catch (error) {
    sendJson(res, 401, {
      error:
        error instanceof Error
          ? error.message
          : "Could not load scheduled rides",
    });
  }
}

export async function handleCancelScheduledRideRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ScheduledRideRouteDeps,
  scheduledRideId: string,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const rawBody = await readJsonBody(req).catch(() => ({}));
    const reason =
      isRecord(rawBody) && typeof rawBody["reason"] === "string"
        ? rawBody["reason"]
        : undefined;
    const result = await scheduledRideClient.cancel(
      scheduledRideId,
      user.id,
      reason,
    );

    if (result.count === 0) {
      sendJson(res, 404, {
        error: "Scheduled ride not found or already closed.",
      });
      return;
    }

    const releasedReferralCashback =
      await referralClient.releaseRideCashback(scheduledRideId);

    deps.dispatcherQueue
      .remove(buildScheduledRideJobId(scheduledRideId))
      .catch((err) =>
        console.warn(
          `[api-gateway] could not remove BullMQ job for ${scheduledRideId}:`,
          err,
        ),
      );
    logActivity({
      userId: user.id,
      eventType: "scheduled_ride_cancelled",
      metadata: { scheduledRideId },
    });

    sendJson(res, 200, {
      cancelled: true,
      scheduledRideId,
      referralCashbackReleasedNgn: releasedReferralCashback.releasedCashbackNgn,
    });
  } catch (error) {
    sendJson(res, 400, {
      error:
        error instanceof Error
          ? error.message
          : "Could not cancel scheduled ride",
    });
  }
}

// ── Ride detail (used by the MCP server and any client that needs a single
// ride by id; ride lifecycle itself stays on the WebSocket) ─────────────────

type RideWithDriver = Awaited<ReturnType<typeof rideClient.findWithDriver>>;

function serializeRideDetail(ride: RideWithDriver) {
  return {
    id: ride.id,
    tripId: formatTripId(ride.tripNumber),
    status: ride.status,
    riderId: ride.riderId,
    driverId: ride.driverId ?? null,
    paymentMethod: ride.paymentMethod,
    pickup: { lat: ride.pickupLat, lng: ride.pickupLng, address: ride.pickupAddress },
    destination: { lat: ride.destLat, lng: ride.destLng, address: ride.destAddress },
    stops: ride.routeStops.map((stop) => ({
      order: stop.stopOrder,
      type: stop.type,
      status: stop.status,
      lat: stop.lat,
      lng: stop.lng,
      address: stop.address,
      completedAt: stop.completedAt?.toISOString() ?? null,
    })),
    fareEstimateNgn: decimalToNumber(ride.fareEstimateNgn),
    riderOfferNgn: decimalToNumber(ride.riderOfferNgn),
    agreedFareNgn: decimalToNumber(ride.agreedFareNgn),
    fareFinalNgn: decimalToNumber(ride.fareFinalNgn),
    platformFeeNgn: decimalToNumber(ride.platformFeeNgn),
    penaltyNgn: decimalToNumber(ride.penaltyNgn),
    distanceKm: ride.distanceKm ?? null,
    durationSeconds: ride.durationSeconds ?? null,
    cancelStage: ride.cancelStage ?? null,
    cancelReason: ride.cancelReason ?? null,
    matchedAt: ride.matchedAt?.toISOString() ?? null,
    arrivedAt: ride.arrivedAt?.toISOString() ?? null,
    startedAt: ride.startedAt?.toISOString() ?? null,
    completedAt: ride.completedAt?.toISOString() ?? null,
    cancelledAt: ride.cancelledAt?.toISOString() ?? null,
    createdAt: ride.createdAt.toISOString(),
    updatedAt: ride.updatedAt.toISOString(),
    driver: ride.driver
      ? {
          id: ride.driver.id,
          userId: ride.driver.userId,
          name: ride.driver.user.name ?? null,
          phone: ride.driver.user.phone ?? null,
          rating: ride.driver.rating,
          status: ride.driver.status,
          vehicleMake: ride.driver.vehicleMake ?? null,
          vehicleModel: ride.driver.vehicleModel ?? null,
          vehiclePlate: ride.driver.vehiclePlate ?? null,
          vehicleYear: ride.driver.vehicleYear ?? null,
        }
      : null,
  };
}

function sendRideRouteError(res: ServerResponse, error: unknown, fallback: string): void {
  if (error instanceof HttpAuthError) {
    sendJson(res, 401, { error: error.message });
    return;
  }
  sendJson(res, 500, { error: error instanceof Error ? error.message : fallback });
}

/** GET /rides/:rideId — rider or assigned driver only. */
export async function handleGetRideRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RideHistoryRouteDeps,
  rideId: string,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const ride = await rideClient.findWithDriver(rideId).catch(() => null);
    if (!ride) {
      sendJson(res, 404, { error: "Ride not found." });
      return;
    }
    if (ride.riderId !== user.id && ride.driver?.userId !== user.id) {
      sendJson(res, 403, { error: "You are not a participant in this ride." });
      return;
    }
    sendJson(res, 200, { ride: serializeRideDetail(ride) });
  } catch (error) {
    sendRideRouteError(res, error, "Could not load ride");
  }
}

/** GET /rides/active — the rider's current in-flight ride, or null. */
export async function handleActiveRideRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RideHistoryRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const active = await rideClient.findActiveByRider(user.id);
    if (!active) {
      sendJson(res, 200, { ride: null });
      return;
    }
    const ride = await rideClient.findWithDriver(active.id);
    // The rider's own trip code, until the driver has used it. Only here: this
    // route answers the rider about their own ride, never a driver.
    const code = await tripCodeClient.state(active.id).catch(() => null);
    const tripCode = code?.tripCode && !code.tripCodeVerifiedAt && !code.tripCodeUnlockedAt && ride.status !== "IN_PROGRESS" ? code.tripCode : null;
    sendJson(res, 200, { ride: { ...serializeRideDetail(ride), tripCode } });
  } catch (error) {
    sendRideRouteError(res, error, "Could not load active ride");
  }
}
