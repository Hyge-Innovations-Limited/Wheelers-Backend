import { randomUUID } from 'node:crypto';
import Jimp from 'jimp';
import { prisma } from '@wheleers/db';
import {
  faceCheckMode, sendAlert, formatTripId, FACE_BLOCK_MINUTES, FACE_CHECK_MAX_SUBMITS, FACE_CHECK_SECONDS, FACE_CHECK_TRIES,
  FACE_FRAMES_KEEP_DAYS, FACE_MATCH_MAX_DISTANCE, FACE_TURN_MIN_DELTA, type FaceCheckMode,
} from '@wheleers/config';
import { RideCancelledEvent } from '@wheleers/kafka-schemas';
import type { RedisClient } from '../redis/client';
import type { GatewayPublisher } from '../websocket/publisher';
import { faceDistance, faceEngine, type FaceEngine, type FoundFace } from './engine';

/**
 * The driver's face check before every ride (Timi, 18 Nov 2026; packages/config face-check.ts has the rules).
 *
 *   booked      startFaceCheck: a PENDING row, a random head turn to ask for, 2 minutes; the driver's app is told
 *               in ride:matched (faceCheck) and opens the camera.
 *   scan        submitFaceCheck: three frames (straight, turned, straight). One face in each, the same person in
 *               all, the head really turned, and close enough to the driver's KYC selfie: PASSED. Not close
 *               enough: another try with a new turn; out of tries: FAILED. Unclear (no face, two faces, too far):
 *               try again, not counted as a miss (up to FACE_CHECK_MAX_SUBMITS scans in all).
 *   no scan     sweepFaceChecks: past the 2 minutes, EXPIRED.
 *   FAILED / EXPIRED (mode on): the ride goes back to the search for the rider (a driver cancel, as when a driver
 *               backs out), the driver is told, and Telegram hears it.
 *   ERROR       the check could not run (the library, R2, or the driver's selfie has no usable face): mode on, the
 *               ride goes back to the search and the driver takes no rides for FACE_BLOCK_MINUTES; Telegram always.
 *   shadow      every step runs and is recorded and alerted, but nothing is cancelled or blocked.
 *
 * Until PASSED (mode on) the driver cannot tap Arrived or Start (assertFaceCheckPassed). Frames go to R2 and are
 * deleted after FACE_FRAMES_KEEP_DAYS. Group trips are not checked yet.
 */

export interface FaceFrameStore {
  getFile(key: string): Promise<{ bytes: Buffer } | null>;
  upload(params: { driverId: string; type: string; imageBuffer: Buffer; mimeType: string }): Promise<string>;
  remove(key: string): Promise<void>;
}

export interface FaceCheckDeps {
  redis: RedisClient;
  publisher: Pick<GatewayPublisher, 'publishRideEvent'>;
  /** The KYC selfies (read) and the scan frames (write, delete). Null: the check cannot run (ERROR). */
  kycStorage: Pick<FaceFrameStore, 'getFile'> | null;
  frameStorage: FaceFrameStore | null;
  engine?: FaceEngine;
  /** A frame made small (default: Jimp to 720 pixels, JPEG). Tests pass the bytes through. */
  shrink?: (frame: Buffer) => Promise<Buffer>;
  notifyDriver?: (userId: string, type: string, payload: Record<string, unknown>) => Promise<unknown>;
  alert?: (title: string, body: string) => Promise<unknown>;
  mode?: FaceCheckMode;
  now?: () => number;
}

export interface FaceCheckView {
  checkId: string;
  rideId: string;
  challenge: 'left' | 'right';
  deadlineAt: string;
  triesLeft: number;
  mode: FaceCheckMode;
}

type Row = Awaited<ReturnType<typeof prisma.faceCheck.findFirstOrThrow>>;
const LIVE = ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED'];
const MAX_FRAME_BYTES = 8_000_000;
const FRAME_SIDE = 720;
const MIN_FACE_SIZE = 0.15;
async function shrinkFrame(frame: Buffer): Promise<Buffer> {
  const img = await Jimp.read(frame);
  if (Math.max(img.bitmap.width, img.bitmap.height) > FRAME_SIDE) img.scaleToFit(FRAME_SIDE, FRAME_SIDE);
  return (await img.quality(80).getBufferAsync(Jimp.MIME_JPEG)) as Buffer;
}
const pickTurn = (): 'left' | 'right' => (Math.random() < 0.5 ? 'left' : 'right');
const modeOf = (deps: FaceCheckDeps) => deps.mode ?? faceCheckMode();
const nowOf = (deps: FaceCheckDeps) => (deps.now ? deps.now() : Date.now());
const blockedKey = (driverUserId: string) => `face:blocked:${driverUserId}`;
const capableKey = (driverUserId: string) => `face:capable:${driverUserId}`;

export function faceCheckView(row: Row): FaceCheckView {
  return {
    checkId: row.id, rideId: row.rideId, challenge: row.challenge === 'right' ? 'right' : 'left', deadlineAt: row.deadlineAt.toISOString(),
    triesLeft: Math.max(0, FACE_CHECK_TRIES - row.failedTries), mode: row.mode === 'on' ? 'on' : 'shadow',
  };
}

/** The driver app says it can scan (driver:online { faceChecks: true }). Kept a day, renewed at every online. */
export async function noteFaceCheckDriver(redis: RedisClient, driverUserId: string): Promise<void> {
  await redis.set(capableKey(driverUserId), '1', 24 * 60 * 60).catch(() => undefined);
}

/** Why this driver may not bid now (mode on): held back after the check broke, or an app that cannot scan. */
export async function faceCheckBidRefusal(redis: RedisClient, driverUserId: string, mode = faceCheckMode()): Promise<string | null> {
  if (mode !== 'on') return null;
  if (await redis.get(blockedKey(driverUserId)).catch(() => null)) return "The face check isn't working for you right now. You can't take rides until it's fixed; we're on it.";
  if (!(await redis.get(capableKey(driverUserId)).catch(() => null))) return 'Update the app to keep driving: rides now start with a quick face check.';
  return null;
}

/** A driver whose check on this ride ended without a pass never bids on it again (no fresh tries by re-booking). */
export async function failedFaceCheckOn(rideId: string, driverId: string): Promise<boolean> {
  const row = await prisma.faceCheck.findUnique({ where: { rideId_driverId: { rideId, driverId } }, select: { status: true, mode: true } }).catch(() => null);
  return Boolean(row && row.mode === 'on' && ['FAILED', 'EXPIRED', 'ERROR'].includes(row.status));
}

/** Booked: the check this ride needs, or null (off, a group trip, an app that cannot scan in shadow). */
export async function startFaceCheck(deps: FaceCheckDeps, input: { rideId: string; driverId: string; driverUserId: string }): Promise<FaceCheckView | null> {
  const mode = modeOf(deps);
  if (mode === 'off') return null;
  const ride = await prisma.ride.findUnique({ where: { id: input.rideId }, select: { groupRole: true, driverId: true } }).catch(() => null);
  if (!ride || ride.groupRole !== null || ride.driverId !== input.driverId) return null;
  if (mode === 'shadow' && !(await deps.redis.get(capableKey(input.driverUserId)).catch(() => null))) return null;
  const row = await prisma.faceCheck.upsert({
    where: { rideId_driverId: { rideId: input.rideId, driverId: input.driverId } },
    create: { rideId: input.rideId, driverId: input.driverId, driverUserId: input.driverUserId, challenge: pickTurn(), mode, deadlineAt: new Date(nowOf(deps) + FACE_CHECK_SECONDS * 1000) },
    update: {},
  });
  // The driver's selfie as a face, ahead of the scan (worked out once and kept).
  void ensureTemplate(deps, input.driverId).catch(() => undefined);
  return row.status === 'PENDING' ? faceCheckView(row) : null;
}

/** The check still to pass on this ride, for the driver's app after a reconnect. */
export async function pendingFaceCheck(rideId: string, driverId: string): Promise<FaceCheckView | null> {
  const row = await prisma.faceCheck.findUnique({ where: { rideId_driverId: { rideId, driverId } } }).catch(() => null);
  return row && row.status === 'PENDING' ? faceCheckView(row) : null;
}

/** Mode on: Arrived and Start wait for the face check. */
export async function assertFaceCheckPassed(rideId: string, driverId: string | null | undefined, mode = faceCheckMode()): Promise<void> {
  if (mode !== 'on' || !driverId) return;
  const row = await prisma.faceCheck.findUnique({ where: { rideId_driverId: { rideId, driverId } }, select: { status: true, mode: true } }).catch(() => null);
  if (row && row.mode === 'on' && row.status === 'PENDING') throw new Error('Scan your face first.');
}

class CheckBroken extends Error {
  constructor(readonly why: 'engine' | 'storage' | 'selfie_missing' | 'selfie_no_face', detail = '') { super(`${why}${detail ? `: ${detail}` : ''}`); }
}

async function ensureTemplate(deps: FaceCheckDeps, driverId: string): Promise<number[]> {
  const kyc = await prisma.driverKycSubmission.findUnique({ where: { driverId }, select: { selfieKey: true } }).catch(() => null);
  const selfieKey = kyc?.selfieKey ?? null;
  if (!selfieKey) throw new CheckBroken('selfie_missing');
  const kept = await prisma.driverFaceTemplate.findUnique({ where: { driverId } });
  if (kept && kept.selfieKey === selfieKey) return kept.descriptor as number[];
  if (!deps.kycStorage) throw new CheckBroken('storage', 'no R2');
  const file = await deps.kycStorage.getFile(selfieKey).catch((e) => { throw new CheckBroken('storage', String(e?.message ?? e)); });
  if (!file) throw new CheckBroken('storage', 'selfie not found in R2');
  const faces = await (deps.engine ?? faceEngine).faces(file.bytes).catch((e) => { throw new CheckBroken('engine', String(e?.message ?? e)); });
  if (faces.length === 0) throw new CheckBroken('selfie_no_face');
  const face = faces.reduce((a, b) => (b.size > a.size ? b : a));
  await prisma.driverFaceTemplate.upsert({
    where: { driverId },
    create: { driverId, selfieKey, descriptor: face.descriptor },
    update: { selfieKey, descriptor: face.descriptor },
  });
  return face.descriptor;
}

export type ScanAnswer =
  | { status: 'passed' }
  | { status: 'retry'; reason: string; challenge: 'left' | 'right'; triesLeft: number }
  | { status: 'failed' | 'expired' | 'error' | 'none'; reason?: string };

const UNCLEAR: Record<string, string> = {
  no_face: "We couldn't see your face. Hold the phone at eye level, in good light.",
  two_faces: 'Only you in the picture, please.',
  too_far: 'Hold the phone a little closer.',
};

/** Judge three frames against the driver's selfie: unclear, not a turn, not the same person, or the distance. */
export function judgeFrames(frames: FoundFace[][], template: number[]): { kind: 'unclear'; why: string } | { kind: 'no_turn' } | { kind: 'scored'; distance: number; match: boolean } {
  for (const found of frames) {
    if (found.length === 0) return { kind: 'unclear', why: 'no_face' };
    if (found.length > 1) return { kind: 'unclear', why: 'two_faces' };
    if (found[0].size < MIN_FACE_SIZE) return { kind: 'unclear', why: 'too_far' };
  }
  const [a, b, c] = frames.map((f) => f[0]);
  // One person all through (no swapping faces between frames), and the head really turned.
  const sameAll = faceDistance(a.descriptor, b.descriptor) <= FACE_MATCH_MAX_DISTANCE + 0.1 && faceDistance(a.descriptor, c.descriptor) <= FACE_MATCH_MAX_DISTANCE;
  const turned = Math.abs(b.turn - a.turn) >= FACE_TURN_MIN_DELTA || Math.abs(b.turn - c.turn) >= FACE_TURN_MIN_DELTA;
  if (!turned) return { kind: 'no_turn' };
  const distance = Math.min(faceDistance(a.descriptor, template), faceDistance(c.descriptor, template));
  return { kind: 'scored', distance, match: sameAll && distance <= FACE_MATCH_MAX_DISTANCE };
}

export async function submitFaceCheck(deps: FaceCheckDeps, input: { driverUserId: string; rideId: string; frames: unknown }): Promise<ScanAnswer> {
  const row = await prisma.faceCheck.findFirst({ where: { rideId: input.rideId, driverUserId: input.driverUserId, status: 'PENDING' } });
  if (!row) return { status: 'none' };
  if (row.deadlineAt.getTime() <= nowOf(deps)) {
    await expireOne(deps, row);
    return { status: 'expired' };
  }
  const ride = await prisma.ride.findUnique({ where: { id: row.rideId }, select: { driverId: true, status: true } });
  if (!ride || ride.driverId !== row.driverId || !LIVE.includes(String(ride.status))) return { status: 'none' };

  const frames = Array.isArray(input.frames) ? input.frames : [];
  const sent = frames.slice(0, 3).map((f) => (typeof f === 'string' ? Buffer.from(f.replace(/^data:image\/\w+;base64,/, ''), 'base64') : Buffer.alloc(0)));
  // Each frame brought down to 720 pixels once (a phone's photo is several MB): what is checked and what is kept.
  const buffers = sent.length === 3 && sent.every((b) => b.length >= 1000 && b.length <= MAX_FRAME_BYTES)
    ? await Promise.all(sent.map((b) => (deps.shrink ?? shrinkFrame)(b).catch(() => null)))
    : [];
  if (buffers.length !== 3 || buffers.some((b) => !b)) {
    return { status: 'retry', reason: UNCLEAR.no_face, challenge: row.challenge === 'right' ? 'right' : 'left', triesLeft: FACE_CHECK_TRIES - row.failedTries };
  }
  const photos = buffers as Buffer[];
  // One more scan, counted atomically (two submits at once never both get past the limit).
  const counted = await prisma.faceCheck.updateMany({ where: { id: row.id, status: 'PENDING', submits: { lt: FACE_CHECK_MAX_SUBMITS } }, data: { submits: { increment: 1 } } });
  if (counted.count === 0) {
    await resolve(deps, row, 'FAILED', 'too many scans');
    return { status: 'failed' };
  }

  let template: number[];
  let found: FoundFace[][];
  try {
    template = await ensureTemplate(deps, row.driverId);
    found = [];
    for (const b of photos) found.push(await (deps.engine ?? faceEngine).faces(b).catch((e) => { throw new CheckBroken('engine', String(e?.message ?? e)); }));
  } catch (error) {
    const why = error instanceof CheckBroken ? error.message : String(error);
    await resolve(deps, row, 'ERROR', why);
    return { status: 'error', reason: why };
  }
  // The frames, kept for disputes (best effort: a failed upload never fails the check).
  const keys = deps.frameStorage
    ? await Promise.all(photos.map((b, i) => deps.frameStorage!.upload({ driverId: row.driverId, type: `face-${row.rideId}-${i + 1}-${randomUUID().slice(0, 8)}`, imageBuffer: b, mimeType: 'image/jpeg' }).catch(() => null)))
    : [];
  const kept = [...((row.frameKeys as string[] | null) ?? []), ...keys.filter((k): k is string => Boolean(k))];

  const verdict = judgeFrames(found, template);
  const best = verdict.kind === 'scored' ? Math.min(verdict.distance, row.bestDistance ?? Infinity) : row.bestDistance;
  if (verdict.kind === 'unclear') {
    await prisma.faceCheck.update({ where: { id: row.id }, data: { frameKeys: kept, lastReason: verdict.why } });
    const after = await prisma.faceCheck.findUniqueOrThrow({ where: { id: row.id } });
    if (after.submits >= FACE_CHECK_MAX_SUBMITS) {
      await resolve(deps, after, 'FAILED', `unclear: ${verdict.why}`);
      return { status: 'failed' };
    }
    return { status: 'retry', reason: UNCLEAR[verdict.why], challenge: row.challenge === 'right' ? 'right' : 'left', triesLeft: FACE_CHECK_TRIES - row.failedTries };
  }
  if (verdict.kind === 'scored' && verdict.match) {
    await prisma.faceCheck.update({ where: { id: row.id }, data: { frameKeys: kept, bestDistance: best, lastReason: null } });
    await resolve(deps, row, 'PASSED', `distance ${verdict.distance.toFixed(3)}`);
    return { status: 'passed' };
  }
  // A miss (not the driver, or no head turn): one try fewer, and a new turn to ask for.
  const reason = verdict.kind === 'no_turn' ? 'no_turn' : `no_match ${verdict.distance.toFixed(3)}`;
  const challenge = pickTurn();
  const updated = await prisma.faceCheck.update({
    where: { id: row.id },
    data: { frameKeys: kept, bestDistance: best ?? null, lastReason: reason, failedTries: { increment: 1 }, challenge },
  });
  if (updated.failedTries >= FACE_CHECK_TRIES) {
    await resolve(deps, updated, 'FAILED', reason);
    return { status: 'failed' };
  }
  return {
    status: 'retry',
    reason: verdict.kind === 'no_turn' ? 'Turn your head when the screen asks.' : "That didn't match your Wheelers photo. Try again: face the camera, good light.",
    challenge, triesLeft: FACE_CHECK_TRIES - updated.failedTries,
  };
}

/** Ends a PENDING check once (the update is the claim) and does what its outcome needs. */
async function resolve(deps: FaceCheckDeps, row: Row, status: 'PASSED' | 'FAILED' | 'EXPIRED' | 'ERROR', detail: string): Promise<boolean> {
  const claimed = await prisma.faceCheck.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { status, resolvedAt: new Date(nowOf(deps)), lastReason: status === 'PASSED' ? null : detail } });
  if (claimed.count === 0) return false;
  const enforced = row.mode === 'on';
  const ride = await prisma.ride.findUnique({ where: { id: row.rideId }, select: { riderId: true, tripNumber: true, driverId: true, status: true } }).catch(() => null);
  const trip = formatTripId(ride?.tripNumber) ?? row.rideId.slice(0, 8);
  if (status === 'PASSED') {
    await deps.notifyDriver?.(row.driverUserId, 'ride:face_check:passed', { rideId: row.rideId }).catch(() => undefined);
    return true;
  }
  const alert = deps.alert ?? ((title: string, body: string) => sendAlert(title, body, { force: status === 'ERROR' }));
  const label = status === 'FAILED' ? "Driver's face didn't match" : status === 'EXPIRED' ? 'Driver did not scan their face in time' : "The face check couldn't run";
  await Promise.resolve(alert(`${enforced ? '' : '[shadow] '}${label}`, `Trip ${trip} · driver ${row.driverId.slice(0, 8)} · ${detail}${enforced ? ' · ride sent back to the search' : ''}`)).catch(() => undefined);

  if (!enforced) return true;
  if (status === 'ERROR') await deps.redis.set(blockedKey(row.driverUserId), '1', FACE_BLOCK_MINUTES * 60).catch(() => undefined);
  // The ride goes back to the search, as when a driver backs out (ride-service re-offers it; the hold is let go).
  if (ride && ride.driverId === row.driverId && LIVE.includes(String(ride.status))) {
    await deps.publisher.publishRideEvent(RideCancelledEvent.parse({
      eventType: 'RIDE_CANCELLED', rideId: row.rideId, riderId: ride.riderId, driverId: row.driverId, driverUserId: row.driverUserId,
      cancelledBy: 'driver', reason: status === 'EXPIRED' ? 'face_check_timeout' : status === 'ERROR' ? 'face_check_unavailable' : 'face_check_failed',
      timestamp: new Date(nowOf(deps)).toISOString(),
    })).catch((error) => console.error('[face-check] CRITICAL: ride not sent back to the search', { rideId: row.rideId, error: error instanceof Error ? error.message : String(error) }));
  }
  await deps.notifyDriver?.(row.driverUserId, 'ride:face_check:failed', {
    rideId: row.rideId,
    reason: status === 'ERROR' ? "The face check isn't working right now. You can't take rides until it's fixed." : status === 'EXPIRED' ? 'No face scan in time. The ride went to another driver.' : "Your face didn't match your Wheelers photo. The ride went to another driver.",
  }).catch(() => undefined);
  return true;
}

async function expireOne(deps: FaceCheckDeps, row: Row): Promise<void> {
  await resolve(deps, row, 'EXPIRED', 'no scan in 2 minutes');
}

/**
 * Every few seconds from the gateway: checks past their time end as EXPIRED (each claimed once, so several gateway
 * processes never act twice); once a day's worth at a time, frames older than 30 days are deleted from R2.
 */
export async function sweepFaceChecks(deps: FaceCheckDeps): Promise<{ expired: number; framesDeleted: number }> {
  const now = nowOf(deps);
  const late = await prisma.faceCheck.findMany({ where: { status: 'PENDING', deadlineAt: { lt: new Date(now) } }, take: 50 });
  let expired = 0;
  for (const row of late) {
    // A ride that is no longer this driver's (cancelled meanwhile): closed quietly.
    const ride = await prisma.ride.findUnique({ where: { id: row.rideId }, select: { driverId: true, status: true } }).catch(() => null);
    if (!ride || ride.driverId !== row.driverId || !LIVE.includes(String(ride.status))) {
      await prisma.faceCheck.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { status: 'EXPIRED', resolvedAt: new Date(now), lastReason: 'ride moved on' } });
      continue;
    }
    if (await resolve(deps, row, 'EXPIRED', 'no scan in 2 minutes')) expired += 1;
  }
  let framesDeleted = 0;
  if (deps.frameStorage) {
    const old = await prisma.faceCheck.findMany({ where: { createdAt: { lt: new Date(now - FACE_FRAMES_KEEP_DAYS * 86_400_000) }, framesDeletedAt: null }, take: 50, select: { id: true, frameKeys: true } }).catch(() => []);
    for (const row of old) {
      for (const key of (row.frameKeys as string[] | null) ?? []) {
        await deps.frameStorage.remove(key).then(() => { framesDeleted += 1; }, () => undefined);
      }
      await prisma.faceCheck.update({ where: { id: row.id }, data: { framesDeletedAt: new Date(now) } }).catch(() => undefined);
    }
  }
  return { expired, framesDeleted };
}
