import type { IncomingMessage, ServerResponse } from 'http';
import { stellarClient } from '@wheleers/db';
import { authenticateHttpUser } from '../http/authenticate';
import { verifyAdminAuth } from '../http/admin-auth.route';
import { readJsonBody, sendJson } from '../http/utils';
import { isRecord } from '../utils/object';
import { RESERVE_XLM, StellarUserError, type StellarService } from './service';

/**
 * Stellar Testnet, over HTTP. Public addresses only, ever.
 *
 *   GET  /stellar/me         the signed-in person's testnet account, balance and recent transfers
 *   POST /stellar/withdraw   { destination, amountXlm }  send testnet XLM out
 *   GET  /admin/stellar      every transfer, with explorer links, and the operations account
 */

export interface StellarRouteDeps {
  jwtSecret: string;
  adminApiKey: string;
  stellar: StellarService | null;
}

async function handleMe(req: IncomingMessage, res: ServerResponse, deps: StellarRouteDeps): Promise<void> {
  const user = await authenticateHttpUser(req, deps.jwtSecret);
  const stellar = deps.stellar;
  if (!stellar) return sendJson(res, 200, { enabled: false });
  // Everyone has one by default; someone the background pass has not reached yet gets theirs now.
  const account = await stellarClient.accountForUser(user.id) ?? await stellar.ensureUserAccount(user.id);
  const [balanceXlm, transfers, rate] = await Promise.all([
    account?.openedAt ? stellar.balanceOf(account.publicKey) : Promise.resolve(null),
    // In and out of this address, looked up by the address itself.
    account ? stellarClient.listForAccount(account.publicKey, 15) : Promise.resolve([]),
    stellar.rates.current().catch(() => null),
  ]);
  sendJson(res, 200, {
    enabled: true,
    network: 'testnet',
    // The live naira value of 1 XLM, shown as an equivalent only; null when no price could be had.
    rate: rate ? { ngnPerXlm: rate.ngnPerXlm, source: rate.source, at: rate.at } : null,
    reserveXlm: RESERVE_XLM,
    account: account
      ? {
          publicKey: account.publicKey,
          opened: Boolean(account.openedAt),
          balanceXlm: balanceXlm === null ? null : String(balanceXlm),
          balanceNgnEquivalent: balanceXlm === null || !rate ? null : Math.round(balanceXlm * rate.ngnPerXlm),
          explorerUrl: stellar.accountUrl(account.publicKey),
        }
      : null,
    transfers: transfers.map((t) => ({ ...stellar.describe(t), direction: t.toPublicKey === account?.publicKey ? 'in' : 'out' })),
  });
}

async function handleWithdraw(req: IncomingMessage, res: ServerResponse, deps: StellarRouteDeps): Promise<void> {
  const user = await authenticateHttpUser(req, deps.jwtSecret);
  if (!deps.stellar) return sendJson(res, 404, { error: 'Stellar is not switched on.', code: 'STELLAR_OFF' });
  const body = await readJsonBody(req).catch(() => null);
  const destination = isRecord(body) && typeof body.destination === 'string' ? body.destination : '';
  const amountXlm = isRecord(body) ? Number(body.amountXlm) : NaN;
  const transfer = await deps.stellar.requestWithdrawal({ userId: user.id, destination, amountXlm });
  sendJson(res, 202, { transfer: deps.stellar.describe(transfer) });
}

async function handleAdmin(req: IncomingMessage, res: ServerResponse, deps: StellarRouteDeps, url: URL): Promise<void> {
  if (!(await verifyAdminAuth(req, deps))) return sendJson(res, 401, { error: 'Unauthorized' });
  const stellar = deps.stellar;
  if (!stellar) return sendJson(res, 200, { enabled: false });
  const ops = await stellarClient.operationsAccount();
  const before = url.searchParams.get('before');
  const transfers = await stellarClient.list({
    limit: Number(url.searchParams.get('limit')) || 50,
    kind: url.searchParams.get('kind'),
    status: url.searchParams.get('status'),
    before: before ? new Date(before) : null,
  });
  const rate = await stellar.rates.current().catch(() => null);
  sendJson(res, 200, {
    enabled: true,
    network: 'testnet',
    rate: rate ? { ngnPerXlm: rate.ngnPerXlm, source: rate.source, at: rate.at } : null,
    operations: ops
      ? { publicKey: ops.publicKey, balanceXlm: String(await stellar.balanceOf(ops.publicKey) ?? '0'), explorerUrl: stellar.accountUrl(ops.publicKey) }
      : null,
    counts: await stellarClient.counts(),
    transfers: transfers.map((t) => ({ id: t.id, reference: t.reference, ...stellar.describe(t) })),
    nextBefore: transfers.length ? transfers[transfers.length - 1]!.createdAt.toISOString() : null,
  });
}

/** Every /stellar/* and /admin/stellar request. Returns false when the path is not ours. */
export async function handleStellarRoute(req: IncomingMessage, res: ServerResponse, deps: StellarRouteDeps, url: URL): Promise<boolean> {
  const routes: Record<string, { method: string; run: () => Promise<void> }> = {
    '/stellar/me': { method: 'GET', run: () => handleMe(req, res, deps) },
    '/stellar/withdraw': { method: 'POST', run: () => handleWithdraw(req, res, deps) },
    '/admin/stellar': { method: 'GET', run: () => handleAdmin(req, res, deps, url) },
  };
  const route = routes[url.pathname];
  if (!route) return false;
  if (req.method !== route.method) {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }
  res.setHeader('Cache-Control', 'no-store');
  try {
    await route.run();
  } catch (error) {
    if (error instanceof StellarUserError) {
      sendJson(res, error.status, { error: error.message, code: error.code });
    } else if (error instanceof Error && /token|unauthori[sz]ed|jwt/i.test(error.message)) {
      sendJson(res, 401, { error: 'Unauthorized' });
    } else {
      console.error('[stellar] route failed', { path: url.pathname, error: error instanceof Error ? error.message : String(error) });
      sendJson(res, 500, { error: 'Something went wrong on our side.' });
    }
  }
  return true;
}
