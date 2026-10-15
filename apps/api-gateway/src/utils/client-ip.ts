import type { IncomingMessage } from 'http';

/**
 * The address of whoever is really on the other end of a request: for rate
 * limits, the bot-probe log, admin sign-ins and KYC records.
 *
 * Headers are only believed when something we run wrote them:
 *
 *   CF-Connecting-IP   Cloudflare's word for the visitor. Believed only when
 *                      TRUST_CLOUDFLARE_IP=true, set once the server takes
 *                      web traffic from Cloudflare alone. Before that anyone
 *                      can send the header and be any address they like.
 *   X-Forwarded-For    each proxy adds the address it saw to the END; what
 *                      comes before is whatever the caller sent. So the last
 *                      entry is what our own nginx saw, and the first is not
 *                      to be trusted.
 *
 * Without either, the connection's own address.
 */
export function clientIp(req: IncomingMessage): string | null {
  if (process.env['TRUST_CLOUDFLARE_IP'] === 'true') {
    const cloudflare = header(req, 'cf-connecting-ip');
    if (cloudflare) return cloudflare;
  }
  const forwarded = header(req, 'x-forwarded-for');
  if (forwarded) {
    const seen = forwarded.split(',').map((part) => part.trim()).filter(Boolean);
    const last = seen[seen.length - 1];
    if (last) return last;
  }
  return req.socket?.remoteAddress ?? null;
}

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first.trim() ? first.trim() : null;
}
