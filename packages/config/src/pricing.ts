/**
 * Wheelers pricing, version 2 (since 2026-10-10).
 *
 * A fare is what the RIDER pays: one number, shown to them with no lines.
 * It is built from the driver's rate per km:
 *
 *   trip fare      = rate per km × distance            ₦350 × 10 km = ₦3,500
 *   + VAT 7.5% of the trip fare                                      ₦262.50
 *   + service charge (Wheelers')                                     ₦350
 *   = the fare, rounded up to ₦50                                    ₦4,150
 *
 * and taken apart the same way when the trip is paid: the booking fee comes
 * off, what is left is trip fare + VAT (so the trip fare is it ÷ 1.075), and
 * from the trip fare the driver gives up 10% commission and the ₦30 Lagos
 * levy. VAT and the booking fee are the rider's cost, never the driver's.
 *
 * Everything is worked from the fare alone, so a rider's own price, a
 * driver's per-km bid and an older app's total bid all settle by one rule.
 * (The few naira of rounding stay in the fare: they raise the trip fare and
 * its VAT a little, so the books always add up to what the rider paid.)
 *
 * Version 1 (rides requested before the switch) is kept below: those rides
 * settle exactly as they were agreed.
 *
 * What a trip is SUGGESTED at is the highest of three numbers (see
 * calculateSuggestedFare): the market floor (what inDrive would charge, plus
 * a premium), the rules (the base rate lifted by traffic and a busy area)
 * and, once switched on, the model. The floor is never undercut.
 */
import { candidateFares, chooseFare, getPricingMlModel, steadyDraw } from './pricing-ml';

export type PricingVersion = 1 | 2;
export const CURRENT_PRICING_VERSION: PricingVersion = 2;

/** The recommended rate per km on a free road. */
export const RATE_PER_KM_NGN = 375;
/** A rider may offer no less than this share of the recommended rate; a driver may ask no more than MAX_COUNTER_SHARE of it. */
export const MIN_OFFER_SHARE = 0.9;
export const MAX_COUNTER_SHARE = 1.5;
/** Old name for the driver ceiling as a rate: 150% of the base rate. */
export const MAX_RATE_PER_KM_NGN = Math.round(RATE_PER_KM_NGN * MAX_COUNTER_SHARE);
/** Wheelers' flat service charge, in every fare, charged to the rider. (Called the booking fee in older code.) */
export const BOOKING_FEE_NGN = 350;
/** Version 1 rides were agreed with a ₦375 booking fee. */
const V1_BOOKING_FEE_NGN = 375;
const bookingFeeOf = (version: PricingVersion) => (version === 1 ? V1_BOOKING_FEE_NGN : BOOKING_FEE_NGN);
/** The booking fee is the platform's part of a suggested fare. (Old name.) */
export const PLATFORM_FEE_NGN = BOOKING_FEE_NGN;
/** Old name: how far below the suggested fare a rider may go. */
export const MIN_OFFER_DISCOUNT = 1 - MIN_OFFER_SHARE;
/**
 * Hard floor on what any ride can cost the rider, regardless of distance.
 * Short trips would otherwise leave the driver nothing for their time.
 */
export const MIN_FARE_NGN = 2500;
/** Fares shown to riders are rounded up to this. */
export const FARE_ROUNDING_INCREMENT = 50;
export const SERVICE_FEE_NGN = BOOKING_FEE_NGN; // the booking fee's old name
/** 10% of the trip fare, from the driver. */
export const COMMISSION_RATE = 0.1;
export const PLATFORM_FEE_RATE = COMMISSION_RATE; // old name
/** 7.5% of the trip fare, added to the rider's fare. */
export const VAT_RATE = 0.075;
export const LAGOS_STATE_FEE_NGN = 30; // ₦30 flat per ride, from the driver

/** Version 1: 4% commission and 7.5% VAT, both taken from the driver's share (fare − booking fee). */
const V1_COMMISSION_RATE = 0.04;

// ── The recommended rate (traffic and demand are switches, off by default) ──

const flag = (name: string) => (process.env[name] ?? '').trim().toLowerCase() === 'on';
/** The recommended rate rises on slow roads: switched on in the admin's pricing settings (or PRICING_TRAFFIC_FACTOR=on). */
export const trafficFactorOn = () => flag('PRICING_TRAFFIC_FACTOR') || pricingSettings.trafficOn;
/** The recommended rate follows demand in the area: the admin's pricing settings (or PRICING_DEMAND_FACTOR=on). */
export const demandFactorOn = () => flag('PRICING_DEMAND_FACTOR') || pricingSettings.demandOn;

// ── Pricing settings (owners edit them in the admin; each service reloads them) ──

/** Another app's fare for a trip, as base + per km + per minute. */
export type MarketFormula = { baseNgn: number; perKmNgn: number; perMinuteNgn: number };

/**
 * The model: a small linear fit of ln(rate per km a trip is agreed at), trained
 * offline from Wheelers' own quotes and bids (scripts/train-pricing-model.mjs).
 * It is a handful of numbers, scored here in a few multiplications.
 */
export type PricingModel = {
  trainedAt: string;
  /** Real agreed trips it was fitted on. */
  rows: number;
  /** True while made-up trips from the simulator still carry part of the fit (fewer than 300 real ones). */
  seeded: boolean;
  intercept: number;
  coef: { lnKm: number; minPerKm: number; lnDemand: number; rush: number; night: number; weekend: number };
};

export type PricingSettings = {
  /** Never suggest less than the market fare + the premium. */
  marketFloorOn: boolean;
  /** How far above the market fare the floor sits, in naira per trip. */
  premiumNgn: number;
  /** inDrive's fare outside rush hours, and in them (weekdays 07–10 and 16–20, Lagos time). */
  quiet: MarketFormula;
  rush: MarketFormula;
  trafficOn: boolean;
  demandOn: boolean;
  /** Off: the model's number is only recorded beside each quote (shadow). On: it may lift the fare. */
  modelOn: boolean;
  model: PricingModel | null;
  /** The rules and the model may lift a fare to at most this many times the floor. */
  liftCap: number;
  /**
   * With the model on, the most it may take off today's price for a trip, in
   * naira. (Never more than a tenth of the fare either, so a short trip is
   * not cut by as much as a long one.)
   */
  maxDiscountNgn: number;
  /**
   * With the model on, the least a price may sit above the other app's fare:
   * a cut stops here. It is also the most a rider may then bargain away, so
   * an offer never goes under the other app.
   */
  modelPremiumNgn: number;
  /**
   * How far under the suggested fare a rider may offer, in naira: the
   * minimum offer is the suggested fare less this (never under the minimum
   * fare). 0 goes back to the older rule: a tenth off, and with the floor on
   * no more than the premium.
   */
  minOfferGapNgn: number;
  /** What a completed ride is worth to Wheelers beyond what it earns on it: the higher, the readier the model is to cut. */
  rideValueNgn: number;
  /**
   * With the model on, the share of trips shown a price OTHER than the
   * model's pick: one of the other prices inside the same limits. Without
   * these the model only ever sees what happens at its own prices and can
   * never learn whether another would have done better. 0 switches it off.
   */
  trialShare: number;
};

/** A cut is never more than this share of the fare. */
const MODEL_MAX_DISCOUNT_SHARE = 0.1;

/**
 * With nothing saved, pricing is the plain rate per km. The figures for the
 * other app come from two real quotes (15.5 km in 23 min on a clear road,
 * ₦5,800; 16 km in 33 min, ₦7,200), which is thin: they are meant to be
 * replaced with regularly sampled ones. The pricing model was trained with
 * these (ml/pricing/world.py).
 */
export const DEFAULT_PRICING_SETTINGS: PricingSettings = {
  marketFloorOn: false,
  premiumNgn: 300,
  quiet: { baseNgn: 500, perKmNgn: 268, perMinuteNgn: 50 },
  rush: { baseNgn: 575, perKmNgn: 308, perMinuteNgn: 58 },
  trafficOn: false,
  demandOn: false,
  modelOn: false,
  model: null,
  liftCap: 1.5,
  maxDiscountNgn: 700,
  modelPremiumNgn: 150,
  minOfferGapNgn: 850,
  rideValueNgn: 500,
  trialShare: 0.1,
};

let pricingSettings: PricingSettings = DEFAULT_PRICING_SETTINGS;

export function getPricingSettings(): PricingSettings {
  return pricingSettings;
}

const finite = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function formulaFrom(value: unknown, fallback: MarketFormula): MarketFormula {
  const v = (value ?? {}) as Partial<MarketFormula>;
  return {
    baseNgn: finite(v.baseNgn, fallback.baseNgn, 0, 20_000),
    perKmNgn: finite(v.perKmNgn, fallback.perKmNgn, 0, 5_000),
    perMinuteNgn: finite(v.perMinuteNgn, fallback.perMinuteNgn, 0, 1_000),
  };
}

function modelFrom(value: unknown): PricingModel | null {
  const v = value as PricingModel | null | undefined;
  if (!v || typeof v !== 'object' || !Number.isFinite(v.intercept) || !v.coef) return null;
  const c = v.coef as Record<string, unknown>;
  return {
    trainedAt: String(v.trainedAt ?? ''),
    rows: finite(v.rows, 0, 0, 1e9),
    seeded: v.seeded === true,
    intercept: Number(v.intercept),
    coef: {
      lnKm: finite(c.lnKm, 0, -5, 5), minPerKm: finite(c.minPerKm, 0, -5, 5), lnDemand: finite(c.lnDemand, 0, -5, 5),
      rush: finite(c.rush, 0, -5, 5), night: finite(c.night, 0, -5, 5), weekend: finite(c.weekend, 0, -5, 5),
    },
  };
}

/** Whatever was saved, made safe to price with: every number in range, anything missing at its default. */
export function normalizePricingSettings(value: unknown): PricingSettings {
  const v = (value ?? {}) as Partial<PricingSettings>;
  const d = DEFAULT_PRICING_SETTINGS;
  return {
    marketFloorOn: v.marketFloorOn === true,
    premiumNgn: finite(v.premiumNgn, d.premiumNgn, 0, 5_000),
    quiet: formulaFrom(v.quiet, d.quiet),
    rush: formulaFrom(v.rush, d.rush),
    trafficOn: v.trafficOn === true,
    demandOn: v.demandOn === true,
    modelOn: v.modelOn === true,
    model: modelFrom(v.model),
    liftCap: finite(v.liftCap, d.liftCap, 1, 3),
    maxDiscountNgn: finite(v.maxDiscountNgn, d.maxDiscountNgn, 0, 3_000),
    modelPremiumNgn: finite(v.modelPremiumNgn, d.modelPremiumNgn, 0, 5_000),
    minOfferGapNgn: finite(v.minOfferGapNgn, d.minOfferGapNgn, 0, 5_000),
    rideValueNgn: finite(v.rideValueNgn, d.rideValueNgn, 0, 10_000),
    trialShare: finite(v.trialShare, d.trialShare, 0, 0.5),
  };
}

/** The trained tree model can set prices: there is one in this build and an owner has switched the model on. */
function mlPricingOn(): boolean {
  return pricingSettings.modelOn && pricingSettings.marketFloorOn && getPricingMlModel() !== null;
}

/** Each service calls this with what the database holds (and again whenever it changes). */
export function setPricingSettings(value: unknown): PricingSettings {
  pricingSettings = normalizePricingSettings(value);
  return pricingSettings;
}

/** Lagos is UTC+1 all year. */
function lagosClock(at: Date): { hour: number; weekend: boolean } {
  const local = new Date(at.getTime() + 60 * 60 * 1000);
  const day = local.getUTCDay();
  return { hour: local.getUTCHours(), weekend: day === 0 || day === 6 };
}

/** Weekdays 07:00–10:00 and 16:00–20:00, Lagos time. */
export function isRushHour(at: Date = new Date()): boolean {
  const { hour, weekend } = lagosClock(at);
  return !weekend && ((hour >= 7 && hour < 10) || (hour >= 16 && hour < 20));
}

/** With no trip time to hand (a fare rebuilt from distance alone), a Lagos road is taken at 24 km/h. */
const ASSUMED_MINUTES_PER_KM = 2.5;

/** What the other app would charge for this trip now, as far as its sampled figures say. */
export function marketFareNgn(distanceKm: number, durationSeconds: number | undefined, at: Date = new Date()): number {
  const f = isRushHour(at) ? pricingSettings.rush : pricingSettings.quiet;
  const minutes = durationSeconds !== undefined && Number.isFinite(durationSeconds) && durationSeconds > 0
    ? durationSeconds / 60
    : distanceKm * ASSUMED_MINUTES_PER_KM;
  return round2(f.baseNgn + f.perKmNgn * distanceKm + f.perMinuteNgn * minutes);
}

/** The model's rate per km for a trip, or null when there is no model (or the trip has no length). */
export function modelRatePerKmNgn(distanceKm: number, factors: RateFactors = {}): number | null {
  const model = pricingSettings.model;
  if (!model || !(distanceKm > 0)) return null;
  const at = factors.at ?? new Date();
  const { hour, weekend } = lagosClock(at);
  const minutes = factors.durationSeconds && factors.durationSeconds > 0 ? factors.durationSeconds / 60 : distanceKm * ASSUMED_MINUTES_PER_KM;
  const demand = demandFactorOf(factors);
  const ln = model.intercept
    + model.coef.lnKm * Math.log(distanceKm)
    + model.coef.minPerKm * (minutes / distanceKm)
    + model.coef.lnDemand * Math.log(demand)
    + model.coef.rush * (isRushHour(at) ? 1 : 0)
    + model.coef.night * (hour >= 22 || hour < 5 ? 1 : 0)
    + model.coef.weekend * (weekend ? 1 : 0);
  const rate = Math.exp(ln);
  // A model can be wrong; it is never allowed to be absurd.
  return Number.isFinite(rate) ? Math.round(Math.min(3 * RATE_PER_KM_NGN, Math.max(0.5 * RATE_PER_KM_NGN, rate))) : null;
}

/** Share of the rate that pays for distance; the rest pays for the driver's time and grows with traffic. */
const TRAFFIC_DISTANCE_SHARE = 0.6;
const TRAFFIC_FACTOR_MAX = 2.6;
const DEMAND_SENSITIVITY = 0.3;
const DEMAND_FACTOR_MAX = 1.8;
/** What riders usually pay elsewhere, per km; the recommended rate stays within sight of it. Review monthly. */
export const MARKET_RATE_PER_KM_NGN = 300;
const MARKET_CAP = 1.5;

export type RateFactors = {
  /** Travel time now ÷ travel time on an empty road, for this route (Google gives both). 1 = no traffic. */
  trafficRatio?: number;
  /** Requests ÷ drivers online in the pickup area, against the usual for that hour. 1 = normal. */
  demandRatio?: number;
  /**
   * The demand multiplier already worked out for the pickup area (1 to 1.8),
   * moved in small steps by the gateway's busyness job. Used in place of demandRatio.
   */
  demandFactor?: number;
  /** The trip's travel time (Google's, live when traffic is on): the other app charges by the minute. */
  durationSeconds?: number;
  /** When the quote is for. Now, unless a test says otherwise. */
  at?: Date;
  /**
   * Names this trip for a while (its two ends and the half hour): whether it
   * is shown a trial price, and which, is decided from this alone, so asking
   * again for the same trip gives the same answer. Without it no trial price is shown.
   */
  trialKey?: string;
};

/** D: the demand multiplier for a trip, 1 when the switch is off or the area is not busy. */
function demandFactorOf(factors: RateFactors): number {
  if (!demandFactorOn()) return 1;
  if (factors.demandFactor !== undefined && Number.isFinite(factors.demandFactor)) {
    return Math.min(DEMAND_FACTOR_MAX, Math.max(1, factors.demandFactor));
  }
  const demand = factors.demandRatio;
  return demand !== undefined && Number.isFinite(demand) && demand > 1
    ? Math.min(1 + DEMAND_SENSITIVITY * Math.log(demand), DEMAND_FACTOR_MAX)
    : 1;
}

/** The demand multiplier a requests-to-drivers ratio comes to (1 = normal), whatever the switch says. */
export function demandFactorForRatio(ratio: number): number {
  return Number.isFinite(ratio) && ratio > 1 ? Math.min(1 + DEMAND_SENSITIVITY * Math.log(ratio), DEMAND_FACTOR_MAX) : 1;
}

/**
 * The recommended rate per km for a trip. Flat ₦375 unless a factor is
 * switched on:
 *   traffic  T = 0.6 + 0.4 × (time now ÷ time on an empty road), at most 2.6:
 *            only the time part of a driver's cost grows, so a road three
 *            times slower costs 80% more, not 200%.
 *   demand   D = 1 + 0.3 × ln(demand), never below 1 (a quiet hour, the
 *            night included, is never a discount) and at most 1.8.
 * The cap rises with traffic (1.5 × the market rate on a clear road), so a
 * slow road is still priced for; an unexplained jump is not.
 */
export function recommendedRatePerKmNgn(factors: RateFactors = {}): number {
  const ratio = factors.trafficRatio;
  const T = trafficFactorOn() && ratio !== undefined && Number.isFinite(ratio) && ratio > 1
    ? Math.min(TRAFFIC_DISTANCE_SHARE + (1 - TRAFFIC_DISTANCE_SHARE) * ratio, TRAFFIC_FACTOR_MAX)
    : 1;
  const D = demandFactorOf(factors);
  const cap = Math.max(RATE_PER_KM_NGN, MARKET_CAP * MARKET_RATE_PER_KM_NGN * (1 + 0.5 * (T - 1)));
  return Math.round(Math.min(RATE_PER_KM_NGN * T * D, cap));
}

export type SuggestedFare = {
  distanceKm: number;
  suggestedFareNgn: number;
  minOfferNgn: number;
  maxOfferNgn: number;
  /** The suggested fare as the driver's rate per km. */
  ratePerKmNgn: number;
  /** What set the fare. "trial": a price near the model's, shown on a small share of trips so there is something to learn from. */
  setBy: 'floor' | 'rules' | 'model' | 'trial';
  /** The other app's fare for this trip, and the floor it gives (that + the premium). Null with the floor off. */
  marketFareNgn: number | null;
  floorFareNgn: number | null;
  /** The base rate lifted by traffic and a busy area, as a fare. */
  rulesFareNgn: number;
  /** The model's fare. Recorded even when the model is not allowed to set the price. Null with no model. */
  modelFareNgn: number | null;
};

export type RidePriceBreakdown = {
  distanceKm: number;
  suggestedFareNgn: number;
  minOfferNgn: number;
  ratePerKmNgn: number;
};

// ── Fare ↔ trip fare ↔ rate per km ─────────────────────────────────────────

/** The fare a rider pays for a trip fare: + VAT + booking fee, rounded up to ₦50, never under the minimum fare. */
export function fareFromTripFareNgn(tripFareNgn: number): number {
  const raw = Math.max(0, tripFareNgn) * (1 + VAT_RATE) + BOOKING_FEE_NGN;
  return Math.max(MIN_FARE_NGN, roundUpToIncrement(round2(raw), FARE_ROUNDING_INCREMENT));
}

/** The fare a rider pays when the driver's rate is `ratePerKmNgn` over `distanceKm`. */
export function fareFromRatePerKmNgn(ratePerKmNgn: number, distanceKm: number): number {
  return fareFromTripFareNgn(round2(ratePerKmNgn * distanceKm));
}

/**
 * The trip fare inside a fare: what the driver's rate, commission and VAT are
 * worked from. (Version 1: the fare after the booking fee, the driver's share.)
 */
export function tripFareNgn(fareNgn: number, version: PricingVersion = CURRENT_PRICING_VERSION): number {
  const afterFee = Math.max(0, round2(fareNgn - bookingFeeOf(version)));
  return version === 1 ? afterFee : round2(afterFee / (1 + VAT_RATE));
}

/** Old name: the driver's part of a fare before commission. */
export function driverShareNgn(fareNgn: number, version: PricingVersion = CURRENT_PRICING_VERSION): number {
  return tripFareNgn(fareNgn, version);
}

/**
 * What a fare is worth to the driver per km: the trip fare over the trip's
 * distance, to one decimal. It moves with the price: every rider price,
 * counter and bid has its own. Null when the distance is unknown.
 */
export function driverRatePerKmNgn(
  fareNgn: number,
  distanceKm: number | null | undefined,
  version: PricingVersion = CURRENT_PRICING_VERSION,
): number | null {
  if (distanceKm === null || distanceKm === undefined || !Number.isFinite(distanceKm) || distanceKm <= 0) return null;
  return Math.round((tripFareNgn(fareNgn, version) / distanceKm) * 10) / 10;
}

// ── The suggested fare and the limits on offers ───────────────────────────

export function calculateSuggestedFare(distanceKm: number, factors: RateFactors = {}): SuggestedFare {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) {
    throw new TypeError('distanceKm must be a finite number >= 0');
  }

  const settings = pricingSettings;
  const rulesFareNgn = fareFromRatePerKmNgn(recommendedRatePerKmNgn(factors), distanceKm);
  const modelRate = modelRatePerKmNgn(distanceKm, factors);
  const modelFareNgn = modelRate === null ? null : fareFromRatePerKmNgn(modelRate, distanceKm);

  // The floor: what the other app charges for this trip, plus the premium.
  // Nothing is ever suggested below it.
  const marketFare = settings.marketFloorOn && distanceKm > 0
    ? marketFareNgn(distanceKm, factors.durationSeconds, factors.at)
    : null;
  const floorFareNgn = marketFare === null
    ? null
    : Math.max(MIN_FARE_NGN, roundUpToIncrement(marketFare + settings.premiumNgn, FARE_ROUNDING_INCREMENT));

  // The rules and the model may only lift it, and only so far: at most
  // liftCap × the floor (or × our own plain rate, where that is the higher).
  const plainFareNgn = fareFromRatePerKmNgn(RATE_PER_KM_NGN, distanceKm);
  const liftLimit = floorFareNgn === null
    ? Infinity
    : roundUpToIncrement(Math.max(floorFareNgn, plainFareNgn) * settings.liftCap, FARE_ROUNDING_INCREMENT);
  let suggestedFareNgn = floorFareNgn ?? rulesFareNgn;
  let setBy: SuggestedFare['setBy'] = floorFareNgn === null ? 'rules' : 'floor';
  const rules = Math.min(rulesFareNgn, liftLimit);
  if (rules > suggestedFareNgn) { suggestedFareNgn = rules; setBy = 'rules'; }

  // The trained model, when this build has one and the floor is on (it reads
  // a price against the other app's). It looks at prices a little either
  // side of today's: at most maxDiscountNgn and a tenth of the fare away,
  // never closer to the other app than modelPremiumNgn and never past the
  // lift limit, and names the one worth most. Its price is always recorded;
  // it is only SHOWN once an owner has switched the model on.
  const ml = getPricingMlModel();
  let modelFare = modelFareNgn;
  if (ml && distanceKm > 0 && floorFareNgn !== null && marketFare !== null) {
    const at = factors.at ?? new Date();
    const { hour, weekend } = lagosClock(at);
    const minutes = factors.durationSeconds !== undefined && Number.isFinite(factors.durationSeconds) && factors.durationSeconds > 0
      ? factors.durationSeconds / 60
      : distanceKm * ASSUMED_MINUTES_PER_KM;
    const marketEstNgn = marketFare;
    const base = suggestedFareNgn;
    const cut = Math.min(settings.maxDiscountNgn, MODEL_MAX_DISCOUNT_SHARE * base);
    const least = roundUpToIncrement(marketEstNgn + settings.modelPremiumNgn, FARE_ROUNDING_INCREMENT);
    const range = {
      lowestNgn: Math.min(base, Math.max(least, base - cut, MIN_FARE_NGN)),
      baseNgn: base,
      highestNgn: Math.max(base, Math.min(liftLimit, base + cut)),
    };
    const choice = chooseFare(
      ml,
      { km: distanceKm, minutes, hour, weekend, rush: isRushHour(at), demand: demandFactorOf(factors), marketEstNgn },
      range,
      { serviceChargeNgn: BOOKING_FEE_NGN, commissionRate: COMMISSION_RATE, vatRate: VAT_RATE, rideValueNgn: settings.rideValueNgn },
    );
    modelFare = Math.max(MIN_FARE_NGN, choice.fareNgn);
    if (settings.modelOn && modelFare !== suggestedFareNgn) { suggestedFareNgn = modelFare; setBy = 'model'; }
    // A small share of trips are shown one of the OTHER prices in the same
    // range, so the model can later learn what a different price would have
    // done. Decided from the trip's own key: the same trip, asked again, gets the same price.
    if (settings.modelOn && settings.trialShare > 0 && factors.trialKey && steadyDraw(factors.trialKey) < settings.trialShare) {
      // Only prices between the lowest allowed and today's: a trial never costs a rider more than they would have paid without the model.
      const others = [...new Set(candidateFares(ml, range))].filter((fare) => fare >= MIN_FARE_NGN && fare <= base && fare !== modelFare);
      if (others.length > 0) {
        suggestedFareNgn = others[Math.floor(steadyDraw(`${factors.trialKey}#which`) * others.length)]!;
        setBy = 'trial';
      }
    }
  } else if (settings.modelOn && modelFareNgn !== null) {
    // No trained model in this build: the small fitted one may lift a fare, never lower it.
    const model = Math.min(modelFareNgn, liftLimit);
    if (model > suggestedFareNgn) { suggestedFareNgn = model; setBy = 'model'; }
  }
  const limits = offerLimitsNgn(suggestedFareNgn);

  return {
    distanceKm,
    suggestedFareNgn,
    minOfferNgn: limits.minOfferNgn,
    maxOfferNgn: limits.maxOfferNgn,
    ratePerKmNgn: distanceKm > 0 ? Math.round(tripFareNgn(suggestedFareNgn) / distanceKm) : recommendedRatePerKmNgn(factors),
    setBy,
    marketFareNgn: marketFare,
    floorFareNgn,
    rulesFareNgn,
    modelFareNgn: modelFare,
  };
}

/**
 * The limits on a trip, from its suggested fare: a rider may offer no less
 * than the fare at 90% of the recommended rate, and a driver may ask no more
 * than the fare at 150% of it. Worked from the suggested fare's own trip fare,
 * so they move with it (traffic included) and need no distance.
 *
 * With the market floor on, a rider may also bargain away no more than the
 * premium: the suggested fare is never under the other app's fare + the
 * premium, so an offer of the suggested fare − the premium is never under
 * the other app's fare.
 */
export function offerLimitsNgn(suggestedFareNgn: number): { minOfferNgn: number; maxOfferNgn: number } {
  const recommendedTripFare = tripFareNgn(suggestedFareNgn);
  // The minimum sits a set amount under the suggested fare (₦850 unless
  // changed), so a rider always sees the same room to bargain whatever the
  // trip costs. It never goes under the minimum fare, nor above the suggested
  // fare on a trip that is already at the minimum.
  if (pricingSettings.minOfferGapNgn > 0) {
    const byGap = roundUpToIncrement(suggestedFareNgn - pricingSettings.minOfferGapNgn, FARE_ROUNDING_INCREMENT);
    return {
      minOfferNgn: Math.min(Math.max(byGap, MIN_FARE_NGN), Math.max(suggestedFareNgn, MIN_FARE_NGN)),
      maxOfferNgn: fareFromTripFareNgn(recommendedTripFare * MAX_COUNTER_SHARE),
    };
  }
  const byShare = fareFromTripFareNgn(recommendedTripFare * MIN_OFFER_SHARE);
  // With the trained model on, a price may already be as close to the other
  // app as modelPremiumNgn, so that is all a rider may then bargain away.
  const room = mlPricingOn() ? Math.min(pricingSettings.premiumNgn, pricingSettings.modelPremiumNgn) : pricingSettings.premiumNgn;
  const byPremium = pricingSettings.marketFloorOn
    ? roundUpToIncrement(suggestedFareNgn - room, FARE_ROUNDING_INCREMENT)
    : 0;
  return {
    minOfferNgn: Math.min(Math.max(byShare, byPremium, MIN_FARE_NGN), Math.max(suggestedFareNgn, MIN_FARE_NGN)),
    maxOfferNgn: fareFromTripFareNgn(recommendedTripFare * MAX_COUNTER_SHARE),
  };
}

/** The same limits as rates per km, for the driver's "your rate" box. Null when the distance is unknown. */
export function rateLimitsPerKmNgn(
  suggestedFareNgn: number,
  distanceKm: number | null | undefined,
): { minRateNgn: number; maxRateNgn: number } | null {
  if (distanceKm === null || distanceKm === undefined || !Number.isFinite(distanceKm) || distanceKm <= 0) return null;
  const recommendedRate = tripFareNgn(suggestedFareNgn) / distanceKm;
  return {
    minRateNgn: Math.ceil(recommendedRate * MIN_OFFER_SHARE),
    maxRateNgn: Math.floor(recommendedRate * MAX_COUNTER_SHARE),
  };
}

export function validateRiderOffer(
  offerNgn: number,
  suggestedFareNgn: number,
): { valid: boolean; minOfferNgn: number; reason?: string } {
  const { minOfferNgn } = offerLimitsNgn(suggestedFareNgn);

  if (!Number.isFinite(offerNgn) || offerNgn <= 0) {
    return { valid: false, minOfferNgn, reason: 'Offer must be a positive number.' };
  }

  if (offerNgn < minOfferNgn) {
    return {
      valid: false,
      minOfferNgn,
      // On short trips the floor is what binds, not the share: say so.
      reason:
        minOfferNgn === MIN_FARE_NGN
          ? `Minimum fare is ${MIN_FARE_NGN} NGN for any ride.`
          : `The lowest offer for this trip is ${minOfferNgn.toLocaleString('en-NG')} NGN.`,
    };
  }

  return { valid: true, minOfferNgn };
}

/**
 * The highest fare a driver may ask on a trip of this distance at the base
 * rate (old callers that only know the distance). Infinity when the distance
 * is unknown: an unknown trip length must not block a bid.
 */
export function resolveMaxOfferNgn(distanceKm: number | undefined): number {
  if (distanceKm === undefined || !Number.isFinite(distanceKm) || distanceKm <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return fareFromRatePerKmNgn(RATE_PER_KM_NGN * MAX_COUNTER_SHARE, distanceKm);
}

/** A bid this many times the rider's price is a typo, not an offer. */
export const DRIVER_BID_TYPO_MULTIPLE = 10;

/**
 * A driver's bid, as the fare the rider would pay. It may be anything up to
 * the fare at 150% of the recommended rate; and taking the rider's own price
 * is always allowed, however high (a rider may offer more than the ceiling).
 * Without a suggested fare to measure against (a group seat), only a typo is
 * refused.
 */
export function validateDriverOffer(
  offerNgn: number,
  riderOfferNgn: number,
  suggestedFareNgn?: number,
): { valid: boolean; minOfferNgn: number; maxOfferNgn: number; reason?: string } {
  const typoCeiling = Math.max(MIN_FARE_NGN, Math.round(riderOfferNgn) * DRIVER_BID_TYPO_MULTIPLE);
  const maxOfferNgn = suggestedFareNgn && suggestedFareNgn > 0
    ? Math.min(typoCeiling, Math.max(offerLimitsNgn(suggestedFareNgn).maxOfferNgn, Math.round(riderOfferNgn)))
    : typoCeiling;
  if (!Number.isFinite(offerNgn) || offerNgn <= 0 || Math.round(offerNgn) !== offerNgn) {
    return { valid: false, minOfferNgn: 1, maxOfferNgn, reason: 'Bid must be a whole amount in naira.' };
  }
  if (offerNgn > maxOfferNgn) {
    return {
      valid: false,
      minOfferNgn: 1,
      maxOfferNgn,
      reason: `That is above the highest price for this trip (${maxOfferNgn.toLocaleString('en-NG')} NGN). Lower your rate and send it again.`,
    };
  }
  return { valid: true, minOfferNgn: 1, maxOfferNgn };
}

// ── Taking a fare apart ───────────────────────────────────────────────────

export type RideFeeBreakdown = {
  /** What the rider pays. */
  fareNgn: number;
  /** Wheelers' flat booking fee. */
  bookingFeeNgn: number;
  /** The trip fare: the driver's rate × distance. (Version 1: the fare after the booking fee.) */
  driverShareNgn: number;
  /** Same figure under its new name. */
  tripFareNgn: number;
  /** 10% of the trip fare, from the driver. (Version 1: 4%.) */
  commissionNgn: number;
  /** 7.5% of the trip fare, paid by the rider inside the fare. (Version 1: taken from the driver.) */
  vatNgn: number;
  stateLevyNgn: number;
  /** Everything that is not the driver's: booking fee + commission + VAT + levy. */
  platformTotalNgn: number;
  driverPayoutNgn: number;
  /** What the rider pays: the fare, nothing on top. */
  totalNgn: number;
  pricingVersion: PricingVersion;
  /** Old names: the commission, and the booking fee. */
  platformFeeNgn: number;
  serviceFeeNgn: number;
};

/**
 * fareNgn = the agreed fare: what the rider pays. Version 2 (now): the
 * booking fee comes off; the rest is trip fare + its 7.5% VAT; the driver is
 * paid the trip fare less 10% commission and the ₦30 levy. Version 1 (rides
 * requested before 2026-10-10): booking fee off, then 4% commission, 7.5% VAT
 * and the levy all from the driver's share.
 */
export function calculateRideFees(fareNgn: number, version: PricingVersion = CURRENT_PRICING_VERSION): RideFeeBreakdown {
  const fare = round2(fareNgn);
  const bookingFeeNgn = Math.min(bookingFeeOf(version), Math.max(0, fare));
  const afterFee = round2(fare - bookingFeeNgn);

  let share: number;
  let commissionNgn: number;
  let vatNgn: number;
  let stateLevyNgn = LAGOS_STATE_FEE_NGN;
  /** What the driver's own deductions come out of. */
  let driverBase: number;
  /** The deductions that are the driver's, in the order they shrink on a fare too small to carry them. */
  let driverLines: number;

  if (version === 1) {
    share = afterFee;
    commissionNgn = round2(share * V1_COMMISSION_RATE);
    vatNgn = round2(share * VAT_RATE);
    driverBase = share;
    driverLines = round2(commissionNgn + vatNgn + stateLevyNgn);
  } else {
    share = round2(afterFee / (1 + VAT_RATE));
    vatNgn = round2(afterFee - share); // the two always add up to what is left after the booking fee
    commissionNgn = round2(share * COMMISSION_RATE);
    driverBase = share;
    driverLines = round2(commissionNgn + stateLevyNgn);
  }

  // A fare too small to carry every line (a ride settled short) must never
  // make the driver pay to work: the levy, then the commission, then (in
  // version 1) VAT shrink until the lines fit and the payout is zero.
  let over = round2(driverLines - driverBase);
  if (over > 0) { const cut = Math.min(stateLevyNgn, over); stateLevyNgn = round2(stateLevyNgn - cut); over = round2(over - cut); }
  if (over > 0) { const cut = Math.min(commissionNgn, over); commissionNgn = round2(commissionNgn - cut); over = round2(over - cut); }
  if (over > 0 && version === 1) { const cut = Math.min(vatNgn, over); vatNgn = round2(vatNgn - cut); }

  const driverPayoutNgn = version === 1
    ? Math.max(0, round2(share - commissionNgn - vatNgn - stateLevyNgn))
    : Math.max(0, round2(share - commissionNgn - stateLevyNgn));
  const platformTotalNgn = round2(fare - driverPayoutNgn);
  return {
    fareNgn: fare,
    bookingFeeNgn,
    driverShareNgn: share,
    tripFareNgn: share,
    commissionNgn,
    vatNgn,
    stateLevyNgn,
    platformTotalNgn,
    driverPayoutNgn,
    totalNgn: fare,
    pricingVersion: version,
    platformFeeNgn: commissionNgn,
    serviceFeeNgn: bookingFeeNgn,
  };
}

/**
 * The platform's total on a ride, split into the three lines it is made of.
 * The state levy comes first (it is owed to Lagos), then the flat service fee,
 * and the commission is what remains. On a fare too small to carry the flat
 * fees, where the total is capped at the fare, the commission shrinks first
 * and the three always add up to it.
 */
export function splitPlatformTotal(
  platformTotalNgn: number,
  // Only rides from before the split was stored need this, and they paid the ₦375 booking fee.
  rates: { serviceFeeNgn: number; stateLevyNgn: number } = { serviceFeeNgn: V1_BOOKING_FEE_NGN, stateLevyNgn: LAGOS_STATE_FEE_NGN },
): { commissionNgn: number; serviceFeeNgn: number; stateLevyNgn: number } {
  const total = Math.max(0, round2(platformTotalNgn));
  const stateLevyNgn = Math.min(rates.stateLevyNgn, total);
  const serviceFeeNgn = Math.min(rates.serviceFeeNgn, round2(total - stateLevyNgn));
  const commissionNgn = round2(total - stateLevyNgn - serviceFeeNgn);
  return { commissionNgn, serviceFeeNgn, stateLevyNgn };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundUpToIncrement(value: number, increment: number): number {
  return Math.ceil(value / increment) * increment;
}
