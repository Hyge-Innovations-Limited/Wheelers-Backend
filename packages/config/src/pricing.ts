export const RATE_PER_KM_NGN = 375;
/**
 * Ceiling on the per-km rate a driver may counter-offer. It doubles as the
 * surge ceiling: 500/375 = 1.33x is the most any fare can move above the
 * suggested price, by construction.
 */
export const MAX_RATE_PER_KM_NGN = 500;
/**
 * Wheelers' booking fee: flat, on every ride, since 2026-10-01. It is part of
 * the price — the suggested fare is the distance price PLUS this — and it is
 * Wheelers' before anything else: whatever the agreed fare, the first ₦375 is
 * the booking fee and the rest is the driver's share.
 */
export const BOOKING_FEE_NGN = 375;
/** The booking fee is the platform's part of a suggested fare. (Old name.) */
export const PLATFORM_FEE_NGN = BOOKING_FEE_NGN;
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
 * What comes off a fare before the driver is paid, since 2026-10-01:
 *
 *   fare ₦3,500
 *   − booking fee ₦375 (Wheelers')         = driver's share ₦3,125
 *   − commission 4% of the driver's share   ₦125
 *   − VAT 7.5% of the driver's share        ₦234.38
 *   − Lagos state levy                      ₦30
 *   = the driver is paid                    ₦2,735.62
 *
 * The driver's share is what they see per km (₦3,125 over 10 km = ₦312.5/km).
 */
export const SERVICE_FEE_NGN = BOOKING_FEE_NGN; // the booking fee's old name
export const COMMISSION_RATE = 0.04; // 4% of the driver's share — "Commission"
export const PLATFORM_FEE_RATE = COMMISSION_RATE; // old name
export const VAT_RATE = 0.075; // 7.5% of the driver's share
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

  // The distance price plus the booking fee, rounded UP to ₦100 for the rider.
  // (Drivers never see this rounding: they see their share per km, exactly.)
  const rawFare = RATE_PER_KM_NGN * distanceKm + BOOKING_FEE_NGN;
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
    roundUpToIncrement(MAX_RATE_PER_KM_NGN * distanceKm + BOOKING_FEE_NGN, FARE_ROUNDING_INCREMENT),
  );
}

/** The driver's share of a fare: everything after Wheelers' booking fee. */
export function driverShareNgn(fareNgn: number): number {
  return Math.max(0, round2(fareNgn - BOOKING_FEE_NGN));
}

/**
 * What a fare is worth to the driver per km — their share over the trip's
 * distance, to one decimal (₦3,500 over 10 km: ₦312.5/km). It moves with the
 * price: every rider price, counter and bid amount has its own. Null when the
 * distance is unknown.
 */
export function driverRatePerKmNgn(fareNgn: number, distanceKm: number | null | undefined): number | null {
  if (distanceKm === null || distanceKm === undefined || !Number.isFinite(distanceKm) || distanceKm <= 0) return null;
  return Math.round((driverShareNgn(fareNgn) / distanceKm) * 10) / 10;
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
  /** Wheelers' flat booking fee, taken first. */
  bookingFeeNgn: number;
  /** The fare after the booking fee: what the driver's per-km is worked from. */
  driverShareNgn: number;
  /** 4% of the driver's share. */
  commissionNgn: number;
  /** 7.5% of the driver's share. */
  vatNgn: number;
  stateLevyNgn: number;
  /** Everything that is not the driver's: booking fee + commission + VAT + levy. */
  platformTotalNgn: number;
  driverPayoutNgn: number;
  /** What the rider pays: the fare, nothing on top. */
  totalNgn: number;
  /** Old names, kept for readers not yet moved: the commission, and the booking fee. */
  platformFeeNgn: number;
  serviceFeeNgn: number;
};

/**
 * fareNgn = the agreed fare (rider's price / the bid they accepted). The rider
 * pays exactly that. The booking fee comes off first; commission and VAT are
 * percentages of what is left (the driver's share); then the Lagos levy. The
 * driver is paid the rest, and sees every line so they can bid accordingly.
 */
export function calculateRideFees(fareNgn: number): RideFeeBreakdown {
  const fare = round2(fareNgn);
  const bookingFeeNgn = Math.min(BOOKING_FEE_NGN, Math.max(0, fare));
  const share = round2(fare - bookingFeeNgn);
  let commissionNgn = round2(share * COMMISSION_RATE);
  let vatNgn = round2(share * VAT_RATE);
  let stateLevyNgn = LAGOS_STATE_FEE_NGN;

  // A fare too small to carry every line (below the minimum fare, which the
  // rules never allow, but a ride settled short can) must never make the driver
  // pay to work: the levy, then the commission, then VAT shrink until the lines
  // fit inside the share and the payout is zero.
  let over = round2(commissionNgn + vatNgn + stateLevyNgn - share);
  if (over > 0) { const cut = Math.min(stateLevyNgn, over); stateLevyNgn = round2(stateLevyNgn - cut); over = round2(over - cut); }
  if (over > 0) { const cut = Math.min(commissionNgn, over); commissionNgn = round2(commissionNgn - cut); over = round2(over - cut); }
  if (over > 0) { const cut = Math.min(vatNgn, over); vatNgn = round2(vatNgn - cut); }

  const driverPayoutNgn = Math.max(0, round2(share - commissionNgn - vatNgn - stateLevyNgn));
  const platformTotalNgn = round2(fare - driverPayoutNgn);
  return {
    fareNgn: fare,
    bookingFeeNgn,
    driverShareNgn: share,
    commissionNgn,
    vatNgn,
    stateLevyNgn,
    platformTotalNgn,
    driverPayoutNgn,
    totalNgn: fare,
    platformFeeNgn: commissionNgn,
    serviceFeeNgn: bookingFeeNgn,
  };
}

/**
 * The platform's total on a ride, split into the three lines it is made of.
 * The state levy comes first (it is owed to Lagos), then the flat service fee,
 * and the commission is what remains. On a normal fare that remainder is exactly
 * the 4%; on a fare too small to carry the flat fees, where the total is capped
 * at the fare, the commission shrinks first and the three always add up to it.
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
