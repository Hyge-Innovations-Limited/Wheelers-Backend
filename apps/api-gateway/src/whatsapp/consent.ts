import { userClient } from '@wheleers/db';
import { provisionDepositAccount } from '../onboarding/user-onboarding';
import { logActivity } from '../analytics/log-activity';
import { MetaWhatsappRouteDeps } from './deps';
import { sendQuickActions } from './menu';
import { MetaMessageInfo } from './parse';
import { signFlowToken } from '../whatsapp-flows/encryption';
import { privacyUrl, termsUrl, welcomeSendsKey } from '../whatsapp-flows/welcome-flow';
import { sendInteractive, sendMetaButtons, sendMetaReply } from './send';

export const PRIVACY_POLICY_URL = (process.env['PRIVACY_POLICY_URL'] ?? 'https://wheelersng.com/privacy').trim();

export const CONSENT_CONTINUE = 'Continue';

export const CONSENT_NOT_NOW = 'Not now';

export const FIRST_MESSAGE_TTL_SECONDS = 24 * 60 * 60;

export function firstMessageKey(userId: string): string {
  return `whatsapp:user:${userId}:pre_consent_message`;
}

export function consentPrompt(returning: boolean): string {
  return [
    returning ? '*Welcome back to Wheelers*' : '*Welcome to Wheelers*',
    '',
    'Book and pay for rides right here in WhatsApp.',
    '',
    `To do that, we use your name, number, the places you share and your trip and payment details. Here is how we keep them safe: ${PRIVACY_POLICY_URL}`,
    '',
    `Tap *${CONSENT_CONTINUE}* to agree and get started.`,
  ].join('\n');
}

/** A first message older than this is not replayed: the menu is shown instead. */
export const REPLAY_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** What the last consent question was: the Welcome form or the text prompt. */
export const consentPromptKey = (userId: string) => `whatsapp:user:${userId}:consent_prompt`;

/** The Welcome form goes out instead of the text prompt: on, or test for the listed phones. Needs the flow id. */
export function welcomeFormOn(phone: string): boolean {
  if (!process.env['WHATSAPP_WELCOME_FLOW_ID']?.trim()) return false;
  const mode = (process.env['WHATSAPP_WELCOME_FORM'] ?? 'off').trim().toLowerCase();
  if (mode === 'on') return true;
  if (mode !== 'test') return false;
  const digits = (value: string) => value.replace(/\D/g, '');
  const mine = digits(phone);
  return (process.env['WHATSAPP_WELCOME_FORM_PHONES'] ?? '').split(',').map(digits).filter(Boolean).some((p) => p === mine || (p.length >= 10 && mine.endsWith(p.slice(-10))));
}

/**
 * Agreed (by the form or by typing): log, open the deposit account, then ONE
 * message: the answer to their first message if it is under two hours old
 * (a "hi" gets "Hi Timmy, where are you headed?"), else that greeting with
 * the Quick Actions button. No separate "You're all set." (Timi, 4 Nov 2026).
 * Call it only from the one that won agreePrivacyOnce.
 */
export async function finishConsent(
  deps: MetaWhatsappRouteDeps,
  user: { id: string; name: string | null; phone: string | null },
  phone: string,
  via: 'welcome_form' | 'text',
  replay: (message: MetaMessageInfo) => Promise<void>,
  said = '',
): Promise<void> {
  logActivity({ userId: user.id, eventType: 'privacy_consent_agreed', source: 'whatsapp', metadata: { via, policyUrl: PRIVACY_POLICY_URL, termsUrl: termsUrl() } });
  // Now — and only now — their name and phone may go to the payment provider.
  void provisionDepositAccount(deps.paymentsClient, user.id, user.name ?? undefined, user.phone ?? phone).catch((error) => {
    console.warn('[whatsapp] deposit account provisioning after consent failed (non-blocking)', {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  await deps.redisClient.del(consentPromptKey(user.id)).catch(() => undefined);
  await deps.redisClient.del(welcomeSendsKey(user.id)).catch(() => undefined);

  // Pick up where they started: the message that met the question is answered now.
  const stashed = await deps.redisClient.get(firstMessageKey(user.id)).catch(() => null);
  await deps.redisClient.del(firstMessageKey(user.id)).catch(() => undefined);
  let first: MetaMessageInfo | null = null;
  try {
    const parsed = stashed ? (JSON.parse(stashed) as Record<string, unknown>) : null;
    if (parsed && typeof parsed['at'] === 'number' && parsed['msg'] && typeof parsed['msg'] === 'object') {
      first = Date.now() - (parsed['at'] as number) <= REPLAY_MAX_AGE_MS ? (parsed['msg'] as MetaMessageInfo) : null;
    } else {
      first = parsed as MetaMessageInfo | null; // stashed before the time was kept
    }
  } catch {
    first = null;
  }
  if (first) {
    await replay({ ...first, messageId: '' });
    return;
  }
  // "Hi <name>, where are you headed?" with the Quick Actions button: one message.
  await sendQuickActions(deps, user, phone, null, said, true);
}

/** The question: the Welcome form when it is on for this phone, else (or if it cannot be sent) the text prompt. */
async function askConsent(deps: MetaWhatsappRouteDeps, user: { id: string }, phone: string, returning: boolean): Promise<void> {
  if (welcomeFormOn(phone)) {
    const sends = Number(await deps.redisClient.get(welcomeSendsKey(user.id)).catch(() => null)) || 0;
    // Two forms sent and never opened (old WhatsApp, desktop): stop sending forms.
    if (sends < 2) {
      const sent = await sendInteractive(deps, phone, {
        type: 'flow',
        body: { text: returning ? '*Welcome back to Wheelers*' : '*Welcome to Wheelers*' },
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            flow_id: process.env['WHATSAPP_WELCOME_FLOW_ID']!.trim(),
            flow_token: signFlowToken(`welcome:${user.id}`, deps.jwtSecret),
            flow_cta: 'Get started',
            flow_action: 'data_exchange',
          },
        },
      });
      if (sent) {
        await deps.redisClient.set(welcomeSendsKey(user.id), String(sends + 1), FIRST_MESSAGE_TTL_SECONDS).catch(() => undefined);
        await deps.redisClient.set(consentPromptKey(user.id), 'form', FIRST_MESSAGE_TTL_SECONDS).catch(() => undefined);
        logActivity({ userId: user.id, eventType: 'welcome_form_sent', source: 'whatsapp', metadata: {} });
        return;
      }
    }
    logActivity({ userId: user.id, eventType: 'welcome_form_fallback_text', source: 'whatsapp', metadata: { sends } });
    await deps.redisClient.set(consentPromptKey(user.id), 'text', FIRST_MESSAGE_TTL_SECONDS).catch(() => undefined);
  }
  await sendMetaButtons(deps, phone, consentPrompt(returning), [CONSENT_CONTINUE, CONSENT_NOT_NOW]);
}

/**
 * Nothing is booked, and nothing about the rider goes to a third party, until
 * they have accepted the privacy policy. "Continue" agrees; "Not now" declines
 * — and declining is never final: any later message offers the choice again.
 *
 * These are OUR button titles plus the plainest yes/no, not a guess at what
 * riders might say: anything else simply shows the question again.
 *
 * Returns true when it has dealt with the message.
 */
export async function requirePrivacyConsent(
  deps: MetaWhatsappRouteDeps,
  user: { id: string; name: string | null; phone: string | null },
  phone: string,
  msgInfo: MetaMessageInfo,
  /** Re-run the message they sent before consenting, now that they have. */
  replay: (message: MetaMessageInfo) => Promise<void>,
): Promise<boolean> {
  const consent = await userClient.getPrivacyConsent(user.id);
  if (consent === 'AGREED') return false;

  const said = msgInfo.isLocation ? '' : msgInfo.messageBody.trim().toLowerCase();

  // A typed "continue" agrees only when the last question was the text one. While the
  // Welcome form is the question, typing is not the form: it is sent again. A tap on
  // an old text-prompt Continue button always counts.
  const tappedTextButton = Boolean(msgInfo.replyId?.startsWith('way_out_'));
  if (/^(continue|i agree|agree|agreed|accept|yes)[\s.!]*$/.test(said)) {
    const lastPrompt = welcomeFormOn(phone) && !tappedTextButton ? await deps.redisClient.get(consentPromptKey(user.id)).catch(() => null) : null;
    if (lastPrompt === 'form') {
      await askConsent(deps, user, phone, consent === 'DECLINED');
      return true;
    }
    // One winner: a form agreed a moment ago has already greeted them.
    if (await userClient.agreePrivacyOnce(user.id)) await finishConsent(deps, user, phone, 'text', replay, msgInfo.messageBody);
    return true;
  }

  if (/^(not now|no|no thanks|decline|i decline|disagree|i disagree|later)[\s.!]*$/.test(said)) {
    await userClient.setPrivacyConsent(user.id, 'DECLINED');
    await deps.redisClient.del(firstMessageKey(user.id)).catch(() => undefined);
    await deps.redisClient.del(consentPromptKey(user.id)).catch(() => undefined);
    logActivity({ userId: user.id, eventType: 'privacy_consent_declined', source: 'whatsapp', metadata: {} });
    await sendMetaReply(deps, phone,
      `No problem. We need that to book rides, so we haven't set anything up and we won't message you.\n\nChanged your mind? Send any message and tap *${CONSENT_CONTINUE}*.`);
    return true;
  }

  // Anything else: keep what they asked for, and ask the question.
  if (!msgInfo.isImage && (msgInfo.isLocation || msgInfo.messageBody.trim())) {
    await deps.redisClient.set(firstMessageKey(user.id), JSON.stringify({ at: Date.now(), msg: msgInfo }), FIRST_MESSAGE_TTL_SECONDS).catch(() => undefined);
  }
  await askConsent(deps, user, phone, consent === 'DECLINED');
  return true;
}

// ── "Which one did you mean?" — a tap, not a typed number ────────────────

