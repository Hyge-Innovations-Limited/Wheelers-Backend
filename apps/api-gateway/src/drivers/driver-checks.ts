import { driverCheckClient } from '@wheleers/db';

/**
 * What a rider sees was checked about a driver, on each offer (Timi, 14 Nov
 * 2026): NIN, licence, face, insurance, plate. Only a check that passed and is
 * still in date is shown; a failed, expired or missing one simply is not
 * there. Each comes with when it was checked, and insurance with its end date.
 *
 *   nin        the team approved the driver's KYC, with a NIN on it
 *   licence    the latest licence check (Prembly or by hand) said verified, and the licence has not run out
 *   face       the latest check of the face against the licence said verified
 *   insurance  the latest insurance check said verified, or the insurance paper was approved; and it has not run out
 *   plate      the latest plate check said verified
 */

export type DriverCheckKind = 'nin' | 'licence' | 'face' | 'insurance' | 'plate';
export type DriverCheckBadge = { kind: DriverCheckKind; at: string; until: string | null };

export type DriverCheckFacts = {
  kycStatus: string;
  licenceExpiresOn: Date | null;
  kycSubmission: { ninImageKey: string | null; status: string; reviewedAt: Date | null; submittedAt: Date | null } | null;
  /** Newest first. */
  checks: Array<{ kind: string; paperType: string | null; outcome: string; createdAt: Date }>;
  documents: Array<{ status: string; expiresOn: Date | null; reviewedAt: Date | null }>;
};

const ORDER: DriverCheckKind[] = ['nin', 'licence', 'face', 'insurance', 'plate'];

/** The start of today in Lagos, as a date-only value is stored. */
function lagosDay(now: number): number {
  const lagos = new Date(now + 3600_000);
  return Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), lagos.getUTCDate());
}

const inDate = (until: Date | null, today: number) => !until || until.getTime() >= today;

/** The newest check of one kind (a hand check of a paper counts as that paper's check). */
function latest(facts: DriverCheckFacts, kind: string, paperType?: string) {
  return facts.checks.find((c) => c.kind === kind || (paperType && c.kind === 'manual' && c.paperType === paperType)) ?? null;
}

export function driverCheckBadges(facts: DriverCheckFacts | null, now = Date.now()): DriverCheckBadge[] {
  if (!facts) return [];
  const today = lagosDay(now);
  const out = new Map<DriverCheckKind, DriverCheckBadge>();
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

  const kyc = facts.kycSubmission;
  // The driver is approved (by the team, whichever way) and their KYC carries a NIN.
  if (facts.kycStatus === 'APPROVED' && kyc?.ninImageKey) {
    out.set('nin', { kind: 'nin', at: iso(kyc.reviewedAt ?? kyc.submittedAt) ?? new Date(now).toISOString(), until: null });
  }

  const licence = latest(facts, 'licence', 'licence');
  if (licence?.outcome === 'verified' && inDate(facts.licenceExpiresOn, today)) {
    out.set('licence', { kind: 'licence', at: licence.createdAt.toISOString(), until: iso(facts.licenceExpiresOn) });
  }

  const face = latest(facts, 'licenceFace');
  if (face?.outcome === 'verified') out.set('face', { kind: 'face', at: face.createdAt.toISOString(), until: null });

  // Insurance: a passed check or an approved paper, and in date (the paper's end date when there is one).
  const paper = facts.documents[0] ?? null;
  const insuranceCheck = latest(facts, 'insurance', 'insurance');
  const until = paper?.expiresOn ?? null;
  const checked = insuranceCheck?.outcome === 'verified';
  const failed = insuranceCheck !== null && !checked;
  const approved = paper?.status === 'APPROVED';
  if (!failed && (checked || approved) && inDate(until, today)) {
    const at = checked ? insuranceCheck!.createdAt : paper?.reviewedAt ?? null;
    if (at) out.set('insurance', { kind: 'insurance', at: at.toISOString(), until: iso(until) });
  }

  const plate = latest(facts, 'plate');
  if (plate?.outcome === 'verified') out.set('plate', { kind: 'plate', at: plate.createdAt.toISOString(), until: null });

  return ORDER.flatMap((k) => (out.has(k) ? [out.get(k)!] : []));
}

/**
 * A driver's badges, kept 10 minutes per driver (the same driver bids on many
 * rides; checks change rarely). Never throws: on any error, no badges.
 */
const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; badges: DriverCheckBadge[] }>();
const inFlight = new Map<string, Promise<DriverCheckBadge[]>>();

export async function driverChecksFor(driverId: string | null | undefined, now = Date.now()): Promise<DriverCheckBadge[]> {
  if (!driverId) return [];
  const hit = cache.get(driverId);
  if (hit && now - hit.at < CACHE_MS) return hit.badges;
  const pending = inFlight.get(driverId);
  if (pending) return pending;
  const run = driverCheckClient.badgeFacts(driverId)
    .then((facts) => {
      const badges = driverCheckBadges(facts as DriverCheckFacts | null, now);
      cache.set(driverId, { at: now, badges });
      if (cache.size > 5000) cache.delete(cache.keys().next().value as string);
      return badges;
    })
    .catch(() => [] as DriverCheckBadge[])
    .finally(() => inFlight.delete(driverId));
  inFlight.set(driverId, run);
  return run;
}

/** The field spread into an offer: `checks` (possibly empty). */
export async function driverChecksField(driverId: string | null | undefined): Promise<{ checks: DriverCheckBadge[] }> {
  return { checks: await driverChecksFor(driverId) };
}

/** For tests. */
export function clearDriverChecksCache(): void {
  cache.clear();
}

