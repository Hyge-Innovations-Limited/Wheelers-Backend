/**
 * Learning the price by the clock: for each hour of a weekday and of a
 * weekend day, what trips really cost against the other app's quiet-hour
 * figures. Every price we have is evidence:
 *
 *   sample   a price read off the other app ......................... weight 3
 *   agreed   a ride's agreed fare, against the price it was shown:
 *            moved by the bargaining (a driver's counter, a lower
 *            offer taken) ............................................... 1
 *            taken as shown, which only says the price was about right ... 0.5
 *   bid      the lowest a driver asked on a ride nobody agreed ........ 0.5
 *
 * Each is a ratio: price ÷ the quiet-hour figures for that trip. An hour's
 * multiplier is the weighted middle of the ratios at that hour (its
 * neighbours count a little, the other kind of day a little less), newer
 * prices counting more, pulled toward the multiplier it has now while there
 * are few, and moved at most maxStep in one fit so a night's odd prices
 * cannot swing it.
 *
 * An hour moves only on enough of its own evidence: fewer than
 * MIN_PRICES_FOR_AN_HOUR prices within an hour of it (on that kind of day),
 * and it stays at the baseline, what the rush and quiet figures charge, so
 * three evening prices cannot lift every evening. Never under HOUR_CURVE_MIN
 * (−10%: a cheaper hour may come down) nor over HOUR_CURVE_MAX (+15%).
 */
import { HOUR_CURVE_MAX, HOUR_CURVE_MIN, lagosClock, type HourCurve } from './pricing';

export type CurveEvidenceKind = 'sample' | 'agreed' | 'bid';

export type CurveEvidence = {
  at: Date;
  /** The price ÷ the other app's quiet-hour figures for the same trip. */
  ratio: number;
  weight: number;
  kind: CurveEvidenceKind;
};

export type HourCurveFit = {
  curve: HourCurve;
  /** Prices within an hour either side of each hour, before weighting. */
  counts: HourCurve;
  used: Record<CurveEvidenceKind, number>;
};

/** A price this far off the figures is a typo or a different trip, not evidence. */
const WILD_LOW = 0.4;
const WILD_HIGH = 3;
/** A price this many days old counts half. */
const HALF_LIFE_DAYS = 7;
/** How much the multiplier an hour has now counts, in prices. */
const PRIOR_WEIGHT = 3;
/** How an hour's neighbours count: the hour itself, one away, two away. */
const NEIGHBOUR = [1, 0.5, 0.15];
/** A weekday price counts this much toward a weekend hour, and the other way round. */
const OTHER_KIND_OF_DAY = 0.3;
/** Prices an hour needs within an hour either side, on its kind of day, before it moves off the baseline. */
export const MIN_PRICES_FOR_AN_HOUR = 8;

function weightedMedian(points: Array<{ value: number; weight: number }>): number {
  const sorted = [...points].sort((a, b) => a.value - b.value);
  const half = sorted.reduce((sum, p) => sum + p.weight, 0) / 2;
  let run = 0;
  for (const p of sorted) {
    run += p.weight;
    if (run >= half) return p.value;
  }
  return sorted[sorted.length - 1]!.value;
}

const clamp = (n: number) => Math.min(HOUR_CURVE_MAX, Math.max(HOUR_CURVE_MIN, n));

export function fitHourCurve(
  evidence: CurveEvidence[],
  previous: HourCurve,
  now: Date = new Date(),
  options: { maxStep?: number; baseline?: HourCurve } = {},
): HourCurveFit {
  // Where an hour sits with too little of its own evidence: the rush and quiet figures, or where it is now.
  const baseline = options.baseline ?? previous;
  const maxStep = options.maxStep ?? 0.15;
  const used: Record<CurveEvidenceKind, number> = { sample: 0, agreed: 0, bid: 0 };
  const points = evidence
    .filter((e) => Number.isFinite(e.ratio) && e.ratio >= WILD_LOW && e.ratio <= WILD_HIGH && e.weight > 0 && e.at <= now)
    .map((e) => {
      used[e.kind] += 1;
      const { hour, weekend } = lagosClock(e.at);
      const ageDays = (now.getTime() - e.at.getTime()) / 86_400_000;
      return { hour, weekend, log: Math.log(e.ratio), weight: e.weight * 0.5 ** (ageDays / HALF_LIFE_DAYS) };
    });

  const fitDay = (weekend: boolean) => {
    const before = weekend ? previous.weekend : previous.weekday;
    const resting = weekend ? baseline.weekend : baseline.weekday;
    const curve: number[] = [];
    const counts: number[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const near: Array<{ value: number; weight: number }> = [];
      let count = 0;
      for (const p of points) {
        const gap = Math.min(Math.abs(p.hour - hour), 24 - Math.abs(p.hour - hour));
        if (gap >= NEIGHBOUR.length) continue;
        if (gap <= 1 && p.weekend === weekend) count += 1;
        near.push({ value: p.log, weight: p.weight * NEIGHBOUR[gap]! * (p.weekend === weekend ? 1 : OTHER_KIND_OF_DAY) });
      }
      counts.push(count);
      if (count < MIN_PRICES_FOR_AN_HOUR) {
        // Not enough to say this hour differs: back to the baseline, not wherever three prices pushed it.
        curve.push(Math.round(clamp(resting[hour] ?? 1) * 100) / 100);
        continue;
      }
      const prior = Math.log(before[hour] ?? 1);
      const total = near.reduce((sum, p) => sum + p.weight, 0);
      const learned = total > 0 ? (total * weightedMedian(near) + PRIOR_WEIGHT * prior) / (total + PRIOR_WEIGHT) : prior;
      const stepped = Math.max(prior - Math.log(1 + maxStep), Math.min(prior + Math.log(1 + maxStep), learned));
      curve.push(Math.round(clamp(Math.exp(stepped)) * 100) / 100);
    }
    return { curve, counts };
  };

  const weekday = fitDay(false);
  const weekend = fitDay(true);
  return {
    curve: { weekday: weekday.curve, weekend: weekend.curve },
    counts: { weekday: weekday.counts, weekend: weekend.counts },
    used,
  };
}
