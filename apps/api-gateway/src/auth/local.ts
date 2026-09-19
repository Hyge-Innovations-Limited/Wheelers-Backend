import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { isRecord } from '../utils/object';

const scrypt = promisify(scryptCallback);
const TOKEN_TYPE = 'wheelers.local.auth';
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

interface LocalTokenPayload {
  sub: string;
  typ: typeof TOKEN_TYPE;
  iat: number;
  exp: number;
}

function base64UrlEncode(value: Buffer | string): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, 'base64');
}

function sign(input: string, secret: string): string {
  return base64UrlEncode(createHmac('sha256', secret).update(input).digest());
}

function requireSecret(secret: string | undefined): string {
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be set to at least 32 characters for username/password auth.');
  }

  return secret;
}

function parsePayload(value: unknown): LocalTokenPayload {
  if (!isRecord(value)) {
    throw new Error('Invalid local auth token payload.');
  }

  const { sub, typ, iat, exp } = value;
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new Error('Local auth token is missing subject.');
  }
  if (typ !== TOKEN_TYPE) {
    throw new Error('Local auth token type is invalid.');
  }
  if (typeof iat !== 'number' || typeof exp !== 'number') {
    throw new Error('Local auth token expiry is invalid.');
  }

  return { sub, typ, iat, exp };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('base64url');
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, storedHash: string | null | undefined): Promise<boolean> {
  if (!storedHash) {
    return false;
  }

  const [scheme, salt, expectedHash] = storedHash.split('$');
  if (scheme !== 'scrypt' || !salt || !expectedHash) {
    return false;
  }

  const expected = Buffer.from(expectedHash, 'base64url');
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createLocalAccessToken(userId: string, jwtSecret: string | undefined): string {
  const secret = requireSecret(jwtSecret);
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(JSON.stringify({
    sub: userId,
    typ: TOKEN_TYPE,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  } satisfies LocalTokenPayload));
  const unsigned = `${header}.${payload}`;

  return `${unsigned}.${sign(unsigned, secret)}`;
}

export function verifyLocalAccessToken(token: string, jwtSecret: string | undefined): LocalTokenPayload {
  const secret = requireSecret(jwtSecret);
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) {
    throw new Error('Invalid local auth token format.');
  }

  const unsigned = `${header}.${payload}`;
  const expected = sign(unsigned, secret);
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  if (
    expectedBuffer.length !== signatureBuffer.length ||
    !timingSafeEqual(expectedBuffer, signatureBuffer)
  ) {
    throw new Error('Local auth token signature verification failed.');
  }

  const parsed = parsePayload(JSON.parse(base64UrlDecode(payload).toString('utf8')));
  const now = Math.floor(Date.now() / 1000);
  if (parsed.exp <= now) {
    throw new Error('Local auth token is expired.');
  }

  return parsed;
}

/* ── Scoped page tokens ───────────────────────────────────────────────────
 * A link sent into a chat can be forwarded, screenshotted, or left open on a
 * shared phone, so it must be worth very little: it names ONE purpose, lives
 * for minutes, and — because its `typ` differs — can never be accepted where a
 * login token is expected (nor the reverse).
 */
const PAGE_TOKEN_TYPE = 'wheelers.wallet.page';

export type WalletPageScope = 'deposit' | 'withdraw';

interface WalletPageTokenPayload {
  sub: string;
  typ: typeof PAGE_TOKEN_TYPE;
  scope: WalletPageScope;
  iat: number;
  exp: number;
}

export const WALLET_PAGE_TOKEN_TTL_SECONDS = 15 * 60;

export function createWalletPageToken(
  userId: string,
  scope: WalletPageScope,
  jwtSecret: string | undefined,
  ttlSeconds: number = WALLET_PAGE_TOKEN_TTL_SECONDS,
): string {
  const secret = requireSecret(jwtSecret);
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(JSON.stringify({
    sub: userId,
    typ: PAGE_TOKEN_TYPE,
    scope,
    iat: now,
    exp: now + ttlSeconds,
  } satisfies WalletPageTokenPayload));
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${sign(unsigned, secret)}`;
}

export function verifyWalletPageToken(
  token: string,
  jwtSecret: string | undefined,
): { userId: string; scope: WalletPageScope } {
  const secret = requireSecret(jwtSecret);
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) {
    throw new Error('Invalid page token format.');
  }
  const unsigned = `${header}.${payload}`;
  const expectedBuffer = Buffer.from(sign(unsigned, secret));
  const signatureBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== signatureBuffer.length || !timingSafeEqual(expectedBuffer, signatureBuffer)) {
    throw new Error('Page token signature verification failed.');
  }

  const parsed: unknown = JSON.parse(base64UrlDecode(payload).toString('utf8'));
  if (!isRecord(parsed) || parsed.typ !== PAGE_TOKEN_TYPE) {
    throw new Error('Page token type is invalid.');
  }
  const { sub, scope, exp } = parsed;
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new Error('Page token is missing subject.');
  }
  if (scope !== 'deposit' && scope !== 'withdraw') {
    throw new Error('Page token scope is invalid.');
  }
  if (typeof exp !== 'number' || exp <= Math.floor(Date.now() / 1000)) {
    throw new Error('This link has expired.');
  }
  return { userId: sub, scope };
}
