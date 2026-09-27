import type { IncomingMessage, ServerResponse } from 'http';
import { userClient } from '@wheleers/db';
import { createLocalAccessToken } from '../auth/local';
import { logActivity } from '../analytics/log-activity';
import {
  buildWhatsappPrivyDid,
  onboardWhatsappUser,
  type UserOnboardingDeps,
} from '../onboarding/user-onboarding';
import { getString, isRecord } from '../utils/object';
import {
  buildOtpCode,
  hashOtp,
  isProviderManagedOtp,
  normalizePhoneNumber,
  OtpDeliveryError,
  sendPhoneOtpMessage,
  timingSafeStringEquals,
  verifyProviderManagedOtp,
  type PhoneRouteDeps,
} from './phone.route';
import { readJsonBody, sendJson } from './utils';

/**
 * Passwordless sign-in by phone number — the identity WhatsApp riders already
 * have. Unlike /auth/phone/{send,verify}-otp (which verify a phone on an
 * already signed-in account) these routes are unauthenticated and END in a
 * session: the code proves control of the number, and the caller gets the
 * same account the WhatsApp bot uses for that number (created the same way
 * if it does not exist yet).
 */

const LOGIN_OTP_KEY_PREFIX = 'auth:phone-login:otp:';
const LOGIN_SEND_COUNT_PREFIX = 'auth:phone-login:sends:';
const LOGIN_OTP_TTL_SECONDS = 300;
const MAX_SENDS_PER_WINDOW = 5;
const SEND_WINDOW_SECONDS = 600;
const MAX_VERIFY_ATTEMPTS = 5;

export interface PhoneLoginRouteDeps extends PhoneRouteDeps {
  onboarding: UserOnboardingDeps;
}

interface StoredLoginOtp {
  codeHash: string;
  attempts: number;
}

function otpKey(phone: string): string {
  return `${LOGIN_OTP_KEY_PREFIX}${phone}`;
}

function sendCountKey(phone: string): string {
  return `${LOGIN_SEND_COUNT_PREFIX}${phone}`;
}

async function readStoredLoginOtp(deps: PhoneRouteDeps, phone: string): Promise<StoredLoginOtp | null> {
  const raw = await deps.redisClient.get(otpKey(phone));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredLoginOtp>;
    if (typeof parsed.codeHash !== 'string') return null;
    return { codeHash: parsed.codeHash, attempts: typeof parsed.attempts === 'number' ? parsed.attempts : 0 };
  } catch {
    return null;
  }
}

/**
 * Same number, same person, one account — in this order:
 *  1. the WhatsApp identity for the number (`whatsapp:+234…`), the account the
 *     bot has been using;
 *  2. an app account that verified this number;
 *  3. otherwise create the WhatsApp identity exactly as a first message would.
 */
async function resolveUserForPhone(
  phone: string,
  onboarding: UserOnboardingDeps,
): Promise<{ user: { id: string; privyDid: string; email: string | null; role: string; name: string | null; phone: string | null; username?: string | null }; created: boolean }> {
  const whatsappUser = await userClient.findByPrivyDid(buildWhatsappPrivyDid(phone));
  if (whatsappUser) {
    return { user: whatsappUser, created: false };
  }

  const verifiedUser = await userClient.findByPhone(phone);
  if (verifiedUser) {
    return { user: verifiedUser, created: false };
  }

  const onboarded = await onboardWhatsappUser({ phone, deps: onboarding });
  const user = await userClient.findById(onboarded.id);
  return { user, created: onboarded.created };
}

export async function handlePhoneLoginSendOtpRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PhoneRouteDeps,
): Promise<void> {
  let phone: string;
  try {
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }
    const rawPhone = getString(rawBody, 'phone');
    if (!rawPhone) {
      sendJson(res, 400, { error: 'phone is required' });
      return;
    }
    phone = normalizePhoneNumber(rawPhone);
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid request' });
    return;
  }

  try {
    const sends = Number((await deps.redisClient.send('INCR', sendCountKey(phone))) ?? 0);
    if (sends === 1) {
      await deps.redisClient.send('EXPIRE', sendCountKey(phone), String(SEND_WINDOW_SECONDS));
    }
    if (sends > MAX_SENDS_PER_WINDOW) {
      sendJson(res, 429, {
        error: `Too many codes requested for this number. Wait up to ${Math.ceil(SEND_WINDOW_SECONDS / 60)} minutes and check WhatsApp for the last code sent.`,
        code: 'OTP_RATE_LIMITED',
      });
      return;
    }

    const code = buildOtpCode();
    const ttlSeconds = deps.phoneOtpTtlSeconds ?? LOGIN_OTP_TTL_SECONDS;
    await deps.redisClient.set(
      otpKey(phone),
      JSON.stringify({ codeHash: hashOtp(code), attempts: 0 } satisfies StoredLoginOtp),
      ttlSeconds,
    );

    const messageBody = `Your Wheelers sign-in code is ${code}. It expires in ${Math.max(1, Math.floor(ttlSeconds / 60))} minute(s). If you did not request this, ignore this message.`;

    let channel: 'whatsapp' | 'sms';
    try {
      channel = await sendPhoneOtpMessage(deps, phone, messageBody, code);
    } catch (error) {
      // A code that never left the building must not eat the rider's quota —
      // otherwise a broken sender locks them out for the whole window.
      await deps.redisClient.del(otpKey(phone)).catch(() => {});
      await deps.redisClient.send('DECR', sendCountKey(phone)).catch(() => {});
      console.error('[phone-login] OTP delivery failed', {
        phone,
        error: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof OtpDeliveryError && error.code === 'OTP_WINDOW_CLOSED') {
        // Meta only delivers free-form messages within 24h of the rider's
        // last message to us. Tell the client so it can offer the fix.
        sendJson(res, 409, {
          error: 'WhatsApp only lets us message you after you message Wheelers first. Send us any message on WhatsApp, then request the code again.',
          code: 'OTP_WINDOW_CLOSED',
          whatsappNumber: error.whatsappNumber ?? null,
        });
        return;
      }
      sendJson(res, 502, {
        error: `We could not deliver the code: ${error instanceof Error ? error.message : 'unknown error'}`,
        code: 'OTP_DELIVERY_FAILED',
      });
      return;
    }

    sendJson(res, 200, { sent: true, channel, phone, expiresInSeconds: ttlSeconds });
  } catch (error) {
    console.error('[phone-login] send failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    sendJson(res, 500, { error: 'Could not send sign-in code' });
  }
}

export async function handlePhoneLoginVerifyOtpRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PhoneLoginRouteDeps,
): Promise<void> {
  let phone: string;
  let code: string;
  try {
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }
    const rawPhone = getString(rawBody, 'phone');
    const rawCode = getString(rawBody, 'code')?.trim();
    if (!rawPhone || !rawCode) {
      sendJson(res, 400, { error: 'phone and code are required' });
      return;
    }
    phone = normalizePhoneNumber(rawPhone);
    code = rawCode;
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid request' });
    return;
  }

  try {
    const stored = await readStoredLoginOtp(deps, phone);
    if (!stored) {
      sendJson(res, 400, { error: 'No active sign-in code for this number. Request a new code.', code: 'OTP_NOT_FOUND' });
      return;
    }

    const codeIsGood = (await isProviderManagedOtp(deps.redisClient, phone))
      ? await verifyProviderManagedOtp(deps, phone, code)
      : timingSafeStringEquals(hashOtp(code), stored.codeHash);

    if (!codeIsGood) {
      const attempts = stored.attempts + 1;
      if (attempts >= MAX_VERIFY_ATTEMPTS) {
        await deps.redisClient.del(otpKey(phone));
        sendJson(res, 400, { error: 'Too many incorrect attempts. Request a new code.', code: 'OTP_LOCKED' });
        return;
      }
      const ttl = Number((await deps.redisClient.send('TTL', otpKey(phone))) ?? 0);
      await deps.redisClient.set(
        otpKey(phone),
        JSON.stringify({ codeHash: stored.codeHash, attempts } satisfies StoredLoginOtp),
        ttl > 0 ? ttl : LOGIN_OTP_TTL_SECONDS,
      );
      sendJson(res, 400, {
        error: 'Invalid sign-in code',
        code: 'OTP_INVALID',
        attemptsRemaining: MAX_VERIFY_ATTEMPTS - attempts,
      });
      return;
    }

    await deps.redisClient.del(otpKey(phone));
    await deps.redisClient.del(sendCountKey(phone)).catch(() => {});

    const { user, created } = await resolveUserForPhone(phone, deps.onboarding);
    const accessToken = createLocalAccessToken(user.id, deps.jwtSecret);

    logActivity({ userId: user.id, eventType: 'phone_login', metadata: { created } });

    sendJson(res, 200, {
      accessToken,
      tokenType: 'Bearer',
      isNewUser: created,
      user: {
        id: user.id,
        privyDid: user.privyDid,
        username: user.username ?? null,
        email: user.email,
        role: user.role,
        name: user.name,
        phone: user.phone,
      },
    });
  } catch (error) {
    console.error('[phone-login] verify failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    sendJson(res, 500, { error: error instanceof Error ? error.message : 'Could not complete sign-in' });
  }
}
