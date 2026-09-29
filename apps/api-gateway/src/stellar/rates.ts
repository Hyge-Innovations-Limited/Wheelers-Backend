import type { RedisClient } from '../redis/client';

/**
 * The naira value of one XLM, live, for showing an equivalent next to XLM and
 * for sizing a trip's payment on Stellar Testnet (its naira fare, in XLM).
 *
 * Where it comes from, first that answers:
 *   1. Stellar's own market: the XLM/USDC order book on the public network
 *      (read only: nothing is sent there), times US dollars to naira.
 *   2. CoinGecko's XLM price in naira.
 *   3. The last rate that worked, for up to a day.
 *   4. STELLAR_NGN_PER_XLM from .env, if set.
 * Each payment keeps the rate it used, so the evidence always adds up.
 */

export interface NgnRate {
  ngnPerXlm: number;
  source: string;
  at: string;
}

const PUBLIC_HORIZON = 'https://horizon.stellar.org';
/** Circle's USDC on the Stellar public network. */
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const CACHE_KEY = 'stellar:rate:ngn-per-xlm';
const FRESH_MS = 10 * 60 * 1000;
const USABLE_MS = 24 * 60 * 60 * 1000;

type Fetch = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

async function getJson(fetcher: Fetch, url: string): Promise<unknown> {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`HTTP error from ${new URL(url).host}`);
  return response.json();
}

/** A rate is only believed inside a sane band: a feed returning 0 or nonsense must not move money. */
const sane = (value: number) => Number.isFinite(value) && value > 1 && value < 1_000_000;

async function fromStellarMarket(fetcher: Fetch): Promise<number> {
  const book = await getJson(fetcher,
    `${PUBLIC_HORIZON}/order_book?selling_asset_type=native&buying_asset_type=credit_alphanum4&buying_asset_code=USDC&buying_asset_issuer=${USDC_ISSUER}&limit=1`) as { bids?: Array<{ price: string }>; asks?: Array<{ price: string }> };
  const bid = Number(book.bids?.[0]?.price);
  const ask = Number(book.asks?.[0]?.price);
  if (!(bid > 0) || !(ask > 0)) throw new Error('empty XLM/USDC order book');
  const usdPerXlm = (bid + ask) / 2;
  const fx = await getJson(fetcher, 'https://open.er-api.com/v6/latest/USD') as { rates?: Record<string, number> };
  const ngnPerUsd = Number(fx.rates?.NGN);
  if (!(ngnPerUsd > 0)) throw new Error('no USD→NGN rate');
  return usdPerXlm * ngnPerUsd;
}

async function fromCoinGecko(fetcher: Fetch): Promise<number> {
  const data = await getJson(fetcher, 'https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=ngn') as { stellar?: { ngn?: number } };
  return Number(data.stellar?.ngn);
}

export function createRateProvider(deps: { redis?: RedisClient | null; fallbackNgnPerXlm?: number | null; fetcher?: Fetch; now?: () => number }) {
  const fetcher: Fetch = deps.fetcher ?? ((url) => fetch(url, { signal: AbortSignal.timeout(8000) }));
  const now = () => (deps.now ? deps.now() : Date.now());
  let memory: NgnRate | null = null;
  let inflight: Promise<NgnRate | null> | null = null;

  async function remembered(): Promise<NgnRate | null> {
    if (memory) return memory;
    const raw = await deps.redis?.get(CACHE_KEY).catch(() => null);
    if (!raw) return null;
    try { memory = JSON.parse(raw) as NgnRate; } catch { memory = null; }
    return memory;
  }

  async function refresh(): Promise<NgnRate | null> {
    for (const [source, read] of [['stellar-dex × er-api', fromStellarMarket], ['coingecko', fromCoinGecko]] as const) {
      try {
        const value = await read(fetcher);
        if (!sane(value)) throw new Error(`implausible rate ${value}`);
        memory = { ngnPerXlm: Math.round(value * 100) / 100, source, at: new Date(now()).toISOString() };
        await deps.redis?.set(CACHE_KEY, JSON.stringify(memory), Math.round(USABLE_MS / 1000)).catch(() => undefined);
        return memory;
      } catch (error) {
        console.warn('[stellar] price source failed', { source, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return null;
  }

  return {
    /** The rate to use now, or null when there is none at all. */
    async current(): Promise<NgnRate | null> {
      const known = await remembered();
      const age = known ? now() - Date.parse(known.at) : Infinity;
      if (known && age < FRESH_MS) return known;
      inflight ??= refresh().finally(() => { inflight = null; });
      const fresh = await inflight;
      if (fresh) return fresh;
      if (known && age < USABLE_MS) return known;
      if (deps.fallbackNgnPerXlm && sane(deps.fallbackNgnPerXlm)) {
        return { ngnPerXlm: deps.fallbackNgnPerXlm, source: 'STELLAR_NGN_PER_XLM', at: new Date(now()).toISOString() };
      }
      return null;
    },
  };
}

export type RateProvider = ReturnType<typeof createRateProvider>;
