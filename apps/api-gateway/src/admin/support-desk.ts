/**
 * The support desk: what a SUPPORT login may use. Everything not listed here
 * is refused to it, so a page added to the dashboard later stays closed to
 * support until it is added on purpose.
 *
 * Support reads and answers the inbox, reads what people tried in the app
 * (the Activity page), looks people and trips up with their phone numbers and
 * emails to reach them, and messages them. It never sees money (wallets,
 * fares, fees, Stellar, deposit accounts), bank details or identity documents.
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
  ['POST', /^\/admin\/support\/people\/[^/]+\/messages$/],
  ['GET', /^\/admin\/desk\/trips\/[^/]+$/],
];

export function supportDeskAllows(method: string | undefined, path: string): boolean {
  const m = (method ?? 'GET').toUpperCase();
  return ALLOWED.some(([allowed, pattern]) => allowed === m && pattern.test(path));
}
