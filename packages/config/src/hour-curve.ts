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
 * and it rests, so three evening prices cannot lift every evening. A weekday
 * hour rests at the baseline, what the rush and quiet figures charge. A
 * weekend hour rests at tonight's weekday value for the same hour: without
 * weekend prices, a Saturday is never taken to be cheaper than a weekday. It
 * needs MIN_PRICES_FOR_A_WEEKEND_HOUR, fewer, since four weeks hold only eight
 * weekend days. Never under HOUR_CURVE_MIN (−10%: a cheaper hour may come
 * down), nor over hourCurveMax: +15% on a weekday, +60% on a weekend.
 *
 * Every weekend hour, not only the ones prices were taken at: from
 * MIN_PRICES_FOR_A_WEEKEND_LIFT weekend prices at any hours, one weekend lift
 * is learned (how far weekend prices sit from the weekday curve at their
 * hours), and each weekend hour without its own prices rests at its weekday
 * value times that lift, moving at most maxStep a fit like a learned hour.
 * Two prices at 11:00 then lift Saturday 15:00 and 21:00 too.
 *
 * Nights the same way: from MIN_PRICES_FOR_A_LIFT weekday prices taken
 * 22:00–05:00, one night lift for every night hour without its own prices
 * (they start at NIGHT_START). Weekend nights carry both.
 *
 * Rain is kept apart: a price seen in the rain says what rain costs, not what
 * that hour costs, so it never moves the curve. From MIN_PRICES_FOR_A_LIFT of
 * them, rainLift is learned: how far rain prices sit above the curve at their
 * hours (pricing.ts applies it while it rains).
 */
import { HOUR_CURVE_MIN, RAIN_LIFT_MAX, hourCurveMax, isNightHour, lagosClock, type HourCurve } from './pricing';

export type CurveEvidenceKind = 'sample' | 'agreed' | 'bid';

export type CurveEvidence = {
  at: Date;
  /** The price ÷ the other app's quiet-hour figures for the same trip. */
  ratio: number;
  weight: number;
  kind: CurveEvidenceKind;
  /** It was raining then (weather.ts): kept out of the curve, used for the rain lift. */
  rain?: boolean;
};

export type HourCurveFit = {
  curve: HourCurve;
  /** Weekend prices against the weekday curve at their hours (1.16 = weekends 16% dearer); null with too few weekend prices. */
  weekendLift: number | null;
  /** Weekday night prices against where night hours start; null with too few. */
  nightLift: number | null;
  /** Prices seen in the rain against the curve at their hours; null with too few. */
  rainLift: number | null;
  /** How many prices each lift was learned from (weekend and night: dry ones only). */
  liftPrices: { weekend: number; night: number; rain: number };
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
/** The same for a weekend hour: about one price per weekend day in that part of the day, over four weeks. */
export const MIN_PRICES_FOR_A_WEEKEND_HOUR = 4;
/** Prices, at any of their hours, before one lift is learned for all of them (weekend, night, rain). */
export const MIN_PRICES_FOR_A_LIFT = 3;
/** The old name. */
export const MIN_PRICES_FOR_A_WEEKEND_LIFT = MIN_PRICES_FOR_A_LIFT;

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

const clamp = (n: number, weekend: boolean, hour: number) => Math.min(hourCurveMax(weekend, hour), Math.max(HOUR_CURVE_MIN, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

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
  const all = evidence
    .filter((e) => Number.isFinite(e.ratio) && e.ratio >= WILD_LOW && e.ratio <= WILD_HIGH && e.weight > 0 && e.at <= now)
    .map((e) => {
      used[e.kind] += 1;
      const { hour, weekend } = lagosClock(e.at);
      const ageDays = (now.getTime() - e.at.getTime()) / 86_400_000;
      return { hour, weekend, rain: e.rain === true, log: Math.log(e.ratio), weight: e.weight * 0.5 ** (ageDays / HALF_LIFE_DAYS) };
    });
  // Dry prices shape the hours; rain ones only the rain lift.
  const points = all.filter((p) => !p.rain);
  /** One lift from a set of prices: the weighted middle of how far each sits from `expected` at its hour. */
  const liftOf = (set: typeof all, expected: (p: (typeof all)[number]) => number) =>
    set.length >= MIN_PRICES_FOR_A_LIFT
      ? round2(Math.exp(weightedMedian(set.map((p) => ({ value: p.log - Math.log(expected(p)), weight: p.weight })))))
      : null;

  const step = (from: number, to: number) => Math.max(from - Math.log(1 + maxStep), Math.min(from + Math.log(1 + maxStep), to));

  /** `steadyRest`: hours at rest that move toward `resting` at most maxStep a fit, as a learned one does (those set by a lift). */
  const fitDay = (weekend: boolean, resting: number[], steadyRest: (hour: number) => boolean = () => false) => {
    const before = weekend ? previous.weekend : previous.weekday;
    const enough = weekend ? MIN_PRICES_FOR_A_WEEKEND_HOUR : MIN_PRICES_FOR_AN_HOUR;
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
      if (count < enough) {
        // Not enough to say this hour differs: back to where it rests, not wherever three prices pushed it.
        const rest = clamp(resting[hour] ?? 1, weekend, hour);
        const value = steadyRest(hour) ? clamp(Math.exp(step(Math.log(before[hour] ?? 1), Math.log(rest))), weekend, hour) : rest;
        curve.push(round2(value));
        continue;
      }
      const prior = Math.log(before[hour] ?? 1);
      const total = near.reduce((sum, p) => sum + p.weight, 0);
      const learned = total > 0 ? (total * weightedMedian(near) + PRIOR_WEIGHT * prior) / (total + PRIOR_WEIGHT) : prior;
      const stepped = step(prior, learned);
      curve.push(round2(clamp(Math.exp(stepped), weekend, hour)));
    }
    return { curve, counts };
  };

  // Weekday nights: how far night prices sit from where night hours start.
  const nightPoints = points.filter((p) => !p.weekend && isNightHour(p.hour));
  const nightLift = liftOf(nightPoints, (p) => baseline.weekday[p.hour] ?? 1);
  const weekdayRest = baseline.weekday.map((v, hour) => (nightLift !== null && isNightHour(hour) ? v * nightLift : v));
  const weekday = fitDay(false, weekdayRest, (hour) => nightLift !== null && isNightHour(hour));

  // Weekends and holidays: how far their prices, at whatever hours, sit from tonight's weekday curve at those hours.
  const weekendPoints = points.filter((p) => p.weekend);
  const weekendLift = liftOf(weekendPoints, (p) => weekday.curve[p.hour] ?? 1);
  // A weekend hour without its own prices rests where the same weekday hour is tonight, times the weekend lift.
  const weekend = weekendLift === null
    ? fitDay(true, weekday.curve)
    : fitDay(true, weekday.curve.map((v) => v * weekendLift), () => true);

  // Rain: how far prices seen in the rain sit above tonight's curve at their hours.
  const rainPoints = all.filter((p) => p.rain);
  const rainLift = liftOf(rainPoints, (p) => (p.weekend ? weekend.curve : weekday.curve)[p.hour] ?? 1);

  return {
    curve: { weekday: weekday.curve, weekend: weekend.curve },
    weekendLift,
    nightLift,
    rainLift: rainLift === null ? null : Math.min(RAIN_LIFT_MAX, Math.max(1, rainLift)),
    liftPrices: { weekend: weekendPoints.length, night: nightPoints.length, rain: rainPoints.length },
    counts: { weekday: weekday.counts, weekend: weekend.counts },
    used,
  };
}
