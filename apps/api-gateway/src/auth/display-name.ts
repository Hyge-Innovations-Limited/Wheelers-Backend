import { userClient } from '@wheleers/db';

/**
 * A name for someone who never gave one: the first word of their email,
 * capitalised. "timilehin.olowu46@gmail.com" → "Timilehin",
 * "timilehinolowu46@gmail.com" → "Timilehinolowu". Null when nothing usable
 * (no email, or only digits and symbols before the @).
 */
export function nameFromEmail(email?: string | null): string | null {
  const local = email?.split('@')[0]?.split('+')[0] ?? '';
  const first = local
    .split(/[._\-\s]+/)
    .map((part) => part.replace(/[^a-zA-Z]/g, ''))
    .find((part) => part.length >= 2);
  if (!first) return null;
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

/**
 * An account with no name gets one, and keeps it: the name Google / Apple /
 * the sign-up form gave, else one from the email. Never overwrites a name the
 * person has. The profile used to fall back to "Driver" (or "Rider").
 */
export async function fillMissingName<T extends { id: string; name: string | null; email: string | null }>(
  user: T,
  given?: string | null,
): Promise<T> {
  if (user.name?.trim()) return user;
  const name = given?.trim() || nameFromEmail(user.email);
  if (!name) return user;
  await userClient.updateProfile(user.id, { name }).catch(() => undefined);
  return { ...user, name };
}
