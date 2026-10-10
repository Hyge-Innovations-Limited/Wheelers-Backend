/**
 * Wheelers pricing, version 2 (since 2026-10-10).
 *
 * A fare is what the RIDER pays: one number, shown to them with no lines.
 * It is built from the driver's rate per km:
 *
 *   trip fare      = rate per km × distance            ₦350 × 10 km = ₦3,500
 *   + VAT 7.5% of the trip fare                                      ₦262.50
 *   + booking fee (Wheelers')                                        ₦375
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
 */
export type PricingVersion = 1 | 2;
export const CURRENT_PRICING_VERSION: PricingVersion = 2;

/** The recommended rate per km on a free road. */
export const RATE_PER_KM_NGN = 375;
/** A rider may offer no less than this share of the recommended rate; a driver may ask no more than MAX_COUNTER_SHARE of it. */
export const MIN_OFFER_SHARE = 0.9;
export const MAX_COUNTER_SHARE = 1.35;
/** Old name for the driver ceiling as a rate: 135% of the base rate. */
export const MAX_RATE_PER_KM_NGN = Math.round(RATE_PER_KM_NGN * MAX_COUNTER_SHARE);
/** Wheelers' flat booking fee, in every fare, charged to the rider. */
export const BOOKING_FEE_NGN = 375;
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
/** PRICING_TRAFFIC_FACTOR=on: the recommended rate rises on slow roads. */
export const trafficFactorOn = () => flag('PRICING_TRAFFIC_FACTOR');
/** PRICING_DEMAND_FACTOR=on: the recommended rate follows demand in the area. */
export const demandFactorOn = () => flag('PRICING_DEMAND_FACTOR');

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
};

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
  const demand = factors.demandRatio;
  const D = demandFactorOn() && demand !== undefined && Number.isFinite(demand) && demand > 1
    ? Math.min(1 + DEMAND_SENSITIVITY * Math.log(demand), DEMAND_FACTOR_MAX)
    : 1;
  const cap = Math.max(RATE_PER_KM_NGN, MARKET_CAP * MARKET_RATE_PER_KM_NGN * (1 + 0.5 * (T - 1)));
  return Math.round(Math.min(RATE_PER_KM_NGN * T * D, cap));
}

export type SuggestedFare = {
  distanceKm: number;
  suggestedFareNgn: number;
  minOfferNgn: number;
  maxOfferNgn: number;
  ratePerKmNgn: number;
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
  const afterFee = Math.max(0, round2(fareNgn - BOOKING_FEE_NGN));
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

  const ratePerKmNgn = recommendedRatePerKmNgn(factors);
  const suggestedFareNgn = fareFromRatePerKmNgn(ratePerKmNgn, distanceKm);
  const limits = offerLimitsNgn(suggestedFareNgn);

  return {
    distanceKm,
    suggestedFareNgn,
    minOfferNgn: limits.minOfferNgn,
    maxOfferNgn: limits.maxOfferNgn,
    ratePerKmNgn,
  };
}

/**
 * The limits on a trip, from its suggested fare: a rider may offer no less
 * than the fare at 90% of the recommended rate, and a driver may ask no more
 * than the fare at 135% of it. Worked from the suggested fare's own trip fare,
 * so they move with it (traffic included) and need no distance.
 */
export function offerLimitsNgn(suggestedFareNgn: number): { minOfferNgn: number; maxOfferNgn: number } {
  const recommendedTripFare = tripFareNgn(suggestedFareNgn);
  return {
    minOfferNgn: fareFromTripFareNgn(recommendedTripFare * MIN_OFFER_SHARE),
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
 * the fare at 135% of the recommended rate; and taking the rider's own price
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
  const bookingFeeNgn = Math.min(BOOKING_FEE_NGN, Math.max(0, fare));
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
  rates: { serviceFeeNgn: number; stateLevyNgn: number } = { serviceFeeNgn: SERVICE_FEE_NGN, stateLevyNgn: LAGOS_STATE_FEE_NGN },
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
