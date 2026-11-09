// Provider-neutral shapes. Paystack is the only implementation; nothing
// outside this package should know a Paystack field name.

export interface PaymentCustomer {
  /** Provider customer id (Paystack customer_code, "CUS_…"). */
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
}

export interface PaymentVirtualAccount {
  /** Provider account id, as a string. */
  id: string;
  customer_id: string;
  account_number: string;
  account_name: string;
  bank_name: string;
  bank_slug: string;
  currency: string;
  country: string;
  active: boolean;
}

/**
 * `uuid` is what the apps send back when withdrawing. It is the bank CODE —
 * the field keeps its old name so neither app needs a release for the switch.
 */
export interface PaymentBank {
  uuid: string;
  name: string;
  code: string;
  country: string;
  currency: string;
  provider: string;
}

export interface PaymentBankValidation {
  account_number: string;
  account_name: string;
  bank_code: string;
}

export interface PaymentPayout {
  /** Provider transfer id (Paystack transfer_code, "TRF_…"). */
  id: string;
  /** OUR reference — always the withdrawal request id. */
  reference: string;
  amountNgn: number;
  /** What the provider charged us for this transfer, if it said. */
  feeNgn: number | null;
  status: string;
  failureReason: string | null;
}

/** A verified inbound payment, read back from the provider — never trusted from a webhook body. */
export interface PaymentInboundTransaction {
  reference: string;
  status: string;
  amountNgn: number;
  /** What the provider kept from this deposit. */
  providerFeeNgn: number;
  channel: string;
  customerId: string | null;
  customerEmail: string | null;
  receiverAccountNumber: string | null;
  senderName: string | null;
  senderBank: string | null;
  senderAccountNumber: string | null;
  paidAt: string | null;
}

export interface PaymentsClientConfig {
  secretKey: string;
  baseUrl?: string;
  /**
   * Bank that issues deposit accounts: "wema-bank" or "titan-paystack" live.
   * Test keys only accept "test-bank" — the client picks that automatically
   * for an sk_test_ key unless told otherwise.
   */
  dvaBank?: string;
  /** Domain for the synthetic per-user customer email. */
  emailDomain?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export class PaymentsApiError extends Error {
  code?: string;
  status?: number;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = 'PaymentsApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * A transfer's state as one of three answers. Anything we do not recognise is
 * "pending": wrongly releasing a reservation pays the user twice, wrongly
 * holding one only delays them.
 */
export type PayoutOutcome = 'settled' | 'failed' | 'pending';

const SETTLED = new Set(['success', 'successful', 'completed']);
const FAILED = new Set(['failed', 'reversed', 'abandoned', 'blocked', 'rejected', 'otp']);

export function classifyPayoutStatus(status: string | null | undefined): PayoutOutcome {
  const normalized = (status ?? '').trim().toLowerCase();
  if (SETTLED.has(normalized)) return 'settled';
  if (FAILED.has(normalized)) return 'failed';
  return 'pending';
}

/**
 * "otp" means the Paystack account still has "Confirm transfers before
 * sending" switched on. No automated payout can complete until it is turned
 * off (Paystack dashboard → Settings → Preferences). It is reported as a
 * failure so the rider's money is released instead of locked forever — and
 * NOBODY should finalise that transfer by hand afterwards, or it pays twice.
 */
export function isOtpRequired(status: string | null | undefined): boolean {
  return (status ?? '').trim().toLowerCase() === 'otp';
}

export const OTP_REQUIRED_MESSAGE =
  'Withdrawals are not switched on yet: the payment provider is asking for a manual confirmation on every transfer. Your balance has not been deducted.';
