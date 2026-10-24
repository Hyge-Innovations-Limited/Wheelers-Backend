import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import type { MailConfig } from './config';
import { providerForDomain, providerForMx } from './providers';

/** Where to take mail for a domain: its mail servers in order, each with its IPv4 addresses. */
export type Route =
  | { ok: true; provider: string; hosts: Array<{ name: string; port: number; ips: string[] }> }
  /** permanent: the domain cannot get mail (it does not exist, or says so with a null MX). Otherwise try later. */
  | { ok: false; permanent: boolean; reason: string };

export type Resolver = {
  resolveMx(domain: string): Promise<Array<{ exchange: string; priority: number }>>;
  /** IPv4 only: Gmail refuses mail over IPv6 from a server without IPv6 reverse DNS, so we never send over it. */
  resolve4(host: string): Promise<string[]>;
};

export const systemResolver: Resolver = {
  resolveMx: (domain) => dns.resolveMx(domain),
  resolve4: async (host) => {
    if (isIP(host) === 4) return [host];
    // lookup, not resolve4: it reads /etc/hosts too (localhost, a test smart host).
    const found = await dns.lookup(host, { family: 4, all: true });
    return found.map((a) => a.address);
  },
};

const code = (error: unknown) => (error as { code?: string })?.code ?? '';
/** No such domain: never going to work. */
const NOT_THERE = new Set(['ENOTFOUND', 'NXDOMAIN']);
/** The domain is there but has no MX records. */
const NO_RECORDS = new Set(['ENODATA']);

type Cached = { route: Route; until: number };

/**
 * The route for a domain (RFC 5321 section 5.1): its MX hosts by preference,
 * equal ones in random order; none, then the domain itself (the "implicit
 * MX"); a single "." MX (RFC 7505) or a domain that does not exist cannot get
 * mail. Hosts without an IPv4 address are skipped. Kept for 10 minutes (a
 * failed lookup for 1). MAIL_SMART_HOST sends everything to one place instead.
 */
export function createRouter(config: Pick<MailConfig, 'smartHost'>, resolver: Resolver = systemResolver) {
  const cache = new Map<string, Cached>();

  async function lookup(domain: string): Promise<Route> {
    if (config.smartHost) {
      const ips = await resolver.resolve4(config.smartHost.host).catch(() => []);
      if (ips.length === 0) return { ok: false, permanent: false, reason: `smart host ${config.smartHost.host} has no IPv4 address` };
      return { ok: true, provider: providerForDomain(domain) ?? 'other', hosts: [{ name: config.smartHost.host, port: config.smartHost.port, ips }] };
    }

    let mx: Array<{ exchange: string; priority: number }>;
    try {
      mx = await resolver.resolveMx(domain);
    } catch (error) {
      if (NOT_THERE.has(code(error))) return { ok: false, permanent: true, reason: `${domain} does not exist` };
      if (!NO_RECORDS.has(code(error))) return { ok: false, permanent: false, reason: `could not look up ${domain} (${code(error) || 'DNS error'})` };
      mx = [];
    }

    if (mx.length === 1 && (mx[0]!.exchange === '' || mx[0]!.exchange === '.')) {
      return { ok: false, permanent: true, reason: `${domain} does not accept mail (null MX)` };
    }
    const named = mx.filter((r) => r.exchange && r.exchange !== '.');
    // Same preference: spread over them, as RFC 5321 asks.
    const ordered = named.map((r) => ({ ...r, tie: Math.random() })).sort((a, b) => a.priority - b.priority || a.tie - b.tie).map((r) => r.exchange.toLowerCase().replace(/\.$/, ''));
    const names = ordered.length ? ordered : [domain];

    const hosts: Array<{ name: string; port: number; ips: string[] }> = [];
    for (const name of [...new Set(names)].slice(0, 5)) {
      const ips = await resolver.resolve4(name).catch(() => [] as string[]);
      if (ips.length) hosts.push({ name, port: 25, ips: ips.slice(0, 2) });
    }
    if (hosts.length === 0) {
      return ordered.length
        ? { ok: false, permanent: false, reason: `no mail server of ${domain} has an IPv4 address` }
        : { ok: false, permanent: true, reason: `${domain} has no mail server` };
    }
    return { ok: true, provider: providerForDomain(domain) ?? providerForMx(hosts[0]!.name), hosts };
  }

  return {
    async route(domain: string): Promise<Route> {
      const hit = cache.get(domain);
      if (hit && hit.until > Date.now()) return hit.route;
      const route = await lookup(domain);
      cache.set(domain, { route, until: Date.now() + (route.ok ? 10 : 1) * 60_000 });
      if (cache.size > 5000) cache.delete(cache.keys().next().value!);
      return route;
    },
    clear: () => cache.clear(),
  };
}

export type Router = ReturnType<typeof createRouter>;
