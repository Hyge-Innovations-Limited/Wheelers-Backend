import type { IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "crypto";
import {
  referralClient,
  scheduledRideClient,
  rideClient,
  tripCodeClient,
  prisma,
} from "@wheleers/db";
import { GoogleMapsRoutePlanner, RIDE, formatTripId, zoneFor, tripDetailsBoxOn, tripDetailsFromRequest, tripDetailsFromRow } from "@wheleers/config";
import { Queue } from "bullmq";
import { authenticateHttpUser, HttpAuthError } from "./authenticate";
import { runIdempotentJsonRequest } from "./idempotency";
import { readJsonBody, sendJson } from "./utils";
import { getBoolean, getNumber, getRecord, getString, isRecord } from "../utils/object";
import { buildRideEstimatePricing } from "../pricing/ride-estimate";
import { logActivity } from "../analytics/log-activity";
import type { RedisClient } from "../redis/client";
import { answerCounter, counterAskFor, formedSeatView, groupNoteFor, GroupTripError, riderGroupView } from "../rides/group-trip";
import type { GatewayPublisher } from "../websocket/publisher";
import { driverPhotoFields, type DriverPhotoResolver } from "../drivers/driver-photo";
import { driverChecksField } from "../drivers/driver-checks";
import { safetyView } from "../rides/safety";
import { assertInServiceArea, refusalCode } from "../utils/service-area";
import { autoAcceptStatus } from "../rides/auto-accept";
import { situationForRide } from "../rides/search-situation";
import { waitingView } from "../rides/waiting";
import { actOnWaiting, readWaitingAction, WaitingDealError } from "../rides/waiting-deal";
import { answerGroupOffer, GroupLiveError, offerForRide, offerViewFor } from "../rides/group-live";
import type { RedisClient as GroupRedis } from "../redis/client";
import { firstNameOf } from "../rides/group-people";

interface RideRouteDeps {
  jwtSecret: string;
  routePlanner: GoogleMapsRoutePlanner;
}

interface RideHistoryRouteDeps {
  jwtSecret: string;
  /** Auto-accept's record for an open search (GET /rides/active). Absent: reported off. */
  redisClient?: RedisClient;
  /** DRIVER_PHOTO_ENABLED: driverPhotoUrl / driverPhotoKey on the driver and the offers. Absent: as before. */
  driverPhoto?: DriverPhotoResolver;
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

export function buildScheduledRideJobId(scheduledRideId: string): string {
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

const SCHEDULE_MIN_AHEAD_MS = 10 * 60 * 1000;
/** Seven days, and an hour for a rider who chose the last slot and took their time. */
const SCHEDULE_MAX_AHEAD_MS = (7 * 24 + 1) * 60 * 60 * 1000;

export function parseScheduledFor(value: unknown): Date {
  if (typeof value !== "string") {
    throw new Error("scheduledFor must be an ISO datetime string");
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("scheduledFor must be a valid ISO datetime string");
  }

  // The search starts a few minutes before the pickup time, so a time that
  // close (or already gone) cannot be honoured; nor is a ride held for weeks.
  const ahead = parsed.getTime() - Date.now();
  if (ahead < SCHEDULE_MIN_AHEAD_MS) {
    throw new Error("Pick a pickup time at least 10 minutes from now.");
  }
  if (ahead > SCHEDULE_MAX_AHEAD_MS) {
    throw new Error("A ride can be scheduled up to 7 days ahead.");
  }

  return parsed;
}

function mapScheduledRideItem(
  ride: Awaited<ReturnType<typeof scheduledRideClient.findByRider>>[number],
) {
  const pricing = buildRideEstimatePricing(ride.plannedDistanceKm ?? null, ride.plannedDurationSeconds ?? null, {
    origin: { lat: ride.pickupLat, lng: ride.pickupLng },
    destination: { lat: ride.destLat, lng: ride.destLng },
  });
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
    assertInServiceArea([pickup, destination, ...stops]);
    const plannedRoute = await deps.routePlanner.planRoute({
      origin: pickup,
      stops,
      destination,
    });

    // For analytics: an app rider shown a price (the app's ride_quoted); with the ride that follows, where they stopped.
    logActivity({
      userId: user.id,
      eventType: "ride_estimate_requested",
      source: "app",
      metadata: {
        distanceKm: plannedRoute.distanceKm,
        suggestedFareNgn: plannedRoute.suggestedFareNgn,
        minOfferNgn: plannedRoute.minOfferNgn,
        stops: stops.length,
        pickupZone: zoneFor(pickup.lat, pickup.lng) ?? "outside",
      },
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
      ratePerKmNgn: plannedRoute.ratePerKmNgn, priceReason: plannedRoute.priceReason ?? null,
      fareEstimateNgn: plannedRoute.suggestedFareNgn,
      pricingCurrency: "NGN",
      pricingBreakdown: plannedRoute.ridePrice,
      // Set your price shows the trip details box (TRIP_DETAILS_BOX=on). Older servers: absent, no box.
      tripDetailsBox: tripDetailsBoxOn(),
    });
  } catch (error) {
    sendJson(res, 400, {
      error:
        error instanceof Error
          ? error.message
          : "Could not estimate ride route",
      ...(refusalCode(error) ? { code: refusalCode(error) } : {}),
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
        assertInServiceArea([pickup, destination, ...stops]);
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
            tripDetails: tripDetailsFromRequest(rawBody["tripDetails"]),
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
    pricingVersion: ride.pricingVersion,
    penaltyNgn: decimalToNumber(ride.penaltyNgn),
    distanceKm: ride.distanceKm ?? null,
    durationSeconds: ride.durationSeconds ?? null,
    cancelStage: ride.cancelStage ?? null,
    cancelReason: ride.cancelReason ?? null,
    matchedAt: ride.matchedAt?.toISOString() ?? null,
    arrivedAt: ride.arrivedAt?.toISOString() ?? null,
    startedAt: ride.startedAt?.toISOString() ?? null,
    completedAt: ride.completedAt?.toISOString() ?? null,
    // Waiting time: the free minutes and the meter while the driver waits, the fee once the trip started.
    waiting: waitingView(ride),
    // Recorded (the driver's phone started it), and the safety tips for before and after the trip.
    ...safetyView(ride, {
      plate: ride.driver?.vehiclePlate ?? null, driverName: ride.driver?.user.name ?? null,
      vehicleModel: [ride.driver?.vehicleMake, ride.driver?.vehicleModel].filter(Boolean).join(' ') || null,
      fareNgn: decimalToNumber(ride.agreedFareNgn),
    }),
    cancelledAt: ride.cancelledAt?.toISOString() ?? null,
    createdAt: ride.createdAt.toISOString(),
    updatedAt: ride.updatedAt.toISOString(),
    // People, luggage, pet and a note: search again from a restored search sends them again.
    ...(tripDetailsFromRow(ride) ? { tripDetails: tripDetailsFromRow(ride) } : {}),
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

/**
 * POST /rides/:rideId/waiting { action: "offer" | "accept", ngn } — the waiting price between the rider and
 * the assigned driver (rides/waiting-deal.ts). Answers { waiting } (the ride's waiting block after it).
 */
export async function handleWaitingDealRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { jwtSecret: string; redisClient?: RedisClient },
  rideId: string,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    if (deps.redisClient) {
      const key = `waiting-deal:${user.id}:${Math.floor(Date.now() / 60_000)}`;
      const used = Number(await deps.redisClient.get(key).catch(() => null)) || 0;
      await deps.redisClient.set(key, String(used + 1), 120).catch(() => undefined);
      if (used >= 20) {
        sendJson(res, 429, { error: "Too many tries. Wait a minute.", code: "RATE_LIMITED" });
        return;
      }
    }
    const act = readWaitingAction(await readJsonBody(req).catch(() => null));
    const waiting = await actOnWaiting(rideId, user.id, act);
    sendJson(res, 200, { waiting });
  } catch (error) {
    if (error instanceof WaitingDealError) {
      sendJson(res, error.status, { error: error.message, code: error.code });
      return;
    }
    sendRideRouteError(res, error, "Could not send that");
  }
}

/**
 * POST /rides/:rideId/group { answer: "join" | "decline" } — the rider's answer to a group ride offer
 * (rides/group-live.ts). The first answer counts. Answers { answer }.
 */
export async function handleGroupAnswerRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { jwtSecret: string; redisClient: RedisClient },
  rideId: string,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const body = await readJsonBody(req).catch(() => null);
    const answer = isRecord(body) && (body.answer === "join" || body.answer === "decline") ? body.answer : null;
    if (!answer) {
      sendJson(res, 400, { error: "Answer join or decline.", code: "BAD_ANSWER" });
      return;
    }
    const result = await answerGroupOffer(deps.redisClient, rideId, user.id, answer);
    sendJson(res, 200, { answer: result.answer, selfieNeeded: result.selfieNeeded });
  } catch (error) {
    if (error instanceof GroupLiveError) {
      sendJson(res, error.status, { error: error.message, code: error.code });
      return;
    }
    sendRideRouteError(res, error, "Could not send that");
  }
}

/**
 * POST /rides/:rideId/group/counter { answer: "yes" | "no" } — a rider in a group answering a driver's counter over
 * their seat (rides/group-trip.ts). Yes from every asked rider books; one No ends it. Answers { answer }.
 */
export async function handleGroupCounterRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { jwtSecret: string; redisClient: RedisClient; publisher: GatewayPublisher },
  rideId: string,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const body = await readJsonBody(req).catch(() => null);
    const answer = isRecord(body) && (body.answer === "yes" || body.answer === "no") ? body.answer : null;
    if (!answer) {
      sendJson(res, 400, { error: "Answer yes or no.", code: "BAD_ANSWER" });
      return;
    }
    const askId = isRecord(body) && typeof body.askId === "string" ? body.askId : undefined;
    sendJson(res, 200, { answer: await answerCounter({ redis: deps.redisClient, publisher: deps.publisher }, user.id, rideId, answer, askId) });
  } catch (error) {
    if (error instanceof GroupTripError) {
      sendJson(res, 409, { error: error.message, code: error.code });
      return;
    }
    sendRideRouteError(res, error, "Could not send that");
  }
}

async function groupOfferView(redis: GroupRedis, rideId: string) {
  const offer = await offerForRide(redis, rideId);
  if (!offer) return null;
  const users = await prisma.user.findMany({ where: { id: { in: offer.members.map((m) => m.riderId) } }, select: { id: true, name: true } }).catch(() => []);
  const names = new Map(users.map((u) => [u.id, firstNameOf(u.name)]));
  return offerViewFor(redis, offer, rideId, names);
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
    // A search still open comes back with its offers, so a rider who closed
    // the app finds the drivers who answered still there. It closes 5 minutes
    // after the rider last set a price (ride-service restarts the clock then).
    const searching = ride.status === "REQUESTED" || ride.status === "MATCHING";
    // Whether the rider said yes to auto-booking for this search (and at what price), so a restored search shows it.
    const autoAccept = searching && deps.redisClient
      ? await autoAcceptStatus(deps.redisClient, active.id).catch(() => ({ on: false, priceNgn: null }))
      : { on: false, priceNgn: null };
    // A group ride on offer to this search (rides/group-live.ts): this rider's view of it.
    const groupOffer = searching && deps.redisClient ? await groupOfferView(deps.redisClient, active.id).catch(() => null) : null;
    // In a group looking for a driver: the riders in it now, and a driver's counter this rider is asked about.
    const [groupFormed, groupCounter, groupNote] = searching && deps.redisClient
      ? await Promise.all([formedSeatView(deps.redisClient, active.id).catch(() => null), counterAskFor(deps.redisClient, active.id).catch(() => null), groupNoteFor(deps.redisClient, active.id).catch(() => null)])
      : [null, null, null];
    const search = searching
      ? {
          ...(groupOffer ? { groupOffer } : {}),
          ...(groupFormed ? { groupFormed } : {}),
          ...(groupCounter ? { groupCounter } : {}),
          // What happened to the group a moment ago (someone left, a wallet short): the app says it once.
          ...(groupNote ? { groupNote } : {}),
          autoAccept: autoAccept.on,
          autoAcceptPriceNgn: autoAccept.priceNgn,
          bidsCloseAt: new Date(ride.updatedAt.getTime() + RIDE.BID_TIMEOUT_SECONDS * 1000).toISOString(),
          // What is happening with the search, as one line ("No drivers near you right now"): rides/search-situation.ts.
          ...(deps.redisClient ? { situation: await situationForRide(deps.redisClient, active.id).catch(() => null) } : {}),
          offers: await Promise.all((await rideClient.pendingBids(active.id).catch(() => [])).map(async (bid) => ({
            bidId: bid.id,
            driverId: bid.driverId,
            driverUserId: bid.driverUserId,
            counterOfferNgn: decimalToNumber(bid.amountNgn) ?? 0,
            driverName: bid.driver.user.name ?? "Driver",
            driverRating: bid.driver.rating ?? null,
            vehiclePlate: bid.driver.vehiclePlate ?? "",
            vehicleModel: [bid.driver.vehicleMake, bid.driver.vehicleModel].filter(Boolean).join(" "),
            etaSeconds: bid.etaSeconds,
            distanceKm: bid.distanceKm,
            receivedAt: bid.createdAt.toISOString(),
            ...(await driverPhotoFields(deps.driverPhoto, bid.driverId, { riderId: user.id })),
            ...(await driverChecksField(bid.driverId)),
          }))),
        }
      : null;
    const detail = serializeRideDetail(ride);
    const driverPhoto = detail.driver ? await driverPhotoFields(deps.driverPhoto, detail.driver.id) : {};
    // A group ride (rides/group-trip.ts): who else is in the car and every stop in order, theirs marked.
    const group = !searching && deps.redisClient ? await riderGroupView(deps.redisClient, active.id).catch(() => null) : null;
    sendJson(res, 200, { ride: { ...detail, ...(detail.driver && deps.driverPhoto ? { driver: { ...detail.driver, ...driverPhoto } } : {}), tripCode, search, ...(group ? { group } : {}) } });
  } catch (error) {
    sendRideRouteError(res, error, "Could not load active ride");
  }
}
