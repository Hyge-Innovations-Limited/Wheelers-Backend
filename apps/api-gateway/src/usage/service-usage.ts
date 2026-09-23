import type { RedisClient } from '../redis/client';

/**
 * What the gateway asks other people's servers to do, counted.
 *
 * Every paid or rate-limited dependency — Google, Gemini, Groq, Paystack,
 * Meta, Twilio, Resend — is reached through the global fetch(). So one
 * wrapper around it, installed at boot, meters all of them without a single
 * call site knowing: each request is classified by its URL and counted in
 * Redis per service per day (calls, failures, milliseconds). The admin page
 * /admin/usage/services reads those counters.
 *
 * Counting never gets in the way: a Redis hiccup is swallowed, and a URL we do
 * not recognise (a CDN, a webhook back to ourselves) is simply not counted.
 */

export interface ServiceSpec {
  key: string;
  label: string;
  /** Where to see the bill / quota. */
  console: string;
  /** How that vendor charges, in one line, for the page. */
  pricing: string;
  match: (url: URL) => boolean;
}

const host = (url: URL, ...hosts: string[]) => hosts.includes(url.hostname);

export const SERVICES: ServiceSpec[] = [
  { key: 'google_geocoding', label: 'Google Geocoding', console: 'https://console.cloud.google.com/google/maps-apis/metrics', pricing: '$5 per 1,000 after the monthly credit',
    match: (u) => host(u, 'maps.googleapis.com') && u.pathname.startsWith('/maps/api/geocode') },
  { key: 'google_places', label: 'Google Places', console: 'https://console.cloud.google.com/google/maps-apis/metrics', pricing: 'Autocomplete ~$2.83, Text Search ~$32 per 1,000',
    match: (u) => host(u, 'places.googleapis.com') },
  { key: 'google_routes', label: 'Google Routes', console: 'https://console.cloud.google.com/google/maps-apis/metrics', pricing: '$5 per 1,000 routes',
    match: (u) => host(u, 'routes.googleapis.com') || (host(u, 'maps.googleapis.com') && u.pathname.startsWith('/maps/api/directions')) },
  { key: 'gemini', label: 'Gemini (Google AI)', console: 'https://aistudio.google.com/usage', pricing: 'Per token; flash-lite is the cheap tier',
    match: (u) => host(u, 'generativelanguage.googleapis.com') },
  { key: 'groq', label: 'Groq', console: 'https://console.groq.com/usage', pricing: 'Free tier: ~8,000 tokens/min',
    match: (u) => host(u, 'api.groq.com') },
  { key: 'meta_whatsapp', label: 'WhatsApp (Meta)', console: 'https://business.facebook.com/wa/manage/insights/', pricing: 'Free inside a 24 h service window; templates are billed',
    match: (u) => host(u, 'graph.facebook.com') },
  { key: 'paystack', label: 'Paystack', console: 'https://dashboard.paystack.com/', pricing: '1.5% + ₦100 on collections; ₦10–50 per transfer',
    match: (u) => host(u, 'api.paystack.co') },
  { key: 'twilio', label: 'Twilio (SMS / Verify)', console: 'https://console.twilio.com/us1/monitor/usage', pricing: 'Per SMS / verification',
    match: (u) => host(u, 'api.twilio.com', 'verify.twilio.com') },
  { key: 'resend', label: 'Resend (email)', console: 'https://resend.com/overview', pricing: 'Free to 3,000 emails/month',
    match: (u) => host(u, 'api.resend.com') },
  { key: 'google_oauth', label: 'Google Sign-In', console: 'https://console.cloud.google.com/apis/credentials', pricing: 'Free',
    match: (u) => host(u, 'www.googleapis.com', 'oauth2.googleapis.com') },
];

export function classify(url: string): ServiceSpec | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  return SERVICES.find((service) => service.match(parsed)) ?? null;
}

/** YYYY-MM-DD in Lagos, where the bills are read. */
export function dayKey(at = new Date()): string {
  return at.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
}
const KEY_TTL_SECONDS = 400 * 24 * 3600;   // a little over a year, then Redis forgets
const key = (service: string, day: string) => `usage:${service}:${day}`;

/**
 * Wrap the global fetch once. Returns the un-wrapped one so a test can put it
 * back. Idempotent: wrapping twice would double-count.
 */
export function meterOutboundCalls(redis: RedisClient): typeof fetch {
  const current = globalThis.fetch as typeof fetch & { __wheelersOriginal?: typeof fetch };
  if (current.__wheelersOriginal) return current.__wheelersOriginal;
  const original = current;

  const metered: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const service = classify(url);
    if (!service) return original(input, init);

    const started = Date.now();
    let failed = false;
    try {
      const response = await original(input, init);
      failed = !response.ok;
      return response;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // Fire and forget: the count must never slow or break the call it is counting.
      void record(redis, service.key, failed, Date.now() - started).catch(() => undefined);
    }
  };
  (metered as typeof fetch & { __wheelersOriginal?: typeof fetch }).__wheelersOriginal = original;
  globalThis.fetch = metered;
  return original;
}

export async function record(redis: RedisClient, service: string, failed: boolean, ms: number, at = new Date()): Promise<void> {
  const k = key(service, dayKey(at));
  await redis.send('HINCRBY', k, 'calls', '1');
  if (failed) await redis.send('HINCRBY', k, 'failed', '1');
  await redis.send('HINCRBY', k, 'ms', String(Math.max(0, Math.round(ms))));
  await redis.send('EXPIRE', k, String(KEY_TTL_SECONDS));
}

export interface DayUsage { day: string; calls: number; failed: number; avgMs: number | null }
export interface ServiceUsage extends Omit<ServiceSpec, 'match'> {
  today: DayUsage;
  /** The last `days` days, oldest first, zeros where nothing happened. */
  days: DayUsage[];
  totalCalls: number;
  totalFailed: number;
}

/** Every service, for the last `days` days ending today. */
export async function serviceUsage(redis: RedisClient, days = 30, now = new Date()): Promise<ServiceUsage[]> {
  const dayKeys = Array.from({ length: days }, (_, i) => dayKey(new Date(now.getTime() - (days - 1 - i) * 86400e3)));
  return Promise.all(SERVICES.map(async ({ match: _match, ...spec }) => {
    const perDay = await Promise.all(dayKeys.map(async (day) => {
      const raw = await redis.send('HGETALL', key(spec.key, day)).catch(() => null);
      const fields = Array.isArray(raw) ? raw.map(String) : [];
      const n = (name: string) => Number(fields[fields.indexOf(name) + 1] ?? 0) || 0;
      const calls = fields.includes('calls') ? n('calls') : 0;
      const ms = fields.includes('ms') ? n('ms') : 0;
      return { day, calls, failed: fields.includes('failed') ? n('failed') : 0, avgMs: calls > 0 ? Math.round(ms / calls) : null };
    }));
    return {
      ...spec,
      today: perDay[perDay.length - 1]!,
      days: perDay,
      totalCalls: perDay.reduce((sum, d) => sum + d.calls, 0),
      totalFailed: perDay.reduce((sum, d) => sum + d.failed, 0),
    };
  }));
}
