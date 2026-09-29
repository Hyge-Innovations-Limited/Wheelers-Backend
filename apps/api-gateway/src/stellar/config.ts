import { Networks } from '@stellar/stellar-sdk';

/**
 * Stellar settings. TESTNET ONLY, by construction: this grant covers testnet,
 * and there is no switch to point it at the public network. A Horizon URL
 * that is not a testnet one, or STELLAR_NETWORK set to anything else, stops
 * the gateway rather than risk it.
 *
 *   STELLAR_ENABLED=true
 *   STELLAR_MASTER_SEED=<64 hex characters>   every account's secret comes from this; keep it like a password
 *   STELLAR_NGN_PER_XLM=1000                  the demo rate: ₦1,000 = 1 XLM
 */

export interface StellarConfig {
  horizonUrl: string;
  friendbotUrl: string;
  networkPassphrase: string;
  masterSeed: Buffer;
  ngnPerXlm: number;
  /** What a new rider or driver account is opened with: Stellar's minimum balance, and a little over. */
  startingXlm: string;
  explorerBase: string;
}

const TESTNET_HORIZON = 'https://horizon-testnet.stellar.org';

export function stellarConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StellarConfig | null {
  if (env.STELLAR_ENABLED !== 'true') return null;
  const network = (env.STELLAR_NETWORK ?? 'testnet').trim().toLowerCase();
  if (network !== 'testnet') {
    throw new Error(`[stellar] STELLAR_NETWORK=${network}: only testnet is supported. Refusing to start.`);
  }
  const horizonUrl = (env.STELLAR_HORIZON_URL ?? TESTNET_HORIZON).trim().replace(/\/+$/, '');
  if (!/testnet/i.test(horizonUrl)) {
    throw new Error(`[stellar] STELLAR_HORIZON_URL=${horizonUrl} is not a testnet Horizon. Refusing to start.`);
  }
  const seedHex = (env.STELLAR_MASTER_SEED ?? '').trim();
  if (!/^[0-9a-fA-F]{64,128}$/.test(seedHex)) {
    throw new Error('[stellar] STELLAR_MASTER_SEED must be 64 to 128 hex characters (make one with: openssl rand -hex 32).');
  }
  const ngnPerXlm = Number(env.STELLAR_NGN_PER_XLM ?? 1000);
  if (!Number.isFinite(ngnPerXlm) || ngnPerXlm <= 0) throw new Error('[stellar] STELLAR_NGN_PER_XLM must be a positive number.');
  return {
    horizonUrl,
    friendbotUrl: (env.STELLAR_FRIENDBOT_URL ?? 'https://friendbot.stellar.org').trim(),
    networkPassphrase: Networks.TESTNET,
    masterSeed: Buffer.from(seedHex, 'hex'),
    ngnPerXlm,
    startingXlm: '2',
    explorerBase: 'https://stellar.expert/explorer/testnet',
  };
}

export const explorerTx = (config: Pick<StellarConfig, 'explorerBase'>, hash: string) => `${config.explorerBase}/tx/${hash}`;
export const explorerAccount = (config: Pick<StellarConfig, 'explorerBase'>, publicKey: string) => `${config.explorerBase}/account/${publicKey}`;
