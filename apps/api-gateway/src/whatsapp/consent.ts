import { userClient } from '@wheleers/db';
import { provisionDepositAccount } from '../onboarding/user-onboarding';
import { logActivity } from '../analytics/log-activity';
import { MetaWhatsappRouteDeps } from './deps';
import { sendQuickActions } from './menu';
import { MetaMessageInfo } from './parse';
import { sendMetaButtons, sendMetaReply } from './send';

export const PRIVACY_POLICY_URL = (process.env['PRIVACY_POLICY_URL'] ?? 'https://wheelersng.com/privacy').trim();

export const CONSENT_CONTINUE = 'Continue';

export const CONSENT_NOT_NOW = 'Not now';

export const FIRST_MESSAGE_TTL_SECONDS = 24 * 60 * 60;

export function firstMessageKey(userId: string): string {
  return `whatsapp:user:${userId}:pre_consent_message`;
}

export function consentPrompt(returning: boolean): string {
  return [
    returning ? 'Welcome back to Wheelers!' : 'Welcome to Wheelers!',
    '',
    'Before we start: to book your rides and run your wallet, Wheelers uses your name, phone number, the locations you share, and your trip and payment details. Our privacy policy explains how we use and protect them:',
    PRIVACY_POLICY_URL,
    '',
    `Tap *${CONSENT_CONTINUE}* to agree and get started, or *${CONSENT_NOT_NOW}*.`,
  ].join('\n');
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

  if (/^(continue|i agree|agree|agreed|accept|yes)[\s.!]*$/.test(said)) {
    await userClient.setPrivacyConsent(user.id, 'AGREED');
    logActivity({ userId: user.id, eventType: 'privacy_consent_agreed', source: 'whatsapp', metadata: { policyUrl: PRIVACY_POLICY_URL } });
    // Now — and only now — their name and phone may go to the payment provider.
    void provisionDepositAccount(deps.paymentsClient, user.id, user.name ?? undefined, user.phone ?? phone).catch((error) => {
      console.warn('[whatsapp] deposit account provisioning after consent failed (non-blocking)', {
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    // Pick up where they started: the message that met the question is answered now.
    const stashed = await deps.redisClient.get(firstMessageKey(user.id)).catch(() => null);
    await deps.redisClient.del(firstMessageKey(user.id)).catch(() => undefined);
    let first: MetaMessageInfo | null = null;
    try {
      first = stashed ? (JSON.parse(stashed) as MetaMessageInfo) : null;
    } catch {
      first = null;
    }
    if (first) {
      await sendMetaReply(deps, phone, "Thank you — you're all set.");
      await replay({ ...first, messageId: '' });
      return true;
    }
    await sendMetaReply(deps, phone, "Thank you — you're all set.");
    await sendQuickActions(deps, user, phone, null, msgInfo.messageBody);
    return true;
  }

  if (/^(not now|no|no thanks|decline|i decline|disagree|i disagree|later)[\s.!]*$/.test(said)) {
    await userClient.setPrivacyConsent(user.id, 'DECLINED');
    await deps.redisClient.del(firstMessageKey(user.id)).catch(() => undefined);
    logActivity({ userId: user.id, eventType: 'privacy_consent_declined', source: 'whatsapp', metadata: {} });
    await sendMetaReply(deps, phone,
      `No problem. We can't book rides without it, so nothing has been set up and we won't message you.\n\nIf you change your mind, just send us a message and tap *${CONSENT_CONTINUE}*.`);
    return true;
  }

  // Anything else: keep what they asked for, and ask the question.
  if (!msgInfo.isImage && (msgInfo.isLocation || msgInfo.messageBody.trim())) {
    await deps.redisClient.set(firstMessageKey(user.id), JSON.stringify(msgInfo), FIRST_MESSAGE_TTL_SECONDS).catch(() => undefined);
  }
  await sendMetaButtons(deps, phone, consentPrompt(consent === 'DECLINED'), [CONSENT_CONTINUE, CONSENT_NOT_NOW]);
  return true;
}

// ── "Which one did you mean?" — a tap, not a typed number ────────────────

