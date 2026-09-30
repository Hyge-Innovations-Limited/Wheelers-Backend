import { z } from 'zod';

const RideEnvSchema = z.object({
  // Radius in km to search for nearby drivers on RIDE_REQUESTED
  MATCH_RADIUS_KM:           z.string().default('5'),
  // How long to wait for a driver to accept before trying the next one (seconds)
  DRIVER_ACCEPT_TIMEOUT_S:   z.string().default('15'),
  // How many drivers each request is sent to, nearest first. It goes to EVERY
  // approved, online driver inside MATCH_RADIUS_KM; this is only a safety cap
  // (it used to be 5, so 15 of 20 drivers in an area never saw a request).
  MAX_MATCH_ATTEMPTS:        z.string().default('200'),
  SCHEDULED_RIDE_DISPATCH_INTERVAL_S: z.string().default('20'),
  SCHEDULED_RIDE_DISPATCH_LEAD_TIME_S: z.string().default('300'),
  // GPS stale detection — run every N seconds
  GPS_STALE_CHECK_INTERVAL_S: z.string().default('30'),
  GOOGLE_MAPS_API_KEY:  z.string().min(1),
  GOOGLE_MAPS_BASE_URL: z.string().url().default('https://routes.googleapis.com'),
});

export type RideEnv = z.infer<typeof RideEnvSchema>;

export function validateRideEnv(): RideEnv {
  const result = RideEnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('[config] ride-service env errors:\n', result.error.format());
    process.exit(1);
  }
  return result.data;
}
