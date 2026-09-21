import type { IncomingMessage, ServerResponse } from 'http';
import { rideClient, userClient, virtualAccountClient, walletClient } from '@wheleers/db';
import { depositNeededFor, validateRiderOffer } from '@wheleers/config';
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
import {
  getAcceptedBid,
  getActiveRide,
  getBids,
  getPendingRoute,
  getRideMeta,
  getRideState,
  markRidePageSeen,
  storeLastBatch,
} from '../whatsapp-flows/bid-state';
import {
  cancelWhatsappRide,
  changeRiderOffer,
  confirmRideWithOffer,
  offerKey,
  publishWhatsappRide,
  type ConfirmedRide,
} from '../rides/whatsapp-ride.service';

/**
 * The bidding page a WhatsApp rider opens from the chat.
 *
 *   GET  /ride-page/state     where the booking is, and every offer on the table
 *   POST /ride-page/find      { amountNgn }  name a price → drivers are asked
 *   POST /ride-page/offer     { amountNgn }  change the bid
 *   POST /ride-page/accept    { key }        take one driver's offer (holds the fare)
 *   POST /ride-page/cancel                   stop the search
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
  /** Tells the chat what happened on the page (search started, ride confirmed). Absent in tests. */
  notifyChat?: (event: RidePageChatEvent) => Promise<void>;
}

export type RidePageChatEvent =
  | { kind: 'search_started'; userId: string; phone: string; rideId: string; offerNgn: number; pickupAddress: string; destAddress: string }
  | { kind: 'ride_confirmed'; userId: string; phone: string; ride: ConfirmedRide }
  | { kind: 'search_cancelled'; userId: string; phone: string };

class PageError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

function authenticate(req: IncomingMessage, deps: RidePageRouteDeps): string {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) throw new PageError('This link is not valid. Ask the Wheelers bot for a new one.', 401, 'LINK_INVALID');
  let session;
  try {
    session = verifyWalletPageToken(token, deps.jwtSecret);
  } catch {
    throw new PageError('This link has expired. Send any message to the Wheelers bot for a new one.', 401, 'LINK_EXPIRED');
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

async function buildState(deps: RidePageRouteDeps, userId: string) {
  const [rideId, balanceNgn, trip] = await Promise.all([getActiveRide(deps.redisClient, userId), balanceOf(userId), liveTripFor(userId)]);

  // A driver is assigned: this is the tracking page now.
  if (trip) {
    return {
      phase: 'confirmed' as const, rideId: trip.rideId, balanceNgn, route: trip.route, offerNgn: trip.fareNgn,
      driver: {
        name: trip.driver.name, phone: trip.driver.phone, rating: trip.driver.rating, totalRides: trip.driver.totalRides,
        vehicle: trip.driver.vehicle, plate: trip.driver.plate, etaMin: trip.etaMin, fareNgn: trip.fareNgn,
      },
      trip: {
        status: trip.status,
        pickup: trip.pickup,
        destination: trip.destination,
        driverPosition: trip.driver.position,
        positionAgeSeconds: trip.driver.positionAgeSeconds,
        positionFresh: trip.driver.positionFresh,
        etaMin: trip.etaMin,
        map: trip.map,
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

      // What the page shows is what "accept 1" in the chat must mean too.
      await storeLastBatch(deps.redisClient, rideId, bids).catch(() => undefined);
      return {
        phase: 'offers' as const, rideId, balanceNgn, route, offerNgn: meta.offerNgn,
        minOfferNgn: validateRiderOffer(0, meta.suggestedFareNgn).minOfferNgn,
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
        distanceKm: quote.distanceKm,
        durationMin: Math.ceil(quote.durationSeconds / 60),
        suggestedFareNgn: quote.suggestedFareNgn,
      },
      minOfferNgn: quote.minOfferNgn,
    };
  }

  // No quote and no live search: it expired, was cancelled, or the trip ended.
  return { phase: 'idle' as const, balanceNgn };
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
  DRIVER_TAKEN: { status: 409, message: 'Another rider is confirming that driver right now. Pick another offer.' },
  HOLD_FAILED: { status: 503, message: 'Could not hold the fare in your wallet. Please try again.' },
  CONFIRM_FAILED: { status: 503, message: 'Could not confirm just now — your money is held safely. Tap Accept again.' },
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

  const result = await confirmRideWithOffer(deps, userId, rideId, key);
  if (!result.ok) {
    if (result.code === 'WALLET_SHORT') {
      // Not an error to apologise for — the page turns this into "Send ₦X".
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

/* ── POST /ride-page/cancel ───────────────────────────────────────────── */

async function handleCancel(req: IncomingMessage, res: ServerResponse, deps: RidePageRouteDeps): Promise<void> {
  const userId = authenticate(req, deps);
  const rideId = await getActiveRide(deps.redisClient, userId);
  if (rideId) {
    const state = await getRideState(deps.redisClient, rideId);
    if (state === 'confirmed' || state === 'in_progress') {
      // A driver is on the way: that cancellation has reasons and may carry a fee. The chat handles it.
      throw new PageError('Your driver is already confirmed. To cancel this trip, reply "cancel" in the chat.', 409, 'ALREADY_CONFIRMED');
    }
    await cancelWhatsappRide(deps, userId, rideId, 'Cancelled on the offers page');
    logActivity({ userId, eventType: 'ride_search_cancelled', source: 'ride_page', rideId, metadata: {} });
    const user = await userClient.findById(userId);
    await deps.notifyChat?.({ kind: 'search_cancelled', userId, phone: user?.phone ?? '' }).catch(() => undefined);
  }
  sendJson(res, 200, await buildState(deps, userId));
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
  '/ride-page/cancel': { method: 'POST', run: handleCancel },
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
