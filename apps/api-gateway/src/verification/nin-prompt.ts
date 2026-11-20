import { prisma } from '@wheleers/db';
import type { RedisClient } from '../redis/client';
import { NIN_CHECKS_PER_DAY } from './rider-nin';
import { premblyConfigFromEnv } from './prembly';

/**
 * The NIN popup (Timi, 18 Nov 2026): a rider with no NIN on file, or whose NIN did not check out (no such NIN,
 * another person's name), is asked in the app, on the ride page and once on WhatsApp after a trip. Never required:
 * tapping outside closes it. It comes back at most every 3 days and stops after 5 closes. A rider whose NIN is
 * verified or suspended is never asked; nor one out of today's tries, nor anyone while Prembly is not set up.
 */
export const NIN_PROMPT_GAP_MS = 3 * 24 * 60 * 60 * 1000;
export const NIN_PROMPT_MAX_CLOSES = 5;
export const NIN_WHATSAPP_GAP_S = 7 * 24 * 60 * 60;
// Asked again too (Timi, 20 Nov 2026): a NIN Prembly could not check (UNCHECKED was never asked again, so it was
// never checked at all), and one already on another account (IN_USE).
const ASK_STATUSES = new Set([null, 'NOT_FOUND', 'NO_MATCH', 'UNCHECKED', 'IN_USE']);
const RETRY_STATUSES = new Set(['NOT_FOUND', 'NO_MATCH', 'IN_USE']);

const keyOf = (userId: string) => `nin-prompt:${userId}`;
const dayKeyFor = (userId: string) => `rider-nin:${userId}:${new Date().toISOString().slice(0, 10)}`;

interface PromptState { lastShownAt: number | null; closes: number }

async function stateOf(redis: RedisClient, userId: string): Promise<PromptState> {
  const raw = await redis.get(keyOf(userId)).catch(() => null);
  try {
    const s = raw ? (JSON.parse(raw) as Partial<PromptState>) : {};
    return { lastShownAt: typeof s.lastShownAt === 'number' ? s.lastShownAt : null, closes: typeof s.closes === 'number' ? s.closes : 0 };
  } catch {
    return { lastShownAt: null, closes: 0 };
  }
}

/** Ask now? And whether their NIN was typed before and did not check out (the sheet says "Check your NIN"). */
export async function ninPromptFor(redis: RedisClient, userId: string, now = Date.now()): Promise<{ ask: boolean; retry: boolean }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { ninStatus: true, role: true } }).catch(() => null);
  if (!user || user.role === 'DRIVER' || !ASK_STATUSES.has(user.ninStatus ?? null)) return { ask: false, retry: false };
  // Nothing to check it with: never asked (it would only ever say it could not be checked).
  if (!premblyConfigFromEnv()) return { ask: false, retry: false };
  const retry = RETRY_STATUSES.has(user.ninStatus ?? '');
  const used = Number(await redis.get(dayKeyFor(userId)).catch(() => null)) || 0;
  if (used >= NIN_CHECKS_PER_DAY) return { ask: false, retry };
  const s = await stateOf(redis, userId);
  if (s.closes >= NIN_PROMPT_MAX_CLOSES) return { ask: false, retry };
  return { ask: s.lastShownAt === null || now - s.lastShownAt >= NIN_PROMPT_GAP_MS, retry };
}

/** The sheet was shown (starts the 3 days) or closed without a NIN (one close more). */
export async function noteNinPrompt(redis: RedisClient, userId: string, event: 'shown' | 'closed', now = Date.now()): Promise<void> {
  const s = await stateOf(redis, userId);
  const next: PromptState = event === 'shown' ? { ...s, lastShownAt: now } : { ...s, closes: s.closes + 1 };
  await redis.set(keyOf(userId), JSON.stringify(next), 180 * 24 * 60 * 60).catch(() => undefined);
}

/** WhatsApp: once a week at most (SET NX with a week's expiry: true only for the one that may send). */
export async function claimNinWhatsapp(redis: RedisClient, userId: string): Promise<boolean> {
  return redis.setIfNotExists(`nin-prompt:wa:${userId}`, '1', NIN_WHATSAPP_GAP_S).catch(() => false);
}
