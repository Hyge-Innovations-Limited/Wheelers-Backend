import { lagosClock } from '@wheleers/config';
import { pricingClient } from '@wheleers/db';

/**
 * Each night at 03:00 Lagos time, with the hour curve switched on, the price
 * by the clock is learned again from the last four weeks of prices (inDrive
 * samples, agreed fares, drivers' bids) and saved; every service picks it up
 * within a minute. Each hour moves at most 15% a night.
 */
const HOUR = 3;

/** Learn and save tonight's curve, unless it is not time yet or it was done today. Exported for the test. */
export async function learnTonight(now = new Date()): Promise<boolean> {
  if (lagosClock(now).hour !== HOUR) return false;
  const { settings } = await pricingClient.loadSettings();
  if (!settings.hourCurveOn) return false;
  const today = new Date(now.getTime() + 60 * 60_000).toISOString().slice(0, 10);
  const last = settings.hourCurveFittedAt ? new Date(new Date(settings.hourCurveFittedAt).getTime() + 60 * 60_000).toISOString().slice(0, 10) : null;
  if (last === today) return false;
  const fit = await pricingClient.learnHourCurve(settings, now);
  await pricingClient.saveSettings({ ...settings, hourCurve: fit.curve, hourCurveFittedAt: now.toISOString() }, 'nightly curve');
  console.info('[pricing] hour curve learned', { used: fit.used });
  return true;
}

export function startHourCurveJob(shouldRun: () => Promise<boolean>, everyMs = 10 * 60_000): () => void {
  const timer = setInterval(() => {
    void (async () => {
      if (!(await shouldRun().catch(() => false))) return;
      await learnTonight().catch((error) => console.warn('[pricing] hour curve not learned', { error: error instanceof Error ? error.message : String(error) }));
    })();
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
