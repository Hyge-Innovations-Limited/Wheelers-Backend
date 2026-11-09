import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { prisma, userClient } from '@wheleers/db';
import { logActivity } from '../analytics/log-activity';
import { createLocalAccessToken } from '../auth/local';
import type { RedisClient } from '../redis/client';
import { clientIp } from '../utils/client-ip';
import { getString, isRecord } from '../utils/object';
import { authenticateHttpUser } from './authenticate';
import { readJsonBody, sendJson } from './utils';

/**
 * Passkeys: signing in with Face ID or a fingerprint instead of an SMS code.
 *
 * The phone keeps a private key that only its owner's face or finger unlocks;
 * this server keeps the public half (the Passkey table). To sign in, the
 * server hands out a one-time challenge, the phone signs it, and the
 * signature is checked against the public key. Nothing stored here can sign
 * anyone in.
 *
 *   POST   /auth/passkey/register/options   signed in: a challenge to make a passkey with
 *   POST   /auth/passkey/register/verify    signed in: { response, deviceName } — the new passkey, checked and kept
 *   POST   /auth/passkey/login/options      a challenge to sign in with: { challengeId, options }
 *   POST   /auth/passkey/login/verify       { challengeId, response } — the same answer as signing in by SMS
 *   GET    /auth/passkeys                   signed in: this account's passkeys
 *   DELETE /auth/passkeys/:id               signed in: remove one
 *
 * Challenges live five minutes and work once. The passkey belongs to the
 * website's name (PASSKEY_RP_ID, wheelersng.com): the app proves it may use
 * that name through files the website serves (.well-known), and the answers
 * it signs carry an origin that must be one of PASSKEY_ORIGINS.
 */

interface PasskeyDeps {
  jwtSecret: string;
  redisClient: RedisClient;
}

const CHALLENGE_TTL_SECONDS = 5 * 60;
const LOGIN_TRIES_PER_MINUTE = 20;

const rpId = () => (process.env['PASSKEY_RP_ID'] ?? 'wheelersng.com').trim();
/**
 * Where a signed answer may come from: the website, and each Android build by
 * its signing key ("android:apk-key-hash:<base64url SHA-256>"). iPhones sign
 * as the website itself.
 */
const origins = () =>
  (process.env['PASSKEY_ORIGINS'] ?? `https://${rpId()}`)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

const regKey = (userId: string) => `passkey:register:${userId}`;
const authKey = (challengeId: string) => `passkey:login:${challengeId}`;
const triesKey = (ip: string) => `passkey:login-tries:${ip}`;

function refuse(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: message, code });
}

async function takeOnce(redis: RedisClient, key: string): Promise<string | null> {
  const value = await redis.get(key).catch(() => null);
  if (value) await redis.del(key).catch(() => undefined);
  return value;
}

export async function handlePasskeyRoute(req: IncomingMessage, res: ServerResponse, deps: PasskeyDeps, url: URL): Promise<boolean> {
  const path = url.pathname;
  const isPasskeyPath = path.startsWith('/auth/passkey/') || path === '/auth/passkeys' || path.startsWith('/auth/passkeys/');
  if (!isPasskeyPath) return false;

  try {
    if (path === '/auth/passkey/login/options' && req.method === 'POST') {
      // A little brake on anyone asking for challenges in a loop.
      const ip = clientIp(req) ?? 'unknown';
      const tries = Number((await deps.redisClient.send('INCR', triesKey(ip)).catch(() => 1)) ?? 1);
      if (tries === 1) await deps.redisClient.send('EXPIRE', triesKey(ip), '60').catch(() => undefined);
      if (tries > LOGIN_TRIES_PER_MINUTE) {
        refuse(res, 429, 'SLOW_DOWN', 'Too many tries. Please wait a minute and try again.');
        return true;
      }
      // No user named: the phone offers whichever Wheelers passkey it holds.
      const options = await generateAuthenticationOptions({ rpID: rpId(), userVerification: 'required', allowCredentials: [] });
      const challengeId = randomUUID();
      await deps.redisClient.set(authKey(challengeId), options.challenge, CHALLENGE_TTL_SECONDS);
      sendJson(res, 200, { challengeId, options });
      return true;
    }

    if (path === '/auth/passkey/login/verify' && req.method === 'POST') {
      const body = await readJsonBody(req).catch(() => null);
      const challengeId = isRecord(body) ? getString(body, 'challengeId') : undefined;
      const response = isRecord(body) && isRecord(body['response']) ? (body['response'] as Record<string, unknown>) : null;
      const expectedChallenge = challengeId ? await takeOnce(deps.redisClient, authKey(challengeId)) : null;
      if (!expectedChallenge || !response || typeof response['id'] !== 'string') {
        refuse(res, 400, 'PASSKEY_EXPIRED', 'That took too long. Try signing in with your passkey again.');
        return true;
      }
      const passkey = await prisma.passkey.findUnique({ where: { credentialId: response['id'] } });
      if (!passkey) {
        refuse(res, 401, 'PASSKEY_UNKNOWN', 'This passkey is not on a Wheelers account any more. Sign in with your phone number.');
        return true;
      }
      const result = await verifyAuthenticationResponse({
        response: response as never,
        expectedChallenge,
        expectedOrigin: origins(),
        expectedRPID: rpId(),
        requireUserVerification: true,
        credential: {
          id: passkey.credentialId,
          publicKey: new Uint8Array(passkey.publicKey),
          counter: Number(passkey.counter),
          transports: passkey.transports as never,
        },
      }).catch(() => ({ verified: false as const, authenticationInfo: undefined }));
      if (!result.verified || !result.authenticationInfo) {
        refuse(res, 401, 'PASSKEY_REFUSED', 'We could not sign you in with that passkey. Sign in with your phone number.');
        return true;
      }
      await prisma.passkey.update({
        where: { id: passkey.id },
        data: { counter: BigInt(result.authenticationInfo.newCounter), lastUsedAt: new Date() },
      });
      const user = await userClient.findById(passkey.userId);
      if (!user) {
        refuse(res, 401, 'PASSKEY_UNKNOWN', 'This passkey is not on a Wheelers account any more. Sign in with your phone number.');
        return true;
      }
      logActivity({ userId: user.id, eventType: 'passkey_login', metadata: { device: passkey.deviceName ?? null } });
      // The same answer as signing in by SMS, so the app goes on exactly as it does after a code.
      sendJson(res, 200, {
        accessToken: createLocalAccessToken(user.id, deps.jwtSecret),
        tokenType: 'Bearer',
        isNewUser: false,
        privacyConsent: await userClient.getPrivacyConsent(user.id).catch(() => 'PENDING'),
        user: { id: user.id, privyDid: user.privyDid, username: user.username ?? null, email: user.email, role: user.role, name: user.name, phone: user.phone },
      });
      return true;
    }

    // Everything below is for someone signed in.
    let user: Awaited<ReturnType<typeof authenticateHttpUser>>;
    try {
      user = await authenticateHttpUser(req, deps.jwtSecret);
    } catch {
      refuse(res, 401, 'SIGN_IN_AGAIN', 'Please sign in again.');
      return true;
    }

    if (path === '/auth/passkey/register/options' && req.method === 'POST') {
      const existing = await prisma.passkey.findMany({ where: { userId: user.id }, select: { credentialId: true, transports: true } });
      const options = await generateRegistrationOptions({
        rpName: 'Wheelers',
        rpID: rpId(),
        userID: new TextEncoder().encode(user.id),
        userName: user.phone ?? user.email ?? user.id,
        userDisplayName: user.name ?? 'Wheelers',
        attestationType: 'none',
        // The same phone twice is one passkey.
        excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports as never })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      });
      await deps.redisClient.set(regKey(user.id), options.challenge, CHALLENGE_TTL_SECONDS);
      sendJson(res, 200, options as unknown as Record<string, unknown>);
      return true;
    }

    if (path === '/auth/passkey/register/verify' && req.method === 'POST') {
      const body = await readJsonBody(req).catch(() => null);
      const response = isRecord(body) && isRecord(body['response']) ? (body['response'] as Record<string, unknown>) : null;
      const deviceName = (isRecord(body) ? getString(body, 'deviceName') : undefined)?.trim().slice(0, 60) || null;
      const expectedChallenge = await takeOnce(deps.redisClient, regKey(user.id));
      if (!expectedChallenge || !response) {
        refuse(res, 400, 'PASSKEY_EXPIRED', 'That took too long. Try making the passkey again.');
        return true;
      }
      const result = await verifyRegistrationResponse({
        response: response as never,
        expectedChallenge,
        expectedOrigin: origins(),
        expectedRPID: rpId(),
        requireUserVerification: true,
      }).catch(() => ({ verified: false as const, registrationInfo: undefined }));
      if (!result.verified || !result.registrationInfo) {
        refuse(res, 400, 'PASSKEY_REFUSED', 'The passkey could not be set up. Please try again.');
        return true;
      }
      const { credential } = result.registrationInfo;
      const saved = await prisma.passkey.upsert({
        where: { credentialId: credential.id },
        create: {
          userId: user.id,
          credentialId: credential.id,
          publicKey: Buffer.from(credential.publicKey),
          counter: BigInt(credential.counter),
          transports: credential.transports ?? [],
          deviceName,
        },
        update: {},
      });
      if (saved.userId !== user.id) {
        refuse(res, 409, 'PASSKEY_TAKEN', 'That passkey belongs to another account.');
        return true;
      }
      logActivity({ userId: user.id, eventType: 'passkey_created', metadata: { device: deviceName } });
      sendJson(res, 200, { id: saved.id, deviceName: saved.deviceName, createdAt: saved.createdAt.toISOString() });
      return true;
    }

    if (path === '/auth/passkeys' && req.method === 'GET') {
      const passkeys = await prisma.passkey.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
      sendJson(res, 200, {
        passkeys: passkeys.map((p) => ({ id: p.id, deviceName: p.deviceName, createdAt: p.createdAt.toISOString(), lastUsedAt: p.lastUsedAt?.toISOString() ?? null })),
      });
      return true;
    }

    const removing = path.match(/^\/auth\/passkeys\/([0-9a-f-]{36})$/);
    if (removing && req.method === 'DELETE') {
      const gone = await prisma.passkey.deleteMany({ where: { id: removing[1], userId: user.id } });
      if (gone.count === 0) {
        refuse(res, 404, 'NOT_FOUND', 'That passkey is already gone.');
        return true;
      }
      logActivity({ userId: user.id, eventType: 'passkey_removed' });
      sendJson(res, 200, { removed: true });
      return true;
    }

    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  } catch (error) {
    console.error('[passkey] failed', { path, error: error instanceof Error ? error.message : String(error) });
    refuse(res, 500, 'PASSKEY_FAILED', 'Passkeys are not working right now. Sign in with your phone number.');
    return true;
  }
}
