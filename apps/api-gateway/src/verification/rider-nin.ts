import { createHmac } from 'node:crypto';
import { prisma } from '@wheleers/db';
import type { RedisClient } from '../redis/client';
import { prembly, premblyConfigFromEnv, type PremblyConfig } from './prembly';

/**
 * A rider's NIN at sign-up (Timi, 16 Nov 2026), in the WhatsApp Welcome form
 * and the app's Create account. Never required: an empty box goes on. When one
 * is typed, Prembly (NIN Basic) looks it up while the rider waits and the name
 * on it is held against the name the rider gave; a wrong one gets a proper
 * message (checkRiderNinLive). Checked on the NIN screen, before the terms
 * (Timi's call, 16 Nov 2026: a message on the spot over asking after them).
 *
 * The number itself is never kept: only its last 4 digits, the outcome and
 * when (User.ninLast4, ninStatus, ninCheckedAt):
 *   VERIFIED   found, and the name matches
 *   NO_MATCH   found, another person's name
 *   NOT_FOUND  Prembly has no such NIN
 *   SUSPENDED  found, but the government has suspended it
 *   UNCHECKED  Prembly could not answer (down, our key or balance): nothing learned
 *   IN_USE     already verified on another Wheelers account (Timi, 20 Nov 2026: one NIN, one account); refused
 *              before Prembly is asked, so it costs nothing
 *
 * A VERIFIED NIN is kept as a keyed hash (User.ninHash, ninHash below) so the same NIN is known again on another
 * account; the number itself still never is.
 *
 * Each lookup costs money on our Prembly balance: at most 3 a day per rider,
 * and none once a rider is VERIFIED.
 */

export type NinStatus = 'VERIFIED' | 'NO_MATCH' | 'NOT_FOUND' | 'SUSPENDED' | 'UNCHECKED' | 'IN_USE';

export const NIN_CHECKS_PER_DAY = 3;

const dayKeyFor = (userId: string) => `rider-nin:${userId}:${new Date().toISOString().slice(0, 10)}`;

/** 11 digits (spaces and dashes taken out), or null. */
export function cleanNin(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const digits = String(raw).replace(/[\s-]/g, '');
  return /^\d{11}$/.test(digits) ? digits : null;
}

/**
 * The NIN as kept: HMAC-SHA256 with our secret (NIN_HASH_SECRET, else JWT_SECRET). A plain hash of 11 digits could
 * be undone by trying them all; without the secret it cannot. Null with no secret at all (never in production).
 */
export function ninHash(nin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = env.NIN_HASH_SECRET?.trim() || env.JWT_SECRET?.trim();
  return secret ? createHmac('sha256', secret).update(`nin:${nin}`).digest('hex') : null;
}

/** Another account already holds this NIN, verified. */
async function ninInUseElsewhere(userId: string, hash: string | null): Promise<boolean> {
  if (!hash) return false;
  const other = await prisma.user.findFirst({ where: { ninHash: hash, ninStatus: 'VERIFIED', NOT: { id: userId } }, select: { id: true } });
  return Boolean(other);
}

/** "Ada Obi": the first and last names on the record, as people write them (shown back to the rider on a match). */
export function ninRecordDisplayName(record: Record<string, unknown>): string | null {
  const titled = (value: unknown) => words(value).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');
  const first = titled(field(record, ['firstname', 'first_name', 'firstName']));
  const last = titled(field(record, ['surname', 'last_name', 'lastname', 'lastName']));
  const name = [first, last].filter(Boolean).join(' ');
  return name || null;
}

/** Whether anything was typed in the NIN box at all. */
export function ninTyped(raw: unknown): boolean {
  return (typeof raw === 'string' && raw.trim().length > 0) || typeof raw === 'number';
}

const words = (value: unknown): string[] =>
  typeof value === 'string'
    ? value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z\s'-]/g, ' ').split(/[\s'-]+/).filter((w) => w.length >= 2)
    : [];

function field(record: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) if (record[name] != null && record[name] !== '') return record[name];
  return undefined;
}

/** The names on the NIN record: first, middle and last, however Prembly spells the keys. */
export function ninRecordNames(record: Record<string, unknown>): string[] {
  return [
    ...words(field(record, ['firstname', 'first_name', 'firstName'])),
    ...words(field(record, ['middlename', 'middle_name', 'middleName'])),
    ...words(field(record, ['surname', 'last_name', 'lastname', 'lastName'])),
  ];
}

/**
 * The rider's name matches the record when at least two of the words they gave are on it (first and last, in
 * any order, a middle name counting too). One word given: that word must be on it.
 */
export function ninNameMatches(fullName: string, record: Record<string, unknown>): boolean {
  const given = [...new Set(words(fullName))];
  const onRecord = new Set(ninRecordNames(record));
  if (!given.length || !onRecord.size) return false;
  const hits = given.filter((w) => onRecord.has(w)).length;
  return given.length === 1 ? hits === 1 : hits >= 2;
}

/**
 * The government has suspended this NIN (Prembly's `nin_suspension_status`, seen on a real lookup, 16 Nov 2026):
 * never verified, whatever the name says.
 */
export function ninSuspended(record: Record<string, unknown>): boolean {
  const flag = record['nin_suspension_status'];
  return flag === true || (typeof flag === 'string' && flag.trim().toLowerCase() === 'true');
}

/** The record is for the NIN sent: when it carries a NIN, it must be the same one (a different record is not theirs). */
export function sameNin(record: Record<string, unknown>, nin: string): boolean {
  const back = record['nin'] ?? record['NIN'];
  if (back == null || back === '') return true;
  return cleanNin(back) === nin;
}

export interface RiderNinDeps {
  redis: RedisClient;
  config?: PremblyConfig | null;
  fetchImpl?: typeof fetch;
}

/**
 * Look the NIN up and write the outcome on the rider. Returns the status written, or null when nothing was
 * looked up (not 11 digits, already verified, over today's limit, Prembly not set up). Never throws.
 */
/** Take one of today's tries; false when they are used up. INCR is atomic; a store without it (tests) reads and writes. */
async function takeTry(redis: RedisClient, userId: string): Promise<boolean> {
  const key = dayKeyFor(userId);
  const store = redis as RedisClient & { send?: (...args: string[]) => Promise<unknown> };
  if (typeof store.send === 'function') {
    const n = Number(await store.send('INCR', key));
    if (n === 1) await store.send('EXPIRE', key, String(26 * 60 * 60)).catch(() => undefined);
    return n <= NIN_CHECKS_PER_DAY;
  }
  const used = Number(await redis.get(key).catch(() => null)) || 0;
  await redis.set(key, String(used + 1), 26 * 60 * 60).catch(() => undefined);
  return used < NIN_CHECKS_PER_DAY;
}

export interface NinLookup {
  status: NinStatus | 'LIMIT';
  /** On VERIFIED: the name on the record ("Ada Obi"), to show the rider it was really checked. */
  name?: string | null;
}

/**
 * Look the NIN up and write the outcome on the rider; the status and, when verified, the name on the record. Null
 * when nothing was looked up (not 11 digits, already verified, Prembly not set up). Never throws.
 */
export async function lookupRiderNin(userId: string, rawNin: unknown, fullName: string, deps: RiderNinDeps): Promise<NinLookup | null> {
  try {
    const nin = cleanNin(rawNin);
    if (!nin) return null;
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { ninStatus: true } });
    if (!user || user.ninStatus === 'VERIFIED') return null;
    const hash = ninHash(nin);
    // Verified on another account: refused before Prembly is asked (and paid).
    if (await ninInUseElsewhere(userId, hash)) {
      await prisma.user.update({ where: { id: userId }, data: { ninLast4: nin.slice(-4), ninStatus: 'IN_USE', ninCheckedAt: new Date() } });
      return { status: 'IN_USE' };
    }
    const config = deps.config === undefined ? premblyConfigFromEnv() : deps.config;
    if (!config) {
      console.warn('[rider-nin] CRITICAL: Prembly is not set up (PREMBLY_API_KEY): the NIN was not checked', { userId });
      return null;
    }
    // One of today's tries, taken atomically: two submits at the same moment never both get past the limit
    // (each lookup costs money on the Prembly balance).
    if (!(await takeTry(deps.redis, userId))) return { status: 'LIMIT' };

    const answer = await prembly.ninBasic(config, nin, deps.fetchImpl);
    const status: NinStatus = answer.kind === 'found'
      ? (!sameNin(answer.data, nin) ? 'NOT_FOUND' : ninSuspended(answer.data) ? 'SUSPENDED' : ninNameMatches(fullName, answer.data) ? 'VERIFIED' : 'NO_MATCH')
      : answer.kind === 'not_found' ? 'NOT_FOUND' : 'UNCHECKED';
    if (answer.kind === 'error') console.warn('[rider-nin] Prembly could not answer', { userId, detail: answer.detail });
    const at = new Date();
    if (status !== 'VERIFIED') {
      await prisma.user.update({ where: { id: userId }, data: { ninLast4: nin.slice(-4), ninStatus: status, ninCheckedAt: at } });
      return { status };
    }
    // Verified: claimed for this account under a lock on the NIN, so two accounts verifying it at the same moment
    // never both get it (the second is IN_USE).
    const written = await prisma.$transaction(async (tx) => {
      if (hash) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${hash}))`;
      const taken = hash ? await tx.user.findFirst({ where: { ninHash: hash, ninStatus: 'VERIFIED', NOT: { id: userId } }, select: { id: true } }) : null;
      const final: NinStatus = taken ? 'IN_USE' : 'VERIFIED';
      await tx.user.update({ where: { id: userId }, data: { ninLast4: nin.slice(-4), ninStatus: final, ninCheckedAt: at, ninHash: final === 'VERIFIED' ? hash : null } });
      return final;
    });
    return written === 'VERIFIED' ? { status: 'VERIFIED', name: answer.kind === 'found' ? ninRecordDisplayName(answer.data) : null } : { status: 'IN_USE' };
  } catch (error) {
    console.warn('[rider-nin] NIN check failed', { userId, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** The status only (the Welcome form, the app's sign-up). See lookupRiderNin. */
export async function checkRiderNin(userId: string, rawNin: unknown, fullName: string, deps: RiderNinDeps): Promise<NinStatus | 'LIMIT' | null> {
  return (await lookupRiderNin(userId, rawNin, fullName, deps))?.status ?? null;
}

/* ── Checked while the rider waits (Timi, 16 Nov 2026): a wrong NIN gets a proper message on the spot ── */

/** How long the form or the app waits for Prembly before letting the rider go on (the check finishes behind). */
export const NIN_LIVE_WAIT_MS = 7000;

/** The popup (no sign-up waiting on it) waits for the real answer: Prembly is usually quick, sometimes 20 s. */
export const NIN_PROMPT_WAIT_MS = 25_000;

export type NinLiveAnswer =
  | { ok: true; status: NinStatus | 'PENDING' | null; name?: string | null }
  | { ok: false; code: 'NIN_INVALID' | 'NIN_NOT_FOUND' | 'NIN_SUSPENDED' | 'NIN_OTHER_NAME' | 'NIN_TOO_MANY' | 'NIN_IN_USE' | 'NIN_UNCHECKED'; error: string };

export const NIN_ERRORS = {
  NIN_INVALID: 'NIN is 11 digits.',
  NIN_NOT_FOUND: "We couldn't find this NIN. Check the 11 digits and try again.",
  NIN_SUSPENDED: "We couldn't verify this NIN. Check it, or leave it empty for now.",
  NIN_OTHER_NAME: (name: string) => `This NIN isn't in the name ${name}. Check your NIN, or go back and fix your name.`,
  NIN_TOO_MANY: 'Too many tries. Leave it empty for now.',
  NIN_IN_USE: 'This NIN is already on another Wheelers account.',
  NIN_UNCHECKED: "We couldn't check your NIN right now. Try again in a few minutes.",
} as const;


/**
 * The NIN typed in the form or the app, checked now. Wrong (not 11 digits, no such NIN, another person's name,
 * too many tries today): a message for the rider. Right, or Prembly slow or down (not their fault): they go on,
 * and a slow check still finishes behind and is written. Never throws.
 */
export async function checkRiderNinLive(
  userId: string,
  rawNin: unknown,
  fullName: string,
  deps: RiderNinDeps & {
    waitMs?: number;
    check?: typeof checkRiderNin;
    /**
     * The NIN popup (not sign-up): nothing waits on it, so it is never "added" unless it really checked out.
     * Prembly down, not set up, or no answer in time: NIN_UNCHECKED, and the popup asks again later.
     */
    mustCheck?: boolean;
  },
): Promise<NinLiveAnswer> {
  const nin = cleanNin(rawNin);
  if (!nin) return { ok: false, code: 'NIN_INVALID', error: NIN_ERRORS.NIN_INVALID };
  const unchecked = { ok: false as const, code: 'NIN_UNCHECKED' as const, error: NIN_ERRORS.NIN_UNCHECKED };
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { ninStatus: true } });
    if (user?.ninStatus === 'VERIFIED') return { ok: true, status: 'VERIFIED' };
    const used = Number(await deps.redis.get(dayKeyFor(userId)).catch(() => null)) || 0;
    if (used >= NIN_CHECKS_PER_DAY) return { ok: false, code: 'NIN_TOO_MANY', error: NIN_ERRORS.NIN_TOO_MANY };
  } catch {
    /* the check below decides */
  }
  if (deps.mustCheck && !deps.check && (deps.config === undefined ? premblyConfigFromEnv() : deps.config) === null) return unchecked;
  const running: Promise<NinLookup | null> = deps.check
    ? deps.check(userId, nin, fullName, deps).then((status) => (status ? { status } : null))
    : lookupRiderNin(userId, nin, fullName, deps);
  let timer: NodeJS.Timeout | undefined;
  const slow = new Promise<'PENDING'>((resolve) => { timer = setTimeout(() => resolve('PENDING'), deps.waitMs ?? (deps.mustCheck ? NIN_PROMPT_WAIT_MS : NIN_LIVE_WAIT_MS)); });
  const result = await Promise.race([running, slow]);
  if (timer) clearTimeout(timer);
  const status = result === 'PENDING' ? 'PENDING' : result?.status ?? null;
  if (status === 'NOT_FOUND') return { ok: false, code: 'NIN_NOT_FOUND', error: NIN_ERRORS.NIN_NOT_FOUND };
  if (status === 'SUSPENDED') return { ok: false, code: 'NIN_SUSPENDED', error: NIN_ERRORS.NIN_SUSPENDED };
  if (status === 'LIMIT') return { ok: false, code: 'NIN_TOO_MANY', error: NIN_ERRORS.NIN_TOO_MANY };
  if (status === 'NO_MATCH') return { ok: false, code: 'NIN_OTHER_NAME', error: NIN_ERRORS.NIN_OTHER_NAME(fullName.trim() || 'you gave') };
  if (status === 'IN_USE') return { ok: false, code: 'NIN_IN_USE', error: NIN_ERRORS.NIN_IN_USE };
  if (deps.mustCheck && (status === 'UNCHECKED' || status === null)) return unchecked;
  return { ok: true, status, ...(result !== 'PENDING' && result?.name ? { name: result.name } : {}) };
}
