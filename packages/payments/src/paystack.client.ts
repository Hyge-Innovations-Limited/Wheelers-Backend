import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  PaymentsApiError,
  type PaymentBank,
  type PaymentBankValidation,
  type PaymentCustomer,
  type PaymentInboundTransaction,
  type PaymentPayout,
  type PaymentVirtualAccount,
  type PaymentsClientConfig,
} from './types';

const DEFAULT_BASE_URL = 'https://api.paystack.co';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRY_BACKOFF_BASE_MS = 500;
const DEFAULT_EMAIL_DOMAIN = 'users.wheelersng.com';

interface PaystackEnvelope<T> {
  status: boolean;
  message?: string;
  data: T;
  code?: string;
  type?: string;
}

type Json = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const koboToNgn = (v: unknown): number => Math.round(Number(v ?? 0)) / 100;

/**
 * Everything Wheelers needs from its payment provider, implemented on
 * Paystack. Money model: every deposit account pools into ONE Paystack
 * balance and every transfer draws from it — who owns what is the ledger's
 * job, never the provider's.
 *
 * Amounts cross this boundary in NAIRA. Paystack speaks kobo; the conversion
 * lives here and nowhere else.
 */
export class PaymentsClient {
  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly dvaBank: string;
  private readonly emailDomain: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(config: PaymentsClientConfig) {
    this.secretKey = config.secretKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    // Live bank slugs are refused under a test key ("wema-bank is not
    // available in test mode"), and "test-bank" is refused under a live one.
    const isTestKey = config.secretKey.startsWith('sk_test_');
    this.dvaBank = isTestKey ? 'test-bank' : (config.dvaBank?.trim() || 'wema-bank');
    this.emailDomain = config.emailDomain?.trim() || DEFAULT_EMAIL_DOMAIN;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  get isTestMode(): boolean {
    return this.secretKey.startsWith('sk_test_');
  }

  // ── Customers ───────────────────────────────────────────────

  /**
   * Paystack keys customers by email and most WhatsApp riders have none, so
   * every user gets a stable synthetic address derived from their user id. It
   * is never mailed, and it makes "find this user's customer" a pure function.
   */
  customerEmailFor(userId: string): string {
    return `${userId.toLowerCase()}@${this.emailDomain}`;
  }

  /** Idempotent: Paystack returns the existing customer for a known email. */
  async createCustomer(params: {
    customerReference: string;
    firstName: string;
    lastName: string;
    phoneNumber?: string;
  }): Promise<PaymentCustomer> {
    const body: Json = {
      email: this.customerEmailFor(params.customerReference),
      first_name: params.firstName,
      last_name: params.lastName,
      metadata: { userId: params.customerReference },
    };
    if (params.phoneNumber) body.phone = params.phoneNumber;
    const res = await this.post<Json>('/customer', body);
    return mapCustomer(res.data);
  }

  async findCustomerByReference(customerReference: string): Promise<PaymentCustomer | null> {
    const found = await this.fetchCustomer(this.customerEmailFor(customerReference));
    return found ? mapCustomer(found) : null;
  }

  async updateCustomer(customerId: string, params: {
    firstName?: string;
    lastName?: string;
    phoneNumber?: string;
  }): Promise<PaymentCustomer> {
    const body: Json = {};
    if (params.firstName) body.first_name = params.firstName;
    if (params.lastName) body.last_name = params.lastName;
    if (params.phoneNumber) body.phone = params.phoneNumber;
    const res = await this.request<Json>('PUT', `/customer/${encodeURIComponent(customerId)}`, body);
    return mapCustomer(res.data);
  }

  // ── Deposit accounts ────────────────────────────────────────

  /**
   * One dedicated account per customer; asking again returns the same one.
   * Paystack can also answer "in progress" and deliver the account later by
   * webhook — that surfaces here as ACCOUNT_PENDING, not as a failure.
   */
  async createVirtualAccount(customerId: string): Promise<PaymentVirtualAccount> {
    const res = await this.post<Json>('/dedicated_account', {
      customer: customerId,
      preferred_bank: this.dvaBank,
    });
    const account = mapVirtualAccount(res.data, customerId);
    if (!account) {
      throw new PaymentsApiError(
        res.message ?? 'Deposit account is being assigned',
        202,
        'ACCOUNT_PENDING',
      );
    }
    return account;
  }

  /** The customer's dedicated account if Paystack has assigned one yet. */
  async findVirtualAccount(customerIdOrEmail: string): Promise<PaymentVirtualAccount | null> {
    const customer = await this.fetchCustomer(customerIdOrEmail);
    if (!customer) return null;
    const raw = customer.dedicated_account;
    if (!raw || typeof raw !== 'object') return null;
    return mapVirtualAccount(raw as Json, str(customer.customer_code) ?? customerIdOrEmail);
  }

  // ── Banks ───────────────────────────────────────────────────

  async listBanks(): Promise<PaymentBank[]> {
    const res = await this.get<Json[]>('/bank?country=nigeria&currency=NGN&perPage=100');
    const rows = Array.isArray(res.data) ? res.data : [];
    return rows
      .filter((b) => b.active !== false && b.is_deleted !== true && b.supports_transfer !== false)
      .map((b) => ({
        uuid: String(b.code ?? ''),
        name: String(b.name ?? ''),
        code: String(b.code ?? ''),
        country: 'NG',
        currency: 'NGN',
        provider: 'paystack',
      }))
      .filter((b) => b.code.length > 0 && b.name.length > 0);
  }

  async validateBankAccount(params: {
    accountNumber: string;
    bankCode: string;
  }): Promise<PaymentBankValidation> {
    const query = new URLSearchParams({
      account_number: params.accountNumber,
      bank_code: params.bankCode,
    });
    const res = await this.get<Json>(`/bank/resolve?${query.toString()}`);
    return {
      account_number: String(res.data.account_number ?? params.accountNumber),
      account_name: String(res.data.account_name ?? ''),
      bank_code: params.bankCode,
    };
  }

  // ── Float ───────────────────────────────────────────────────

  /** Cash available for transfers, in naira. */
  async getBalanceNgn(): Promise<number> {
    const res = await this.get<Json[]>('/balance');
    const ngn = (Array.isArray(res.data) ? res.data : []).find((b) => b.currency === 'NGN');
    return koboToNgn(ngn?.balance);
  }

  // ── Payouts ─────────────────────────────────────────────────

  /**
   * `reference` MUST be the withdrawal request id. Paystack refuses a second
   * transfer with a reference it has seen, so a retry can never pay twice —
   * a duplicate is answered by reading the original back.
   */
  async createPayout(params: {
    reference: string;
    amountNgn: number;
    accountNumber: string;
    bankCode: string;
    accountName: string;
    narration?: string;
  }): Promise<PaymentPayout> {
    const recipient = await this.post<Json>('/transferrecipient', {
      type: 'nuban',
      name: params.accountName,
      account_number: params.accountNumber,
      bank_code: params.bankCode,
      currency: 'NGN',
    });
    const recipientCode = str(recipient.data.recipient_code);
    if (!recipientCode) {
      throw new PaymentsApiError('Could not register the destination bank account', 400, 'RECIPIENT_FAILED');
    }

    try {
      const res = await this.post<Json>('/transfer', {
        source: 'balance',
        amount: Math.round(params.amountNgn * 100),
        recipient: recipientCode,
        reference: params.reference,
        reason: params.narration ?? 'Wheelers withdrawal',
      });
      return mapPayout(res.data, params.reference);
    } catch (error) {
      if (error instanceof PaymentsApiError && error.code === 'duplicate_transfer_reference') {
        const existing = await this.getPayout(params.reference);
        if (existing) return existing;
      }
      throw error;
    }
  }

  /** By OUR reference. `null` means Paystack has never seen it — no transfer exists. */
  async getPayout(reference: string): Promise<PaymentPayout | null> {
    try {
      const res = await this.get<Json>(`/transfer/verify/${encodeURIComponent(reference)}`);
      return mapPayout(res.data, reference);
    } catch (error) {
      if (error instanceof PaymentsApiError && (error.code === 'not_found' || error.status === 404)) {
        return null;
      }
      throw error;
    }
  }

  // ── Inbound ─────────────────────────────────────────────────

  /**
   * The authoritative record of an inbound payment. A webhook only tells us
   * WHICH reference to look at; the amount and status credited to a wallet
   * always come from here.
   */
  async verifyTransaction(reference: string): Promise<PaymentInboundTransaction | null> {
    let data: Json;
    try {
      data = (await this.get<Json>(`/transaction/verify/${encodeURIComponent(reference)}`)).data;
    } catch (error) {
      if (error instanceof PaymentsApiError && (error.code === 'transaction_not_found' || error.status === 404)) {
        return null;
      }
      throw error;
    }
    const customer = (data.customer ?? {}) as Json;
    const authorization = (data.authorization ?? {}) as Json;
    const metadata = (data.metadata && typeof data.metadata === 'object' ? data.metadata : {}) as Json;
    return {
      reference: String(data.reference ?? reference),
      status: String(data.status ?? ''),
      amountNgn: koboToNgn(data.amount),
      providerFeeNgn: koboToNgn(data.fees),
      channel: String(data.channel ?? ''),
      customerId: str(customer.customer_code),
      customerEmail: str(customer.email),
      receiverAccountNumber:
        str(authorization.receiver_bank_account_number) ?? str(metadata.receiver_account_number),
      senderName: str(authorization.sender_name) ?? str(authorization.account_name),
      senderBank: str(authorization.sender_bank) ?? str(authorization.bank),
      senderAccountNumber: str(authorization.sender_bank_account_number),
      paidAt: str(data.paid_at) ?? str(data.paidAt),
    };
  }

  /** Paystack signs the raw body with HMAC-SHA512 keyed by the secret key. */
  verifyWebhookSignature(rawBody: Buffer | string, signature: string | undefined | null): boolean {
    if (!signature) return false;
    const expected = createHmac('sha512', this.secretKey).update(rawBody).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature.trim().toLowerCase(), 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // ── HTTP ────────────────────────────────────────────────────

  private async fetchCustomer(idOrEmail: string): Promise<Json | null> {
    try {
      const res = await this.get<Json>(`/customer/${encodeURIComponent(idOrEmail)}`);
      return res.data;
    } catch (error) {
      if (error instanceof PaymentsApiError && (error.status === 404 || error.code === 'customer_not_found')) {
        return null;
      }
      throw error;
    }
  }

  private get<T>(path: string): Promise<PaystackEnvelope<T>> {
    return this.request<T>('GET', path);
  }

  private post<T>(path: string, body: unknown): Promise<PaystackEnvelope<T>> {
    return this.request<T>('POST', path, body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<PaystackEnvelope<T>> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.requestOnce<T>(method, path, body);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // A 4xx is an answer, not an outage. Retrying a 5xx or a dropped
        // connection is safe everywhere: each create call is idempotent on
        // Paystack's side (email, customer, account number, our reference).
        if (error instanceof PaymentsApiError && error.status && error.status < 500 && error.status !== 429) {
          throw error;
        }
        if (attempt < this.maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_BASE_MS * 2 ** attempt));
        }
      }
    }
    throw lastError!;
  }

  private async requestOnce<T>(method: string, path: string, body?: unknown): Promise<PaystackEnvelope<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => null)) as PaystackEnvelope<T> | null;
      if (!res.ok || !json || json.status === false) {
        const message = json?.message ?? `Paystack ${method} ${path} failed (${res.status})`;
        throw new PaymentsApiError(message, res.status, json?.code);
      }
      return json;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function mapCustomer(data: Json): PaymentCustomer {
  return {
    id: String(data.customer_code ?? ''),
    email: String(data.email ?? ''),
    first_name: str(data.first_name),
    last_name: str(data.last_name),
    phone: str(data.phone),
  };
}

function mapVirtualAccount(data: Json, customerId: string): PaymentVirtualAccount | null {
  const accountNumber = str(data.account_number);
  if (!accountNumber) return null;
  const bank = (data.bank ?? {}) as Json;
  return {
    id: String(data.id ?? accountNumber),
    customer_id: customerId,
    account_number: accountNumber,
    account_name: String(data.account_name ?? ''),
    bank_name: String(bank.name ?? ''),
    bank_slug: String(bank.slug ?? ''),
    currency: String(data.currency ?? 'NGN'),
    country: 'NG',
    active: data.active !== false,
  };
}

function mapPayout(data: Json, reference: string): PaymentPayout {
  const fee = data.fee_charged ?? data.fees;
  return {
    id: String(data.transfer_code ?? data.id ?? reference),
    reference: String(data.reference ?? reference),
    amountNgn: koboToNgn(data.amount),
    feeNgn: fee === undefined || fee === null ? null : koboToNgn(fee),
    status: String(data.status ?? ''),
    failureReason: str(data.gateway_response) ?? str(data.failures) ?? str(data.reason),
  };
}
