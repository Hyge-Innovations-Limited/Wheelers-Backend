import { createHash, randomInt, timingSafeEqual } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { userClient } from '@wheleers/db';
import type { RedisClient } from '../redis/client';
import { verifyLocalAccessToken } from '../auth/local';
import { getString, isRecord } from '../utils/object';
import { readJsonBody, sendJson } from './utils';
import { logActivity } from '../analytics/log-activity';
import type { PaymentsClient } from '@wheleers/payments';
import { provisionDepositAccount } from '../onboarding/user-onboarding';
import {
  checkTwilioVerify,
  deliverOtp,
  isOtpConfigured,
  OtpDeliveryFailed,
  type OtpChannelConfig,
} from '../otp/channels';

const PHONE_OTP_KEY_PREFIX = 'auth:phone-otp:';
const PHONE_OTP_LENGTH = 6;
const PHONE_OTP_TTL_SECONDS = 300;

export interface PhoneRouteDeps {
  jwtSecret: string;
  redisClient: RedisClient;
  // Optional: when present, a freshly verified phone kicks off deposit-account
  // provisioning. Accounts that signed up with no contact info have no
  // virtual account until this moment.
  paymentsClient?: PaymentsClient;
  // Meta WhatsApp Cloud API — the same credentials the bot replies with.
  metaAccessToken?: string;
  metaPhoneNumberId?: string;
  // Approved AUTHENTICATION template. Without it a plain text is sent, which
  // Meta only delivers inside the 24h window after the rider last messaged.
  metaOtpTemplateName?: string;
  metaOtpTemplateLanguage?: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioFromNumber?: string;
  twilioWhatsappNumber?: string;
  twilioVerifyServiceSid?: string;
  otpChannelOrder?: string;
  phoneOtpTtlSeconds?: number;
}

interface StoredPhoneOtp {
  codeHash: string;
  phone: string;
}

function extractBearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;

  const [scheme, token] = value.split(' ');
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') {
    return undefined;
  }

  return token;
}

async function authenticateHttpUser(
  req: IncomingMessage,
  jwtSecret: string,
): Promise<NonNullable<Awaited<ReturnType<typeof userClient.findByPrivyDid>>>> {
  const authorization =
    typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
  const token = extractBearerToken(authorization);

  if (!token) {
    throw new Error('Authorization bearer token is required');
  }

  const localToken = verifyLocalAccessToken(token, jwtSecret);
  return await userClient.findById(localToken.sub);
}

export function normalizePhoneNumber(value: string): string {
  const trimmed = value.trim();
  if (!/^\+[1-9]\d{7,14}$/.test(trimmed)) {
    throw new Error('phone must be a valid E.164 number, for example +2348012345678');
  }

  return trimmed;
}

export function hashOtp(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export function buildOtpCode(): string {
  const max = 10 ** PHONE_OTP_LENGTH;
  return String(randomInt(0, max)).padStart(PHONE_OTP_LENGTH, '0');
}

function buildOtpRedisKey(userId: string): string {
  return `${PHONE_OTP_KEY_PREFIX}${userId}`;
}

export function timingSafeStringEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}


/** Everything the delivery chain needs, pulled off the route deps. */
export function otpConfigFrom(deps: PhoneRouteDeps): OtpChannelConfig {
  return {
    metaAccessToken: deps.metaAccessToken,
    metaPhoneNumberId: deps.metaPhoneNumberId,
    metaOtpTemplateName: deps.metaOtpTemplateName,
    metaOtpTemplateLanguage: deps.metaOtpTemplateLanguage,
    twilioAccountSid: deps.twilioAccountSid,
    twilioAuthToken: deps.twilioAuthToken,
    twilioFromNumber: deps.twilioFromNumber,
    twilioWhatsappNumber: deps.twilioWhatsappNumber,
    twilioVerifyServiceSid: deps.twilioVerifyServiceSid,
    channelOrder: deps.otpChannelOrder,
  };
}

export function hasOtpChannel(deps: PhoneRouteDeps): boolean {
  return isOtpConfigured(otpConfigFrom(deps));
}

const OTP_NOT_CONFIGURED =
  'Phone code delivery is not configured. Set META_ACCESS_TOKEN + META_PHONE_NUMBER_ID, or TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN.';

export class OtpDeliveryError extends Error {
  constructor(
    message: string,
    readonly code: 'OTP_WINDOW_CLOSED' | 'OTP_DELIVERY_FAILED',
    readonly whatsappNumber?: string,
  ) {
    super(message);
    this.name = 'OtpDeliveryError';
  }
}

let cachedBusinessNumber: string | null = null;

/** Our own WhatsApp number in E.164, for "message us first" links. */
export async function getWhatsappBusinessNumber(
  deps: PhoneRouteDeps,
): Promise<string | undefined> {
  if (cachedBusinessNumber) return cachedBusinessNumber;
  if (!deps.metaAccessToken || !deps.metaPhoneNumberId) return undefined;
  try {
    const response = await fetch(
      `https://graph.facebook.com/v21.0/${deps.metaPhoneNumberId}?fields=display_phone_number`,
      { headers: { authorization: `Bearer ${deps.metaAccessToken}` } },
    );
    if (!response.ok) return undefined;
    const data = (await response.json()) as { display_phone_number?: string };
    const digits = data.display_phone_number?.replace(/[^\d]/g, '');
    if (!digits) return undefined;
    cachedBusinessNumber = `+${digits}`;
    return cachedBusinessNumber;
  } catch {
    return undefined;
  }
}

/**
 * Deliver a code over the best available channel. Returns which one worked so
 * the caller can tell the rider where to look ("check WhatsApp" vs "check SMS").
 */
export async function sendPhoneOtpMessage(
  deps: PhoneRouteDeps,
  phone: string,
  body: string,
  code: string,
): Promise<'whatsapp' | 'sms'> {
  if (!hasOtpChannel(deps)) {
    throw new Error(OTP_NOT_CONFIGURED);
  }

  try {
    const result = await deliverOtp(otpConfigFrom(deps), {
      phone,
      code,
      body,
      log: (message, meta) => console.warn(message, meta ?? {}),
    });
    // Twilio Verify owns the code; remember that so verification asks Twilio
    // instead of comparing against a hash we never generated.
    lastDeliveryWasProviderManaged.set(phone, result.providerManaged);
    return result.medium;
  } catch (error) {
    if (error instanceof OtpDeliveryFailed) {
      throw new OtpDeliveryError(
        error.message,
        error.allWindowClosed ? 'OTP_WINDOW_CLOSED' : 'OTP_DELIVERY_FAILED',
        error.allWindowClosed ? await getWhatsappBusinessNumber(deps) : undefined,
      );
    }
    throw error;
  }
}

/**
 * Which phones currently hold a Twilio-Verify-issued code. In-memory is enough:
 * a gateway restart simply falls back to the hash check, which fails closed.
 */
const lastDeliveryWasProviderManaged = new Map<string, boolean>();

export function isProviderManagedOtp(phone: string): boolean {
  return lastDeliveryWasProviderManaged.get(phone) === true;
}

export async function verifyProviderManagedOtp(
  deps: PhoneRouteDeps,
  phone: string,
  code: string,
): Promise<boolean> {
  const ok = await checkTwilioVerify(otpConfigFrom(deps), phone, code);
  if (ok) lastDeliveryWasProviderManaged.delete(phone);
  return ok;
}

async function readStoredPhoneOtp(
  redisClient: RedisClient,
  userId: string,
): Promise<StoredPhoneOtp | null> {
  const raw = await redisClient.get(buildOtpRedisKey(userId));
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StoredPhoneOtp>;
    if (typeof parsed.codeHash !== 'string' || typeof parsed.phone !== 'string') {
      return null;
    }

    return {
      codeHash: parsed.codeHash,
      phone: parsed.phone,
    };
  } catch {
    return null;
  }
}

export async function handleSendPhoneOtpRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PhoneRouteDeps,
): Promise<void> {
  try {
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const rawPhone = getString(rawBody, 'phone');
    if (!rawPhone) {
      sendJson(res, 400, { error: 'phone is required' });
      return;
    }

    if (!hasOtpChannel(deps)) {
      sendJson(res, 500, { error: OTP_NOT_CONFIGURED });
      return;
    }

    const phone = normalizePhoneNumber(rawPhone);
    const code = buildOtpCode();
    const codeHash = hashOtp(code);
    const ttlSeconds = deps.phoneOtpTtlSeconds ?? PHONE_OTP_TTL_SECONDS;

    const redisKey = buildOtpRedisKey(user.id);
    const messageBody = `Your Wheelers verification code is ${code}. It expires in ${Math.max(1, Math.floor(ttlSeconds / 60))} minute(s).`;

    await deps.redisClient.set(
      redisKey,
      JSON.stringify({
        codeHash,
        phone,
      } satisfies StoredPhoneOtp),
      ttlSeconds,
    );

    try {
      const channel = await sendPhoneOtpMessage(deps, phone, messageBody, code);
      sendJson(res, 200, {
        sent: true,
        channel,
        phone,
        expiresInSeconds: ttlSeconds,
      });
    } catch (error) {
      await deps.redisClient.del(redisKey);
      throw error;
    }
  } catch (error) {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : 'Could not send phone verification code',
    });
  }
}

export async function handleVerifyPhoneOtpRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PhoneRouteDeps,
): Promise<void> {
  try {
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const code = getString(rawBody, 'code')?.trim();
    if (!code) {
      sendJson(res, 400, { error: 'code is required' });
      return;
    }

    const stored = await readStoredPhoneOtp(deps.redisClient, user.id);
    if (!stored) {
      sendJson(res, 400, { error: 'No active phone verification code found. Request a new code.' });
      return;
    }

    // Twilio Verify generates the code, so only Twilio can confirm it. Every
    // other channel used a code we hashed ourselves.
    if (isProviderManagedOtp(stored.phone)) {
      const approved = await verifyProviderManagedOtp(deps, stored.phone, code);
      if (!approved) {
        sendJson(res, 400, { error: 'Invalid verification code' });
        return;
      }
    } else if (!timingSafeStringEquals(hashOtp(code), stored.codeHash)) {
      sendJson(res, 400, { error: 'Invalid verification code' });
      return;
    }

    const updatedUser = await userClient.updateAuthIdentity(user.id, {
      phone: stored.phone,
    });

    await deps.redisClient.del(buildOtpRedisKey(user.id));

    logActivity({ userId: user.id, eventType: 'phone_verified', metadata: {} });

    if (deps.paymentsClient) {
      void provisionDepositAccount(
        deps.paymentsClient,
        user.id,
        updatedUser.name ?? undefined,
        updatedUser.phone ?? undefined,
      ).catch((provisionError) => {
        console.warn('[phone] deposit account provisioning after phone verify failed (non-blocking)', {
          userId: user.id,
          error: provisionError instanceof Error ? provisionError.message : String(provisionError),
        });
      });
    }

    sendJson(res, 200, {
      verified: true,
      user: {
        id: updatedUser.id,
        privyDid: updatedUser.privyDid,
        email: updatedUser.email,
        role: updatedUser.role,
        name: updatedUser.name,
        phone: updatedUser.phone,
      },
    });
  } catch (error) {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : 'Could not verify phone code',
    });
  }
}
