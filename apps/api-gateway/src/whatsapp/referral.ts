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
/** What a referral link types in the chat: REF-CODE, short enough to read in the link itself. */
const REF = new RegExp(`^\\s*REF-(${ANY})\\s*$`, 'i');

/**
 * The referral code in a message, or null. It is read from "my referral code
 * is WHLAB2CD3" (what a referral link or QR code opens the chat with; here a
 * code someone chose for themselves, like TIMI, is read too) and from a
 * message that is nothing but a WHL code. A code inside any other sentence is
 * left alone: it could be part of an address.
 */
export function referralCodeIn(text: string): string | null {
  const said = SAID.exec(text);
  const found = said ? (said[1] ?? said[2]) : (REF.exec(text)?.[1] ?? ALONE.exec(text)?.[1]);
  return found ? found.toUpperCase() : null;
}

/** What a referral link puts in the chat box, ready to send. */
export const referralChatMessage = (code: string) => `Hi Wheelers. My referral code is ${code}`;

/** The Wheelers WhatsApp number when WHATSAPP_BOT_NUMBER is not set (the website's too). */
export const WHEELERS_NUMBER = '2348141979106';

/**
 * A person's referral link, what their QR code holds and what the app and
 * the bot share: a chat with the Wheelers bot with "My referral code is CODE"
 * already typed. The bot adds the code when the friend sends it.
 */
/**
 * The referral link: the bot's WhatsApp chat with REF-CODE typed, e.g.
 * wa.me/2348141979106?text=REF-TIMI. Nothing in it needs encoding, so it reads
 * clean wherever it is shown. (Links shared before, with "My referral code is
 * …", are still read.)
 */
export function referralWhatsappLink(code: string, botNumber = process.env['WHATSAPP_BOT_NUMBER'] || WHEELERS_NUMBER): string {
  const digits = botNumber.replace(/\D/g, '') || WHEELERS_NUMBER;
  return `https://wa.me/${digits}?text=REF-${code.toUpperCase().replace(/[^A-Z0-9]/g, '')}`;
}

/** The link as a person reads it: no https://. */
export const referralLinkText = (code: string): string => referralWhatsappLink(code).replace(/^https?:\/\//, '');

export const referralShareLink = (code: string, botNumber?: string): string => referralWhatsappLink(code, botNumber);

/**
 * What a rider forwards to a friend: the code, and the link that opens a chat
 * with the Wheelers bot with it already typed (the bot reads it and adds it).
 */
export function referralShareMessage(code: string, link: string | null = referralShareLink(code)): string {
  return link
    ? `Book rides on WhatsApp with Wheelers and name your own price. Use my code *${code}* — tap to start: ${link}`
    : `Book rides on WhatsApp with Wheelers. Message Wheelers and say: My referral code is ${code}`;
}

/** WhatsApp's own share: pick a chat, and the forward message is typed there. */
export const referralShareUrl = (code: string): string => `https://wa.me/?text=${encodeURIComponent(referralShareMessage(code))}`;

/** Where an app.wheelersng.com/r/CODE link (shared for a day) sends the friend: the same chat with the bot, on every phone. */
export const referralLinkTarget = (code: string): string => referralWhatsappLink(code);

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
