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
  OFFER_TTL_SECONDS: 90,

  // How long the whole search runs before the rider is told nobody took it.
  // Tried at 180 s on 2026-09-22 and pulled back the next day: too long for a
  // rider to sit on. The cases that pushed it up are handled elsewhere now —
  // a rider paying for a chosen driver is never timed out, and the driver app
  // refuses a bid under the floor before it is sent.
  BID_TIMEOUT_SECONDS: 90,

  // Maximum number of drivers to attempt before cancelling the ride
  // with a "no drivers available" reason.
  MAX_MATCH_ATTEMPTS: 5,

  // How long after RIDE_COMPLETED the rider has to submit a rating.
  RATING_WINDOW_HOURS: 24,

  // Maximum surge multiplier on fare estimates during high demand.
  MAX_SURGE_MULTIPLIER: 3.0,
} as const;
