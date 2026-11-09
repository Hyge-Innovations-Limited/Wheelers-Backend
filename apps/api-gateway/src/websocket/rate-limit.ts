/**
 * A token bucket for one socket: `perSecond` messages a second on average, and
 * up to `burst` at once after a quiet spell. A driver in a trip sends a
 * position every few seconds and a chat message now and then; nothing a real
 * app does comes near the default. It exists for the client that loops.
 */
export function createRateLimiter(perSecond: number, burst: number, now: () => number = Date.now) {
  let tokens = burst;
  let last = now();
  return {
    /** True if this message may go through. */
    take(): boolean {
      const t = now();
      tokens = Math.min(burst, tokens + ((t - last) / 1000) * perSecond);
      last = t;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}
