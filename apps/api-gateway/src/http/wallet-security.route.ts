import type { IncomingMessage, ServerResponse } from 'http';
import { logActivity } from '../analytics/log-activity';
import { isRecord } from '../utils/object';
import {
  PinFlowError,
  completePinReset,
  getSecuritySummary,
  startPinReset,
  type PinFlowDeps,
} from '../wallet-security/pin-flows';
import { WalletSecurityError, setInitialPin } from '../wallet-security/wallet-pin';
import { HttpAuthError, authenticateHttpUser } from './authenticate';
import { readJsonBody, sendJson } from './utils';

const TAG = '[api-gateway][wallet-security]';

export interface WalletSecurityRouteDeps extends PinFlowDeps {
  jwtSecret: string;
}

/**
 * The wallet PIN for signed-in APP users — the same rules the WhatsApp pages
 * use (wallet-security/*), reached with a login token instead of a page link.
 *
 *   GET  /wallet/security            → what PIN screen to draw
 *   POST /wallet/pin                 → set the FIRST pin            { pin }
 *   POST /wallet/pin/reset/start     → email a code, or warn of the 24h pause
 *   POST /wallet/pin/reset/complete  → { newPin, code? }
 *
 * There is deliberately no "change PIN" that takes the old one: a forgotten
 * and a stolen PIN both go through reset, where the email or the pause guards it.
 */
const ROUTES: Record<string, { method: 'GET' | 'POST'; run: (userId: string, body: Record<string, unknown>, deps: WalletSecurityRouteDeps) => Promise<Record<string, unknown>> }> = {
  '/wallet/security': {
    method: 'GET',
    run: (userId) => getSecuritySummary(userId),
  },
  '/wallet/pin': {
    method: 'POST',
    run: async (userId, body) => {
      await setInitialPin(userId, body.pin);
      logActivity({ userId, eventType: 'wallet_pin_set', metadata: { via: 'app' } });
      return { ok: true };
    },
  },
  '/wallet/pin/reset/start': {
    method: 'POST',
    run: (userId, _body, deps) => startPinReset(deps, userId),
  },
  '/wallet/pin/reset/complete': {
    method: 'POST',
    run: async (userId, body, deps) => ({ ok: true, ...(await completePinReset(deps, userId, { code: body.code, newPin: body.newPin })) }),
  },
};

/** Returns false when the path is not one of ours. */
export async function handleWalletSecurityRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WalletSecurityRouteDeps,
  url: URL,
): Promise<boolean> {
  const route = ROUTES[url.pathname];
  if (!route) return false;
  if (req.method !== route.method) {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }

  res.setHeader('Cache-Control', 'no-store');
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const body = route.method === 'POST' ? await readJsonBody(req).catch(() => null) : {};
    if (!isRecord(body)) {
      sendJson(res, 400, { error: 'Body must be a JSON object', code: 'BAD_REQUEST' });
      return true;
    }
    sendJson(res, 200, await route.run(user.id, body, deps));
  } catch (error) {
    if (error instanceof HttpAuthError) {
      sendJson(res, 401, { error: error.message, code: 'UNAUTHENTICATED' });
    } else if (error instanceof PinFlowError) {
      sendJson(res, error.status, { error: error.message, code: error.code });
    } else if (error instanceof WalletSecurityError) {
      sendJson(res, error.code === 'PIN_LOCKED' ? 429 : 400, { error: error.message, code: error.code, ...error.details });
    } else {
      console.error(`${TAG} ${url.pathname} failed`, { error: error instanceof Error ? error.message : String(error) });
      sendJson(res, 500, { error: 'Something went wrong on our side. Please try again.', code: 'INTERNAL' });
    }
  }
  return true;
}
