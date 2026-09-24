import { rideClient } from '@wheleers/db';
import type { RouteStop } from '../whatsapp-flows/bid-state';

/**
 * Quick actions: the one place a rider can see everything the bot does.
 *
 * WhatsApp gives a bot no permanent menu, and reply buttons stop at three —
 * so this is a LIST message: one short body, one "Quick Actions" button, and WhatsApp's
 * own picker behind it with up to ten rows. It is sent when the rider asks for
 * it ("menu", "help", a bare greeting with nothing going on), when the bot did
 * not understand and nothing is in progress, and right after the privacy
 * Continue, so a new rider sees what exists.
 *
 * Every row's id is a plain verb the webhook dispatches on (QUICK_ACTION_IDS).
 * Repeat and Reverse are only offered when there is a completed trip to
 * repeat; History lists the places they have actually been, each one
 * repeatable. Building the messages is pure — this file sends nothing — so the
 * tests can look at exactly what a rider would tap.
 */

export const QUICK_ACTION_IDS = {
  book: 'qa_book',
  repeat: 'qa_repeat',
  reverse: 'qa_reverse',
  history: 'qa_history',
  currentTrip: 'qa_current',
  addMoney: 'qa_deposit',
  withdraw: 'qa_withdraw',
  support: 'qa_support',
} as const;

/** A row in the History list: `qa_hist:<rideId>`; the follow-up buttons: `qa_again:<rideId>` / `qa_back:<rideId>`. */
export const HISTORY_ROW = /^qa_hist:([0-9a-f-]{36})$/;
export const REPEAT_ROW = /^qa_again:([0-9a-f-]{36})$/;
export const REVERSE_ROW = /^qa_back:([0-9a-f-]{36})$/;

export const isQuickActionId = (id: string | undefined): boolean =>
  Boolean(id) && (Object.values(QUICK_ACTION_IDS).includes(id as never) || HISTORY_ROW.test(id!) || REPEAT_ROW.test(id!) || REVERSE_ROW.test(id!));

/** "menu", "options", "what can you do" — the words that open this without a button. */
export function asksForMenu(message: string): boolean {
  return /^(actions?|menu|options?|quick actions?|what can (you|u) do|help me|show (menu|actions)|main menu)[\s!?.]*$/i.test(message.trim());
}

/** A completed trip, as the history needs it: both ends, the stops in order, what it cost. */
export interface PastTrip {
  rideId: string;
  when: Date;
  pickup: RouteStop;
  destination: RouteStop;
  stops: RouteStop[];
  fareNgn: number;
}

export async function recentTrips(riderId: string, limit = 5): Promise<PastTrip[]> {
  const rows = await rideClient.recentCompletedForRider(riderId, limit).catch(() => []);
  return rows.map((row) => ({
    rideId: row.id,
    when: row.completedAt ?? row.createdAt,
    pickup: { lat: row.pickupLat, lng: row.pickupLng, address: row.pickupAddress },
    destination: { lat: row.destLat, lng: row.destLng, address: row.destAddress },
    stops: row.routeStops.map((stop) => ({ lat: stop.lat, lng: stop.lng, address: stop.address })),
    fareNgn: Number(row.fareFinalNgn ?? row.agreedFareNgn ?? row.riderOfferNgn ?? 0),
  }));
}

/** The same trip, the other way round: ends swapped, stops in reverse order. */
export function reversed(trip: PastTrip): Pick<PastTrip, 'pickup' | 'destination' | 'stops'> {
  return { pickup: trip.destination, destination: trip.pickup, stops: [...trip.stops].reverse() };
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);
/** "Ikorodu Garage" from "Ikorodu Garage, Lagos Rd, Ikorodu, Lagos, Nigeria". */
export const shortPlace = (address: string) => address.split(',')[0]?.trim() || address;

interface MenuInput {
  /** "Hey" gets a hello; "menu" gets straight to it. */
  greeting: boolean;
  /** Their first name, when we have one — "Hi Timi" rather than "Hi". */
  firstName?: string | null;
  lastTrip: PastTrip | null;
  /** A search or trip is live: Book/Repeat make no sense, "your current trip" does. */
  busy: boolean;
  supportContact: string | null;
}

/** The quick-actions message, as WhatsApp wants it. */
export function buildQuickActions(input: MenuInput): Record<string, unknown> {
  const ride = input.busy
    ? [{ id: QUICK_ACTION_IDS.currentTrip, title: 'Your current trip', description: 'Where things are with your ride right now' }]
    : [
        { id: QUICK_ACTION_IDS.book, title: 'Book a ride', description: 'Tell me where you are going' },
        ...(input.lastTrip ? [
          { id: QUICK_ACTION_IDS.repeat, title: 'Repeat last ride', description: clip(`${shortPlace(input.lastTrip.pickup.address)} → ${shortPlace(input.lastTrip.destination.address)}`, 72) },
          { id: QUICK_ACTION_IDS.reverse, title: 'Reverse last ride', description: clip(`${shortPlace(input.lastTrip.destination.address)} → ${shortPlace(input.lastTrip.pickup.address)}`, 72) },
        ] : []),
        { id: QUICK_ACTION_IDS.history, title: 'Ride history', description: 'Places you have been — book any of them again' },
      ];

  return {
    type: 'list',
    // A greeting is answered like one. The balance is not here: nobody said
    // "wallet", and a rider saying hello does not need to be told their money.
    body: { text: input.greeting
      ? `Hey${input.firstName ? ` ${input.firstName}` : ''}! 👋 Good to see you.\n\nTap *Quick Actions* to book a ride, add money, or see where you have been.`
      : `Here is everything I can do. 👇` },
    action: {
      button: 'Quick Actions',
      sections: [
        { title: 'Ride', rows: ride },
        { title: 'Wallet', rows: [
          { id: QUICK_ACTION_IDS.addMoney, title: 'Add money', description: 'Get your account number to transfer to' },
          { id: QUICK_ACTION_IDS.withdraw, title: 'Withdraw', description: 'Send money from your wallet to your bank' },
        ] },
        ...(input.supportContact ? [{ title: 'Help', rows: [
          { id: QUICK_ACTION_IDS.support, title: 'Contact support', description: 'Talk to a person at Wheelers' },
        ] }] : []),
      ],
    },
  };
}

/** The history list: one row per past trip, newest first. Null when there are none. */
export function buildHistoryList(trips: PastTrip[]): Record<string, unknown> | null {
  if (trips.length === 0) return null;
  const day = (when: Date) => when.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' });
  return {
    type: 'list',
    body: { text: `🕘 *Your recent rides*\n\nPick one to book it again — the same way, or back the other way.` },
    action: {
      button: 'Choose a ride',
      sections: [{
        title: 'Places you have been',
        rows: trips.slice(0, 10).map((trip) => ({
          id: `qa_hist:${trip.rideId}`,
          title: clip(`${day(trip.when)} · ₦${trip.fareNgn.toLocaleString()}`, 24),
          description: clip(`${shortPlace(trip.pickup.address)} → ${shortPlace(trip.destination.address)}${trip.stops.length ? ` · ${trip.stops.length} stop${trip.stops.length === 1 ? '' : 's'}` : ''}`, 72),
        })),
      }],
    },
  };
}

/** After picking a past trip (or on the receipt): the same way, or back. */
export function buildRepeatButtons(trip: PastTrip, headline: string): Record<string, unknown> {
  return {
    type: 'button',
    body: { text: `${headline}\n\n📍 ${trip.pickup.address}\n${trip.stops.map((stop) => `🔸 ${stop.address}\n`).join('')}🏁 ${trip.destination.address}` },
    action: {
      buttons: [
        { type: 'reply', reply: { id: `qa_again:${trip.rideId}`, title: 'Repeat this ride' } },
        { type: 'reply', reply: { id: `qa_back:${trip.rideId}`, title: 'Reverse this ride' } },
      ],
    },
  };
}
