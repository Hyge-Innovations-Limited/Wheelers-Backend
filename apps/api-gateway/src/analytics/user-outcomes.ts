import type { IncomingMessage, ServerResponse } from 'http';
import { verifyLocalAccessToken } from '../auth/local';
import { logActivity } from './log-activity';
import { clientIp } from '../utils/client-ip';

/**
 * What people tried to do in the app and how it went, for the admin Activity
 * page: every refusal with the sentence the person was shown, and the things
 * that worked which are worth a line. Written after the response has gone, so
 * it never slows or fails a request.
 */

export const OUTCOME_FAILED = 'request_failed';
export const OUTCOME_OK = 'request_ok';
/**
 * Someone not signed in asking for an address the server does not have: not a
 * person using the app (it only calls real routes) but a bot trying known
 * weaknesses, like POST /vendor/phpunit/.../eval-stdin.php or GET /.env. Kept
 * apart from people's problems, with where it came from, for the security view.
 */
export const OUTCOME_PROBE = 'security_probe';
/** Rows written for someone who is not signed in (asking for a sign-in code, say). */
export const GUEST_USER_ID = 'guest';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | '*';

/** What the person was doing, in words anyone on the team can read. First match wins. */
const ACTIONS: [Method, RegExp, string][] = [
  ['POST', /^\/auth\/phone\/login\/send-otp$/, 'Asked for a sign-in code'],
  ['POST', /^\/auth\/phone\/login\/verify-otp$/, 'Entered their sign-in code'],
  ['POST', /^\/auth\/phone\/send-otp$/, 'Asked for a code to confirm their phone number'],
  ['POST', /^\/auth\/phone\/verify-otp$/, 'Entered the code for their phone number'],
  ['POST', /^\/auth\/(apple|google)$/, 'Signed in with Apple or Google'],
  ['POST', /^\/auth\/signin$/, 'Signed in with email'],
  ['POST', /^\/auth\/signup$/, 'Created an account with email'],
  ['POST', /^\/auth\/forgot-password$/, 'Asked to reset their password'],
  ['POST', /^\/auth\/verify-reset-code$/, 'Entered a password reset code'],
  ['POST', /^\/auth\/reset-password$/, 'Set a new password'],
  ['*', /^\/auth\/profile$/, 'Changed their name or email'],
  ['POST', /^\/auth\/delete-account$/, 'Deleted their account'],
  ['*', /^\/auth\/(me|refresh|logout)$/, 'Opened the app'],
  ['POST', /^\/drivers\/kyc\/(submit|resubmit)$/, 'Sent their driver application'],
  ['*', /^\/drivers\/kyc\//, 'Checked their driver application'],
  ['*', /^\/kyc\//, 'Verified their identity'],
  ['*', /^\/group-rides\/face-check$/, 'Did the face check'],
  ['*', /^\/group-rides\//, 'Used group ride'],
  ['*', /^\/interstate\//, 'Used intercity travel'],
  ['POST', /^\/referrals\/apply$/, 'Entered a referral code'],
  ['PUT', /^\/referrals\/me\/code$/, 'Created their own referral code'],
  ['*', /^\/referrals\//, 'Opened referrals'],
  ['POST', /^\/rides\/estimate$/, 'Asked for the price of a trip'],
  ['POST', /^\/scheduled-rides$/, 'Scheduled a ride'],
  ['DELETE', /^\/scheduled-rides\//, 'Cancelled a scheduled ride'],
  ['*', /^\/scheduled-rides/, 'Opened their scheduled rides'],
  ['POST', /^\/rides\/[^/]+\/(rating|rate|feedback)$/, 'Rated a trip'],
  ['*', /^\/rides\//, 'Opened a trip'],
  ['POST', /^\/safety\/alerts/, 'Pressed the Emergency button'],
  ['POST', /^\/wallet\/withdrawals\/verify-bank-account$/, 'Checked a bank account number'],
  ['POST', /^\/wallet\/withdrawals$/, 'Asked to withdraw money'],
  ['*', /^\/wallet\/pin/, 'Set or entered their wallet PIN'],
  ['POST', /^\/wallet\/provision-virtual-account$/, 'Asked for an account number to add money'],
  ['*', /^\/wallet\//, 'Opened their wallet'],
  ['POST', /^\/support\/chat\/messages$/, 'Wrote to support'],
  ['*', /^\/support\//, 'Opened the chat with support'],
  ['*', /^\/trip-chat\//, 'Chatted with their driver or rider'],
];

/** What the app asks for over its live connection, in the same plain words. */
const LIVE_ACTIONS: Record<string, string> = {
  'ride:request': 'Searched for a driver',
  'ride:cancel': 'Cancelled a ride',
  'ride:accept_offer': "Accepted a driver's offer",
  'ride:decline_offer': "Declined a driver's offer",
  'ride:rider_counter_offer': 'Changed their price',
  'ride:counter_offer': 'Made an offer on a ride',
  'ride:accept': 'Accepted a ride at the rider\'s price',
  'ride:arrived': 'Marked themselves as arrived',
  'ride:start': 'Started a trip',
  'ride:complete': 'Completed a trip',
  'driver:online': 'Went online',
  'driver:offline': 'Went offline',
  'chat:send': 'Sent a chat message',
};

/**
 * Requests that happen constantly or mean nothing to a person reading the
 * page. Among them two the app makes by itself, with nobody tapping: older
 * builds asking for intercity requests, and the login check on opening.
 */
const NEVER = /^\/(admin|webhooks|health|widget|ride-page|wallet-page|stellar)(\/|$)|^\/drivers\/me\/(location|standby|standby-location)$|^\/notifications|^\/interstate\/driver\/offers$|^\/auth\/session$/;
/** Successes worth a line: things a person did, not screens loading. */
const WORTH_SAYING = /^\/auth\/(phone\/|apple$|google$|signin$|signup$|reset-password$|delete-account$)|^\/drivers\/kyc\/(submit|resubmit)$|^\/referrals\/(apply|me\/code)$|^\/scheduled-rides|^\/wallet\/(withdrawals$|pin)|^\/safety\/alerts|^\/support\/chat\/messages$/;

export function describeAction(method: string, path: string): string {
  for (const [wanted, pattern, words] of ACTIONS) {
    if ((wanted === '*' || wanted === method) && pattern.test(path)) return words;
  }
  return `${method} ${path}`;
}

export function describeLiveAction(type: string): string {
  return LIVE_ACTIONS[type] ?? `Sent "${type}" from the app`;
}

/**
 * Why it failed, for someone who does not read status codes. The sentence the
 * person saw comes first; when the server gave none, the status says it.
 */
export function plainReason(status: number, shown: string | undefined): string {
  const said = shown?.trim();
  if (status >= 500) {
    return said && !/internal|unexpected|prisma|undefined|null|ECONN|timeout/i.test(said)
      ? `${said} (a fault on our side)`
      : 'Something broke on our side. The person saw an error and could not continue.';
  }
  if (said && !/^(unauthorized|forbidden|not found|bad request)$/i.test(said)) return said;
  if (status === 401) return 'They were not signed in, or their login had ended, so the app asked them to sign in again.';
  if (status === 403) return 'Their account is not allowed to do this.';
  if (status === 404) return 'What they asked for could not be found.';
  if (status === 409) return 'This was already done, or something changed before their request arrived.';
  if (status === 413) return 'The file or photo they sent was too large.';
  if (status === 429) return 'They tried too many times in a short while and were asked to wait.';
  return said ?? 'The request was refused.';
}

type Noted = { shownError?: string; phone?: string; detail?: string };
const notes = new WeakMap<ServerResponse, Noted>();

/** Remembered by `sendJson`: the sentence this response showed the person. */
export function noteShownError(res: ServerResponse, error: unknown): void {
  if (typeof error === 'string' && error.trim()) notes.set(res, { ...notes.get(res), shownError: error.trim() });
}

/** A route that knows whose request this is before they are signed in (their phone number) says so. */
export function noteRequestPhone(res: ServerResponse, phone: string | null | undefined): void {
  if (phone) notes.set(res, { ...notes.get(res), phone });
}

/**
 * What the person entered, where it says what went wrong better than the
 * refusal alone ("DEJI" for a referral code nobody has). Shown after the
 * action on the Activity page. Never a secret: no passwords, PINs or codes sent by SMS.
 */
export function noteRequestDetail(res: ServerResponse, detail: string | null | undefined): void {
  const clean = typeof detail === 'string' ? detail.trim().slice(0, 60) : '';
  if (clean) notes.set(res, { ...notes.get(res), detail: clean });
}

function userIdOf(req: IncomingMessage, jwtSecret: string): string | null {
  const header = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    return verifyLocalAccessToken(header.slice(7), jwtSecret).sub;
  } catch {
    return null;
  }
}

/** The same person hitting the same wall again inside a minute is one line, not twenty. */
const lately = new Map<string, number>();
const REPEAT_MS = 60_000;
const PROBE_REPEAT_MS = 60 * 60 * 1000;

function saidLately(key: string, now: number, window = REPEAT_MS): boolean {
  const last = lately.get(key);
  if (last && now - last < window) return true;
  lately.set(key, now);
  if (lately.size > 5000) {
    for (const [k, at] of lately) if (now - at >= PROBE_REPEAT_MS) lately.delete(k);
  }
  return false;
}

export type Outcome = {
  userId: string;
  eventType: typeof OUTCOME_FAILED | typeof OUTCOME_OK | typeof OUTCOME_PROBE;
  metadata: Record<string, unknown>;
};

/** What a browser asks every site for by itself: not worth a line anywhere. */
const BROWSER_NOISE = /^\/(favicon\.ico|robots\.txt|apple-touch-icon[\w-]*\.png)$/;

/** What to write for a finished request, or null when it is not worth a line. Pure: tested without a server. */
export function outcomeOf(input: {
  method: string;
  path: string;
  status: number;
  userId: string | null;
  shownError?: string;
  phone?: string;
  via?: string;
  detail?: string;
}): Outcome | null {
  const { method, path, status } = input;
  if (method === 'OPTIONS' || NEVER.test(path)) return null;
  const failed = status >= 400;
  if (failed) {
    // Nobody signed in, asking for an address that does not exist: a bot probing, not a person.
    if (status === 404 && !input.userId) {
      if (BROWSER_NOISE.test(path)) return null;
      return { userId: GUEST_USER_ID, eventType: OUTCOME_PROBE, metadata: { method, path: path.slice(0, 300), status } };
    }
    if (method === 'HEAD') return null;
    // A screen loading while signed out, or finding nothing, is the app's ordinary business.
    if (method === 'GET' && (status === 401 || status === 404)) return null;
  } else if (method === 'GET' || method === 'HEAD' || !WORTH_SAYING.test(path)) {
    return null;
  }
  const metadata: Record<string, unknown> = {
    action: describeAction(method, path),
    status,
    path,
    method,
    ...(input.phone ? { phone: input.phone } : {}),
    ...(input.via ? { via: input.via } : {}),
    ...(input.detail ? { detail: input.detail } : {}),
    ...(failed ? { message: plainReason(status, input.shownError), fault: status >= 500 ? 'ours' : 'theirs' } : {}),
  };
  return { userId: input.userId ?? GUEST_USER_ID, eventType: failed ? OUTCOME_FAILED : OUTCOME_OK, metadata };
}

/** After every response: one line for the Activity page when the request is worth one. */
export function recordRequestOutcome(req: IncomingMessage, res: ServerResponse, path: string, jwtSecret: string): void {
  const noted = notes.get(res);
  const outcome = outcomeOf({
    method: req.method ?? 'GET',
    path,
    status: res.statusCode,
    userId: userIdOf(req, jwtSecret),
    shownError: noted?.shownError,
    phone: noted?.phone,
    detail: noted?.detail,
  });
  if (!outcome) return;
  if (outcome.eventType === OUTCOME_PROBE) {
    // Where it came from: the address and what it calls itself. One line per address and path an hour.
    const ip = clientIp(req) ?? 'unknown';
    if (saidLately(`probe|${ip}|${path}`, Date.now(), PROBE_REPEAT_MS)) return;
    const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 200) : null;
    logActivity({ userId: GUEST_USER_ID, eventType: OUTCOME_PROBE, source: 'app', metadata: { ...outcome.metadata, ip, userAgent } });
    return;
  }
  const who = outcome.userId === GUEST_USER_ID ? `guest:${noted?.phone ?? ''}` : outcome.userId;
  if (saidLately(`${who}|${path}|${res.statusCode}|${outcome.metadata.message ?? ''}|${noted?.detail ?? ''}`, Date.now())) return;
  logActivity({ userId: outcome.userId, eventType: outcome.eventType, source: 'app', metadata: outcome.metadata });
}

/** A request over the app's live connection that was refused: the same line, from the other door. */
export function recordLiveFailure(userId: string, requestType: string | null | undefined, message: string, code?: string): void {
  const type = requestType ?? 'unknown';
  if (saidLately(`${userId}|ws:${type}|${message}`, Date.now())) return;
  logActivity({
    userId,
    eventType: OUTCOME_FAILED,
    source: 'app',
    metadata: {
      action: describeLiveAction(type),
      message: plainReason(400, message),
      fault: 'theirs',
      path: type,
      method: 'LIVE',
      ...(code ? { code } : {}),
    },
  });
}
