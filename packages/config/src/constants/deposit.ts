/**
 * Deposit fee.
 *
 * Wheelers keeps a flat ₦20 from every deposit, whatever its size. The user's
 * wallet is credited with the rest and the ₦20 lands in the platform wallet.
 *
 * The payment provider ALSO takes a cut of every deposit before the cash
 * reaches us. Someone has to carry that, and it is a business decision:
 *
 *   DEPOSIT_PROVIDER_FEE_PAID_BY=platform  (default)
 *     The user only ever loses the flat ₦20. The provider's cut is booked
 *     against the platform wallet, so on a large deposit Wheelers can net
 *     LESS than zero (₦20 earned, ₦100 paid on a ₦10,000 deposit).
 *   DEPOSIT_PROVIDER_FEE_PAID_BY=user
 *     The provider's cut is taken from the deposit as well. Wheelers always
 *     nets exactly ₦20.
 *
 * Either way every naira is booked, so the ledger total always equals the
 * cash the provider actually holds. That equality is the whole point: the
 * old integration ignored provider fees and the two drifted apart.
 */
function readFee(): number {
  const raw = process.env.DEPOSIT_FEE_NGN;
  if (raw === undefined || raw === '') return 20;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 20;
}

export const DEPOSIT_FEE_NGN = readFee();

export const DEPOSIT_PROVIDER_FEE_PAID_BY: 'platform' | 'user' =
  (process.env.DEPOSIT_PROVIDER_FEE_PAID_BY ?? 'platform').trim().toLowerCase() === 'user'
    ? 'user'
    : 'platform';

export interface DepositSplit {
  /** Credited to the user's wallet. */
  userCreditNgn: number;
  /** Credited to the platform wallet — Wheelers' flat fee. */
  platformFeeNgn: number;
  /** Debited from the platform wallet — the provider's cut Wheelers absorbs. */
  platformAbsorbsNgn: number;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Split one deposit. Invariant, for any input:
 *   userCredit + platformFee − platformAbsorbs === amount − providerFee
 * i.e. what the ledger gains equals the cash that actually arrived.
 */
export function splitDeposit(
  amountNgn: number,
  providerFeeNgn: number,
  feeNgn: number = DEPOSIT_FEE_NGN,
  providerFeePaidBy: 'platform' | 'user' = DEPOSIT_PROVIDER_FEE_PAID_BY,
): DepositSplit {
  const amount = Math.max(0, round2(amountNgn));
  const providerFee = Math.min(amount, Math.max(0, round2(providerFeeNgn)));
  // A deposit smaller than the fee is kept whole; nobody goes negative.
  const platformFee = Math.min(amount, Math.max(0, round2(feeNgn)));
  if (providerFeePaidBy === 'user') {
    const userCredit = Math.max(0, round2(amount - platformFee - providerFee));
    // If the deposit could not cover both, the platform eats the remainder.
    const absorbed = round2(userCredit + platformFee - (amount - providerFee));
    return { userCreditNgn: userCredit, platformFeeNgn: platformFee, platformAbsorbsNgn: Math.max(0, absorbed) };
  }
  return {
    userCreditNgn: round2(amount - platformFee),
    platformFeeNgn: platformFee,
    platformAbsorbsNgn: providerFee,
  };
}
