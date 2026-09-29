import { Horizon, type FeeBumpTransaction, type Transaction } from '@stellar/stellar-sdk';
import type { StellarConfig } from './config';

/**
 * What the service needs from Stellar, narrow so tests can hand it a fake.
 * The real one talks to Horizon (testnet) and Friendbot.
 */
export interface StellarNetwork {
  /** The account's sequence and XLM balance, or null when it does not exist yet. */
  account(publicKey: string): Promise<{ sequence: string; balanceXlm: string } | null>;
  /** Sends a signed transaction; throws StellarSubmitError with Horizon's result codes. */
  submit(tx: Transaction | FeeBumpTransaction): Promise<{ hash: string; ledger: number | null }>;
  /** A sent transaction by hash: whether it made it, or null when Horizon has never seen it. */
  transaction(hash: string): Promise<{ ledger: number | null; successful: boolean } | null>;
  /** Friendbot: free testnet XLM for a new account. Operations only. */
  fund(publicKey: string): Promise<void>;
}

export class StellarSubmitError extends Error {
  constructor(message: string, readonly codes: string[], readonly retryable: boolean) {
    super(message);
  }
}

/** Codes that mean "try again with a fresh transaction", not "this can never work". */
const RETRYABLE = new Set(['tx_bad_seq', 'tx_too_late', 'tx_insufficient_fee', 'op_underfunded', 'op_no_destination', 'tx_no_source_account', 'timeout']);

export function createHorizonNetwork(config: Pick<StellarConfig, 'horizonUrl' | 'friendbotUrl'>): StellarNetwork {
  const server = new Horizon.Server(config.horizonUrl);
  return {
    async account(publicKey) {
      try {
        const account = await server.loadAccount(publicKey);
        const native = account.balances.find((b) => b.asset_type === 'native');
        return { sequence: account.sequenceNumber(), balanceXlm: native?.balance ?? '0' };
      } catch (error) {
        if ((error as { response?: { status?: number } })?.response?.status === 404) return null;
        throw error;
      }
    },

    async submit(tx) {
      try {
        const result = await server.submitTransaction(tx);
        return { hash: result.hash, ledger: typeof result.ledger === 'number' ? result.ledger : null };
      } catch (error) {
        const data = (error as { response?: { status?: number; data?: { extras?: { result_codes?: { transaction?: string; operations?: string[] } } } } }).response;
        const codes = [data?.data?.extras?.result_codes?.transaction, ...(data?.data?.extras?.result_codes?.operations ?? [])].filter((c): c is string => Boolean(c));
        if (!data) throw new StellarSubmitError(error instanceof Error ? error.message : 'Network error', ['timeout'], true);
        const retryable = data.status === 504 || codes.some((code) => RETRYABLE.has(code));
        throw new StellarSubmitError(`Horizon refused: ${codes.join(', ') || data.status}`, codes, retryable);
      }
    },

    async transaction(hash) {
      try {
        const tx = await server.transactions().transaction(hash).call();
        return { ledger: typeof tx.ledger_attr === 'number' ? tx.ledger_attr : null, successful: tx.successful };
      } catch (error) {
        if ((error as { response?: { status?: number } })?.response?.status === 404) return null;
        throw error;
      }
    },

    async fund(publicKey) {
      const response = await fetch(`${config.friendbotUrl}?addr=${encodeURIComponent(publicKey)}`);
      if (!response.ok) throw new Error(`Friendbot refused (${response.status}): ${(await response.text().catch(() => '')).slice(0, 200)}`);
    },
  };
}
