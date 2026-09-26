export const RATE_PER_KM_NGN = 375;
/**
 * Ceiling on the per-km rate a driver may counter-offer. It doubles as the
 * surge ceiling: 500/375 = 1.33x is the most any fare can move above the
 * suggested price, by construction.
 */
export const MAX_RATE_PER_KM_NGN = 500;
export const PLATFORM_FEE_NGN = 0;
export const MIN_OFFER_DISCOUNT = 0.17;
/**
 * Hard floor on what any ride can cost, regardless of distance. Nothing —
 * neither the suggested fare nor the lowest offer a rider may haggle down to —
 * goes below this. Short trips would otherwise price under the flat fees
 * (₦375 service + ₦30 levy), leaving the driver nothing for their time.
 */
export const MIN_FARE_NGN = 2500;
export const FARE_ROUNDING_INCREMENT = 100;
/**
 * What comes off a fare before the driver is paid, since 2026-09-26:
 * a flat service fee, a 4% platform fee (shown to riders and drivers as
 * "Fees"), and the Lagos state levy. There is no separate VAT line.
 */
export const SERVICE_FEE_NGN = 375; // ₦375 flat per ride
export const PLATFORM_FEE_RATE = 0.04; // 4% of the fare — "Fees"
export const LAGOS_STATE_FEE_NGN = 30; // ₦30 flat per ride

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

export function calculateSuggestedFare(distanceKm: number): SuggestedFare {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) {
    throw new TypeError('distanceKm must be a finite number >= 0');
  }

  const rawFare = RATE_PER_KM_NGN * distanceKm + PLATFORM_FEE_NGN;
  const suggestedFareNgn = Math.max(
    MIN_FARE_NGN,
    roundUpToIncrement(rawFare, FARE_ROUNDING_INCREMENT),
  );
  const minOfferNgn = resolveMinOfferNgn(suggestedFareNgn);

  return {
    distanceKm,
    suggestedFareNgn,
    minOfferNgn,
    maxOfferNgn: resolveMaxOfferNgn(distanceKm),
    ratePerKmNgn: RATE_PER_KM_NGN,
  };
}

export function validateRiderOffer(
  offerNgn: number,
  suggestedFareNgn: number,
): { valid: boolean; minOfferNgn: number; reason?: string } {
  const minOfferNgn = resolveMinOfferNgn(suggestedFareNgn);

  if (!Number.isFinite(offerNgn) || offerNgn <= 0) {
    return { valid: false, minOfferNgn, reason: 'Offer must be a positive number.' };
  }

  if (offerNgn < minOfferNgn) {
    return {
      valid: false,
      minOfferNgn,
      // On short trips the floor is what binds, not the discount — say so,
      // otherwise "28% of suggested fare" reads as wrong to the rider.
      reason:
        minOfferNgn === MIN_FARE_NGN
          ? `Minimum fare is ${MIN_FARE_NGN} NGN for any ride.`
          : `Minimum offer is ${minOfferNgn} NGN (${Math.round((1 - MIN_OFFER_DISCOUNT) * 100)}% of suggested fare).`,
    };
  }

  return { valid: true, minOfferNgn };
}

/**
 * Lowest offer we accept: the haggling discount, but never below the floor.
 * Rounded UP to the fare increment so riders see ₦3,200, not ₦3,154.
 */
function resolveMinOfferNgn(suggestedFareNgn: number): number {
  return Math.max(
    MIN_FARE_NGN,
    roundUpToIncrement(suggestedFareNgn * (1 - MIN_OFFER_DISCOUNT), FARE_ROUNDING_INCREMENT),
  );
}

/**
 * Highest offer we accept on a trip: MAX_RATE_PER_KM_NGN per km, never below
 * the minimum fare — on a 3 km hop ₦500/km is ₦1,500, which would sit UNDER
 * the ₦2,500 floor and make the ride unbookable.
 *
 * Distance is not always resolvable (a group seat, a ride row without a
 * planned distance). Callers get Infinity there: an unknown trip length must
 * not block a bid, exactly as an unresolvable fare does not.
 */
export function resolveMaxOfferNgn(distanceKm: number | undefined): number {
  if (distanceKm === undefined || !Number.isFinite(distanceKm) || distanceKm <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(
    MIN_FARE_NGN,
    roundUpToIncrement(MAX_RATE_PER_KM_NGN * distanceKm, FARE_ROUNDING_INCREMENT),
  );
}

/** A bid this many times the rider's price is a typo, not an offer. */
export const DRIVER_BID_TYPO_MULTIPLE = 10;

/**
 * A driver's bid has no band. Below the rider's price, at it, or above it — the
 * rider decides, and a rider who offers more than the suggested fare must be
 * acceptable at that price (the old ₦500/km ceiling refused exactly that). The
 * only refusals: not a positive whole amount, or so far above the rider's price
 * that it can only be a typo.
 */
export function validateDriverOffer(
  offerNgn: number,
  riderOfferNgn: number,
): { valid: boolean; minOfferNgn: number; maxOfferNgn: number; reason?: string } {
  const maxOfferNgn = Math.max(MIN_FARE_NGN, Math.round(riderOfferNgn) * DRIVER_BID_TYPO_MULTIPLE);
  if (!Number.isFinite(offerNgn) || offerNgn <= 0 || Math.round(offerNgn) !== offerNgn) {
    return { valid: false, minOfferNgn: 1, maxOfferNgn, reason: 'Bid must be a whole amount in naira.' };
  }
  if (offerNgn > maxOfferNgn) {
    return {
      valid: false,
      minOfferNgn: 1,
      maxOfferNgn,
      reason: `That looks like a typo — the rider offered ${Math.round(riderOfferNgn).toLocaleString('en-NG')} NGN. Bids above ${maxOfferNgn.toLocaleString('en-NG')} NGN are not sent.`,
    };
  }
  return { valid: true, minOfferNgn: 1, maxOfferNgn };
}

export type RideFeeBreakdown = {
  fareNgn: number;
  /** 4% of the fare — the line called "Fees". */
  platformFeeNgn: number;
  stateLevyNgn: number;
  serviceFeeNgn: number;
  /** Everything that is not the driver's: fees + levy + service fee. */
  platformTotalNgn: number;
  driverPayoutNgn: number;
  totalNgn: number;
};

/**
 * fareNgn = the agreed fare (rider's offer / negotiated price).
 * Rider pays exactly fareNgn (totalNgn = fareNgn).
 * The 4% fee, the state levy and the service fee are deducted from the fare.
 * Driver receives fareNgn minus all deductions.
 * Driver sees the full breakdown so they know to bid accordingly.
 * Platform receives fees + state levy + service fee.
 */
export function calculateRideFees(fareNgn: number): RideFeeBreakdown {
  const stateLevyNgn = LAGOS_STATE_FEE_NGN;
  const platformFeeNgn = round2(fareNgn * PLATFORM_FEE_RATE);
  const serviceFeeNgn = SERVICE_FEE_NGN;
  const rawPlatformTotalNgn = round2(platformFeeNgn + stateLevyNgn + serviceFeeNgn);
  const rawDriverPayoutNgn = round2(fareNgn - rawPlatformTotalNgn);

  // The flat fees (₦375 service + ₦30 levy) exceed the fare on very short
  // rides, which used to produce a NEGATIVE driver payout — the driver's own
  // balance was debited to cover the platform's cut. Clamp the payout at zero
  // and cap the platform's take at the fare, so the rider's debit always
  // equals driverPayout + platformTotal and nobody pays to work.
  const driverPayoutNgn = Math.max(0, rawDriverPayoutNgn);
  const platformTotalNgn =
    rawDriverPayoutNgn < 0 ? round2(fareNgn) : rawPlatformTotalNgn;

  const totalNgn = fareNgn;
  return { fareNgn, platformFeeNgn, stateLevyNgn, serviceFeeNgn, platformTotalNgn, driverPayoutNgn, totalNgn };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundUpToIncrement(value: number, increment: number): number {
  return Math.ceil(value / increment) * increment;
}
