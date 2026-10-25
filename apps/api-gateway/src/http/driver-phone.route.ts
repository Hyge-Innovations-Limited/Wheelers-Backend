import type { IncomingMessage, ServerResponse } from 'http';
import { prisma, driverClient, userClient } from '@wheleers/db';
import { verifyLocalAccessToken } from '../auth/local';
import { logActivity } from '../analytics/log-activity';
import { deliverOtpEverywhere, isOtpConfigured, type OtpChannelConfig } from '../otp/channels';
import type { RedisClient } from '../redis/client';
import { getString, isRecord } from '../utils/object';
import { buildOtpCode, hashOtp, timingSafeStringEquals } from './phone.route';
import { readJsonBody, sendJson } from './utils';

/**
 * A driver proves their phone number is theirs: a code goes to it by SMS,
 * and they type it back.
 *
 *   GET  /drivers/phone                the number on the account and whether it is verified
 *   POST /drivers/phone/send-code      { phone }   send (or send again) a code
 *   POST /drivers/phone/verify-code    { code }    check it; right, the number is saved as verified
 *
 * The rules, all kept in Redis so they hold across gateway processes:
 *   - a code lasts 30 minutes, and a new one replaces the one before;
 *   - a minute must pass between sends;
 *   - five codes in a session (30 minutes from the first). Asking for a
 *     sixth, the fifth press of "Send again", stops them for 30 minutes;
 *   - five wrong tries kill a code: a new one must be asked for.
 * Every refusal says what to do and when, with a `code` the app can read
 * and, where there is a wait, how many seconds it is.
 *
 * SMS goes out through the provider chosen in .env (SMS_PROVIDER), the other
 * behind it; WhatsApp is the last resort, so a driver is not stuck when SMS
 * is down.
 */
export interface DriverPhoneDeps {
  jwtSecret: string;
  redisClient: RedisClient;
  otp: OtpChannelConfig;
}

export const CODE_TTL_SECONDS = 30 * 60;
export const MAX_CODES_PER_SESSION = 5;
export const LOCK_SECONDS = 30 * 60;
export const RESEND_WAIT_SECONDS = 60;
export const MAX_WRONG_TRIES = 5;

const key = {
  code: (userId: string) => `driver:phone:code:${userId}`,
  sends: (userId: string) => `driver:phone:sends:${userId}`,
  lock: (userId: string) => `driver:phone:lock:${userId}`,
  wait: (userId: string) => `driver:phone:wait:${userId}`,
};

interface StoredCode { codeHash: string; phone: string; tries: number }

/** "08031234567", "8031234567", "2348031234567" or "+2348031234567" → "+2348031234567". Null when it is not a Nigerian mobile number. */
export function nigerianMobile(value: string): string | null {
  const digits = value.replace(/[\s()-]/g, '').replace(/^\+/, '');
  const national = digits.startsWith('234') ? digits.slice(3) : digits.startsWith('0') ? digits.slice(1) : digits;
  return /^[789][01]\d{8}$/.test(national) ? `+234${national}` : null;
}

/** "+2348031234567" → "0803 ••• 4567": enough for a driver to know which phone to look at. */
export function maskPhone(phone: string): string {
  const local = phone.startsWith('+234') ? `0${phone.slice(4)}` : phone;
  return `${local.slice(0, 4)} ••• ${local.slice(-4)}`;
}

const minutes = (seconds: number) => {
  const m = Math.max(1, Math.ceil(seconds / 60));
  return m === 1 ? '1 minute' : `${m} minutes`;
};

function userIdOf(req: IncomingMessage, jwtSecret: string): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  try {
    return verifyLocalAccessToken(header.slice(7), jwtSecret).sub;
  } catch {
    return null;
  }
}

async function ttl(redis: RedisClient, k: string): Promise<number> {
  const left = Number(await redis.send('TTL', k).catch(() => -2));
  return Number.isFinite(left) && left > 0 ? left : 0;
}

export async function handleDriverPhoneRoute(req: IncomingMessage, res: ServerResponse, deps: DriverPhoneDeps, url: URL): Promise<boolean> {
  const path = url.pathname;
  if (path !== '/drivers/phone' && path !== '/drivers/phone/send-code' && path !== '/drivers/phone/verify-code') return false;

  const userId = userIdOf(req, deps.jwtSecret);
  if (!userId) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }
  const driver = await driverClient.findByUserId(userId);
  if (!driver) {
    sendJson(res, 404, { error: 'Driver record not found' });
    return true;
  }
  const redis = deps.redisClient;

  if (path === '/drivers/phone') {
    if (req.method !== 'GET') { sendJson(res, 405, { error: 'Method not allowed' }); return true; }
    const user = await userClient.findById(userId);
    const verified = Boolean(driver.verifiedPhone && driver.phoneVerifiedAt && user.phone === driver.verifiedPhone);
    const [locked, wait, pending] = await Promise.all([ttl(redis, key.lock(userId)), ttl(redis, key.wait(userId)), redis.get(key.code(userId)).catch(() => null)]);
    const waitingOn = pending ? (JSON.parse(pending) as StoredCode).phone : null;
    sendJson(res, 200, {
      phone: user.phone ?? null,
      verified,
      verifiedAt: verified ? driver.phoneVerifiedAt!.toISOString() : null,
      // A code is out and still good: the app opens on the box to type it into.
      codeSentTo: waitingOn ? maskPhone(waitingOn) : null,
      resendInSeconds: wait,
      lockedForSeconds: locked,
    });
    return true;
  }

  if (req.method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed' }); return true; }
  const body = await readJsonBody(req).catch(() => null);
  if (!isRecord(body)) {
    sendJson(res, 400, { error: 'That did not arrive in one piece. Check your connection and try again.', code: 'BAD_REQUEST' });
    return true;
  }

  // Stopped for asking for too many codes: nothing is sent or checked until it lifts.
  const locked = await ttl(redis, key.lock(userId));
  if (locked > 0) {
    sendJson(res, 429, {
      error: `You have asked for too many codes. For your security, wait ${minutes(locked)} and try again.`,
      code: 'TOO_MANY_CODES',
      retryAfterSeconds: locked,
    });
    return true;
  }

  if (path === '/drivers/phone/send-code') {
    const phone = nigerianMobile(getString(body, 'phone') ?? '');
    if (!phone) {
      sendJson(res, 400, { error: 'Enter a Nigerian mobile number, for example 0803 123 4567.', code: 'BAD_PHONE' });
      return true;
    }
    if (!isOtpConfigured(deps.otp)) {
      sendJson(res, 503, { error: 'We cannot send codes right now. Please try again later.', code: 'SEND_UNAVAILABLE' });
      return true;
    }
    // One number, one driver.
    const taken = await prisma.driver.findFirst({ where: { verifiedPhone: phone, userId: { not: userId } }, select: { id: true } });
    if (taken) {
      sendJson(res, 409, { error: 'That number is already verified on another driver account. Use a different number, or contact support if it is yours.', code: 'PHONE_TAKEN' });
      return true;
    }
    const wait = await ttl(redis, key.wait(userId));
    if (wait > 0) {
      sendJson(res, 429, { error: `A code was just sent. You can ask for another in ${wait} seconds.`, code: 'WAIT_TO_RESEND', retryAfterSeconds: wait });
      return true;
    }

    // Five codes in a session. The sixth ask stops them for half an hour.
    const sends = Number(await redis.send('INCR', key.sends(userId)));
    if (sends === 1) await redis.send('EXPIRE', key.sends(userId), String(CODE_TTL_SECONDS));
    if (sends > MAX_CODES_PER_SESSION) {
      await redis.set(key.lock(userId), '1', LOCK_SECONDS);
      await Promise.all([redis.del(key.sends(userId)), redis.del(key.code(userId))]);
      console.warn('[driver-phone] too many codes asked for, stopped for 30 minutes', { userId });
      sendJson(res, 429, {
        error: `You have asked for ${MAX_CODES_PER_SESSION} codes. For your security, wait ${minutes(LOCK_SECONDS)} before asking for another.`,
        code: 'TOO_MANY_CODES',
        retryAfterSeconds: LOCK_SECONDS,
      });
      return true;
    }

    const code = buildOtpCode();
    try {
      // By SMS and on WhatsApp at once, the same code.
      const sent = await deliverOtpEverywhere(deps.otp, {
        phone,
        code,
        body: `Your Wheelers verification code is ${code}. This code expires in 30 minutes. Do not share with anyone.`,
        log: (message, meta) => console.warn(message, meta),
      });
      await redis.set(key.code(userId), JSON.stringify({ codeHash: hashOtp(code), phone, tries: 0 } satisfies StoredCode), CODE_TTL_SECONDS);
      await redis.set(key.wait(userId), '1', RESEND_WAIT_SECONDS);
      logActivity({ userId, eventType: 'driver_phone_code_sent', metadata: { channel: sent.channels.join('+'), number: sends } });
      sendJson(res, 200, {
        sentTo: maskPhone(phone),
        by: sent.medium,
        expiresInMinutes: CODE_TTL_SECONDS / 60,
        resendInSeconds: RESEND_WAIT_SECONDS,
        codesLeft: MAX_CODES_PER_SESSION - sends,
      });
    } catch (error) {
      // Nothing went out: this ask does not count against them.
      await redis.send('DECR', key.sends(userId)).catch(() => undefined);
      console.error('[driver-phone] code not sent', { userId, error: error instanceof Error ? error.message : String(error) });
      sendJson(res, 502, { error: 'We could not send a code to that number. Check the number, then try again in a moment.', code: 'SEND_FAILED' });
    }
    return true;
  }

  // verify-code
  const typed = (getString(body, 'code') ?? '').replace(/\D/g, '');
  const raw = await redis.get(key.code(userId)).catch(() => null);
  if (!raw) {
    sendJson(res, 400, { error: 'That code has expired. Ask for a new one.', code: 'CODE_EXPIRED' });
    return true;
  }
  const stored = JSON.parse(raw) as StoredCode;
  if (typed.length !== 6 || !timingSafeStringEquals(hashOtp(typed), stored.codeHash)) {
    const tries = stored.tries + 1;
    if (tries >= MAX_WRONG_TRIES) {
      await redis.del(key.code(userId));
      sendJson(res, 400, { error: 'Too many wrong tries. Ask for a new code.', code: 'CODE_DEAD' });
      return true;
    }
    const left = await ttl(redis, key.code(userId));
    await redis.set(key.code(userId), JSON.stringify({ ...stored, tries }), Math.max(1, left));
    const remaining = MAX_WRONG_TRIES - tries;
    sendJson(res, 400, { error: `That code is not right. Check the message and try again (${remaining} ${remaining === 1 ? 'try' : 'tries'} left).`, code: 'WRONG_CODE', triesLeft: remaining });
    return true;
  }

  // Right. Someone else may have verified the same number while this code was out.
  const taken = await prisma.driver.findFirst({ where: { verifiedPhone: stored.phone, userId: { not: userId } }, select: { id: true } });
  if (taken) {
    await redis.del(key.code(userId));
    sendJson(res, 409, { error: 'That number is already verified on another driver account. Use a different number.', code: 'PHONE_TAKEN' });
    return true;
  }
  await userClient.updateProfile(userId, { phone: stored.phone });
  await prisma.driver.update({ where: { id: driver.id }, data: { verifiedPhone: stored.phone, phoneVerifiedAt: new Date() } });
  await Promise.all([redis.del(key.code(userId)), redis.del(key.sends(userId)), redis.del(key.wait(userId))]);
  logActivity({ userId, eventType: 'driver_phone_verified', metadata: {} });
  sendJson(res, 200, { verified: true, phone: stored.phone });
  return true;
}
