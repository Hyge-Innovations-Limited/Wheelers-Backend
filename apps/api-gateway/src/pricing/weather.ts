import { LAUNCH_ZONES, zoneFor, type Rain } from '@wheleers/config';
import { pricingClient, type WeatherReadingInput } from '@wheleers/db';
import type { RedisClient } from '../redis/client';

/**
 * Rain, for pricing: the other apps charge more in the rain, and we want to
 * as well, without anyone having to say it is raining.
 *
 * Every 15 minutes, on the one process that runs jobs, the weather at the
 * middle of each launch zone is read from Google's Weather API (the same
 * Google key as the maps; the "Weather API" must be enabled for it). Each
 * reading is kept (the nightly learning uses them to tell prices seen in the
 * rain from dry ones) and shared through Redis; every process reads them each
 * minute. A pickup takes its zone's reading, or the nearest zone's within
 * 25 km; a reading older than 45 minutes, or none at all, is no rain: a price
 * is never lifted on stale or missing weather.
 */
const KEY = 'pricing:weather';
const FRESH_MS = 45 * 60_000;
const NEAR_KM = 25;
const URL_BASE = 'https://weather.googleapis.com/v1/currentConditions:lookup';

export type ZoneWeather = WeatherReadingInput & { lat: number; lng: number };

/** What Google says, as rain we price on: none, light or heavy. */
export function classifyWeather(payload: unknown): { rain: Rain; mm: number | null; condition: string | null } {
  const p = payload as { weatherCondition?: { type?: unknown }; precipitation?: { qpf?: { quantity?: unknown } } } | null;
  const condition = typeof p?.weatherCondition?.type === 'string' ? p.weatherCondition.type.toUpperCase() : null;
  const raw = Number(p?.precipitation?.qpf?.quantity);
  const mm = Number.isFinite(raw) && raw >= 0 ? Math.round(raw * 10) / 10 : null;
  const word = condition ?? '';
  // "Chance of showers" is a forecast, not rain now.
  const wet = !/CHANCE_OF/.test(word) && /RAIN|SHOWER|DRIZZLE|THUNDER/.test(word);
  const heavy = /HEAVY|THUNDERSTORM|THUNDERSHOWER/.test(word) || (mm !== null && mm >= 7.5);
  if (heavy && (wet || (mm !== null && mm >= 7.5))) return { rain: 'heavy', mm, condition };
  if (wet || (mm !== null && mm >= 0.5)) return { rain: 'light', mm, condition };
  return { rain: 'none', mm, condition };
}

function centre(polygon: Array<[number, number]>): { lat: number; lng: number } {
  const lats = polygon.map((pt) => pt[0]);
  const lngs = polygon.map((pt) => pt[1]);
  return { lat: (Math.min(...lats) + Math.max(...lats)) / 2, lng: (Math.min(...lngs) + Math.max(...lngs)) / 2 };
}

const kmBetween = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) =>
  Math.hypot((a.lat - b.lat) * 111, (a.lng - b.lng) * 110);

let current: ZoneWeather[] = [];
let lastFailureLog = 0;

/** The rain at a pickup now. Unknown or stale is none. */
export function rainAt(lat: number, lng: number, now = Date.now()): Rain {
  const fresh = current.filter((w) => now - new Date(w.at).getTime() <= FRESH_MS);
  if (fresh.length === 0) return 'none';
  const zone = zoneFor(lat, lng);
  const own = zone ? fresh.find((w) => w.zone === zone) : undefined;
  if (own) return own.rain;
  const nearest = fresh
    .map((w) => ({ w, km: kmBetween({ lat, lng }, w) }))
    .filter((x) => x.km <= NEAR_KM)
    .sort((a, b) => a.km - b.km)[0];
  return nearest?.w.rain ?? 'none';
}

export function weatherNow(): ZoneWeather[] {
  return current;
}

/** One pass: every zone's weather, kept and shared. Zones that fail are left out. Exported for the test and the CLI. */
export async function measureWeather(redis: RedisClient, apiKey: string, fetchFn: typeof fetch = fetch, now = new Date()): Promise<ZoneWeather[]> {
  const read = await Promise.all(LAUNCH_ZONES.map(async (zone): Promise<ZoneWeather | null> => {
    const c = centre(zone.polygon);
    try {
      const url = `${URL_BASE}?key=${encodeURIComponent(apiKey)}&location.latitude=${c.lat}&location.longitude=${c.lng}`;
      const res = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!res.ok) throw new Error(`${res.status} ${body?.error?.message?.slice(0, 160) ?? ''}`.trim());
      return { zone: zone.name, at: now, ...classifyWeather(body), ...c };
    } catch (error) {
      // Once an hour at most: a disabled API would otherwise fill the log every 15 minutes.
      if (Date.now() - lastFailureLog > 60 * 60_000) {
        lastFailureLog = Date.now();
        console.warn('[pricing] weather not read; prices go on without rain', { zone: zone.name, error: error instanceof Error ? error.message : String(error) });
      }
      return null;
    }
  }));
  const readings = read.filter((r): r is ZoneWeather => r !== null);
  if (readings.length === 0) return [];
  await pricingClient.saveWeather(readings.map(({ zone, at, rain, mm, condition }) => ({ zone, at, rain, mm, condition })))
    .catch((error) => console.warn('[pricing] weather not kept', { error: error instanceof Error ? error.message : String(error) }));
  // Zones that failed this pass keep their last reading until it goes stale.
  const merged = new Map(current.map((w) => [w.zone, w]));
  for (const r of readings) merged.set(r.zone, r);
  current = [...merged.values()];
  await redis.set(KEY, JSON.stringify(current), 60 * 60);
  return readings;
}

async function readShared(redis: RedisClient): Promise<void> {
  const raw = await redis.get(KEY).catch(() => null);
  if (!raw) return;
  try {
    current = (JSON.parse(raw) as ZoneWeather[]).map((w) => ({ ...w, at: new Date(w.at) }));
  } catch {
    // keep what we have
  }
}

/** The leader reads the weather every 15 minutes; every process takes it up each minute. Nothing runs without a key. */
export function startWeatherJob(redis: RedisClient, apiKey: string | undefined, shouldRun: () => Promise<boolean>, everyMs = 15 * 60_000): () => void {
  if (!apiKey) return () => undefined;
  const pass = () => void (async () => {
    if (!(await shouldRun().catch(() => false))) return;
    await measureWeather(redis, apiKey).catch((error) => console.warn('[pricing] weather pass failed', { error: error instanceof Error ? error.message : String(error) }));
  })();
  const measure = setInterval(pass, everyMs);
  // The first read soon after starting, not 15 minutes in.
  const first = setTimeout(pass, 30_000);
  const read = setInterval(() => void readShared(redis), 60_000);
  void readShared(redis);
  measure.unref?.();
  first.unref?.();
  read.unref?.();
  return () => { clearInterval(measure); clearTimeout(first); clearInterval(read); };
}

/** Tests: set the readings directly. */
export function setWeatherForTest(readings: ZoneWeather[]): void {
  current = readings;
}
