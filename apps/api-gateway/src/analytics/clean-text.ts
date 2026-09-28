/**
 * Names and addresses as the spreadsheet shows them: one plain style, however
 * people typed them into WhatsApp.
 *
 *   𝐾𝐼𝑁𝐺     → King          styled letters become plain ones
 *   Olá🌸     → Olá           emoji and their joiners go
 *   oke  oyebade → Oke Oyebade  spaces collapse; each word capitalised
 *
 * Only the export is cleaned. What people chose to be called is stored as they
 * typed it.
 */

// Pictographs, flags, keycaps, skin tones, and the invisible characters that glue them.
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}]/gu;
// Control and formatting characters (zero-width spaces, direction marks).
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

function plain(text: string): string {
  return text
    .normalize('NFKC') // 𝐾𝐼𝑁𝐺 → KING, ｆｕｌｌｗｉｄｔｈ → fullwidth, ﬁ → fi
    .replace(EMOJI, ' ')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Capitalise each word, keeping the letters after an apostrophe or hyphen: O'Neil, Ade-Bayo. */
function titleCase(text: string): string {
  return text
    .toLocaleLowerCase('en-NG')
    .replace(/(^|[\s'’\-.])(\p{L})/gu, (_, before: string, letter: string) => before + letter.toLocaleUpperCase('en-NG'));
}

/** A person's name, cleaned. Blank or nothing but emoji becomes the fallback. */
export function cleanName(name: string | null | undefined, fallback = 'No name'): string {
  const text = plain(name ?? '');
  // A name with no letters at all ("🌸", "...") is no name.
  if (!/\p{L}/u.test(text)) return fallback;
  return titleCase(text);
}

/** An address or free text, cleaned but left in its own capitals. */
export function cleanText(text: string | null | undefined): string {
  return plain(text ?? '');
}
