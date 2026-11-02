import { userClient } from '@wheleers/db';
import type { RedisClient } from '../redis/client';
import type { FlowRequestBody } from './encryption';
import { actionFor } from './flow-dispatch';

/**
 * The Welcome form (token `welcome:<userId>`): email, then the Privacy Policy and
 * Terms with an "I agree" tick. The user comes only from the signed token.
 *
 *   EMAIL  one box                         [Next]        -> TERMS
 *   TERMS  two links and the tick          [Get started] -> the form closes
 *
 * Agreeing goes through userClient.agreePrivacyOnce: one winner, and only the
 * winner starts the chat follow-up (onWelcomeAgreed). The email is saved as
 * User.contactEmail (unverified) — never as User.email.
 */

export interface WelcomeFlowDeps {
  redisClient: RedisClient;
  /** The call that agreed: log, open the deposit account, "You're all set." and carry on. */
  onWelcomeAgreed?: (userId: string) => Promise<void>;
}

export const WELCOME_ACTIONS = { EMAIL: 'welcome_email', TERMS: 'welcome_agree' } as const;

export const WELCOME_SUBMITS_PER_MINUTE = 10;

/** Forms sent since the last time one was opened. */
export const welcomeSendsKey = (userId: string) => `whatsapp:user:${userId}:welcome_form_sends`;
const rateKey = (userId: string, minute: number) => `whatsapp:user:${userId}:welcome_submits:${minute}`;

export const privacyUrl = () => (process.env['PRIVACY_POLICY_URL'] ?? 'https://wheelersng.com/privacy').trim();
export const termsUrl = () => (process.env['TERMS_URL'] ?? 'https://wheelersng.com/terms').trim();

/** Trimmed, lowercased, at most 254 characters, one @, a dot in the domain, no spaces. Null when not an email. */
export function cleanEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > 254 || /\s/.test(email)) return null;
  const parts = email.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const domain = parts[1];
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return null;
  return email;
}

type Screen = { screen: string; data: Record<string, unknown> };

function emailScreen(email: string, error = ''): Screen {
  return { screen: 'EMAIL', data: { email, error, has_error: Boolean(error) } };
}

function termsScreen(email: string, error = ''): Screen {
  return { screen: 'TERMS', data: { email, privacy_url: privacyUrl(), terms_url: termsUrl(), error, has_error: Boolean(error) } };
}

/** Closes the form. Meta posts its small reply bubble; the chat follow-up is separate. */
function closed(flowToken: string): Screen {
  return { screen: 'SUCCESS', data: { extension_message_response: { params: { flow_token: flowToken } } } };
}

async function overRateLimit(redis: RedisClient, userId: string): Promise<boolean> {
  const key = rateKey(userId, Math.floor(Date.now() / 60_000));
  const used = Number(await redis.get(key).catch(() => null)) || 0;
  await redis.set(key, String(used + 1), 120).catch(() => undefined);
  return used >= WELCOME_SUBMITS_PER_MINUTE;
}

export async function handleWelcomeFlow(body: FlowRequestBody, userId: string, deps: WelcomeFlowDeps): Promise<Screen> {
  const action = actionFor(body, { EMAIL: WELCOME_ACTIONS.EMAIL, TERMS: WELCOME_ACTIONS.TERMS });
  const data = body.data ?? {};

  if (body.action !== 'data_exchange' || !action) {
    // Opened (or Back): they have seen the form, so the "never opened" count starts again.
    await deps.redisClient.del(welcomeSendsKey(userId)).catch(() => undefined);
    const known = await userClient.findById(userId).catch(() => null) as { contactEmail?: string | null; email?: string | null } | null;
    return emailScreen(known?.contactEmail ?? known?.email ?? '');
  }

  if (await overRateLimit(deps.redisClient, userId)) {
    const typed = typeof data['email'] === 'string' ? data['email'] : '';
    return action === WELCOME_ACTIONS.TERMS ? termsScreen(typed, 'Try again in a minute.') : emailScreen(typed, 'Try again in a minute.');
  }

  const email = cleanEmail(data['email']);
  if (!email) {
    return emailScreen(typeof data['email'] === 'string' ? data['email'].trim() : '', 'Enter a valid email.');
  }
  if (action === WELCOME_ACTIONS.EMAIL) return termsScreen(email);

  // TERMS: the tick is required.
  const ticked = data['agree'] === true || data['agree'] === 'true';
  if (!ticked) return termsScreen(email, 'Tick I agree to continue.');

  // Already agreed (an old form, the app, or the typed Continue): nothing saved, nothing said.
  if ((await userClient.getPrivacyConsent(userId)) === 'AGREED') return closed(body.flow_token);

  await userClient.setContactEmail(userId, email);
  const won = await userClient.agreePrivacyOnce(userId);
  if (won && deps.onWelcomeAgreed) {
    // The form must answer Meta within seconds; the chat follow-up runs on its own.
    void deps.onWelcomeAgreed(userId).catch((error) => {
      console.warn('[whatsapp] welcome follow-up failed (non-blocking)', { userId, error: error instanceof Error ? error.message : String(error) });
    });
  }
  return closed(body.flow_token);
}
