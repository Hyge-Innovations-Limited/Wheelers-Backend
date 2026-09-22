export const RIDE = {
  // Default search radius when looking for nearby drivers.
  DEFAULT_MATCH_RADIUS_KM: 5,

  // How long a driver has to accept a ride request before ride-service
  // tries the next nearest driver.
  DRIVER_ACCEPT_TIMEOUT_SECONDS: 15,

  // The offer card and the auction are ONE clock, deliberately equal: a
  // driver's card lives exactly as long as the rider's search. They used to
  // differ (150s card / 180s auction), which left drivers staring at an
  // empty feed during a live auction. If you change one, change both.
  OFFER_TTL_SECONDS: 180,

  // How long the whole search runs before the rider is told nobody took it.
  // 90 s was tuned for a rider watching a chat; the rider now opens a form,
  // reads the offers and taps — and a driver who first bid under the floor
  // needs time to bid again. Both were losing rides at 90 s (2026-09-22).
  BID_TIMEOUT_SECONDS: 180,

  // Maximum number of drivers to attempt before cancelling the ride
  // with a "no drivers available" reason.
  MAX_MATCH_ATTEMPTS: 5,

  // How long after RIDE_COMPLETED the rider has to submit a rating.
  RATING_WINDOW_HOURS: 24,

  // Maximum surge multiplier on fare estimates during high demand.
  MAX_SURGE_MULTIPLIER: 3.0,
} as const;
