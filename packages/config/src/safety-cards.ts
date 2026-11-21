/**
 * Playful safety tips, one at a time (Timi, 21 Nov 2026): the tip that matters at this point of the ride, chosen by
 * how far the driver is, and still until the moment changes (nothing cycles). Every tip of the ride is one tap away
 * ("See all"). On WhatsApp the tip rides inside a message we already send (on the way, here, trip started, receipt).
 * Filled with the trip's own details (plate, driver, car, fare). The plain sentences in safety-tips.ts stay for apps
 * from before this.
 */

export type SafetyStage = 'far' | 'wait' | 'near' | 'close' | 'here' | 'trip' | 'after';
export type SafetyTone = 'orange' | 'ink' | 'cream' | 'green' | 'sky' | 'pink';

export interface SafetyCard {
  key: string;
  emoji: string;
  /** The small caps line above the title ("Plate check"). */
  kick: string;
  title: string;
  line: string;
  tone: SafetyTone;
}

export interface SafetyTrip {
  plate?: string | null;
  driverName?: string | null;
  vehicleModel?: string | null;
  fareNgn?: number | null;
}

const first = (name: string | null | undefined) => name?.trim().split(/\s+/)[0] || null;
const naira = (n: number) => `₦${Math.round(n).toLocaleString('en-NG')}`;

type Maker = (t: SafetyTrip) => Omit<SafetyCard, 'key'>;
const CARDS: Record<string, Maker> = {
  share: () => ({ emoji: '📍', kick: 'Share it', title: 'Let someone ride along', line: 'Share your trip live. One person should know where you are.', tone: 'sky' }),
  battery: () => ({ emoji: '🔋', kick: 'Battery', title: 'Charge before you go far', line: 'Your phone is your safety kit.', tone: 'green' }),
  inside: (t) => ({ emoji: '🏠', kick: 'Wait smart', title: 'Let the car come to you', line: `Wait inside till ${first(t.driverName) ?? 'your driver'} has arrived.`, tone: 'green' }),
  random: () => ({ emoji: '🚫', kick: 'Random car', title: "Didn't book it? Don't board it", line: 'A car that just shows up is not your car.', tone: 'ink' }),
  model: (t) => ({ emoji: '🚗', kick: 'Car check', title: 'Right car, right model', line: t.vehicleModel?.trim() ? `Look for a ${t.vehicleModel.trim()}. Not almost.` : 'Check the make and model, not just the colour.', tone: 'cream' }),
  plate: (t) => ({ emoji: '🚘', kick: 'Plate check', title: 'Plate or nothing', line: t.plate?.trim() ? `If it isn't ${t.plate.trim().toUpperCase()}, it isn't your ride.` : "If the plate doesn't match, it isn't your ride.", tone: 'orange' }),
  name: () => ({ emoji: '🗣️', kick: 'Name game', title: 'Make them say it', line: 'Ask who they’re picking up. They say your name, not you.', tone: 'orange' }),
  code: () => ({ emoji: '🔐', kick: 'Trip code', title: 'Code is for inside', line: 'Your 4 digits only once you’re in the car.', tone: 'cream' }),
  vip: () => ({ emoji: '👑', kick: 'Solo rider', title: 'Back seat is VIP', line: 'Riding alone? Sit in the back.', tone: 'pink' }),
  belt: () => ({ emoji: '🎗️', kick: 'Seatbelt', title: 'Click clack', line: 'Seatbelt on, even for short trips.', tone: 'orange' }),
  route: () => ({ emoji: '🗺️', kick: 'Route', title: 'Watch the line', line: 'Your map follows the route. So can you.', tone: 'sky' }),
  sos: () => ({ emoji: '🆘', kick: 'SOS', title: 'One tap, no explaining', line: 'Feel off? Press SOS. That’s what it’s for.', tone: 'ink' }),
  keys: () => ({ emoji: '🔑', kick: 'Pat-down', title: 'Phone, wallet, keys', line: 'Check before the door shuts.', tone: 'orange' }),
  fare: (t) => ({ emoji: '💸', kick: 'Fare', title: 'Agreed is agreed', line: `${t.fareNgn && t.fareNgn > 0 ? `Pay only ${naira(t.fareNgn)}.` : 'Pay only the agreed fare.'} Never extra, never to a personal account.`, tone: 'ink' }),
  okada: () => ({ emoji: '🏍️', kick: 'Okada alert', title: 'Look back, then open', line: 'Bikes come fast. Check before you open the door.', tone: 'cream' }),
};

/** The one tip for each point of the ride. */
export const STAGE_TIP: Readonly<Record<SafetyStage, string>> = {
  far: 'share', wait: 'inside', near: 'model', close: 'plate', here: 'name', trip: 'belt', after: 'keys',
};

/** Every tip of the ride, by when it matters ("See all"). */
export const SAFETY_GROUPS: ReadonlyArray<{ title: string; keys: readonly string[] }> = [
  { title: 'Before your driver arrives', keys: ['share', 'battery', 'inside', 'random', 'model', 'plate'] },
  { title: 'When your driver is here', keys: ['name', 'code', 'vip'] },
  { title: 'On the trip', keys: ['belt', 'route', 'sos'] },
  { title: 'After the trip', keys: ['keys', 'fare', 'okada'] },
];

export function safetyCard(key: string, trip: SafetyTrip): SafetyCard {
  const make = CARDS[key] ?? CARDS.plate;
  return { key: CARDS[key] ? key : 'plate', ...make(trip) };
}

/**
 * Where the ride is: the driver coming (by minutes away: over 8 far, over 4 waiting, over 1.5 near, else close),
 * here, on the trip, or done. Minutes not known: near.
 */
export function safetyStageFor(input: { phase: 'coming' | 'here' | 'trip' | 'after'; etaSeconds?: number | null }): SafetyStage {
  if (input.phase !== 'coming') return input.phase;
  const eta = input.etaSeconds;
  if (eta === null || eta === undefined || !Number.isFinite(eta)) return 'near';
  if (eta > 8 * 60) return 'far';
  if (eta > 4 * 60) return 'wait';
  if (eta > 90) return 'near';
  return 'close';
}

/** Everything a screen needs: the tip for each point of the ride, and every tip by group. */
export function safetyCardsFor(trip: SafetyTrip): { byStage: Record<SafetyStage, SafetyCard>; groups: Array<{ title: string; cards: SafetyCard[] }> } {
  const byStage = Object.fromEntries(Object.entries(STAGE_TIP).map(([stage, key]) => [stage, safetyCard(key, trip)])) as Record<SafetyStage, SafetyCard>;
  return { byStage, groups: SAFETY_GROUPS.map((g) => ({ title: g.title, cards: g.keys.map((k) => safetyCard(k, trip)) })) };
}

/** The tip as one WhatsApp line: "🚘 *Plate or nothing.* If it isn't LAG 234 KJ, it isn't your ride." */
export function safetyCardLine(card: SafetyCard): string {
  const title = /[.?!]$/.test(card.title) ? card.title : `${card.title}.`;
  return `${card.emoji} *${title}* ${card.line}`;
}
