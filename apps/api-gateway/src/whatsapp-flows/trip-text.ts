/**
 * The ONE way a trip is written out in the chat: pickup, each stop, destination,
 * a blank line between them, the places bold. Every message that shows a trip
 * — the trip card, "your bid is in", the ride card, the receipt, history — reads
 * from here, so they never drift apart again (they did: one card ran the ends
 * together, another bolded nothing).
 *
 * Forms cannot bold, so a form passes `bold: false` and keeps the same order
 * and spacing.
 */

export interface TripText {
  pickupAddress: string;
  destAddress: string;
  stops?: Array<{ address: string }>;
}

export function tripLines(trip: TripText, options: { bold?: boolean } = {}): string[] {
  const bold = options.bold ?? true;
  const place = (address: string) => (bold ? `*${address}*` : address);
  const lines = [`Pickup: ${place(trip.pickupAddress)}`];
  (trip.stops ?? []).forEach((stop, index) => {
    lines.push('', `Stop ${index + 1}: ${place(stop.address)}`);
  });
  lines.push('', `Destination: ${place(trip.destAddress)}`);
  return lines;
}

export function tripBlock(trip: TripText, options: { bold?: boolean } = {}): string {
  return tripLines(trip, options).join('\n');
}

/** "1.9 km · ~9 min · suggested fare ₦2,500" — the line under the trip. */
export function tripSummaryLine(trip: { distanceKm: number; durationSeconds: number; suggestedFareNgn?: number }): string {
  const parts = [`${trip.distanceKm.toFixed(1)} km`, `~${Math.max(1, Math.ceil(trip.durationSeconds / 60))} min`];
  if (trip.suggestedFareNgn) parts.push(`suggested fare ₦${trip.suggestedFareNgn.toLocaleString()}`);
  return parts.join(' · ');
}
