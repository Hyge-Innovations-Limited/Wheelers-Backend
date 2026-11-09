import { walletClient } from '@wheleers/db';

/**
 * The last line for a rider's money: a hold still locked on a ride that was
 * cancelled a while ago is released. Every cancellation already releases its
 * hold when it happens; this catches the ones where that failed (an error
 * swallowed on the way, a service down at the time).
 */

/** Long enough that a rider paying for a driver after a search timed out has finished. */
export const STRANDED_AFTER_MS = 30 * 60_000;

/** One pass never runs away: at most this many batches of 50. */
const MAX_BATCHES = 20;

export async function sweepStrandedHolds(now = Date.now()): Promise<number> {
  let released = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const stranded = await walletClient.strandedRideHolds(new Date(now - STRANDED_AFTER_MS));
    if (stranded.length === 0) break;
    const before = released;
    released += await releaseEach(stranded);
    // Nothing released this round (every release failed): stop, try next pass.
    if (released === before) break;
  }
  return released;
}

async function releaseEach(stranded: Array<{ rideId: string; riderId: string; amountNgn: number }>): Promise<number> {
  let released = 0;
  for (const hold of stranded) {
    const result = await walletClient.cancelRideHold(hold.rideId).catch((error) => {
      console.error('[hold-sweeper] could not release a stranded hold', { rideId: hold.rideId, error: error instanceof Error ? error.message : String(error) });
      return null;
    });
    if (result) {
      released += 1;
      console.warn('[hold-sweeper] released a hold left on a cancelled ride', { rideId: hold.rideId, riderId: hold.riderId, amountNgn: hold.amountNgn });
    }
  }
  return released;
}

/** Every few minutes, on the one gateway process that runs jobs. */
export function startHoldSweeper(shouldRun: () => Promise<boolean>, everyMs = 5 * 60_000): () => void {
  const timer = setInterval(() => {
    void (async () => {
      if (!(await shouldRun().catch(() => false))) return;
      await sweepStrandedHolds().catch((error) => console.warn('[hold-sweeper] pass failed', { error: error instanceof Error ? error.message : String(error) }));
    })();
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
