import { zoneFor } from '@wheleers/config';

/** Group rides (Timi, 17 Nov 2026): what one rider is shown of another — a first name and an area, nothing more. */

/**
 * A first name fit to show to another rider (and to send in a WhatsApp message to a stranger): letters, an apostrophe
 * or a hyphen only, at most 20; anything else (a link, digits, a dot) is "Rider".
 */
export function firstNameOf(name: string | null | undefined): string {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  return /^[\p{L}][\p{L}'’-]{0,19}$/u.test(first) ? first : 'Rider';
}

const NOT_AN_AREA = /^(lagos|lagos state|nigeria|ng|\d{4,6}|.*\bstate)$/i;
const STREETISH = /(\d|\b(flat|block|blk|house|no\.?|plot|road|rd|street|st|avenue|ave|crescent|cres|close|way|drive|dr|lane|ln|junction|bus stop)\b)/i;

/**
 * Where another rider gets in or out, as an area only (never their street or house): the address part that names a
 * place and not a street, else the launch zone it is in, else "nearby".
 */
export function areaOf(address: string | null | undefined, lat?: number, lng?: number): string {
  const parts = (address ?? '').split(',').map((p) => p.trim()).filter((p) => p && !NOT_AN_AREA.test(p));
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (i === 0 && parts.length > 1) break; // the first part of a full address is the street or the building
    if (!STREETISH.test(parts[i]!)) return parts[i]!;
  }
  const zone = typeof lat === 'number' && typeof lng === 'number' ? zoneFor(lat, lng) : null;
  return zone ?? 'nearby';
}
