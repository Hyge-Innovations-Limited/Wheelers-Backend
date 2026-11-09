import { lagosClock, type HourCurveFit, type PricingSettings } from '@wheleers/config';
import { pricingClient } from '@wheleers/db';

/**
 * Each night at 03:00 Lagos time, with the hour curve switched on, the price
 * by the clock is learned again from the last four weeks of prices (inDrive
 * samples, agreed fares, drivers' bids) and saved; every service picks it up
 * within a minute. Each hour moves at most 15% a night.
 */
const HOUR = 3;

/**
 * What a night's learning saves: the curve, the rain lift moved toward what
 * prices in the rain said, and the other app's high end moved toward what its
 * prices said, each at most 15% a night like the hours (each stays where it
 * is with too few prices).
 */
export function curveUpdate(settings: PricingSettings, fit: HourCurveFit & { marketHigh?: number | null }, now: Date): Partial<PricingSettings> {
  const toward = (from: number, to: number) => Math.round(Math.min(from * 1.15, Math.max(from / 1.15, to)) * 100) / 100;
  const rain = fit.rainLift === null
    ? {}
    : { rainLift: toward(settings.rainLift, fit.rainLift), rainLiftFittedAt: now.toISOString() };
  // The other app's high end: the same 15% a night; too few of its prices, and it stays where it is.
  const high = fit.marketHigh === null || fit.marketHigh === undefined
    ? {}
    : { marketHigh: toward(settings.marketHigh, fit.marketHigh), marketHighFittedAt: now.toISOString() };
  return { hourCurve: fit.curve, hourCurveFittedAt: now.toISOString(), ...rain, ...high };
}

/** Learn and save tonight's curve, unless it is not time yet or it was done today. Exported for the test. */
export async function learnTonight(now = new Date()): Promise<boolean> {
  if (lagosClock(now).hour !== HOUR) return false;
  const { settings } = await pricingClient.loadSettings();
  if (!settings.hourCurveOn) return false;
  const today = new Date(now.getTime() + 60 * 60_000).toISOString().slice(0, 10);
  const last = settings.hourCurveFittedAt ? new Date(new Date(settings.hourCurveFittedAt).getTime() + 60 * 60_000).toISOString().slice(0, 10) : null;
  if (last === today) return false;
  const fit = await pricingClient.learnHourCurve(settings, now);
  await pricingClient.saveSettings({ ...settings, ...curveUpdate(settings, fit, now) }, 'nightly curve');
  console.info('[pricing] hour curve learned', { used: fit.used, weekendLift: fit.weekendLift, nightLift: fit.nightLift, rainLift: fit.rainLift, marketHigh: fit.marketHigh, liftPrices: fit.liftPrices });
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
