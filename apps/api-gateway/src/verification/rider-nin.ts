import { prisma } from '@wheleers/db';
import type { RedisClient } from '../redis/client';
import { prembly, premblyConfigFromEnv, type PremblyConfig } from './prembly';

/**
 * A rider's NIN at sign-up (Timi, 16 Nov 2026), in the WhatsApp Welcome form
 * and the app's Create account. Never required: an empty box goes on. When one
 * is typed, Prembly (NIN Basic) looks it up and the name on it is held against
 * the name the rider gave. Only after they agreed to the privacy policy (no
 * data to a third party before that).
 *
 * The number itself is never kept: only its last 4 digits, the outcome and
 * when (User.ninLast4, ninStatus, ninCheckedAt):
 *   VERIFIED   found, and the name matches
 *   NO_MATCH   found, another person's name
 *   NOT_FOUND  Prembly has no such NIN
 *   UNCHECKED  Prembly could not answer (down, our key or balance): nothing learned
 *
 * Each lookup costs money on our Prembly balance: at most 3 a day per rider,
 * and none once a rider is VERIFIED.
 */

export type NinStatus = 'VERIFIED' | 'NO_MATCH' | 'NOT_FOUND' | 'UNCHECKED';

export const NIN_CHECKS_PER_DAY = 3;

/** 11 digits (spaces and dashes taken out), or null. */
export function cleanNin(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const digits = String(raw).replace(/[\s-]/g, '');
  return /^\d{11}$/.test(digits) ? digits : null;
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

export interface RiderNinDeps {
  redis: RedisClient;
  config?: PremblyConfig | null;
  fetchImpl?: typeof fetch;
}

/**
 * Look the NIN up and write the outcome on the rider. Returns the status written, or null when nothing was
 * looked up (not 11 digits, already verified, over today's limit, Prembly not set up). Never throws.
 */
export async function checkRiderNin(userId: string, rawNin: unknown, fullName: string, deps: RiderNinDeps): Promise<NinStatus | null> {
  try {
    const nin = cleanNin(rawNin);
    if (!nin) return null;
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { ninStatus: true } });
    if (!user || user.ninStatus === 'VERIFIED') return null;
    const config = deps.config === undefined ? premblyConfigFromEnv() : deps.config;
    if (!config) {
      console.warn('[rider-nin] Prembly is not set up: the NIN was not checked', { userId });
      return null;
    }
    const dayKey = `rider-nin:${userId}:${new Date().toISOString().slice(0, 10)}`;
    const used = Number(await deps.redis.get(dayKey).catch(() => null)) || 0;
    if (used >= NIN_CHECKS_PER_DAY) return null;
    await deps.redis.set(dayKey, String(used + 1), 26 * 60 * 60).catch(() => undefined);

    const answer = await prembly.ninBasic(config, nin, deps.fetchImpl);
    const status: NinStatus = answer.kind === 'found'
      ? (ninNameMatches(fullName, answer.data) ? 'VERIFIED' : 'NO_MATCH')
      : answer.kind === 'not_found' ? 'NOT_FOUND' : 'UNCHECKED';
    if (answer.kind === 'error') console.warn('[rider-nin] Prembly could not answer', { userId, detail: answer.detail });
    await prisma.user.update({ where: { id: userId }, data: { ninLast4: nin.slice(-4), ninStatus: status, ninCheckedAt: new Date() } });
    return status;
  } catch (error) {
    console.warn('[rider-nin] NIN check failed', { userId, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
