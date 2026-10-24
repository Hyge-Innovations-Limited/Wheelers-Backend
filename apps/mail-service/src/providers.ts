/**
 * Who runs a recipient's mail, so each is paced on its own: Gmail, Microsoft
 * and Yahoo judge a new sending IP separately, and each says "slow down" in
 * its own words. Known from the address's domain when it is a webmail one,
 * otherwise from the MX host (a company on Google Workspace is "gmail" too).
 */

const BY_DOMAIN: Record<string, string> = {
  'gmail.com': 'gmail', 'googlemail.com': 'gmail',
  'yahoo.com': 'yahoo', 'ymail.com': 'yahoo', 'rocketmail.com': 'yahoo', 'yahoo.co.uk': 'yahoo', 'yahoo.fr': 'yahoo', 'aol.com': 'yahoo',
  'outlook.com': 'microsoft', 'hotmail.com': 'microsoft', 'live.com': 'microsoft', 'msn.com': 'microsoft', 'hotmail.co.uk': 'microsoft', 'outlook.fr': 'microsoft',
  'icloud.com': 'apple', 'me.com': 'apple', 'mac.com': 'apple',
  'zohomail.com': 'zoho', 'zoho.com': 'zoho',
};

const BY_MX: Array<[RegExp, string]> = [
  [/(^|\.)(google|googlemail)\.com$/, 'gmail'],
  [/(^|\.)(outlook\.com|protection\.outlook\.com|hotmail\.com)$/, 'microsoft'],
  [/(^|\.)(yahoodns\.net|yahoo\.com|aol\.com)$/, 'yahoo'],
  [/(^|\.)icloud\.com$/, 'apple'],
  [/(^|\.)zoho(mail)?\.(com|eu|in|com\.au)$/, 'zoho'],
];

export function providerForDomain(domain: string): string | null {
  return BY_DOMAIN[domain] ?? null;
}

export function providerForMx(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '');
  for (const [pattern, name] of BY_MX) if (pattern.test(h)) return name;
  return 'other';
}

/**
 * A reply that means "you are sending too fast" rather than "not this one":
 * Gmail 421 4.7.28, Yahoo TSS04, Microsoft "throttled", and the plain ones.
 * The whole provider waits, not just this email.
 */
export function isRateLimit(code: number | null, text: string): boolean {
  if (code === null || code < 400 || code >= 500) return false;
  return /4\.7\.28|TSS0[1-9]|throttl|rate.?limit|too many (messages|connections|emails)|sending rate|exceeded|try again later.*(rate|volume)/i.test(text);
}
