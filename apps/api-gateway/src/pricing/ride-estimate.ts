import { calculateSuggestedFare, calculateRideFees, type SuggestedFare, type RideFeeBreakdown } from '@wheleers/config';

export const RIDE_PRICING_CURRENCY = 'NGN' as const;

export type RideEstimatePricingFields = {
  fareEstimateNgn: number | null;
  suggestedFareNgn: number | null;
  minOfferNgn: number | null;
  ratePerKmNgn: number | null;
  pricingCurrency: typeof RIDE_PRICING_CURRENCY | null;
  pricingBreakdown: SuggestedFare | null;
  fees: RideFeeBreakdown | null;
};

export function buildRideEstimatePricing(
  distanceKm: number | null | undefined,
  /** The trip's planned time: the fare has a per-minute part, so pass it wherever it is known. */
  durationSeconds?: number | null,
  /** The trip's ends, wherever known: a pickup or drop-off in an outer area (Ikorodu, Epe…) lifts the price. */
  ends: { origin?: { lat: number; lng: number }; destination?: { lat: number; lng: number } } = {},
): RideEstimatePricingFields {
  if (distanceKm === null || distanceKm === undefined || !Number.isFinite(distanceKm)) {
    return {
      fareEstimateNgn: null,
      suggestedFareNgn: null,
      minOfferNgn: null,
      ratePerKmNgn: null,
      pricingCurrency: null,
      pricingBreakdown: null,
      fees: null,
    };
  }

  const pricing = calculateSuggestedFare(distanceKm, { durationSeconds: durationSeconds ?? undefined, ...ends });
  const fees = calculateRideFees(pricing.suggestedFareNgn);

  return {
    fareEstimateNgn: pricing.suggestedFareNgn,
    suggestedFareNgn: pricing.suggestedFareNgn,
    minOfferNgn: pricing.minOfferNgn,
    ratePerKmNgn: pricing.ratePerKmNgn,
    pricingCurrency: RIDE_PRICING_CURRENCY,
    pricingBreakdown: pricing,
    fees,
  };
}
