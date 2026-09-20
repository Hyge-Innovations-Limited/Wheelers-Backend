import type { IncomingMessage, ServerResponse } from 'http';
import {
  GroupRideGenderPreference,
  GroupRideMatchRequestStatus,
  groupRideClient,
} from '@wheleers/db';
import type {
  GoogleMapsRoutePlanner,
} from '@wheleers/config';
import type { GroupRideMatchCancelledEvent } from '@wheleers/kafka-schemas';
import { buildReadyForMatchEvent } from '../group-ride/ready-event';
import { createLlm } from '../LLM/llm';
import { verifySelfiePhoto } from '../LLM/face-check';
import { authenticateHttpUser } from './authenticate';
import { runIdempotentJsonRequest } from './idempotency';
import { readJsonBody, sendJson } from './utils';
import { getNumber, getRecord, getString, isRecord } from '../utils/object';
import type { GatewayPublisher } from '../websocket/publisher';
import type { GroupRideFaceStorage } from '../storage/group-ride-face-storage';
import type { RedisClient } from '../redis/client';

interface GroupRideRouteDeps {
  jwtSecret: string;
  routePlanner: GoogleMapsRoutePlanner;
  publisher: GatewayPublisher;
  redisClient: RedisClient;
  faceStorage?: GroupRideFaceStorage;
  groqApiKey?: string;
  groqModel: string;
  groqTimeoutMs: number;
}

type LatLngAddress = {
  lat: number;
  lng: number;
  address: string;
};

/** ~8 MB of base64, comfortably above any phone selfie. */
const MAX_FACE_CHECK_BASE64_LENGTH = 8_000_000;

const ALLOWED_FACE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

function parseWaypoint(record: Record<string, unknown>, key: string): LatLngAddress {
  const value = getRecord(record, key);
  if (!value) {
    throw new Error(`Missing required field: ${key}`);
  }

  const lat = getNumber(value, 'lat');
  const lng = getNumber(value, 'lng');
  const address = getString(value, 'address');

  if (lat === undefined || lng === undefined || !address) {
    throw new Error(`Invalid ${key} payload`);
  }

  return { lat, lng, address };
}

function parseStops(record: Record<string, unknown>, key: string): LatLngAddress[] {
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

    const lat = getNumber(item, 'lat');
    const lng = getNumber(item, 'lng');
    const address = getString(item, 'address');

    if (lat === undefined || lng === undefined || !address) {
      throw new Error(`Invalid ${key}[${index}] payload`);
    }

    return { lat, lng, address };
  });
}

function normalizeGenderPreference(value: unknown): GroupRideGenderPreference {
  if (value === 'women_only' || value === 'WOMEN_ONLY') {
    return GroupRideGenderPreference.WOMEN_ONLY;
  }

  if (value === 'men_only' || value === 'MEN_ONLY') {
    return GroupRideGenderPreference.MEN_ONLY;
  }

  return GroupRideGenderPreference.ANY;
}

function serializeGenderPreference(
  value: GroupRideGenderPreference,
): 'any' | 'women_only' | 'men_only' {
  if (value === GroupRideGenderPreference.WOMEN_ONLY) {
    return 'women_only';
  }

  if (value === GroupRideGenderPreference.MEN_ONLY) {
    return 'men_only';
  }

  return 'any';
}

function parseCapturedAt(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('capturedAt must be a valid ISO datetime string');
  }

  return parsed;
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
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (
    value &&
    typeof value === 'object' &&
    'toString' in value &&
    typeof value.toString === 'function'
  ) {
    const parsed = Number(value.toString());
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function mapMatchRequestItem(
  request: NonNullable<Awaited<ReturnType<typeof groupRideClient.findMatchRequestById>>>,
) {
  const matchedRideIds = Array.isArray(request.matchedRideIds)
    ? request.matchedRideIds.filter((item): item is string => typeof item === 'string')
    : [];

  return {
    id: request.id,
    userId: request.userId,
    status: request.status,
    groupId: request.groupId ?? null,
    matchedRideIds,
    pickup: {
      lat: request.pickupLat,
      lng: request.pickupLng,
      address: request.pickupAddress,
    },
    destination: {
      lat: request.destLat,
      lng: request.destLng,
      address: request.destAddress,
    },
    stops: Array.isArray(request.stops) ? request.stops : [],
    plannedDistanceKm: request.plannedDistanceKm ?? null,
    plannedDurationSeconds: request.plannedDurationSeconds ?? null,
    fareEstimateNgn: decimalToNumber(request.fareEstimateNgn),
    genderPreference: serializeGenderPreference(request.genderPreference),
    paymentMethod: 'wallet_balance',
    readyForMatchAt: request.readyForMatchAt?.toISOString() ?? null,
    matchingStartedAt: request.matchingStartedAt?.toISOString() ?? null,
    groupedAt: request.groupedAt?.toISOString() ?? null,
    bookedAt: request.bookedAt?.toISOString() ?? null,
    expiredAt: request.expiredAt?.toISOString() ?? null,
    cancelledAt: request.cancelledAt?.toISOString() ?? null,
    cancelReason: request.cancelReason ?? null,
    faceVerification: request.faceVerification
      ? {
          id: request.faceVerification.id,
          uploadStatus: request.faceVerification.uploadStatus,
          mimeType: request.faceVerification.mimeType,
          sizeBytes: request.faceVerification.sizeBytes ?? null,
          capturedAt: request.faceVerification.capturedAt?.toISOString() ?? null,
          storedAt: request.faceVerification.storedAt?.toISOString() ?? null,
          failedAt: request.faceVerification.failedAt?.toISOString() ?? null,
          failureReason: request.faceVerification.failureReason ?? null,
        }
      : null,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
  };
}

async function buildMatchedRiders(
  request: NonNullable<Awaited<ReturnType<typeof groupRideClient.findMatchRequestById>>>,
) {
  const matchedRideIds = Array.isArray(request.matchedRideIds)
    ? request.matchedRideIds.filter((item): item is string => typeof item === 'string')
    : [];

  if (matchedRideIds.length < 2) {
    return [];
  }

  const requests = await groupRideClient.findMatchRequestsByIds(matchedRideIds);
  return requests
    .filter((item) => item.id !== request.id)
    .map((item) => ({
      rideId: item.id,
      userId: item.userId,
      name: item.user.name ?? null,
      username: item.user.username ?? null,
      photoUrl: item.user.photoUrl ?? null,
      pickupAddress: item.pickupAddress,
      destinationAddress: item.destAddress,
      status: item.status,
    }));
}

function buildCancelledEvent(
  requestId: string,
  userId: string,
  reason?: string,
): GroupRideMatchCancelledEvent {
  return {
    eventType: 'GROUP_RIDE_MATCH_CANCELLED',
    rideId: requestId,
    riderId: userId,
    reason,
    timestamp: new Date().toISOString(),
  };
}

function ensureFaceStorage(deps: GroupRideRouteDeps): GroupRideFaceStorage {
  if (!deps.faceStorage) {
    throw new Error('Group ride face upload is not configured.');
  }

  return deps.faceStorage;
}

export async function handleCreateGroupRideMatchRequestRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: GroupRideRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const result = await runIdempotentJsonRequest({
      req,
      redisClient: deps.redisClient,
      userId: user.id,
      routeKey: "group-rides:match-request:create",
      requestBody: rawBody,
      execute: async () => {
        const pickup = parseWaypoint(rawBody, 'pickup');
        const destination = parseWaypoint(rawBody, 'destination');
        const stops = parseStops(rawBody, 'stops');
        const plannedRoute = await deps.routePlanner.planRoute({
          origin: pickup,
          stops,
          destination,
        });

        const request = await groupRideClient.createMatchRequest({
          userId: user.id,
          pickupLat: pickup.lat,
          pickupLng: pickup.lng,
          pickupAddress: pickup.address,
          destLat: destination.lat,
          destLng: destination.lng,
          destAddress: destination.address,
          genderPreference: normalizeGenderPreference(rawBody['genderPreference']),
          stops,
          plannedDistanceKm: plannedRoute.distanceKm,
          plannedDurationSeconds: plannedRoute.durationSeconds,
          fareEstimateNgn: plannedRoute.fareEstimateNgn,
          paymentMethod: 'WALLET_BALANCE',
        });

        return {
          statusCode: 201,
          body: {
            item: mapMatchRequestItem(request),
            uploadRequired: true,
          },
        };
      },
    });

    sendJson(res, result.statusCode, result.body);
  } catch (error) {
    sendJson(res, 400, {
      error:
        error instanceof Error
          ? error.message
          : 'Could not create group ride match request',
    });
  }
}

export async function handleListGroupRideMatchRequestsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: GroupRideRouteDeps,
  url: URL,
): Promise<void> {
  let user;
  try {
    user = await authenticateHttpUser(req, deps.jwtSecret);
  } catch (error) {
    sendJson(res, 401, {
      error:
        error instanceof Error
          ? error.message
          : 'Authentication failed',
    });
    return;
  }

  try {
    const limit = parseLimit(url.searchParams.get('limit'));
    const items = await groupRideClient.listMatchRequestsByUser(user.id, limit);

    sendJson(res, 200, {
      items: items.map((item) => mapMatchRequestItem(item)),
    });
  } catch (error) {
    sendJson(res, 500, {
      error:
        error instanceof Error
          ? error.message
          : 'Could not load group ride match requests',
    });
  }
}

export async function handleGetGroupRideMatchRequestRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: GroupRideRouteDeps,
  requestId: string,
): Promise<void> {
  let user;
  try {
    user = await authenticateHttpUser(req, deps.jwtSecret);
  } catch (error) {
    sendJson(res, 401, {
      error:
        error instanceof Error
          ? error.message
          : 'Authentication failed',
    });
    return;
  }

  try {
    const request = await groupRideClient.findMatchRequestByIdForUser(
      requestId,
      user.id,
    );

    if (!request) {
      sendJson(res, 404, { error: 'Group ride match request not found.' });
      return;
    }

    sendJson(res, 200, {
      item: mapMatchRequestItem(request),
      matchedRiders: await buildMatchedRiders(request),
    });
  } catch (error) {
    sendJson(res, 500, {
      error:
        error instanceof Error
          ? error.message
          : 'Could not load group ride match request',
    });
  }
}

/**
 * Check a selfie without storing it.
 *
 * The app captures the selfie before the match request exists, and a rider who
 * pointed the camera at their cat should hear about it while the camera is
 * still open — not three screens later. This is a preview of the same verdict
 * the upload-complete route enforces, so it is advisory: passing here is not
 * what lets a rider through, the stored-object check still is.
 */
export async function handleGroupRideFaceCheckRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: GroupRideRouteDeps,
): Promise<void> {
  try {
    await authenticateHttpUser(req, deps.jwtSecret);

    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const mimeType = getString(rawBody, 'mimeType')?.toLowerCase() ?? 'image/jpeg';
    if (!ALLOWED_FACE_MIME_TYPES.has(mimeType)) {
      sendJson(res, 400, { error: 'mimeType must be a supported image type.' });
      return;
    }

    const imageBase64 = getString(rawBody, 'imageBase64');
    if (!imageBase64) {
      sendJson(res, 400, { error: 'imageBase64 is required.' });
      return;
    }

    if (imageBase64.length > MAX_FACE_CHECK_BASE64_LENGTH) {
      sendJson(res, 413, { error: 'That photo is too large to check.' });
      return;
    }

    const buffer = Buffer.from(imageBase64, 'base64');
    if (buffer.length === 0) {
      sendJson(res, 400, { error: 'imageBase64 was not valid base64 image data.' });
      return;
    }

    const groq = createLlm({ groqApiKey: deps.groqApiKey, groqModel: deps.groqModel, timeoutMs: deps.groqTimeoutMs });
    const verdict = await verifySelfiePhoto(groq, buffer, mimeType);

    sendJson(res, 200, {
      accepted: verdict.accepted,
      reason: verdict.reason,
    });
  } catch (error) {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : 'Could not check that photo',
    });
  }
}

export async function handleCreateGroupRideFaceUploadUrlRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: GroupRideRouteDeps,
  requestId: string,
): Promise<void> {
  try {
    const storage = ensureFaceStorage(deps);
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const request = await groupRideClient.findMatchRequestByIdForUser(
      requestId,
      user.id,
    );

    if (!request) {
      sendJson(res, 404, { error: 'Group ride match request not found.' });
      return;
    }

    if (request.status === GroupRideMatchRequestStatus.CANCELLED) {
      sendJson(res, 409, { error: 'This group ride match request has been cancelled.' });
      return;
    }

    if (request.status === GroupRideMatchRequestStatus.EXPIRED) {
      sendJson(res, 409, { error: 'This group ride match request has expired.' });
      return;
    }

    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const mimeType = getString(rawBody, 'mimeType')?.toLowerCase();
    if (!mimeType || !ALLOWED_FACE_MIME_TYPES.has(mimeType)) {
      sendJson(res, 400, {
        error: 'mimeType must be a supported image type.',
      });
      return;
    }

    const capturedAt = parseCapturedAt(rawBody['capturedAt']);
    const upload = await storage.createUploadUrl({
      matchRequestId: request.id,
      userId: user.id,
      mimeType,
    });

    await groupRideClient.upsertFaceVerificationUpload({
      matchRequestId: request.id,
      userId: user.id,
      bucket: upload.bucket,
      objectKey: upload.objectKey,
      mimeType,
      capturedAt,
    });

    sendJson(res, 200, {
      upload,
    });
  } catch (error) {
    sendJson(res, 400, {
      error:
        error instanceof Error
          ? error.message
          : 'Could not create face upload URL',
    });
  }
}

export async function handleCompleteGroupRideFaceUploadRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: GroupRideRouteDeps,
  requestId: string,
): Promise<void> {
  try {
    const storage = ensureFaceStorage(deps);
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const request = await groupRideClient.findMatchRequestByIdForUser(
      requestId,
      user.id,
    );

    if (!request) {
      sendJson(res, 404, { error: 'Group ride match request not found.' });
      return;
    }

    if (!request.faceVerification) {
      sendJson(res, 400, {
        error: 'Create a face upload URL before completing upload.',
      });
      return;
    }

    if (
      request.faceVerification.uploadStatus === 'STORED' &&
      request.status !== GroupRideMatchRequestStatus.PENDING_FACE_UPLOAD
    ) {
      sendJson(res, 200, {
        item: mapMatchRequestItem(request),
        publishedReadyEvent: false,
      });
      return;
    }

    const rawBody = await readJsonBody(req).catch(() => ({}));
    const capturedAt = isRecord(rawBody)
      ? parseCapturedAt(rawBody['capturedAt'])
      : undefined;

    const storedObject = await storage.verifyUploadedObject({
      bucket: request.faceVerification.bucket,
      objectKey: request.faceVerification.objectKey,
    });

    // Look at the photo. Confirming the bytes exist says nothing about whether
    // they show a person — the same guardrail the WhatsApp flow applies has to
    // apply here, or the app is the way around it.
    const groq = createLlm({ groqApiKey: deps.groqApiKey, groqModel: deps.groqModel, timeoutMs: deps.groqTimeoutMs });
    const download = await storage.download({
      bucket: request.faceVerification.bucket,
      objectKey: request.faceVerification.objectKey,
    });
    const verdict = await verifySelfiePhoto(
      groq,
      download.buffer,
      storedObject.mimeType === 'application/octet-stream'
        ? download.mimeType
        : storedObject.mimeType,
    );

    if (!verdict.accepted) {
      await groupRideClient.markFaceVerificationFailed({
        matchRequestId: request.id,
        reason: verdict.reason || 'Selfie did not show a clear human face.',
      });

      // 422, not 400: the request was well-formed, the photo was not usable.
      // The rider can retake it against the same match request.
      sendJson(res, 422, {
        error:
          "That doesn't look like a clear photo of your face. Retake it with your face fully visible — no pets, screenshots, or photos of a screen.",
        reason: verdict.reason,
        retryable: true,
      });
      return;
    }

    const completed = await groupRideClient.completeFaceVerificationAndMarkReady({
      matchRequestId: request.id,
      sizeBytes: storedObject.sizeBytes,
      etag: storedObject.etag,
      capturedAt: capturedAt ?? storedObject.capturedAt,
    });

    await deps.publisher.publishGroupRideEvent(
      buildReadyForMatchEvent(completed.request),
    );

    sendJson(res, 200, {
      item: mapMatchRequestItem(completed.request),
      publishedReadyEvent: true,
    });
  } catch (error) {
    if (error instanceof Error && /NotFound|NoSuchKey/i.test(error.message)) {
      try {
        await groupRideClient.markFaceVerificationFailed({
          matchRequestId: requestId,
          reason: 'Uploaded face image was not found in storage.',
        });
      } catch {
        // ignore secondary failure
      }
    }

    sendJson(res, 400, {
      error:
        error instanceof Error
          ? error.message
          : 'Could not complete face upload',
    });
  }
}

export async function handleCancelGroupRideMatchRequestRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: GroupRideRouteDeps,
  requestId: string,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const rawBody = await readJsonBody(req).catch(() => ({}));
    const reason =
      isRecord(rawBody) && typeof rawBody['reason'] === 'string'
        ? rawBody['reason']
        : undefined;

    const result = await groupRideClient.cancelMatchRequestForUser(
      requestId,
      user.id,
      reason,
    );

    if (result.count === 0) {
      sendJson(res, 409, {
        error: 'This group ride match request cannot be cancelled.',
      });
      return;
    }

    await deps.publisher.publishGroupRideEvent(
      buildCancelledEvent(requestId, user.id, reason),
    );

    const updated = await groupRideClient.findMatchRequestByIdForUser(
      requestId,
      user.id,
    );

    sendJson(res, 200, {
      item: updated ? mapMatchRequestItem(updated) : null,
      cancelled: true,
    });
  } catch (error) {
    sendJson(res, 400, {
      error:
        error instanceof Error
          ? error.message
          : 'Could not cancel group ride match request',
    });
  }
}
