import type { IncomingMessage, ServerResponse } from 'http';
import { adminActivityClient, driverClient, rideClient, tripRecordingClient, TRIP_RECORDING_KEEP_DAYS } from '@wheleers/db';
import { authenticateHttpUser } from './authenticate';
import { verifyAdminAuth } from './admin-auth.route';
import { readJsonBody, sendJson } from './utils';
import { clientIp } from '../utils/client-ip';
import {
  looksLikeM4a,
  TRIP_RECORDING_MAX_SEGMENT_BYTES,
  TRIP_RECORDING_MAX_SEGMENTS,
  type TripRecordingStorage,
} from '../storage/trip-recording-storage';

/**
 * Trip voice recording: the driver's phone records the trip in 5-minute
 * segments and uploads each straight to R2; only support and owners listen.
 *
 *   GET  /drivers/me/trip-recording              { recordTrips }  should this driver's phone record?
 *   POST /drivers/me/trip-recordings/start       { rideId } → { ok, nextSegmentIndex }  the trip runs: it is marked as recorded, then the phone records
 *   POST /drivers/me/trip-recordings/upload-url  { rideId, segmentIndex, bytes } → { url, key, expiresInSeconds }
 *   POST /drivers/me/trip-recordings/complete    { rideId, segmentIndex, durationSec? } → { ok }
 *   GET  /admin/rides/:id/recordings             support/owner: signed 5-minute links, each listen logged first
 *   GET  /admin/trip-recordings?from=&to=&q=&limit=&offset=   support/owner: every recorded trip, newest first, with its R2 bucket and keys
 *
 * A segment is accepted only for a trip marked as recorded while it ran (start),
 * within 48 hours of its end, no more segments than the trip's length
 * allows, and once: a recorded segment never gets a new upload link.
 */
export interface TripRecordingDeps {
  jwtSecret: string;
  adminApiKey: string;
  /** Off (TRIP_RECORDING_ENABLED unset): no phone records, and the driver routes answer as if they did not exist. */
  enabled: boolean;
  /** A pilot: only these Driver ids record. Empty: every driver. */
  driverIds: string[];
  storage: TripRecordingStorage | null;
}

const SEGMENT_MS = 5 * 60 * 1000;
/** Pieces the phone may add beyond the trip's length (a restart, the last short piece). */
const SEGMENT_SLACK = 3;
const UPLOAD_WINDOW_MS = 48 * 60 * 60 * 1000;
const UPLOADABLE_STATUSES = new Set(['IN_PROGRESS', 'COMPLETED', 'CANCELLED']);

export function recordsTrips(deps: Pick<TripRecordingDeps, 'enabled' | 'driverIds' | 'storage'>, driverId: string | null | undefined): boolean {
  if (!deps.enabled || !deps.storage || !driverId) return false;
  return deps.driverIds.length === 0 || deps.driverIds.includes(driverId);
}

class RecordingError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
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

async function ownRide(driverId: string, rideId: unknown) {
  if (typeof rideId !== 'string' || !rideId) throw new RecordingError('Which trip?', 400);
  const ride = await rideClient.findById(rideId).catch(() => null);
  if (!ride || ride.driverId !== driverId) throw new RecordingError('This trip is not yours.', 403);
  return ride;
}

const time = (value: Date | string | null | undefined) => (value ? new Date(value).getTime() : null);

/** The driver's own trip, marked as recorded while it ran, still within its upload window; and the segment fits the trip. */
async function uploadableSegment(driverId: string, rideId: unknown, segmentValue: unknown, now = Date.now()) {
  const ride = await ownRide(driverId, rideId);
  const status = String(ride.status);
  const startedAt = time(ride.recordingStartedAt);
  if (!UPLOADABLE_STATUSES.has(status) || startedAt === null) throw new RecordingError('This trip was not recorded.', 409, 'not_recorded');
  const endedAt = status === 'IN_PROGRESS' ? now : status === 'COMPLETED' ? time(ride.completedAt) : time(ride.cancelledAt);
  if (endedAt === null || now - endedAt > UPLOAD_WINDOW_MS) throw new RecordingError('This trip is too old to upload.', 409, 'too_old');
  const segmentIndex = Number(segmentValue);
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= TRIP_RECORDING_MAX_SEGMENTS) throw new RecordingError('Bad segment.', 400);
  const allowed = Math.floor(Math.max(0, endedAt - startedAt) / SEGMENT_MS) + SEGMENT_SLACK;
  if (segmentIndex >= allowed) throw new RecordingError('This trip was not that long.', 409, 'too_long');
  return { ride, segmentIndex };
}

function fail(res: ServerResponse, error: unknown) {
  if (error instanceof RecordingError) {
    sendJson(res, error.status, { error: error.message, ...(error.code ? { code: error.code } : {}) });
    return;
  }
  console.error('[trip-recording] failed', error instanceof Error ? error.message : String(error));
  sendJson(res, 500, { error: 'Something went wrong. Try again.' });
}

/** Handles the trip-recording paths; false when the path is not one of them. */
export async function handleTripRecordingRoute(req: IncomingMessage, res: ServerResponse, deps: TripRecordingDeps, url: URL): Promise<boolean> {
  const path = url.pathname;
  const admin = /^\/admin\/rides\/([^/]+)\/recordings$/.exec(path);
  const list = path === '/admin/trip-recordings';
  const mine = path === '/drivers/me/trip-recording' || path.startsWith('/drivers/me/trip-recordings/');
  if (!admin && !list && !mine) return false;

  try {
    if (list) {
      // The list (no audio, no links): support and owners, every view logged.
      if (req.method !== 'GET') throw new RecordingError('Method not allowed', 405);
      const auth = await verifyAdminAuth(req, { jwtSecret: deps.jwtSecret, adminApiKey: deps.adminApiKey });
      if (!auth) throw new RecordingError('Unauthorized', 401);
      if (auth.role !== 'SUPPORT' && auth.role !== 'OWNER') throw new RecordingError('Support and owners only.', 403);
      const day = (key: string, endOfDay: boolean): Date | null => {
        const raw = url.searchParams.get(key);
        if (!raw) return null;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00+01:00`))) throw new RecordingError(`${key} must be a day, YYYY-MM-DD.`, 400);
        // Lagos days: from the start of `from` to the end of `to`.
        const at = new Date(`${raw}T00:00:00+01:00`);
        return endOfDay ? new Date(at.getTime() + 24 * 60 * 60 * 1000) : at;
      };
      const from = day('from', false);
      const to = day('to', true);
      const q = (url.searchParams.get('q') ?? '').slice(0, 80);
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      await adminActivityClient.record({
        adminId: auth.adminId,
        adminName: auth.adminName,
        kind: 'view',
        page: path,
        detail: { from: url.searchParams.get('from'), to: url.searchParams.get('to'), q: q || null },
        ip: clientIp(req),
      });
      const result = await tripRecordingClient.listRides({ from, to, q, limit: Number.isFinite(limit) ? limit : 50, offset: Number.isFinite(offset) ? offset : 0 });
      sendJson(res, 200, { bucket: deps.storage?.bucketName ?? null, keepDays: TRIP_RECORDING_KEEP_DAYS, ...result });
      return true;
    }

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
      const storage = deps.storage;
      const body = (await readJsonBody(req).catch(() => null)) as Record<string, unknown> | null;
      if (!body) throw new RecordingError('Bad request.', 400);

      if (path === '/drivers/me/trip-recordings/start') {
        const ride = await ownRide(driver.id, body.rideId);
        if (String(ride.status) !== 'IN_PROGRESS') throw new RecordingError('This trip is not running.', 409, 'not_running');
        await tripRecordingClient.markRideRecording(ride.id);
        sendJson(res, 200, { ok: true, nextSegmentIndex: await tripRecordingClient.nextSegmentIndex(ride.id) });
        return true;
      }

      const { ride, segmentIndex } = await uploadableSegment(driver.id, body.rideId, body.segmentIndex);
      const key = storage.keyFor(ride.id, segmentIndex);

      if (path === '/drivers/me/trip-recordings/upload-url') {
        const bytes = Number(body.bytes);
        if (!Number.isInteger(bytes) || bytes < 1 || bytes > TRIP_RECORDING_MAX_SEGMENT_BYTES) throw new RecordingError('That file is too big.', 413);
        if (await tripRecordingClient.segmentExists(ride.id, segmentIndex)) throw new RecordingError('This piece is already recorded.', 409, 'already_recorded');
        const expiresInSeconds = 15 * 60;
        sendJson(res, 200, { url: await storage.uploadUrl(key, bytes, expiresInSeconds), key, expiresInSeconds });
        return true;
      }

      if (path === '/drivers/me/trip-recordings/complete') {
        if (await tripRecordingClient.segmentExists(ride.id, segmentIndex)) {
          sendJson(res, 200, { ok: true });
          return true;
        }
        const stored = await storage.stat(key);
        // 425: not there yet; the phone tries again later.
        if (!stored) throw new RecordingError('The upload has not arrived yet.', 425, 'not_arrived');
        if (stored.size > TRIP_RECORDING_MAX_SEGMENT_BYTES) {
          await storage.remove([key]).catch(() => []);
          throw new RecordingError('That file is too big.', 413);
        }
        if (!looksLikeM4a(await storage.head(key))) {
          await storage.remove([key]).catch(() => []);
          throw new RecordingError('That is not a recording.', 415);
        }
        const duration = Number(body.durationSec);
        await tripRecordingClient.recordSegment({
          rideId: ride.id,
          driverId: driver.id,
          segmentIndex,
          objectKey: key,
          bytes: stored.size,
          etag: stored.etag,
          durationSec: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
        });
        sendJson(res, 200, { ok: true });
        return true;
      }
      throw new RecordingError('Not found.', 404);
    }

    // GET /admin/rides/:id/recordings: support and owners only; the listen is logged before any link is made.
    if (req.method !== 'GET') throw new RecordingError('Method not allowed', 405);
    const auth = await verifyAdminAuth(req, { jwtSecret: deps.jwtSecret, adminApiKey: deps.adminApiKey });
    if (!auth) throw new RecordingError('Unauthorized', 401);
    if (auth.role !== 'SUPPORT' && auth.role !== 'OWNER') throw new RecordingError('Support and owners only.', 403);
    if (!deps.storage) throw new RecordingError('Trip recording is not set up.', 404);
    const storage = deps.storage;
    const rideId = decodeURIComponent(admin![1]);
    const ride = await rideClient.findById(rideId).catch(() => null);
    const segments = await tripRecordingClient.listForRide(rideId);
    await adminActivityClient.record({
      adminId: auth.adminId,
      adminName: auth.adminName,
      kind: 'trip_recording_listen',
      page: path,
      detail: { rideId, segments: segments.length },
      flagged: true,
      ip: clientIp(req),
    });
    const recordings = await Promise.all(segments.map(async (segment) => {
      const now = await storage.stat(segment.objectKey).catch(() => undefined);
      return {
        segmentIndex: segment.segmentIndex,
        durationSec: segment.durationSec,
        bytes: segment.bytes,
        uploadedAt: segment.uploadedAt.toISOString(),
        // The file differs from the one recorded (or is gone): do not trust it.
        changed: now === undefined ? null : !now || (segment.etag !== null && now.etag !== segment.etag) || now.size !== segment.bytes,
        url: await storage.listenUrl(segment.objectKey),
      };
    }));
    const iso = (value: Date | string | null | undefined) => (value ? new Date(value).toISOString() : null);
    sendJson(res, 200, {
      rideId,
      recordingStartedAt: iso(ride?.recordingStartedAt),
      completedAt: iso(ride?.completedAt),
      cancelledAt: iso(ride?.cancelledAt),
      recordings,
      expiresInSeconds: 5 * 60,
    });
    return true;
  } catch (error) {
    fail(res, error);
    return true;
  }
}

/**
 * The 30-day sweep, run by the gateway every few hours (one process at a
 * time, through a Redis lock), whether or not recording is switched on:
 * the rows' objects first (a row is marked only once its object is gone),
 * then anything else under trips/ that old, such as an upload never confirmed.
 */
export async function sweepTripRecordings(storage: TripRecordingStorage, now = new Date()): Promise<number> {
  let removed = 0;
  for (let round = 0; round < 50; round++) {
    const batch = await tripRecordingClient.listExpired(now, 200);
    if (batch.length === 0) break;
    const failed = new Set(await storage.remove(batch.map((item) => item.objectKey)));
    removed += await tripRecordingClient.markDeleted(batch.filter((item) => !failed.has(item.objectKey)).map((item) => item.id), now);
    if (failed.size > 0 || batch.length < 200) break;
  }
  const cutoff = new Date(now.getTime() - TRIP_RECORDING_KEEP_DAYS * 24 * 60 * 60 * 1000);
  for (let round = 0; round < 20; round++) {
    const stray = (await storage.listOlderThan(cutoff)).slice(0, 1000);
    if (stray.length === 0) break;
    const failed = await storage.remove(stray);
    if (failed.length > 0 || stray.length < 1000) break;
  }
  return removed;
}
