// The other app's figures (base + per km + per minute), fitted from prices
// read off it by hand. Used by `npm run pricing fit`.
//
// How much is fitted depends on how many prices there are for those hours,
// because three numbers cannot be told apart from two trips:
//
//   1 or 2 prices   only the per-km figure moves; base and per-minute stay as they are
//   3 to 5          per km and per minute are fitted; the base stays
//   6 or more       all three
//
// A fit that comes out absurd (a negative figure, or a minute dearer than a
// km) falls back to the step above it. Nothing here saves anything.

/** Least squares, no intercept: columns of X against y. Returns null when the trips are too alike to tell the columns apart. */
function solve(X, y) {
  const k = X[0].length;
  const A = Array.from({ length: k }, () => new Array(k + 1).fill(0));
  for (let r = 0; r < X.length; r++) for (let i = 0; i < k; i++) {
    A[i][k] += X[r][i] * y[r];
    for (let j = 0; j < k; j++) A[i][j] += X[r][i] * X[r][j];
  }
  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    if (Math.abs(A[col][col]) < 1e-6 * Math.max(1, Math.abs(A[0][0]))) return null;
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let c = col; c <= k; c++) A[r][c] -= f * A[col][c];
    }
  }
  return A.map((row, i) => row[k] / row[i]);
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const estimate = (f, s) => f.baseNgn + f.perKmNgn * s.km + f.perMinuteNgn * s.minutes;
export const typicalMiss = (f, samples) => (samples.length ? Math.round(median(samples.map((s) => Math.abs(estimate(f, s) - s.priceNgn)))) : null);
const sane = (f) => f.baseNgn >= 0 && f.baseNgn <= 3000 && f.perKmNgn >= 50 && f.perKmNgn <= 1500 && f.perMinuteNgn >= 0 && f.perMinuteNgn <= 200 && f.perMinuteNgn < f.perKmNgn;

/**
 * Figures for one set of hours. `samples`: [{ km, minutes, priceNgn }]. `current`: what is saved now.
 * Returns { figures, fitted: 'nothing' | 'per km' | 'per km and per minute' | 'all three', missBefore, missAfter }.
 */
export function fitMarket(samples, current) {
  const n = samples.length;
  if (n === 0) return { figures: current, fitted: 'nothing', missBefore: null, missAfter: null };
  const perKmOnly = () => ({
    ...current,
    perKmNgn: Math.round(median(samples.map((s) => (s.priceNgn - current.baseNgn - current.perMinuteNgn * s.minutes) / s.km))),
  });
  const kmAndMinute = () => {
    const w = solve(samples.map((s) => [s.km, s.minutes]), samples.map((s) => s.priceNgn - current.baseNgn));
    return w && { baseNgn: current.baseNgn, perKmNgn: Math.round(w[0]), perMinuteNgn: Math.round(w[1]) };
  };
  const allThree = () => {
    const w = solve(samples.map((s) => [1, s.km, s.minutes]), samples.map((s) => s.priceNgn));
    return w && { baseNgn: Math.round(w[0] / 10) * 10, perKmNgn: Math.round(w[1]), perMinuteNgn: Math.round(w[2]) };
  };
  const steps = [['all three', n >= 6 ? allThree : null], ['per km and per minute', n >= 3 ? kmAndMinute : null], ['per km', perKmOnly]];
  for (const [fitted, make] of steps) {
    const figures = make?.();
    if (figures && sane(figures)) return { figures, fitted, missBefore: typicalMiss(current, samples), missAfter: typicalMiss(figures, samples) };
  }
  return { figures: current, fitted: 'nothing', missBefore: typicalMiss(current, samples), missAfter: typicalMiss(current, samples) };
}
