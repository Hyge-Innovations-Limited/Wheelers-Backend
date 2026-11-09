/**
 * Times every driver location ping (the live socket's driver:gps and the background POST /drivers/me/location)
 * for the Health page: how many a second, and how long each takes to store. The gateway points it at its
 * stats recorder at boot; before that (and in tests) it counts nothing.
 */
let sink: ((ms: number, failed: boolean) => void) | null = null;

export function setLocationSink(fn: ((ms: number, failed: boolean) => void) | null): void {
  sink = fn;
}

export async function meterLocation<T>(work: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    const out = await work();
    sink?.(Date.now() - startedAt, false);
    return out;
  } catch (error) {
    sink?.(Date.now() - startedAt, true);
    throw error;
  }
}
