import { createHash } from 'node:crypto';
import { driverClient } from '@wheleers/db';

/**
 * The driver's face for the rider's avatar (DRIVER_PHOTO_ENABLED): the driver's profile photo, else the
 * KYC selfie, else null (the apps show initials). Clients get a signed GET URL (never a raw object key or
 * a public URL) and a stable cache key that changes only when the photo does.
 */

export interface DriverPhoto {
  driverPhotoUrl: string | null;
  driverPhotoKey: string | null;
}

/** The same signer the WhatsApp ride card uses for the selfie (DriverKycStorage.getSignedUrl). */
export interface DriverPhotoStorage {
  getSignedUrl(key: string, expiresInSeconds?: number): Promise<string>;
}

export interface DriverPhotoRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<unknown>;
  /** Raw commands (SADD / SCARD / EXPIRE / SREM) for the face budget. Absent or non-numeric answers: the budget is skipped. */
  send?(...args: string[]): Promise<unknown>;
}

export interface DriverPhotoSources {
  user?: { photoUrl?: string | null } | null;
  kycSubmission?: { selfieKey?: string | null } | null;
}

export interface DriverPhotoResolver {
  /** One driver's photo. Never throws. */
  forDriver(driverId: string): Promise<DriverPhoto>;
  /** Rides the driver has completed, cached ~10 min. Null when unknown. Never throws. */
  ridesCompleted(driverId: string): Promise<number | null>;
  /**
   * The face budget: a rider sees at most FACE_BUDGET_PER_DAY different drivers' photos a (Lagos) day on offers.
   * A repeat driver is always allowed. Fails open when Redis cannot answer.
   */
  allowOfferFace(riderId: string, driverId: string): Promise<boolean>;
}

export const FACE_BUDGET_PER_DAY = 25;
const FACE_SET_TTL_SECONDS = 36 * 3600;
export const RIDES_COMPLETED_TTL_SECONDS = 10 * 60;
export const ridesCompletedKey = (driverId: string): string => `driver:${driverId}:rides-completed`;
const lagosDate = (now = new Date()): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
export const facesKey = (riderId: string, now = new Date()): string => `rider:${riderId}:faces:${lagosDate(now)}`;

export const NO_DRIVER_PHOTO: DriverPhoto = { driverPhotoUrl: null, driverPhotoKey: null };
/** The URL is signed for an hour and kept for 50 minutes, so a client never holds one that is about to expire. */
export const PHOTO_URL_TTL_SECONDS = 3600;
export const PHOTO_CACHE_TTL_SECONDS = 50 * 60;
/** A driver with no photo is looked up again after this long (they may upload or finish KYC). */
export const NO_PHOTO_CACHE_TTL_SECONDS = 5 * 60;

export const photoCacheKey = (driverId: string): string => `driver:${driverId}:photo`;

/**
 * User.photoUrl is free text from the client. It counts only when it is a key under THIS driver's own profile
 * folder, drivers/profile/<driverId>/ (never KYC documents, licence or vehicle photos), no scheme, no dot-dot.
 */
export function isOwnPhotoKey(value: unknown, driverId: string): value is string {
  if (typeof value !== 'string') return false;
  const key = value.trim();
  if (key.length === 0 || key.length > 300 || key !== value) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(key) || key.includes('//') || key.includes('..') || key.includes('\\') || key.startsWith('/')) return false;
  if (!/^[A-Za-z0-9._\-/]+$/.test(key)) return false;
  return key.startsWith(`drivers/profile/${driverId}/`) && key.length > `drivers/profile/${driverId}/`.length;
}

/** The object key to show: the own-R2 profile photo, else the selfie, else null. */
export function pickPhotoKey(driverId: string, sources: DriverPhotoSources | null | undefined): string | null {
  const profile = sources?.user?.photoUrl;
  if (isOwnPhotoKey(profile, driverId)) return profile;
  const selfie = sources?.kycSubmission?.selfieKey;
  return typeof selfie === 'string' && selfie.length > 0 ? selfie : null;
}

const versionOf = (objectKey: string): string => createHash('sha256').update(objectKey).digest('hex').slice(0, 10);
const isSignedHttps = (url: unknown): url is string => typeof url === 'string' && /^https:\/\//i.test(url);

export interface DriverPhotoDeps {
  /** Absent: storage is off or unconfigured, so every answer is null. */
  storage?: DriverPhotoStorage | null;
  redis?: DriverPhotoRedis | null;
  /** Where the photo comes from. Default: one indexed read. Replaceable in tests. */
  loadSources?: (driverId: string) => Promise<DriverPhotoSources | null>;
  /** Where the completed-ride count comes from. Default: one indexed COUNT. Replaceable in tests. */
  countRides?: (driverId: string) => Promise<number>;
}

export function createDriverPhotoResolver(deps: DriverPhotoDeps): DriverPhotoResolver {
  const loadSources = deps.loadSources ?? ((driverId: string) => driverClient.photoSourcesOf(driverId));
  // Many readers of the same driver at once (a search with offers, several polls) share one lookup and one sign.
  const inFlight = new Map<string, Promise<DriverPhoto>>();

  async function resolve(driverId: string): Promise<DriverPhoto> {
    if (!deps.storage) return NO_DRIVER_PHOTO;
    const cacheKey = photoCacheKey(driverId);
    const cached = await deps.redis?.get(cacheKey).catch(() => null);
    if (cached) {
      try {
        const hit = JSON.parse(cached) as { u?: unknown; k?: unknown };
        if (hit.u === null) return NO_DRIVER_PHOTO;
        if (isSignedHttps(hit.u) && typeof hit.k === 'string') return { driverPhotoUrl: hit.u, driverPhotoKey: hit.k };
      } catch { /* a bad entry is looked up again */ }
    }
    let objectKey: string | null;
    try {
      objectKey = pickPhotoKey(driverId, await loadSources(driverId));
    } catch (error) {
      console.warn('[driver-photo] could not read the driver', { driverId, error: error instanceof Error ? error.message : String(error) });
      return NO_DRIVER_PHOTO;
    }
    if (!objectKey) {
      await deps.redis?.set(cacheKey, JSON.stringify({ u: null }), NO_PHOTO_CACHE_TTL_SECONDS).catch(() => undefined);
      return NO_DRIVER_PHOTO;
    }
    try {
      const url = await deps.storage.getSignedUrl(objectKey, PHOTO_URL_TTL_SECONDS);
      if (!isSignedHttps(url)) return NO_DRIVER_PHOTO;
      const photo = { driverPhotoUrl: url, driverPhotoKey: `${driverId}-${versionOf(objectKey)}` };
      await deps.redis?.set(cacheKey, JSON.stringify({ u: photo.driverPhotoUrl, k: photo.driverPhotoKey }), PHOTO_CACHE_TTL_SECONDS).catch(() => undefined);
      return photo;
    } catch (error) {
      console.warn('[driver-photo] could not sign the photo', { driverId, error: error instanceof Error ? error.message : String(error) });
      return NO_DRIVER_PHOTO;
    }
  }

  const countRides = deps.countRides ?? ((driverId: string) => driverClient.completedRidesOf(driverId));
  const ridesInFlight = new Map<string, Promise<number | null>>();

  async function rides(driverId: string): Promise<number | null> {
    const cached = await deps.redis?.get(ridesCompletedKey(driverId)).catch(() => null);
    if (cached !== null && cached !== undefined && /^\d+$/.test(cached)) return Number(cached);
    try {
      const count = await countRides(driverId);
      if (!Number.isInteger(count) || count < 0) return null;
      await deps.redis?.set(ridesCompletedKey(driverId), String(count), RIDES_COMPLETED_TTL_SECONDS).catch(() => undefined);
      return count;
    } catch (error) {
      console.warn('[driver-photo] could not count rides', { driverId, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  async function allowFace(riderId: string, driverId: string): Promise<boolean> {
    const send = deps.redis?.send?.bind(deps.redis);
    if (!send) return true;
    try {
      const key = facesKey(riderId);
      const added = await send('SADD', key, driverId);
      if (typeof added !== 'number') return true;     // no answer we can use: never hide a face for it
      if (added === 0) return true;                   // seen today already
      await send('EXPIRE', key, String(FACE_SET_TTL_SECONDS));
      const size = await send('SCARD', key);
      if (typeof size !== 'number' || size <= FACE_BUDGET_PER_DAY) return true;
      await send('SREM', key, driverId);
      // Once per rider per day, so a script shows up in the logs without flooding them.
      const first = await deps.redis?.get(`${key}:logged`).catch(() => 'x');
      if (!first) {
        await deps.redis?.set(`${key}:logged`, '1', FACE_SET_TTL_SECONDS).catch(() => undefined);
        console.warn('[driver-photo] face budget reached', { userId: riderId, limit: FACE_BUDGET_PER_DAY });
      }
      return false;
    } catch {
      return true;
    }
  }

  return {
    allowOfferFace: allowFace,
    ridesCompleted(driverId: string): Promise<number | null> {
      if (!driverId) return Promise.resolve(null);
      const pending = ridesInFlight.get(driverId);
      if (pending) return pending;
      const run = rides(driverId).catch(() => null).finally(() => { ridesInFlight.delete(driverId); });
      ridesInFlight.set(driverId, run);
      return run;
    },
    forDriver(driverId: string): Promise<DriverPhoto> {
      if (!driverId) return Promise.resolve(NO_DRIVER_PHOTO);
      const pending = inFlight.get(driverId);
      if (pending) return pending;
      const run = resolve(driverId).catch(() => NO_DRIVER_PHOTO).finally(() => { inFlight.delete(driverId); });
      inFlight.set(driverId, run);
      return run;
    },
  };
}

/**
 * The fields to spread into a rider's payload: nothing at all when the flag is off (resolver absent).
 *   driverPhotoUrl / driverPhotoKey (string | null) and driverRidesCompleted (integer | null).
 * Pass riderId for an OFFER (the face budget applies: past it the photo is null, the count stays);
 * leave it out for the booked driver, who always has a face.
 */
export async function driverPhotoFields(
  resolver: DriverPhotoResolver | undefined,
  driverId: string | null | undefined,
  opts: { riderId?: string | null } = {},
): Promise<Partial<DriverPhoto> & { driverRidesCompleted?: number | null }> {
  if (!resolver || !driverId) return {};
  const [face, driverRidesCompleted] = await Promise.all([
    opts.riderId && !(await resolver.allowOfferFace(opts.riderId, driverId)) ? Promise.resolve(NO_DRIVER_PHOTO) : resolver.forDriver(driverId),
    resolver.ridesCompleted(driverId),
  ]);
  return { ...face, driverRidesCompleted };
}

/** The one resolver of this process (set at start-up when the flag is on), for code that has no deps to carry it (the app's accept). */
let current: DriverPhotoResolver | undefined;
export function setDriverPhotoResolver(resolver: DriverPhotoResolver | undefined): void { current = resolver; }
export function getDriverPhotoResolver(): DriverPhotoResolver | undefined { return current; }
