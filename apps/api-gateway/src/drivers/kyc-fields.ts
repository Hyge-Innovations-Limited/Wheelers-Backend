/**
 * The five things a driver hands in for verification, and what an admin can
 * send back to be fixed. `vehicle` is the car's details (make, model, plate,
 * year); `vehiclePhotos` the 7–10 photos. They used to be one review item, so
 * an older admin page that rejects `vehicle` without ever reviewing the
 * photos means both (see rejectedFieldsFrom).
 */
export const KYC_FIELDS = ['nin', 'licence', 'selfie', 'vehicle', 'vehiclePhotos'] as const;
export type KycField = (typeof KYC_FIELDS)[number];

export const KYC_FIELD_LABELS: Record<KycField, string> = {
  nin: 'NIN card',
  licence: "Driver's licence",
  selfie: 'Face check',
  vehicle: 'Vehicle details',
  vehiclePhotos: 'Vehicle photos',
};

export function isKycField(value: unknown): value is KycField {
  return typeof value === 'string' && (KYC_FIELDS as readonly string[]).includes(value);
}

type FieldStatus = { status?: unknown; reason?: unknown };

function fieldStatusesOf(raw: unknown): Record<string, FieldStatus> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, FieldStatus>) : {};
}

/**
 * Which items go back to the driver. Whatever the admin named, in the order
 * the driver fills them in; nothing named means the whole application.
 */
export function rejectedFieldsFrom(requested: unknown[], fieldStatusesRaw: unknown): KycField[] {
  const named = new Set(requested.filter(isKycField));
  const statuses = fieldStatusesOf(fieldStatusesRaw);
  // An admin page from before the split reviewed the car as one item.
  if (named.has('vehicle') && !statuses.vehiclePhotos) named.add('vehiclePhotos');
  if (named.size === 0) return [...KYC_FIELDS];
  return KYC_FIELDS.filter((f) => named.has(f));
}

/** The admin's reason for each rejected item, from the per-item review. */
export function fieldReasonsFrom(fieldStatusesRaw: unknown, fields: readonly string[]): Partial<Record<KycField, string>> {
  const statuses = fieldStatusesOf(fieldStatusesRaw);
  const out: Partial<Record<KycField, string>> = {};
  for (const field of fields) {
    if (!isKycField(field)) continue;
    const entry = statuses[field];
    const reason = typeof entry?.reason === 'string' ? entry.reason.trim() : '';
    if (entry?.status === 'rejected' && reason) out[field] = reason;
  }
  return out;
}

/**
 * The sentence a driver reads: "Driver's licence: photo is blurry." per item,
 * never the internal keys. Falls back to the admin's overall reason.
 */
export function readableRejection(fields: readonly KycField[], reasons: Partial<Record<KycField, string>>, fallback: string | null): string {
  const lines = fields
    .filter((f) => reasons[f])
    .map((f) => `${KYC_FIELD_LABELS[f]}: ${reasons[f]!.replace(/[.\s]+$/, '')}.`);
  if (lines.length > 0) return lines.join(' ');
  return fallback?.trim() || 'Your documents did not pass review.';
}
