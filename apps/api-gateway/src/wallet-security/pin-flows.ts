import { createHash, randomInt, timingSafeEqual } from 'crypto';
import { userClient, walletSecurityClient } from '@wheleers/db';
import { sendEmail } from '../email/resend';
import { logActivity } from '../analytics/log-activity';
import type { RedisClient } from '../redis/client';
import { resetPin } from './wallet-pin';

/**
 * The PIN flows that are the same whether the user arrived through a WhatsApp
 * page link or the mobile app: "what is my security state", "I forgot my PIN",
 * and the recovery email. Both surfaces call these, so a rule cannot be
 * tightened on one and forgotten on the other.
 */

const CODE_TTL_SECONDS = 10 * 60;
const CODE_MAX_TRIES = 5;

export interface PinFlowDeps {
  redisClient: RedisClient;
  resendApiKey?: string;
  /** Tells the user on WhatsApp that their PIN changed. Absent in tests. */
  notifyUser?: (phone: string, message: string) => Promise<void>;
}

/** A failure written for the user; `status` is the HTTP status to answer with. */
export class PinFlowError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = 'PinFlowError';
  }
}

const hashCode = (code: string) => createHash('sha256').update(code).digest('hex');
const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '••••';
  return `${local.slice(0, 1)}${'•'.repeat(Math.max(2, Math.min(6, local.length - 1)))}@${domain}`;
}

export async function storeCode(deps: PinFlowDeps, key: string, email: string): Promise<string> {
  const code = newCode();
  await deps.redisClient.set(key, JSON.stringify({ email, codeHash: hashCode(code), tries: 0 }), CODE_TTL_SECONDS);
  return code;
}

/** Single use, five guesses, ten minutes. Returns the email the code was sent to. */
export async function consumeCode(deps: PinFlowDeps, key: string, code: unknown): Promise<string> {
  const raw = await deps.redisClient.get(key).catch(() => null);
  if (!raw) throw new PinFlowError('That code has expired. Request a new one.', 400, 'CODE_EXPIRED');
  const stored = JSON.parse(raw) as { email: string; codeHash: string; tries: number };
  if (stored.tries >= CODE_MAX_TRIES) {
    await deps.redisClient.del(key).catch(() => {});
    throw new PinFlowError('Too many wrong codes. Request a new one.', 429, 'CODE_LOCKED');
  }
  const given = Buffer.from(hashCode(typeof code === 'string' ? code.trim() : ''));
  const expected = Buffer.from(stored.codeHash);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    await deps.redisClient.set(key, JSON.stringify({ ...stored, tries: stored.tries + 1 }), CODE_TTL_SECONDS);
    throw new PinFlowError('That code is not right. Check the email and try again.', 400, 'CODE_WRONG');
  }
  await deps.redisClient.del(key).catch(() => {});
  return stored.email;
}

export async function emailCode(deps: PinFlowDeps, to: string, code: string, purpose: string): Promise<void> {
  if (!deps.resendApiKey) throw new PinFlowError('Email is not available right now. Please try again later.', 503, 'EMAIL_UNAVAILABLE');
  await sendEmail({
    to,
    subject: `${code} is your Wheelers code`,
    html: `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px;background:#FFF8EC;border:2px solid #141210;border-radius:12px">
  <p style="font-size:15px;color:#141210;margin:0 0 12px">Use this code to ${purpose}:</p>
  <p style="font-size:34px;font-weight:700;letter-spacing:8px;color:#FF7700;margin:0 0 16px">${code}</p>
  <p style="font-size:13px;color:#5B534A;margin:0">It expires in 10 minutes. If you did not ask for this, ignore this email — your PIN has not changed.</p>
</div>`,
  }, deps.resendApiKey);
}

/**
 * Issue a code and deliver it — or leave nothing behind. A code that was
 * stored but never delivered is a secret nobody holds and a guess target for
 * ten minutes; if the email cannot go out, the code does not exist.
 */
export async function sendCode(deps: PinFlowDeps, key: string, email: string, purpose: string): Promise<void> {
  if (!deps.resendApiKey) throw new PinFlowError('Email is not available right now. Please try again later.', 503, 'EMAIL_UNAVAILABLE');
  const code = await storeCode(deps, key, email);
  try {
    await emailCode(deps, email, code, purpose);
  } catch (error) {
    await deps.redisClient.del(key).catch(() => {});
    throw error instanceof PinFlowError
      ? error
      : new PinFlowError('We could not send that email. Please try again in a moment.', 502, 'EMAIL_FAILED');
  }
}

/**
 * Where a PIN-reset code may go: the verified recovery email first, else the
 * email the account signs in with. Either is a second thing a phone thief is
 * unlikely to hold. `null` = the user has neither.
 */
async function resetEmailFor(userId: string): Promise<string | null> {
  const state = await walletSecurityClient.getState(userId);
  if (state.recoveryEmail && state.recoveryEmailVerifiedAt) return state.recoveryEmail;
  const user = await userClient.findById(userId).catch(() => null);
  return user?.email?.trim() || null;
}

/** Everything a client needs to draw the right PIN screen. Never the hash. */
export async function getSecuritySummary(userId: string) {
  const [state, resetEmail] = await Promise.all([walletSecurityClient.getState(userId), resetEmailFor(userId)]);
  const now = Date.now();
  const future = (d: Date | null) => (d && d.getTime() > now ? d.toISOString() : null);
  const frozenUntil = future(state.withdrawalsFrozenUntil);
  return {
    hasPin: Boolean(state.walletPinHash),
    recoveryEmail: state.recoveryEmail && state.recoveryEmailVerifiedAt ? maskEmail(state.recoveryEmail) : null,
    /** Where a "Forgot PIN" code would go; null means a reset pauses withdrawals instead. */
    resetEmail: resetEmail ? maskEmail(resetEmail) : null,
    pinLockedUntil: future(state.walletPinLockedUntil),
    frozenUntil,
    frozenReason: frozenUntil ? state.withdrawalsFrozenReason : null,
    restrictedUntil: future(state.withdrawalsRestrictedUntil),
  };
}

const resetKey = (userId: string) => `wallet:pin-reset:${userId}`;

export async function startPinReset(
  deps: PinFlowDeps,
  userId: string,
): Promise<{ method: 'email'; sentTo: string } | { method: 'pause'; pauseHours: number }> {
  const email = await resetEmailFor(userId);
  if (email) {
    await sendCode(deps, resetKey(userId), email, 'reset your Wheelers wallet PIN');
    return { method: 'email', sentTo: maskEmail(email) };
  }
  // No second factor on file: the reset is allowed, and made worthless to a
  // thief by the pause that follows. Say so BEFORE they commit to it.
  return { method: 'pause', pauseHours: 24 };
}

export async function completePinReset(
  deps: PinFlowDeps,
  userId: string,
  input: { code?: unknown; newPin: unknown },
): Promise<{ frozenUntil: string | null; restrictedUntil: string | null }> {
  // An account WITH an email must use it — otherwise a thief would simply
  // pick the no-email path and wait out its 24 hours.
  const email = await resetEmailFor(userId);
  const verifiedByEmail = Boolean(email);
  if (email) await consumeCode(deps, resetKey(userId), input.code);

  const outcome = await resetPin(userId, input.newPin, verifiedByEmail);
  logActivity({ userId, eventType: 'wallet_pin_reset', metadata: { verifiedByEmail } });

  const state = await walletSecurityClient.getState(userId);
  if (state.phone && deps.notifyUser) {
    const message = verifiedByEmail
      ? '🔐 Your Wheelers wallet PIN was just changed.\n\nIf this was not you, reply *FREEZE* right now to pause withdrawals.'
      : '🔐 Your Wheelers wallet PIN was just reset.\n\nFor your safety, withdrawals are paused for 24 hours. Deposits and rides work as normal.\n\nIf this was not you, reply *FREEZE* right now and we will keep withdrawals locked.';
    void deps.notifyUser(state.phone, message).catch(() => {});
  }
  return {
    frozenUntil: outcome.frozenUntil?.toISOString() ?? null,
    restrictedUntil: outcome.restrictedUntil?.toISOString() ?? null,
  };
}
