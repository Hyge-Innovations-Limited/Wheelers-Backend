import type { IncomingMessage, ServerResponse } from 'http';
import { prisma } from '@wheleers/db';
import { logActivity } from '../analytics/log-activity';
import type { RedisClient } from '../redis/client';
import { getString, isRecord } from '../utils/object';
import { consumeCode, maskEmail, PinFlowError, sendCode } from '../wallet-security/pin-flows';
import { authenticateHttpUser } from './authenticate';
import { readJsonBody, sendJson } from './utils';

/**
 * Every account has an email, proved with a code sent to it: for receipts,
 * and a way back into the account. The app asks right after the privacy
 * policy, and once more of anyone who signed up before it did.
 *
 *   POST /auth/email/code    { email }  send a 6-digit code to it
 *   POST /auth/email/verify  { code }   the code back: the email is now the account's, confirmed
 *
 * A code is single use, lasts ten minutes and allows five guesses (the same
 * rules as the PIN-recovery codes, whose helpers these are). One confirmed
 * email belongs to one account.
 */

interface EmailRouteDeps {
  jwtSecret: string;
  redisClient: RedisClient;
  resendApiKey?: string;
}

const RESEND_WAIT_SECONDS = 45;
const codeKey = (userId: string) => `account-email:code:${userId}`;
const waitKey = (userId: string) => `account-email:wait:${userId}`;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function refuse(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: message, code });
}

export async function handleAccountEmailRoute(req: IncomingMessage, res: ServerResponse, deps: EmailRouteDeps, url: URL): Promise<boolean> {
  if (url.pathname !== '/auth/email/code' && url.pathname !== '/auth/email/verify') return false;
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }

  let user: Awaited<ReturnType<typeof authenticateHttpUser>>;
  try {
    user = await authenticateHttpUser(req, deps.jwtSecret);
  } catch {
    refuse(res, 401, 'SIGN_IN_AGAIN', 'Please sign in again.');
    return true;
  }
  const body = await readJsonBody(req).catch(() => null);
  const flow = { redisClient: deps.redisClient, resendApiKey: deps.resendApiKey };

  try {
    if (url.pathname === '/auth/email/code') {
      const email = (isRecord(body) ? getString(body, 'email') : undefined)?.trim().toLowerCase() ?? '';
      if (!EMAIL_SHAPE.test(email) || email.length > 254) {
        refuse(res, 400, 'EMAIL_INVALID', 'That does not look like an email address. Check it and try again.');
        return true;
      }
      if (await deps.redisClient.get(waitKey(user.id)).catch(() => null)) {
        refuse(res, 429, 'WAIT', 'A code is on its way. Give it a moment before asking for another.');
        return true;
      }
      const taken = await prisma.user.findFirst({
        where: { email, emailVerifiedAt: { not: null }, NOT: { id: user.id } },
        select: { id: true },
      });
      if (taken) {
        refuse(res, 409, 'EMAIL_TAKEN', 'That email is already on another Wheelers account. Use a different one.');
        return true;
      }
      await sendCode(flow, codeKey(user.id), email, 'confirm your email on Wheelers', 'If you did not ask for this, you can ignore this email.');
      await deps.redisClient.set(waitKey(user.id), '1', RESEND_WAIT_SECONDS).catch(() => undefined);
      logActivity({ userId: user.id, eventType: 'account_email_code_sent', metadata: { email: maskEmail(email) } });
      sendJson(res, 200, { sentTo: maskEmail(email), resendInSeconds: RESEND_WAIT_SECONDS });
      return true;
    }

    const email = await consumeCode(flow, codeKey(user.id), isRecord(body) ? getString(body, 'code') : undefined);
    const now = new Date();
    const saved = await prisma.user.update({
      where: { id: user.id },
      data: {
        email,
        emailVerifiedAt: now,
        // The first proved email also becomes where PIN-reset codes go, until they choose another.
        ...(user.recoveryEmail ? {} : { recoveryEmail: email, recoveryEmailVerifiedAt: now }),
      },
      select: { email: true, emailVerifiedAt: true },
    });
    logActivity({ userId: user.id, eventType: 'account_email_verified', metadata: { email: maskEmail(email) } });
    sendJson(res, 200, { email: saved.email, emailVerified: true });
    return true;
  } catch (error) {
    if (error instanceof PinFlowError) {
      refuse(res, error.status, error.code, error.message);
      return true;
    }
    console.error('[account-email] failed', { userId: user.id, error: error instanceof Error ? error.message : String(error) });
    refuse(res, 500, 'EMAIL_FAILED', 'We could not do that just now. Please try again in a moment.');
    return true;
  }
}
