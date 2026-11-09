/**
 * Banks only accept plain letters in an account holder's name — emoji, symbols
 * and decorative Unicode fonts are rejected or, worse, accepted and then
 * mangled by the bank network ("Olá" plus a flower emoji became "OlÃƒÂ¡Ã‚Â¸ User"). WhatsApp
 * profile names carry all three, and a bad name means no usable deposit
 * account.
 *
 * The display name stays exactly as the user wrote it. Only what we hand to
 * the payment provider is cleaned: NFKD folds fancy letters back to ASCII
 * ("𝓐" → "A", "é" → "e"), everything that is not a letter, apostrophe or
 * hyphen becomes a space, and whatever is left is split into first/last.
 * Nothing usable → fallback.
 */
export interface BankNameParts {
  firstName: string;
  lastName: string;
}

const MAX_PART_LENGTH = 50;

/** Latin letters NFKD leaves alone — they have no accent to strip, they ARE the letter. */
const UNDECOMPOSABLE: Record<string, string> = {
  Ø: 'O', ø: 'o', Đ: 'D', đ: 'd', Ł: 'L', ł: 'l', Ħ: 'H', ħ: 'h',
  Æ: 'AE', æ: 'ae', Œ: 'OE', œ: 'oe', ß: 'ss', Þ: 'Th', þ: 'th', ı: 'i',
};

export function sanitizeBankName(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/[ØøĐđŁłĦħÆæŒœßÞþı]/g, (ch) => UNDECOMPOSABLE[ch] ?? ch)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    // A digit inside a handle ("Uri3l") is dropped, not turned into a gap —
    // "Uril" is a name, "Uri l" makes the bank print "L URI".
    .replace(/(?<=\p{L})\d+(?=\p{L})/gu, '')
    .replace(/[^A-Za-z'\-]+/g, ' ')
    .split(' ')
    .map((token) => token.replace(/^['-]+|['-]+$/g, ''))
    .filter((token) => /[A-Za-z]/.test(token))
    .map((token) => token.slice(0, MAX_PART_LENGTH))
    .join(' ');
}

export function bankNameParts(
  displayName: string | null | undefined,
  fallback: BankNameParts = { firstName: 'Wheelers', lastName: 'User' },
): BankNameParts {
  const parts = sanitizeBankName(displayName).split(' ').filter(Boolean);
  if (parts.length === 0) return { ...fallback };
  const firstName = parts[0];
  const lastName = parts.slice(1).join(' ').slice(0, MAX_PART_LENGTH).trim() || fallback.lastName;
  return { firstName, lastName };
}
