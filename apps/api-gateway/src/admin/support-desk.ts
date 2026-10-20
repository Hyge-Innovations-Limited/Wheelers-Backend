/**
 * The support desk: what a SUPPORT login may use, and how what it sees is
 * trimmed. Everything not listed here is refused to it, so a page added to
 * the dashboard later stays closed to support until it is added on purpose.
 *
 * Support reads and answers the inbox, reads what people tried in the app
 * (the Activity page), and looks people and trips up. It never sees money
 * (wallets, fares, fees, Stellar, deposit accounts), bank details or
 * identity documents; phone numbers and emails are shown masked, and a
 * phone number is shown in full only when asked for, which is recorded.
 */

/** Where a support login lands. */
export const SUPPORT_DESK_HOME = '/admin/dashboard/support';

const ALLOWED: Array<[string, RegExp]> = [
  ['GET', /^\/admin\/me$/],
  ['POST', /^\/admin\/activity$/],
  ['GET', /^\/admin\/support\/conversations$/],
  ['GET', /^\/admin\/support\/conversations\/[^/]+$/],
  ['POST', /^\/admin\/support\/conversations\/[^/]+\/(messages|assign|resolve)$/],
  ['GET', /^\/admin\/analytics\/app-activity$/],
  ['GET', /^\/admin\/desk\/people$/],
  ['GET', /^\/admin\/desk\/people\/[^/]+$/],
  ['POST', /^\/admin\/desk\/people\/[^/]+\/phone$/],
  ['GET', /^\/admin\/desk\/trips\/[^/]+$/],
];

export function supportDeskAllows(method: string | undefined, path: string): boolean {
  const m = (method ?? 'GET').toUpperCase();
  return ALLOWED.some(([allowed, pattern]) => allowed === m && pattern.test(path));
}

/** "+2347084266640" → "+234 708 *** 6640": enough to match what a caller says, not to call them. */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, '');
  const nigerian = /^\+234(\d{3})\d+(\d{4})$/.exec(digits);
  if (nigerian) return `+234 ${nigerian[1]} *** ${nigerian[2]}`;
  if (digits.length <= 6) return '***';
  return `${digits.slice(0, 4)} *** ${digits.slice(-4)}`;
}

/** "pheezzy27@gmail.com" → "ph•••@gmail.com". */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  if (at < 1) return '•••';
  return `${email.slice(0, Math.min(2, at))}•••${email.slice(at)}`;
}
