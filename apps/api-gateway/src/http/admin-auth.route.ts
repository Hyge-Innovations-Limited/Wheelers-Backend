import type { IncomingMessage, ServerResponse } from 'http';
import { adminClient } from '@wheleers/db';
import { hashPassword, verifyPassword, createLocalAccessToken, verifyLocalAccessToken } from '../auth/local';
import { isRecord, getString } from '../utils/object';
import { readJsonBody, sendJson } from './utils';
import { adminMarkCode, clientIp, recordAdminActivity, type AdminRoleName } from '../admin/activity';

/** Who is asking: their ID (null for the bootstrap key), name and role. */
export interface AdminAuth {
  adminId: string | null;
  adminName: string;
  role: AdminRoleName;
}

/** An admin login lasts two hours; then the dashboard asks for the password again. */
export const ADMIN_SESSION_SECONDS = 2 * 60 * 60;

interface AdminAuthDeps {
  jwtSecret: string;
  adminApiKey: string;
}

/**
 * POST /admin/login
 * Authenticates an admin user with username/password.
 * Returns a JWT access token.
 */
export async function handleAdminLoginRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminAuthDeps,
): Promise<void> {
  try {
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const username = getString(rawBody, 'username')?.trim().toLowerCase();
    const password = getString(rawBody, 'password');

    if (!username || !password) {
      sendJson(res, 400, { error: 'username and password are required' });
      return;
    }

    const admin = await adminClient.findByUsername(username);
    const valid = admin?.active ? await verifyPassword(password, admin.passwordHash) : false;
    if (!admin || !admin.active || !valid) {
      recordAdminActivity({ adminId: admin?.id ?? null, adminName: admin?.name ?? username, kind: 'login-failed', ip: clientIp(req), detail: { username } });
      sendJson(res, 401, { error: 'Invalid username or password' });
      return;
    }
    recordAdminActivity({ adminId: admin.id, adminName: admin.name, kind: 'login', ip: clientIp(req) });

    const accessToken = createLocalAccessToken(admin.id, deps.jwtSecret, ADMIN_SESSION_SECONDS);

    sendJson(res, 200, {
      accessToken,
      tokenType: 'Bearer',
      // The dashboard logs out on its own at this moment; the server refuses the token after it anyway.
      expiresAt: new Date(Date.now() + ADMIN_SESSION_SECONDS * 1000).toISOString(),
      admin: {
        id: admin.id,
        username: admin.username,
        name: admin.name,
        role: admin.role,
        markCode: adminMarkCode(admin.id, deps.jwtSecret),
      },
    });
  } catch (error) {
    console.error('[admin-auth] login failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    sendJson(res, 500, { error: 'Login failed' });
  }
}

/**
 * POST /admin/create-admin
 * Creates a new admin user. Requires x-admin-key header (bootstrap key).
 * This is how you create the first admin users.
 *
 * Body: { username, password, name }
 */
export async function handleCreateAdminRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminAuthDeps,
): Promise<void> {
  // Only the bootstrap API key can create admin users
  const key = req.headers['x-admin-key'] as string | undefined;
  if (key !== deps.adminApiKey || !deps.adminApiKey) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  try {
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const username = getString(rawBody, 'username')?.trim().toLowerCase();
    const password = getString(rawBody, 'password');
    const name = getString(rawBody, 'name')?.trim();
    // New admins are staff unless the bootstrap call says otherwise.
    const role: AdminRoleName = getString(rawBody, 'role') === 'OWNER' ? 'OWNER' : 'STAFF';

    if (!username || !password || !name) {
      sendJson(res, 400, { error: 'username, password, and name are required' });
      return;
    }

    if (username.length < 3 || !/^[a-z][a-z0-9_]*$/.test(username)) {
      sendJson(res, 400, { error: 'Username must be 3+ chars, lowercase, starting with a letter' });
      return;
    }

    if (password.length < 8) {
      sendJson(res, 400, { error: 'Password must be at least 8 characters' });
      return;
    }

    const existing = await adminClient.findByUsername(username);
    if (existing) {
      sendJson(res, 409, { error: 'Username already taken' });
      return;
    }

    const passwordHash = await hashPassword(password);
    const admin = await adminClient.create({ username, passwordHash, name, role });

    sendJson(res, 201, {
      admin: {
        id: admin.id,
        username: admin.username,
        name: admin.name,
        role: admin.role,
      },
    });
  } catch (error) {
    console.error('[admin-auth] create admin failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    sendJson(res, 500, { error: 'Failed to create admin' });
  }
}

/**
 * Extracts and verifies admin user from Bearer token.
 * Returns admin ID or null.
 */
export function extractAdminId(req: IncomingMessage, jwtSecret: string): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;

  try {
    const payload = verifyLocalAccessToken(authHeader.slice(7), jwtSecret);
    // Two hours from login, whatever the token says: admin tokens issued
    // before sessions were short carry a 30-day expiry.
    if (Math.floor(Date.now() / 1000) - payload.iat > ADMIN_SESSION_SECONDS) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

/**
 * Verifies the request is from an authenticated admin (JWT) or has the bootstrap API key.
 * Returns the admin's name for audit logging, or null if unauthorized.
 */
export async function verifyAdminAuth(
  req: IncomingMessage,
  deps: AdminAuthDeps,
): Promise<AdminAuth | null> {
  // Try JWT first
  const adminId = extractAdminId(req, deps.jwtSecret);
  if (adminId) {
    const admin = await adminClient.findById(adminId);
    if (admin?.active) {
      return { adminId: admin.id, adminName: admin.name, role: admin.role };
    }
  }

  // Fall back to API key (bootstrap): it can do anything an owner can.
  const key = req.headers['x-admin-key'] as string | undefined;
  if (key === deps.adminApiKey && deps.adminApiKey) {
    return { adminId: null, adminName: 'api-key', role: 'OWNER' };
  }

  return null;
}
