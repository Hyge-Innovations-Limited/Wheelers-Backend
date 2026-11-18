import { CASH_OWED_LIMIT_NGN, cashOwedNgn, depositNeededFor, owesPastLimit } from '@wheleers/config';
import { walletClient } from '@wheleers/db';

/**
 * Pay with cash (Timi, 18 Nov 2026): a driver's wallet goes below zero by Wheelers' share of each cash ride. Owing
 * up to ₦1,000 is fine; past it they get no new requests (driverClient.findNearby leaves them out) and a bid is
 * refused, until a deposit brings the wallet back. The deposit to ask for clears all of it (₦0), the deposit fee
 * included.
 */
export interface DriverOwed {
  owedNgn: number;
  /** Past the limit: no new requests. */
  paused: boolean;
  /** What to send to be back at ₦0 (fees included); 0 when nothing is owed. */
  depositNgn: number;
}

export function owedOf(balanceNgn: number): DriverOwed {
  const owedNgn = cashOwedNgn(balanceNgn);
  return { owedNgn, paused: owesPastLimit(balanceNgn), depositNgn: owedNgn > 0 ? depositNeededFor(owedNgn) : 0 };
}

export function owedMessage(owed: DriverOwed): string {
  return `You owe Wheelers ₦${Math.ceil(owed.owedNgn).toLocaleString('en-NG')} from cash trips. Deposit ₦${owed.depositNgn.toLocaleString('en-NG')} to keep driving.`;
}

/** Refuses a bid from a driver who owes past the limit (the request should not have reached them). */
export async function assertNotOwingPastLimit(userId: string): Promise<void> {
  const wallet = await walletClient.findByUserId(userId).catch(() => null);
  if (!wallet) return;
  const owed = owedOf(Number(wallet.balanceNgn));
  if (owed.paused) throw new Error(owedMessage(owed));
}

export { CASH_OWED_LIMIT_NGN };
