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
  OFFER_TTL_SECONDS: 1800,

  // How long the whole search runs before it gives up. Thirty minutes since
  // 2026-09-25: the rider is not sitting on it any more — the search lives in
  // the offers form, which they open when they like, and nothing is sent to
  // the chat when it ends. The form says "no driver took ₦X" and offers
  // Search again / Change my price right there. (90 s before that, when every
  // end of a search was a chat message the rider had to wait for.)
  BID_TIMEOUT_SECONDS: 1800,

  // Maximum number of drivers to attempt before cancelling the ride
  // with a "no drivers available" reason.
  MAX_MATCH_ATTEMPTS: 5,

  // How long after RIDE_COMPLETED the rider has to submit a rating.
  RATING_WINDOW_HOURS: 24,

  // Maximum surge multiplier on fare estimates during high demand.
  MAX_SURGE_MULTIPLIER: 3.0,
} as const;
