/**
 * The path written to the request log: query values that may be secrets
 * dropped (their names kept), and a path that carries one itself (the ride
 * page's one-time open code) cut to its prefix.
 */
export function getSafePathForLog(url: URL): string {
  // GET /ride-page/open/:code — the code opens a rider's page: never in a log.
  if (url.pathname.startsWith('/ride-page/open/')) return '/ride-page/open/<redacted>';

  if (url.searchParams.size === 0) {
    return url.pathname;
  }

  const queryKeys = Array.from(url.searchParams.keys())
    .filter((key) => !/token|secret|password|authorization|otp|code/i.test(key))
    .sort();

  return queryKeys.length > 0
    ? `${url.pathname}?${queryKeys.map((key) => `${key}=<redacted>`).join('&')}`
    : url.pathname;
}
