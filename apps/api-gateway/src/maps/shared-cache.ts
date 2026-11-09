import { createHash } from 'node:crypto';
import type { RedisClient } from '../redis/client';

/**
 * Google Maps answers kept in Redis, shared by every gateway process, so the
 * same route or place is paid for once. What keeps it from serving stale or
 * wrong answers:
 *   - only Google's own answer is kept (a fare is worked out fresh from it);
 *   - every kind has a version in its key: bump it and the old answers are never read again;
 *   - short lifetimes (hours), well inside what Google's terms allow;
 *   - nothing is kept when Google failed or found nothing (that may be temporary);
 *   - an answer read back is checked for shape before it is used;
 *   - the same question asked twice at once makes one call to Google;
 *   - Redis trouble is never an error: it simply asks Google.
 */

let redis: RedisClient | null = null;

export function configureMapsCache(client: RedisClient | null): void {
  redis = client;
}

const inflight = new Map<string, Promise<unknown>>();

/** A short key for any question: kind and version in clear, the rest hashed. */
export function mapsKey(kind: string, version: number, ...parts: Array<string | number | undefined>): string {
  const digest = createHash('sha1').update(parts.map((p) => String(p ?? '')).join('|')).digest('base64url');
  return `maps:${kind}:v${version}:${digest}`;
}

export async function cachedMaps<T>(
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
  options: { keep: (value: T) => boolean; valid: (value: unknown) => value is T },
): Promise<T> {
  if (redis) {
    try {
      const raw = await redis.get(key);
      if (raw !== null) {
        const value = JSON.parse(raw) as unknown;
        if (options.valid(value)) return value;
      }
    } catch { /* ask Google */ }
  }

  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const work = (async () => {
    const value = await load();
    if (redis && options.keep(value)) {
      try { await redis.set(key, JSON.stringify(value), ttlSeconds); } catch { /* not kept, still answered */ }
    }
    return value;
  })();
  inflight.set(key, work);
  try {
    return await work;
  } finally {
    inflight.delete(key);
  }
}
