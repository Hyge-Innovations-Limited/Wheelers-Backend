import type { GoogleMapsRoutePlanner } from '@wheleers/config';
import { referralClient, rideClient, userClient, virtualAccountClient, walletClient } from '@wheleers/db';
import { recentTrips, reversed, shortPlace, type PastTrip } from '../http/quick-actions';
import { logActivity } from '../analytics/log-activity';
import type { RedisClient } from '../redis/client';
import type { GatewayPublisher } from '../websocket/publisher';
import {
  clearBookingMisses, clearBookingStage, clearPendingAreaHint, clearPendingFarPlace, clearPendingGeoChoices, clearPendingLocation, clearPendingRoute,
  getAcceptedBid, getActiveRide, getBids, getBookingStage, getGroupSeat, getLastRoute, getPendingFarPlace, getPendingLocation, getPendingRoute,
  getRideMeta, getRideState, getSearchTimedOut, markOffersMessageOpened, setBookingStage, setPendingAreaHint, setPendingLocation, storePendingRoute,
} from './bid-state';
import type { PendingRouteData } from './bid-state';
import { BOOK_RIDE_ACTIONS, clearBookDraft, handleBookRideAction, isBookRideAction, startBooking } from './book-ride-flow';
import {
  confirm, doneScreen, priceScreen, reviewScreen, setPrice,
  EDIT_TRIP_ACTIONS, SEARCHING_NOTE, type EditTripFlowDeps,
} from './edit-trip-flow';
import type { FlowRequestBody } from './encryption';
import { actionFor } from './flow-dispatch';
import { handleOffersFormFlow, offersScreen, republishLastSearch, OFFERS_FORM_ACTIONS, type OffersFormDeps } from './offers-form-flow';

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
 *   NEXT          the list again after a search is cancelled here, so the rider
 *                 goes on inside the form instead of back in the chat
 *   REFERRAL      a referral code, typed in a box                    [Add code]
 *   BOOK_WHERE    Book a ride: pickup and destination boxes, with what was
 *                 typed last still in them and a shared pin as the pickup [Find places]
 *   BOOK_PLACES   what was found for each, ALWAYS shown — they see what Google
 *                 understood before anything is planned            [Continue]
 *   BOOK_TRIP     the planned trip, its fare, up to three stop boxes [Confirm trip]
 *   BOOK_STOP_PLACES  only when a typed stop has several matches
 *   BOOK_REVIEW   the trip with its stops, one more look            [Confirm trip]
 *   REVIEW_TRIP   the planned trip and its fare      [Confirm trip] → SET_PRICE
 *   SET_PRICE     the price                          [Find drivers] → DONE
 *   STATUS        the current trip once a driver is on it (or a group seat)
 *   OFFERS        the current trip while it is still a search — the offers
 *                 form's own list, offers or none: accept, change price, decline
 *   CHANGE_PRICE  all, cancel — the same handler, so the money rules are not
 *   CANCEL_SEARCH restated here
 *   ADD_MONEY     the account number to transfer to, right on the screen
 *   SUPPORT       the contact
 *   NOTE          something to read, closed with the X — the button in the chat lives on
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
  onSearchCancelled?: OffersFormDeps['onSearchCancelled'];
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
  changePickup: 'change_pickup', changeDestination: 'change_destination', startAgain: 'start_again', cancelBooking: 'cancel_booking',
  bookFromPin: 'book_from_pin', referral: 'referral',
} as const;

/** What NEXT (the list after a cancelled search) may offer: only rows whose screens it can reach. */
const NEXT_CHOICES: ReadonlySet<string> = new Set([MENU_IDS.book, MENU_IDS.repeat, MENU_IDS.reverse, MENU_IDS.history, MENU_IDS.deposit, MENU_IDS.withdraw, MENU_IDS.support]);
const CANCELLED_LINE = 'Search cancelled. Nothing was charged. What would you like to do next?';

/**
 * The chat steps of booking a ride. While a rider is in one, the menu is that
 * booking's ways out: what the chat used to ask them to type ("reply change
 * pickup, start again or cancel") is here to tap instead.
 */
const RIDE_BOOKING_STEPS: ReadonlySet<string> = new Set([
  'awaiting_pickup', 'awaiting_destination', 'awaiting_trip_confirm', 'adding_stop', 'awaiting_price',
  'awaiting_route_confirmation', 'editing_pickup', 'editing_destination',
]);

/** Forget the booking in progress, all of it. */
async function clearBooking(redisClient: RedisClient, userId: string): Promise<void> {
  await Promise.all([
    clearPendingRoute(redisClient, userId), clearBookingStage(redisClient, userId), clearPendingLocation(redisClient, userId),
    clearPendingAreaHint(redisClient, userId), clearPendingGeoChoices(redisClient, userId), clearPendingFarPlace(redisClient, userId),
    clearBookingMisses(redisClient, userId),
  ].map((step) => step.catch(() => undefined)));
}
const TRIP_ROW = /^trip:([0-9a-f-]{36})$/;

const BUSY_NOTE = 'You already have a ride in progress. To book a new one, cancel it first.';
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
  const screen = await answerQuickActions(body, userId, deps);
  // No ending completes the form. Completing disables the button on the message it came
  // from and posts "Response sent" in the chat; the rider wants neither, ever. So every
  // ending is a NOTE the rider swipes down from, and the Quick Actions button stays live.
  // DONE exists in the form's JSON only because Meta requires one terminal screen.
  if (screen.screen === 'DONE') return { screen: 'NOTE', data: { headline: screen.data['headline'], note: screen.data['note'] } };
  return screen;
}

async function answerQuickActions(body: FlowRequestBody, userId: string, deps: QuickActionsFlowDeps): Promise<FlowScreen> {
  const data = body.data ?? {};
  const action = actionFor(body, QUICK_ACTIONS_ACTIONS);
  if (!action) return menuScreen(userId, deps);

  // The offers form's screens, verbatim: its handler reads the active ride itself.
  if (action === 'offers_choice' || action === 'update_price' || action === 'cancel_search') {
    const answered = await handleOffersFormFlow({ ...body, data: { ...data, action } }, userId, offersDeps(deps));
    // A search cancelled here does not close the form: the list comes back, ready for the next thing.
    if (action === 'cancel_search' && answered.screen === 'NOTE' && answered.data['headline'] === 'Search cancelled') return nextScreen(userId, deps);
    return answered;
  }
  // The Edit-trip form's review and price screens, verbatim: a repeated trip is confirmed and priced by the same code.
  if (action === 'confirm_trip' || action === 'set_price') {
    const [trip, activeRideId] = await Promise.all([getPendingRoute(deps.redisClient, userId), getActiveRide(deps.redisClient, userId)]);
    if (activeRideId) return doneScreen('Already searching', SEARCHING_NOTE);
    if (!trip) return menuScreen(userId, deps, 'That trip has expired. Pick again.');
    if (action === 'confirm_trip') return confirm(userId, trip, editDeps(deps));
    const priced = await setPrice(data, userId, trip, editDeps(deps));
    // The search is on: the booking boxes start empty next time.
    if (priced.screen === 'DONE') await clearBookDraft(deps, userId);
    return priced;
  }

  // Book a ride: its own module (book-ride-flow.ts); BOOK_REVIEW's Confirm is the trip form's confirm_trip below.
  if (isBookRideAction(action)) return handleBookRideAction(action, data, userId, deps);
  if (action === 'menu_choice') return menuChoice(text(data['choice']), userId, deps);
  if (action === 'next_choice') return nextChoice(text(data['choice']), userId, deps);
  if (action === 'apply_referral') return applyReferral(text(data['code']), userId);
  if (action === 'history_pick') return historyPick(text(data['trip']), userId, deps);
  if (action === 'trip_direction') return tripDirection(text(data['ride_id']), text(data['direction']), userId, deps);
  if (action === 'status_next') return statusNext(userId, deps);
  return menuScreen(userId, deps);
}

/** The one Continue button on each screen. The trip and offers screens are the other forms' own. */
export const QUICK_ACTIONS_ACTIONS = {
  MENU: 'menu_choice',
  NEXT: 'next_choice',
  REFERRAL: 'apply_referral',
  ...BOOK_RIDE_ACTIONS, BOOK_REVIEW: 'confirm_trip',
  HISTORY: 'history_pick', TRIP: 'trip_direction',
  ...EDIT_TRIP_ACTIONS,
  STATUS: 'status_next',
  ...OFFERS_FORM_ACTIONS,
} as const;

const editDeps = (deps: QuickActionsFlowDeps): EditTripFlowDeps => ({
  redisClient: deps.redisClient, googleMapsApiKey: deps.googleMapsApiKey, routePlanner: deps.routePlanner, publisher: deps.publisher, onBidPlaced: deps.onBidPlaced,
});
const offersDeps = (deps: QuickActionsFlowDeps): OffersFormDeps => ({
  redisClient: deps.redisClient, publisher: deps.publisher, onRideConfirmed: deps.onRideConfirmed, onWalletShort: deps.onWalletShort, onSearchCancelled: deps.onSearchCancelled,
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
        ? 'Still looking for drivers — check for offers or change your price'
        : bids.length === 1 ? '1 driver offer waiting for you' : `${bids.length} driver offers waiting for you`)).catch(() => 'See where your ride is');
    choices.push({ id: MENU_IDS.current, title: 'Your current trip', description });
  } else {
    // In the middle of booking: the booking's own choices, and money for it.
    const stage = await getBookingStage(deps.redisClient, userId).catch(() => null);
    if (stage && RIDE_BOOKING_STEPS.has(stage)) {
      const pickup = trip?.pickupAddress ?? (await getPendingLocation(deps.redisClient, userId).catch(() => null))?.address;
      // A trip already planned (a Repeat, a form they closed) is picked up where it was left.
      if (trip) choices.push({ id: MENU_IDS.resume, title: 'Continue your booking', description: clip(`${shortPlace(trip.pickupAddress)} → ${shortPlace(trip.destAddress)}${trip.confirmed ? ' — name your price' : ''}`, 300) });
      // A pickup already given (a shared location pin, usually) and nowhere to go yet: the booking
      // boxes open with it filled in, and only the destination is left to type.
      else if (pickup) choices.push({ id: MENU_IDS.bookFromPin, title: 'Continue your booking', description: clip(`From ${shortPlace(pickup)} — add where you are going`, 300) });
      if (pickup) {
        choices.push(
          { id: MENU_IDS.changePickup, title: 'Change pickup', description: clip(`Now: ${shortPlace(pickup)}`, 300) },
          { id: MENU_IDS.changeDestination, title: 'Change destination', description: clip(trip ? `Now: ${shortPlace(trip.destAddress)}` : 'Send a different destination', 300) },
        );
      }
      choices.push(
        { id: MENU_IDS.startAgain, title: 'Start again', description: 'Clear this booking and book from the beginning' },
        { id: MENU_IDS.cancelBooking, title: 'Cancel booking', description: 'Stop here. Nothing is charged' },
        { id: MENU_IDS.deposit, title: 'Add money', description: 'Your account number for transfers' },
      );
      return {
        screen: 'MENU',
        data: {
          greeting_line: firstName ? `${firstName}, you are booking a ride. What would you like to do?` : 'You are booking a ride. What would you like to do?',
          choices,
          error,
          has_error: error.length > 0,
        },
      };
    }
    if (trip) choices.push({ id: MENU_IDS.resume, title: 'Continue your booking', description: clip(`${shortPlace(trip.pickupAddress)} → ${shortPlace(trip.destAddress)}${trip.confirmed ? ' — name your price' : ''}`, 300) });
    else {
      // The last search ran out with no driver: the way back in is one row, not a message.
      const [ended, last] = await Promise.all([getSearchTimedOut(deps.redisClient, userId), getLastRoute(deps.redisClient, userId)]);
      if (ended && last) choices.push({ id: MENU_IDS.searchAgain, title: 'Search again', description: clip(`No driver took ${naira(ended.offerNgn || last.offerNgn)} — ${shortPlace(last.pickupAddress)} → ${shortPlace(last.destAddress)}, fresh search`, 300) });
    }
    choices.push({ id: MENU_IDS.book, title: 'Book a ride', description: 'Pickup, destination and your price' });
    const [last] = await recentTrips(userId, 1);
    if (last) {
      choices.push(
        { id: MENU_IDS.repeat, title: 'Repeat last ride', description: clip(`${shortPlace(last.pickup.address)} → ${shortPlace(last.destination.address)}`, 300) },
        { id: MENU_IDS.reverse, title: 'Reverse last ride', description: clip(`${shortPlace(last.destination.address)} → ${shortPlace(last.pickup.address)}`, 300) },
        { id: MENU_IDS.history, title: 'Ride history', description: 'Book a past trip again' },
      );
    }
    // Shown until a code is on the account: one per person.
    if (!(await referralClient.hasAppliedCode(userId).catch(() => true))) {
      choices.push({ id: MENU_IDS.referral, title: 'Enter referral code', description: 'Got a code from a driver or a friend? Add it here' });
    }
    choices.push({ id: MENU_IDS.withdraw, title: 'Withdraw', description: 'Send money to your bank' });
  }
  // Add money sits after the ride rows in both lists; Withdraw is not offered mid-ride (the fare is held).
  choices.splice(activeRideId ? 1 : choices.length - 1, 0, { id: MENU_IDS.deposit, title: 'Add money', description: 'Your account number for transfers' });
  // Mid-ride the menu is two things: the trip, and money for it.
  if (support && !activeRideId) choices.push({ id: MENU_IDS.support, title: 'Contact support', description: 'Talk to a person' });

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
    // Back to chat, where the Withdraw button now is. Quick Actions comes back with the next reply.
    return doneScreen('Withdraw to your bank', 'The Withdraw button is in your chat. Tap it, pick the amount and the account, and confirm with your wallet PIN.', false);
  }
  if (choice === MENU_IDS.support) {
    const contact = deps.supportContact?.() ?? null;
    if (!contact) return doneScreen('Wheelers support', 'Reply in the chat and a person will see it.', false);
    return { screen: 'SUPPORT', data: { headline: 'Wheelers support', contact_line: contact, note_line: 'A person will reply as soon as they can.' } };
  }

  if (choice === MENU_IDS.referral) return referralScreen();

  // Everything below starts or changes a booking: not while one is live.
  if (activeRideId) return menuScreen(userId, deps, BUSY_NOTE);
  if (choice === MENU_IDS.bookFromPin) {
    const location = await getPendingLocation(deps.redisClient, userId).catch(() => null);
    if (!location) return startBooking(deps, userId);
    return startBooking(deps, userId, { pin: { lat: location.lat, lng: location.lng, address: location.address }, destination: location.suggestedDestination });
  }
  if (choice === MENU_IDS.cancelBooking) {
    await clearBooking(deps.redisClient, userId);
    return doneScreen('Booking cancelled', 'Nothing was charged. Tap Quick Actions whenever you want a ride.', false);
  }
  if (choice === MENU_IDS.startAgain) {
    await clearBooking(deps.redisClient, userId);
    return startBooking(deps, userId, { fresh: true });
  }
  if (choice === MENU_IDS.changePickup) {
    // Whatever destination they gave travels on: once the new pickup is found,
    // the chat goes straight to the trip check with it.
    const [trip, location, heldFar] = await Promise.all([
      getPendingRoute(deps.redisClient, userId), getPendingLocation(deps.redisClient, userId), getPendingFarPlace(deps.redisClient, userId).catch(() => null),
    ]);
    const keepDestination = trip?.destAddress ?? (heldFar?.field === 'destination' ? heldFar.address : undefined) ?? location?.suggestedDestination;
    await clearBooking(deps.redisClient, userId);
    await setBookingStage(deps.redisClient, userId, 'awaiting_pickup');
    if (keepDestination) await setPendingAreaHint(deps.redisClient, userId, { kind: 'pickup', area: '', counterpartAddress: keepDestination });
    return doneScreen('Change pickup',
      `Send your new pickup in the chat: the address with the area (e.g. "92 Murtala Muhammed Way, Yaba"), or share a location pin.${keepDestination ? ` Your destination stays: ${shortPlace(keepDestination)}.` : ''}`, false);
  }
  if (choice === MENU_IDS.changeDestination) {
    const [trip, location] = await Promise.all([getPendingRoute(deps.redisClient, userId), getPendingLocation(deps.redisClient, userId)]);
    const pickup = trip
      ? { lat: trip.pickupLat, lng: trip.pickupLng, address: trip.pickupAddress }
      : location ? { lat: location.lat, lng: location.lng, address: location.address } : null;
    if (!pickup) return menuScreen(userId, deps, 'Send your pickup in the chat first.');
    await clearBooking(deps.redisClient, userId);
    await setPendingLocation(deps.redisClient, userId, { ...pickup, savedAt: new Date().toISOString() });
    await setBookingStage(deps.redisClient, userId, 'awaiting_destination');
    return doneScreen('Change destination',
      `Send your new destination in the chat: the address with the area (e.g. "Yaba College of Technology, Yaba"), or share a location pin. Your pickup stays: ${shortPlace(pickup.address)}.`, false);
  }
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
    await clearBooking(deps.redisClient, userId);
    return startBooking(deps, userId);
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

// ── NEXT: the list after a cancelled search ─────────────────────────────────

/** The menu's rows that still make sense once the search is gone, on a screen that can reach them. */
async function nextScreen(userId: string, deps: QuickActionsFlowDeps, error = ''): Promise<FlowScreen> {
  const menu = await menuScreen(userId, deps);
  const choices = (menu.data['choices'] as Array<{ id: string; title: string; description: string }>).filter((row) => NEXT_CHOICES.has(row.id));
  return { screen: 'NEXT', data: { greeting_line: CANCELLED_LINE, choices, error, has_error: error.length > 0 } };
}

async function nextChoice(choice: string, userId: string, deps: QuickActionsFlowDeps): Promise<FlowScreen> {
  if (!NEXT_CHOICES.has(choice)) return nextScreen(userId, deps, 'Pick one to continue.');
  const answered = await menuChoice(choice, userId, deps);
  // The menu answers its own refusals on MENU, which this screen cannot go back to: say them here.
  if (answered.screen === 'MENU') return nextScreen(userId, deps, text(answered.data['error']) || 'That is not available right now.');
  return answered;
}

// ── REFERRAL ────────────────────────────────────────────────────────────────

function referralScreen(code = '', error = ''): FlowScreen {
  return { screen: 'REFERRAL', data: { intro_line: 'Got a code from a driver or a friend? Enter it here.', code, error, has_error: error.length > 0 } };
}

/** The code typed in the box: added to the account, or refused in words on the same screen. */
async function applyReferral(typed: string, userId: string): Promise<FlowScreen> {
  const code = referralClient.normalizeCode(typed);
  if (!code) return referralScreen('', 'Type the referral code to continue.');
  try {
    await referralClient.applyCode({ referredUserId: userId, code });
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    if (/own referral code/i.test(reason)) return referralScreen(code, 'That is your own code. Enter the code someone gave you.');
    if (/already been applied/i.test(reason)) return doneScreen('Referral code', 'A referral code is already on your account, so this one was not added.', false);
    if (/not found/i.test(reason)) return referralScreen(code, `"${code}" was not found. Check the code and try again.`);
    return referralScreen(code, 'That code could not be added just now. Please try again.');
  }
  logActivity({ userId, eventType: 'referral_code_applied', source: 'whatsapp', metadata: { code, via: 'quick_actions' } });
  return doneScreen('Referral code added', `${code} is on your account. Tap Quick Actions in the chat to book your first ride.`, false);
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
 * card. Still searching: the offers list, offers or none — an empty list still
 * carries Check for more offers, Change my price and Cancel search, so a rider
 * nobody has answered yet can raise their price right here instead of being
 * left with a button that only checks again.
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
        cta_label: 'Done',
      },
    };
  }

  if (!meta) return menuScreen(userId, deps, 'That search has ended. Nothing was charged.');
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
        cta_label: 'Done',
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
  // They are looking at the search: the next offer that arrives may buzz them again.
  await markOffersMessageOpened(deps.redisClient, rideId).catch(() => undefined);
  return offersScreen(offersDeps(deps), rideId);
}

async function statusNext(userId: string, deps: QuickActionsFlowDeps): Promise<FlowScreen> {
  const activeRideId = await getActiveRide(deps.redisClient, userId);
  if (!activeRideId) return menuScreen(userId, deps, 'That search has ended. Nothing was charged.');
  const driver = await driverOnRide(deps.redisClient, activeRideId);
  if (driver) {
    const accepted = await getAcceptedBid(deps.redisClient, activeRideId).catch(() => null);
    return doneScreen(`${accepted?.driverName ?? 'Your driver'} is ${driver === 'driving' ? 'driving you now' : 'on the way'}`, 'Their photo, car and plate are in your chat, with a button to track the trip live.', false);
  }
  if (await getGroupSeat(deps.redisClient, activeRideId).catch(() => null)) return doneScreen('Your group ride', 'Driver offers for a shared car come to the chat. Reply the number of the driver you want there.', false);
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
