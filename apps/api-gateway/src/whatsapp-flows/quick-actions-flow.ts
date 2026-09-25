import type { GoogleMapsRoutePlanner } from '@wheleers/config';
import { rideClient, userClient, virtualAccountClient, walletClient } from '@wheleers/db';
import { recentTrips, reversed, shortPlace, type PastTrip } from '../http/quick-actions';
import type { RedisClient } from '../redis/client';
import type { GatewayPublisher } from '../websocket/publisher';
import {
  clearBookingMisses, clearBookingStage, clearPendingAreaHint, clearPendingFarPlace, clearPendingGeoChoices, clearPendingLocation, clearPendingRoute,
  getAcceptedBid, getActiveRide, getBids, getGroupSeat, getLastRoute, getPendingRoute, getRideMeta, getRideState, getSearchTimedOut,
  markOffersMessageOpened, setBookingStage, storePendingRoute,
} from './bid-state';
import type { PendingRouteData } from './bid-state';
import {
  confirm, doneScreen, priceScreen, reviewScreen, setPrice,
  EXPIRED_NOTE, SEARCHING_NOTE, type EditTripFlowDeps,
} from './edit-trip-flow';
import type { FlowRequestBody } from './encryption';
import { handleOffersFormFlow, offersScreen, republishLastSearch, type OffersFormDeps } from './offers-form-flow';

/**
 * Quick Actions — the menu as ONE WhatsApp Flow. One message, one button, and
 * everything the bot does behind it as screens that link to each other:
 *
 *   MENU          Continue your booking / Book a ride / Repeat / Reverse /
 *                 Ride history / Your current trip / Add money / Withdraw /
 *                 Contact support — built live on open, so it only offers
 *                 what makes sense right now                       [Continue]
 *   HISTORY       the last ten trips                → TRIP
 *   TRIP          one past trip, Repeat or Reverse  → REVIEW_TRIP
 *   (Book a ride)  closes the form: booking is the chat's job — a location pin,
 *                 "from X to Y", the place picker — one clear prompt goes there
 *   REVIEW_TRIP   the planned trip and its fare      [Confirm trip] → SET_PRICE
 *   SET_PRICE     the price                          [Find drivers] → DONE
 *   STATUS        the current trip: the driver on the way, or the search with
 *                 a button that keeps checking for offers → OFFERS
 *   OFFERS        the offers form's own list: accept, change price, decline
 *   CHANGE_PRICE  all, cancel — the same handler, so the money rules are not
 *   CANCEL_SEARCH restated here
 *   ADD_MONEY     the account number to transfer to, right on the screen
 *   SUPPORT       the contact
 *   DONE          terminal
 *
 * What used to be two, three or four chat messages (menu, history list,
 * Repeat/Reverse buttons, trip card) is one message and some taps. The chat
 * hears from the form only when there is something the rider must keep: the
 * driver's card after an accept, the Add money button when the wallet is
 * short, the Withdraw button (it needs the PIN and a bank, which stay on the
 * page), the See driver offers button once a bid is in, the booking prompt.
 *
 * A flow may only OPEN on its entry screen, so INIT always answers MENU.
 */

export interface QuickActionsFlowDeps {
  redisClient: RedisClient;
  publisher: GatewayPublisher;
  googleMapsApiKey: string;
  routePlanner: GoogleMapsRoutePlanner;
  /** Where "Contact support" points. Null hides the row. */
  supportContact?: () => string | null;
  onRideConfirmed?: OffersFormDeps['onRideConfirmed'];
  onWalletShort?: OffersFormDeps['onWalletShort'];
  /** Withdraw needs the PIN and a bank: send the chat the Withdraw button. */
  onWithdraw?: (userId: string) => Promise<void>;
  /** No account number yet: open one now. Null when it is still on its way. */
  ensureDepositAccount?: (userId: string) => Promise<VirtualAccountLines | null>;
  /** Book a ride: the form closes and the chat asks where they are going. */
  onBookInChat?: (userId: string) => Promise<void>;
  /** A bid placed here: the chat gets the See driver offers button. */
  onBidPlaced?: EditTripFlowDeps['onBidPlaced'];
}

export interface VirtualAccountLines { bankName: string; accountNumber: string; accountName: string }

type FlowScreen = { screen: string; data: Record<string, unknown> };

export const MENU_IDS = {
  resume: 'resume', searchAgain: 'search_again', book: 'book', repeat: 'repeat', reverse: 'reverse', history: 'history',
  current: 'current', deposit: 'deposit', withdraw: 'withdraw', support: 'support',
} as const;
const MENU_ID_SET = new Set<string>(Object.values(MENU_IDS));
const TRIP_ROW = /^trip:([0-9a-f-]{36})$/;

const BUSY_NOTE = 'You already have a ride going. Finish or cancel it first, then book again.';
const ENDED_NOTE = 'Nothing was charged. Send your trip again in the chat.';
const CHECK_OFFERS_MS = 3_500;

/**
 * Is a driver on this ride? Redis says so for 30 minutes; a long trip outlives that, and
 * the pointer to the ride lives three hours. The ride row is the truth after Redis forgets.
 */
async function driverOnRide(redisClient: RedisClient, rideId: string): Promise<'on_the_way' | 'driving' | null> {
  const state = await getRideState(redisClient, rideId).catch(() => null);
  if (state === 'in_progress') return 'driving';
  if (state === 'confirmed') return 'on_the_way';
  if (state) return null;
  const ride = await rideClient.findById(rideId).catch(() => null);
  if (ride?.status === 'IN_PROGRESS') return 'driving';
  if (ride?.status === 'DRIVER_ASSIGNED' || ride?.status === 'DRIVER_EN_ROUTE' || ride?.status === 'ARRIVED') return 'on_the_way';
  return null;
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);
const naira = (amount: number) => `₦${amount.toLocaleString()}`;
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every request the Quick Actions form makes: opening it, and every Continue button on every screen. */
export async function handleQuickActionsFlow(body: FlowRequestBody, userId: string, deps: QuickActionsFlowDeps): Promise<FlowScreen> {
  const data = body.data ?? {};
  const action = inferAction(data, body.screen ?? '');
  if (body.action !== 'data_exchange' || !action) return menuScreen(userId, deps);

  // The offers form's screens, verbatim: its handler reads the active ride itself.
  if (action === 'offers_choice' || action === 'update_price' || action === 'cancel_search') {
    return handleOffersFormFlow({ ...body, data: { ...data, action } }, userId, offersDeps(deps));
  }
  // The Edit-trip form's review and price screens, verbatim: a repeated trip is confirmed and priced by the same code.
  if (action === 'confirm_trip' || action === 'set_price') {
    const [trip, activeRideId] = await Promise.all([getPendingRoute(deps.redisClient, userId), getActiveRide(deps.redisClient, userId)]);
    if (activeRideId) return doneScreen('Already searching', SEARCHING_NOTE);
    if (!trip) return doneScreen('This trip has expired', EXPIRED_NOTE);
    return action === 'confirm_trip' ? confirm(userId, trip, editDeps(deps)) : setPrice(data, userId, trip, editDeps(deps));
  }

  if (action === 'menu_choice') return menuChoice(text(data['choice']), userId, deps);
  if (action === 'history_pick') return historyPick(text(data['trip']), userId, deps);
  if (action === 'trip_direction') return tripDirection(text(data['ride_id']), text(data['direction']), userId, deps);
  if (action === 'status_next') return statusNext(userId, deps);
  return menuScreen(userId, deps);
}

/** Phones cache flow JSON and old copies drop our `action` tag — the payload's shape and the screen still say what it is. */
function inferAction(data: Record<string, unknown>, screen: string): string | null {
  if (typeof data['action'] === 'string') return data['action'];
  if (typeof data['choice'] === 'string') {
    if (screen === 'OFFERS') return 'offers_choice';
    return MENU_ID_SET.has(data['choice']) ? 'menu_choice' : 'offers_choice';
  }
  if (typeof data['trip'] === 'string') return 'history_pick';
  if (typeof data['direction'] === 'string') return 'trip_direction';
  if (data['price'] !== undefined) return 'set_price';
  if (data['new_price'] !== undefined) return 'update_price';
  if (typeof data['reason'] === 'string') return 'cancel_search';
  if (screen === 'REVIEW_TRIP') return 'confirm_trip';
  if (screen === 'STATUS') return 'status_next';
  return null;
}

const editDeps = (deps: QuickActionsFlowDeps): EditTripFlowDeps => ({
  redisClient: deps.redisClient, googleMapsApiKey: deps.googleMapsApiKey, routePlanner: deps.routePlanner, publisher: deps.publisher, onBidPlaced: deps.onBidPlaced,
});
const offersDeps = (deps: QuickActionsFlowDeps): OffersFormDeps => ({
  redisClient: deps.redisClient, publisher: deps.publisher, onRideConfirmed: deps.onRideConfirmed, onWalletShort: deps.onWalletShort,
});

// ── MENU ─────────────────────────────────────────────────────────────────

export async function menuScreen(userId: string, deps: QuickActionsFlowDeps, error = ''): Promise<FlowScreen> {
  const [activeRideId, trip, who] = await Promise.all([
    getActiveRide(deps.redisClient, userId),
    getPendingRoute(deps.redisClient, userId),
    userClient.findById(userId).catch(() => null),
  ]);
  const firstName = who?.name?.trim().split(/\s+/)[0] || '';
  const support = deps.supportContact?.() ?? null;
  const choices: Array<{ id: string; title: string; description: string }> = [];

  if (activeRideId) {
    const [driver, seat] = await Promise.all([driverOnRide(deps.redisClient, activeRideId), getGroupSeat(deps.redisClient, activeRideId).catch(() => null)]);
    const description = driver
      ? (driver === 'driving' ? 'Your driver is driving you now' : 'Your driver is on the way — where things are')
      : seat ? 'Your group ride — where things are'
      : await getBids(deps.redisClient, activeRideId).then((bids) => (bids.length === 0
        ? 'Still looking for drivers — check for offers'
        : bids.length === 1 ? '1 driver offer waiting for you' : `${bids.length} driver offers waiting for you`)).catch(() => 'Where things are with your ride');
    choices.push({ id: MENU_IDS.current, title: 'Your current trip', description });
  } else {
    if (trip) choices.push({ id: MENU_IDS.resume, title: 'Continue your booking', description: clip(`${shortPlace(trip.pickupAddress)} → ${shortPlace(trip.destAddress)}${trip.confirmed ? ' — name your price' : ''}`, 300) });
    else {
      // The last search ran out with no driver: the way back in is one row, not a message.
      const [ended, last] = await Promise.all([getSearchTimedOut(deps.redisClient, userId), getLastRoute(deps.redisClient, userId)]);
      if (ended && last) choices.push({ id: MENU_IDS.searchAgain, title: 'Search again', description: clip(`No driver took ${naira(ended.offerNgn || last.offerNgn)} — ${shortPlace(last.pickupAddress)} → ${shortPlace(last.destAddress)}, fresh search`, 300) });
    }
    choices.push({ id: MENU_IDS.book, title: 'Book a ride', description: 'Back in the chat: type where you are going, or share a pin' });
    const [last] = await recentTrips(userId, 1);
    if (last) {
      choices.push(
        { id: MENU_IDS.repeat, title: 'Repeat last ride', description: clip(`${shortPlace(last.pickup.address)} → ${shortPlace(last.destination.address)}`, 300) },
        { id: MENU_IDS.reverse, title: 'Reverse last ride', description: clip(`${shortPlace(last.destination.address)} → ${shortPlace(last.pickup.address)}`, 300) },
        { id: MENU_IDS.history, title: 'Ride history', description: 'Places you have been — book any of them again' },
      );
    }
    choices.push({ id: MENU_IDS.withdraw, title: 'Withdraw', description: 'Send money from your wallet to your bank' });
  }
  // Add money sits after the ride rows in both lists; Withdraw is not offered mid-ride (the fare is held).
  choices.splice(activeRideId ? 1 : choices.length - 1, 0, { id: MENU_IDS.deposit, title: 'Add money', description: 'Your account number to transfer to' });
  if (support) choices.push({ id: MENU_IDS.support, title: 'Contact support', description: 'Talk to a person at Wheelers' });

  return {
    screen: 'MENU',
    data: {
      greeting_line: firstName ? `Hi ${firstName}. What would you like to do?` : 'What would you like to do?',
      choices,
      error,
      has_error: error.length > 0,
    },
  };
}

async function menuChoice(choice: string, userId: string, deps: QuickActionsFlowDeps): Promise<FlowScreen> {
  const activeRideId = await getActiveRide(deps.redisClient, userId);

  if (choice === MENU_IDS.current) {
    if (!activeRideId) return menuScreen(userId, deps, 'No ride going right now.');
    return statusOrOffers(activeRideId, userId, deps, false);
  }
  if (choice === MENU_IDS.deposit) return addMoneyScreen(userId, deps);
  if (choice === MENU_IDS.withdraw) {
    if (activeRideId) return menuScreen(userId, deps, 'Withdrawals wait until your ride is over — the fare is held in your wallet.');
    void deps.onWithdraw?.(userId).catch((error) => console.error('[quick-actions] withdraw button not sent', { userId, error: error instanceof Error ? error.message : String(error) }));
    return doneScreen('Withdraw to your bank', 'The Withdraw button is in your chat. Tap it, pick the amount and the account, and confirm with your wallet PIN.');
  }
  if (choice === MENU_IDS.support) {
    const contact = deps.supportContact?.() ?? null;
    if (!contact) return doneScreen('Wheelers support', 'Reply in the chat and a person will see it.');
    return { screen: 'SUPPORT', data: { headline: 'Wheelers support', contact_line: contact, note_line: 'A person will reply as soon as they can.' } };
  }

  // Everything below starts a booking: not while one is live.
  if (activeRideId) return menuScreen(userId, deps, BUSY_NOTE);
  if (choice === MENU_IDS.searchAgain) {
    const [ended, last] = await Promise.all([getSearchTimedOut(deps.redisClient, userId), getLastRoute(deps.redisClient, userId)]);
    if (!ended || !last) return menuScreen(userId, deps, 'That search is not there any more. Book a ride to start again.');
    return republishLastSearch(offersDeps(deps), userId, ended.offerNgn || last.offerNgn, (error) => menuScreen(userId, deps, error));
  }
  if (choice === MENU_IDS.resume) {
    const trip = await getPendingRoute(deps.redisClient, userId);
    if (!trip) return menuScreen(userId, deps, 'That booking has expired. Book a ride to start again.');
    return trip.confirmed ? priceScreen(trip) : reviewScreen(trip);
  }
  if (choice === MENU_IDS.book) {
    // A clean slate. A half-finished trip left in memory (a Repeat they walked away from, an old
    // pin, a picker waiting for a number) would make "from Ilemere" an EDIT of that trip's pickup,
    // keeping its destination — the rider asked to book, not to change something.
    await Promise.all([
      clearPendingRoute(deps.redisClient, userId), clearBookingStage(deps.redisClient, userId), clearPendingLocation(deps.redisClient, userId),
      clearPendingAreaHint(deps.redisClient, userId), clearPendingGeoChoices(deps.redisClient, userId), clearPendingFarPlace(deps.redisClient, userId),
      clearBookingMisses(deps.redisClient, userId),
    ].map((step) => step.catch(() => undefined)));
    void deps.onBookInChat?.(userId).catch((error) => console.error('[quick-actions] booking prompt not sent', { userId, error: error instanceof Error ? error.message : String(error) }));
    return doneScreen('Where are you going?', 'Back in the chat, send your pickup and your destination, e.g. from Ikeja City Mall to Unilag gate, Yaba. Or share your pickup location pin first.');
  }
  if (choice === MENU_IDS.repeat || choice === MENU_IDS.reverse) {
    const [last] = await recentTrips(userId, 1);
    if (!last) return menuScreen(userId, deps, 'No completed ride to repeat yet. Book a ride instead.');
    return planPastTrip(last, choice === MENU_IDS.reverse, userId, deps, (error) => menuScreen(userId, deps, error));
  }
  if (choice === MENU_IDS.history) {
    const trips = await recentTrips(userId, 10);
    if (trips.length === 0) return menuScreen(userId, deps, 'No rides yet — your first one goes here. Book a ride to start.');
    return historyScreen(trips);
  }
  return menuScreen(userId, deps);
}

// ── HISTORY → TRIP → REVIEW_TRIP ──────────────────────────────────────────

function historyScreen(trips: PastTrip[], error = ''): FlowScreen {
  const day = (when: Date) => when.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' });
  return {
    screen: 'HISTORY',
    data: {
      intro_line: 'Pick a ride to book it again — the same way, or back the other way.',
      choices: trips.slice(0, 10).map((trip) => ({
        id: `trip:${trip.rideId}`,
        title: clip(`${day(trip.when)} · ${naira(trip.fareNgn)}`, 30),
        description: clip(`${shortPlace(trip.pickup.address)} → ${shortPlace(trip.destination.address)}${trip.stops.length ? ` · ${trip.stops.length} stop${trip.stops.length === 1 ? '' : 's'}` : ''}`, 300),
      })),
      error,
      has_error: error.length > 0,
    },
  };
}

function tripScreen(trip: PastTrip, error = ''): FlowScreen {
  const [stop1, stop2, stop3] = trip.stops;
  return {
    screen: 'TRIP',
    data: {
      headline: 'This ride',
      pickup_line: `Pickup: ${trip.pickup.address}`,
      stop_1_line: stop1 ? `Stop 1: ${stop1.address}` : '',
      has_stop_1: Boolean(stop1),
      stop_2_line: stop2 ? `Stop 2: ${stop2.address}` : '',
      has_stop_2: Boolean(stop2),
      stop_3_line: stop3 ? `Stop 3: ${stop3.address}` : '',
      has_stop_3: Boolean(stop3),
      destination_line: `Destination: ${trip.destination.address}`,
      fare_line: trip.fareNgn > 0 ? `You paid ${naira(trip.fareNgn)} — today's fare is worked out when you pick` : "Today's fare is worked out when you pick",
      ride_id: trip.rideId,
      directions: [
        { id: MENU_IDS.repeat, title: 'Repeat this ride', description: `${shortPlace(trip.pickup.address)} → ${shortPlace(trip.destination.address)}` },
        { id: MENU_IDS.reverse, title: 'Reverse this ride', description: `${shortPlace(trip.destination.address)} → ${shortPlace(trip.pickup.address)}` },
      ],
      error,
      has_error: error.length > 0,
    },
  };
}

async function historyPick(picked: string, userId: string, deps: QuickActionsFlowDeps): Promise<FlowScreen> {
  const trips = await recentTrips(userId, 10);
  const rideId = TRIP_ROW.exec(picked)?.[1];
  const trip = rideId ? trips.find((candidate) => candidate.rideId === rideId) : undefined;
  if (!trip) return trips.length ? historyScreen(trips, 'Pick a ride to continue.') : menuScreen(userId, deps, 'That ride is not in your recent history any more.');
  return tripScreen(trip);
}

async function tripDirection(rideId: string, direction: string, userId: string, deps: QuickActionsFlowDeps): Promise<FlowScreen> {
  if (await getActiveRide(deps.redisClient, userId)) return doneScreen('Already searching', SEARCHING_NOTE);
  const trip = (await recentTrips(userId, 10)).find((candidate) => candidate.rideId === rideId);
  if (!trip) return menuScreen(userId, deps, 'That ride is not in your recent history any more.');
  if (direction !== MENU_IDS.repeat && direction !== MENU_IDS.reverse) return tripScreen(trip, 'Pick Repeat or Reverse to continue.');
  return planPastTrip(trip, direction === MENU_IDS.reverse, userId, deps, (error) => tripScreen(trip, error));
}

/** The past ride's places, re-planned so distance and fare are today's — then the ordinary review screen. */
async function planPastTrip(trip: PastTrip, backwards: boolean, userId: string, deps: QuickActionsFlowDeps, refuse: (error: string) => FlowScreen | Promise<FlowScreen>): Promise<FlowScreen> {
  const { pickup, destination, stops } = backwards ? reversed(trip) : trip;
  const planned = await deps.routePlanner.planRoute({ origin: pickup, destination, ...(stops.length ? { stops } : {}) }).catch(() => null);
  if (!planned) return refuse('I could not plan that trip today — a road may have changed. Book a ride and type it instead.');
  const next: PendingRouteData = {
    pickupLat: pickup.lat, pickupLng: pickup.lng, pickupAddress: pickup.address,
    destLat: destination.lat, destLng: destination.lng, destAddress: destination.address,
    stops,
    distanceKm: planned.distanceKm,
    durationSeconds: planned.durationSeconds,
    suggestedFareNgn: planned.suggestedFareNgn,
    minOfferNgn: planned.minOfferNgn,
    ratePerKmNgn: planned.ratePerKmNgn,
    route: planned.geometry,
    // Looked at again before any price: never `confirmed`, never a carried-over offer.
  };
  await storePendingRoute(deps.redisClient, userId, next);
  await setBookingStage(deps.redisClient, userId, 'awaiting_trip_confirm');
  return reviewScreen(next);
}

// ── STATUS / OFFERS ───────────────────────────────────────────────────────

/**
 * The current trip. A driver on the way: their details, and the chat holds the
 * card. Still searching: the offers list when there are offers, otherwise a
 * screen whose one button checks again — waiting a few seconds each time, so
 * a rider tapping it is effectively watching the search live.
 */
async function statusOrOffers(rideId: string, userId: string, deps: QuickActionsFlowDeps, wait: boolean): Promise<FlowScreen> {
  const [driver, meta, seat] = await Promise.all([driverOnRide(deps.redisClient, rideId), getRideMeta(deps.redisClient, rideId), getGroupSeat(deps.redisClient, rideId).catch(() => null)]);

  if (driver) {
    const accepted = await getAcceptedBid(deps.redisClient, rideId).catch(() => null);
    const driving = driver === 'driving';
    const eta = accepted ? Math.max(1, Math.ceil(accepted.etaSeconds / 60)) : 0;
    return {
      screen: 'STATUS',
      data: {
        headline: `${accepted?.driverName ?? 'Your driver'} is ${driving ? 'driving you now' : 'on the way'}`,
        line_1: accepted ? `${accepted.vehicleModel} · plate ${accepted.vehiclePlate}` : 'Their details are in your chat.',
        line_2: accepted ? `Fare: ${naira(accepted.fareNgn)} — held in your wallet, paid when the trip ends` : '',
        line_3: accepted && !driving ? `Arrives in about ${eta} min` : '',
        has_line_3: Boolean(accepted && !driving),
        note: 'Your ride card is in the chat — tap Track live trip on it, or reply cancel there.',
        cta_label: 'Back to chat',
      },
    };
  }

  if (!meta) return doneScreen('This search has ended', ENDED_NOTE);
  if (seat) {
    // A seat in a shared car is booked by number in the chat: the car only moves when every
    // rider picks the same driver. The offers form's Accept is for a rider alone in the car.
    return {
      screen: 'STATUS',
      data: {
        headline: 'Your group ride',
        line_1: clip(`${shortPlace(meta.pickupAddress)} → ${shortPlace(meta.destinationAddress)}`, 200),
        line_2: `Your seat: ${naira(meta.offerNgn)}`,
        line_3: '',
        has_line_3: false,
        note: 'Driver offers for a shared car come to the chat. Reply the number of the driver you want there — everyone in the car has to pick the same one.',
        cta_label: 'Back to chat',
      },
    };
  }
  let bids = await getBids(deps.redisClient, rideId);
  if (wait && bids.length === 0) {
    const deadline = Date.now() + CHECK_OFFERS_MS;
    while (bids.length === 0 && Date.now() < deadline) {
      await sleep(Math.min(700, deadline - Date.now()));
      bids = await getBids(deps.redisClient, rideId);
    }
  }
  if (bids.length > 0) {
    // They are looking at the offers: the next one that arrives may buzz them again.
    await markOffersMessageOpened(deps.redisClient, rideId).catch(() => undefined);
    return offersScreen(offersDeps(deps), rideId);
  }
  return {
    screen: 'STATUS',
    data: {
      headline: 'Looking for drivers',
      line_1: clip(`${shortPlace(meta.pickupAddress)} → ${shortPlace(meta.destinationAddress)}`, 200),
      line_2: `Your price: ${naira(meta.offerNgn)}`,
      line_3: '',
      has_line_3: false,
      note: wait
        ? 'No offers yet. Drivers usually answer within a minute — tap below to check again, or wait for the offers message in your chat.'
        : 'No offers yet. Drivers near you are seeing your request now. Tap below to check for offers.',
      cta_label: 'Check for offers',
    },
  };
}

async function statusNext(userId: string, deps: QuickActionsFlowDeps): Promise<FlowScreen> {
  const activeRideId = await getActiveRide(deps.redisClient, userId);
  if (!activeRideId) return doneScreen('This search has ended', ENDED_NOTE);
  const driver = await driverOnRide(deps.redisClient, activeRideId);
  if (driver) {
    const accepted = await getAcceptedBid(deps.redisClient, activeRideId).catch(() => null);
    return doneScreen(`${accepted?.driverName ?? 'Your driver'} is ${driver === 'driving' ? 'driving you now' : 'on the way'}`, 'Their photo, car and plate are in your chat, with a button to track the trip live.');
  }
  if (await getGroupSeat(deps.redisClient, activeRideId).catch(() => null)) return doneScreen('Your group ride', 'Driver offers for a shared car come to the chat. Reply the number of the driver you want there.');
  return statusOrOffers(activeRideId, userId, deps, true);
}

// ── ADD_MONEY ─────────────────────────────────────────────────────────────

async function addMoneyScreen(userId: string, deps: QuickActionsFlowDeps): Promise<FlowScreen> {
  const [wallet, existing] = await Promise.all([
    walletClient.findByUserId(userId).catch(() => null),
    virtualAccountClient.findByUserId(userId).catch(() => null),
  ]);
  let account: VirtualAccountLines | null = existing ? { bankName: existing.bankName, accountNumber: existing.accountNumber, accountName: existing.accountName } : null;
  if (!account && deps.ensureDepositAccount) {
    // Opening one is a bank call. WhatsApp cuts a screen off at ~10 s: give it 6, then say it is on its way.
    account = await Promise.race([
      deps.ensureDepositAccount(userId).catch(() => null),
      sleep(6_000).then(() => null),
    ]);
  }
  const balanceNgn = wallet ? Number(wallet.balanceNgn) : 0;
  return {
    screen: 'ADD_MONEY',
    data: {
      headline: 'Add money to your wallet',
      balance_line: `Wallet: ${naira(balanceNgn)}`,
      bank_line: account ? `Bank: ${account.bankName}` : 'Bank: on its way',
      // A box, not a line, so the number can be long-pressed and copied.
      account_number: account ? account.accountNumber : '',
      account_label: account ? 'Account number' : 'Account number: being set up',
      name_line: account ? `Name: ${account.accountName}` : '',
      note_line: account
        ? 'Transfer from any bank app to this account. It lands in your wallet by itself, usually within a minute, and the chat tells you when it does. Deposit charges come off first, so send a little more than you need.'
        : 'Your account number is being created. Open Quick Actions again in a minute and it will be here.',
    },
  };
}
