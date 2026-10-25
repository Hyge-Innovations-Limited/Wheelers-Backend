// Env validators — each service imports and calls its own
export { loadWorkspaceEnv }         from './load-workspace-env';
export { validateSharedEnv }       from './env/shared.env';
export { validateGatewayEnv, resolvePublicBaseUrl, PUBLIC_BASE_URL_DEFAULT }      from './env/gateway.env';
export { validateRideEnv }         from './env/ride.env';
export { validatePaymentEnv }      from './env/payment.env';
export { validateNotificationEnv } from './env/notification.env';
export { validateGroupRideEnv }    from './env/group-ride.env';
export { validateWhatsappEnv }     from './env/whatsapp.env';
export { validateMcpEnv }          from './env/mcp.env';

// Env types
export type { SharedEnv }       from './env/shared.env';
export type { GatewayEnv }      from './env/gateway.env';
export type { RideEnv }         from './env/ride.env';
export type { PaymentEnv }      from './env/payment.env';
export type { NotificationEnv } from './env/notification.env';
export type { GroupRideEnv }    from './env/group-ride.env';
export type { WhatsappEnv }     from './env/whatsapp.env';
export type { McpEnv }          from './env/mcp.env';

// Outer areas priced higher (pickup / drop-off factors in the pricing settings)
export { PRICING_AREAS, pricingAreaOf } from './pricing-areas';
export type { PricingArea, PricingAreaKey } from './pricing-areas';

// Where rides are taken: Lagos State
export { SERVICE_AREA_NAME, OUTSIDE_SERVICE_AREA_LINE, LAGOS_OUTLINE, isInLagos, isInServiceArea, firstOutsideServiceArea } from './service-area';

// Launch zones (analytics)
export { LAUNCH_ZONES, OUTSIDE_ZONES_LABEL, zoneFor } from './zones';
export { DRIVER_PAPERS, DRIVER_PAPER_NEEDS, DRIVER_PAPER_SOON_DAYS, driverPaper } from './driver-papers';
export type { DriverPaper, DriverPaperNeed, DriverPaperType } from './driver-papers';
export type { LaunchZone } from './zones';

// Constants
export { FEES }                        from './constants/fees';
export { MIN_WITHDRAWAL_NGN, MIN_WITHDRAWAL_REQUEST_NGN, WITHDRAWAL_FEE_NGN, withdrawalBreakdown } from './constants/withdrawal';
export type { WithdrawalBreakdown } from './constants/withdrawal';
export {
  DEPOSIT_FEE_NGN,
  DEPOSIT_FEE_NOTICE,
  DEPOSIT_PROVIDER_FEE_PAID_BY,
  depositNeededFor,
  estimateDepositProviderFee,
  splitDeposit,
  type DepositSplit,
} from './constants/deposit';
export { GPS }                         from './constants/gps';
export { RIDE }                        from './constants/ride';
export {
  RATE_PER_KM_NGN,
  MAX_RATE_PER_KM_NGN,
  PLATFORM_FEE_NGN,
  MIN_OFFER_DISCOUNT,
  MIN_FARE_NGN,
  FARE_ROUNDING_INCREMENT,
  PLATFORM_FEE_RATE,
  LAGOS_STATE_FEE_NGN,
  SERVICE_FEE_NGN,
  BOOKING_FEE_NGN,
  COMMISSION_RATE,
  VAT_RATE,
  calculateSuggestedFare,
  areaFactorOf,
  AREA_FACTOR_MAX,
  resolveMaxOfferNgn,
  validateRiderOffer,
  validateDriverOffer,
  calculateRideFees, splitPlatformTotal, driverShareNgn, driverRatePerKmNgn,
  CURRENT_PRICING_VERSION, pricingVersionOf, WHATSAPP_FEE_NGN, MIN_OFFER_SHARE, MAX_COUNTER_SHARE, MARKET_RATE_PER_KM_NGN,
  fareFromRatePerKmNgn, fareFromTripFareNgn, tripFareNgn, offerLimitsNgn, rateLimitsPerKmNgn,
  recommendedRatePerKmNgn, trafficFactorOn, demandFactorOn,
  getPricingSettings, setPricingSettings, normalizePricingSettings, DEFAULT_PRICING_SETTINGS,
  marketFareNgn, modelRatePerKmNgn, isRushHour, demandFactorForRatio,
  dayPeriodOf, premiumAt, premiumFor, DAY_PERIODS, PERIOD_PREMIUM_MAX_NGN,
  lagosClock, curveDay, curveValueAt, isNightHour, NIGHT_START, rainFactorOf, marketHighFrom, MARKET_HIGH_MAX, MARKET_HIGH_MIN_PRICES, RAIN_START, RAIN_LIFT_MAX, COMBINED_LIFT_MAX, quietMarketFareNgn, seedHourCurve, hourFactorAt, surgeFactorOf, HOUR_CURVE_MIN, HOUR_CURVE_MAX, WEEKEND_HOUR_CURVE_MAX, hourCurveMax, SURGE_MAX_LIMIT, SURGE_MIN_LIMIT,
} from './pricing';
export { easterSunday, holidaysFor, holidayOn, upcomingHolidays } from './calendar';
export type { Holiday } from './calendar';
export { fitHourCurve, MIN_PRICES_FOR_AN_HOUR, MIN_PRICES_FOR_A_WEEKEND_HOUR, MIN_PRICES_FOR_A_WEEKEND_LIFT, MIN_PRICES_FOR_A_LIFT } from './hour-curve';
export type { CurveEvidence, CurveEvidenceKind, HourCurveFit } from './hour-curve';
export { getPricingMlModel, setPricingMlModel, scoreForest, rideChance, chooseFare, candidateFares, steadyDraw } from './pricing-ml';
export type { PricingMlModel, MlTrip, FareChoice } from './pricing-ml';
export type { SuggestedFare, RidePriceBreakdown, RideFeeBreakdown, PricingVersion, RateFactors, PricingSettings, PricingModel, MarketFormula, AreaFactors, DayPeriod, PremiumRange, TripPremium, HourCurve, DayKind, Rain } from './pricing';
export {
  GoogleMapsRoutePlanner,
  RoutePlanningError,
  estimateRideFareNgn,
} from './routing';
export type {
  PlannedRouteGeometry,
  PlannedRouteMetrics,
  RouteBounds,
  RouteWaypoint,
} from './routing';
export { formatTripId, parseTripId, TRIP_ID_PREFIX } from './trip-id';
