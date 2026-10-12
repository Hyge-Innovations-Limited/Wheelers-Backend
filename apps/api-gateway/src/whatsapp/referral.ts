import { referralClient } from '@wheleers/db';
import { logActivity } from '../analytics/log-activity';
import type { MetaWhatsappRouteDeps } from './deps';
import { replyAndLog } from './send';

/**
 * A code Wheelers gave out is WHL and six more letters or digits; one a person
 * chose for themselves is any four to twelve (see referralClient).
 */
const GIVEN = 'WHL[A-Z0-9]{6}';
const ANY = '[A-Z0-9]{4,12}';
const SAID = new RegExp(`\\bmy\\s+referral\\s+code\\s+is\\b[^A-Za-z0-9]*(${ANY})\\b|\\breferral\\s+code\\b[^A-Za-z0-9]*(?:is\\b[^A-Za-z0-9]*)?(${GIVEN})\\b`, 'i');
const ALONE = new RegExp(`^\\s*(${GIVEN})\\s*$`, 'i');

/**
 * The referral code in a message, or null. It is read from "my referral code
 * is WHLAB2CD3" (what a referral link or QR code opens the chat with; here a
 * code someone chose for themselves, like TIMI, is read too) and from a
 * message that is nothing but a WHL code. A code inside any other sentence is
 * left alone: it could be part of an address.
 */
export function referralCodeIn(text: string): string | null {
  const said = SAID.exec(text);
  const found = said ? (said[1] ?? said[2]) : ALONE.exec(text)?.[1];
  return found ? found.toUpperCase() : null;
}

/** What a referral link puts in the chat box, ready to send. */
export const referralChatMessage = (code: string) => `Hi Wheelers. My referral code is ${code}`;

/**
 * A link that opens a chat with the Wheelers number and the code already
 * typed. It is what a referral QR code holds. Null when the number is not set.
 */
export function referralShareLink(code: string, botNumber = process.env['WHATSAPP_BOT_NUMBER'] ?? ''): string | null {
  const digits = botNumber.replace(/\D/g, '');
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(referralChatMessage(code))}` : null;
}

const NEXT = 'To book a ride, tell me where you are going, or reply *menu*.';

/** What to say when a code cannot be added, from the reason the rules gave. */
export function referralRefusal(reason: string): string {
  if (/own referral code/i.test(reason)) return `You cannot use your own referral code.\n\n${NEXT}`;
  if (/already been applied/i.test(reason)) return `A referral code is already on your account, so this one was not added.\n\n${NEXT}`;
  if (/not found/i.test(reason)) return `That referral code was not found. Check it and send it again.\n\n${NEXT}`;
  return `That referral code could not be added right now. Please try again later.\n\n${NEXT}`;
}

/** A rider sent a referral code in the chat: add it to their account and say so. */
export async function applyReferralFromChat(deps: MetaWhatsappRouteDeps, user: { id: string }, phone: string, incoming: string, code: string): Promise<void> {
  try {
    await referralClient.applyCode({ referredUserId: user.id, code });
    logActivity({ userId: user.id, eventType: 'referral_code_applied', source: 'whatsapp', metadata: { code } });
    await replyAndLog(deps, phone, incoming, `Referral code *${code}* has been added to your account.\n\n${NEXT}`);
  } catch (error) {
    await replyAndLog(deps, phone, incoming, referralRefusal(error instanceof Error ? error.message : ''));
  }
}
