import type { IncomingMessage, ServerResponse } from 'http';
import { userClient } from '@wheleers/db';
import { authenticateHttpUser, HttpAuthError } from './authenticate';
import { createLocalAccessToken, verifyLocalAccessToken } from '../auth/local';
import { sendJson } from './utils';
import { logActivity } from '../analytics/log-activity';
import type { RedisClient } from '../redis/client';

/**
 * Token blacklist: prefix + jti (token signature) stored in Redis
 * with TTL matching the token's remaining lifetime.
 */
const BLACKLIST_PREFIX = 'auth:blacklist:';

// Max token TTL is 30 days (from auth/local.ts TOKEN_TTL_SECONDS)
const MAX_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

function extractTokenSignature(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const [, token] = authorization.split(' ');
  if (!token) return null;
  // The signature is the last segment of the JWT
  const parts = token.split('.');
  return parts.length === 3 ? parts[2]! : null;
}

interface AccountRouteDeps {
  jwtSecret: string;
  redisClient: RedisClient;
}

/**
 * POST /auth/logout
 *
 * Blacklists the current token so it cannot be reused.
 * The frontend already clears the local token — this prevents
 * anyone who intercepted the token from using it after logout.
 */
export async function handleLogoutRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AccountRouteDeps,
): Promise<void> {
  try {
    // Authenticate to confirm this is a valid token
    const user = await authenticateHttpUser(req, deps.jwtSecret);

    // Blacklist the token signature in Redis
    const sig = extractTokenSignature(
      typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
    );

    if (sig) {
      const key = `${BLACKLIST_PREFIX}${sig}`;
      await deps.redisClient.set(key, '1', MAX_TOKEN_TTL_SECONDS);
    }

    logActivity({ userId: user.id, eventType: 'auth_logout' });

    sendJson(res, 200, { success: true });
  } catch (error) {
    sendJson(res, 401, {
      error: error instanceof Error ? error.message : 'Logout failed',
    });
  }
}

/**
 * POST /auth/refresh
 *
 * A signed-in phone swaps its login for a fresh 30-day one, so someone who
 * opens the app at least once a month is never asked to sign in again. Only
 * a login that is still valid can be renewed: not an expired one, not one
 * signed out (blacklisted), not a deleted account's. The old login is left to
 * expire on its own: if this answer is lost on a bad connection, the phone
 * still holds a working one.
 */
export async function handleRefreshRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AccountRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const sig = extractTokenSignature(
      typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
    );
    if (!sig || (await deps.redisClient.get(`${BLACKLIST_PREFIX}${sig}`))) {
      throw new HttpAuthError('This login was signed out.');
    }
    if (!user || user.privyDid?.startsWith('deleted:')) {
      throw new HttpAuthError('This account no longer exists.');
    }
    const accessToken = createLocalAccessToken(user.id, deps.jwtSecret);
    const { exp } = verifyLocalAccessToken(accessToken, deps.jwtSecret);
    sendJson(res, 200, { accessToken, expiresAt: new Date(exp * 1000).toISOString() });
  } catch (error) {
    if (error instanceof HttpAuthError) {
      sendJson(res, 401, { error: error.message, code: 'SESSION_ENDED' });
      return;
    }
    console.error('[auth] refresh failed', { error: error instanceof Error ? error.message : String(error) });
    sendJson(res, 500, { error: 'Could not renew the login right now.' });
  }
}

/**
 * POST /auth/delete-account
 *
 * Soft-deletes the authenticated user's account:
 * - Anonymizes all PII (name, email, phone, etc.)
 * - Clears auth credentials (password hash)
 * - Disables notification devices
 * - Revokes consents
 * - Blacklists the current token
 *
 * The user row is kept for referential integrity with rides, wallets, etc.
 */
export async function handleDeleteAccountRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AccountRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);

    // Soft-delete: anonymize PII and disable everything
    await userClient.softDelete(user.id);

    // Blacklist the current token
    const sig = extractTokenSignature(
      typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
    );

    if (sig) {
      const key = `${BLACKLIST_PREFIX}${sig}`;
      await deps.redisClient.set(key, '1', MAX_TOKEN_TTL_SECONDS);
    }

    console.info('[account] account deleted', { userId: user.id });

    logActivity({ userId: user.id, eventType: 'account_deleted' });

    sendJson(res, 200, { deleted: true });
  } catch (error) {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : 'Could not delete account',
    });
  }
}

/**
 * Check if a token signature is blacklisted.
 * Call this from authenticateHttpUser or middleware to reject revoked tokens.
 */
export async function isTokenBlacklisted(
  redisClient: RedisClient,
  authorization: string | undefined,
): Promise<boolean> {
  const sig = extractTokenSignature(authorization);
  if (!sig) return false;

  const result = await redisClient.get(`${BLACKLIST_PREFIX}${sig}`);
  return result !== null;
}
