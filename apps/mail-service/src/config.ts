import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

/**
 * The mail service's settings, all from .env (MAIL_*). Nothing here is a key
 * from an outside provider: we send from our own server.
 *
 *   MAIL_HOSTNAME          mta1.wheelersng.com   the server's name: HELO, banner, reverse DNS
 *   MAIL_DOMAIN            wheelersng.com        signs mail as this (DKIM d=); From must be on it
 *   MAIL_DEFAULT_FROM      Wheelers <noreply@wheelersng.com>
 *   MAIL_BOUNCE_DOMAIN     bounce.wheelersng.com the envelope sender; bounces come back here
 *   MAIL_INBOUND_DOMAINS   bounce.wheelersng.com,mail.wheelersng.com   domains we receive for
 *   MAIL_DMARC_MAILBOX     dmarc@bounce.wheelersng.com   where DMARC reports go
 *   MAIL_DKIM_SELECTOR     s2026q4
 *   MAIL_DKIM_KEY_PATH     /home/wheelers/mail/dkim-s2026q4.key   (never in git)
 *   MAIL_PUBLIC_IP         the server's IPv4, for the DNS records it prints
 *   MAIL_OUTBOUND_IP       bind outgoing connections to this IPv4 (optional)
 *   MAIL_SMART_HOST        host:port: deliver everything there instead (local testing only)
 *   MAIL_API_HOST / MAIL_API_PORT   127.0.0.1 / 4400: the internal API, for our own services
 *   MAIL_API_TOKEN         needed only when the API listens beyond this machine
 *   MAIL_SMTP_PORT         25 (receiving)
 *   MAIL_TLS_KEY_PATH / MAIL_TLS_CERT_PATH   the certificate for STARTTLS when receiving
 *   MAIL_ROLES             api,worker,smtp   which parts this process runs
 *   MAIL_LIMITS            gmail=200,microsoft=100,yahoo=100,apple=100,zoho=200,other=500   per hour (warm-up: start low)
 *   MAIL_KEEP_DAYS         90: sent mail and its events are kept this long
 */

export type Role = 'api' | 'worker' | 'smtp';

export type MailConfig = {
  hostname: string;
  domain: string;
  defaultFrom: string;
  bounceDomain: string;
  inboundDomains: string[];
  dmarcMailbox: string;
  dkim: { selector: string; privateKey: string | null };
  publicIp: string | null;
  outboundIp: string | null;
  smartHost: { host: string; port: number } | null;
  api: { host: string; port: number; token: string | null };
  smtp: { port: number; tlsKey: string | null; tlsCert: string | null; maxSizeBytes: number };
  roles: Set<Role>;
  limitsPerHour: Record<string, number>;
  workerConcurrency: number;
  keepDays: number;
};

export const DEFAULT_LIMITS: Record<string, number> = { gmail: 200, microsoft: 100, yahoo: 100, apple: 100, zoho: 200, other: 500 };

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export class ConfigError extends Error {}

function domainOf(name: string, value: string | undefined, fallback?: string): string {
  const v = (value ?? fallback ?? '').trim().toLowerCase();
  if (!DOMAIN.test(v)) throw new ConfigError(`${name} must be a domain name like wheelersng.com (got "${value ?? ''}")`);
  return v;
}

function hostPort(value: string): { host: string; port: number } {
  const at = value.lastIndexOf(':');
  const port = Number(value.slice(at + 1));
  if (at < 1 || !Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`MAIL_SMART_HOST must be host:port (got "${value}")`);
  return { host: value.slice(0, at), port };
}

function limits(value: string | undefined): Record<string, number> {
  const out = { ...DEFAULT_LIMITS };
  for (const part of (value ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const [name, n] = part.split('=');
    const count = Number(n);
    if (!name || !Number.isInteger(count) || count < 0) throw new ConfigError(`MAIL_LIMITS must look like gmail=200,other=500 (got "${part}")`);
    out[name.trim().toLowerCase()] = count;
  }
  return out;
}

const isLoopback = (host: string) => host === 'localhost' || host === '::1' || host.startsWith('127.');

export function readConfig(env: NodeJS.ProcessEnv = process.env): MailConfig {
  const domain = domainOf('MAIL_DOMAIN', env.MAIL_DOMAIN);
  const hostname = domainOf('MAIL_HOSTNAME', env.MAIL_HOSTNAME, `mta1.${domain}`);
  const bounceDomain = domainOf('MAIL_BOUNCE_DOMAIN', env.MAIL_BOUNCE_DOMAIN, `bounce.${domain}`);
  const inboundDomains = [...new Set([bounceDomain, ...(env.MAIL_INBOUND_DOMAINS ?? '').split(',').map((d) => d.trim()).filter(Boolean).map((d) => domainOf('MAIL_INBOUND_DOMAINS', d))])];

  const roles = new Set((env.MAIL_ROLES ?? 'api,worker,smtp').split(',').map((r) => r.trim()).filter(Boolean) as Role[]);
  for (const role of roles) if (!['api', 'worker', 'smtp'].includes(role)) throw new ConfigError(`MAIL_ROLES has "${role}": use api, worker and smtp`);

  const keyPath = env.MAIL_DKIM_KEY_PATH?.trim();
  let privateKey: string | null = null;
  if (keyPath) {
    try {
      privateKey = readFileSync(keyPath, 'utf8');
    } catch {
      throw new ConfigError(`MAIL_DKIM_KEY_PATH: cannot read ${keyPath}. Make one with: npm -w @wheleers/mail-service run cli -- dkim-keygen ${keyPath}`);
    }
  }

  const apiHost = env.MAIL_API_HOST?.trim() || '127.0.0.1';
  const token = env.MAIL_API_TOKEN?.trim() || null;
  // Open beyond this machine, the API sends mail as us: it must then ask for the token.
  if (!isLoopback(apiHost) && !token) throw new ConfigError('MAIL_API_HOST is not this machine (127.0.0.1): set MAIL_API_TOKEN too');

  const publicIp = env.MAIL_PUBLIC_IP?.trim() || null;
  if (publicIp && isIP(publicIp) !== 4) throw new ConfigError('MAIL_PUBLIC_IP must be an IPv4 address');
  const outboundIp = env.MAIL_OUTBOUND_IP?.trim() || null;
  if (outboundIp && isIP(outboundIp) !== 4) throw new ConfigError('MAIL_OUTBOUND_IP must be an IPv4 address: we send over IPv4 only');

  const file = (name: string) => {
    const path = env[name]?.trim();
    if (!path) return null;
    try {
      return readFileSync(path, 'utf8');
    } catch {
      throw new ConfigError(`${name}: cannot read ${path}`);
    }
  };

  const defaultFrom = env.MAIL_DEFAULT_FROM?.trim() || `Wheelers <noreply@${domain}>`;
  return {
    hostname,
    domain,
    defaultFrom,
    bounceDomain,
    inboundDomains,
    dmarcMailbox: (env.MAIL_DMARC_MAILBOX?.trim() || `dmarc@${bounceDomain}`).toLowerCase(),
    dkim: { selector: env.MAIL_DKIM_SELECTOR?.trim() || 'mail', privateKey },
    publicIp,
    outboundIp,
    smartHost: env.MAIL_SMART_HOST?.trim() ? hostPort(env.MAIL_SMART_HOST.trim()) : null,
    api: { host: apiHost, port: Number(env.MAIL_API_PORT) || 4400, token },
    smtp: { port: Number(env.MAIL_SMTP_PORT) || 25, tlsKey: file('MAIL_TLS_KEY_PATH'), tlsCert: file('MAIL_TLS_CERT_PATH'), maxSizeBytes: 25 * 1024 * 1024 },
    roles,
    limitsPerHour: limits(env.MAIL_LIMITS),
    workerConcurrency: Math.min(Math.max(Number(env.MAIL_WORKER_CONCURRENCY) || 8, 1), 50),
    keepDays: Math.max(Number(env.MAIL_KEEP_DAYS) || 90, 7),
  };
}
