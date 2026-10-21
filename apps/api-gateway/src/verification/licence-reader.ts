import type { LlmClient } from '../LLM/llm';
import { readDay } from './driver-checks';

/**
 * Reading a Nigerian driver's licence off the photo (or PDF) the driver sent,
 * so the admin does not type the date of birth for the FRSC check by hand.
 * What it reads is a suggestion shown in the form, to be looked at against
 * the photo beside it before a paid check runs: never saved, never decides
 * anything.
 */
export type LicenceReading = {
  readable: boolean;
  licenceNumber: string | null;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  /** YYYY-MM-DD. */
  dateOfBirth: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  /** Why it could not read something: "blurry", "not a licence". */
  note: string | null;
};

const PROMPT = `
You are reading a Nigerian driver's licence (FRSC) from a photo or scan, to fill in a form.

Read exactly what is printed. Never guess or invent: a field you cannot read clearly is null.
- licenceNumber: the licence number (letters and digits, e.g. "KRD52734AA02"), no spaces.
- firstName, middleName, lastName: as printed. Nigerian licences usually print the SURNAME first, then the other names; put the surname in lastName.
- dateOfBirth, issuedOn, expiresOn: Nigerian licences print dates DAY first (DD-MM-YYYY or DD/MM/YYYY). Return each as YYYY-MM-DD.
- readable: false when this is not a driver's licence, or it is too blurry or cut off to read the date of birth.
- note: a few words on anything unclear, else null.

Return ONLY a JSON object:
{"readable": true|false, "licenceNumber": string|null, "firstName": string|null, "middleName": string|null, "lastName": string|null, "dateOfBirth": string|null, "issuedOn": string|null, "expiresOn": string|null, "note": string|null}
`.trim();

const text = (v: unknown, max = 60): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  return s && !/^(null|n\/a|none|unknown)$/i.test(s) ? s.slice(0, max) : null;
};

/** What the model sent back, cleaned: dates read as days, the number without spaces. Exported for the test. */
export function cleanReading(raw: Record<string, unknown>): LicenceReading {
  const number = text(raw.licenceNumber, 30)?.toUpperCase().replace(/[^A-Z0-9]/g, '') || null;
  const dob = readDay(raw.dateOfBirth);
  return {
    // Nothing to fill in is the same as unreadable, whatever the model said.
    readable: raw.readable !== false && Boolean(dob || number),
    licenceNumber: number,
    firstName: text(raw.firstName),
    middleName: text(raw.middleName),
    lastName: text(raw.lastName),
    // A birth date in the future, or a driver under 16, is a misread.
    dateOfBirth: dob && dob <= new Date(Date.now() - 16 * 365.25 * 86_400_000).toISOString().slice(0, 10) && dob >= '1920-01-01' ? dob : null,
    issuedOn: readDay(raw.issuedOn),
    expiresOn: readDay(raw.expiresOn),
    note: text(raw.note, 160),
  };
}

/** Null when no model is set up or it gave no answer. Never throws. */
export async function readLicencePhoto(llm: LlmClient, bytes: Buffer, mimeType: string): Promise<LicenceReading | null> {
  if (!llm.configured) return null;
  try {
    const raw = await llm.completeVisionJson(PROMPT, bytes, mimeType);
    return raw ? cleanReading(raw) : null;
  } catch (error) {
    console.warn('[licence-reader] could not read the licence', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
