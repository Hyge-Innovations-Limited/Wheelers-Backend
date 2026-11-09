import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The pricing model: four small gradient-boosted tree models trained offline
 * (ml/pricing/train.py) and written to packages/config/models/pricing-ml.json.
 * Scored here with a loop over arrays: no ML library, no model server.
 *
 * For a trip shown at a price, three of them say how likely it is that
 *   requested   the rider asks for the ride,
 *   answered    a driver takes it or counters,
 *   agreed      the two then agree,
 * and the fourth what share of the shown price ends up paid. Their product is
 * the chance a quote becomes a ride. chooseFare() tries a handful of prices
 * around today's and returns the one worth most.
 *
 * ml/pricing/train.py holds the same choice in Python (choose()); the two
 * must stay in step, and the rows in `checks` fail a test when they do not.
 */
type Tree = { f: number[]; t: number[]; l: number[]; r: number[]; v: number[] };
/**
 * `adjust` is the correction fitted on Wheelers' real quotes, when there are
 * enough: for a chance, sigmoid(a + b × trees + c × ln(price ÷ the other
 * app's price)); for an amount, a + b × trees. Without it the trees stand.
 */
type Forest = { kind: 'chance' | 'amount'; base: number; trees: Tree[]; adjust?: { a: number; b: number; c?: number } };

export type PricingMlModel = {
  version: number;
  trainedAt: string;
  /** "simulated" until it has learned from Wheelers' own quotes ("simulated+real"). */
  source: string;
  rows: number;
  /** Real quotes it has learned from. */
  realRows?: number;
  features: string[];
  choice: { stepsDown: number; stepsUp: number; nearBest: number };
  models: { requested: Forest; answered: Forest; agreed: Forest; paid: Forest };
  checks?: Array<{ x: number[]; requested: number; answered: number; agreed: number; paid: number }>;
};

/** The order train.py builds a row in. */
const FEATURES = ['km', 'minPerKm', 'hour', 'weekend', 'rush', 'night', 'demand', 'marketEst', 'fare', 'fareOverMarket'];
const FARE_OVER_MARKET = FEATURES.indexOf('fareOverMarket');

let model: PricingMlModel | null | undefined;

function usable(value: unknown): value is PricingMlModel {
  const m = value as PricingMlModel | null;
  return Boolean(
    m && m.version === 1 && Array.isArray(m.features) && m.features.join() === FEATURES.join()
      && m.models?.requested?.trees?.length && m.models.answered?.trees?.length && m.models.agreed?.trees?.length && m.models.paid?.trees?.length,
  );
}

/** The model shipped with this build, read once. Null when there is none (or it is not one this code can score). */
export function getPricingMlModel(): PricingMlModel | null {
  if (model !== undefined) return model;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(__dirname, '..', 'models', 'pricing-ml.json'), 'utf8'));
    model = usable(parsed) ? parsed : null;
    if (!model) console.warn('[pricing] the model file is not one this build can score; pricing carries on without it');
  } catch {
    model = null;
  }
  return model;
}

/** For tests: use this model (null for none, undefined to read the file again). */
export function setPricingMlModel(next: PricingMlModel | null | undefined): void {
  model = next === undefined || next === null || usable(next) ? next : null;
}

export function scoreForest(forest: Forest, x: number[]): number {
  let sum = forest.base;
  for (const tree of forest.trees) {
    let node = 0;
    // A leaf is marked by feature -1. The depth guard is for a damaged file, not a real tree.
    for (let depth = 0; depth < 64 && tree.f[node]! >= 0; depth++) {
      node = x[tree.f[node]!]! <= tree.t[node]! ? tree.l[node]! : tree.r[node]!;
    }
    sum += tree.v[node]!;
  }
  const adjust = forest.adjust;
  if (forest.kind === 'chance') {
    if (adjust) sum = adjust.a + adjust.b * sum + (adjust.c ?? 0) * Math.log(x[FARE_OVER_MARKET]!);
    return 1 / (1 + Math.exp(-sum));
  }
  return adjust ? adjust.a + adjust.b * sum : sum;
}

export type MlTrip = {
  km: number;
  minutes: number;
  /** Lagos clock. */
  hour: number;
  weekend: boolean;
  rush: boolean;
  /** The busyness multiplier for the pickup area, 1 to 1.8. */
  demand: number;
  /** What the other app is taken to charge for this trip. */
  marketEstNgn: number;
};

function row(trip: MlTrip, fareNgn: number): number[] {
  return [
    trip.km, trip.minutes / trip.km, trip.hour, trip.weekend ? 1 : 0, trip.rush ? 1 : 0, trip.hour >= 22 || trip.hour < 5 ? 1 : 0, trip.demand,
    trip.marketEstNgn, fareNgn, fareNgn / trip.marketEstNgn,
  ];
}

/** The chance a quote at this price becomes a ride, and the share of the price that would be paid. */
export function rideChance(m: PricingMlModel, trip: MlTrip, fareNgn: number): { chance: number; paidShare: number } {
  const x = row(trip, fareNgn);
  return {
    chance: scoreForest(m.models.requested, x) * scoreForest(m.models.answered, x) * scoreForest(m.models.agreed, x),
    paidShare: Math.min(1.3, Math.max(0.7, scoreForest(m.models.paid, x))),
  };
}

const ceil50 = (value: number) => Math.ceil(Math.round(value * 100) / 100 / 50) * 50;

/** The prices looked at for a trip: from the lowest allowed up to today's, then above it to the highest allowed, each rounded up to ₦50. */
export function candidateFares(m: PricingMlModel, range: { lowestNgn: number; baseNgn: number; highestNgn: number }): number[] {
  const base = range.baseNgn;
  const lo = Math.min(base, range.lowestNgn);
  const hi = Math.max(base, range.highestNgn);
  const { stepsDown, stepsUp } = m.choice;
  const fares: number[] = [];
  for (let i = 0; i < stepsDown; i++) fares.push(ceil50(lo + ((base - lo) * i) / (stepsDown - 1)));
  for (let i = 1; i <= stepsUp; i++) fares.push(ceil50(base + ((hi - base) * i) / stepsUp));
  return fares;
}

/** A number from 0 up to (not including) 1 that is always the same for the same text. */
export function steadyDraw(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // one more scramble, so texts that differ only at the end do not land side by side
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export type FareChoice = {
  fareNgn: number;
  /** The model's chance that a quote at this fare becomes a ride. */
  chance: number;
  /** The same at today's price, for comparison. */
  chanceAtBase: number;
};

/**
 * The price the model would show for a trip.
 *
 * It looks at `stepsDown` prices from `lowestNgn` up to today's price
 * (`baseNgn`) and `stepsUp` above it up to `highestNgn`, each rounded up to
 * ₦50, and values each as
 *
 *   chance it becomes a ride × (what Wheelers earns on it + what a ride is worth besides)
 *
 * Of the prices worth within 1.5% of the best it takes the dearest: a cut is
 * only as deep as it has to be.
 */
export function chooseFare(
  m: PricingMlModel,
  trip: MlTrip,
  range: { lowestNgn: number; baseNgn: number; highestNgn: number },
  money: { serviceChargeNgn: number; commissionRate: number; vatRate: number; rideValueNgn: number },
): FareChoice {
  const { stepsDown, nearBest } = m.choice;
  const fares = candidateFares(m, range);
  const base = range.baseNgn;

  let best = -Infinity;
  const valued = fares.map((fareNgn) => {
    const { chance, paidShare } = rideChance(m, trip, fareNgn);
    const tripFare = Math.max(0, fareNgn * paidShare - money.serviceChargeNgn) / (1 + money.vatRate);
    const worth = chance * (money.serviceChargeNgn + money.commissionRate * tripFare + money.rideValueNgn);
    if (worth > best) best = worth;
    return { fareNgn, chance, worth };
  });
  let pick: (typeof valued)[number] | null = null;
  for (const candidate of valued) {
    if (candidate.worth >= nearBest * best && (pick === null || candidate.fareNgn >= pick.fareNgn)) pick = candidate;
  }
  pick ??= valued[stepsDown - 1]!;   // today's price, should nothing have a value at all
  return { fareNgn: pick.fareNgn, chance: pick.chance, chanceAtBase: rideChance(m, trip, ceil50(base)).chance };
}
