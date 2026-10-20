import { LAUNCH_ZONES, getPricingSettings, zoneFor } from '@wheleers/config';
import { driverPresence, prisma } from '@wheleers/db';
import type { RedisClient } from '../redis/client';

/**
 * The live surge: how far our own market says the price should move right
 * now, read from what our riders and drivers are doing, the way other apps
 * price on theirs. 1 is none; up to surgeMax when busy, down to surgeMin
 * when quiet.
 *
 * Every two minutes, on the one process that runs jobs, over the last half
 * hour, for each launch zone and for the whole city:
 *
 *   up    drivers ask more    the lowest bid against the rider's offer:
 *                             drivers asking 10% more lift it 8%
 *         nobody bids         drivers online, yet most rides got no bid: +up to 10%
 *         more riders than    requests against drivers online: +up to 20%
 *         drivers
 *   down  quiet               at least 3 drivers online and next to nobody
 *                             asking (no ride, or one ride for every four
 *                             drivers): halfway to surgeMin, all the way with no ride at all
 *         drivers ask less    drivers bidding under riders' offers: half of how far under
 *
 * Anything pushing up wins over anything pushing down, and nothing comes off
 * without drivers there to take the ride: no drivers online, or nothing to
 * read, is 1. A zone with too few rides to read takes the city's figure. The
 * figure moves toward what the signals call for by at most 0.05 a pass up
 * and 0.03 down, so a price never jumps, and goes back to 1 as the reasons
 * pass. Each gateway process reads the result once a minute.
 */
const KEY = 'pricing:surge';
const WINDOW_MS = 30 * 60_000;
/** A ride this new has not had its chance at a bid yet. */
const BID_GRACE_MS = 3 * 60_000;
/** Rides in the window a zone needs before its own signals are read; fewer, and it takes the city's. */
const MIN_RIDES = 2;
/** Drivers online, at least, before a quiet market takes anything off: there must be someone to take the ride. */
export const QUIET_DRIVERS = 3;
/** Rides for every driver online below which the market is quiet. */
const QUIET_RIDES_PER_DRIVER = 0.25;
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
  /** Why, in a few words: "quiet: 4 drivers, no rides". */
  why: string;
  /** Took the city's signals: too few rides in the zone. */
  fromCity: boolean;
  at: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * What the signals call for, between min and max (min 1: never down), and
 * why. Up wins over down; nothing comes off without drivers online.
 */
export function readSurge(s: SurgeSignals, max: number, min = 1): { target: number; why: string } {
  const floor = Math.min(1, Math.max(0, min));
  const bounded = (n: number) => round2(Math.min(max, Math.max(floor, n)));
  const quiet = s.drivers >= QUIET_DRIVERS;
  const halfway = 1 - (1 - floor) / 2;

  if (s.rides < MIN_RIDES) {
    // Too few rides to read how drivers bid; who is waiting still says something.
    if (quiet && s.rides === 0) return { target: bounded(floor), why: `quiet: ${s.drivers} drivers online, no rides` };
    if (quiet) return { target: bounded(halfway), why: `quiet: ${s.drivers} drivers online, 1 ride` };
    return { target: 1, why: s.drivers === 0 ? 'no drivers online' : 'too little to read' };
  }

  let up = 0;
  const reasons: string[] = [];
  if (s.counter !== null && s.counter > 1) { up += 0.8 * (s.counter - 1); reasons.push(`drivers ask ${Math.round((s.counter - 1) * 100)}% more`); }
  if (s.drivers > 0 && s.noBidShare !== null && s.noBidShare >= 0.5) { up += 0.1 * s.noBidShare; reasons.push(`${Math.round(s.noBidShare * 100)}% got no bid`); }
  const perDriver = s.rides / Math.max(s.drivers, 1);
  if (perDriver > 1.5) { up += Math.min(0.2, 0.1 * Math.log(perDriver)); reasons.push(`${s.rides} rides for ${s.drivers} drivers`); }
  if (up > 0) return { target: bounded(1 + up), why: `busy: ${reasons.join(', ')}` };

  // Nothing pushing up: is anything pushing down?
  let down = 1;
  if (s.counter !== null && s.counter < 0.97) { down = Math.min(down, 1 - 0.5 * (1 - s.counter)); reasons.push(`drivers bid ${Math.round((1 - s.counter) * 100)}% under`); }
  if (quiet && perDriver < QUIET_RIDES_PER_DRIVER) { down = Math.min(down, halfway); reasons.push(`${s.drivers} drivers for ${s.rides} rides`); }
  if (down < 1 && s.drivers > 0) return { target: bounded(down), why: `quiet: ${reasons.join(', ')}` };
  return { target: 1, why: 'steady' };
}

/** What the signals call for: see readSurge. */
export function surgeTarget(s: SurgeSignals, max: number, min = 1): number {
  return readSurge(s, max, min).target;
}

/** One step from where the surge is toward where the signals say, never under min. */
export function stepSurge(was: number, target: number, min = 1): number {
  const next = target > was ? Math.min(target, was + STEP_UP) : Math.max(target, was - STEP_DOWN);
  return round2(Math.max(Math.min(1, min), next));
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
  const min = settings.surgeMin;
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

  const area = (name: string, signals: SurgeSignals, fromCity: boolean, read: { target: number; why: string }): AreaSurge => {
    const was = previous.get(name)?.factor ?? 1;
    // Off, it reads but applies nothing; a saved figure past today's limits is brought inside them.
    const factor = settings.surgeOn ? stepSurge(Math.min(max, Math.max(min, was)), read.target, min) : 1;
    return { area: name, ...signals, target: read.target, factor, why: read.why, fromCity, at: now.toISOString() };
  };

  const citySignals = signalsOf(rides, cityDrivers, now);
  const cityRead = readSurge(citySignals, max, min);
  const out: AreaSurge[] = [area(CITY, citySignals, false, cityRead)];
  for (const zone of LAUNCH_ZONES) {
    const signals = signalsOf(rides.filter((r) => r.pickupZone === zone.name), driversByZone.get(zone.name) ?? 0, now);
    const own = signals.rides >= MIN_RIDES;
    out.push(area(zone.name, signals, !own, own ? readSurge(signals, max, min) : cityRead));
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
