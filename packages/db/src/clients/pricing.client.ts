import { Prisma } from '@prisma/client';
import {
  areaFactorOf,
  fitHourCurve,
  getPricingSettings,
  lagosClock,
  marketHighFrom,
  normalizePricingSettings,
  quietMarketFareNgn,
  seedHourCurve,
  setPricingSettings,
  type CurveEvidence,
  type HourCurveFit,
  type PricingAreaKey,
  type PricingSettings,
} from '@wheleers/config';
import { prisma } from '../prisma';

const ROW = 'current';

/** One price shown to a rider and what it was made from. */
export interface PricingQuoteInput {
  origin: { lat: number; lng: number };
  destination: { lat: number; lng: number };
  pickupZone: string | null;
  distanceKm: number;
  durationSeconds: number;
  trafficRatio?: number | null;
  demandFactor: number;
  rush: boolean;
  marketFareNgn: number | null;
  floorFareNgn: number | null;
  rulesFareNgn: number;
  modelFareNgn: number | null;
  suggestedFareNgn: number;
  minOfferNgn: number;
  setBy: string;
  tripKey?: string | null;
  premiumNgn?: number | null;
  premiumPosition?: number | null;
  dayPeriod?: string | null;
  hourFactor?: number | null;
  surgeFactor?: number;
  rain?: string | null;
  rainFactor?: number;
}

/** A weather reading for a launch zone (apps/api-gateway pricing/weather.ts). */
export interface WeatherReadingInput {
  zone: string;
  at: Date;
  rain: 'none' | 'light' | 'heavy';
  mm: number | null;
  condition: string | null;
}

/** A reading this close to a price counts as the weather it was seen in. */
const RAIN_MATCH_MS = 20 * 60_000;

/** How far back the hour curve learns from. Older prices count less anyway (a week's age halves one). */
const CURVE_DAYS = 28;

/** With no trip time known, a Lagos road is taken at 24 km/h (as the fare does). */
const MINUTES_PER_KM = 2.5;
const point = (lat: number, lng: number) => `${lat.toFixed(5)},${lng.toFixed(5)}`;

/** The pricing settings owners edit, and the log of every price shown. */
export const pricingClient = {
  /** What is saved, made safe to price with. Defaults when nothing is. */
  async loadSettings(): Promise<{ settings: PricingSettings; updatedAt: Date | null; updatedBy: string | null }> {
    const row = await prisma.pricingSettings.findUnique({ where: { id: ROW } });
    return { settings: normalizePricingSettings(row?.data), updatedAt: row?.updatedAt ?? null, updatedBy: row?.updatedBy ?? null };
  },

  async saveSettings(settings: PricingSettings, updatedBy: string): Promise<PricingSettings> {
    const data = normalizePricingSettings(settings);
    await prisma.pricingSettings.upsert({
      where: { id: ROW },
      create: { id: ROW, data: data as unknown as Prisma.InputJsonValue, updatedBy: updatedBy.slice(0, 120) },
      update: { data: data as unknown as Prisma.InputJsonValue, updatedBy: updatedBy.slice(0, 120) },
    });
    return setPricingSettings(data);
  },

  /** Read the saved settings into this process. A failed read keeps what it had. */
  async refresh(): Promise<PricingSettings> {
    try {
      return setPricingSettings((await pricingClient.loadSettings()).settings);
    } catch (error) {
      console.warn('[pricing] settings not reloaded, keeping the last ones', { error: error instanceof Error ? error.message : String(error) });
      return getPricingSettings();
    }
  },

  /**
   * Load the settings now and again every minute, so a change an owner saves
   * reaches every process without a restart. Returns the stop function.
   */
  async startSync(everyMs = 60_000): Promise<() => void> {
    await pricingClient.refresh();
    const timer = setInterval(() => { void pricingClient.refresh(); }, everyMs);
    timer.unref?.();
    return () => clearInterval(timer);
  },

  logQuote: (q: PricingQuoteInput) =>
    prisma.pricingQuote.create({
      data: {
        originLat: q.origin.lat, originLng: q.origin.lng, destLat: q.destination.lat, destLng: q.destination.lng,
        pickupZone: q.pickupZone,
        distanceKm: q.distanceKm,
        durationSeconds: Math.round(q.durationSeconds),
        trafficRatio: q.trafficRatio ?? null,
        demandFactor: q.demandFactor,
        rush: q.rush,
        marketFareNgn: q.marketFareNgn,
        floorFareNgn: q.floorFareNgn,
        rulesFareNgn: q.rulesFareNgn,
        modelFareNgn: q.modelFareNgn,
        suggestedFareNgn: q.suggestedFareNgn,
        minOfferNgn: q.minOfferNgn,
        setBy: q.setBy.slice(0, 12),
        tripKey: q.tripKey ?? null,
        premiumNgn: q.premiumNgn ?? null,
        premiumPosition: q.premiumPosition ?? null,
        dayPeriod: q.dayPeriod ?? null,
        hourFactor: q.hourFactor ?? null,
        surgeFactor: q.surgeFactor ?? 1,
        rain: q.rain ?? null,
        rainFactor: q.rainFactor ?? 1,
      },
    }),

  /**
   * Every price since `since` that says what trips really cost, as a ratio to
   * the other app's quiet-hour figures for the same trip (fitHourCurve):
   * prices read off the other app; rides' agreed fares, moved from the price
   * they were shown by however far the bargaining took them; and the lowest
   * a driver asked on rides nobody agreed. A ride's own surge is taken out,
   * so a surge is never learned as the usual price for its hour.
   */
  async curveEvidence(since: Date, settings: PricingSettings = getPricingSettings()): Promise<CurveEvidence[]> {
    const [samples, rides, quotes, rainy] = await Promise.all([
      prisma.marketSample.findMany({ where: { takenAt: { gte: since } } }),
      prisma.ride.findMany({
        where: { createdAt: { gte: since }, distanceKm: { gt: 0 } },
        select: {
          pickupLat: true, pickupLng: true, destLat: true, destLng: true, distanceKm: true, durationSeconds: true, pickupZone: true,
          agreedFareNgn: true, createdAt: true, bids: { select: { amountNgn: true } },
        },
      }),
      prisma.pricingQuote.findMany({
        where: { createdAt: { gte: new Date(since.getTime() - 30 * 60_000) }, tripKey: { not: null }, marketFareNgn: { not: null } },
        select: { tripKey: true, marketFareNgn: true, suggestedFareNgn: true, surgeFactor: true, rainFactor: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.weatherReading.findMany({
        where: { at: { gte: new Date(since.getTime() - RAIN_MATCH_MS) }, rain: { not: 'none' } },
        select: { zone: true, at: true },
        orderBy: { at: 'asc' },
      }),
    ]);
    const out: CurveEvidence[] = [];
    // Was it raining then? At the ride's pickup zone when there is one; anywhere in the city for a price read off the other app (it has no place).
    const rainedAt = (at: Date, zone: string | null = null) =>
      rainy.some((r) => Math.abs(r.at.getTime() - at.getTime()) <= RAIN_MATCH_MS && (zone === null || r.zone === zone));

    for (const s of samples) {
      const area = s.area ? settings.areas[s.area as PricingAreaKey] : undefined;
      const base = quietMarketFareNgn(s.km, s.minutes, settings) * (area?.pickup ?? 1);
      if (base > 0) out.push({ at: s.takenAt, ratio: Number(s.priceNgn) / base, weight: 3, kind: 'sample', rain: rainedAt(s.takenAt) });
    }

    // The last price each trip was shown in its half hour.
    const quoteByKey = new Map(quotes.map((q) => [q.tripKey!, q]));
    for (const r of rides) {
      const bucket = Math.floor(r.createdAt.getTime() / (30 * 60_000));
      const ends = `${point(r.pickupLat, r.pickupLng)}>${point(r.destLat, r.destLng)}`;
      // A ride booked just after the half hour turned was quoted in the one before.
      const q = quoteByKey.get(`${ends}@${bucket}`) ?? quoteByKey.get(`${ends}@${bucket - 1}`);
      if (!q) continue;
      const km = r.distanceKm!;
      const minutes = r.durationSeconds && r.durationSeconds > 0 ? r.durationSeconds / 60 : km * MINUTES_PER_KM;
      const { factor } = areaFactorOf({ origin: { lat: r.pickupLat, lng: r.pickupLng }, destination: { lat: r.destLat, lng: r.destLng } });
      const base = quietMarketFareNgn(km, minutes, settings) * factor;
      const shown = Number(q.suggestedFareNgn);
      const market = Number(q.marketFareNgn) / (q.surgeFactor > 0 ? q.surgeFactor : 1);
      const lowestBid = r.bids.length ? Math.min(...r.bids.map((b) => Number(b.amountNgn))) : null;
      if (base <= 0) continue;
      if (r.agreedFareNgn !== null) {
        const agreed = Number(r.agreedFareNgn);
        // Taken as shown only says the price was about right; bargained, it says which way.
        out.push({ at: r.createdAt, ratio: (market + agreed - shown) / base, weight: Math.abs(agreed - shown) < 50 ? 0.5 : 1, kind: 'agreed', rain: rainedAt(r.createdAt, r.pickupZone) });
      } else if (lowestBid !== null) {
        out.push({ at: r.createdAt, ratio: (market + lowestBid - shown) / base, weight: 0.5, kind: 'bid', rain: rainedAt(r.createdAt, r.pickupZone) });
      }
    }
    return out;
  },

  /**
   * The hour curve the last four weeks of prices give, from the one saved (or,
   * with none yet, from what the rush and quiet figures charge now). Saves nothing.
   */
  /** Keep this pass's readings; drop those older than 90 days. */
  async saveWeather(readings: WeatherReadingInput[]): Promise<void> {
    if (readings.length === 0) return;
    await prisma.weatherReading.createMany({ data: readings });
    await prisma.weatherReading.deleteMany({ where: { at: { lt: new Date(Date.now() - 90 * 86_400_000) } } });
  },

  /** The latest reading of each zone. */
  async latestWeather(): Promise<WeatherReadingInput[]> {
    const rows = await prisma.$queryRaw<WeatherReadingInput[]>`
      SELECT DISTINCT ON (zone) zone, at, rain, mm, condition FROM "WeatherReading" ORDER BY zone, at DESC`;
    return rows.map((r) => ({ ...r, rain: r.rain as WeatherReadingInput['rain'] }));
  },

  async learnHourCurve(settings: PricingSettings, now = new Date()): Promise<HourCurveFit & {
    previous: PricingSettings['hourCurve'];
    /** The other app's high end against our guess with tonight's curve (null with too few of its prices), and from how many. */
    marketHigh: number | null;
    marketHighPrices: number;
  }> {
    const baseline = seedHourCurve(settings);
    const previous = settings.hourCurve ?? baseline;
    const evidence = await pricingClient.curveEvidence(new Date(now.getTime() - CURVE_DAYS * 86_400_000), settings);
    const fit = fitHourCurve(evidence, previous, now, { baseline });
    // Each price read off the other app against what we would have guessed for it with tonight's curve
    // (and the rain lift, if it rained): its high end is where we read the other app from.
    const ratios = evidence
      .filter((e) => e.kind === 'sample')
      .map((e) => {
        const { hour, weekend } = lagosClock(e.at);
        const curve = (weekend ? fit.curve.weekend : fit.curve.weekday)[hour] ?? 1;
        return e.ratio / (curve * (e.rain ? settings.rainLift : 1));
      });
    return { ...fit, previous, marketHigh: marketHighFrom(ratios), marketHighPrices: ratios.length };
  },

  /**
   * The weekly check: how many prices were shown since `since`, which part
   * set them, how far above the other app they sat, and how many rides were
   * requested and completed in the same period.
   */
  async summary(since: Date) {
    const [bySetter, quotes, rides] = await Promise.all([
      prisma.pricingQuote.groupBy({ by: ['setBy'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
      prisma.$queryRaw<Array<{ n: bigint; above: number | null; model_gap: number | null; with_model: bigint }>>`
        SELECT count(*) AS n,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY ("suggestedFareNgn" - "marketFareNgn")) FILTER (WHERE "marketFareNgn" IS NOT NULL) AS above,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY ("modelFareNgn" - "suggestedFareNgn")) FILTER (WHERE "modelFareNgn" IS NOT NULL) AS model_gap,
               count(*) FILTER (WHERE "modelFareNgn" IS NOT NULL) AS with_model
        FROM "PricingQuote" WHERE "createdAt" >= ${since}`,
      prisma.ride.groupBy({ by: ['status'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    ]);
    const q = quotes[0];
    const rideCount = (status: string) => rides.find((r) => r.status === status)?._count._all ?? 0;
    return {
      since: since.toISOString(),
      quotes: Number(q?.n ?? 0),
      setBy: Object.fromEntries(bySetter.map((r) => [r.setBy, r._count._all])) as Record<string, number>,
      medianAboveMarketNgn: q?.above == null ? null : Math.round(Number(q.above)),
      quotesWithModel: Number(q?.with_model ?? 0),
      medianModelMinusQuoteNgn: q?.model_gap == null ? null : Math.round(Number(q.model_gap)),
      ridesRequested: rides.reduce((sum, r) => sum + r._count._all, 0),
      ridesCompleted: rideCount('COMPLETED'),
    };
  },
};
