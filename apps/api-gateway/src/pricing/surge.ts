import { LAUNCH_ZONES, getPricingSettings, zoneFor } from '@wheleers/config';
import { driverPresence, prisma } from '@wheleers/db';
import type { RedisClient } from '../redis/client';

/**
 * The live surge: how far our own market says the price should rise right
 * now, read from what our riders and drivers are doing, the way other apps
 * surge on theirs. It only ever lifts a price (1 = none), up to surgeMax.
 *
 * Every two minutes, on the one process that runs jobs, over the last half
 * hour, for each launch zone and for the whole city:
 *
 *   drivers ask more    the lowest bid on a ride against the rider's offer:
 *                       drivers asking 10% more lift it 8%
 *   nobody bids         drivers are online, yet most rides got no bid: +up to 10%
 *   more riders than    requests against drivers online there: +up to 20%
 *   drivers
 *
 * A zone with too few rides to read takes the city's figure, so a surge
 * works at our size: a few rides across Lagos are enough to read. The
 * figure moves toward what the signals call for by at most 0.05 a pass up
 * and 0.03 down, so a price never jumps, and falls back to 1 when the
 * signals go quiet. Each gateway process reads the result once a minute.
 */
const KEY = 'pricing:surge';
const WINDOW_MS = 30 * 60_000;
/** A ride this new has not had its chance at a bid yet. */
const BID_GRACE_MS = 3 * 60_000;
/** Rides in the window a zone needs before its own signals are read; fewer, and it takes the city's. */
const MIN_RIDES = 2;
const STEP_UP = 0.05;
const STEP_DOWN = 0.03;
export const CITY = 'city';

export interface SurgeSignals {
  /** Rides requested in the window. */
  rides: number;
  /** Drivers online in the area now. */
  drivers: number;
  /** The middle of (lowest bid ÷ rider's offer) over rides that got a bid. Null: no bids. */
  counter: number | null;
  /** Of rides old enough to have been bid on, the share that got none. Null: none old enough. */
  noBidShare: number | null;
}

export interface AreaSurge extends SurgeSignals {
  area: string;
  /** What the signals call for now, and the figure applied (moving toward it). */
  target: number;
  factor: number;
  /** Took the city's signals: too few rides in the zone. */
  fromCity: boolean;
  at: string;
}

/** What the signals call for: 1 when there is too little to read, never past max. */
export function surgeTarget(s: SurgeSignals, max: number): number {
  if (s.rides < MIN_RIDES) return 1;
  let target = 1;
  if (s.counter !== null && s.counter > 1) target += 0.8 * (s.counter - 1);
  if (s.drivers > 0 && s.noBidShare !== null && s.noBidShare >= 0.5) target += 0.1 * s.noBidShare;
  const perDriver = s.rides / Math.max(s.drivers, 1);
  if (perDriver > 1.5) target += Math.min(0.2, 0.1 * Math.log(perDriver));
  return Math.round(Math.min(max, Math.max(1, target)) * 100) / 100;
}

/** One step from where the surge is toward where the signals say. */
export function stepSurge(was: number, target: number): number {
  const next = target > was ? Math.min(target, was + STEP_UP) : Math.max(target, was - STEP_DOWN);
  return Math.round(Math.max(1, next) * 100) / 100;
}

let current = new Map<string, AreaSurge>();

/** The live surge for a pickup point: its zone's, or the city's outside the zones. 1 when there is none. */
export function surgeFactorAt(lat: number, lng: number): number {
  const zone = zoneFor(lat, lng);
  return (zone && current.get(zone)?.factor) || current.get(CITY)?.factor || 1;
}

export function surgeNow(): AreaSurge[] {
  return [...current.values()];
}

function centre(polygon: Array<[number, number]>): { lat: number; lng: number; radiusKm: number } {
  const lats = polygon.map((p) => p[0]); const lngs = polygon.map((p) => p[1]);
  const lat = (Math.min(...lats) + Math.max(...lats)) / 2; const lng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
  const halfDiagonalKm = Math.hypot((Math.max(...lats) - Math.min(...lats)) * 111, (Math.max(...lngs) - Math.min(...lngs)) * 110) / 2;
  return { lat, lng, radiusKm: Math.max(2, halfDiagonalKm) };
}

type WindowRide = {
  pickupZone: string | null;
  createdAt: Date;
  riderOfferNgn: unknown;
  fareEstimateNgn: unknown;
  bids: Array<{ amountNgn: unknown }>;
};

function signalsOf(rides: WindowRide[], drivers: number, now: Date): SurgeSignals {
  const ratios: number[] = [];
  let old = 0;
  let unbid = 0;
  for (const r of rides) {
    const offer = Number(r.riderOfferNgn ?? r.fareEstimateNgn ?? 0);
    if (r.bids.length && offer > 0) ratios.push(Math.min(...r.bids.map((b) => Number(b.amountNgn))) / offer);
    if (now.getTime() - r.createdAt.getTime() >= BID_GRACE_MS) {
      old += 1;
      if (!r.bids.length) unbid += 1;
    }
  }
  ratios.sort((a, b) => a - b);
  return {
    rides: rides.length,
    drivers,
    counter: ratios.length ? ratios[Math.floor(ratios.length / 2)]! : null,
    noBidShare: old ? unbid / old : null,
  };
}

/** One pass: read each zone and the city, step each figure, save. Exported for the test and the CLI. */
export async function measureSurge(redis: RedisClient, now = new Date()): Promise<AreaSurge[]> {
  const settings = getPricingSettings();
  const max = settings.surgeMax;
  const previous = await readSaved(redis);
  const rides: WindowRide[] = await prisma.ride.findMany({
    where: {
      createdAt: { gte: new Date(now.getTime() - WINDOW_MS), lte: now },
      // A request the rider replaced with a newer one is the same person asking again, not more demand.
      OR: [{ cancelReason: null }, { cancelReason: { not: 'Replaced by a newer request' } }],
    },
    select: { pickupZone: true, createdAt: true, riderOfferNgn: true, fareEstimateNgn: true, bids: { select: { amountNgn: true } } },
  });

  const driversByZone = new Map<string, number>();
  let cityDrivers = 0;
  for (const zone of LAUNCH_ZONES) {
    const c = centre(zone.polygon);
    const near = (await driverPresence.nearby(c.lat, c.lng, c.radiusKm, 500, now.getTime()).catch(() => null)) ?? [];
    const count = near.filter((d) => zoneFor(d.lat, d.lng) === zone.name).length;
    driversByZone.set(zone.name, count);
    cityDrivers += count;
  }

  const area = (name: string, signals: SurgeSignals, fromCity: boolean, target: number): AreaSurge => {
    const was = previous.get(name)?.factor ?? 1;
    return { area: name, ...signals, target, factor: settings.surgeOn ? stepSurge(was, target) : 1, fromCity, at: now.toISOString() };
  };

  const citySignals = signalsOf(rides, cityDrivers, now);
  const cityTarget = surgeTarget(citySignals, max);
  const out: AreaSurge[] = [area(CITY, citySignals, false, cityTarget)];
  for (const zone of LAUNCH_ZONES) {
    const signals = signalsOf(rides.filter((r) => r.pickupZone === zone.name), driversByZone.get(zone.name) ?? 0, now);
    const own = signals.rides >= MIN_RIDES;
    out.push(area(zone.name, signals, !own, own ? surgeTarget(signals, max) : cityTarget));
  }

  await redis.set(KEY, JSON.stringify(out), 30 * 60);
  current = new Map(out.map((a) => [a.area, a]));
  return out;
}

export async function readSaved(redis: RedisClient): Promise<Map<string, AreaSurge>> {
  const raw = await redis.get(KEY).catch(() => null);
  if (!raw) return new Map();
  try {
    return new Map((JSON.parse(raw) as AreaSurge[]).map((a) => [a.area, a]));
  } catch {
    return new Map();
  }
}

/** The leader measures every two minutes; every process reads the result each minute. */
export function startSurgeJob(redis: RedisClient, shouldRun: () => Promise<boolean>, everyMs = 2 * 60_000): () => void {
  const measure = setInterval(() => {
    void (async () => {
      if (!(await shouldRun().catch(() => false))) return;
      await measureSurge(redis).catch((error) => console.warn('[pricing] surge pass failed', { error: error instanceof Error ? error.message : String(error) }));
    })();
  }, everyMs);
  const read = setInterval(() => { void readSaved(redis).then((saved) => { current = saved; }); }, 60_000);
  void readSaved(redis).then((saved) => { current = saved; });
  measure.unref?.(); read.unref?.();
  return () => { clearInterval(measure); clearInterval(read); };
}
