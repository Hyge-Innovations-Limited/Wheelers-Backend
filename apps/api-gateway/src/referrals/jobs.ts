import { referralClient } from '@wheleers/db';

const DEFAULT_REFERRAL_JOB_INTERVAL_MS = 5 * 60 * 1000;

export interface ReferralJobsHandle {
  shutdown: () => void;
}

function parseIntervalMs(): number {
  const raw = process.env['REFERRAL_JOBS_INTERVAL_MS'];
  if (!raw) return DEFAULT_REFERRAL_JOB_INTERVAL_MS;

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 30_000
    ? parsed
    : DEFAULT_REFERRAL_JOB_INTERVAL_MS;
}

export function startReferralJobs(shouldRun?: () => Promise<boolean>): ReferralJobsHandle {
  let running = false;
  let stopped = false;
  const intervalMs = parseIntervalMs();

  const run = async () => {
    if (running || stopped) return;
    running = true;

    try {
      // With more than one gateway process, one of them settles; the rest skip.
      if (shouldRun && !(await shouldRun())) return;
      const now = new Date();
      const frozen = await referralClient.freezeExpiredCashbacks(now);
      const qualified = await referralClient.settleQualifiedRideRewards(now);
      const expired = await referralClient.settleExpiredNoRideRewards(now);
      const closed = await referralClient.closeStaleReferrals(now);

      if (frozen > 0 || qualified > 0 || expired > 0 || closed > 0) {
        console.info('[referrals] jobs settled', {
          frozenCashbacks: frozen,
          qualifiedRideRewards: qualified,
          expiredNoRideRewards: expired,
          closedReferrals: closed,
        });
      }
    } catch (error) {
      console.warn('[referrals] jobs failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(() => void run(), intervalMs);

  return {
    shutdown: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
