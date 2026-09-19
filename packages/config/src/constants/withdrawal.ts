/**
 * Withdrawal limits and fees.
 *
 * There is no Wheelers minimum: a user may withdraw any amount they hold.
 * Paystack accepts transfers from ₦50 upward (checked against the live API),
 * so the floor below is only a guard against a zero or negative request.
 * Set WITHDRAWAL_MIN_NGN to raise it.
 */
function readNonNegative(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(`[config] ${name} is not a valid non-negative number, falling back to default`, {
      value: raw,
      fallback,
    });
    return fallback;
  }
  return parsed;
}

export const MIN_WITHDRAWAL_NGN = readNonNegative('WITHDRAWAL_MIN_NGN', 50);
