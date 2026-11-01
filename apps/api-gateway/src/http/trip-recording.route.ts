import type { IncomingMessage, ServerResponse } from 'http';
import { adminActivityClient, driverClient, rideClient, tripRecordingClient } from '@wheleers/db';
import { authenticateHttpUser } from './authenticate';
import { verifyAdminAuth } from './admin-auth.route';
import { readJsonBody, sendJson } from './utils';
import {
  TRIP_RECORDING_MAX_SEGMENT_BYTES,
  TRIP_RECORDING_MAX_SEGMENTS,
  type TripRecordingStorage,
} from '../storage/trip-recording-storage';

/**
 * Trip voice recording: the driver's phone records the trip in 5-minute
 * segments and uploads each straight to R2; only support and owners listen.
 *
 *   GET  /drivers/me/trip-recording              { recordTrips }  should this driver's phone record?
 *   POST /drivers/me/trip-recordings/upload-url  { rideId, segmentIndex, bytes } → { url, key, expiresInSeconds }
 *   POST /drivers/me/trip-recordings/complete    { rideId, segmentIndex, durationSec? } → { ok }
 *   GET  /admin/rides/:id/recordings             support/owner: signed 5-minute links, each listen logged
 */
export interface TripRecordingDeps {
  jwtSecret: string;
  adminApiKey: string;
  /** Off (TRIP_RECORDING_ENABLED unset): no phone records, every route answers as if it did not exist. */
  enabled: boolean;
  /** A pilot: only these Driver ids record. Empty: every driver. */
  driverIds: string[];
  storage: TripRecordingStorage | null;
}

/** A ride is recorded only while it runs, and uploads may finish within 30 days of its end. */
const UPLOAD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const RECORDABLE_STATUSES = new Set(['IN_PROGRESS', 'COMPLETED']);

export function recordsTrips(deps: Pick<TripRecordingDeps, 'enabled' | 'driverIds' | 'storage'>, driverId: string | null | undefined): boolean {
  if (!deps.enabled || !deps.storage || !driverId) return false;
  return deps.driverIds.length === 0 || deps.driverIds.includes(driverId);
}

class RecordingError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function driverOf(req: IncomingMessage, deps: TripRecordingDeps) {
  const user = await authenticateHttpUser(req, deps.jwtSecret).catch(() => null);
  if (!user) throw new RecordingError('Sign in again.', 401);
  const driver = await driverClient.findByUserId(user.id);
  if (!driver) throw new RecordingError('Only a driver can do that.', 403);
  return driver;
}

/** The driver's own ride, running or ended within the upload window. */
async function uploadableRide(driverId: string, rideId: unknown) {
  if (typeof rideId !== 'string' || !rideId) throw new RecordingError('Which trip?', 400);
  const ride = await rideClient.findById(rideId);
  if (!ride || ride.driverId !== driverId) throw new RecordingError('This trip is not yours.', 403);
  if (!RECORDABLE_STATUSES.has(String(ride.status))) throw new RecordingError('This trip cannot be recorded.', 409);
  const endedAt = ride.completedAt ? new Date(ride.completedAt).getTime() : null;
  if (endedAt !== null && Date.now() - endedAt > UPLOAD_WINDOW_MS) throw new RecordingError('This trip is too old to upload.', 409);
  return ride;
}

function segmentOf(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n >= TRIP_RECORDING_MAX_SEGMENTS) throw new RecordingError('Bad segment.', 400);
  return n;
}

/** Handles the trip-recording paths; false when the path is not one of them. */
export async function handleTripRecordingRoute(req: IncomingMessage, res: ServerResponse, deps: TripRecordingDeps, url: URL): Promise<boolean> {
  const path = url.pathname;
  const admin = /^\/admin\/rides\/([^/]+)\/recordings$/.exec(path);
  const mine = path === '/drivers/me/trip-recording' || path.startsWith('/drivers/me/trip-recordings/');
  if (!admin && !mine) return false;

  try {
    if (path === '/drivers/me/trip-recording') {
      if (req.method !== 'GET') throw new RecordingError('Method not allowed', 405);
      const driver = await driverOf(req, deps);
      sendJson(res, 200, { recordTrips: recordsTrips(deps, driver.id) });
      return true;
    }

    if (mine) {
      if (req.method !== 'POST') throw new RecordingError('Method not allowed', 405);
      const driver = await driverOf(req, deps);
      if (!recordsTrips(deps, driver.id) || !deps.storage) throw new RecordingError('Trip recording is off.', 404);
      const body = (await readJsonBody(req).catch(() => null)) as Record<string, unknown> | null;
      if (!body) throw new RecordingError('Bad request.', 400);
      const ride = await uploadableRide(driver.id, body.rideId);
      const segmentIndex = segmentOf(body.segmentIndex);
      const key = deps.storage.keyFor(ride.id, segmentIndex);

      if (path === '/drivers/me/trip-recordings/upload-url') {
        const bytes = Number(body.bytes);
        if (!Number.isInteger(bytes) || bytes < 1 || bytes > TRIP_RECORDING_MAX_SEGMENT_BYTES) throw new RecordingError('That file is too big.', 413);
        const expiresInSeconds = 15 * 60;
        sendJson(res, 200, { url: await deps.storage.uploadUrl(key, bytes, expiresInSeconds), key, expiresInSeconds });
        return true;
      }

      if (path === '/drivers/me/trip-recordings/complete') {
        const size = await deps.storage.sizeOf(key);
        if (size === null) throw new RecordingError('The upload has not arrived yet.', 409);
        if (size > TRIP_RECORDING_MAX_SEGMENT_BYTES) {
          await deps.storage.remove([key]).catch(() => undefined);
          throw new RecordingError('That file is too big.', 413);
        }
        const duration = Number(body.durationSec);
        await tripRecordingClient.recordSegment({
          rideId: ride.id,
          driverId: driver.id,
          segmentIndex,
          objectKey: key,
          bytes: size,
          durationSec: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
        });
        sendJson(res, 200, { ok: true });
        return true;
      }
      throw new RecordingError('Not found.', 404);
    }

    // GET /admin/rides/:id/recordings: support and owners only; every listen is logged.
    if (req.method !== 'GET') throw new RecordingError('Method not allowed', 405);
    const auth = await verifyAdminAuth(req, { jwtSecret: deps.jwtSecret, adminApiKey: deps.adminApiKey });
    if (!auth) throw new RecordingError('Unauthorized', 401);
    if (auth.role !== 'SUPPORT' && auth.role !== 'OWNER') throw new RecordingError('Support and owners only.', 403);
    if (!deps.storage) throw new RecordingError('Trip recording is not set up.', 404);
    const rideId = decodeURIComponent(admin![1]);
    const segments = await tripRecordingClient.listForRide(rideId);
    const recordings = await Promise.all(segments.map(async (segment) => ({
      segmentIndex: segment.segmentIndex,
      durationSec: segment.durationSec,
      bytes: segment.bytes,
      uploadedAt: segment.uploadedAt.toISOString(),
      url: await deps.storage!.listenUrl(segment.objectKey),
    })));
    await adminActivityClient.record({
      adminId: auth.adminId,
      adminName: auth.adminName,
      kind: 'trip_recording_listen',
      page: path,
      detail: { rideId, segments: recordings.length },
      flagged: true,
      ip: typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket?.remoteAddress ?? null,
    }).catch(() => undefined);
    sendJson(res, 200, { rideId, recordings, expiresInSeconds: 5 * 60 });
    return true;
  } catch (error) {
    if (error instanceof RecordingError) {
      sendJson(res, error.status, { error: error.message });
      return true;
    }
    console.error('[trip-recording] failed', error instanceof Error ? error.message : String(error));
    sendJson(res, 500, { error: 'Something went wrong. Try again.' });
    return true;
  }
}

/**
 * The 30-day sweep: objects first, then the rows, a batch at a time. Run by
 * the gateway every few hours (one process at a time, through a Redis lock).
 */
export async function sweepTripRecordings(storage: TripRecordingStorage, now = new Date()): Promise<number> {
  let removed = 0;
  for (let round = 0; round < 50; round++) {
    const batch = await tripRecordingClient.listExpired(now, 200);
    if (batch.length === 0) break;
    await storage.remove(batch.map((item) => item.objectKey));
    removed += await tripRecordingClient.markDeleted(batch.map((item) => item.id), now);
    if (batch.length < 200) break;
  }
  return removed;
}
