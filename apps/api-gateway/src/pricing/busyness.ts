import { LAUNCH_ZONES, demandFactorForRatio, zoneFor } from '@wheleers/config';
import { driverPresence, prisma } from '@wheleers/db';
import type { RedisClient } from '../redis/client';

/**
 * How busy each launch zone is right now, as the demand multiplier the fare
 * uses (1 = normal, at most 1.8).
 *
 * Every five minutes, on the one process that runs jobs: rides requested in
 * the zone in the last ten minutes over drivers online there, against what
 * is usual for that zone at that hour. The multiplier then moves toward what
 * that ratio calls for by at most 0.1 a pass, so a price never jumps.
 *
 * It only rises when there is something to read: fewer than three requests
 * in the window is no signal, and a zone-hour with no history yet has no
 * "usual" to be busier than. Until then the multiplier is 1.
 *
 * The result sits in Redis; every gateway process reads it once a minute.
 */
const KEY = 'pricing:busyness';
const BASELINE_KEY = 'pricing:busyness:usual';
const WINDOW_MS = 10 * 60_000;
const STEP = 0.1;
const MIN_REQUESTS = 3;
/** Passes a zone-hour needs before its usual level is trusted (about an hour of that hour, across days). */
const MIN_HISTORY = 12;
const USUAL_WEIGHT = 0.05;

export interface ZoneBusyness {
  zone: string;
  requests: number;
  drivers: number;
  /** Requests per driver now ÷ the usual for this zone and hour. Null when there is nothing to compare. */
  ratio: number | null;
  factor: number;
  at: string;
}

let current = new Map<string, ZoneBusyness>();

/** The demand multiplier for a pickup point. 1 outside the launch zones. */
export function demandFactorAt(lat: number, lng: number): number {
  const zone = zoneFor(lat, lng);
  return (zone && current.get(zone)?.factor) || 1;
}

export function busynessNow(): ZoneBusyness[] {
  return [...current.values()];
}

function centre(polygon: Array<[number, number]>): { lat: number; lng: number; radiusKm: number } {
  const lats = polygon.map((p) => p[0]); const lngs = polygon.map((p) => p[1]);
  const lat = (Math.min(...lats) + Math.max(...lats)) / 2; const lng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
  const halfDiagonalKm = Math.hypot((Math.max(...lats) - Math.min(...lats)) * 111, (Math.max(...lngs) - Math.min(...lngs)) * 110) / 2;
  return { lat, lng, radiusKm: Math.max(2, halfDiagonalKm) };
}

/** One pass: measure each zone, step its multiplier, save. Exported for the test. */
export async function measureBusyness(redis: RedisClient, now = new Date()): Promise<ZoneBusyness[]> {
  const since = new Date(now.getTime() - WINDOW_MS);
  const lagos = new Date(now.getTime() + 60 * 60_000);
  const cell = `${lagos.getUTCHours()}:${lagos.getUTCDay() === 0 || lagos.getUTCDay() === 6 ? 'we' : 'wd'}`;
  const previous = await readSaved(redis);
  const usualRaw = await redis.get(BASELINE_KEY).catch(() => null);
  const usual = (usualRaw ? JSON.parse(usualRaw) : {}) as Record<string, { level: number; n: number }>;
  const out: ZoneBusyness[] = [];

  for (const zone of LAUNCH_ZONES) {
    const requests = await prisma.ride.count({
      // A request the rider replaced with a newer one is the same person asking again, not more demand.
      where: { pickupZone: zone.name, createdAt: { gte: since, lte: now }, OR: [{ cancelReason: null }, { cancelReason: { not: 'Replaced by a newer request' } }] },
    });
    const c = centre(zone.polygon);
    const near = (await driverPresence.nearby(c.lat, c.lng, c.radiusKm, 500, now.getTime()).catch(() => null)) ?? [];
    const drivers = near.filter((d) => zoneFor(d.lat, d.lng) === zone.name).length;
    const level = requests / Math.max(drivers, 1);

    const key = `${zone.name}:${cell}`;
    const known = usual[key];
    const ratio = known && known.n >= MIN_HISTORY && known.level > 0 ? level / known.level : null;
    usual[key] = known
      ? { level: known.level * (1 - USUAL_WEIGHT) + level * USUAL_WEIGHT, n: known.n + 1 }
      : { level, n: 1 };

    const target = ratio !== null && requests >= MIN_REQUESTS ? demandFactorForRatio(ratio) : 1;
    const was = previous.get(zone.name)?.factor ?? 1;
    const factor = Math.round((was + Math.max(-STEP, Math.min(STEP, target - was))) * 100) / 100;
    out.push({ zone: zone.name, requests, drivers, ratio: ratio === null ? null : Math.round(ratio * 100) / 100, factor, at: now.toISOString() });
  }

  await redis.set(KEY, JSON.stringify(out), 30 * 60);
  await redis.set(BASELINE_KEY, JSON.stringify(usual));
  current = new Map(out.map((z) => [z.zone, z]));
  return out;
}

async function readSaved(redis: RedisClient): Promise<Map<string, ZoneBusyness>> {
  const raw = await redis.get(KEY).catch(() => null);
  if (!raw) return new Map();
  try {
    return new Map((JSON.parse(raw) as ZoneBusyness[]).map((z) => [z.zone, z]));
  } catch {
    return new Map();
  }
}

/** The leader measures every five minutes; every process reads the result each minute. */
export function startBusynessJob(redis: RedisClient, shouldRun: () => Promise<boolean>, everyMs = 5 * 60_000): () => void {
  const measure = setInterval(() => {
    void (async () => {
      if (!(await shouldRun().catch(() => false))) return;
      await measureBusyness(redis).catch((error) => console.warn('[pricing] busyness pass failed', { error: error instanceof Error ? error.message : String(error) }));
    })();
  }, everyMs);
  const read = setInterval(() => { void readSaved(redis).then((saved) => { current = saved; }); }, 60_000);
  void readSaved(redis).then((saved) => { current = saved; });
  measure.unref?.(); read.unref?.();
  return () => { clearInterval(measure); clearInterval(read); };
}
