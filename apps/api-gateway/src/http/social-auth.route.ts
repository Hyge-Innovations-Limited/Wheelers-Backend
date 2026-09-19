import type { IncomingMessage, ServerResponse } from 'http';
import { createPublicKey, createVerify } from 'crypto';
import { UserRole, userClient, driverClient, walletClient } from '@wheleers/db';
import type { PaymentsClient } from '@wheleers/payments';
import { createLocalAccessToken } from '../auth/local';
import { provisionDepositAccount } from '../onboarding/user-onboarding';
import { isRecord, getString } from '../utils/object';
import { readJsonBody, sendJson } from './utils';
import { logActivity } from '../analytics/log-activity';
import { sendEmail } from '../email/resend';
import { buildWelcomeDriverEmail } from '../email/templates';

interface SocialAuthDeps {
  jwtSecret: string;
  appleBundleId?: string;
  googleClientId?: string;
  paymentsClient?: PaymentsClient;
  resendApiKey?: string;
}

// ------------------------------------------------------------------
// Lightweight JWT helpers (no external dep — only need RS256 verify)
// ------------------------------------------------------------------

interface JwtHeader {
  alg: string;
  kid?: string;
}

interface JwtPayload {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  email?: string;
  name?: string;
  email_verified?: boolean;
}

function base64UrlDecode(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, 'base64');
}

function decodeJwt(token: string): { header: JwtHeader; payload: JwtPayload; signedPart: string; signature: Buffer } {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');

  const header = JSON.parse(base64UrlDecode(parts[0]!).toString('utf8')) as JwtHeader;
  const payload = JSON.parse(base64UrlDecode(parts[1]!).toString('utf8')) as JwtPayload;
  const signedPart = `${parts[0]}.${parts[1]}`;
  const signature = base64UrlDecode(parts[2]!);

  return { header, payload, signedPart, signature };
}

// ------------------------------------------------------------------
// JWKS cache (fetches public keys from Apple/Google)
// ------------------------------------------------------------------

interface JwkKey {
  kty: string;
  kid: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  crv?: string;
}

const jwksCache = new Map<string, { keys: JwkKey[]; fetchedAt: number }>();
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function fetchJwks(url: string): Promise<JwkKey[]> {
  const cached = jwksCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < JWKS_CACHE_TTL_MS) {
    return cached.keys;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch JWKS from ${url}: ${response.status}`);
  }

  const body = await response.json() as { keys: JwkKey[] };
  const keys = body.keys ?? [];
  jwksCache.set(url, { keys, fetchedAt: Date.now() });
  return keys;
}

function verifyRsaSignature(signedPart: string, signature: Buffer, jwk: JwkKey): boolean {
  const keyObject = createPublicKey({ key: jwk, format: 'jwk' });
  const verifier = createVerify('RSA-SHA256');
  verifier.update(signedPart);
  return verifier.verify(keyObject, signature);
}

// ------------------------------------------------------------------
// Apple ID Token Verification
// ------------------------------------------------------------------

const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';

/**
 * Split the configured bundle id(s).
 *
 * Wheelers ships two iOS apps from one backend — `com.timmy133.wheelers` for
 * riders and `com.timmy133.wheelers.driver` for drivers — and Apple stamps the
 * app's own bundle id into the token's `aud`. A single configured value can
 * therefore only ever verify one of the two; the other gets "Invalid Apple
 * token audience" and Sign in with Apple looks broken in that app.
 *
 * `APPLE_BUNDLE_ID` accepts a comma-separated list for exactly this reason.
 */
function allowedAppleAudiences(configured: string): string[] {
  return configured
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function verifyAppleToken(idToken: string, bundleId: string): Promise<{ sub: string; email?: string; name?: string }> {
  const { header, payload, signedPart, signature } = decodeJwt(idToken);

  if (header.alg !== 'RS256') {
    throw new Error('Unsupported Apple token algorithm');
  }

  // Verify issuer
  if (payload.iss !== 'https://appleid.apple.com') {
    throw new Error('Invalid Apple token issuer');
  }

  // Verify audience against every bundle we ship.
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const allowed = allowedAppleAudiences(bundleId);
  if (!aud.some((entry) => allowed.includes(String(entry)))) {
    // Name both sides: "invalid audience" with neither value in it is the kind
    // of error that costs an afternoon.
    throw new Error(
      `Apple token audience ${aud.join(', ')} is not one of the configured bundle ids (${allowed.join(', ')}). Add it to APPLE_BUNDLE_ID.`,
    );
  }

  // Verify expiry
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Apple token expired');
  }

  // Verify signature with JWKS
  const keys = await fetchJwks(APPLE_JWKS_URL);
  const key = keys.find((k) => k.kid === header.kid);
  if (!key) {
    throw new Error('Apple signing key not found');
  }

  if (!verifyRsaSignature(signedPart, signature, key)) {
    throw new Error('Apple token signature verification failed');
  }

  if (!payload.sub) {
    throw new Error('Apple token missing subject');
  }

  return {
    sub: payload.sub,
    email: payload.email,
    name: undefined, // Apple sends name only on first auth — handled by client
  };
}

// ------------------------------------------------------------------
// Google ID Token Verification
// ------------------------------------------------------------------

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

async function verifyGoogleToken(idToken: string, clientId: string): Promise<{ sub: string; email?: string; name?: string; emailVerified?: boolean }> {
  const { header, payload, signedPart, signature } = decodeJwt(idToken);

  if (header.alg !== 'RS256') {
    throw new Error('Unsupported Google token algorithm');
  }

  // Verify issuer
  if (!payload.iss || !GOOGLE_ISSUERS.includes(payload.iss)) {
    throw new Error('Invalid Google token issuer');
  }

  // Verify audience against every client we ship.
  //
  // Google stamps the *web* client id into the token when the app configures
  // one, but rider and driver can be registered as separate OAuth clients — and
  // a native iOS client issues its own id instead. A single configured value
  // therefore locks out whichever app is not it, exactly as the Apple bundle id
  // used to. `GOOGLE_CLIENT_ID` accepts a comma-separated list.
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const allowed = clientId
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (!aud.some((entry) => allowed.includes(String(entry)))) {
    throw new Error(
      `Google token audience ${aud.join(', ')} is not one of the configured client ids (${allowed.join(', ')}). Add it to GOOGLE_CLIENT_ID.`,
    );
  }

  // Verify expiry
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Google token expired');
  }

  // Verify signature with JWKS
  const keys = await fetchJwks(GOOGLE_JWKS_URL);
  const key = keys.find((k) => k.kid === header.kid);
  if (!key) {
    throw new Error('Google signing key not found');
  }

  if (!verifyRsaSignature(signedPart, signature, key)) {
    throw new Error('Google token signature verification failed');
  }

  if (!payload.sub) {
    throw new Error('Google token missing subject');
  }

  return {
    sub: payload.sub,
    email: payload.email,
    name: payload.name,
    emailVerified: payload.email_verified !== false,
  };
}


/**
 * Test seam for Google/Apple token verification.
 *
 * Verifying a real id_token needs Apple's and Google's live JWKS, which a test
 * cannot and should not reach. Tests substitute a verifier here so the branch
 * under test is our own find-or-create logic, not someone else's crypto.
 * Always null in production.
 */
type TokenVerifier = (idToken: string) => Promise<{ sub: string; email?: string; name?: string; emailVerified?: boolean }>;
let testTokenVerifier: TokenVerifier | null = null;

export function __setTokenVerifierForTests(verifier: TokenVerifier | null): void {
  testTokenVerifier = verifier;
}

// ------------------------------------------------------------------
// Shared: find-or-create user + driver record
// ------------------------------------------------------------------

/** Apps send "rider"/"driver"; anything unrecognised signs up as a rider. */
function parseSocialRole(value: string | undefined): UserRole {
  switch ((value ?? '').trim().toUpperCase()) {
    case 'DRIVER':
      return UserRole.DRIVER;
    case 'BOTH':
      return UserRole.BOTH;
    default:
      return UserRole.RIDER;
  }
}

/**
 * Google and Apple sign-in for both sides of the marketplace.
 *
 * This used to hardcode `role: DRIVER` and always create a Driver record, so a
 * rider signing up with Google silently became a driver. The role is a
 * parameter now and defaults to RIDER — the rider app is the bigger audience,
 * and a driver has to go through KYC anyway.
 */
async function findOrCreateSocialUser(
  provider: 'apple' | 'google',
  sub: string,
  email?: string,
  name?: string,
  emailVerified = true,
  jwtSecret?: string,
  paymentsClient?: PaymentsClient,
  resendApiKey?: string,
  role: UserRole = UserRole.RIDER,
): Promise<{ accessToken: string; user: Record<string, unknown>; userId: string; isNewUser: boolean }> {
  const privyDid = `${provider}:${sub}`;

  let existing = await userClient.findByPrivyDid(privyDid);
  if (!existing && email && emailVerified) {
    // Same person, different door. An account created with email/password
    // (or the other provider) has a different privyDid — looking up only by
    // privyDid minted a DUPLICATE user with an empty driver profile, so
    // "Continue with Google" restarted onboarding for people who already
    // had an account. A provider-verified email is the same identity: sign
    // into the existing account instead of creating a twin.
    existing = await userClient.findByEmail(email);
  }
  let isNewUser = false;
  let userId: string;
  let userRecord: { id: string; privyDid: string; email: string | null; role: UserRole; name: string | null; phone: string | null };

  if (existing) {
    userId = existing.id;
    userRecord = existing;
  } else {
    const created = await userClient.create({
      privyDid,
      email: email ?? undefined,
      role,
      name: name ?? undefined,
    });
    userId = created.id;
    userRecord = created;
    isNewUser = true;

    // Only drivers get a Driver record; a rider does not need one.
    if (role === UserRole.DRIVER || role === UserRole.BOTH) {
      await driverClient.create(userId);
    }

    // Create fiat wallet
    await walletClient.create(userId).catch((error) => {
      console.warn('[social-auth] wallet creation failed (non-blocking)', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    // Send welcome email to new drivers
    if (email && resendApiKey && (role === UserRole.DRIVER || role === UserRole.BOTH)) {
      const welcome = buildWelcomeDriverEmail(name);
      void sendEmail({ to: email, ...welcome }, resendApiKey).catch((err) => {
        console.warn('[social-auth] welcome email failed (non-blocking)', {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  // Provision virtual account in background (for both new and existing users)
  if (paymentsClient) {
    void provisionDepositAccount(
      paymentsClient,
      userId,
      name ?? userRecord.name ?? undefined,
    ).catch((error) => {
      const errorDetail = error instanceof Error
        ? { message: error.message, name: error.name, ...(error as any).status && { status: (error as any).status } }
        : error;
      console.warn('[social-auth] deposit account provisioning failed (non-blocking)', {
        userId,
        error: JSON.stringify(errorDetail),
      });
    });
  }

  const accessToken = createLocalAccessToken(userId, jwtSecret);

  return {
    accessToken,
    userId,
    user: {
      id: userRecord.id,
      privyDid: userRecord.privyDid,
      email: userRecord.email,
      role: userRecord.role,
      name: userRecord.name,
      phone: userRecord.phone,
      isNewUser,
    },
    isNewUser,
  };
}

// ------------------------------------------------------------------
// Route Handlers
// ------------------------------------------------------------------

export async function handleAppleAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SocialAuthDeps,
): Promise<void> {
  try {
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const idToken = getString(rawBody, 'idToken');
    const clientName = getString(rawBody, 'name'); // Apple sends name from client on first auth
    const role = parseSocialRole(getString(rawBody, 'role'));

    if (!idToken) {
      sendJson(res, 400, { error: 'idToken is required' });
      return;
    }

    if (!deps.appleBundleId) {
      console.error(
        '[social-auth] APPLE_BUNDLE_ID is not set — Sign in with Apple cannot verify any token.',
      );
      sendJson(res, 500, {
        error: 'Signing in with Apple is unavailable right now. Please use Google or email.',
      });
      return;
    }

    const verified = testTokenVerifier
      ? await testTokenVerifier(idToken)
      : await verifyAppleToken(idToken, deps.appleBundleId);
    const result = await findOrCreateSocialUser(
      'apple',
      verified.sub,
      verified.email,
      clientName ?? verified.name,
      true,
      deps.jwtSecret,
      deps.paymentsClient,
      deps.resendApiKey,
      role,
    );

    logActivity({
      userId: result.userId,
      eventType: 'auth_login',
      metadata: { method: 'apple', isNewUser: result.isNewUser },
    });

    sendJson(res, 200, {
      accessToken: result.accessToken,
      tokenType: 'Bearer',
      user: result.user,
    });
  } catch (error) {
    console.warn('[auth/apple] verification failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    sendJson(res, 401, {
      error: error instanceof Error ? error.message : 'Apple authentication failed',
    });
  }
}

export async function handleGoogleAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SocialAuthDeps,
): Promise<void> {
  try {
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const idToken = getString(rawBody, 'idToken');
    const role = parseSocialRole(getString(rawBody, 'role'));

    if (!idToken) {
      sendJson(res, 400, { error: 'idToken is required' });
      return;
    }

    if (!deps.googleClientId) {
      console.error(
        '[social-auth] GOOGLE_CLIENT_ID is not set — Sign in with Google cannot verify any token.',
      );
      sendJson(res, 500, { error: 'Google auth not configured' });
      return;
    }

    const verified = testTokenVerifier
      ? await testTokenVerifier(idToken)
      : await verifyGoogleToken(idToken, deps.googleClientId);
    const result = await findOrCreateSocialUser(
      'google',
      verified.sub,
      verified.email,
      verified.name,
      verified.emailVerified ?? true,
      deps.jwtSecret,
      deps.paymentsClient,
      deps.resendApiKey,
      role,
    );

    logActivity({
      userId: result.userId,
      eventType: 'auth_login',
      metadata: { method: 'google', isNewUser: result.isNewUser },
    });

    sendJson(res, 200, {
      accessToken: result.accessToken,
      tokenType: 'Bearer',
      user: result.user,
    });
  } catch (error) {
    console.warn('[auth/google] verification failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    sendJson(res, 401, {
      error: error instanceof Error ? error.message : 'Google authentication failed',
    });
  }
}
