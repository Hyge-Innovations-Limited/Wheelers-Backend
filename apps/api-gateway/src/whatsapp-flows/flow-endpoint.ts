import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { GoogleMapsRoutePlanner, validateRiderOffer } from '@wheleers/config';
import { walletClient, virtualAccountClient, driverClient, rideClient } from '@wheleers/db';
import { RideOfferAcceptedEvent, RideRequestedEvent, RideRiderCounterOfferEvent } from '@wheleers/kafka-schemas';
import type { GatewayPublisher } from '../websocket/publisher';
import type { RedisClient } from '../redis/client';
import { readRawBody, sendJson } from '../http/utils';
import { decryptFlowRequest, encryptFlowResponse, verifyFlowToken } from './encryption';
import { sendFlowOffersMessage } from './whatsapp-notifier';
import { META_FLOWS_ENABLED } from './flow-toggle';
import { handleEditTripFlow, type EditTripFlowDeps } from './edit-trip-flow';
import type { WhatsappNotifierDeps } from './whatsapp-notifier';
import type { DecryptedFlowRequest } from './encryption';
import type { FlowRequestBody } from './encryption';
import { geocodeAddress } from '../LLM/geocoding';
import {
  getBids,
  getRideMeta,
  getRideState,
  setRideState,
  getActiveRide,
  setActiveRide,
  clearActiveRide,
  storeWhatsappRide,
  getPendingLocation,
  storeFlowEstimate,
  getFlowEstimate,
  clearFlowEstimate,
  storeFlowPendingAccept,
  getFlowPendingAccept,
  clearFlowPendingAccept,
  clearPendingLocation,
  clearBids,
  removeBid,
  lookupPhoneByUserId,
  storeAcceptedBid,
  getAcceptedBid,
} from './bid-state';
import type { FlowEstimate, WhatsappBid } from './bid-state';
import {
  buildBidListData,
  buildConfirmationData,
  buildDriverProfileData,
  buildPaymentData,
  buildErrorData,
  buildRideSetupData,
  buildFareConfirmData,
  buildTopUpData,
  buildNotifyExitData,
} from './flow-screens';
import type { DriverKycStorage } from '../storage/driver-kyc-storage';

export interface WhatsappFlowEndpointDeps {
  redisClient: RedisClient;
  publisher: GatewayPublisher;
  privateKeyPem: string;
  tokenSecret: string;
  googleMapsApiKey: string;
  routePlanner: GoogleMapsRoutePlanner;
  kycStorage?: DriverKycStorage;
  /** When set, Find Drivers drops a 'Check offers' re-entry button in chat. */
  notifier?: WhatsappNotifierDeps;
  /** The trip was confirmed in the Edit-trip form: send the price step to the rider's chat. */
  onTripConfirmed?: EditTripFlowDeps['onTripConfirmed'];
}

const POLL_INTERVAL_MS = 1_000;
const POLL_MAX_MS = 4_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollForBids(
  redis: RedisClient,
  rideId: string,
  knownCount: number,
  maxMs: number = POLL_MAX_MS,
): Promise<WhatsappBid[]> {
  const deadline = Date.now() + maxMs;

  while (Date.now() < deadline) {
    const bids = await getBids(redis, rideId);
    if (bids.length > knownCount) return bids;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return bids;
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }

  return getBids(redis, rideId);
}

function parseFlowToken(flowToken: string, secret: string): { rideId: string; userId: string } | null {
  const payload = verifyFlowToken(flowToken, secret);
  if (!payload) return null;
  const parts = payload.split(':');
  if (parts.length < 2) return null;
  return { rideId: parts[0], userId: parts[1] };
}

// ── Fetch wallet + virtual account for confirmation screen ────────────────

async function getWalletInfo(userId: string) {
  const [wallet, virtualAccount] = await Promise.all([
    walletClient.findByUserId(userId).catch(() => null),
    virtualAccountClient.findByUserId(userId).catch(() => null),
  ]);

  return {
    walletBalanceNgn: wallet ? Number(wallet.balanceNgn) : 0,
    virtualAccount: virtualAccount ? {
      bankName: virtualAccount.bankName,
      accountNumber: virtualAccount.accountNumber,
      accountName: virtualAccount.accountName,
    } : null,
  };
}

// ── State-based screen router ──────────────────────────────────────────────

async function resolveScreen(
  rideId: string,
  userId: string,
  deps: WhatsappFlowEndpointDeps,
): Promise<{ screen: string; data: Record<string, unknown> }> {
  const state = await getRideState(deps.redisClient, rideId);
  const meta = await getRideMeta(deps.redisClient, rideId);

  if (!meta) {
    return { screen: 'SUCCESS', data: buildErrorData('This ride request has expired. Send a new message to book a ride.') };
  }

  if (state === 'confirmed') {
    // Find the accepted bid to show driver info
    const bids = await getBids(deps.redisClient, rideId);
    const acceptedBid = bids[0];
    return {
      screen: 'RIDE_CONFIRMED',
      data: buildConfirmationData({
        driverName: acceptedBid?.driverName ?? 'Your driver',
        vehicleModel: acceptedBid?.vehicleModel ?? 'their vehicle',
        vehiclePlate: acceptedBid?.vehiclePlate ?? '',
        etaSeconds: acceptedBid?.etaSeconds ?? 0,
        fareNgn: acceptedBid?.counterOfferNgn ?? meta.offerNgn,
        driverRating: acceptedBid?.driverRating ?? 0,
      }),
    };
  }

  // Check for bids — poll briefly if none exist yet
  let bids = await getBids(deps.redisClient, rideId);

  if (bids.length === 0 && state === 'searching') {
    bids = await pollForBids(deps.redisClient, rideId, 0);
  }

  if (bids.length > 0) {
    if (state === 'searching') {
      await setRideState(deps.redisClient, rideId, 'bidding');
    }
    return { screen: 'BID_LIST', data: buildBidListData(meta, bids) };
  }

  // No bids yet — tell rider we'll notify them
  return {
    screen: 'SUCCESS',
    data: buildNotifyExitData("We're looking for drivers! You'll get a notification as soon as someone is interested."),
  };
}

// ── Main flow action handler ───────────────────────────────────────────────

async function handleFlowAction(
  body: FlowRequestBody,
  deps: WhatsappFlowEndpointDeps,
): Promise<{ screen: string; data: Record<string, unknown> }> {
  if (body.action === 'ping') {
    return { screen: 'SUCCESS', data: { status: 'active' } };
  }

  const tokenData = parseFlowToken(body.flow_token, deps.tokenSecret);
  if (!tokenData) {
    return { screen: 'SUCCESS', data: buildErrorData('Invalid session. Please try again.') };
  }

  const { rideId, userId } = tokenData;

  // ── The Edit-trip form (token `edit:<userId>`) is its own small flow ───
  if (rideId === 'edit') {
    return handleEditTripFlow(body, userId, {
      redisClient: deps.redisClient,
      googleMapsApiKey: deps.googleMapsApiKey,
      routePlanner: deps.routePlanner,
      onTripConfirmed: deps.onTripConfirmed,
    });
  }

  // ── INIT — show appropriate screen based on ride state ────────────────

  if (body.action === 'INIT') {
    if (rideId === 'offers') {
      return await handleOffersInit(userId, deps);
    }
    if (rideId === 'new') {
      return await handleRideSetupInit(userId, deps);
    }
    return await resolveScreen(rideId, userId, deps);
  }

  // ── BACK — return to appropriate screen ───────────────────────────────

  if (body.action === 'BACK') {
    if (rideId === 'offers') {
      return await handleOffersInit(userId, deps);
    }
    if (rideId === 'new') {
      return await handleRideSetupInit(userId, deps);
    }
    return await resolveScreen(rideId, userId, deps);
  }

  // ── data_exchange — handle user actions ───────────────────────────────

  if (body.action === 'data_exchange') {
    const data = body.data ?? {};
    let action = data.action as string | undefined;

    // Phones cache flow JSON aggressively: an old cached screen submits the
    // form fields without our `action` tag. Infer the intent instead of
    // falling through to a terminal screen (which reads as a crash).
    if (!action && typeof data.pickup_address === 'string') {
      action = data.offer_amount !== undefined && data.offer_amount !== '' ? 'find_drivers' : 'estimate_fare';
    } else if (!action && body.screen === 'BID_LIST') {
      action = 'bid_action';
    } else if (!action && body.screen === 'TOP_UP') {
      action = 'topup_check';
    } else if (!action && body.screen === 'RIDE_CONFIRMED') {
      action = 'view_driver_profile';
    } else if (!action && body.screen === 'DRIVER_PROFILE') {
      action = 'view_payment';
    }
    if (!(data.action as string | undefined) && action) {
      console.info('[whatsapp-flow] inferred action', { screen: body.screen ?? null, action });
    }

    // ── RIDE_SETUP: estimate fare, show FARE_CONFIRM ────────────────────
    if (action === 'estimate_fare') {
      return await handleEstimateFare(userId, data, deps);
    }

    // ── FARE_CONFIRM: find drivers ──────────────────────────────────────
    if (action === 'find_drivers') {
      return await handleFindDrivers(userId, data, deps);
    }

    // Need a valid ride from here on. The booking flow runs on a
    // 'new:<user>' token — the ride it created is only reachable through
    // the active-ride pointer, never through the token itself.
    const sessionRideId =
      rideId === 'new' || rideId === 'offers' ? await getActiveRide(deps.redisClient, userId) : rideId;
    const meta = sessionRideId ? await getRideMeta(deps.redisClient, sessionRideId) : null;
    if (!sessionRideId || !meta) {
      return { screen: 'SUCCESS', data: buildErrorData('This ride request has expired. Send a new message to book a ride.') };
    }

    // ── BID_LIST actions: accept / decline ───────────────────────────
    if (action === 'bid_action') {
      const bidAction = data.bid_action as string;
      const selectedBid = data.selected_bid as string | undefined;
      const adjustAmount = Number(data.adjust_amount);

      // Empty selections mean the rider is on the no-offers-yet screen and
      // tapped the button to refresh — wait briefly for fresh bids.
      if (!selectedBid || !bidAction) {
        const bids = await pollForBids(deps.redisClient, sessionRideId, 0);
        return { screen: 'BID_LIST', data: buildBidListData(meta, bids) };
      }

      // A changed adjust amount is a COUNTER-OFFER, not an accept at the
      // driver's price — publish it so every candidate driver sees the new
      // number, and keep the rider on the offers page.
      if (!isNaN(adjustAmount) && adjustAmount >= 100 && adjustAmount !== meta.offerNgn) {
        meta.offerNgn = adjustAmount;
        await deps.redisClient.set(
          `whatsapp:ride:${sessionRideId}:meta`,
          JSON.stringify(meta),
          900,
        );
        const counterEvent = RideRiderCounterOfferEvent.parse({
          eventType: 'RIDE_RIDER_COUNTER_OFFER',
          rideId: sessionRideId,
          riderId: userId,
          counterOfferNgn: adjustAmount,
          timestamp: new Date().toISOString(),
        });
        await deps.publisher.publishRideEvent(counterEvent);
        console.info('[whatsapp-flow] rider counter-offer sent', { rideId: sessionRideId, counterOfferNgn: adjustAmount });
        const bids = await getBids(deps.redisClient, sessionRideId);
        return {
          screen: 'BID_LIST',
          data: buildBidListData(
            meta,
            bids,
            `Your new offer of ₦${adjustAmount.toLocaleString()} was sent to the drivers — updated responses will arrive shortly.`,
          ),
        };
      }

      if (bidAction === 'accept') {
        return await handleAcceptBid(sessionRideId, userId, selectedBid, meta, deps);
      }

      if (bidAction === 'decline') {
        return await handleDeclineBid(sessionRideId, userId, selectedBid, meta, deps);
      }
    }

    // ── TOP_UP: rider says they've transferred — re-check and book ──
    if (action === 'topup_check') {
      return await handleTopUpCheck(sessionRideId, userId, meta, deps);
    }

    // ── RIDE_CONFIRMED: view driver profile ─────────────────────────
    if (action === 'view_driver_profile') {
      return await handleViewDriverProfile(sessionRideId, deps);
    }

    // ── DRIVER_PROFILE: view payment ─────────────────────────────────
    if (action === 'view_payment') {
      return await handleViewPayment(userId, meta);
    }

    // Default: resolve based on state
    return await resolveScreen(sessionRideId, userId, deps);
  }

  return { screen: 'SUCCESS', data: buildErrorData('Something went wrong. Please try again.') };
}

// ── Accept selected driver ──────────────────────────────────────────────

async function handleAcceptBid(
  rideId: string,
  userId: string,
  selectedBid: string,
  meta: NonNullable<Awaited<ReturnType<typeof getRideMeta>>>,
  deps: WhatsappFlowEndpointDeps,
): Promise<{ screen: string; data: Record<string, unknown> }> {
  const bids = await getBids(deps.redisClient, rideId);
  const key = selectedBid.replace('bid-', '');
  const bid = bids.find((b) => b.driverId === key) ?? bids[parseInt(key, 10)];

  if (!bid) {
    return { screen: 'BID_LIST', data: buildBidListData(meta, bids) };
  }

  // ── The moment of commitment — SAME guards as the chat pay path and the
  // app's ride:accept_offer. This used to publish the accept blind, which
  // is exactly the class of bug (driver sold twice, unsecured rides) the
  // marketplace overhaul removed. The flow must never be a way around it.
  const driver = await driverClient.findById(bid.driverId).catch(() => null);
  const driverFresh =
    driver?.lastSeenAt != null && Date.now() - driver.lastSeenAt.getTime() < 2 * 60_000;
  const driverBusy = driver
    ? await rideClient.findActiveByDriver(bid.driverId).catch(() => null)
    : null;
  if (!driver || driver.status !== 'ONLINE' || !driverFresh || driverBusy) {
    console.info('[whatsapp-flow] accept blocked: driver unavailable', {
      rideId,
      driverId: bid.driverId,
      found: !!driver,
      status: driver?.status ?? null,
      fresh: driverFresh,
      busyRideId: driverBusy?.id ?? null,
    });
    const remaining = await removeBid(deps.redisClient, rideId, bid.driverId);
    if (remaining.length > 0) {
      return { screen: 'BID_LIST', data: buildBidListData(meta, remaining) };
    }
    await setRideState(deps.redisClient, rideId, 'searching');
    return {
      screen: 'BID_LIST',
      data: buildBidListData(
        meta,
        remaining,
        `${bid.driverName} just became unavailable — your money has not moved. New offers will arrive here.`,
      ),
    };
  }

  // No hold, no match — the fare is locked before the accept is published.
  const wallet = await walletClient.findByUserId(userId).catch(() => null);
  const balanceNgn = wallet ? Number(wallet.balanceNgn) : 0;
  if (!wallet || balanceNgn < bid.counterOfferNgn) {
    console.info('[whatsapp-flow] accept blocked: wallet short', {
      rideId,
      balanceNgn,
      fareNgn: bid.counterOfferNgn,
    });
    const { virtualAccount } = await getWalletInfo(userId);
    await storeFlowPendingAccept(deps.redisClient, userId, { rideId, driverId: bid.driverId });
    return {
      screen: 'TOP_UP',
      data: buildTopUpData({
        fareNgn: bid.counterOfferNgn,
        balanceNgn,
        virtualAccount,
      }),
    };
  }
  try {
    await walletClient.createRideHold({
      rideId,
      walletId: wallet.id,
      riderId: userId,
      driverUserId: bid.driverUserId,
      amountNgn: bid.counterOfferNgn,
    });
  } catch (holdError) {
    console.warn('[whatsapp-flow] accept blocked: hold failed', {
      rideId,
      error: holdError instanceof Error ? holdError.message : String(holdError),
    });
    return {
      screen: 'BID_LIST',
      data: buildBidListData(meta, bids, 'Could not lock funds in your wallet. Please try again.'),
    };
  }

  const acceptEvent = RideOfferAcceptedEvent.parse({
    eventType: 'RIDE_OFFER_ACCEPTED',
    rideId,
    riderId: userId,
    driverId: bid.driverId,
    driverUserId: bid.driverUserId,
    bidId: bid.bidId,
    agreedFareNgn: bid.counterOfferNgn,
    paymentMethod: 'WALLET',
    timestamp: new Date().toISOString(),
  });
  await deps.publisher.publishRideEvent(acceptEvent);
  await setRideState(deps.redisClient, rideId, 'confirmed');
  await clearFlowPendingAccept(deps.redisClient, userId).catch(() => undefined);
  console.info('[whatsapp-flow] accept confirmed', { rideId, driverId: bid.driverId, fareNgn: bid.counterOfferNgn });

  // Fetch driver details for profile flow
  let driverPhone = '';
  let vehicleColor = '';
  let totalRides = 0;
  try {
    const driver = await driverClient.findById(bid.driverId);
    driverPhone = driver.user.phone ?? '';
    vehicleColor = '';
    totalRides = driver.totalRides ?? 0;
  } catch {
    // Driver lookup failed — continue without phone
  }

  await storeAcceptedBid(deps.redisClient, rideId, {
    driverName: bid.driverName,
    driverPhone,
    driverUserId: bid.driverUserId,
    vehicleModel: bid.vehicleModel,
    vehiclePlate: bid.vehiclePlate,
    vehicleColor,
    driverRating: bid.driverRating,
    totalRides,
    etaSeconds: bid.etaSeconds,
    fareNgn: bid.counterOfferNgn,
  });

  return {
    screen: 'RIDE_CONFIRMED',
    data: buildConfirmationData({
      driverName: bid.driverName,
      vehicleModel: bid.vehicleModel,
      vehiclePlate: bid.vehiclePlate,
      etaSeconds: bid.etaSeconds,
      fareNgn: bid.counterOfferNgn,
      driverRating: bid.driverRating,
    }),
  };
}

// ── TOP_UP re-check — book the reserved driver once money landed ────────

async function handleTopUpCheck(
  rideId: string,
  userId: string,
  meta: NonNullable<Awaited<ReturnType<typeof getRideMeta>>>,
  deps: WhatsappFlowEndpointDeps,
): Promise<{ screen: string; data: Record<string, unknown> }> {
  const pending = await getFlowPendingAccept(deps.redisClient, userId);
  if (!pending || pending.rideId !== rideId) {
    return {
      screen: 'SUCCESS',
      data: buildNotifyExitData("This booking session has expired. Send 'hi' to book again — your money has not moved."),
    };
  }

  const bids = await getBids(deps.redisClient, rideId);
  const bid = bids.find((b) => b.driverId === pending.driverId);
  if (!bid) {
    await clearFlowPendingAccept(deps.redisClient, userId);
    return {
      screen: 'SUCCESS',
      data: buildNotifyExitData('That driver became unavailable — your money has not moved. New offers will arrive as messages in the chat.'),
    };
  }

  const wallet = await walletClient.findByUserId(userId).catch(() => null);
  const balanceNgn = wallet ? Number(wallet.balanceNgn) : 0;
  if (balanceNgn < bid.counterOfferNgn) {
    const { virtualAccount } = await getWalletInfo(userId);
    return {
      screen: 'TOP_UP',
      data: buildTopUpData({
        fareNgn: bid.counterOfferNgn,
        balanceNgn,
        virtualAccount,
        status: `No new credit yet (wallet: ₦${balanceNgn.toLocaleString()}). Transfers usually land within a minute — tap again shortly.`,
      }),
    };
  }

  // Funded — run the same guarded accept. From TOP_UP the routing model
  // cannot go back to BID_LIST, so a driver-side failure exits via SUCCESS.
  const result = await handleAcceptBid(rideId, userId, `bid-${pending.driverId}`, meta, deps);
  if (result.screen === 'BID_LIST') {
    await clearFlowPendingAccept(deps.redisClient, userId);
    return {
      screen: 'SUCCESS',
      data: buildNotifyExitData('That driver became unavailable — your money has not moved. New offers will arrive as messages in the chat.'),
    };
  }
  return result;
}

// ── Decline selected driver ─────────────────────────────────────────────

async function handleDeclineBid(
  rideId: string,
  userId: string,
  selectedBid: string,
  meta: NonNullable<Awaited<ReturnType<typeof getRideMeta>>>,
  deps: WhatsappFlowEndpointDeps,
): Promise<{ screen: string; data: Record<string, unknown> }> {
  const bids = await getBids(deps.redisClient, rideId);
  const declineKey = selectedBid.replace('bid-', '');
  const bid = bids.find((b) => b.driverId === declineKey) ?? bids[parseInt(declineKey, 10)];

  if (bid) {
    const remaining = await removeBid(deps.redisClient, rideId, bid.driverId);

    if (remaining.length > 0) {
      return { screen: 'BID_LIST', data: buildBidListData(meta, remaining) };
    }

    // No bids left — go back to searching
    await setRideState(deps.redisClient, rideId, 'searching');
    return {
      screen: 'SUCCESS',
      data: buildNotifyExitData('Driver declined. We\'ll notify you when new drivers bid.'),
    };
  }

  return { screen: 'BID_LIST', data: buildBidListData(meta, bids) };
}

// ── View driver profile screen ──────────────────────────────────────────

async function handleViewDriverProfile(
  rideId: string,
  deps: WhatsappFlowEndpointDeps,
): Promise<{ screen: string; data: Record<string, unknown> }> {
  const acceptedBid = await getAcceptedBid(deps.redisClient, rideId);

  if (!acceptedBid) {
    return { screen: 'SUCCESS', data: buildErrorData('Driver info not available yet.') };
  }

  const etaMin = Math.ceil(acceptedBid.etaSeconds / 60);

  // Fetch driver selfie + first vehicle photo from R2 storage
  let driverPhoto = '';
  let vehiclePhoto = '';
  if (deps.kycStorage) {
    try {
      const driver = await driverClient.findByUserId(acceptedBid.driverUserId ?? '');
      if (driver) {
        const kycSubmission = await driverClient.findKycSubmission(driver.id);
        if (kycSubmission?.selfieKey) {
          driverPhoto = await deps.kycStorage.getImageAsBase64(kycSubmission.selfieKey) ?? '';
        }
        if (kycSubmission?.vehicleImageKeys?.length) {
          vehiclePhoto = await deps.kycStorage.getImageAsBase64(kycSubmission.vehicleImageKeys[0]) ?? '';
        }
      }
    } catch {
      // Non-critical — show profile without photos
    }
  }

  return {
    screen: 'DRIVER_PROFILE',
    data: buildDriverProfileData({
      driverName: acceptedBid.driverName,
      phoneNumber: acceptedBid.driverPhone,
      vehicleInfo: acceptedBid.vehicleColor
        ? `${acceptedBid.vehicleColor} ${acceptedBid.vehicleModel}`
        : acceptedBid.vehicleModel,
      vehiclePlate: acceptedBid.vehiclePlate,
      ratingInfo: `${acceptedBid.driverRating.toFixed(1)}★ · ${acceptedBid.totalRides} rides`,
      eta: `${etaMin} minute${etaMin === 1 ? '' : 's'} away`,
      fare: `₦${acceptedBid.fareNgn.toLocaleString()}`,
      driverPhoto,
      vehiclePhoto,
    }),
  };
}

// ── View payment screen ─────────────────────────────────────────────────

async function handleViewPayment(
  userId: string,
  meta: NonNullable<Awaited<ReturnType<typeof getRideMeta>>>,
): Promise<{ screen: string; data: Record<string, unknown> }> {
  const walletInfo = await getWalletInfo(userId);

  return {
    screen: 'PAYMENT',
    data: buildPaymentData({
      fareNgn: meta.offerNgn,
      ...walletInfo,
    }),
  };
}

// ── RIDE_SETUP init — build setup screen from pending location data ─────

async function handleRideSetupInit(
  userId: string,
  deps: WhatsappFlowEndpointDeps,
): Promise<{ screen: string; data: Record<string, unknown> }> {
  const existingRideId = await getActiveRide(deps.redisClient, userId);
  if (existingRideId) {
    const existingMeta = await getRideMeta(deps.redisClient, existingRideId);
    if (existingMeta) {
      // Meta only allows a flow to OPEN on the entry screen — answering
      // INIT with BID_LIST is rejected client-side as an invalid screen
      // transition. Offers are reachable through the 'View offers'
      // message (which navigates directly); here we can only inform.
      return {
        screen: 'RIDE_SETUP',
        data: buildRideSetupData({
          pickupAddress: existingMeta.pickupAddress,
          destinationAddress: existingMeta.destinationAddress,
          error:
            "You have a ride in progress — driver offers arrive as 'View offers' messages in this chat. Say 'cancel ride' in the chat to start over.",
        }),
      };
    }
    // A pointer to a ride whose data expired must not block booking.
    await clearActiveRide(deps.redisClient, userId);
  }

  const pendingLocation = await getPendingLocation(deps.redisClient, userId);

  return {
    screen: 'RIDE_SETUP',
    data: buildRideSetupData({
      pickupAddress: pendingLocation?.address ?? '',
      destinationAddress: '',
    }),
  };
}

// ── Offers flow INIT — entry screen IS the bid list ─────────────────────

async function handleOffersInit(
  userId: string,
  deps: WhatsappFlowEndpointDeps,
): Promise<{ screen: string; data: Record<string, unknown> }> {
  const rideId = await getActiveRide(deps.redisClient, userId);
  const meta = rideId ? await getRideMeta(deps.redisClient, rideId) : null;
  if (!rideId || !meta) {
    return {
      screen: 'BID_LIST',
      data: buildBidListData(
        { riderId: userId, phone: '', pickupAddress: '—', destinationAddress: '—', offerNgn: 0, suggestedFareNgn: 0, paymentMethod: 'WALLET', createdAt: new Date().toISOString() },
        [],
        "This request has ended. Send 'hi' in the chat to book a new ride.",
      ),
    };
  }
  const state = await getRideState(deps.redisClient, rideId);
  if (state === 'confirmed' || state === 'in_progress' || state === 'completed') {
    return await resolveScreen(rideId, userId, deps);
  }
  const bids = await getBids(deps.redisClient, rideId);
  return { screen: 'BID_LIST', data: buildBidListData(meta, bids) };
}

// ── Estimate fare — geocode + plan route, hand off to FARE_CONFIRM ──────

async function handleEstimateFare(
  userId: string,
  data: Record<string, unknown>,
  deps: WhatsappFlowEndpointDeps,
): Promise<{ screen: string; data: Record<string, unknown> }> {
  const pickupAddress = (data.pickup_address as string)?.trim();
  const destinationAddress = (data.destination_address as string)?.trim();

  if (!pickupAddress || pickupAddress.length < 3) {
    return {
      screen: 'RIDE_SETUP',
      data: buildRideSetupData({
        pickupAddress: pickupAddress ?? '',
        destinationAddress: destinationAddress ?? '',
        error: 'Enter a more specific pickup (street, landmark, bus stop)',
      }),
    };
  }

  if (!destinationAddress || destinationAddress.length < 3) {
    return {
      screen: 'RIDE_SETUP',
      data: buildRideSetupData({
        pickupAddress,
        destinationAddress: destinationAddress ?? '',
        error: 'Enter a more specific destination (street, landmark, bus stop)',
      }),
    };
  }

  const existingRide = await getActiveRide(deps.redisClient, userId);
  if (existingRide) {
    const existingMeta = await getRideMeta(deps.redisClient, existingRide);
    if (existingMeta) {
      return {
        screen: 'RIDE_SETUP',
        data: buildRideSetupData({
          pickupAddress,
          destinationAddress,
          error: "You have an active ride. Say 'cancel ride' on WhatsApp first.",
        }),
      };
    }
    await clearActiveRide(deps.redisClient, userId);
  }

  // A location pin shared in chat pre-fills pickup; only trust its coordinates
  // when the rider kept that exact address.
  const pendingLocation = await getPendingLocation(deps.redisClient, userId);
  let pickupGeo: { lat: number; lng: number; formattedAddress: string } | null = null;
  if (pendingLocation && pendingLocation.address === pickupAddress) {
    pickupGeo = { lat: pendingLocation.lat, lng: pendingLocation.lng, formattedAddress: pendingLocation.address };
    await clearPendingLocation(deps.redisClient, userId);
  } else {
    pickupGeo = await geocodeAddress(deps.googleMapsApiKey, `${pickupAddress}, Lagos, Nigeria`);
  }

  if (!pickupGeo) {
    return {
      screen: 'RIDE_SETUP',
      data: buildRideSetupData({
        pickupAddress,
        destinationAddress,
        error: `Could not find "${pickupAddress}". Try a landmark, bus stop, or street name.`,
      }),
    };
  }

  const destGeo = await geocodeAddress(deps.googleMapsApiKey, `${destinationAddress}, Lagos, Nigeria`);
  if (!destGeo) {
    return {
      screen: 'RIDE_SETUP',
      data: buildRideSetupData({
        pickupAddress,
        destinationAddress,
        error: `Could not find "${destinationAddress}". Try a landmark, bus stop, or street name.`,
      }),
    };
  }

  let plannedRoute: Awaited<ReturnType<typeof deps.routePlanner.planRoute>>;
  try {
    plannedRoute = await deps.routePlanner.planRoute({
      origin: pickupGeo,
      destination: destGeo,
    });
  } catch (error) {
    console.warn('[whatsapp-flow] route planning failed', {
      pickup: pickupGeo.formattedAddress,
      destination: destGeo.formattedAddress,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      screen: 'RIDE_SETUP',
      data: buildRideSetupData({
        pickupAddress,
        destinationAddress,
        error: 'Could not find a driving route between those two points. Please check the addresses.',
      }),
    };
  }

  await storeFlowEstimate(deps.redisClient, userId, {
    pickupAddress: pickupGeo.formattedAddress,
    pickupLat: pickupGeo.lat,
    pickupLng: pickupGeo.lng,
    destinationAddress: destGeo.formattedAddress,
    destinationLat: destGeo.lat,
    destinationLng: destGeo.lng,
    distanceKm: plannedRoute.distanceKm,
    durationSeconds: plannedRoute.durationSeconds,
    suggestedFareNgn: plannedRoute.suggestedFareNgn,
    minOfferNgn: plannedRoute.minOfferNgn,
    ratePerKmNgn: plannedRoute.ratePerKmNgn,
    geometry: plannedRoute.geometry,
  });

  return {
    screen: 'FARE_CONFIRM',
    data: buildFareConfirmData({
      pickupAddress: pickupGeo.formattedAddress,
      destinationAddress: destGeo.formattedAddress,
      suggestedFareNgn: plannedRoute.suggestedFareNgn,
      minOfferNgn: plannedRoute.minOfferNgn,
      distanceKm: plannedRoute.distanceKm,
      durationSeconds: plannedRoute.durationSeconds,
    }),
  };
}

// ── Find drivers — create the ride from the confirmed estimate ──────────

async function handleFindDrivers(
  userId: string,
  data: Record<string, unknown>,
  deps: WhatsappFlowEndpointDeps,
): Promise<{ screen: string; data: Record<string, unknown> }> {
  const pickupAddress = (data.pickup_address as string)?.trim();
  const destinationAddress = (data.destination_address as string)?.trim();
  const offerAmount = Number(data.offer_amount);
  const paymentMethod = 'WALLET' as const;

  // Meta's routing model is forward-only, so a failure here cannot send the
  // rider back to RIDE_SETUP — redisplay FARE_CONFIRM or exit via SUCCESS.
  if (!pickupAddress || !destinationAddress) {
    return {
      screen: 'SUCCESS',
      data: buildNotifyExitData("Something went wrong with that booking. Send 'hi' to start again."),
    };
  }

  const existingRide = await getActiveRide(deps.redisClient, userId);
  if (existingRide) {
    const existingMeta = await getRideMeta(deps.redisClient, existingRide);
    if (existingMeta) {
      return {
        screen: 'SUCCESS',
        data: buildNotifyExitData("You already have an active ride. Say 'cancel ride' in the chat first if you want to rebook."),
      };
    }
    await clearActiveRide(deps.redisClient, userId);
  }

  // Reuse the geocode + route from the estimate step; recompute only when the
  // cached estimate expired or no longer matches the addresses on screen.
  let route: FlowEstimate | null = await getFlowEstimate(deps.redisClient, userId);
  if (route && (route.pickupAddress !== pickupAddress || route.destinationAddress !== destinationAddress)) {
    route = null;
  }

  if (!route) {
    const pickupGeo = await geocodeAddress(deps.googleMapsApiKey, `${pickupAddress}, Lagos, Nigeria`);
    const destGeo = pickupGeo
      ? await geocodeAddress(deps.googleMapsApiKey, `${destinationAddress}, Lagos, Nigeria`)
      : null;
    if (!pickupGeo || !destGeo) {
      return {
        screen: 'SUCCESS',
        data: buildNotifyExitData("Your fare estimate expired and we couldn't confirm the route. Send 'hi' to start again."),
      };
    }

    let plannedRoute: Awaited<ReturnType<typeof deps.routePlanner.planRoute>>;
    try {
      plannedRoute = await deps.routePlanner.planRoute({
        origin: pickupGeo,
        destination: destGeo,
      });
    } catch (error) {
      console.warn('[whatsapp-flow] route planning failed', {
        pickup: pickupGeo.formattedAddress,
        destination: destGeo.formattedAddress,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        screen: 'SUCCESS',
        data: buildNotifyExitData("We couldn't map a driving route for that trip. Send 'hi' to try again."),
      };
    }

    route = {
      pickupAddress: pickupGeo.formattedAddress,
      pickupLat: pickupGeo.lat,
      pickupLng: pickupGeo.lng,
      destinationAddress: destGeo.formattedAddress,
      destinationLat: destGeo.lat,
      destinationLng: destGeo.lng,
      distanceKm: plannedRoute.distanceKm,
      durationSeconds: plannedRoute.durationSeconds,
      suggestedFareNgn: plannedRoute.suggestedFareNgn,
      minOfferNgn: plannedRoute.minOfferNgn,
      ratePerKmNgn: plannedRoute.ratePerKmNgn,
      geometry: plannedRoute.geometry,
    };
  }

  const suggestedFareNgn = route.suggestedFareNgn;
  const riderOfferNgn = offerAmount > 0 ? offerAmount : suggestedFareNgn;
  const validation = validateRiderOffer(riderOfferNgn, suggestedFareNgn);
  if (!validation.valid) {
    return {
      screen: 'FARE_CONFIRM',
      data: buildFareConfirmData({
        pickupAddress: route.pickupAddress,
        destinationAddress: route.destinationAddress,
        suggestedFareNgn,
        minOfferNgn: route.minOfferNgn,
        distanceKm: route.distanceKm,
        durationSeconds: route.durationSeconds,
        error: validation.reason ?? 'That offer is too low. Try again.',
      }),
    };
  }
  const finalOffer = riderOfferNgn;

  const rideId = randomUUID();
  const phone = await lookupPhoneByUserId(deps.redisClient, userId) ?? '';

  const event = RideRequestedEvent.parse({
    eventType: 'RIDE_REQUESTED',
    rideId,
    riderId: userId,
    pickup: { lat: route.pickupLat, lng: route.pickupLng, address: route.pickupAddress },
    destination: { lat: route.destinationLat, lng: route.destinationLng, address: route.destinationAddress },
    stops: [],
    plannedDistanceKm: route.distanceKm,
    plannedDurationSeconds: route.durationSeconds,
    fareEstimateNgn: suggestedFareNgn,
    paymentMethod,
    riderOfferNgn: finalOffer,
    suggestedFareNgn,
    minOfferNgn: route.minOfferNgn,
    ratePerKmNgn: route.ratePerKmNgn,
    route: route.geometry,
    timestamp: new Date().toISOString(),
  });

  await deps.publisher.publishRideEvent(event);

  await storeWhatsappRide(deps.redisClient, rideId, {
    riderId: userId,
    phone,
    source: 'flow',
    pickupAddress: route.pickupAddress,
    pickupLat: route.pickupLat,
    pickupLng: route.pickupLng,
    destinationAddress: route.destinationAddress,
    destinationLat: route.destinationLat,
    destinationLng: route.destinationLng,
    distanceKm: route.distanceKm,
    durationSeconds: route.durationSeconds,
    offerNgn: finalOffer,
    suggestedFareNgn,
    paymentMethod,
    createdAt: new Date().toISOString(),
  });
  await setActiveRide(deps.redisClient, userId, rideId);
  await clearFlowEstimate(deps.redisClient, userId);
  await clearPendingLocation(deps.redisClient, userId).catch(() => undefined);
  await setRideState(deps.redisClient, rideId, 'bidding');

  // Drop a re-entry button in the chat right away: if the rider closes the
  // form while we search, tapping it re-opens the offers page any time —
  // they are never stranded waiting for the first bid.
  if (META_FLOWS_ENABLED && deps.notifier && phone) {
    const entryMeta = {
      riderId: userId,
      phone,
      pickupAddress: route.pickupAddress,
      destinationAddress: route.destinationAddress,
      offerNgn: finalOffer,
      suggestedFareNgn,
      paymentMethod,
      createdAt: new Date().toISOString(),
      source: 'flow' as const,
    };
    void sendFlowOffersMessage(deps.notifier, phone, userId, entryMeta, []).catch((err) =>
      console.warn('[whatsapp-flow] re-entry message failed', err),
    );
  }

  // Stay in the flow: hold up to 8.5s (Meta cuts us off around 10), then land
  // on the offers page either way — empty state has its own refresh button.
  const bids = await pollForBids(deps.redisClient, rideId, 0, 8_500);

  return {
    screen: 'BID_LIST',
    data: buildBidListData(
      {
        riderId: userId,
        phone,
        pickupAddress: route.pickupAddress,
        destinationAddress: route.destinationAddress,
        offerNgn: finalOffer,
        suggestedFareNgn,
        paymentMethod,
        createdAt: new Date().toISOString(),
      },
      bids,
    ),
  };
}

// ── HTTP handler ────────────────────────────────────────────────────────────

export async function handleWhatsappFlowEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WhatsappFlowEndpointDeps,
): Promise<void> {
  let decrypted: DecryptedFlowRequest;
  try {
    const rawBody = await readRawBody(req);
    const envelope = JSON.parse(rawBody.toString('utf8'));
    decrypted = decryptFlowRequest(envelope, deps.privateKeyPem);
  } catch (error) {
    // Meta's spec: a 421 tells WhatsApp our public key changed — it
    // re-fetches the key and re-encrypts. A 500 here leaves Meta stuck on
    // a stale cached key forever (exactly the health-check OAEP failure).
    console.warn('[whatsapp-flow] could not decrypt request — answering 421 so Meta refreshes the key', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.statusCode = 421;
    res.end();
    return;
  }

  try {
    const started = Date.now();
    const body = decrypted.decryptedBody;
    if (body.action !== 'ping') {
      console.info('[whatsapp-flow] request', {
        action: body.action,
        screen: body.screen ?? null,
        dataAction: (body.data?.action as string) ?? null,
        data: JSON.stringify(body.data ?? {}).slice(0, 400),
        flowToken: body.flow_token?.slice(0, 24),
      });
    }
    const response = await handleFlowAction(body, deps);
    if (body.action !== 'ping') {
      console.info('[whatsapp-flow] response', {
        action: body.action,
        dataAction: (body.data?.action as string) ?? null,
        screen: response.screen,
        durationMs: Date.now() - started,
      });
    }

    const encrypted = encryptFlowResponse(response, decrypted.aesKey, decrypted.iv);
    res.statusCode = 200;
    res.setHeader('content-type', 'text/plain');
    res.end(encrypted);
  } catch (error) {
    // A 500 shows the rider a hard error banner and kills the flow. Whatever
    // broke server-side, hand back a graceful terminal screen instead — the
    // money paths are guarded transactionally, so exiting is always safe.
    console.error('[whatsapp-flow] Endpoint error', error);
    try {
      const fallback = encryptFlowResponse(
        {
          screen: 'SUCCESS',
          data: buildNotifyExitData("Something went wrong on our side — nothing was charged. Send 'hi' to try again."),
        },
        decrypted.aesKey,
        decrypted.iv,
      );
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain');
      res.end(fallback);
    } catch {
      sendJson(res, 500, { error: 'Internal error' });
    }
  }
}
