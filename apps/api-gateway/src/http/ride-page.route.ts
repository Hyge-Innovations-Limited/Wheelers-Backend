import type { IncomingMessage, ServerResponse } from 'http';
import { referralClient, rideClient, ridePageEventClient, safetyAlertClient, scheduledRideClient, tripCodeClient, userClient, virtualAccountClient, walletClient } from '@wheleers/db';
import { depositNeededFor, firstOutsideServiceArea, OUTSIDE_SERVICE_AREA_LINE, validateRiderOffer, formatTripId } from '@wheleers/config';
import type { PaymentsClient } from '@wheleers/payments';
import { createWalletPageToken, PageLinkExpiredError, RIDE_PAGE_TOKEN_TTL_SECONDS, verifyWalletPageToken } from '../auth/local';
import type { Queue } from 'bullmq';
import { buildScheduledRideJobId, parseScheduledFor } from './ride.route';
import { placeLocation, suggestPlaces } from './ride-page-places';
import { WHEELERS_NUMBER } from '../whatsapp/referral';
import { extractBearerToken } from './authenticate';
import { readJsonBody, sendJson } from './utils';
import { isRecord } from '../utils/object';
import type { RedisClient } from '../redis/client';
import type { GatewayPublisher } from '../websocket/publisher';
import { provisionDepositAccount } from '../onboarding/user-onboarding';
import { logActivity } from '../analytics/log-activity';
import { estimateEtaSeconds, haversineKm } from '../utils/geo';
import { clearActiveRideIfMatches, clearPendingAccept, getPendingAccept, markCancelledOnPage, unmarkCancelledOnPage, wasCancelledOnPage, getAcceptedBid, getActiveRide, getBids, getGroupSeat, getPendingRoute, getRideMeta, getRideState, markRidePageSeen, getLastRoute, getSearchTimedOut, setBookingStage, storePendingRoute, whatsappWindowEnd, MAX_CHAT_STOPS, getPageNotice, clearPageNotice, getTripLine, storeTripLine } from '../whatsapp-flows/bid-state';
import { getSearchStatus } from '../rides/search-status';
import { releaseBookingLock, takeBookingLock } from '../rides/booking-lock';
import { autoAcceptOnAtStart, autoAcceptStatus, switchAutoAccept } from '../rides/auto-accept';
import { quoteTripRoute } from '../rides/trip-route-quote';
import { takeRidePageOpenCode } from '../whatsapp/scheduled-template';
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
import { handleRideMessage } from '../websocket/handlers/ride.handler';
import type { GatewayAuthContext } from '../types';
import { cancelRiderSos, raiseRiderSos, SOS_KINDS, sosLabel } from '../safety/rider-sos';
import { supportContact } from '../whatsapp/menu';
import { scheduledStartTemplate } from '../whatsapp/scheduled-template';
import { refusalCode } from '../utils/service-area';

/**
 * The page a WhatsApp rider opens from the chat ("See driver offers"): name a
 * price, see every driver's offer as it comes, accept one (paying right here
 * when the wallet is short), decline them all, change the price or cancel —
 * then track the trip. The chat gets one message per search ("Your bid is
 * in") with the number of offers shown on it.
 *
 *   GET  /ride-page/state        where the booking is, and the offers on the table
 *   POST /ride-page/find         { amountNgn, autoAccept? }  name a price → drivers are asked (autoAccept: true: the rider's yes to auto-booking)
 *   POST /ride-page/auto-accept  { on, priceNgn? }  switch auto-accept for this search (on: the rider's yes, at priceNgn)
 *   POST /ride-page/search-again { amountNgn, autoAccept? }  after "No driver accepted": the same trip again at a new price
 *   POST /ride-page/offer        { amountNgn, autoAccept? }  change the bid (autoAccept: the answer to auto-booking at it)
 *   POST /ride-page/accept       { key, priceNgn? }  take one driver's offer (holds the fare); priceNgn: the price shown
 *   POST /ride-page/decline      { key }        decline one driver's offer; they can send a new price
 *   POST /ride-page/keep-looking                backed out of adding money for a driver: no longer theirs to pay for
 *   POST /ride-page/decline-all                 decline every offer; the search goes on
 *   POST /ride-page/cancel        { reason, detail? }   stop the search, saying why (the app's reasons)
 *   GET  /ride-page/places?q=&field=            places matching what the rider types (the chat's lookup; pages before /suggest)
 *   GET  /ride-page/suggest?q=&session=         places matching what the rider types, inside Lagos (Google Places, as the app)
 *   GET  /ride-page/place?id=&session=          where a suggested place is: { place: { lat, lng } }
 *   POST /ride-page/schedule/quote { scheduledFor, pickup, destination, stops? }   a ride for later, priced (nothing kept)
 *   POST /ride-page/schedule      { scheduledFor, pickup, destination, stops?, requestId? }   book it (its search starts
 *                                               before the pickup time and is a WhatsApp search)
 *   GET  /ride-page/scheduled                   rides for later still waiting
 *   POST /ride-page/scheduled/:id/cancel        cancel one of them
 *   POST /ride-page/cancel-ride   { reason, detail? }   cancel the trip once a driver is booked (the app's ride:cancel)
 *   POST /ride-page/trip-route/quote { destination?, stops }   what that change would cost: { fareNgn, extraNgn } (nothing moves)
 *   POST /ride-page/trip-route    { destination?, stops, acceptedFareNgn }   change where a booked trip goes (the app's
 *                                               ride:route:update), at the quoted price (else 409 PRICE_CHANGED)
 *   POST /ride-page/sos           { kind? }     the Emergency button: the safety team is alerted (as the ride card's SOS)
 *   POST /ride-page/sos/cancel                  "I'm safe": the rider's open alert is withdrawn
 *   GET  /ride-page/open/:code                  the start template's button: a one-time code, on to the page with a fresh link
 *   POST /ride-page/notice/seen   { id }        Home's one line (state.notice) was seen
 *   GET  /ride-page/where?lat=&lng=             the rider's position as a place (Use my current location)
 *   POST /ride-page/route         { pickup, destination, stops? }   plan the trip (from Home) or change it before pricing it
 *   POST /ride-page/edit-trip                   go back from the search to the trip: the search stops,
 *                                               the trip comes back to Set your price to change
 *   POST /ride-page/events        { sessionId, events: [{ seq, event, phase?, rideId?, at, props? }] }
 *                                               what the rider did on the page, step by step, for analytics
 *                                               (RidePageEvent; the ride_page_sessions view)
 *   GET  /ride-page/topup?amount=            what to send for ₦amount to land
 *   POST /ride-page/keep-looking  { key? }      backed out of adding money for that offer's driver: let go of them
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
  /** Rides for later: the scheduler's queue and how long before the pickup the search starts. Absent: no "Later". */
  scheduling?: { dispatcherQueue: Pick<Queue, 'add' | 'remove'>; leadTimeMs: number };
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
  | { kind: 'search_started'; userId: string; phone: string; rideId: string; offerNgn: number; pickupAddress: string; destAddress: string; stopAddresses?: string[]; scheduled?: boolean }
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
  } catch (error) {
    // A real link whose time is up: the page says so, with the way back to the chat for a new one.
    if (error instanceof PageLinkExpiredError) {
      // The full sentence: a page opened before this release shows the message alone.
      throw new PageError('This link has expired. Go back to WhatsApp and send any message for a new one.', 401, 'LINK_EXPIRED', { chatUrl: EXPIRED_CHAT_URL });
    }
    throw new PageError('This link is not valid. Go back to WhatsApp and send any message for a new one.', 401, 'LINK_INVALID');
  }
  if (session.scope !== 'ride') throw new PageError('This link cannot be used for that.', 403, 'LINK_WRONG_SCOPE');
  return session.userId;
}

/** The price in a body already read: whole naira, or refused in words. */
function amountIn(body: unknown): number {
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
/** An expired link's one button: the bot's chat, Wheelers' own number when none is set. */
const EXPIRED_CHAT_URL = CHAT_URL ?? `https://wa.me/${WHEELERS_NUMBER}`;

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
  // Where the trip goes now (a changed route lives in its stops): for Plan your trip, pre-filled.
  const finalStop = ride.routeStops.find((stop) => stop.type === 'FINAL');
  const endsAt = finalStop
    ? { lat: finalStop.lat, lng: finalStop.lng, address: finalStop.address }
    : { lat: ride.destLat, lng: ride.destLng, address: ride.destAddress };
  const stopsLeft = ride.routeStops
    .filter((stop) => stop.type === 'INTERMEDIATE' && stop.status === 'PENDING')
    .map((stop) => ({ lat: stop.lat, lng: stop.lng, address: stop.address }));

  return {
    rideId: ride.id,
    tripId: formatTripId(ride.tripNumber),
    status: ride.status,
    fareNgn: Number(ride.agreedFareNgn ?? ride.riderOfferNgn ?? ride.fareEstimateNgn ?? 0),
    route: {
      pickupAddress: ride.pickupAddress,
      destAddress: endsAt.address,
      stopAddresses: stopsLeft.map((stop) => stop.address),
      distanceKm: ride.distanceKm ?? 0,
      durationMin: Math.ceil((ride.durationSeconds ?? 0) / 60),
    },
    places: {
      pickup: { lat: ride.pickupLat, lng: ride.pickupLng, address: ride.pickupAddress },
      destination: endsAt,
      stops: stopsLeft,
    },
    driverId: ride.driverId,
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
  const [pointer, balanceNgn, live] = await Promise.all([getActiveRide(deps.redisClient, userId), balanceOf(userId), liveTripFor(userId)]);
  // Cancelled on the page a moment ago: over, though the database has not caught up yet.
  const trip = live && await wasCancelledOnPage(deps.redisClient, live.rideId) ? null : live;
  const rideId = pointer && await wasCancelledOnPage(deps.redisClient, pointer) ? null : pointer;

  // A driver is assigned: this is the tracking page now.
  if (trip) {
    // The planned road — the trip's own once its route was changed, else the one saved when the
    // search was published — drawn under the car so "how far?" is answered by the line, not just the badge.
    const changed = await getTripLine(deps.redisClient, trip.rideId).catch(() => null);
    const planned = changed ? null : await getLastRoute(deps.redisClient, userId).catch(() => null);
    const geometry = changed ? { coordinates: changed } : planned?.route as { coordinates?: Array<{ lat: number; lng: number }> } | undefined;
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
      // Plan your trip, pre-filled, to change where it goes.
      places: trip.places,
      ...(await tripExtras(userId)),
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
        // The line under the price: why it is up, and by how much (null: nothing notable).
        priceReason: meta.priceReason ?? null,
      };

      if (state === 'confirmed' || state === 'in_progress') {
        const accepted = await getAcceptedBid(deps.redisClient, rideId);
        return {
          phase: 'confirmed' as const, rideId, balanceNgn, route, offerNgn: meta.offerNgn,
          trip: null,
          places: placesOf(meta),
          ...(await tripExtras(userId)),
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

      const [status, autoBook, planned] = await Promise.all([
        getSearchStatus(deps.redisClient, rideId).catch(() => ({ driversNotified: null, bidsCloseAt: null })),
        autoAcceptStatus(deps.redisClient, rideId).catch(() => ({ on: false, priceNgn: null })),
        getLastRoute(deps.redisClient, userId).catch(() => null),
      ]);
      // The Finding map: the trip's places, and its road when the last route saved is this search's trip.
      const places = placesOf(meta);
      const sameTrip = planned && planned.pickupAddress === meta.pickupAddress && planned.destAddress === meta.destinationAddress;
      const road = sameTrip ? (planned.route as { coordinates?: Array<{ lat: number; lng: number }> } | undefined)?.coordinates : undefined;
      const line = Array.isArray(road) ? road.filter((p) => typeof p?.lat === 'number' && typeof p?.lng === 'number') : [];
      return {
        phase: 'offers' as const, rideId, balanceNgn, route, offerNgn: meta.offerNgn,
        // The waiting screen: drivers the price went out to, and when the search closes.
        driversNotified: status.driversNotified,
        bidsCloseAt: status.bidsCloseAt,
        // Only when the rider said yes at Find: the first driver at or under the price (never above the
        // price of the yes, autoAcceptPriceNgn), ≤ 10 min away, is booked when the wallet covers them.
        autoAccept: autoBook.on,
        autoAcceptPriceNgn: autoBook.priceNgn,
        places,
        line,
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
        priceReason: quote.priceReason ?? null,
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
  return {
    phase: 'idle' as const, balanceNgn, chatUrl: CHAT_URL, lastSearch: await lastSearchFor(deps, userId),
    // Home's "Later" (a ride for later), and how many stops Plan your trip takes.
    canSchedule: Boolean(deps.scheduling && deps.routePlanner),
    maxStops: MAX_CHAT_STOPS,
    // The latest pickup time Later may offer: the end of the rider's 24 h WhatsApp window
    // (its start message must reach them); null: the usual 7 days (the start template is set).
    scheduleUntil: await scheduleUntilFor(deps, userId),
    // One line the chat could not say (a ride for later that could not start): shown until seen (POST /ride-page/notice/seen).
    notice: await getPageNotice(deps.redisClient, userId).catch(() => null),
  };
}

/** A search's places from its saved trip; null when it was saved without them. */
function placesOf(meta: NonNullable<Awaited<ReturnType<typeof getRideMeta>>>) {
  return meta.pickupLat != null && meta.pickupLng != null && meta.destinationLat != null && meta.destinationLng != null
    ? {
        pickup: { lat: meta.pickupLat, lng: meta.pickupLng, address: meta.pickupAddress },
        destination: { lat: meta.destinationLat, lng: meta.destinationLng, address: meta.destinationAddress },
        stops: meta.stops ?? [],
      }
    : null;
}

/** Why a booked trip may be cancelled: the app's list once a driver is coming (app/rider-cancel.tsx). */
export const RIDE_CANCEL_REASONS = [
  'Long waiting time',
  'Wrong pickup or destination',
  'Driver is not moving',
  'Driver asked me to cancel',
  'My plans changed',
  'Other reason',
] as const;
/** Their own words for "Other reason", at most this long (as in the app). */
const OWN_WORDS_MAX = 140;

/** As many stops as the app allows on a trip (MAX_ADDITIONAL_STOPS), for changing a booked trip's route. */
export const TRIP_MAX_STOPS = 5;

/** On a booked trip: the cancel reasons, who to reach for help (Quick Actions' support), the Emergency kinds, an open SOS. */
async function tripExtras(userId: string) {
  const alert = await safetyAlertClient.findOpenForUser(userId).catch(() => null);
  return {
    rideCancelReasons: [...RIDE_CANCEL_REASONS],
    supportContact: supportContact(),
    // The app's Emergency choices, in its order (POST /ride-page/sos { kind }).
    sosKinds: SOS_KINDS.map((k) => k.label),
    sosActive: Boolean(alert),
    // The open alert: when it was sent, and which (as the app shows it: "Unsafe driving — sent 2 min ago").
    ...(alert ? { sosSentAt: alert.createdAt.toISOString(), sosKind: sosLabel(alert.kind) } : {}),
    // Plan your trip's stops when changing the route.
    maxStops: TRIP_MAX_STOPS,
  };
}

/** The latest time a ride for later may be booked for (ISO), or null for no limit beyond the usual 7 days. */
async function scheduleUntilFor(deps: RidePageRouteDeps, userId: string, now = Date.now()): Promise<string | null> {
  if (scheduledStartTemplate()) return null;
  const end = await whatsappWindowEnd(deps.redisClient, userId, now).catch(() => null);
  return new Date(end ?? now).toISOString();
}

/**
 * The last search ended with no driver: its price, and its trip (for "Search
 * again at ₦Y"). Null when the last search did not time out.
 */
async function lastSearchFor(deps: RidePageRouteDeps, userId: string) {
  const timedOut = await getSearchTimedOut(deps.redisClient, userId).catch(() => null);
  if (!timedOut) return null;
  const last = await getLastRoute(deps.redisClient, userId).catch(() => null);
  return {
    offerNgn: timedOut.offerNgn || last?.offerNgn || 0,
    route: last ? {
      pickupAddress: last.pickupAddress,
      destAddress: last.destAddress,
      distanceKm: last.distanceKm,
      durationMin: Math.ceil((last.durationSeconds ?? 0) / 60),
      suggestedFareNgn: last.suggestedFareNgn,
    } : null,
  };
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
  const body = await readJsonBody(req).catch(() => null);
  const amountNgn = amountIn(body);
  // Auto-accept only with the rider's yes (asked once, at Find): autoAccept: true. Anything else: off.
  const autoAccept = isRecord(body) && body.autoAccept === true;

  const quote = await getPendingRoute(deps.redisClient, userId);
  if (!quote) {
    // Already searching (a double tap, or they named a price in the chat)? Show that.
    if (await getActiveRide(deps.redisClient, userId)) return sendJson(res, 200, await buildState(deps, userId));
    throw new PageError('This quote has expired. Send your trip to the Wheelers bot again for a fresh one.', 409, 'QUOTE_EXPIRED');
  }
  await startSearch(deps, userId, quote, amountNgn, autoAccept);
  sendJson(res, 200, await buildState(deps, userId));
}

/** Drivers are asked: the search goes out at the rider's price (auto-accept only when they said yes). */
async function startSearch(deps: RidePageRouteDeps, userId: string, quote: PendingRouteData, amountNgn: number, autoAccept = false): Promise<void> {
  const user = await userClient.findById(userId);
  const phone = user?.phone ?? '';
  const result = await publishWhatsappRide(deps, { id: userId, phone }, quote, amountNgn);
  if (!result.ok) {
    if (result.code === 'BELOW_MINIMUM') {
      throw new PageError(`The lowest price for this trip is ₦${result.minOfferNgn.toLocaleString()}.`, 400, 'BELOW_MINIMUM', { minOfferNgn: result.minOfferNgn });
    }
    if (result.code === 'ALREADY_PUBLISHING') return;
    throw new PageError('Could not start the search just now. Please try again.', 503, 'PUBLISH_FAILED');
  }

  logActivity({ userId, eventType: 'ride_search_started', source: 'ride_page', rideId: result.rideId, metadata: { offerNgn: amountNgn } });
  await deps.notifyChat?.({
    kind: 'search_started', userId, phone, rideId: result.rideId, offerNgn: amountNgn,
    pickupAddress: quote.pickupAddress, destAddress: quote.destAddress,
    stopAddresses: (quote.stops ?? []).map((stop) => stop.address),
  }).catch((error) => console.warn(`${TAG} chat notice failed`, { error: error instanceof Error ? error.message : String(error) }));
  // The yes is for this price: nothing is booked above it.
  if (autoAccept) await autoAcceptOnAtStart(deps.redisClient, result.rideId, userId, amountNgn).catch(() => undefined);
}

/* ── POST /ride-page/auto-accept ──────────────────────────────────────── */

async function handleAutoAccept(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps): Promise<void> {
  const userId = authenticate(req, deps);
  await markRidePageSeen(deps.redisClient, userId).catch(() => undefined);
  const body = await readJsonBody(req).catch(() => null);
  if (!isRecord(body) || typeof body.on !== 'boolean') throw new PageError('Say on or off.', 400, 'BAD_REQUEST');
  const rideId = await getActiveRide(deps.redisClient, userId);
  if (!rideId) {
    if (!body.on) return sendJson(res, 200, await buildState(deps, userId));
    throw new PageError('This search has ended.', 409, 'NOT_SEARCHING');
  }
  // The price the rider was asked about (absent: the search's price now).
  const priceNgn = typeof body.priceNgn === 'number' && Number.isFinite(body.priceNgn) && body.priceNgn > 0 ? Math.round(body.priceNgn) : undefined;
  const result = await switchAutoAccept(deps, userId, rideId, body.on, priceNgn);
  if (!result.ok) throw new PageError(result.message, 409, 'NOT_SEARCHING');
  logActivity({ userId, eventType: result.on ? 'ride_auto_accept_switched_on' : 'ride_auto_accept_switched_off', source: 'ride_page', rideId, metadata: result.booked ? { booked: true } : {} });
  sendJson(res, 200, await buildState(deps, userId));
}

/* ── POST /ride-page/search-again ─────────────────────────────────────── */

/**
 * "No driver accepted ₦X" → the same trip again at the price the rider picks.
 * The trip is the one still being priced, or else the last one searched,
 * planned again so its price is today's (kept as it was when planning fails).
 */
async function handleSearchAgain(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps): Promise<void> {
  const userId = authenticate(req, deps);
  await markRidePageSeen(deps.redisClient, userId).catch(() => undefined);
  const body = await readJsonBody(req).catch(() => null);
  const amountNgn = amountIn(body);
  // The rider's yes to auto-booking, asked again at this Find (absent: off).
  const autoAccept = isRecord(body) && body.autoAccept === true;
  // Already searching (a double tap): show that.
  if (await getActiveRide(deps.redisClient, userId)) return sendJson(res, 200, await buildState(deps, userId));

  let quote = await getPendingRoute(deps.redisClient, userId);
  if (!quote) {
    const last = await getLastRoute(deps.redisClient, userId);
    if (!last) throw new PageError('This trip has expired. Plan it again.', 409, 'QUOTE_EXPIRED');
    const stops = last.stops ?? [];
    const planned = deps.routePlanner
      ? await deps.routePlanner.planRoute({
          origin: { lat: last.pickupLat, lng: last.pickupLng },
          destination: { lat: last.destLat, lng: last.destLng },
          ...(stops.length ? { stops } : {}),
        }).catch(() => null)
      : null;
    quote = {
      pickupLat: last.pickupLat, pickupLng: last.pickupLng, pickupAddress: last.pickupAddress,
      destLat: last.destLat, destLng: last.destLng, destAddress: last.destAddress,
      stops,
      distanceKm: planned?.distanceKm ?? last.distanceKm,
      durationSeconds: planned?.durationSeconds ?? last.durationSeconds,
      suggestedFareNgn: planned?.suggestedFareNgn ?? last.suggestedFareNgn,
      minOfferNgn: planned?.minOfferNgn ?? last.minOfferNgn,
      ratePerKmNgn: planned?.ratePerKmNgn ?? last.ratePerKmNgn,
      priceReason: planned ? planned.priceReason ?? null : last.priceReason ?? null,
      route: planned?.geometry ?? last.route,
      confirmed: true,
    };
    await storePendingRoute(deps.redisClient, userId, quote);
  }
  await startSearch(deps, userId, quote, amountNgn, autoAccept);
  logActivity({ userId, eventType: 'ride_search_again', source: 'ride_page', metadata: { offerNgn: amountNgn } });
  sendJson(res, 200, await buildState(deps, userId));
}

/* ── POST /ride-page/offer ────────────────────────────────────────────── */

async function handleOffer(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps): Promise<void> {
  const userId = authenticate(req, deps);
  await markRidePageSeen(deps.redisClient, userId).catch(() => undefined);
  const body = await readJsonBody(req).catch(() => null);
  const amountNgn = amountIn(body);
  // The rider's answer to "Auto-book a driver at ₦X?" for the new price, when asked (absent: not asked).
  const autoAccept = isRecord(body) && typeof body.autoAccept === 'boolean' ? body.autoAccept : undefined;
  const rideId = await getActiveRide(deps.redisClient, userId);
  if (!rideId) throw new PageError('This search has ended.', 409, 'RIDE_GONE');

  const result = await changeRiderOffer(deps, userId, rideId, amountNgn);
  if (!result.ok) {
    if (result.code === 'BELOW_MINIMUM') {
      throw new PageError(`The lowest price for this trip is ₦${result.minOfferNgn.toLocaleString()}.`, 400, 'BELOW_MINIMUM', { minOfferNgn: result.minOfferNgn });
    }
    throw new PageError('This search has ended.', 409, 'RIDE_GONE');
  }
  // A yes at the new price (a price above the last yes switches auto-accept off without one).
  if (autoAccept !== undefined) await switchAutoAccept(deps, userId, rideId, autoAccept, amountNgn).catch(() => undefined);
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
  ALREADY_CONFIRMING: { status: 409, message: 'Your ride is being booked — one moment.' },
  ALREADY_BOOKED: { status: 409, message: 'Your ride is already booked.' },
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
  // The price the page showed for this offer (optional; older pages send none): a driver who
  // changed it since is not booked at the new one.
  const shownNgn = isRecord(body) && typeof body.priceNgn === 'number' && Number.isFinite(body.priceNgn) ? body.priceNgn : undefined;
  const result = await confirmRideWithOffer(deps, userId, rideId, key, { method, xlm: deps.stellar ?? null, ...(shownNgn !== undefined ? { expectedFareNgn: shownNgn } : {}) });
  if (!result.ok) {
    if (result.code === 'XLM_SHORT') {
      throw new PageError(
        `This ride is ${result.amountXlm} XLM and you can spend ${result.spendableXlm} XLM. Pay in naira instead — your XLM has not moved.`,
        402, 'XLM_SHORT', { amountXlm: result.amountXlm, spendableXlm: result.spendableXlm },
      );
    }
    if (result.code === 'OFFER_CHANGED') {
      throw new PageError(`The price changed to ₦${result.fareNgn.toLocaleString()}. Check it and try again.`, 409, 'OFFER_CHANGED', { fareNgn: result.fareNgn });
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

/* ── POST /ride-page/keep-looking ─────────────────────────────────────── */

/**
 * Backed out of adding money for a driver: that driver is no longer theirs
 * to pay for. A deposit later does not book them, and auto-accept is free
 * again. The offer itself stays on the list.
 */
async function handleKeepLooking(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps): Promise<void> {
  const userId = authenticate(req, deps);
  await markRidePageSeen(deps.redisClient, userId).catch(() => undefined);
  // The offer they backed out of (optional; older pages send none): only that driver is let go.
  const body = await readJsonBody(req).catch(() => null);
  const key = isRecord(body) && typeof body.key === 'string' && body.key ? body.key : null;
  const rideId = await getActiveRide(deps.redisClient, userId);
  const paying = await getPendingAccept(deps.redisClient, userId).catch(() => null);
  const sameOffer = !key || (paying !== null && (paying.bidId === key || `driver:${paying.driverId}` === key));
  if (paying && sameOffer && (!rideId || paying.rideId === rideId)) {
    // Under the booking lock: a deposit landing and booking them right now is not raced.
    await whileNotConfirming(deps, paying.rideId, async () => {
      await clearPendingAccept(deps.redisClient, userId).catch(() => undefined);
    });
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
      await cancelOnPage(deps, rideId, () => cancelWhatsappRide(deps, userId, rideId, reason ?? 'Cancelled on the offers page'));
    });
    logActivity({ userId, eventType: 'ride_search_cancelled', source: 'ride_page', rideId, metadata: reason ? { reason } : {} });
    const user = await userClient.findById(userId);
    await deps.notifyChat?.({ kind: 'search_cancelled', userId, phone: user?.phone ?? '' }).catch(() => undefined);
  }
  sendJson(res, 200, await buildState(deps, userId));
}

/**
 * A cancel the rider made on the page: marked first (the chat says nothing of
 * it, and the page stops showing the ride), but only kept when the cancel
 * really went out. A cancel that failed leaves the ride as it was, on the page
 * and in the chat.
 */
async function cancelOnPage(deps: RidePageRouteDeps, rideId: string, cancel: () => Promise<unknown>): Promise<void> {
  await markCancelledOnPage(deps.redisClient, rideId).catch(() => undefined);
  try {
    await cancel();
  } catch (error) {
    await unmarkCancelledOnPage(deps.redisClient, rideId).catch(() => undefined);
    console.warn(`${TAG} cancel not sent`, { rideId, error: error instanceof Error ? error.message : String(error) });
    throw new PageError('Could not cancel just now. Please try again.', 503, 'CANCEL_FAILED');
  }
}

/**
 * Runs `work` holding the ride's confirming lock (the one confirmRideWithOffer
 * takes), so a search is never cancelled while a driver is being confirmed on
 * it: a deposit landing or an Accept in the chat in the same second.
 */
async function whileNotConfirming(deps: RidePageRouteDeps, rideId: string, work: () => Promise<void>): Promise<void> {
  const lock = await takeBookingLock(deps.redisClient, rideId);
  if (!lock) throw new PageError('A driver is being confirmed for this trip right now. Give it a moment.', 409, 'CONFIRMING');
  try {
    await work();
  } finally {
    await releaseBookingLock(deps.redisClient, lock);
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

/* ── GET /ride-page/suggest?q=&session=  ·  GET /ride-page/place?id=&session= ── */

/** Google's session token, made by the page for one search (typing, then the pick). */
const SESSION_TOKEN = /^[A-Za-z0-9_-]{8,64}$/;
const PLACE_ID = /^[A-Za-z0-9_-]{8,300}$/;

function sessionFrom(url: URL): string | undefined {
  const session = url.searchParams.get('session') ?? '';
  return SESSION_TOKEN.test(session) ? session : undefined;
}

/** The search box, as the app's: Google's suggestions for what is typed, inside Lagos. */
async function handleSuggest(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps, url: URL): Promise<void> {
  const userId = authenticate(req, deps);
  if (!deps.googleMapsApiKey) throw new PageError('Search is not available right now. Send your trip in the chat.', 503, 'EDIT_OFF');
  const query = (url.searchParams.get('q') ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (query.length < 2) return sendJson(res, 200, { places: [] });
  // Every lookup is billed by Google: plenty for typing, not for a script.
  if (await overLimit(deps.redisClient, `ride-page:suggest:${userId}`, 60, 60)) {
    throw new PageError('Too many searches at once. Wait a moment and try again.', 429, 'TOO_MANY');
  }
  const places = await suggestPlaces(deps.googleMapsApiKey, query, sessionFrom(url)).catch((error) => {
    console.warn(`${TAG} place suggestions failed`, { error: error instanceof Error ? error.message : String(error) });
    throw new PageError('Could not look that up. Try again.', 502, 'PLACES_FAILED');
  });
  sendJson(res, 200, { places });
}

/** A suggestion picked: where it is. Refused outside Lagos, as everywhere a trip is planned. */
async function handlePlace(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps, url: URL): Promise<void> {
  const userId = authenticate(req, deps);
  if (!deps.googleMapsApiKey) throw new PageError('Search is not available right now. Send your trip in the chat.', 503, 'EDIT_OFF');
  const placeId = url.searchParams.get('id') ?? '';
  if (!PLACE_ID.test(placeId)) throw new PageError('Pick a place from the list.', 400, 'PLACE_INVALID');
  if (await overLimit(deps.redisClient, `ride-page:place:${userId}`, 30, 60)) {
    throw new PageError('Too many searches at once. Wait a moment and try again.', 429, 'TOO_MANY');
  }
  const spot = await placeLocation(deps.googleMapsApiKey, placeId, sessionFrom(url)).catch((error) => {
    console.warn(`${TAG} place lookup failed`, { error: error instanceof Error ? error.message : String(error) });
    throw new PageError('Could not look that up. Try again.', 502, 'PLACES_FAILED');
  });
  if (!spot) throw new PageError('That place could not be found. Pick another.', 404, 'PLACE_NOT_FOUND');
  if (firstOutsideServiceArea([spot])) throw new PageError(OUTSIDE_SERVICE_AREA_LINE, 400, 'OUTSIDE_SERVICE_AREA');
  sendJson(res, 200, { place: spot });
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

  checkTrip(pickup, destination, stops);

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
      ratePerKmNgn: planned.ratePerKmNgn, priceReason: planned.priceReason ?? null,
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

/* ── rides for later ──────────────────────────────────────────────────── */

/** The pickup, destination and stops in a body: the same checks as the trip planned for now. */
function readTrip(body: Record<string, unknown>): { pickup: RouteStop; destination: RouteStop; stops: RouteStop[] } {
  const pickup = readPlace(body.pickup, 'pickup');
  const destination = readPlace(body.destination, 'destination');
  const stops = (Array.isArray(body.stops) ? body.stops : []).slice(0, MAX_CHAT_STOPS).map((stop, index) => readPlace(stop, `stop ${index + 1}`));
  checkTrip(pickup, destination, stops);
  return { pickup, destination, stops };
}

/** Another city, outside Lagos, or two places the same: refused in words (the chat's trip form says the same). */
function checkTrip(pickup: RouteStop, destination: RouteStop, stops: RouteStop[]): void {
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
}

/** The pickup time: the app's rules (POST /rides/scheduled), refused in its words. */
function readScheduledFor(body: Record<string, unknown>): Date {
  try {
    return parseScheduledFor(body.scheduledFor);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    throw new PageError(/at least|up to 7 days/.test(message) ? message : 'Choose a pickup time.', 400, 'TIME_INVALID');
  }
}

/** A ride for later, as the page lists it. */
function scheduledItem(ride: { id: string; status: string; scheduledFor: Date; pickupAddress: string; destAddress: string; stops: unknown; fareEstimateNgn: unknown }) {
  const stops = Array.isArray(ride.stops) ? ride.stops : [];
  return {
    id: ride.id,
    status: ride.status,
    scheduledFor: ride.scheduledFor.toISOString(),
    pickupAddress: ride.pickupAddress,
    destAddress: ride.destAddress,
    stopAddresses: stops.map((stop) => (isRecord(stop) && typeof stop.address === 'string' ? stop.address : '')).filter(Boolean),
    fareNgn: ride.fareEstimateNgn == null ? null : Math.round(Number(ride.fareEstimateNgn)),
  };
}

async function scheduledList(userId: string) {
  return (await scheduledRideClient.findByRider(userId, 20)).map(scheduledItem);
}

function schedulingOn(deps: RidePageRouteDeps): { scheduling: NonNullable<RidePageRouteDeps['scheduling']>; routePlanner: NonNullable<RidePageRouteDeps['routePlanner']> } {
  if (!deps.scheduling || !deps.routePlanner) throw new PageError('Rides for later are not available right now.', 503, 'SCHEDULE_OFF');
  return { scheduling: deps.scheduling, routePlanner: deps.routePlanner };
}

/** Each is a paid Google route: plenty for a rider, not for a script. */
async function scheduleLimit(deps: RidePageRouteDeps, userId: string): Promise<void> {
  if (await overLimit(deps.redisClient, `ride-page:schedule:${userId}`, 15, 60)) {
    throw new PageError('Too many changes at once. Wait a moment and try again.', 429, 'TOO_MANY');
  }
}

/** POST /ride-page/schedule/quote: the trip for later, planned and priced. Nothing is kept. */
async function handleScheduleQuote(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps): Promise<void> {
  const userId = authenticate(req, deps);
  const { routePlanner } = schedulingOn(deps);
  const body = await readJsonBody(req).catch(() => null);
  if (!isRecord(body)) throw new PageError('Pick the pickup and the destination.', 400, 'BAD_REQUEST');
  const scheduledFor = readScheduledFor(body);
  const { pickup, destination, stops } = readTrip(body);
  await scheduleLimit(deps, userId);
  const planned = await routePlanner.planRoute({ origin: pickup, destination, ...(stops.length ? { stops } : {}) }).catch(() => null);
  if (!planned) throw new PageError('We could not find a driving route through those places. Check them and try again.', 422, 'NO_ROUTE');
  sendJson(res, 200, {
    scheduledFor: scheduledFor.toISOString(),
    route: {
      pickupAddress: pickup.address,
      destAddress: destination.address,
      stopAddresses: stops.map((stop) => stop.address),
      distanceKm: planned.distanceKm,
      durationMin: Math.ceil(planned.durationSeconds / 60),
      suggestedFareNgn: planned.suggestedFareNgn,
    },
  });
}

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * POST /ride-page/schedule: book the ride for later, as the app's POST
 * /rides/scheduled does (the same time rules, the same planned price, the same
 * job for the scheduler), marked WHATSAPP: when its search starts it is a
 * WhatsApp search, on the page and in the chat. A double tap books once.
 */
async function handleSchedule(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps): Promise<void> {
  const userId = authenticate(req, deps);
  const { scheduling, routePlanner } = schedulingOn(deps);
  const body = await readJsonBody(req).catch(() => null);
  if (!isRecord(body)) throw new PageError('Pick the pickup and the destination.', 400, 'BAD_REQUEST');
  const scheduledFor = readScheduledFor(body);
  const { pickup, destination, stops } = readTrip(body);
  const requestId = typeof body.requestId === 'string' && REQUEST_ID.test(body.requestId) ? body.requestId : null;
  const onceKey = requestId ? `ride-page:schedule:${userId}:${requestId}` : null;
  if (onceKey && await deps.redisClient.get(onceKey).catch(() => null)) {
    return sendJson(res, 200, { item: null, scheduled: await scheduledList(userId) });
  }
  // Its start is said in WhatsApp: inside the rider's 24 h window, unless the start template is set.
  const until = await scheduleUntilFor(deps, userId);
  if (until !== null && scheduledFor.getTime() > Date.parse(until)) {
    throw new PageError(Date.parse(until) - Date.now() > SCHEDULE_MIN_AHEAD_MS
      ? `Pick a time before ${lagosTime(new Date(until))}.`
      : 'Send any message in WhatsApp, then pick a time.', 400, 'SCHEDULE_OUTSIDE_WINDOW', { scheduleUntil: until });
  }
  await scheduleLimit(deps, userId);
  // One booking at a time per rider: the limits below are checked and the ride written together.
  const lockKey = `ride-page:schedule-lock:${userId}`;
  if (!(await deps.redisClient.setIfNotExists(lockKey, '1', 30).catch(() => true))) {
    throw new PageError('Too many changes at once. Wait a moment and try again.', 429, 'TOO_MANY');
  }
  try {
    await bookScheduled();
  } finally {
    await deps.redisClient.del(lockKey).catch(() => undefined);
  }

  async function bookScheduled(): Promise<void> {
    const waiting = await scheduledRideClient.findByRider(userId, 20);
    if (waiting.length >= MAX_WAITING_SCHEDULED) {
      throw new PageError(`You can book up to ${MAX_WAITING_SCHEDULED} rides ahead.`, 409, 'SCHEDULE_LIMIT', { scheduled: waiting.map(scheduledItem) });
    }
    if (waiting.some((ride) => Math.abs(ride.scheduledFor.getTime() - scheduledFor.getTime()) < SCHEDULE_GAP_MS)) {
      throw new PageError('You have a ride within 30 minutes of that time.', 409, 'SCHEDULE_TOO_CLOSE', { scheduled: waiting.map(scheduledItem) });
    }
    const planned = await routePlanner.planRoute({ origin: pickup, destination, ...(stops.length ? { stops } : {}) }).catch(() => null);
    if (!planned) throw new PageError('We could not find a driving route through those places. Check them and try again.', 422, 'NO_ROUTE');
    // Taken just before the ride is written: a second tap in the same moment books nothing.
    if (onceKey && !(await deps.redisClient.setIfNotExists(onceKey, '1', 10 * 60).catch(() => true))) {
      return sendJson(res, 200, { item: null, scheduled: await scheduledList(userId) });
    }

    const ride = await scheduledRideClient.create({
      riderId: userId,
      scheduledFor,
      paymentMethod: 'WALLET_BALANCE',
      pickupLat: pickup.lat, pickupLng: pickup.lng, pickupAddress: pickup.address,
      destLat: destination.lat, destLng: destination.lng, destAddress: destination.address,
      stops,
      plannedDistanceKm: planned.distanceKm,
      plannedDurationSeconds: planned.durationSeconds,
      fareEstimateNgn: planned.suggestedFareNgn,
      channel: 'WHATSAPP',
    }).catch(async (error) => {
      if (onceKey) await deps.redisClient.del(onceKey).catch(() => undefined);
      throw error;
    });

    // The scheduler's job, as the app's; a lost one is caught by its recovery scan.
    const delay = Math.max(0, ride.scheduledFor.getTime() - scheduling.leadTimeMs - Date.now());
    await Promise.resolve()
      .then(() => scheduling.dispatcherQueue.add('dispatch', { scheduledRideId: ride.id, scheduledFor: ride.scheduledFor.toISOString() }, { delay, jobId: buildScheduledRideJobId(ride.id) }))
      .catch((error) => console.warn(`${TAG} scheduler job not queued (the recovery scan will catch it)`, { scheduledRideId: ride.id, error: error instanceof Error ? error.message : String(error) }));

    logActivity({ userId, eventType: 'scheduled_ride_created', source: 'ride_page', metadata: { scheduledRideId: ride.id, stops: stops.length } });
    sendJson(res, 201, { item: scheduledItem(ride), scheduled: await scheduledList(userId) });
  }
}

/** At most this many rides for later waiting per rider (app and page together). */
const MAX_WAITING_SCHEDULED = 5;
/** Two rides for later this close together cannot both be kept. */
const SCHEDULE_GAP_MS = 30 * 60_000;
/** The app's rule: a pickup at least 10 minutes away (parseScheduledFor). */
const SCHEDULE_MIN_AHEAD_MS = 10 * 60_000;

/** "3:30 PM", Lagos time. */
function lagosTime(at: Date): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Africa/Lagos' }).format(at);
}

/** GET /ride-page/scheduled: the rider's rides for later still waiting. */
async function handleScheduledList(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps): Promise<void> {
  const userId = authenticate(req, deps);
  sendJson(res, 200, { scheduled: await scheduledList(userId) });
}

const SCHEDULED_CANCEL = /^\/ride-page\/scheduled\/([0-9a-fA-F-]{36})\/cancel$/;

/** POST /ride-page/scheduled/:id/cancel: only the rider's own, only while it waits. */
async function handleScheduledCancel(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps, url: URL): Promise<void> {
  const userId = authenticate(req, deps);
  const id = SCHEDULED_CANCEL.exec(url.pathname)?.[1] ?? '';
  const result = await scheduledRideClient.cancel(id, userId, 'rider_cancelled_schedule');
  if (result.count === 0) throw new PageError('This ride has already started or ended.', 404, 'SCHEDULED_GONE', { scheduled: await scheduledList(userId) });
  await referralClient.releaseRideCashback(id).catch(() => undefined);
  await Promise.resolve()
    .then(() => deps.scheduling?.dispatcherQueue.remove(buildScheduledRideJobId(id)))
    .catch((error) => console.warn(`${TAG} scheduler job not removed`, { scheduledRideId: id, error: error instanceof Error ? error.message : String(error) }));
  logActivity({ userId, eventType: 'scheduled_ride_cancelled', source: 'ride_page', metadata: { scheduledRideId: id } });
  sendJson(res, 200, { cancelled: true, scheduled: await scheduledList(userId) });
}

/* ── a booked trip: cancel it, change where it goes, the Emergency button ── */

/** The page acts for the rider as the app does: the same handler, with the rider as the sender. */
function riderAuth(userId: string): GatewayAuthContext {
  return { userId, privyDid: '', role: 'RIDER' };
}

/** The rider's booked trip (a driver assigned, on the way, outside or driving), from the database. */
async function bookedTrip(deps: RidePageRouteDeps, userId: string) {
  const active = await rideClient.findActiveByRider(userId).catch(() => null);
  if (active && active.driverId && TRIP_STATUSES.includes(active.status) && !(await wasCancelledOnPage(deps.redisClient, active.id))) return active;
  // A driver being confirmed this second: not booked yet, not over either.
  const pointer = await getActiveRide(deps.redisClient, userId).catch(() => null);
  const state = pointer ? await getRideState(deps.redisClient, pointer).catch(() => null) : null;
  if (state === 'confirmed' || state === 'in_progress') {
    throw new PageError('Your driver is being confirmed. Give it a moment.', 409, 'CONFIRMING');
  }
  throw new PageError('This trip has ended.', 409, 'NO_TRIP');
}

/**
 * POST /ride-page/cancel-ride: the app's "Cancel this ride?" once a driver is
 * booked — its reasons, and its ride:cancel exactly (the refund, any fee and the
 * driver being told all follow from it). The chat says nothing: they did it here.
 */
async function handleCancelRide(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps): Promise<void> {
  const userId = authenticate(req, deps);
  await markRidePageSeen(deps.redisClient, userId).catch(() => undefined);
  const body = await readJsonBody(req).catch(() => null);
  const picked = isRecord(body) && typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!(RIDE_CANCEL_REASONS as readonly string[]).includes(picked)) throw new PageError('Pick why you are cancelling.', 400, 'REASON_INVALID');
  // As the app sends it: their own words for "Other reason" when they wrote some.
  const words = picked === OTHER_REASON && isRecord(body) && typeof body.detail === 'string' ? body.detail.replace(/\s+/g, ' ').trim().slice(0, OWN_WORDS_MAX) : '';
  const reason = words || picked;

  const ride = await bookedTrip(deps, userId);
  await cancelOnPage(deps, ride.id, () => handleRideMessage('ride:cancel', { rideId: ride.id, driverId: ride.driverId, reason }, riderAuth(userId), deps.publisher, deps.routePlanner as never, deps.redisClient));
  await clearActiveRideIfMatches(deps.redisClient, userId, ride.id).catch(() => false);
  await clearPendingAccept(deps.redisClient, userId).catch(() => undefined);
  logActivity({ userId, eventType: 'ride_cancelled', source: 'ride_page', rideId: ride.id, metadata: { reason, status: ride.status } });
  sendJson(res, 200, await buildState(deps, userId));
}

/** A booked trip's new route from the page: { destination?, stops } (destination omitted: where it goes now). */
async function readTripRoute(deps: RidePageRouteDeps, userId: string, body: unknown) {
  if (!isRecord(body)) throw new PageError('Pick where you are going.', 400, 'BAD_REQUEST');
  if (!deps.routePlanner) throw new PageError('Changing the route is not available right now.', 503, 'UNAVAILABLE');
  const ride = await bookedTrip(deps, userId);
  // Each look is a paid Google route: plenty for a rider, not for a script.
  if (await overLimit(deps.redisClient, `ride-page:trip-route:${userId}`, 10, 60)) {
    throw new PageError('Too many changes at once. Wait a moment and try again.', 429, 'TOO_MANY');
  }
  const trip = await rideClient.findWithDriver(ride.id).catch(() => null);
  const finalStop = trip?.routeStops.find((stop) => stop.type === 'FINAL');
  const destination = body.destination !== undefined && body.destination !== null
    ? readPlace(body.destination, 'destination')
    : finalStop ? { lat: finalStop.lat, lng: finalStop.lng, address: finalStop.address } : { lat: ride.destLat, lng: ride.destLng, address: ride.destAddress };
  // As many stops as the app allows on a trip (one booked in the app with 5 is never cut short).
  const stops = (Array.isArray(body.stops) ? body.stops : []).slice(0, TRIP_MAX_STOPS).map((stop, index) => readPlace(stop, `stop ${index + 1}`));
  if (firstOutsideServiceArea([destination, ...stops])) throw new PageError(OUTSIDE_SERVICE_AREA_LINE, 400, 'OUTSIDE_SERVICE_AREA');
  return { ride, destination, stops };
}

/**
 * POST /ride-page/trip-route/quote: what the new route would cost, before
 * anything moves — { fareNgn, extraNgn }, extraNgn being how much more the
 * wallet would hold for it (negative: that much goes back). The page asks
 * "₦X more will be held" with it, then sends the change with acceptedFareNgn.
 */
async function handleTripRouteQuote(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps): Promise<void> {
  const userId = authenticate(req, deps);
  await markRidePageSeen(deps.redisClient, userId).catch(() => undefined);
  const { ride, destination, stops } = await readTripRoute(deps, userId, await readJsonBody(req).catch(() => null));
  const quote = await quoteTripRoute({ redis: deps.redisClient, routePlanner: deps.routePlanner! }, ride.id, destination, stops).catch((error) => {
    console.warn(`${TAG} route not priced`, { rideId: ride.id, error: error instanceof Error ? error.message : String(error) });
    throw new PageError('Could not price that route just now. Please try again.', 503, 'QUOTE_FAILED');
  });
  sendJson(res, 200, { fareNgn: quote.fareNgn, extraNgn: quote.extraNgn });
}

/**
 * POST /ride-page/trip-route: add, change or remove stops (and the destination)
 * on a booked trip — the app's ride:route:update exactly (the driver is told),
 * at the price the rider was shown: acceptedFareNgn must be the quote's fareNgn
 * (else 409 PRICE_CHANGED with the price now), and the wallet holds exactly it.
 */
async function handleTripRoute(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps): Promise<void> {
  const userId = authenticate(req, deps);
  await markRidePageSeen(deps.redisClient, userId).catch(() => undefined);
  const body = await readJsonBody(req).catch(() => null);
  const { ride, destination, stops } = await readTripRoute(deps, userId, body);
  const accepted = isRecord(body) && typeof body.acceptedFareNgn === 'number' && Number.isFinite(body.acceptedFareNgn) ? body.acceptedFareNgn : null;
  if (accepted === null) {
    // Never moved without the rider seeing the price: the price, to ask about.
    const quote = await quoteTripRoute({ redis: deps.redisClient, routePlanner: deps.routePlanner! }, ride.id, destination, stops);
    throw new PageError(`The price is now ₦${quote.fareNgn.toLocaleString()}.`, 409, 'PRICE_CHANGED', { fareNgn: quote.fareNgn, extraNgn: quote.extraNgn });
  }
  let reply;
  try {
    reply = await handleRideMessage('ride:route:update', { rideId: ride.id, driverId: ride.driverId, destination, stops, acceptedFareNgn: accepted }, riderAuth(userId), deps.publisher, deps.routePlanner as never, deps.redisClient);
  } catch (error) {
    if (refusalCode(error) === 'OUTSIDE_SERVICE_AREA') throw new PageError(OUTSIDE_SERVICE_AREA_LINE, 400, 'OUTSIDE_SERVICE_AREA');
    throw error;
  }
  if (reply?.type === 'ride:route:update:rejected') {
    const fareNgn = Number(reply.payload['fareNgn']);
    throw new PageError(`The price is now ₦${fareNgn.toLocaleString()}.`, 409, 'PRICE_CHANGED', { fareNgn, extraNgn: reply.payload['extraNgn'] });
  }
  // The road drawn on the trip is the new one from now (the ride service saves the stops a moment later).
  const line = (reply?.payload['route'] as { coordinates?: Array<{ lat: number; lng: number }> } | undefined)?.coordinates;
  if (Array.isArray(line) && line.length) await storeTripLine(deps.redisClient, ride.id, line).catch(() => undefined);
  logActivity({ userId, eventType: 'ride_route_changed', source: 'ride_page', rideId: ride.id, metadata: { stops: stops.length, fareNgn: accepted } });
  sendJson(res, 200, await buildState(deps, userId));
}

/**
 * POST /ride-page/sos { kind? }: the Emergency button — the same alert as the
 * ride card's SOS, of the kind the rider picked (the app's choices: its label
 * or its code; absent or unknown: "I need help now").
 */
async function handleSos(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps): Promise<void> {
  const userId = authenticate(req, deps);
  const body = await readJsonBody(req).catch(() => null);
  const asked = isRecord(body) && typeof body.kind === 'string' ? body.kind.trim() : '';
  const kind = SOS_KINDS.find((k) => k.kind === asked || k.label.toLowerCase() === asked.toLowerCase())?.kind ?? 'SOS';
  const { alreadyOpen } = await raiseRiderSos(userId, 'ride_page', kind);
  logActivity({ userId, eventType: 'safety_alert_raised', source: 'ride_page', metadata: { alreadyOpen, kind } });
  sendJson(res, 200, { ok: true, alreadyOpen });
}

/** POST /ride-page/sos/cancel: "I'm safe" — the rider's own open alert is withdrawn. */
async function handleSosCancel(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps): Promise<void> {
  const userId = authenticate(req, deps);
  const withdrawn = await cancelRiderSos(userId, 'ride_page');
  sendJson(res, 200, { ok: true, withdrawn });
}

/* ── GET /ride-page/open/:code ────────────────────────────────────────── */

/**
 * The start template's button (Meta appends a variable to a fixed address): a
 * random one-time code, never the link itself (a path ends up in logs). It is
 * spent here, and the rider goes on to the page with a fresh link in the
 * fragment (never sent to a server again). A spent or unknown code: the page,
 * which says the link has expired and how to get a new one.
 */
const OPEN_PAGE = /^\/ride-page\/open\/([A-Za-z0-9_-]{16,64})$/;

async function handleOpen(res: ServerResponse, deps: RidePageRouteDeps, url: URL): Promise<void> {
  const code = OPEN_PAGE.exec(url.pathname)?.[1];
  const userId = code ? await takeRidePageOpenCode(deps.redisClient, code).catch(() => null) : null;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!code) {
    res.statusCode = 404;
    res.setHeader('location', '/widget/ride/ride.html');
    res.end();
    return;
  }
  res.statusCode = 302;
  const token = userId ? createWalletPageToken(userId, 'ride', deps.jwtSecret, RIDE_PAGE_TOKEN_TTL_SECONDS) : null;
  res.setHeader('location', token ? `/widget/ride/ride.html#t=${token}` : '/widget/ride/ride.html#expired=1');
  res.end();
}

/* ── POST /ride-page/notice/seen ──────────────────────────────────────── */

/** Home's one line (state.notice) was seen: { id }. Answers the state, without it. */
async function handleNoticeSeen(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps): Promise<void> {
  const userId = authenticate(req, deps);
  await markRidePageSeen(deps.redisClient, userId).catch(() => undefined);
  const body = await readJsonBody(req).catch(() => null);
  const id = isRecord(body) && typeof body.id === 'string' ? body.id : '';
  if (id) await clearPageNotice(deps.redisClient, userId, id).catch(() => false);
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
    await cancelOnPage(deps, rideId, () => cancelWhatsappRide(deps, userId, rideId, 'Changed the trip on the offers page'));
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
  'auto_accept_switched', 'track_driver_tapped',
  'stop_added', 'schedule_opened', 'schedule_saved', 'schedule_failed', 'scheduled_cancelled',
  'saved_place_saved', 'saved_place_removed', 'link_expired_shown',
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
  '/ride-page/auto-accept': { method: 'POST', run: handleAutoAccept },
  '/ride-page/search-again': { method: 'POST', run: handleSearchAgain },
  '/ride-page/offer': { method: 'POST', run: handleOffer },
  '/ride-page/accept': { method: 'POST', run: handleAccept },
  '/ride-page/decline': { method: 'POST', run: handleDecline },
  '/ride-page/keep-looking': { method: 'POST', run: handleKeepLooking },
  '/ride-page/decline-all': { method: 'POST', run: handleDeclineAll },
  '/ride-page/cancel': { method: 'POST', run: handleCancel },
  '/ride-page/places': { method: 'GET', run: handlePlaces },
  '/ride-page/suggest': { method: 'GET', run: handleSuggest },
  '/ride-page/place': { method: 'GET', run: handlePlace },
  '/ride-page/schedule/quote': { method: 'POST', run: handleScheduleQuote },
  '/ride-page/schedule': { method: 'POST', run: handleSchedule },
  '/ride-page/scheduled': { method: 'GET', run: handleScheduledList },
  '/ride-page/route': { method: 'POST', run: handleRoute },
  '/ride-page/where': { method: 'GET', run: handleWhere },
  '/ride-page/edit-trip': { method: 'POST', run: handleEditTrip },
  '/ride-page/events': { method: 'POST', run: handleEvents },
  '/ride-page/topup': { method: 'GET', run: handleTopup },
  '/ride-page/cancel-ride': { method: 'POST', run: handleCancelRide },
  '/ride-page/trip-route': { method: 'POST', run: handleTripRoute },
  '/ride-page/trip-route/quote': { method: 'POST', run: handleTripRouteQuote },
  '/ride-page/notice/seen': { method: 'POST', run: handleNoticeSeen },
  '/ride-page/sos': { method: 'POST', run: handleSos },
  '/ride-page/sos/cancel': { method: 'POST', run: handleSosCancel },
};

/** Every /ride-page/* request. Returns false when the path is not ours. */
export async function handleRidePageRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RidePageRouteDeps,
  url: URL,
): Promise<boolean> {
  if (url.pathname.startsWith('/ride-page/open/')) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }
    await handleOpen(res, deps, url);
    return true;
  }
  const route = ROUTES[url.pathname] ?? (SCHEDULED_CANCEL.test(url.pathname) ? { method: 'POST' as const, run: handleScheduledCancel } : undefined);
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
