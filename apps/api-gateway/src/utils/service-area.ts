import { firstOutsideServiceArea, OUTSIDE_SERVICE_AREA_LINE } from '@wheleers/config';

export const OUTSIDE_SERVICE_AREA_CODE = 'OUTSIDE_SERVICE_AREA';

/**
 * A trip with a pickup, a stop or a destination outside Lagos is refused, in
 * words the rider sees as they are: "Wheelers is only in Lagos for now…".
 * The error carries a code, so the app (and a socket "error") can tell it from
 * a failure worth retrying.
 */
export function assertInServiceArea(points: Array<{ lat: number; lng: number } | null | undefined>): void {
  if (firstOutsideServiceArea(points)) {
    throw Object.assign(new Error(OUTSIDE_SERVICE_AREA_LINE), { code: OUTSIDE_SERVICE_AREA_CODE });
  }
}

/** The code of a refusal like the one above, for JSON replies. */
export function refusalCode(error: unknown): string | undefined {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}
