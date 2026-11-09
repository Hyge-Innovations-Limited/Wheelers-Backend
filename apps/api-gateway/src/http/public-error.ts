/**
 * The sentence a person is shown when something is refused or fails: always
 * ours. A message the code wrote for people ("You need a Wheelers wallet
 * before booking") passes untouched; anything written for engineers (a
 * database error, a crash, a network failure, JSON, a stack line, a wall of
 * text) is replaced with a plain Wheelers sentence. The original still goes
 * to the server log, so nothing is lost for whoever has to fix it.
 */

const TECHNICAL: RegExp[] = [
  /prisma|invocation|`\w+\.\w+\(\)`/i,
  /\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EPIPE)\b|socket hang up|fetch failed|network error/i,
  /cannot read propert|is not a function|is not defined|undefined|null is not|\[object Object\]/i,
  /unexpected token|JSON|unexpected end of/i,
  /\b(TypeError|ReferenceError|SyntaxError|RangeError|ZodError)\b/,
  /\bat [\w.<>]+ \(|\.ts:\d+|\.js:\d+/,
  /\b(SELECT|INSERT INTO|UPDATE \w+ SET|DELETE FROM)\b|unique constraint|foreign key|violates/i,
  /status code \d{3}|timeout of \d+ms|request failed with/i,
  /E\.164|payload|must be a (string|number|boolean|finite)|expected (string|number|object)|required field/i,
  /^\s*[[{]/,
];

const LONGEST_SENTENCE = 240;

/** Ours, for when the real reason is not one for a person. */
export function defaultMessageFor(status: number): string {
  if (status >= 500) return 'Something went wrong on our side. Please try again in a moment.';
  if (status === 401) return 'Please sign in again.';
  if (status === 403) return 'You cannot do that with this account.';
  if (status === 404) return 'We could not find that.';
  if (status === 429) return 'Too many tries. Please wait a moment and try again.';
  return 'That did not work. Please check and try again.';
}

/** Is this a sentence written for a person? */
export function isPersonFacing(message: unknown): message is string {
  if (typeof message !== 'string') return false;
  const text = message.trim();
  if (!text || text.length > LONGEST_SENTENCE) return false;
  return !TECHNICAL.some((pattern) => pattern.test(text));
}

/** The message to show: the one given when it is for a person, else ours for this status. */
export function publicMessage(message: unknown, status: number): string {
  return isPersonFacing(message) ? message.trim() : defaultMessageFor(status);
}
