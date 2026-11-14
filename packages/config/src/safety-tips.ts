/**
 * Safety tips for riders (Timi, 14 Nov 2026): 30, ten for each moment of a
 * trip. Each trip shows three from each group: before (the ride page and the
 * app, while the driver is on the way), during (the WhatsApp "Trip started"
 * message) and after (over the receipt). The same three for one trip on every
 * screen; a different three from trip to trip.
 */

export type SafetyMoment = 'before' | 'during' | 'after';

export const SAFETY_TIPS: Readonly<Record<SafetyMoment, readonly string[]>> = {
  before: [
    'Check the plate matches before you get in.',
    "Check the driver's face matches their photo.",
    "Give your trip code only once you're in the car.",
    "Sit in the back if you're riding alone.",
    'Share your trip with someone you trust.',
    'Wait inside until your driver has arrived.',
    "Don't get into a car that came without a request.",
    "Check the car's colour and model too.",
    "Ask the driver your name; don't say it first.",
    'Keep your phone charged before a long trip.',
  ],
  during: [
    'Keep your seatbelt on.',
    'Follow the route on your map.',
    'Keep your bag on your lap or beside you.',
    'Use SOS if you feel unsafe.',
    'Keep windows up in slow traffic.',
    "Don't share personal details with the driver.",
    'Ask to stop somewhere busy if something feels wrong.',
    'Your driver should not pick up anyone else.',
    'Avoid calls about money or bank details on the trip.',
    'Trust your instinct: you can end the trip at a safe spot.',
  ],
  after: [
    'Check you have your phone, bag and keys.',
    'Pay only the agreed fare. Never extra to a personal account.',
    'Rate your driver: it keeps riders safe.',
    'Something wrong? Tell us within 24 hours.',
    "Don't share your trip code after the trip.",
    'Get out on the pavement side.',
    'Watch for bikes when you open the door.',
    "Lost something? Message us; we'll reach the driver.",
    'Check the receipt matches what you paid.',
    "Let someone know you've arrived.",
  ],
};

/** A number from the ride id (FNV-1a): the same ride always picks the same tips. */
function seedOf(rideId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < rideId.length; i += 1) {
    h ^= rideId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Three different tips for this ride and moment. Before the trip the first is
 * always the plate (named when known: "Check the plate is LAG 234 KJ."), then
 * two of the rest; during and after, any three.
 */
export function safetyTipsFor(rideId: string, moment: SafetyMoment, plate?: string | null): string[] {
  const all = SAFETY_TIPS[moment];
  const plateTip = moment === 'before' ? all[0]! : null;
  const list = plateTip ? all.slice(1) : all;
  const seed = seedOf(`${rideId}:${moment}`);
  const start = seed % list.length;
  // Any step that shares no factor with the list's length walks it without repeating.
  const steps = [1, 2, 3, 4, 5, 7, 8].filter((n) => gcd(n, list.length) === 1);
  const step = steps[(seed >>> 8) % steps.length]!;
  const picked = [0, 1, 2].map((i) => list[(start + i * step) % list.length]!);
  if (!plateTip) return picked;
  const cleanPlate = plate?.trim().toUpperCase();
  return [cleanPlate ? `Check the plate is ${cleanPlate}.` : plateTip, picked[0]!, picked[1]!];
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** The rider's line once the driver's phone is recording the trip. */
export const TRIP_RECORDED_LINE = 'This trip is recorded for your safety.';
