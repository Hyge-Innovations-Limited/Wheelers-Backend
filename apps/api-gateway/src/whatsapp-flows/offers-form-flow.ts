import { validateRiderOffer } from '@wheleers/config';
import { userClient } from '@wheleers/db';
import type { RedisClient } from '../redis/client';
import type { GatewayPublisher } from '../websocket/publisher';
import {
  cancelWhatsappRide,
  changeRiderOffer,
  confirmRideWithOffer,
  offerKey,
  publishWhatsappRide,
  type ConfirmedRide,
} from '../rides/whatsapp-ride.service';
import { clearBids, clearPendingAccept, getActiveRide, getBids, getLastBatch, getLastRoute, getRideMeta, getRideState, getSearchTimedOut, markOffersMessageOpened, markOffersMessageSent, setRideState, storeLastBatch } from './bid-state';
import type { LastRouteData, PendingRouteData, SearchTimedOut, WhatsappBid } from './bid-state';
import type { FlowRequestBody } from './encryption';
import { offerReplyId, parseOfferReplyId, sortOffers } from './whatsapp-notifier';

/**
 * The offers form — everything a rider can do about the offers on the table, in
 * ONE place, behind the ONE button of the offers message.
 *
 * WhatsApp allows a message reply buttons OR one form button, never both. With
 * reply buttons, "Change my price" and "Cancel search" each cost more chat
 * messages (a prompt, a typed answer, a reply). Here they cost none:
 *
 *   OFFERS         one list: every driver's offer, then Check for more
 *                  offers, Change my price, Decline all, Cancel search [Continue]
 *     Check more     → waits a few seconds for drivers, the list again — so
 *                      the rider watches the search HERE, and no "N drivers
 *                      found" message is ever sent after the first button
 *     a driver       → the fare is held, the ride confirmed        → DONE
 *     Change price   → CHANGE_PRICE → "Bid updated"             → DONE   (no chat message)
 *     Decline all    → offers dropped, the search carries on       → DONE   (no chat message)
 *     Cancel search  → CANCEL_SEARCH (why?) → cancelled            → DONE   (no chat message)
 *
 * Accepting IS confirmRideWithOffer — the same function the chat's tap and the
 * page used — so the wallet-first / driver-still-there / hold-before-confirm
 * rules are not restated here. The chat hears about it only when there is
 * something the rider must keep: the driver's details, or the Add money button.
 *
 * A flow may only OPEN on its entry screen, so INIT always answers OFFERS — a
 * search that is over says so in the error line, with "Close" as the only choice.
 *
 * A search that ran out with no driver is NOT a chat message (the form's button
 * is already there). It is this screen: "No driver took ₦X", with Search again
 * (same route, same price) and Change my price (same route, a new price) —
 * either starts a fresh search and lands back on the live list.
 */

export interface OffersFormDeps {
  redisClient: RedisClient;
  publisher: GatewayPublisher;
  /** Ride confirmed in the form: send the driver's details to the chat. */
  onRideConfirmed?: (userId: string, ride: ConfirmedRide) => Promise<void>;
  /** Wallet short for the chosen driver: remember the choice and send the Add money button. */
  onWalletShort?: (userId: string, rideId: string, bid: WhatsappBid, short: { balanceNgn: number; fareNgn: number; shortNgn: number; sendNgn: number }) => Promise<void>;
}

type FlowScreen = { screen: string; data: Record<string, unknown> };

const REFRESH = 'refresh';
const SEARCH_AGAIN = 'search_again';
const CHANGE_PRICE = 'change_price';
const DECLINE_ALL = 'decline_all';
/** How long "Check for more offers" waits for a driver before showing the list again (WhatsApp cuts a form off at ~10 s). */
const REFRESH_WAIT_MS = 3_500;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CANCEL_SEARCH = 'cancel_search';
const CLOSE = 'close';

/** The same four reasons the chat asks for (CANCELLATION_REASONS in whatsapp.route.ts), so the admin sees one vocabulary. */
const CANCEL_REASONS: Record<string, string> = {
  '1': 'Long waiting time',
  '2': 'Wrong pickup or destination point',
  '3': 'Want to change ride type',
  '4': 'Accidental request',
};

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);
const naira = (amount: number) => `₦${amount.toLocaleString()}`;

function done(headline: string, note: string): FlowScreen {
  return { screen: 'DONE', data: { headline, note } };
}

/** A terminal-sounding state on the ENTRY screen (the only screen a flow may open on): one choice, "Close". */
function closedOffers(message: string): FlowScreen {
  return {
    screen: 'OFFERS',
    data: {
      route_line: '', offer_line: 'Nothing to decide here', count_line: '',
      choices: [{ id: CLOSE, title: 'Close', description: 'Go back to the chat' }],
      error: message, has_error: true,
    },
  };
}

export async function offersScreen(deps: OffersFormDeps, rideId: string, error = ''): Promise<FlowScreen> {
  const [meta, bids] = await Promise.all([getRideMeta(deps.redisClient, rideId), getBids(deps.redisClient, rideId)]);
  if (!meta) return closedOffers('This search has ended — nothing was charged. Send your trip again in the chat.');
  const offers = sortOffers(bids);
  // What "1" means if they type a number in the chat instead must be what this screen shows.
  await storeLastBatch(deps.redisClient, rideId, offers).catch(() => undefined);

  return {
    screen: 'OFFERS',
    data: {
      route_line: clip(`${meta.pickupAddress.split(',')[0]} → ${meta.destinationAddress.split(',')[0]}`, 80),
      offer_line: `Your price: ${naira(meta.offerNgn)}`,
      count_line: offers.length === 0 ? 'No offers yet — drivers are still looking at your request.'
        : offers.length === 1 ? '1 driver has made an offer' : `${offers.length} drivers have made offers — cheapest first`,
      choices: [
        ...offers.slice(0, 9).map((bid) => ({
          // The price rides in the id: a screen left open while the driver re-prices must not hold the new fare.
          id: offerReplyId(bid),
          title: clip(`${naira(bid.counterOfferNgn)} · ${bid.driverName}`, 30),
          description: clip([bid.vehicleModel, bid.vehiclePlate, `${bid.driverRating.toFixed(1)}★`, `${Math.max(1, Math.ceil(bid.etaSeconds / 60))} min away`].filter(Boolean).join(' · '), 300),
        })),
        { id: REFRESH, title: 'Check for more offers', description: offers.length === 0 ? 'Drivers usually answer within a minute' : 'See if more drivers have answered' },
        { id: CHANGE_PRICE, title: 'Change my price', description: 'Offer drivers a different amount' },
        ...(offers.length > 0 ? [{ id: DECLINE_ALL, title: 'Decline all', description: 'None of these drivers — keep searching' }] : []),
        { id: CANCEL_SEARCH, title: 'Cancel search', description: 'Stop looking. Nothing is charged.' },
      ],
      error,
      has_error: error.length > 0,
    },
  };
}

async function priceScreen(deps: OffersFormDeps, rideId: string, error = '', prefillNgn?: number): Promise<FlowScreen> {
  const meta = await getRideMeta(deps.redisClient, rideId);
  if (!meta) return done('This search has ended', 'Nothing was charged. Send your trip again in the chat.');
  return priceBox({ offerNgn: prefillNgn ?? meta.offerNgn, suggestedFareNgn: meta.suggestedFareNgn }, error);
}

function priceBox(trip: { offerNgn: number; suggestedFareNgn: number }, error = ''): FlowScreen {
  const floor = validateRiderOffer(0, trip.suggestedFareNgn).minOfferNgn;
  return {
    screen: 'CHANGE_PRICE',
    data: {
      current_price: String(trip.offerNgn),
      offer_line: `Your price now: ${naira(trip.offerNgn)}`,
      limits_line: `Lowest for this trip: ${naira(floor)} · suggested ${naira(trip.suggestedFareNgn)}`,
      error,
      has_error: error.length > 0,
    },
  };
}

// ── the search ran out with no driver ──────────────────────────────────

function endedSearchScreen(timedOut: SearchTimedOut, route: LastRouteData, error = ''): FlowScreen {
  const price = timedOut.offerNgn || route.offerNgn;
  const higher = Math.ceil((price * 1.1) / 100) * 100;
  return {
    screen: 'OFFERS',
    data: {
      route_line: clip(`${route.pickupAddress.split(',')[0]} → ${route.destAddress.split(',')[0]}`, 80),
      offer_line: `No driver took ${naira(price)} this time.`,
      count_line: 'Nothing was charged. Two ways forward: search again at the same price, or raise it — that usually gets drivers moving.',
      choices: [
        { id: SEARCH_AGAIN, title: 'Search again', description: `Same route, ${naira(price)} again, a fresh search` },
        { id: CHANGE_PRICE, title: 'Change my price', description: `Same route at a new price — e.g. ${naira(higher)}` },
        { id: CLOSE, title: 'Close', description: 'Go back to the chat' },
      ],
      error,
      has_error: error.length > 0,
    },
  };
}

/**
 * A fresh search on the last route, from inside a form (the offers form's Search
 * again / Change my price, Quick Actions' Search again). The chat gets nothing:
 * its See driver offers button already opens on whatever search is live.
 */
export async function republishLastSearch(deps: OffersFormDeps, userId: string, priceNgn: number, refuse: (error: string) => FlowScreen | Promise<FlowScreen>): Promise<FlowScreen> {
  const route = await getLastRoute(deps.redisClient, userId);
  if (!route) return done('That trip has expired', 'Send your pickup and destination again in the chat.');
  const phone = (await userClient.findById(userId).catch(() => null))?.phone ?? '';
  // The event schema wants the geometry as an object or absent — never null.
  const trip: PendingRouteData = { ...route, route: route.route, confirmed: true };
  const result = await publishWhatsappRide({ redisClient: deps.redisClient, publisher: deps.publisher }, { id: userId, phone }, trip, priceNgn);
  if (!result.ok) {
    if (result.code === 'BELOW_MINIMUM') return refuse(`${naira(priceNgn)} is under the lowest price for this trip, ${naira(result.minOfferNgn)}. Offer that, or more.`);
    if (result.code === 'PUBLISH_FAILED') return refuse('Could not start the search just now. Try again.');
    const live = await getActiveRide(deps.redisClient, userId);          // ALREADY_PUBLISHING: a double tap — the first one is out
    return live ? offersScreen(deps, live) : refuse('Could not start the search just now. Try again.');
  }
  await markOffersMessageSent(deps.redisClient, result.rideId).catch(() => undefined);   // the button in the chat is already there
  return offersScreen(deps, result.rideId);
}

function cancelScreen(error = ''): FlowScreen {
  return {
    screen: 'CANCEL_SEARCH',
    data: { reasons: Object.entries(CANCEL_REASONS).map(([id, title]) => ({ id, title: clip(title, 30) })), error, has_error: error.length > 0 },
  };
}

/** Every request the offers form makes. */
export async function handleOffersFormFlow(body: FlowRequestBody, userId: string, deps: OffersFormDeps): Promise<FlowScreen> {
  const rideId = await getActiveRide(deps.redisClient, userId);
  const state = rideId ? await getRideState(deps.redisClient, rideId).catch(() => null) : null;
  const confirmed = state === 'confirmed' || state === 'in_progress';

  const data = body.data ?? {};
  // Phones cache flow JSON and old copies drop our `action` tag — the payload's shape still says what it is.
  const action = typeof data['action'] === 'string' ? data['action']
    : typeof data['choice'] === 'string' ? 'offers_choice'
      : data['new_price'] !== undefined ? 'update_price'
        : typeof data['reason'] === 'string' ? 'cancel_search' : null;

  // No live search: if the last one ran out with no driver, that is the screen — with the ways forward on it.
  const ended = rideId ? null : await getSearchTimedOut(deps.redisClient, userId);
  const lastRoute = ended ? await getLastRoute(deps.redisClient, userId) : null;
  if (!rideId && ended && lastRoute) {
    if (body.action !== 'data_exchange' || !action) return endedSearchScreen(ended, lastRoute);
    if (action === 'update_price') {
      const amount = Math.round(Number(String(data['new_price'] ?? '').replace(/[,\s₦]/g, '')));
      if (!Number.isFinite(amount) || amount <= 0) return priceBox({ offerNgn: ended.offerNgn || lastRoute.offerNgn, suggestedFareNgn: lastRoute.suggestedFareNgn }, 'Enter your price in figures, e.g. 3000.');
      return republishLastSearch(deps, userId, amount, (error) => priceBox({ offerNgn: amount, suggestedFareNgn: lastRoute.suggestedFareNgn }, error));
    }
    const choice = String(data['choice'] ?? '');
    if (choice === CLOSE) return done('Wheelers', 'You can go back to the chat.');
    if (choice === CHANGE_PRICE) return priceBox({ offerNgn: ended.offerNgn || lastRoute.offerNgn, suggestedFareNgn: lastRoute.suggestedFareNgn });
    if (choice === SEARCH_AGAIN) return republishLastSearch(deps, userId, ended.offerNgn || lastRoute.offerNgn, (error) => endedSearchScreen(ended, lastRoute, error));
    return endedSearchScreen(ended, lastRoute, action === 'cancel_search' ? '' : 'Pick one to continue.');
  }

  if (body.action !== 'data_exchange' || !action) {
    if (!rideId) return closedOffers('This search has ended — nothing was charged. Send your trip again in the chat.');
    if (confirmed) return closedOffers('Your driver is already confirmed — their details are in the chat.');
    // They are looking: the next offer that arrives may buzz them again.
    await markOffersMessageOpened(deps.redisClient, rideId).catch(() => undefined);
    return offersScreen(deps, rideId);
  }

  if (!rideId) return done('This search has ended', 'Nothing was charged. Send your trip again in the chat.');
  if (confirmed) return done('Your driver is confirmed', 'Their details are in the chat.');
  const service = { redisClient: deps.redisClient, publisher: deps.publisher };

  if (action === 'update_price') {
    const amount = Math.round(Number(String(data['new_price'] ?? '').replace(/[,\s₦]/g, '')));
    if (!Number.isFinite(amount) || amount <= 0) return priceScreen(deps, rideId, 'Enter your price in figures, e.g. 3000.');
    const result = await changeRiderOffer(service, userId, rideId, amount);
    if (!result.ok) {
      if (result.code === 'BELOW_MINIMUM') return priceScreen(deps, rideId, `${naira(amount)} is under the lowest price for this trip, ${naira(result.minOfferNgn)}. It is in the box now — tap Update price to offer it, or type more.`, result.minOfferNgn);
      return done('This search has ended', 'Nothing was charged. Send your trip again in the chat.');
    }
    // No chat message: "Bid updated" is said HERE, and the next thing the chat hears is a driver answering it.
    return done(`Bid updated to ${naira(result.offerNgn)}`, 'Every driver looking at your request can see it. Their offers will come to your chat.');
  }

  if (action === 'cancel_search') {
    const reason = CANCEL_REASONS[String(data['reason'] ?? '')];
    if (!reason) return cancelScreen('Pick a reason to continue.');
    await cancelWhatsappRide(service, userId, rideId, reason);
    return done('Search cancelled', 'Nothing was charged. Message Wheelers whenever you need a ride.');
  }

  const choice = String(data['choice'] ?? '');
  if (choice === CLOSE) return done('Wheelers', 'You can go back to the chat.');
  if (choice === REFRESH) {
    // Anything new since the list they are looking at shows at once; otherwise wait a few
    // seconds for a driver to answer or re-price, then the list again either way.
    const fingerprint = (bids: WhatsappBid[]) => bids.map((bid) => `${offerKey(bid)}@${bid.counterOfferNgn}`).sort().join('|');
    const seen = fingerprint(await getLastBatch(deps.redisClient, rideId).catch(() => []));
    const deadline = Date.now() + REFRESH_WAIT_MS;
    while (fingerprint(await getBids(deps.redisClient, rideId)) === seen && Date.now() < deadline) {
      await sleep(Math.min(700, Math.max(1, deadline - Date.now())));
    }
    await markOffersMessageOpened(deps.redisClient, rideId).catch(() => undefined);
    return offersScreen(deps, rideId);
  }
  if (choice === CHANGE_PRICE) return priceScreen(deps, rideId);
  if (choice === CANCEL_SEARCH) return cancelScreen();
  if (choice === DECLINE_ALL) {
    await clearBids(deps.redisClient, rideId);
    await storeLastBatch(deps.redisClient, rideId, []).catch(() => undefined);
    await clearPendingAccept(deps.redisClient, userId).catch(() => undefined);
    await setRideState(deps.redisClient, rideId, 'searching').catch(() => undefined);
    return done('Offers declined', 'Still searching — new offers will come to your chat. Raising your price usually gets drivers moving.');
  }

  const tapped = parseOfferReplyId(choice);
  if (!tapped) return offersScreen(deps, rideId, 'Pick a driver, or one of the options below.');
  const bid = (await getBids(deps.redisClient, rideId)).find((candidate) => offerKey(candidate) === tapped.key);
  if (!bid) return offersScreen(deps, rideId, 'That offer is no longer on the table — nothing was charged.');
  if (bid.counterOfferNgn !== tapped.shownPriceNgn) {
    return offersScreen(deps, rideId, `${bid.driverName} changed their price to ${naira(bid.counterOfferNgn)} (it was ${naira(tapped.shownPriceNgn)}) — nothing was charged.`);
  }

  const result = await confirmRideWithOffer(service, userId, rideId, tapped.key);
  if (result.ok) {
    // Not awaited: the driver's photos take seconds to send, and WhatsApp cuts a form's request off at ~10.
    void deps.onRideConfirmed?.(userId, result.ride).catch((error) => console.error('[offers-form] ride confirmed but the chat was not told', { userId, error: error instanceof Error ? error.message : String(error) }));
    return done('Ride confirmed', `${bid.driverName} is on the way. Their photo, car and plate are in your chat — with a button to track the trip live.`);
  }
  switch (result.code) {
    case 'WALLET_SHORT':
      await deps.onWalletShort?.(userId, rideId, bid, result).catch((error) => console.error('[offers-form] wallet short but the Add money button was not sent', { userId, error: error instanceof Error ? error.message : String(error) }));
      return done(`Add ${naira(result.shortNgn)} to ride with ${bid.driverName.split(' ')[0]}`,
        `Your wallet has ${naira(result.balanceNgn)} and the fare is ${naira(result.fareNgn)}. The Add money button is in your chat — the moment it lands, ${bid.driverName.split(' ')[0]} is confirmed by itself.`);
    case 'DRIVER_UNAVAILABLE':
      return offersScreen(deps, rideId, `${bid.driverName} can't be reached right now — your money has not moved. Pick another driver.`);
    case 'DRIVER_TAKEN':
      return offersScreen(deps, rideId, `Another rider is confirming ${bid.driverName} right now — your money has not moved. Pick another driver.`);
    case 'ALREADY_CONFIRMING':
      return done('One moment', `${bid.driverName} is being confirmed — check your chat.`);
    case 'HOLD_FAILED':
      return offersScreen(deps, rideId, 'Could not hold the fare in your wallet just now — nothing was charged. Try again.');
    case 'CONFIRM_FAILED':
      return offersScreen(deps, rideId, 'Could not confirm just now — your money is locked safely. Try again.');
    default:
      return done('This search has ended', 'Nothing was charged. Send your trip again in the chat.');
  }
}
