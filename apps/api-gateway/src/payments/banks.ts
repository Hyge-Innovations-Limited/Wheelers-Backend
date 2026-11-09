import type { PaymentBank, PaymentsClient } from '@wheleers/payments';
import type { RedisClient } from '../redis/client';

const BANKS_CACHE_TTL_SECONDS = 6 * 60 * 60;

/**
 * Versioned on purpose. The previous provider cached its own bank ids under a
 * different key; a new key means an app can never be handed an id the current
 * provider does not understand.
 */
export const BANKS_CACHE_KEY = 'payments:banks:v1:NG';

/** Nigerian banks that can receive a transfer — cached, since it rarely changes. */
export async function getBanks(
  paymentsClient: PaymentsClient,
  redisClient?: RedisClient | null,
): Promise<PaymentBank[]> {
  if (redisClient) {
    const cached = await redisClient.get(BANKS_CACHE_KEY).catch(() => null);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as { banks?: PaymentBank[] };
        if (Array.isArray(parsed.banks) && parsed.banks.length > 0) return parsed.banks;
      } catch {
        // fall through to the provider
      }
    }
  }

  const banks = await paymentsClient.listBanks();
  if (redisClient && banks.length > 0) {
    await redisClient
      .set(BANKS_CACHE_KEY, JSON.stringify({ banks }), BANKS_CACHE_TTL_SECONDS)
      .catch(() => undefined);
  }
  return banks;
}
