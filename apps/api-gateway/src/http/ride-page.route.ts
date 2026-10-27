import type { IncomingMessage, ServerResponse } from 'http';
import { rideClient, ridePageEventClient, tripCodeClient, userClient, virtualAccountClient, walletClient } from '@wheleers/db';
import { depositNeededFor, firstOutsideServiceArea, OUTSIDE_SERVICE_AREA_LINE, validateRiderOffer, formatTripId } from '@wheleers/config';
import type { PaymentsClient } from '@wheleers/payments';
import { verifyWalletPageToken } from '../auth/local';
import { extractBearerToken } from './authenticate';
import { readJsonBody, sendJson } from './utils';
import { isRecord } from '../utils/object';
import type { RedisClient } from '../redis/client';
import type { GatewayPublisher } from '../websocket/publisher';
import { provisionDepositAccount } from '../onboarding/user-onboarding';
import { logActivity } from '../analytics/log-activity';
import { estimateEtaSeconds, haversineKm } from '../utils/geo';
import { getAcceptedBid, getActiveRide, getBids, getGroupSeat, getPendingRoute, getRideMeta, getRideState, markRidePageSeen, getLastRoute, setBookingStage, storePendingRoute, MAX_CHAT_STOPS } from '../whatsapp-flows/bid-state';
import type { PendingRouteData, RouteStop } from '../whatsapp-flows/bid-state';
import type { GoogleMapsRoutePlanner } from '@wheleers/config';
import { findPlaceOptions, kmBetween, reverseGeocode, SAME_CITY_KM, SAME_PLACE_KM } from '../LLM/geocoding';
import { tripPageUrl } from '../trip-chat/whatsapp';
import { overLimit } from '../trip-chat/limits';
import {
  cancelWhatsappRide,
  changeRiderOffer,
  confirmRideWithOffer,
  declineAllOffers,
  declineOneOffer,
  offerKey,
  publishWhatsappRide,
  type ConfirmedRide,
} from '../rides/whatsapp-ride.service';
import { rememberChosenOffer } from '../whatsapp/ride-card';
import type { XlmPayer } from '../rides/whatsapp-ride.service';

/**
 * The page a WhatsApp rider opens from the chat ("See driver offers"): name a
 * price, see every driver's offer as it comes, accept one (paying right here
 * when the wallet is short), decline them all, change the price or cancel —
 * then track the trip. The chat gets one message per search ("Your bid is
 * in") with the number of offers shown on it.
 *
 *   GET  /ride-page/state        where the booking is, and the offers on the table
 *   POST /ride-page/find         { amountNgn }  name a price → drivers are asked
 *   POST /ride-page/offer        { amountNgn }  change the bid
 *   POST /ride-page/accept       { key }        take one driver's offer (holds the fare)
 *   POST /ride-page/decline      { key }        decline one driver's offer; they can send a new price
 *   POST /ride-page/decline-all                 decline every offer; the search goes on
 *   POST /ride-page/cancel        { reason, detail? }   stop the search, saying why (the app's reasons)
 *   GET  /ride-page/places?q=&field=            places matching what the rider types (the chat's lookup)
 *   GET  /ride-page/where?lat=&lng=             the rider's position as a place (Use my current location)
 *   POST /ride-page/route         { pickup, destination, stops? }   plan the trip (from Home) or change it before pricing it
 *   POST /ride-page/edit-trip                   go back from the search to the trip: the search stops,
 *                                               the trip comes back to Set your price to change
 *   POST /ride-page/events        { sessionId, events: [{ seq, event, phase?, rideId?, at, props? }] }
 *                                               what the rider did on the page, step by step, for analytics
 *                                               (RidePageEvent; the ride_page_sessions view)
 *   GET  /ride-page/topup?amount=            what to send for ₦amount to land
 *
 * The page polls /state every few seconds, and that poll is also how we know
 * the rider is looking: while it keeps coming, offers are toasts on the page
 * and the chat stays quiet; when it stops, chat notifications resume.
 *
 * It owns no booking logic — that lives in whatsapp-ride.service, shared with
 * the chat — and no state: everything is read from the same Redis keys the chat
 * uses, which is why leaving, refreshing or opening a fresh link an hour later
 * shows the same list.
 */

const TAG = '[api-gateway][ride-page]';

export interface RidePageRouteDeps {
  jwtSecret: string;
  redisClient: RedisClient;
  publisher: GatewayPublisher;
  paymentsClient: PaymentsClient;
  /** Looking places up and planning a changed trip. Absent: the trip cannot be changed on the page. */
  googleMapsApiKey?: string;
  /** The page's Google map (a key restricted to our web address). Absent: the page keeps its old map. */
  googleMapsBrowserKey?: string;
  routePlanner?: Pick<GoogleMapsRoutePlanner, 'planRoute'>;
  /** Tells the chat what happened on the page (search started, ride confirmed). Absent in tests. */
  notifyChat?: (event: RidePageChatEvent) => Promise<void>;
  /** Stellar (testnet): paying with XLM. Absent when Stellar is off — the page then offers naira only. */
  stellar?: (XlmPayer & {
    walletSummary(userId: string): Promise<{ balanceXlm: number; spendableXlm: number; rate: { ngnPerXlm: number; at: string } | null } | null>;
  }) | null;
}

/** What the page needs to offer "Pay with XLM": the spendable balance and the rate (refreshed every 30 minutes). */
async function xlmFor(deps: RidePageRouteDeps, userId: string) {
  if (!deps.stellar) return null;
  const summary = await deps.stellar.walletSummary(userId).catch(() => null);
  if (!summary?.rate) return null;
  return { balanceXlm: summary.balanceXlm, spendableXlm: summary.spendableXlm, ngnPerXlm: summary.rate.ngnPerXlm, rateAt: summary.rate.at };
}

export type RidePageChatEvent =
  | { kind: 'search_started'; userId: string; phone: string; rideId: string; offerNgn: number; pickupAddress: string; destAddress: string; stopAddresses?: string[] }
  | { kind: 'ride_confirmed'; userId: string; phone: string; ride: ConfirmedRide }
  | { kind: 'search_cancelled'; userId: string; phone: string };

class PageError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

function authenticate(req: IncomingMessage, deps: RidePageRouteDeps): string {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) throw new PageError('This link is not valid. Go back to WhatsApp and send any message for a new one.', 401, 'LINK_INVALID');
  let session;
  try {
    session = verifyWalletPageToken(token, deps.jwtSecret);
  } catch {
    throw new PageError('This link has expired. Go back to WhatsApp and send any message for a new one.', 401, 'LINK_EXPIRED');
  }
  if (session.scope !== 'ride') throw new PageError('This link cannot be used for that.', 403, 'LINK_WRONG_SCOPE');
  return session.userId;
}

async function readAmount(req: IncomingMessage): Promise<number> {
  const body = await readJsonBody(req).catch(() => null);
  const raw = isRecord(body) ? body.amountNgn : undefined;
  const amount = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(/[,\s₦]/g, ''));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) {
    throw new PageError('Enter your price in figures.', 400, 'AMOUNT_INVALID');
  }
  // Whole naira: drivers are shown what the rider typed, not ₦2,000.4.
  return Math.round(amount);
}

async function balanceOf(userId: string): Promise<number> {
  const wallet = await walletClient.findByUserId(userId);
  return wallet ? Number(wallet.balanceNgn) : 0;
}

/* ── live trip ─────────────────────────────────────────────────────────── */

// Where the map's pictures come from. OpenStreetMap needs no key; a paid tile
// service can replace it with one setting when traffic grows.
const MAP_TILE_URL = (process.env['MAP_TILE_URL'] ?? 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').trim();
const MAP_ATTRIBUTION = (process.env['MAP_ATTRIBUTION'] ?? '© OpenStreetMap contributors').trim();

// "Back to WhatsApp" on the page. The bot's own number, digits only (2348012345678).
// Unset, the page just says to close itself.
const BOT_NUMBER = (process.env['WHATSAPP_BOT_NUMBER'] ?? '').replace(/\D/g, '');
const CHAT_URL = BOT_NUMBER ? `https://wa.me/${BOT_NUMBER}` : null;

const TRIP_STATUSES = ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'];
/** A position older than this is shown, but labelled as old. */
const POSITION_FRESH_MS = 90_000;

/**
 * The rider's live trip, from the DATABASE — not from the chat's Redis keys,
 * which expire in minutes while a trip can last an hour. Only while a driver is
 * assigned to THIS rider's ride: a driver's position is nobody else's business,
 * and stops being this rider's the moment the trip ends.
 */
async function liveTripFor(userId: string) {
  const active = await rideClient.findActiveByRider(userId).catch(() => null);
  if (!active || !active.driverId || !TRIP_STATUSES.includes(active.status)) return null;
  const ride = await rideClient.findWithDriver(active.id).catch(() => null);
  const driver = ride?.driver;
  if (!ride || !driver) return null;

  const hasPosition = driver.lat != null && driver.lng != null;
  const seenMsAgo = driver.lastSeenAt ? Date.now() - driver.lastSeenAt.getTime() : null;
  const inTrip = ride.status === 'IN_PROGRESS';
  const target = inTrip ? { lat: ride.destLat, lng: ride.destLng } : { lat: ride.pickupLat, lng: ride.pickupLng };
  const kmToGo = hasPosition ? haversineKm(driver.lat!, driver.lng!, target.lat, target.lng) : null;

  return {
    rideId: ride.id,
    tripId: formatTripId(ride.tripNumber),
    status: ride.status,
    fareNgn: Number(ride.agreedFareNgn ?? ride.riderOfferNgn ?? ride.fareEstimateNgn ?? 0),
    route: {
      pickupAddress: ride.pickupAddress,
      destAddress: ride.destAddress,
      distanceKm: ride.distanceKm ?? 0,
      durationMin: Math.ceil((ride.durationSeconds ?? 0) / 60),
    },
    pickup: { lat: ride.pickupLat, lng: ride.pickupLng },
    destination: { lat: ride.destLat, lng: ride.destLng },
    driver: {
      name: driver.user?.name ?? 'Your driver',
      phone: driver.user?.phone ?? '',
      rating: driver.rating,
      totalRides: driver.totalRides,
      vehicle: [driver.vehicleMake, driver.vehicleModel].filter(Boolean).join(' ') || '',
      plate: driver.vehiclePlate ?? '',
      position: hasPosition ? { lat: driver.lat!, lng: driver.lng! } : null,
      positionAgeSeconds: seenMsAgo === null ? null : Math.round(seenMsAgo / 1000),
      positionFresh: seenMsAgo !== null && seenMsAgo <= POSITION_FRESH_MS,
    },
    // Minutes to the pickup before the trip starts, to the destination during it.
    etaMin: kmToGo === null || ride.status === 'ARRIVED' ? null : Math.max(1, Math.round(estimateEtaSeconds(kmToGo) / 60)),
    map: { tileUrl: MAP_TILE_URL, attribution: MAP_ATTRIBUTION },
  };
}

/* ── GET /ride-page/state ─────────────────────────────────────────────── */

/** Every answer the page gets: where the rider is, and the key for its map. */
async function buildState(deps: RidePageRouteDeps, userId: string) {
  return { ...(await buildPhaseState(deps, userId)), mapsKey: deps.googleMapsBrowserKey ?? null };
}

async function buildPhaseState(deps: RidePageRouteDeps, userId: string) {
  const [rideId, balanceNgn, trip] = await Promise.all([getActiveRide(deps.redisClient, userId), balanceOf(userId), liveTripFor(userId)]);

  // A driver is assigned: this is the tracking page now.
  if (trip) {
    // The planned road, saved when the search was published — drawn under the car so
    // "how far?" is answered by the line, not just the badge.
    const planned = await getLastRoute(deps.redisClient, userId).catch(() => null);
    const geometry = planned?.route as { coordinates?: Array<{ lat: number; lng: number }> } | undefined;
    const line = Array.isArray(geometry?.coordinates) ? geometry.coordinates.filter((p) => typeof p?.lat === 'number' && typeof p?.lng === 'number') : [];
    // Before the trip starts: the code the rider gives the driver (not for a group seat).
    const beforeStart = trip.status !== 'IN_PROGRESS';
    const groupSeat = beforeStart ? await getGroupSeat(deps.redisClient, trip.rideId).catch(() => null) : null;
    const tripCode = beforeStart && !groupSeat ? await tripCodeClient.ensure(trip.rideId).catch(() => null) : null;
    const payment = await rideClient.findById(trip.rideId).catch(() => null);
    const paidWithXlm = payment?.paymentMethod === 'XLM' && payment.fareXlm != null
      ? { amountXlm: String(Number(payment.fareXlm)), ngnPerXlm: Number(payment.xlmRateNgn ?? 0) }
      : null;
    return {
      phase: 'confirmed' as const, rideId: trip.rideId, balanceNgn, route: trip.route, offerNgn: trip.fareNgn,
      driver: {
        name: trip.driver.name, phone: trip.driver.phone, rating: trip.driver.rating, totalRides: trip.driver.totalRides,
        vehicle: trip.driver.vehicle, plate: trip.driver.plate, etaMin: trip.etaMin, fareNgn: trip.fareNgn,
      },
      tripCode,
      paidWithXlm,
      // The Trip chat page (same site): chat with, or call, the driver through Wheelers.
      tripChatUrl: tripPageUrl('', deps.jwtSecret, userId, trip.rideId),
      trip: {
        tripId: trip.tripId,
        status: trip.status,
        pickup: trip.pickup,
        destination: trip.destination,
        driverPosition: trip.driver.position,
        positionAgeSeconds: trip.driver.positionAgeSeconds,
        positionFresh: trip.driver.positionFresh,
        etaMin: trip.etaMin,
        map: trip.map,
        line,
      },
    };
  }

  if (rideId) {
    const [meta, state, bids] = await Promise.all([
      getRideMeta(deps.redisClient, rideId),
      getRideState(deps.redisClient, rideId),
      getBids(deps.redisClient, rideId),
    ]);
    if (meta && meta.riderId === userId) {
      const route = {
        pickupAddress: meta.pickupAddress,
        destAddress: meta.destinationAddress,
        stopAddresses: (meta.stops ?? []).map((stop) => stop.address),
        distanceKm: meta.distanceKm,
        durationMin: Math.ceil((meta.durationSeconds ?? 0) / 60),
        suggestedFareNgn: meta.suggestedFareNgn,
      };

      if (state === 'confirmed' || state === 'in_progress') {
        const accepted = await getAcceptedBid(deps.redisClient, rideId);
        return {
          phase: 'confirmed' as const, rideId, balanceNgn, route, offerNgn: meta.offerNgn,
          trip: null,
          driver: accepted ? {
            name: accepted.driverName,
            phone: accepted.driverPhone,
            rating: accepted.driverRating,
            totalRides: accepted.totalRides,
            vehicle: accepted.vehicleModel,
            plate: accepted.vehiclePlate,
            etaMin: Math.ceil(accepted.etaSeconds / 60),
            fareNgn: accepted.fareNgn,
          } : null,
        };
      }

      return {
        phase: 'offers' as const, rideId, balanceNgn, route, offerNgn: meta.offerNgn,
        // Paying with XLM, when the rider has a Stellar account and there is a price.
        xlm: await xlmFor(deps, userId),
        minOfferNgn: validateRiderOffer(0, meta.suggestedFareNgn).minOfferNgn,
        // All the page says about offers: how many are waiting in the chat, and the way back to it.
        offerCount: bids.length,
        chatUrl: CHAT_URL,
        offers: bids.map((bid) => ({
          key: offerKey(bid),
          // Wallet short for THIS offer? Then this is what to deposit — the bank's
          // cut and Wheelers' fee already folded in, so the figure on the Accept
          // sheet is the figure they will actually transfer. null = wallet covers it.
          topupSendNgn: balanceNgn + 0.004 < bid.counterOfferNgn ? depositNeededFor(Math.ceil(bid.counterOfferNgn - balanceNgn)) : null,
          driverName: bid.driverName,
          rating: bid.driverRating,
          vehicle: bid.vehicleModel,
          plate: bid.vehiclePlate,
          priceNgn: bid.counterOfferNgn,
          etaMin: Math.max(1, Math.ceil(bid.etaSeconds / 60)),
          distanceKm: bid.distanceKm ?? null,
          receivedAt: bid.receivedAt,
        })),
      };
    }
  }

  const quote = await getPendingRoute(deps.redisClient, userId);
  if (quote) {
    return {
      phase: 'price' as const, balanceNgn,
      route: {
        pickupAddress: quote.pickupAddress,
        destAddress: quote.destAddress,
        stopAddresses: (quote.stops ?? []).map((stop) => stop.address),
        distanceKm: quote.distanceKm,
        durationMin: Math.ceil(quote.durationSeconds / 60),
        suggestedFareNgn: quote.suggestedFareNgn,
      },
      minOfferNgn: quote.minOfferNgn,
      // Back from a search to change the trip: the price they had named, to start from.
      ...(quote.offerNgn ? { lastOfferNgn: quote.offerNgn } : {}),
      // The page can change the trip (place search and route planning are set up), starting from these places.
      canEditTrip: Boolean(deps.googleMapsApiKey && deps.routePlanner),
      places: {
        pickup: { lat: quote.pickupLat, lng: quote.pickupLng, address: quote.pickupAddress },
        destination: { lat: quote.destLat, lng: quote.destLng, address: quote.destAddress },
        stops: quote.stops ?? [],
      },
      chatUrl: CHAT_URL,
    };
  }

  // No quote and no live search: it expired, was cancelled, or the trip ended.
  return { phase: 'idle' as const, balanceNgn, chatUrl: CHAT_URL };
}

async function handleState(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps): Promise<void> {
  const userId = authenticate(req, deps);
  await markRidePageSeen(deps.redisClient, userId).catch(() => undefined);
  sendJson(res, 200, await buildState(deps, userId));
}

/* ── POST /ride-page/find ─────────────────────────────────────────────── */

async function handleFind(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps): Promise<void> {
  const userId = authenticate(req, deps);
  await markRidePageSeen(deps.redisClient, userId).catch(() => undefined);
  const amountNgn = await readAmount(req);

  const quote = await getPendingRoute(deps.redisClient, userId);
  if (!quote) {
    // Already searching (a double tap, or they named a price in the chat)? Show that.
    if (await getActiveRide(deps.redisClient, userId)) return sendJson(res, 200, await buildState(deps, userId));
    throw new PageError('This quote has expired. Send your trip to the Wheelers bot again for a fresh one.', 409, 'QUOTE_EXPIRED');
  }

  const user = await userClient.findById(userId);
  const phone = user?.phone ?? '';
  const result = await publishWhatsappRide(deps, { id: userId, phone }, quote, amountNgn);
  if (!result.ok) {
    if (result.code === 'BELOW_MINIMUM') {
      throw new PageError(`The lowest price for this trip is ₦${result.minOfferNgn.toLocaleString()}.`, 400, 'BELOW_MINIMUM', { minOfferNgn: result.minOfferNgn });
    }
    if (result.code === 'ALREADY_PUBLISHING') return sendJson(res, 200, await buildState(deps, userId));
    throw new PageError('Could not start the search just now. Please try again.', 503, 'PUBLISH_FAILED');
  }

  logActivity({ userId, eventType: 'ride_search_started', source: 'ride_page', rideId: result.rideId, metadata: { offerNgn: amountNgn } });
  await deps.notifyChat?.({
    kind: 'search_started', userId, phone, rideId: result.rideId, offerNgn: amountNgn,
    pickupAddress: quote.pickupAddress, destAddress: quote.destAddress,
    stopAddresses: (quote.stops ?? []).map((stop) => stop.address),
  }).catch((error) => console.warn(`${TAG} chat notice failed`, { error: error instanceof Error ? error.message : String(error) }));
  sendJson(res, 200, await buildState(deps, userId));
}

/* ── POST /ride-page/offer ────────────────────────────────────────────── */

async function handleOffer(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps): Promise<void> {
  const userId = authenticate(req, deps);
  await markRidePageSeen(deps.redisClient, userId).catch(() => undefined);
  const amountNgn = await readAmount(req);
  const rideId = await getActiveRide(deps.redisClient, userId);
  if (!rideId) throw new PageError('This search has ended.', 409, 'RIDE_GONE');

  const result = await changeRiderOffer(deps, userId, rideId, amountNgn);
  if (!result.ok) {
    if (result.code === 'BELOW_MINIMUM') {
      throw new PageError(`The lowest price for this trip is ₦${result.minOfferNgn.toLocaleString()}.`, 400, 'BELOW_MINIMUM', { minOfferNgn: result.minOfferNgn });
    }
    throw new PageError('This search has ended.', 409, 'RIDE_GONE');
  }
  sendJson(res, 200, await buildState(deps, userId));
}

/* ── POST /ride-page/accept ───────────────────────────────────────────── */

const ACCEPT_FAILURES: Record<string, { status: number; message: string }> = {
  RIDE_GONE: { status: 409, message: 'This search has ended.' },
  OFFER_GONE: { status: 409, message: 'That offer is no longer on the table.' },
  DRIVER_UNAVAILABLE: { status: 409, message: 'That driver just became unavailable — your money has not moved. Pick another offer.' },
  DRIVER_AWAY: { status: 409, message: "That driver's app is closed for a moment — we've sent them a notification. Try again in a minute, or pick another offer. Your money has not moved." },
  DRIVER_TAKEN: { status: 409, message: 'Another rider is confirming that driver right now. Pick another offer.' },
  HOLD_FAILED: { status: 503, message: 'Could not hold the fare in your wallet. Please try again.' },
  CONFIRM_FAILED: { status: 503, message: 'Could not confirm just now — your money is held safely. Tap Accept again.' },
  ALREADY_CONFIRMING: { status: 409, message: 'Your driver is being confirmed — one moment.' },
  XLM_UNAVAILABLE: { status: 409, message: "Paying with XLM isn't available right now. Pay in naira instead — your XLM has not moved." },
};

async function handleAccept(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps): Promise<void> {
  const userId = authenticate(req, deps);
  await markRidePageSeen(deps.redisClient, userId).catch(() => undefined);
  const body = await readJsonBody(req).catch(() => null);
  const key = isRecord(body) && typeof body.key === 'string' ? body.key : '';
  if (!key) throw new PageError('Pick an offer first.', 400, 'BAD_REQUEST');

  const rideId = await getActiveRide(deps.redisClient, userId);
  if (!rideId) throw new PageError('This search has ended.', 409, 'RIDE_GONE');

  // A second tap after the ride is confirmed: the fare is already held, so the
  // wallet looks short — and they would be told to add money for a ride they
  // have. They are confirmed; show them that.
  const current = await getRideState(deps.redisClient, rideId);
  if (current === 'confirmed' || current === 'in_progress') return sendJson(res, 200, await buildState(deps, userId));

  const method = isRecord(body) && body.method === 'xlm' ? 'XLM' as const : 'NGN' as const;
  const result = await confirmRideWithOffer(deps, userId, rideId, key, { method, xlm: deps.stellar ?? null });
  if (!result.ok) {
    if (result.code === 'XLM_SHORT') {
      throw new PageError(
        `This ride is ${result.amountXlm} XLM and you can spend ${result.spendableXlm} XLM. Pay in naira instead — your XLM has not moved.`,
        402, 'XLM_SHORT', { amountXlm: result.amountXlm, spendableXlm: result.spendableXlm },
      );
    }
    if (result.code === 'WALLET_SHORT') {
      // Not an error to apologise for — the page turns this into "Send ₦X",
      // and the driver is remembered: the deposit landing confirms them, with
      // no further tap (the same as from the chat).
      const chosen = (await getBids(deps.redisClient, rideId)).find((bid) => offerKey(bid) === key);
      if (chosen) await rememberChosenOffer(deps, userId, rideId, chosen).catch(() => undefined);
      const account = await depositAccountFor(deps, userId);
      throw new PageError(`Add ₦${result.shortNgn.toLocaleString()} to take this ride.`, 402, 'WALLET_SHORT', {
        balanceNgn: result.balanceNgn, fareNgn: result.fareNgn, shortNgn: result.shortNgn, sendNgn: result.sendNgn, account,
      });
    }
    const failure = ACCEPT_FAILURES[result.code]!;
    throw new PageError(failure.message, failure.status, result.code);
  }

  logActivity({ userId, eventType: 'ride_offer_accepted', source: 'ride_page', rideId, metadata: { fareNgn: result.ride.fareNgn, driverId: result.ride.driverId } });
  const user = await userClient.findById(userId);
  await deps.notifyChat?.({ kind: 'ride_confirmed', userId, phone: user?.phone ?? '', ride: result.ride })
    .catch((error) => console.warn(`${TAG} chat notice failed`, { error: error instanceof Error ? error.message : String(error) }));
  sendJson(res, 200, await buildState(deps, userId));
}

/* ── POST /ride-page/decline ──────────────────────────────────────────── */

async function handleDecline(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps): Promise<void> {
  const userId = authenticate(req, deps);
  await markRidePageSeen(deps.redisClient, userId).catch(() => undefined);
  const body = await readJsonBody(req).catch(() => null);
  const key = isRecord(body) && typeof body.key === 'string' ? body.key : '';
  if (!key) throw new PageError('Pick an offer first.', 400, 'BAD_REQUEST');
  const rideId = await getActiveRide(deps.redisClient, userId);
  if (!rideId) throw new PageError('This search has ended.', 409, 'RIDE_GONE');
  const state = await getRideState(deps.redisClient, rideId);
  if (state === 'confirmed' || state === 'in_progress') return sendJson(res, 200, await buildState(deps, userId));
  const offer = (await getBids(deps.redisClient, rideId)).find((bid) => offerKey(bid) === key);
  if (offer) {
    await declineOneOffer(deps, userId, rideId, offer.driverId);
    logActivity({ userId, eventType: 'ride_offer_declined', source: 'ride_page', rideId, metadata: { driverId: offer.driverId } });
  }
  sendJson(res, 200, await buildState(deps, userId));
}

/* ── POST /ride-page/decline-all ──────────────────────────────────────── */

async function handleDeclineAll(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps): Promise<void> {
  const userId = authenticate(req, deps);
  await markRidePageSeen(deps.redisClient, userId).catch(() => undefined);
  const rideId = await getActiveRide(deps.redisClient, userId);
  if (!rideId) throw new PageError('This search has ended.', 409, 'RIDE_GONE');
  const state = await getRideState(deps.redisClient, rideId);
  if (state === 'confirmed' || state === 'in_progress') return sendJson(res, 200, await buildState(deps, userId));
  const { declined } = await declineAllOffers(deps, userId, rideId);
  logActivity({ userId, eventType: 'ride_offers_declined', source: 'ride_page', rideId, metadata: { declined } });
  sendJson(res, 200, await buildState(deps, userId));
}

/* ── POST /ride-page/cancel ───────────────────────────────────────────── */

/** Why a rider stops a search: the app's own list (app/rider-cancel.tsx), so both say the same. */
export const SEARCH_CANCEL_REASONS = [
  "It's taking too long to find a driver",
  'The prices are too high',
  'Wrong pickup or destination',
  'I found another ride',
  'My plans changed',
  'Other reason',
] as const;
const OTHER_REASON = 'Other reason';

/** The reason as it is saved on the ride: one of the list, or "Other: their own words". Null: none given. */
async function readCancelReason(req: IncomingMessage): Promise<string | null> {
  const body = await readJsonBody(req).catch(() => null);
  if (!isRecord(body) || typeof body.reason !== 'string') return null;
  const reason = body.reason.trim();
  if (!(SEARCH_CANCEL_REASONS as readonly string[]).includes(reason)) throw new PageError('Pick why you are cancelling.', 400, 'REASON_INVALID');
  if (reason !== OTHER_REASON) return reason;
  // Their own words are optional, as in the app.
  const words = (typeof body.detail === 'string' ? body.detail : '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return words ? `Other: ${words}` : OTHER_REASON;
}

async function handleCancel(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps): Promise<void> {
  const userId = authenticate(req, deps);
  // A page opened before reasons were asked sends none: it still cancels.
  const reason = await readCancelReason(req);
  const rideId = await getActiveRide(deps.redisClient, userId);
  if (rideId) {
    await whileNotConfirming(deps, rideId, async () => {
      const state = await getRideState(deps.redisClient, rideId);
      if (state === 'confirmed' || state === 'in_progress') {
        // A driver is on the way: that cancellation has reasons and may carry a fee. The chat handles it.
        throw new PageError('Your driver is already confirmed. To cancel this trip, reply "cancel" in the chat.', 409, 'ALREADY_CONFIRMED');
      }
      await cancelWhatsappRide(deps, userId, rideId, reason ?? 'Cancelled on the offers page');
    });
    logActivity({ userId, eventType: 'ride_search_cancelled', source: 'ride_page', rideId, metadata: reason ? { reason } : {} });
    const user = await userClient.findById(userId);
    await deps.notifyChat?.({ kind: 'search_cancelled', userId, phone: user?.phone ?? '' }).catch(() => undefined);
  }
  sendJson(res, 200, await buildState(deps, userId));
}

/**
 * Runs `work` holding the ride's confirming lock (the one confirmRideWithOffer
 * takes), so a search is never cancelled while a driver is being confirmed on
 * it: a deposit landing or an Accept in the chat in the same second.
 */
async function whileNotConfirming(deps: RidePageRouteDeps, rideId: string, work: () => Promise<void>): Promise<void> {
  const key = `whatsapp:ride:${rideId}:confirming`;
  const mine = await deps.redisClient.setIfNotExists(key, '1', 20).catch(() => true);
  if (!mine) throw new PageError('A driver is being confirmed for this trip right now. Give it a moment.', 409, 'CONFIRMING');
  try {
    await work();
  } finally {
    await deps.redisClient.del(key).catch(() => undefined);
  }
}

/* ── GET /ride-page/places?q=&field= ──────────────────────────────────── */

/** The rider's search box: places matching what they typed, near the other end of the trip. */
async function handlePlaces(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps, url: URL): Promise<void> {
  const userId = authenticate(req, deps);
  if (!deps.googleMapsApiKey) throw new PageError('Changing the trip is not available right now. Send the new trip in the chat.', 503, 'EDIT_OFF');
  const query = (url.searchParams.get('q') ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (query.length < 3) return sendJson(res, 200, { places: [] });
  // Every lookup is billed by Google: plenty for typing, not for a script.
  if (await overLimit(deps.redisClient, `ride-page:places:${userId}`, 40, 60)) {
    throw new PageError('Too many searches at once. Wait a moment and try again.', 429, 'TOO_MANY');
  }
  const trip = await getPendingRoute(deps.redisClient, userId);
  const field = url.searchParams.get('field');
  // Looking for a pickup: near the destination, and the other way round.
  const near = trip ? (field === 'pickup' ? { lat: trip.destLat, lng: trip.destLng } : { lat: trip.pickupLat, lng: trip.pickupLng }) : undefined;
  const matches = await findPlaceOptions(deps.googleMapsApiKey, query, { ...(near ? { near } : {}), limit: 6 }).catch(() => []);
  sendJson(res, 200, {
    places: matches.slice(0, 6).map((match) => {
      const [name, ...rest] = match.formattedAddress.split(',');
      return { lat: match.lat, lng: match.lng, address: match.formattedAddress, name: (name ?? match.formattedAddress).trim(), area: rest.join(',').trim() };
    }),
  });
}

/* ── GET /ride-page/where ─────────────────────────────────────────────── */

/** Where the rider's phone says they are, as a place: the pickup "Use my current location" fills in. */
async function handleWhere(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps, url: URL): Promise<void> {
  const userId = authenticate(req, deps);
  if (!deps.googleMapsApiKey) throw new PageError('Type your pickup instead.', 503, 'EDIT_OFF');
  const lat = Number(url.searchParams.get('lat'));
  const lng = Number(url.searchParams.get('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 3 || lat > 14.5 || lng < 2 || lng > 15) {
    throw new PageError('Type your pickup instead.', 400, 'PLACE_INVALID');
  }
  if (await overLimit(deps.redisClient, `ride-page:where:${userId}`, 20, 60)) {
    throw new PageError('Type your pickup instead.', 429, 'TOO_MANY');
  }
  const inArea = !firstOutsideServiceArea([{ lat, lng }]);
  const found = await reverseGeocode(deps.googleMapsApiKey, lat, lng).catch(() => null);
  const address = found?.formattedAddress ?? '';
  const [name, ...rest] = address.split(',');
  sendJson(res, 200, { place: address ? { lat, lng, address, name: (name ?? address).trim(), area: rest.join(',').trim() } : null, inArea });
}

/* ── POST /ride-page/route ────────────────────────────────────────────── */

function readPlace(value: unknown, label: string): RouteStop {
  const place = isRecord(value) ? value : null;
  const lat = Number(place?.lat);
  const lng = Number(place?.lng);
  const address = typeof place?.address === 'string' ? place.address.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  // Nigeria, roughly: a place from anywhere else is a mistake (or a made-up request).
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 3 || lat > 14.5 || lng < 2 || lng > 15 || !address) {
    throw new PageError(`Pick the ${label} from the list.`, 400, 'PLACE_INVALID');
  }
  return { lat, lng, address };
}

/**
 * The trip changed on the page, before a price is named: planned again, the
 * suggested price with it, and saved as the trip the chat knows too. The same
 * checks the chat's trip form makes (another city, two places the same).
 */
async function handleRoute(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps): Promise<void> {
  const userId = authenticate(req, deps);
  await markRidePageSeen(deps.redisClient, userId).catch(() => undefined);
  if (!deps.routePlanner) throw new PageError('Changing the trip is not available right now. Send the new trip in the chat.', 503, 'EDIT_OFF');
  if (await getActiveRide(deps.redisClient, userId)) throw new PageError('Drivers are already looking at this trip. Go back to change it.', 409, 'ALREADY_SEARCHING');
  // No trip yet: one planned on the page (Home → Plan your trip) starts here.
  const trip = await getPendingRoute(deps.redisClient, userId);
  // Each new trip is a paid Google route: plenty for a rider, not for a script.
  if (await overLimit(deps.redisClient, `ride-page:route:${userId}`, 15, 60)) {
    throw new PageError('Too many changes at once. Wait a moment and try again.', 429, 'TOO_MANY');
  }

  const body = await readJsonBody(req).catch(() => null);
  if (!isRecord(body)) throw new PageError('Pick the pickup and the destination.', 400, 'BAD_REQUEST');
  const pickup = readPlace(body.pickup, 'pickup');
  const destination = readPlace(body.destination, 'destination');
  const stops = (Array.isArray(body.stops) ? body.stops : []).slice(0, MAX_CHAT_STOPS).map((stop, index) => readPlace(stop, `stop ${index + 1}`));

  const far = [{ label: 'destination', place: destination }, ...stops.map((place, index) => ({ label: `stop ${index + 1}`, place }))]
    .find(({ place }) => kmBetween(pickup, place) > SAME_CITY_KM);
  if (far) throw new PageError(`That ${far.label} is about ${Math.round(kmBetween(pickup, far.place)).toLocaleString()} km from your pickup. Pick a place in Lagos.`, 400, 'TOO_FAR');
  if (firstOutsideServiceArea([pickup, ...stops, destination])) throw new PageError(OUTSIDE_SERVICE_AREA_LINE, 400, 'OUTSIDE_SERVICE_AREA');
  const named = [{ label: 'pickup', place: pickup }, ...stops.map((place, index) => ({ label: `stop ${index + 1}`, place })), { label: 'destination', place: destination }];
  for (let a = 0; a < named.length; a++) {
    for (let b = a + 1; b < named.length; b++) {
      if (kmBetween(named[a]!.place, named[b]!.place) < SAME_PLACE_KM) {
        throw new PageError(`Your ${named[a]!.label} and your ${named[b]!.label} are the same place. Change one of them.`, 400, 'SAME_PLACE');
      }
    }
  }

  const before = trip?.stops ?? [];
  const unchanged = trip !== null && trip.pickupAddress === pickup.address && trip.destAddress === destination.address
    && before.length === stops.length && stops.every((stop, index) => stop.address === before[index]!.address);
  if (!unchanged) {
    const planned = await deps.routePlanner.planRoute({ origin: pickup, destination, ...(stops.length ? { stops } : {}) }).catch(() => null);
    if (!planned) throw new PageError('We could not find a driving route through those places. Check them and try again.', 422, 'NO_ROUTE');
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
      // Looked at and changed on the page itself: the price is the next step.
      confirmed: true,
    };
    await storePendingRoute(deps.redisClient, userId, next);
    await setBookingStage(deps.redisClient, userId, 'awaiting_price');
    logActivity({ userId, eventType: 'ride_trip_changed', source: 'ride_page', metadata: { distanceKm: planned.distanceKm, stops: stops.length } });
  }
  sendJson(res, 200, await buildState(deps, userId));
}

/* ── POST /ride-page/edit-trip ────────────────────────────────────────── */

/**
 * Back from the search to the trip, to change it: the search stops (no driver
 * is waiting on it), and the trip it was for comes back to Set your price.
 * The chat is not told it was cancelled: the rider has not given up.
 */
async function handleEditTrip(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps): Promise<void> {
  const userId = authenticate(req, deps);
  await markRidePageSeen(deps.redisClient, userId).catch(() => undefined);
  const rideId = await getActiveRide(deps.redisClient, userId);
  if (!rideId) return sendJson(res, 200, await buildState(deps, userId));
  const [last, meta] = await Promise.all([getLastRoute(deps.redisClient, userId), getRideMeta(deps.redisClient, rideId)]);
  // The trip to bring back must be this search's trip. Some searches (the chat's
  // forms, a group seat) do not remember one, and an older trip is the wrong one.
  const sameTrip = last && meta && meta.riderId === userId
    && last.pickupAddress === meta.pickupAddress && last.destAddress === meta.destinationAddress
    && (last.stops ?? []).length === (meta.stops ?? []).length;
  if (!sameTrip) throw new PageError('This trip can not be changed here. Reply "cancel" in the chat, then send the new trip.', 409, 'EDIT_NOT_HERE');
  await whileNotConfirming(deps, rideId, async () => {
    const state = await getRideState(deps.redisClient, rideId);
    if (state === 'confirmed' || state === 'in_progress') {
      throw new PageError('Your driver is already confirmed. To change this trip, reply in the chat.', 409, 'ALREADY_CONFIRMED');
    }
    await cancelWhatsappRide(deps, userId, rideId, 'Changed the trip on the offers page');
  });
  await storePendingRoute(deps.redisClient, userId, { ...last, route: last.route, confirmed: true });
  await setBookingStage(deps.redisClient, userId, 'awaiting_price');
  logActivity({ userId, eventType: 'ride_search_cancelled', source: 'ride_page', rideId, metadata: { reason: 'Changed the trip' } });
  sendJson(res, 200, await buildState(deps, userId));
}

/* ── POST /ride-page/events ───────────────────────────────────────────── */

/**
 * The steps the page may report. Anything else is dropped: the table is for
 * analysis, so it holds only names an analyst can rely on.
 */
export const RIDE_PAGE_EVENTS = [
  'page_opened', 'phase_shown', 'page_hidden', 'page_visible', 'page_left',
  'price_changed', 'find_tapped', 'find_failed',
  'trip_edit_opened', 'place_searched', 'place_picked', 'stop_removed', 'trip_saved', 'trip_save_failed',
  'offer_received', 'raise_tapped', 'price_sheet_opened', 'price_updated', 'price_update_failed',
  'offer_declined', 'decline_all',
  'accept_tapped', 'accept_failed', 'pay_method_chosen', 'wallet_short_shown', 'account_copied', 'pay_sheet_closed',
  'cancel_opened', 'cancel_reason_picked', 'cancel_confirmed', 'cancel_failed', 'cancel_kept',
  'edit_trip_back_tapped', 'edit_trip_back_confirmed', 'edit_trip_back_kept',
  'chat_link_tapped', 'call_driver_tapped', 'chat_driver_tapped', 'map_recentred',
] as const;
const EVENT_NAMES = new Set<string>(RIDE_PAGE_EVENTS);
const PHASES = new Set(['loading', 'fatal', 'idle', 'price', 'offers', 'confirmed']);
const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;
const RIDE_ID = /^[0-9A-Za-z-]{8,64}$/;
const MAX_EVENTS = 50;
const DAY_MS = 86_400_000;

/** A step's details: a flat object of short strings, numbers and true/false, at most 20 of them. */
function cleanProps(value: unknown): Record<string, string | number | boolean> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(value).slice(0, 20)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key)) continue;
    if (typeof raw === 'string') out[key] = raw.replace(/\s+/g, ' ').trim().slice(0, 200);
    else if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw;
    else if (typeof raw === 'boolean') out[key] = raw;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * What the rider did on the page, sent in small batches (and once more as they
 * leave). Never fails the page: bad steps are dropped, and the answer is 202
 * whatever was kept. Does not count as "the rider is looking" (the poll does).
 */
async function handleEvents(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps): Promise<void> {
  const userId = authenticate(req, deps);
  const body = await readJsonBody(req).catch(() => null);
  // The page sends a batch every few seconds; far more than that is not a person. Dropped, never refused.
  if (await overLimit(deps.redisClient, `ride-page:events:${userId}`, 60, 60)) return sendJson(res, 202, { ok: true, kept: 0 });
  const sessionId = isRecord(body) && typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!SESSION_ID.test(sessionId) || !isRecord(body) || !Array.isArray(body.events)) {
    throw new PageError('sessionId and events are needed.', 400, 'BAD_REQUEST');
  }
  const now = Date.now();
  const rows = body.events.slice(0, MAX_EVENTS).flatMap((raw) => {
    if (!isRecord(raw) || typeof raw.event !== 'string' || !EVENT_NAMES.has(raw.event)) return [];
    const seq = Number(raw.seq);
    if (!Number.isInteger(seq) || seq < 1 || seq > 100_000) return [];
    const at = Date.parse(String(raw.at ?? ''));
    // The phone's clock, within the visit; a clock a day out is replaced by ours.
    const clientAt = new Date(Number.isFinite(at) && Math.abs(at - now) < DAY_MS ? at : now);
    const phase = typeof raw.phase === 'string' && PHASES.has(raw.phase) ? raw.phase : null;
    const rideId = typeof raw.rideId === 'string' && RIDE_ID.test(raw.rideId) ? raw.rideId : null;
    return [{ sessionId, userId, rideId, event: raw.event, phase, seq, props: cleanProps(raw.props), clientAt }];
  });
  await ridePageEventClient.recordMany(rows).catch((error) =>
    console.warn(`${TAG} page events not kept`, { error: error instanceof Error ? error.message : String(error) }));
  sendJson(res, 202, { ok: true, kept: rows.length });
}

/* ── GET /ride-page/topup?amount= ─────────────────────────────────────── */

async function depositAccountFor(deps: RidePageRouteDeps, userId: string) {
  let account = await virtualAccountClient.findByUserId(userId);
  if (!account) {
    const user = await userClient.findById(userId);
    await provisionDepositAccount(deps.paymentsClient, userId, user?.name ?? undefined, user?.phone ?? undefined).catch(() => undefined);
    account = await virtualAccountClient.findByUserId(userId);
  }
  return account ? { bankName: account.bankName, accountNumber: account.accountNumber, accountName: account.accountName } : null;
}

async function handleTopup(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps, url: URL): Promise<void> {
  const userId = authenticate(req, deps);
  await markRidePageSeen(deps.redisClient, userId).catch(() => undefined);
  const wanted = Math.floor(Number(url.searchParams.get('amount')));
  if (!Number.isFinite(wanted) || wanted < 1 || wanted > 10_000_000) throw new PageError('Enter an amount.', 400, 'AMOUNT_INVALID');
  // One figure to send, exactly as on the Add money page — never an itemised list.
  sendJson(res, 200, {
    walletGetsNgn: wanted,
    shortNgn: wanted,
    sendNgn: depositNeededFor(wanted),
    balanceNgn: await balanceOf(userId),
    // null while the bank is still opening the account: the page keeps asking.
    account: await depositAccountFor(deps, userId),
  });
}

/* ── dispatch ─────────────────────────────────────────────────────────── */

type Handler = (req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps, url: URL) => Promise<void>;

const ROUTES: Record<string, { method: 'GET' | 'POST'; run: Handler }> = {
  '/ride-page/state': { method: 'GET', run: handleState },
  '/ride-page/find': { method: 'POST', run: handleFind },
  '/ride-page/offer': { method: 'POST', run: handleOffer },
  '/ride-page/accept': { method: 'POST', run: handleAccept },
  '/ride-page/decline': { method: 'POST', run: handleDecline },
  '/ride-page/decline-all': { method: 'POST', run: handleDeclineAll },
  '/ride-page/cancel': { method: 'POST', run: handleCancel },
  '/ride-page/places': { method: 'GET', run: handlePlaces },
  '/ride-page/route': { method: 'POST', run: handleRoute },
  '/ride-page/where': { method: 'GET', run: handleWhere },
  '/ride-page/edit-trip': { method: 'POST', run: handleEditTrip },
  '/ride-page/events': { method: 'POST', run: handleEvents },
  '/ride-page/topup': { method: 'GET', run: handleTopup },
};

/** Every /ride-page/* request. Returns false when the path is not ours. */
export async function handleRidePageRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RidePageRouteDeps,
  url: URL,
): Promise<boolean> {
  const route = ROUTES[url.pathname];
  if (!route) return false;
  if (req.method !== route.method) {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }

  // Balances, account numbers and a driver's phone: never cached.
  res.setHeader('Cache-Control', 'no-store');
  try {
    await route.run(req, res, deps, url);
  } catch (error) {
    if (error instanceof PageError) {
      sendJson(res, error.status, { error: error.message, code: error.code, ...error.extra });
    } else {
      console.error(`${TAG} ${url.pathname} failed`, { error: error instanceof Error ? error.message : String(error) });
      sendJson(res, 500, { error: 'Something went wrong on our side. Please try again.', code: 'INTERNAL' });
    }
  }
  return true;
}
