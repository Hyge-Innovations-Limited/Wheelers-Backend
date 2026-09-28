/**
 * Withdrawal limits and fees.
 *
 * Wheelers takes a flat fee on every withdrawal, out of the amount: withdraw
 * ₦5,000 and the wallet falls by ₦5,000 while the bank receives ₦4,955. The fee
 * is platform income; what Paystack charges Wheelers for the transfer is a
 * separate cost. Set WITHDRAWAL_FEE_NGN to change it.
 *
 * Beyond the fee there is no Wheelers minimum: a user may withdraw any amount they hold.
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

/** The least a bank transfer may carry. Paystack's floor. */
export const MIN_WITHDRAWAL_NGN = readNonNegative('WITHDRAWAL_MIN_NGN', 50);

/** Wheelers' fee on every withdrawal, taken from the amount. */
export const WITHDRAWAL_FEE_NGN = readNonNegative('WITHDRAWAL_FEE_NGN', 45);

/** The least a user may ask to withdraw: the fee, and enough left for the bank to accept. */
export const MIN_WITHDRAWAL_REQUEST_NGN = WITHDRAWAL_FEE_NGN + MIN_WITHDRAWAL_NGN;

export interface WithdrawalBreakdown {
  /** What leaves the wallet: the amount the user typed. */
  amountNgn: number;
  /** Wheelers' fee. */
  feeNgn: number;
  /** What arrives in the bank. */
  payoutNgn: number;
}

const kobo = (n: number) => Math.round(n * 100) / 100;

/** What a withdrawal of `amountNgn` costs and pays. The one place this is worked out. */
export function withdrawalBreakdown(amountNgn: number, feeNgn = WITHDRAWAL_FEE_NGN): WithdrawalBreakdown {
  const amount = kobo(Math.max(0, amountNgn));
  const fee = kobo(Math.min(amount, Math.max(0, feeNgn)));
  return { amountNgn: amount, feeNgn: fee, payoutNgn: kobo(amount - fee) };
}
