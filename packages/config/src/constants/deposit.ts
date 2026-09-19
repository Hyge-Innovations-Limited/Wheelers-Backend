/**
 * Deposit fee.
 *
 * Wheelers keeps a flat ₦20 from every deposit, whatever its size. The user's
 * wallet is credited with the rest and the ₦20 lands in the platform wallet.
 *
 * The payment provider ALSO takes a cut of every deposit before the cash
 * reaches us. Someone has to carry that, and it is a business decision:
 *
 *   DEPOSIT_PROVIDER_FEE_PAID_BY=user  (default)
 *     The provider's cut is taken from the deposit as well as the flat ₦20.
 *     Wheelers always nets exactly ₦20, whatever the deposit size.
 *   DEPOSIT_PROVIDER_FEE_PAID_BY=platform
 *     The user only ever loses the flat ₦20. The provider's cut is booked
 *     against the platform wallet, so on a large deposit Wheelers nets LESS
 *     than zero (₦20 earned, ₦100 paid on a ₦10,000 deposit).
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
  (process.env.DEPOSIT_PROVIDER_FEE_PAID_BY ?? 'user').trim().toLowerCase() === 'platform'
    ? 'platform'
    : 'user';

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

/**
 * The provider's deposit cut, used ONLY to tell a user how much to send. What
 * is actually deducted always comes from the provider's own figure for that
 * transaction. Paystack dedicated accounts: 1%, capped at ₦300.
 */
const PROVIDER_DEPOSIT_RATE = Number(process.env.DEPOSIT_PROVIDER_FEE_RATE ?? 0.01);
const PROVIDER_DEPOSIT_CAP_NGN = Number(process.env.DEPOSIT_PROVIDER_FEE_CAP_NGN ?? 300);

/** The provider's likely cut of a deposit of this size — an ESTIMATE, for display. */
export function estimateDepositProviderFee(sendNgn: number): number {
  if (!(sendNgn > 0) || !(PROVIDER_DEPOSIT_RATE > 0)) return 0;
  return Math.round(Math.min(PROVIDER_DEPOSIT_CAP_NGN, sendNgn * PROVIDER_DEPOSIT_RATE) * 100) / 100;
}

/**
 * How much someone must SEND for `netNgn` to land in their wallet. Rounded up
 * to the next ₦10 so the rider gets a number they can type, and so a rounding
 * kobo never leaves them ₦1 short of a ride.
 */
export function depositNeededFor(netNgn: number): number {
  const net = Math.max(0, netNgn);
  let gross = net + DEPOSIT_FEE_NGN;
  if (DEPOSIT_PROVIDER_FEE_PAID_BY === 'user' && PROVIDER_DEPOSIT_RATE > 0 && PROVIDER_DEPOSIT_RATE < 1) {
    const uncapped = gross / (1 - PROVIDER_DEPOSIT_RATE);
    gross = uncapped * PROVIDER_DEPOSIT_RATE > PROVIDER_DEPOSIT_CAP_NGN ? gross + PROVIDER_DEPOSIT_CAP_NGN : uncapped;
  }
  return Math.ceil(gross / 10) * 10;
}

/** One honest sentence about deposit charges, for anywhere account details are shown. */
export const DEPOSIT_FEE_NOTICE =
  DEPOSIT_FEE_NGN <= 0 && DEPOSIT_PROVIDER_FEE_PAID_BY !== 'user'
    ? ''
    : DEPOSIT_PROVIDER_FEE_PAID_BY === 'user'
      ? `Each deposit has a ₦${DEPOSIT_FEE_NGN} Wheelers fee plus the bank's processing charge (about ${Math.round(PROVIDER_DEPOSIT_RATE * 100)}%, max ₦${PROVIDER_DEPOSIT_CAP_NGN}) taken off before it reaches your wallet.`
      : `Each deposit has a ₦${DEPOSIT_FEE_NGN} Wheelers fee taken off before it reaches your wallet.`;
