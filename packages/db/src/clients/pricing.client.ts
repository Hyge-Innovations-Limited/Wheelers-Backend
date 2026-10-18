import { Prisma } from '@prisma/client';
import { getPricingSettings, normalizePricingSettings, setPricingSettings, type PricingSettings } from '@wheleers/config';
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
}

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
      },
    }),

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
