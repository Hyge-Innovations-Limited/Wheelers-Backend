import { Client } from 'pg';
import { walletCashFields } from '../rides/cash-owed';

/**
 * The live wallet (Timi, 19 Nov 2026): the balance and money history in the app update by themselves, the moment the
 * money moves, from every path that moves it (a deposit, a ride, a refund, waiting, a withdrawal, a cash fee, an
 * admin fix). The database says so itself: a trigger on Wallet and Transaction (migration 20261119090000_wallet_live)
 * sends one pg_notify per change, on commit. Each gateway process LISTENs on one connection of its own and hands the
 * news to the sockets it holds (each person's socket is on one process, so nobody hears it twice). The app needs no
 * fetch: the balance message carries what the overview shows, the transaction message the row as the history lists it.
 *
 *   wallet:live { balanceNgn, lockedNgn, updatedAt, cashRides, owedNgn, owedLimitNgn, driverPaused, depositToDriveNgn }
 *   wallet:live { transaction: { id, type, direction, amountNgn, balanceAfterNgn, referenceId, metadata, createdAt } }
 *
 * A connection that drops is made again (1 s, then up to 30 s); what changed meanwhile the app catches up on when its
 * own socket comes back (it fetches the wallet once then).
 */
export const WALLET_LIVE_CHANNEL = 'wallet_live';

export type WalletLiveNotice =
  | { kind: 'balance'; userId: string; payload: Record<string, unknown> }
  | { kind: 'transaction'; userId: string; payload: Record<string, unknown> };

/** Postgres's timestamp(3) without a zone comes as "2026-11-19T10:00:00.123": it is UTC. */
function isoOf(value: unknown): string {
  if (typeof value !== 'string' || !value) return new Date().toISOString();
  const withZone = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`;
  const at = new Date(withZone);
  return Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString();
}

const num = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** One notification as the app's message. Null: not one of ours, or no person (never sent anywhere). */
export function parseWalletNotice(raw: string | undefined): WalletLiveNotice | null {
  if (!raw) return null;
  let n: Record<string, unknown>;
  try { n = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  const userId = typeof n.u === 'string' && n.u ? n.u : null;
  if (!userId) return null;
  if (n.k === 'w') {
    const balanceNgn = num(n.b);
    return {
      kind: 'balance',
      userId,
      payload: { balanceNgn, lockedNgn: num(n.l), updatedAt: isoOf(n.at), ...walletCashFields(balanceNgn) },
    };
  }
  if (n.k === 't' && typeof n.id === 'string') {
    return {
      kind: 'transaction',
      userId,
      payload: {
        transaction: {
          id: n.id,
          type: String(n.type ?? ''),
          direction: n.d === 'DEBIT' ? 'DEBIT' : 'CREDIT',
          amountNgn: num(n.a),
          balanceAfterNgn: num(n.ba),
          referenceId: String(n.r ?? ''),
          metadata: n.m && typeof n.m === 'object' ? n.m : null,
          createdAt: isoOf(n.at),
        },
        // Its metadata was too big for the notice: the app fetches the history once for this row.
        ...(n.mx === true ? { incomplete: true } : {}),
      },
    };
  }
  return null;
}

/** Prisma's DATABASE_URL with Prisma's own settings (schema, connection_limit, …) taken off; sslmode kept. */
export function pgConnectionString(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const sslmode = url.searchParams.get('sslmode');
  url.search = sslmode ? `?sslmode=${encodeURIComponent(sslmode)}` : '';
  return url.toString();
}

export interface WalletLive {
  stop(): Promise<void>;
  /** For tests and the health page: listening right now. */
  readonly listening: boolean;
}

export function startWalletLive(params: {
  databaseUrl: string;
  deliver: (userId: string, type: string, payload: Record<string, unknown>) => void;
}): WalletLive {
  let client: Client | null = null;
  let stopped = false;
  let listening = false;
  let delayMs = 1000;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const again = () => {
    listening = false;
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = null; void connect(); }, delayMs);
    timer.unref?.();
    delayMs = Math.min(delayMs * 2, 30_000);
  };

  const connect = async () => {
    const next = new Client({ connectionString: pgConnectionString(params.databaseUrl), keepAlive: true, application_name: 'wheelers-wallet-live' });
    client = next;
    next.on('error', (error) => {
      console.warn('[wallet-live] connection lost', { error: error.message });
      void next.end().catch(() => undefined);
      again();
    });
    next.on('end', () => { if (client === next) again(); });
    next.on('notification', (msg) => {
      if (msg.channel !== WALLET_LIVE_CHANNEL) return;
      const notice = parseWalletNotice(msg.payload);
      if (notice) params.deliver(notice.userId, 'wallet:live', notice.payload);
    });
    try {
      await next.connect();
      await next.query(`LISTEN ${WALLET_LIVE_CHANNEL}`);
      if (stopped) { await next.end().catch(() => undefined); return; }
      listening = true;
      delayMs = 1000;
    } catch (error) {
      console.warn('[wallet-live] could not listen', { error: error instanceof Error ? error.message : String(error) });
      await next.end().catch(() => undefined);
      again();
    }
  };

  void connect();

  return {
    get listening() { return listening; },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      listening = false;
      await client?.end().catch(() => undefined);
    },
  };
}
