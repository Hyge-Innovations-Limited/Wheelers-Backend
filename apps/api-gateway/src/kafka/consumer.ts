import { randomUUID } from 'node:crypto';
import { appBackgroundKey } from '../websocket/app-state';
import { clearForBooking, closePaying, payingStatusEnabled, readPaying } from '../rides/paying-status';
import type { WheelersConsumer } from '@wheleers/kafka-client';
import { referralClient, walletClient, virtualAccountClient, driverClient, userClient, driverBidClient, rideClient, complianceClient, tripCodeClient, scheduledRideClient, SEARCH_TIMED_OUT_REASON } from '@wheleers/db';
import {
  ComplianceEvent,
  GroupRideEvent,
  GpsProcessedEvent,
  NotificationEvent,
  RideEvent,
  WalletEvent,
  TOPICS,
} from '@wheleers/kafka-schemas';
import { BOOKING_FEE_NGN, CURRENT_PRICING_VERSION, offerLimitsNgn, rateLimitsPerKmNgn, calculateRideFees, formatTripId } from '@wheleers/config';
import { buildRideEstimatePricing } from '../pricing/ride-estimate';
import { SocketRegistry } from '../websocket/registry';
import { loadDriverRideSnapshot } from '../websocket/driver-ride-sync';
import type { RedisClient } from '../redis/client';
import {
  isWhatsappRider,
  lookupPhoneByUserId,
  addBid,
  shouldNotify,
  noteNotified,
  hasOffersMessage,
  markOffersMessageSent,
  markSearchTimedOut,
  getGroupSeat,
  clearActiveRide,
  clearActiveRideIfMatches,
  clearPendingAccept,
  getPendingAccept,
  getActiveRide,
  removeBid,
  IN_TRIP_ACTIVE_RIDE_TTL,
  cleanupRideKeys,
  setRideState,
  getRideState,
  getRideMeta,
  getBids,
  storeAcceptedBid,
  clearAcceptedBid,
  storeLastBatch,
  getGroupRequestRider,
  storeWhatsappRide,
  setActiveRide,
  storeGroupSeat,
  storeGroupSeatMembers,
  getAcceptedBid,
  storeLastCompletedRide,
  getLastBatch,
  takeChatCancellation,
  wasCancelledOnPage,
  isRidePageOpen,
  clearBids,
  whatsappWindowEnd,
  storeTripLine,
  setPageNotice,
  isRidePageSeen,
} from '../whatsapp-flows/bid-state';
import type { WhatsappBid } from '../whatsapp-flows/bid-state';
import {
  sendBidNotification,
  sendOffersInChat,
  offersFormIsOn,
  sortOffers,
  sendFlowOffersMessage,
  sendDriverArrivedNotification,
  sendRideCompletedNotification,
  setGroupRideChecker,
  sendRideCancelledNotification,
  rideCancelledText,
  sendBidTimeoutNotification,
  sendOfferWithdrawnNotification,
  sendMetaWhatsappMessage,
  sendDepositConfirmation,
  sendGroupRideGroupedNotification,
  sendGroupRideDriverAssignedNotification,
  sendGroupRideDispatchNotification,
} from '../whatsapp-flows/whatsapp-notifier';
import type { WhatsappNotifierDeps } from '../whatsapp-flows/whatsapp-notifier';
import { clearOfferCount, hasOffersPageMessage, sendOffersPageMessage, showOfferCount } from '../whatsapp-flows/offers-page-message';
import { loadTripChat } from '../trip-chat/access';
import { hasRideCard, setCardStatus } from '../trip-chat/card-status';
import { tripCodeStillNeeded } from '../rides/trip-code';
import { SCHEDULED_START_HELD_REASON, startScheduledWhatsappSearch } from '../rides/scheduled-whatsapp';
import { ChatUnreachableError } from '../whatsapp/scheduled-template';
import type { StellarService } from '../stellar/service';
import { createPageCatchup, deferUntilPageLeft, deliverCatchup, pendingCatchup } from '../whatsapp-flows/page-catchup';
import type { CatchupItem } from '../whatsapp-flows/page-catchup';
import type { RidePageChatEvent } from '../http/ride-page.route';
import type { DriverKycStorage } from '../storage/driver-kyc-storage';
import type { GatewayPublisher } from '../websocket/publisher';
import { noteOfferSent } from '../rides/search-status';
import { autoAcceptOffAtStart, autoAcceptPriceChanged, autoAcceptToldChat, autoBookedDriver, clearAutoAcceptBooked, tryAutoAccept, type AutoAcceptDeps } from '../rides/auto-accept';
import { acceptPublishingFor, acceptSentFor, BOOKING_LOCK_HOLD_MS, BOOKING_LOCK_WAIT_MS, clearAcceptSent, isSearchEnded, markSearchEnded, releaseBookingLock, takeBookingLock } from '../rides/booking-lock';

export interface StartGatewayConsumerDeps {
  consumer: WheelersConsumer;
  registry: SocketRegistry;
  redisClient: RedisClient;
  publisher: GatewayPublisher;
  whatsappNotifier?: WhatsappNotifierDeps;
  /** DRIVER_STATUS_PUSHES_ENABLED: an app that reported background counts as away, and the "paying now" push. */
  driverStatusPushes?: boolean;
  /** Resolves a driver's KYC photos — the car's, shown when they arrive. */
  kycStorage?: DriverKycStorage;
  /**
   * A WhatsApp rider's deposit has landed. Returns true when it was spoken for —
   * the rider had tapped a driver and was adding money to take them, so the chat
   * has already said what happened — and the plain "deposit received" is skipped.
   */
  onWhatsappDeposit?: (deposit: { userId: string; amountNgn: number; newBalanceNgn: number }) => Promise<boolean>;
  /** Stellar Testnet mirror (grant deliverable 3). Absent when STELLAR_ENABLED is off. */
  stellar?: StellarService | null;
  /** The rider's own link to the offers page — for the message that reopens a search after a driver bailed. */
  ridePageUrlFor?: (userId: string) => string | null;
  /** Says a ride-page event in the chat (the catch-up once the rider leaves the page). Absent: no catch-up runs. */
  ridePageChat?: (event: RidePageChatEvent) => Promise<void>;
}

interface RideParticipantState {
  riderId: string;
  driverUserId?: string;
}

/** The most a driver may ask on a trip, as a fare and as rates per km. Empty when there is nothing to measure against. */
function driverBidLimits(suggestedFareNgn: number | undefined, distanceKm: number | undefined) {
  if (!suggestedFareNgn || !(suggestedFareNgn > 0) || !distanceKm || !(distanceKm > 0)) return {};
  const rates = rateLimitsPerKmNgn(suggestedFareNgn, distanceKm);
  return {
    maxOfferNgn: offerLimitsNgn(suggestedFareNgn).maxOfferNgn,
    ...(rates ? { minRatePerKmNgn: rates.minRateNgn, maxRatePerKmNgn: rates.maxRateNgn } : {}),
  };
}

export async function startGatewayKafkaConsumer(deps: StartGatewayConsumerDeps): Promise<void> {
  // The receipt's Repeat / Reverse buttons must not be offered for a group seat.
  setGroupRideChecker(async (rideId) => Boolean(await getGroupSeat(deps.redisClient, rideId).catch(() => null)));
  const rideParticipants = new Map<string, RideParticipantState>();
  // What waited while riders were on the ride page, said when they leave it.
  if (deps.ridePageChat) {
    createPageCatchup({ redis: deps.redisClient, deliver: (userId, item) => deliverPageCatchup(deps, userId, item) }).start();
  }

  await deps.consumer.subscribe(
    [
      TOPICS.RIDE_EVENTS,
      TOPICS.WALLET_EVENTS,
      TOPICS.NOTIFICATION_EVENTS,
      TOPICS.GPS_PROCESSED,
      TOPICS.COMPLIANCE_EVENTS,
      TOPICS.GROUP_RIDE_EVENTS,
    ],
    async (value, context) => {
      if (context.topic === TOPICS.RIDE_EVENTS) {
        const parsed = RideEvent.safeParse(value);
        if (!parsed.success) {
          throw new Error(`Invalid ride event: ${parsed.error.message}`);
        }
        await handleRideEvent(parsed.data, deps, rideParticipants);
        return;
      }

      if (context.topic === TOPICS.WALLET_EVENTS) {
        const parsed = WalletEvent.safeParse(value);
        if (!parsed.success) {
          throw new Error(`Invalid wallet event: ${parsed.error.message}`);
        }
        await handleWalletEvent(parsed.data, deps, rideParticipants);
        return;
      }

      if (context.topic === TOPICS.NOTIFICATION_EVENTS) {
        const parsed = NotificationEvent.safeParse(value);
        if (!parsed.success) {
          throw new Error(`Invalid notification event: ${parsed.error.message}`);
        }
        await handleNotificationEvent(parsed.data, deps.registry);
        return;
      }

      if (context.topic === TOPICS.GPS_PROCESSED) {
        const parsed = GpsProcessedEvent.safeParse(value);
        if (!parsed.success) {
          throw new Error(`Invalid GPS processed event: ${parsed.error.message}`);
        }
        await handleGpsProcessedEvent(parsed.data, deps.registry, rideParticipants);
        return;
      }

      if (context.topic === TOPICS.COMPLIANCE_EVENTS) {
        const parsed = ComplianceEvent.safeParse(value);
        if (!parsed.success) {
          throw new Error(`Invalid compliance event: ${parsed.error.message}`);
        }
        await handleComplianceEvent(parsed.data, deps.registry);
        return;
      }

      if (context.topic === TOPICS.GROUP_RIDE_EVENTS) {
        const parsed = GroupRideEvent.safeParse(value);
        if (!parsed.success) {
          throw new Error(`Invalid group ride event: ${parsed.error.message}`);
        }
        await handleGroupRideEvent(parsed.data, deps);
      }
    },
  );
}

/**
 * One pending flush per ride. In-memory is acceptable here: if the gateway
 * restarts, the worst case is the swallowed bid stays hidden until the next
 * bid arrives after the debounce — the pre-fix behaviour, not a new failure.
 */
const pendingBidFlushTimers = new Map<string, NodeJS.Timeout>();

/** Just past the 15s notification debounce, so shouldNotify passes at fire time. */
const BID_FLUSH_DELAY_MS = 16_000;

/** "Timilehin now ₦4,300 (was ₦5,000)" — the delta, not a re-announcement. */
function describeBidChanges(previous: WhatsappBid[], current: WhatsappBid[]): string[] {
  const before = new Map(previous.map((bid) => [bid.driverUserId, bid]));
  const changes: string[] = [];
  for (const bid of current) {
    const prior = before.get(bid.driverUserId);
    if (!prior) {
      if (previous.length > 0) changes.push(`${bid.driverName} joined at ₦${bid.counterOfferNgn.toLocaleString()}`);
    } else if (prior.counterOfferNgn !== bid.counterOfferNgn) {
      changes.push(`${bid.driverName} now ₦${bid.counterOfferNgn.toLocaleString()} (was ₦${prior.counterOfferNgn.toLocaleString()})`);
    }
  }
  return changes;
}

/**
 * Who is asking for this ride — name and track record, cached briefly so a
 * five-driver broadcast doesn't cost five identical lookups.
 */
const riderOfferInfoCache = new Map<string, { at: number; value: { name?: string; rating: number; tripCount: number } | null }>();
const RIDER_INFO_TTL_MS = 5 * 60_000;

async function getRiderOfferInfo(riderId: string) {
  const cached = riderOfferInfoCache.get(riderId);
  if (cached && Date.now() - cached.at < RIDER_INFO_TTL_MS) return cached.value;
  let value: { name?: string; rating: number; tripCount: number } | null = null;
  try {
    const [user, tripCount] = await Promise.all([
      userClient.findById(riderId),
      rideClient.countCompletedByRider(riderId),
    ]);
    value = {
      name: user?.name?.split(' ')[0] ?? undefined,
      rating: user?.riderRating ?? 5,
      tripCount,
    };
  } catch {
    // enrichment is best-effort — the offer must still go out
  }
  riderOfferInfoCache.set(riderId, { at: Date.now(), value });
  return value;
}


function scheduleBidFlush(
  deps: StartGatewayConsumerDeps,
  rideId: string,
  riderId: string,
): void {
  if (pendingBidFlushTimers.has(rideId)) return;

  const timer = setTimeout(() => {
    pendingBidFlushTimers.delete(rideId);
    void (async () => {
      // The ride may have resolved while we waited — meta is deleted by
      // cleanupRideKeys on assign/cancel/timeout, and a rider who accepted
      // meanwhile has left the bidding state. Stay silent in those cases.
      const meta = await getRideMeta(deps.redisClient, rideId);
      const state = await getRideState(deps.redisClient, rideId);
      if (!meta || state !== 'bidding') return;

      const phone = await lookupPhoneByUserId(deps.redisClient, riderId);
      if (!phone || !deps.whatsappNotifier) return;

      if (!(await shouldNotify(deps.redisClient, rideId))) {
        // Another bid beat us to it inside a fresh window; it will flush.
        scheduleBidFlush(deps, rideId, riderId);
        return;
      }

      const previousBatch = await getLastBatch(deps.redisClient, rideId).catch(() => []);
      const allBids = sortOffers(await getBids(deps.redisClient, rideId));
      if (allBids.length === 0) return;

      await storeLastBatch(deps.redisClient, rideId, allBids);
      if (meta.source === 'flow') {
        // The old form's message: not while the rider is on the ride page — sent when they leave.
        if (await isRidePageOpen(deps.redisClient, riderId)) {
          await deferUntilPageLeft(deps.redisClient, riderId, { kind: 'legacy_offers', rideId }).catch(() => undefined);
          return;
        }
        await sendFlowOffersMessage(deps.whatsappNotifier, phone, riderId, meta, allBids)
          .catch((err) => console.warn('[consumer] WhatsApp flow offers message failed', err));
      } else {
        await announceOffers(deps, phone, rideId, riderId, allBids, meta.offerNgn, describeBidChanges(previousBatch, allBids))
          .catch((err) => console.warn('[consumer] WhatsApp bid flush failed', err));
      }
    })();
  }, BID_FLUSH_DELAY_MS);
  timer.unref();

  pendingBidFlushTimers.set(rideId, timer);
}

/**
 * Offers go to the rider's CHAT — always, whether or not the bidding page is
 * open. The page only takes the price; the chat is where offers are seen and
 * taken, because it is the only thing that can buzz a phone in a pocket.
 *
 *   one offer      → a message with an "Accept ₦X" button
 *   several        → one "Choose a driver" list, cheapest first
 *   a group seat   → the numbered text list (a seat is booked by number, and
 *                    confirmed only when every rider picks the same driver)
 *   WhatsApp refuses the tappable message → the numbered text list
 */
export async function announceOffers(
  deps: Pick<StartGatewayConsumerDeps, 'redisClient' | 'whatsappNotifier'> & Partial<StartGatewayConsumerDeps>,
  phone: string,
  rideId: string,
  riderId: string,
  bids: WhatsappBid[],
  riderOfferNgn: number,
  changes?: string[],
): Promise<void> {
  if (!deps.whatsappNotifier) return;
  const groupSeat = await getGroupSeat(deps.redisClient, rideId).catch(() => null);
  // On the ride page, the offers are there as they come: nothing in the chat. The number on
  // "Your bid is in" is put right when they leave.
  if (!groupSeat && await isRidePageOpen(deps.redisClient, riderId)) {
    if (await hasOffersPageMessage(deps.redisClient, rideId).catch(() => false)) {
      await deferUntilPageLeft(deps.redisClient, riderId, { kind: 'offer_count', rideId }).catch(() => undefined);
    }
    return;
  }
  // Just left the page with "Your bid is in" still waiting for the catch-up: that one message
  // now (it carries the offer count), instead of an offers message before it.
  if (!groupSeat && deps.ridePageChat && deps.registry
    && (await pendingCatchup(deps.redisClient, riderId)).some((item) => item.kind === 'search_started' && item.rideId === rideId)) {
    const full = deps as StartGatewayConsumerDeps;
    await deliverCatchup({ redis: deps.redisClient, deliver: (userId, item) => deliverPageCatchup(full, userId, item) }, riderId);
    return;
  }
  // The offers page: the number of offers on "Your bid is in", changing in place.
  if (!groupSeat && await hasOffersPageMessage(deps.redisClient, rideId)) {
    await showOfferCount(offerCountDeps(deps)!, rideId, bids.length);
    return;
  }
  if (!groupSeat) {
    // The offers form: ONE message per search, ever — sent when the bid went in, or
    // by the first offer if that was missed. It opens on the live list and has its
    // own "Check for more offers" row, so no offer after it sends anything.
    if (offersFormIsOn(deps.whatsappNotifier) && await hasOffersMessage(deps.redisClient, rideId)) return;
    const sent = await sendOffersInChat(deps.whatsappNotifier, phone, bids, riderOfferNgn, changes, riderId);
    if (sent === 'form') await markOffersMessageSent(deps.redisClient, rideId).catch(() => undefined);
    if (sent) return;
  }
  await sendBidNotification(deps.whatsappNotifier, phone, bids, riderOfferNgn, changes);
}

/**
 * When does an offer interrupt the rider?
 *
 *   the FIRST offer of a search            → now. They are waiting for exactly this.
 *   an offer CHEAPER than any they've seen → now. It changes their decision.
 *   anything else                          → bundled: one message per 15 seconds.
 *
 * A flat 30-second wait made the first driver feel slow; a message per bid made
 * five drivers re-pricing feel like spam.
 */
export function isUrgentOffer(previousBatch: Pick<WhatsappBid, 'counterOfferNgn'>[], bid: Pick<WhatsappBid, 'counterOfferNgn'>): boolean {
  if (previousBatch.length === 0) return true;
  return bid.counterOfferNgn < Math.min(...previousBatch.map((shown) => shown.counterOfferNgn));
}

/** The car's photo, for the one message that needs it: "has arrived". Null if there is none. */
async function carPhotoFor(deps: StartGatewayConsumerDeps, driverId: string): Promise<string | null> {
  if (!deps.kycStorage) return null;
  try {
    const kyc = await driverClient.findKycSubmission(driverId);
    const key = kyc?.vehicleImageKeys?.[0];
    return key ? await deps.kycStorage.getSignedUrl(key) : null;
  } catch {
    return null;   // never let a missing picture delay "your driver is outside"
  }
}

/** "Your driver is outside": the car, the plate, the trip code. */
async function tellArrivedInChat(deps: StartGatewayConsumerDeps, phone: string, rideId: string, driverId: string | undefined): Promise<void> {
  if (!deps.whatsappNotifier) return;
  const arrivedBid = await getAcceptedBid(deps.redisClient, rideId).catch(() => null);
  // The car as the rider will see it at the kerb: the driver's profile wins
  // over whatever the bid carried (an old "UNKNOWN" placeholder, or nothing).
  const car = driverId ? await driverClient.findById(driverId).catch(() => null) : null;
  await sendDriverArrivedNotification(deps.whatsappNotifier, phone, {
    driverName: arrivedBid?.driverName ?? car?.user?.name?.split(' ')[0] ?? undefined,
    vehicleModel: knownVehicleText(car?.vehicleModel) ?? knownVehicleText(arrivedBid?.vehicleModel),
    vehiclePlate: knownVehicleText(car?.vehiclePlate) ?? knownVehicleText(arrivedBid?.vehiclePlate),
    driverPhone: arrivedBid?.driverPhone,
    carPhotoUrl: driverId ? await carPhotoFor(deps, driverId) : null,
    // The code they give the driver now. Not for a group seat (no code there).
    tripCode: await getGroupSeat(deps.redisClient, rideId).catch(() => null)
      ? null
      : await tripCodeClient.ensure(rideId).catch(() => null),
  }).catch(() => {});
}

/** "Your 3:30 PM ride will start when this one ends." Lagos time. */
export function scheduledHeldText(scheduledFor: string): string {
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Africa/Lagos' }).format(new Date(scheduledFor));
  return `Your ${time} ride will start when this one ends.`;
}

/**
 * A WhatsApp ride for later is due while the rider is busy: it waits, and they
 * are told once — in the chat, or when they leave the ride page. Not outside
 * their 24 h window (a plain message cannot reach them there).
 */
async function tellScheduledRideHeld(deps: StartGatewayConsumerDeps, event: Extract<RideEvent, { eventType: 'SCHEDULED_RIDE_HELD' }>): Promise<void> {
  if (!deps.whatsappNotifier) return;
  if (!(await deps.redisClient.setIfNotExists(`scheduled-ride:${event.rideId}:held-said`, '1', 3 * 24 * 60 * 60).catch(() => true))) return;
  const text = scheduledHeldText(event.scheduledFor);
  if (await isRidePageOpen(deps.redisClient, event.riderId).catch(() => false)) {
    await deferUntilPageLeft(deps.redisClient, event.riderId, { kind: 'scheduled_held', rideId: event.rideId, text }).catch(() => undefined);
    return;
  }
  await sayScheduledHeld(deps, event.riderId, text);
}

/** "Your 3:30 PM ride could not start, so it was cancelled." Lagos time. */
export function scheduledGaveUpText(scheduledFor: string): string {
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Africa/Lagos' }).format(new Date(scheduledFor));
  return `Your ${time} ride could not start, so it was cancelled.`;
}

/**
 * A WhatsApp ride for later the scheduler gave up on (its start could not reach
 * them, or it waited an hour past its time): never silent, said once. In the
 * chat when it can reach them (their window open) and they are not on the ride
 * page; otherwise on the page's Home (state.notice, until seen) and in the app.
 */
async function tellScheduledRideGaveUp(deps: StartGatewayConsumerDeps, event: Extract<RideEvent, { eventType: 'SCHEDULED_RIDE_GAVE_UP' }>): Promise<void> {
  if (!(await deps.redisClient.setIfNotExists(`scheduled-ride:${event.rideId}:gave-up-said`, '1', 3 * 24 * 60 * 60).catch(() => true))) return;
  const text = scheduledGaveUpText(event.scheduledFor);
  const onPage = await isRidePageSeen(deps.redisClient, event.riderId).catch(() => false);
  // isRidePageOpen is also true while a start template waits for their answer: the chat cannot reach them then.
  const chatReaches = !onPage && !(await isRidePageOpen(deps.redisClient, event.riderId).catch(() => false));
  if (chatReaches && await sayScheduledHeld(deps, event.riderId, text)) return;
  await setPageNotice(deps.redisClient, event.riderId, { id: event.rideId, text }).catch(() => undefined);
  await tellAppRider(deps, event.riderId, { title: 'Your ride for later', body: text, type: 'scheduled:cancelled', rideId: event.rideId, inApp: true });
}

async function sayScheduledHeld(deps: StartGatewayConsumerDeps, riderId: string, text: string): Promise<boolean> {
  if (!deps.whatsappNotifier) return false;
  if (!(await whatsappWindowEnd(deps.redisClient, riderId).catch(() => null))) return false;
  const phone = (await lookupPhoneByUserId(deps.redisClient, riderId).catch(() => null)) ?? (await userClient.findById(riderId).catch(() => null))?.phone ?? null;
  if (!phone) return false;
  await sendMetaWhatsappMessage(deps.whatsappNotifier, phone, text).catch(() => {});
  return true;
}

/**
 * What waited while the rider was on the ride page, said now they have left —
 * only if it is still true: the search still on, the booking still standing,
 * the driver still outside.
 */
export async function deliverPageCatchup(deps: StartGatewayConsumerDeps, userId: string, item: CatchupItem): Promise<boolean> {
  if (item.kind === 'scheduled_held') {
    // Still waiting for them (not started, not cancelled meanwhile).
    const waiting = await scheduledRideClient.findById(item.rideId).catch(() => null);
    if (!waiting || waiting.riderId !== userId || waiting.status !== 'SCHEDULED') return false;
    return sayScheduledHeld(deps, userId, item.text);
  }
  const ride = await rideClient.findById(item.rideId).catch(() => null);
  if (!ride || ride.riderId !== userId) return false;
  const countDeps = offerCountDeps(deps);
  /** "Your bid is in" (or the bail's message) shows the offers on the table now, not 0. */
  const showCount = async () => {
    if (countDeps) await showOfferCount(countDeps, item.rideId, (await getBids(deps.redisClient, item.rideId).catch(() => [])).length).catch(() => false);
  };
  if (item.kind === 'arrived') {
    if (ride.status !== 'ARRIVED') return false;
    const phone = await whatsappRiderPhone(deps, userId, item.rideId);
    if (!phone) return false;
    await tellArrivedInChat(deps, phone, item.rideId, item.driverId);
    return true;
  }
  if (item.kind === 'cancelled') {
    // Still cancelled (not revived for another driver).
    if (ride.status !== 'CANCELLED') return false;
    const phone = await whatsappRiderPhone(deps, userId, item.rideId) ?? (await userClient.findById(userId).catch(() => null))?.phone ?? null;
    if (!phone || !deps.whatsappNotifier) return false;
    await sendRideCancelledNotification(deps.whatsappNotifier, phone, item.details as Parameters<typeof sendRideCancelledNotification>[2]).catch(() => {});
    return true;
  }
  if (item.kind === 'booking_failed' && item.ended) {
    if (ride.status !== 'CANCELLED') return false;
    const phone = (await userClient.findById(userId).catch(() => null))?.phone;
    if (!phone || !deps.whatsappNotifier) return false;
    await sendMetaWhatsappMessage(deps.whatsappNotifier, phone, item.text).catch(() => {});
    return true;
  }
  const [active, state] = await Promise.all([
    getActiveRide(deps.redisClient, userId).catch(() => null),
    getRideState(deps.redisClient, item.rideId).catch(() => null),
  ]);
  const inTrip = ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'].includes(ride.status);
  if (item.kind === 'ride_confirmed') {
    // The card, once per ride: never when one was sent already; while the booking stands or the
    // trip is on (it carries the car, the plate, the code, chat, calls and SOS), never once it is over.
    const booked = state === 'confirmed' || state === 'in_progress';
    if ((!booked && !inTrip) || ride.status === 'CANCELLED' || ride.status === 'COMPLETED') return false;
    if (await hasRideCard(deps.redisClient, item.rideId)) return false;
    if (!deps.ridePageChat) return false;
    await deps.ridePageChat(item.event as unknown as RidePageChatEvent);
    return true;
  }
  if (active !== item.rideId) return false;
  const booked = state === 'confirmed' || state === 'in_progress';
  const searching = !booked && (ride.status === 'REQUESTED' || ride.status === 'MATCHING');
  if (item.kind === 'offer_count') {
    // Silent: the number on "Your bid is in", right again now they are back in the chat.
    if (!searching || !countDeps || !(await hasOffersPageMessage(deps.redisClient, item.rideId).catch(() => false))) return false;
    await showCount();
    return true;
  }
  if (item.kind === 'booking_failed') {
    if (booked || !searching) return false;
    const phone = await whatsappRiderPhone(deps, userId, item.rideId);
    if (!phone || !deps.whatsappNotifier) return false;
    await sendMetaWhatsappMessage(deps.whatsappNotifier, phone, item.text).catch(() => {});
    return true;
  }
  if (item.kind === 'driver_cancelled') {
    if (!searching) return false;
    const phone = await whatsappRiderPhone(deps, userId, item.rideId);
    if (!phone || !deps.whatsappNotifier) return false;
    await tellDriverBailedOrCancelled(deps, phone, item.rideId, userId, item.details as Parameters<typeof rideCancelledText>[0], true);
    await showCount();
    return true;
  }
  if (item.kind === 'legacy_offers') {
    const meta = await getRideMeta(deps.redisClient, item.rideId).catch(() => null);
    const bids = sortOffers(await getBids(deps.redisClient, item.rideId).catch(() => []));
    const phone = await whatsappRiderPhone(deps, userId, item.rideId);
    if (!searching || !meta || bids.length === 0 || !phone || !deps.whatsappNotifier) return false;
    await storeLastBatch(deps.redisClient, item.rideId, bids).catch(() => undefined);
    await sendFlowOffersMessage(deps.whatsappNotifier, phone, userId, meta, bids).catch(() => {});
    return true;
  }
  // search_started: "Your bid is in", with the offers already on the table counted on it.
  if (!deps.ridePageChat || !searching) return false;
  try {
    await deps.ridePageChat(item.event as unknown as RidePageChatEvent);
  } catch (error) {
    // A ride for later's start outside their window, the template not sent: nothing reaches them (the page shows it).
    if (error instanceof ChatUnreachableError) return false;
    throw error;
  }
  await showCount();
  return true;
}

/**
 * The search ran out with nobody booked: over in the gateway's eyes. Bidders
 * hear it, their bids expire, the money and any cashback go back, and the
 * rider is told the way a timeout tells them (on the ride page the page says
 * it; with the offers form's button in the chat the form holds it). Used by
 * RIDE_BID_TIMEOUT, and by a booking that was in flight when the clock ran
 * out and then fell through (the timeout had stood aside for it).
 *
 *   toldBooked  the chat was told "booked" (its card, or auto-accept's message):
 *               it hears, once, that the booking did not go through instead
 *   alreadyTold the search had already been ended and said: nothing more is said
 */
async function endTimedOutSearch(
  deps: StartGatewayConsumerDeps,
  rideId: string,
  riderId: string,
  timestamp: string,
  openBids: Array<{ status: string; driverUserId: string }>,
  rideParticipants: Map<string, RideParticipantState>,
  options: { toldBooked?: boolean; cardInChat?: boolean; alreadyTold?: boolean } = {},
): Promise<void> {
  const { registry } = deps;
  // Over in the gateway's eyes: auto-accept never books it (a late bid revives its chat state only).
  await markSearchEnded(deps.redisClient, rideId);
  if (payingStatusEnabled()) await closePaying(deps, rideId, 'search_ended').catch(() => false);
  // A bidder away from the app hears the search ended by push.
  for (const userId of new Set(openBids.filter((bid) => isOpenBid(bid.status)).map((bid) => bid.driverUserId))) {
    await pushDriverIfAway(deps, userId, { title: 'Search ended', body: 'The rider did not choose a driver.', type: 'ride:bid_timeout', rideId, generation: `timed_out@${timestamp}` });
  }

  await driverBidClient.resolvePending(rideId, 'EXPIRED').catch(() => {});

  // Same money cleanup as a cancellation: the fare hold and any reserved
  // referral cashback must go back to the rider now that nobody accepted.
  await walletClient.cancelRideHold(rideId).catch(() => {});
  await referralClient.releaseRideCashback(rideId).catch((error) => {
    console.warn('[gateway] referral cashback release after bid timeout failed', {
      rideId,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  const waRider = await isWhatsappRider(deps.redisClient, riderId);
  if (waRider && deps.whatsappNotifier) {
    const phone = await lookupPhoneByUserId(deps.redisClient, riderId);
    if (phone) {
      const timedOutMeta = await getRideMeta(deps.redisClient, rideId).catch(() => null);
      // Remembered for the offers form: it says "no driver took ₦X" and offers Search again there.
      await markSearchTimedOut(deps.redisClient, riderId, { rideId, offerNgn: timedOutMeta?.offerNgn ?? 0, at: new Date().toISOString() }).catch(() => undefined);
      // On the ride page, the page says the search ended.
      const pageShowsIt = await isRidePageOpen(deps.redisClient, riderId);
      if (options.toldBooked) {
        // The chat said "booked": it hears, once, that it did not go through (on the page: when they leave, if the card was in the chat).
        if (await deps.redisClient.setIfNotExists(`ride:${rideId}:closed-told`, '1', 24 * 60 * 60).catch(() => true)) {
          const text = "That booking didn't go through: the search had ended. Nothing was charged.";
          if (pageShowsIt) {
            if (options.cardInChat) await deferUntilPageLeft(deps.redisClient, riderId, { kind: 'booking_failed', rideId, text, ended: true }).catch(() => undefined);
          } else {
            await sendMetaWhatsappMessage(deps.whatsappNotifier, phone, text).catch(() => {});
          }
        }
      } else if (!options.alreadyTold) {
        // With the form's button already in the chat, the end of the search is not a message:
        // the rider opens the form when they like and finds the two ways forward inside it.
        const formHoldsIt = offersFormIsOn(deps.whatsappNotifier) && await hasOffersMessage(deps.redisClient, rideId);
        if (!formHoldsIt && !pageShowsIt) await sendBidTimeoutNotification(deps.whatsappNotifier, phone, timedOutMeta?.offerNgn).catch(() => {});
      }
    }
    await clearActiveRideIfMatches(deps.redisClient, riderId, rideId);
    await clearPendingAccept(deps.redisClient, riderId).catch(() => {});
    await endOfferCount(deps, rideId);
    await cleanupRideKeys(deps.redisClient, rideId);
    // An app open on the same search (begun on WhatsApp) ends it too.
    await registry.sendToUser(riderId, 'ride:bid_timeout', { rideId });
  } else {
    await registry.sendToUser(riderId, 'ride:bid_timeout', {
      rideId,
    });
    // Said by push as well when the app is closed: a search that ends
    // unseen (a scheduled ride, most of all) must not just vanish.
    if (!registry.hasUser(riderId) && !options.alreadyTold) {
      await tellAppRider(deps, riderId, {
        title: 'No driver accepted your ride',
        body: 'You were not charged. Open Wheelers to search again or change your price.',
        type: 'ride:bid_timeout',
        rideId,
        inApp: true,
      });
    }
  }
  rideParticipants.delete(rideId);
}

/** Cancelled only by the search clock (not the rider, not the system): an acceptance may still revive it. */
function isTimedOutOnly(ride: { status: string; cancelStage?: string | null; cancelReason?: string | null } | null | undefined): boolean {
  return ride?.status === 'CANCELLED' && ride.cancelStage === 'BEFORE_MATCH' && ride.cancelReason === SEARCH_TIMED_OUT_REASON;
}

/**
 * The driver the rider chose was busy, and the search had timed out while
 * that acceptance was on its way (the timeout stood aside for it). Nothing
 * else will end this search now: that driver's money goes back, the booking
 * marks go, and the rider hears the search ended (or, when the chat was told
 * "booked", that it did not go through). Inside the ride's booking lock, so a
 * new accept never has its state cleaned away; waited for as long as the lock
 * can live, so the money is never left held.
 */
async function busyAfterSearchTimedOut(
  deps: StartGatewayConsumerDeps,
  event: { rideId: string; riderId: string; driverId: string; driverUserId: string; timestamp: string },
  rideParticipants: Map<string, RideParticipantState>,
): Promise<void> {
  const { registry } = deps;
  const lock = await takeBookingLock(deps.redisClient, event.rideId, BOOKING_LOCK_HOLD_MS);
  try {
    // Looked at again inside the lock: an accept that went through meanwhile (the ride revived,
    // another driver's money held or acceptance sent) is left alone.
    const [ride, hold, sentFor, publishing] = await Promise.all([
      rideClient.findById(event.rideId).catch(() => null),
      walletClient.rideHoldOf(event.rideId).catch(() => null),
      acceptSentFor(deps.redisClient, event.rideId),
      acceptPublishingFor(deps.redisClient, event.rideId),
    ]);
    if (!isTimedOutOnly(ride)) return;
    if (hold?.status === 'ACTIVE' && hold.driverUserId != null && hold.driverUserId !== event.driverUserId) return;
    if ((sentFor && sentFor !== event.driverUserId) || (publishing && publishing !== event.driverUserId)) return;

    await walletClient.cancelRideHold(event.rideId, event.driverUserId).catch(() => {});
    const byAutoAccept = (await autoBookedDriver(deps.redisClient, event.rideId)) === event.driverId;
    const autoToldChat = byAutoAccept && await autoAcceptToldChat(deps.redisClient, event.rideId);
    const cardWasSent = await hasRideCard(deps.redisClient, event.rideId);
    const state = await getRideState(deps.redisClient, event.rideId).catch(() => null);
    // The booking's card went to the chat: its light goes off.
    const cardDeps = offerCountDeps(deps);
    if (cardWasSent && cardDeps) await setCardStatus(cardDeps, event.rideId, 'none').catch(() => false);
    await clearAcceptSent(deps.redisClient, event.rideId);
    await clearAutoAcceptBooked(deps.redisClient, event.rideId);
    if (!byAutoAccept) {
      void registry.sendToUser(event.riderId, 'ride:accept_offer:rejected', {
        rideId: event.rideId,
        driverId: event.driverId,
        reason: 'driver_unavailable',
        message: 'That driver is no longer available.',
      });
    }
    // Ended and said already (the timeout ran in full before a late accept): only "it did not go through", if "booked" was said.
    const alreadyTold = await isSearchEnded(deps.redisClient, event.rideId);
    const openBids = await driverBidClient.findByRide(event.rideId).catch(() => []);
    for (const bid of openBids) {
      if (!isOpenBid(bid.status)) continue;
      void registry.sendToUser(bid.driverUserId, 'ride:bid_timeout', { rideId: event.rideId, reason: 'timed_out' });
    }
    await endTimedOutSearch(deps, event.rideId, event.riderId, event.timestamp, openBids, rideParticipants, {
      toldBooked: cardWasSent || autoToldChat || state === 'confirmed',
      cardInChat: cardWasSent || autoToldChat,
      alreadyTold,
    });
  } finally {
    await releaseBookingLock(deps.redisClient, lock);
  }
}

/** A car's model or plate worth showing a rider — never a placeholder. */
function knownVehicleText(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text && !/^unknown$/i.test(text) ? text : undefined;
}

/**
 * Still in the search: waiting on the rider, or declined by them (a declined
 * driver's card stays live and red — they can bid again). When the ride is
 * taken, cancelled or times out, both are told.
 */
function isOpenBid(status: string): boolean {
  return status === 'PENDING' || status === 'DECLINED';
}

const PUSH_DEDUPE_SECONDS = 10 * 60;
/** The claim before the send: short, so a process dying mid-send loses the push for seconds, not minutes. */
const PUSH_CLAIM_SECONDS = 30;
/**
 * Away = no socket. With DRIVER_STATUS_PUSHES_ENABLED also: the app said it is
 * in the background (app:state, a short-lived flag the app refreshes). A
 * presence check that fails counts as away: a banner too many beats a driver
 * who never hears.
 */
async function driverIsAway(deps: Pick<StartGatewayConsumerDeps, 'registry' | 'redisClient' | 'driverStatusPushes'>, driverUserId: string): Promise<boolean> {
  try {
    if (!(await deps.registry.isUserConnected(driverUserId))) return true;
  } catch {
    return true;
  }
  if (!deps.driverStatusPushes) return false;
  try {
    return (await deps.redisClient.get(appBackgroundKey(driverUserId))) !== null;
  } catch {
    return true;
  }
}

/**
 * A push to a driver whose app is not connected; a connected app has the
 * socket message and needs no banner on top. Never throws.
 */
async function pushDriverIfAway(
  deps: StartGatewayConsumerDeps,
  driverUserId: string,
  /**
   * `generation` names this piece of news: the same event delivered again (or a
   * second event saying the same thing) is one banner, real news is another —
   * a new price, another driver booked, a later booking.
   */
  message: { title: string; body: string; type: string; rideId: string; generation: string },
): Promise<void> {
  if (!(await driverIsAway(deps, driverUserId))) return;
  const key = `push:driver:${message.rideId}:${driverUserId}:${message.type}:${message.generation}`;
  // Claimed before sending (atomic), so two events at once give one banner; given back if the send fails.
  const claimed = await deps.redisClient.setIfNotExists(key, '1', PUSH_CLAIM_SECONDS).catch(() => true);
  if (!claimed) return;
  const sent = await deps.publisher.publishNotificationEvent({
    eventType: 'PUSH_SEND',
    notificationId: randomUUID(),
    userId: driverUserId,
    title: message.title,
    body: message.body,
    data: { type: message.type, rideId: message.rideId },
    priority: 'high',
    timestamp: new Date().toISOString(),
  }).then(() => true, () => false);
  // A push that failed is tried again on redelivery.
  if (sent) await deps.redisClient.set(key, '1', PUSH_DEDUPE_SECONDS).catch(() => undefined);
  else await deps.redisClient.del(key).catch(() => undefined);
}

/** What auto-accept needs from the consumer: Redis, the publisher, and the rider's app to tell. */
function autoAcceptDeps(deps: StartGatewayConsumerDeps): AutoAcceptDeps {
  return { redisClient: deps.redisClient, publisher: deps.publisher, registry: deps.registry, ...(deps.ridePageChat ? { tellChat: deps.ridePageChat } : {}) };
}

/**
 * ride:search_status to the rider's app: how many drivers saw the request and
 * when the search closes. A broadcast reaches many drivers in one burst; the
 * rider gets one message for it, a moment after the last (all of a ride's
 * events reach the same process: they share a Kafka key).
 */
export const SEARCH_STATUS_DELAY_MS = 250;
const searchStatusTimers = new Map<string, NodeJS.Timeout>();
function sendSearchStatusSoon(deps: StartGatewayConsumerDeps, riderId: string, rideId: string, status: { driversNotified: number | null; bidsCloseAt: string | null }): void {
  const before = searchStatusTimers.get(rideId);
  if (before) clearTimeout(before);
  const timer = setTimeout(() => {
    searchStatusTimers.delete(rideId);
    void Promise.resolve().then(() => deps.registry.sendToUser(riderId, 'ride:search_status', { rideId, ...status })).catch(() => undefined);
  }, SEARCH_STATUS_DELAY_MS);
  timer.unref?.();
  searchStatusTimers.set(rideId, timer);
}

/**
 * The ride is cancelled (or its driver bailed and the search goes on): one message.
 * A bail's message carries "See driver offers" and becomes the search's offers message.
 */
async function tellDriverBailedOrCancelled(
  deps: StartGatewayConsumerDeps,
  phone: string,
  rideId: string,
  riderId: string,
  details: Parameters<typeof rideCancelledText>[0],
  driverBailed: boolean,
): Promise<void> {
  if (!deps.whatsappNotifier) return;
  const pageUrl = driverBailed ? deps.ridePageUrlFor?.(riderId) ?? null : null;
  const countDeps = offerCountDeps(deps);
  const sentWithButton = pageUrl && countDeps
    ? await sendOffersPageMessage(countDeps, phone, rideId, pageUrl, { pickupAddress: '', destAddress: '' }, rideCancelledText(details, { withOffersButton: true }))
        .catch(() => false)
    : false;
  if (sentWithButton) {
    await markOffersMessageSent(deps.redisClient, rideId).catch(() => undefined);
  } else {
    await sendRideCancelledNotification(deps.whatsappNotifier, phone, details).catch(() => {});
  }
}

/** One ride event, as the Kafka loop feeds it. Exported for the tests that replay events. */
/** A search the scheduler started: its offers belong to the app, never to WhatsApp. Remembered a little longer than a search can run. */
const APP_ONLY_RIDE_TTL_SECONDS = 2 * 60 * 60;
const appOnlyRideKey = (rideId: string) => `ride:${rideId}:app-only`;
const isAppOnlyRide = async (deps: StartGatewayConsumerDeps, rideId: string) =>
  (await deps.redisClient.get(appOnlyRideKey(rideId)).catch(() => null)) === '1';

/** True the first time it is asked for a ride: one "a driver made an offer" push per search, not one per offer. */
async function firstOfferPush(deps: StartGatewayConsumerDeps, rideId: string): Promise<boolean> {
  const key = `ride:${rideId}:offer-push`;
  try {
    if (await deps.redisClient.get(key)) return false;
    await deps.redisClient.set(key, '1', APP_ONLY_RIDE_TTL_SECONDS);
    return true;
  } catch {
    return false;
  }
}

/** A push to the rider's phone, and the same line in the app's notifications when it should stay on record. Never throws. */
async function tellAppRider(
  deps: StartGatewayConsumerDeps,
  riderId: string,
  message: { title: string; body: string; type: string; rideId: string; inApp?: boolean },
): Promise<void> {
  const timestamp = new Date().toISOString();
  await deps.publisher.publishNotificationEvent({
    eventType: 'PUSH_SEND',
    notificationId: randomUUID(),
    userId: riderId,
    title: message.title,
    body: message.body,
    data: { type: message.type, rideId: message.rideId },
    priority: 'high',
    timestamp,
  }).catch(() => {});
  if (message.inApp) {
    await deps.publisher.publishNotificationEvent({
      eventType: 'IN_APP_SEND',
      notificationId: randomUUID(),
      userId: riderId,
      title: message.title,
      body: message.body,
      category: 'ride',
      read: false,
      timestamp,
    }).catch(() => {});
  }
}

export async function handleRideEvent(
  event: RideEvent,
  deps: StartGatewayConsumerDeps,
  rideParticipants: Map<string, RideParticipantState>,
): Promise<void> {
  const registry = deps.registry;
  if (event.eventType === 'RIDE_REQUESTED') {
    rideParticipants.set(event.rideId, { riderId: event.riderId });
    // A ride booked for later has just started looking for drivers. The rider
    // did not start it and is not looking at the app, and no driver is theirs
    // until they pick one: without this they never knew, and the search died.
    if (event.scheduled) {
      // Booked on the WhatsApp ride page: a WhatsApp search (the page shows it, the chat says
      // "Your bid is in"), or it waits while the rider is busy. Never the app's: only when the
      // account has no phone at all is the app the one way left to reach them.
      if (event.channel === 'WHATSAPP' && (await startScheduledWhatsappSearch(deps, event)) !== 'app') return;
      // The rider picks the driver: auto-accept is off for every ride for later.
      await autoAcceptOffAtStart(deps.redisClient, event.rideId, event.riderId).catch(() => undefined);
      await deps.redisClient.set(appOnlyRideKey(event.rideId), '1', APP_ONLY_RIDE_TTL_SECONDS).catch(() => undefined);
      await tellAppRider(deps, event.riderId, {
        title: 'Your scheduled ride',
        body: 'We are finding your driver now. Open Wheelers to see the offers and choose one.',
        type: 'ride:scheduled_started',
        rideId: event.rideId,
        inApp: true,
      });
    }
    return;
  }

  if (event.eventType === 'SCHEDULED_RIDE_HELD') {
    await tellScheduledRideHeld(deps, event);
    return;
  }

  if (event.eventType === 'SCHEDULED_RIDE_GAVE_UP') {
    await tellScheduledRideGaveUp(deps, event);
    return;
  }

  if (event.eventType === 'RIDE_OFFER_SENT') {
    // Drivers commit a car and half an hour to this request — it carries a
    // person, not just coordinates. Cached per rider: one broadcast fans out
    // to up to five drivers and must not cost five identical lookups.
    const riderInfo = await getRiderOfferInfo(event.riderId);

    await registry.sendToUser(event.driverUserId, 'ride:offer', {
      rideId: event.rideId,
      riderId: event.riderId,
      riderName: riderInfo?.name,
      riderRating: riderInfo?.rating,
      riderTripCount: riderInfo?.tripCount,
      bidsCloseAt: event.bidsCloseAt ?? event.expiresAt,
      pickup: event.pickup,
      destination: event.destination,
      stops: event.stops,
      fareEstimateNgn: event.fareEstimateNgn,
      paymentMethod: event.paymentMethod,
      riderOfferNgn: event.riderOfferNgn,
      suggestedFareNgn: event.suggestedFareNgn,
      // The floor, so the app can say it BEFORE a bid is typed.
      minOfferNgn: event.minOfferNgn,
      ratePerKmNgn: event.ratePerKmNgn,
      // What a price is made of, so the app can show every price as the
      // driver's rate per km and what they would receive: the rules in force
      // (version 2: VAT and the booking fee are in the rider's fare), the
      // highest fare a driver may ask, and the same limits as rates per km.
      bookingFeeNgn: BOOKING_FEE_NGN,
      pricingVersion: CURRENT_PRICING_VERSION,
      ...driverBidLimits(event.suggestedFareNgn ?? event.fareEstimateNgn, event.plannedDistanceKm),
      plannedDistanceKm: event.plannedDistanceKm,
      plannedDurationSeconds: event.plannedDurationSeconds,
      pickupDistanceKm: event.pickupDistanceKm,
      pickupEtaSeconds: event.pickupEtaSeconds,
      // "Next ride — near your drop-off": they are mid-trip, this is a queue.
      afterCurrentTrip: event.afterCurrentTrip ?? false,
      expiresAt: event.expiresAt,
      route: event.route,
      isGroupRide: event.isGroupRide ?? false,
      riderCount: event.riderCount ?? 1,
      stopKinds: event.stopKinds ?? [],
      groupMembers: event.groupMembers ?? [],
    });
    // The rider's waiting screen: drivers who saw the price, and the search's clock.
    const status = await noteOfferSent(deps.redisClient, event.rideId, event.driverId, event.bidsCloseAt ?? event.expiresAt).catch(() => null);
    if (status?.changed) sendSearchStatusSoon(deps, event.riderId, event.rideId, { driversNotified: status.driversNotified, bidsCloseAt: status.bidsCloseAt });
    // The rider changed their price: a driver away from the app hears it by push.
    if (event.repriced) {
      await pushDriverIfAway(deps, event.driverUserId, {
        title: `New price ₦${Math.round(event.riderOfferNgn ?? 0).toLocaleString('en-NG')}`,
        body: `${event.pickup.address} → ${event.destination.address}`,
        type: 'ride:offer_updated',
        rideId: event.rideId,
        // Each price change restarts the clock: the price and its clock name it.
        generation: `${event.riderOfferNgn ?? 0}@${event.bidsCloseAt ?? event.expiresAt}`,
      });
    }
    return;
  }

  if (event.eventType === 'RIDE_COUNTER_OFFER') {
    const waRiderByPointer = await isWhatsappRider(deps.redisClient, event.riderId);
    let waRider = waRiderByPointer;
    if (!waRider && deps.whatsappNotifier) {
      // isWhatsappRider keys on the active-ride entry — which the
      // bid-timeout cleanup deletes. A late bid then looked like it belonged
      // to an app rider and the WhatsApp rider heard nothing. But a phone on
      // file alone is not proof: an app rider who chatted with the bot
      // yesterday had their whole ride hijacked to WhatsApp. Fall back only
      // when this ride has WhatsApp state or the rider has no live app socket.
      const hasPhone = (await lookupPhoneByUserId(deps.redisClient, event.riderId)) !== null;
      const hasWaMeta = hasPhone && (await getRideMeta(deps.redisClient, event.rideId)) !== null;
      waRider = hasPhone && (hasWaMeta || !registry.hasUser(event.riderId));
      // A scheduled ride was booked in the app: its offers stay in the app,
      // even when the rider chatted with the bot today and the app is closed.
      if (waRider && !hasWaMeta && await isAppOnlyRide(deps, event.rideId)) waRider = false;
    }
    console.info('[consumer] counter-offer', {
      rideId: event.rideId,
      driver: event.driverName,
      offerNgn: event.counterOfferNgn,
      waRider,
      hasNotifier: !!deps.whatsappNotifier,
    });
    // Booked by auto-accept on this offer: then nobody is asked to choose.
    let autoBooked = false;
    if (waRider && deps.whatsappNotifier) {
      const bid: WhatsappBid = {
        bidId: event.bidId,
        driverId: event.driverId,
        driverUserId: event.driverUserId,
        counterOfferNgn: event.counterOfferNgn,
        driverName: event.driverName,
        driverRating: event.driverRating,
        vehiclePlate: event.vehiclePlate,
        vehicleModel: event.vehicleModel,
        etaSeconds: event.etaSeconds,
        distanceKm: event.distanceKm,
        receivedAt: new Date().toISOString(),
      };
      await addBid(deps.redisClient, event.rideId, bid);
      await setRideState(deps.redisClient, event.rideId, 'bidding');

      const phone = await lookupPhoneByUserId(deps.redisClient, event.riderId);
      let meta = await getRideMeta(deps.redisClient, event.rideId);
      if (phone && !meta) {
        // A LATE bid: the bid-timeout cleanup wiped this ride's WhatsApp
        // state, but a driver has just put money on the table — the request
        // is not dead until somebody actually takes the rider somewhere.
        // Rebuild the ride's chat state from the DB (only while the ride is
        // still winnable) and put the rider back into the bidding flow, so
        // this offer reaches them and "pay" still works.
        const ride = await rideClient.findById(event.rideId).catch(() => null);
        const winnable =
          ride &&
          (ride.status === 'REQUESTED' ||
            ride.status === 'MATCHING' ||
            (ride.status === 'CANCELLED' && ride.cancelStage === 'BEFORE_MATCH'));
        if (winnable && ride) {
          const offerNgn = Number(ride.riderOfferNgn ?? ride.fareEstimateNgn ?? event.counterOfferNgn);
          meta = {
            riderId: event.riderId,
            phone,
            pickupAddress: ride.pickupAddress,
            pickupLat: ride.pickupLat ?? undefined,
            pickupLng: ride.pickupLng ?? undefined,
            destinationAddress: ride.destAddress,
            destinationLat: ride.destLat ?? undefined,
            destinationLng: ride.destLng ?? undefined,
            distanceKm: ride.distanceKm ?? undefined,
            durationSeconds: ride.durationSeconds ?? undefined,
            offerNgn,
            suggestedFareNgn: Number(ride.fareEstimateNgn ?? offerNgn),
            paymentMethod: ride.paymentMethod === 'CASH' ? 'CASH' : 'WALLET',
            createdAt: new Date().toISOString(),
          };
          // storeWhatsappRide resets the bid list and state — put this
          // bid (already added above) and the bidding state back after it.
          await storeWhatsappRide(deps.redisClient, event.rideId, meta);
          await addBid(deps.redisClient, event.rideId, bid);
          await setRideState(deps.redisClient, event.rideId, 'bidding');
          // Never yank the pointer off a ride the rider has since started.
          const currentActive = await getActiveRide(deps.redisClient, event.riderId).catch(() => null);
          if (!currentActive || currentActive === event.rideId) {
            await setActiveRide(deps.redisClient, event.riderId, event.rideId);
          }
        }
      }
      console.info('[consumer] counter-offer state', {
        rideId: event.rideId,
        hasPhone: !!phone,
        hasMeta: !!meta,
        source: meta?.source ?? null,
      });
      // Auto-accept first: an offer it books is not announced as one to choose.
      if (meta) autoBooked = (await tryAutoAccept(autoAcceptDeps(deps), event.rideId).catch(() => ({ booked: false }))).booked;
      if (phone && meta && !autoBooked) {
        const previousBatch = await getLastBatch(deps.redisClient, event.rideId).catch(() => []);
        const urgent = isUrgentOffer(previousBatch, bid);
        if (urgent) await noteNotified(deps.redisClient, event.rideId).catch(() => undefined);
        if (urgent || await shouldNotify(deps.redisClient, event.rideId)) {
          // Fetch ALL bids and send as one batched message — naming what
          // changed since the last message the rider actually saw.
          const allBids = sortOffers(await getBids(deps.redisClient, event.rideId));
          const changes = describeBidChanges(previousBatch, allBids);
          await storeLastBatch(deps.redisClient, event.rideId, allBids);
          if (meta.source === 'flow') {
            // Bidding lives on the offers screen; each debounced batch sends
            // a 'View offers' button that re-opens the flow on current bids.
            // The old form's message: not while the rider is on the ride page — sent when they leave.
            if (await isRidePageOpen(deps.redisClient, event.riderId)) {
              await deferUntilPageLeft(deps.redisClient, event.riderId, { kind: 'legacy_offers', rideId: event.rideId }).catch(() => undefined);
            } else {
              console.info('[consumer] sending flow offers message', { rideId: event.rideId, bids: allBids.length });
              await sendFlowOffersMessage(deps.whatsappNotifier, phone, event.riderId, meta, allBids)
                .catch((err) => console.warn('[consumer] WhatsApp flow offers message failed', err));
            }
          } else {
            await announceOffers(deps, phone, event.rideId, event.riderId, allBids, meta.offerNgn, changes)
              .catch((err) => console.warn('[consumer] WhatsApp bid notification failed', err));
          }
        } else {
          // Debounced. The bid is in Redis but the rider has NOT seen it — and
          // acceptance reads getLastBatch (what was actually sent), so a bid
          // that is never flushed is not just invisible, it is unacceptable.
          // That was the hole: a driver re-bidding within 30s of the previous
          // notification vanished from the rider's view forever. Flush once
          // the debounce window ends.
          scheduleBidFlush(deps, event.rideId, event.riderId);
        }
      }
    }
    // An app rider's offer: auto-accept first too (the bid row is already there), so a
    // booked offer is not pushed as "Open Wheelers to accept".
    if (!autoBooked) autoBooked = (await tryAutoAccept(autoAcceptDeps(deps), event.rideId).catch(() => ({ booked: false }))).booked;
    if (!waRiderByPointer) {
      // An app rider — or one we could not tell apart — always gets the
      // socket event; sending to a rider with no socket is a no-op.
      await registry.sendToUser(event.riderId, 'ride:counter_offer', {
        rideId: event.rideId,
        bidId: event.bidId,
        driverId: event.driverId,
        driverUserId: event.driverUserId,
        counterOfferNgn: event.counterOfferNgn,
        driverName: event.driverName,
        driverRating: event.driverRating,
        vehiclePlate: event.vehiclePlate,
        vehicleModel: event.vehicleModel,
        etaSeconds: event.etaSeconds,
        distanceKm: event.distanceKm,
      });
      // The socket only reaches an open app. With the app closed, the first
      // offer of a search is a push, so the rider knows to come and choose.
      if (!autoBooked && !waRider && !registry.hasUser(event.riderId) && await firstOfferPush(deps, event.rideId)) {
        await tellAppRider(deps, event.riderId, {
          title: 'A driver made an offer',
          body: `${event.driverName} offered ₦${Math.round(event.counterOfferNgn).toLocaleString('en-NG')}. Open Wheelers to accept or see more offers.`,
          type: 'ride:offer',
          rideId: event.rideId,
        });
      }
    }
    return;
  }

  if (event.eventType === 'RIDE_RIDER_COUNTER_OFFER') {
    // Confirm to the rider (for app riders on WebSocket)
    await registry.sendToUser(event.riderId, 'ride:rider_counter_offer:confirmed', {
      rideId: event.rideId,
      driverId: event.driverId,
      counterOfferNgn: event.counterOfferNgn,
    });
    // Driver notification is handled when ride-service re-broadcasts RIDE_OFFER_SENT
    // with the updated riderOfferNgn — the RIDE_OFFER_SENT handler above bridges to WhatsApp.
    // The rider's own price moved (not a haggle with one driver): auto-accept follows it,
    // or switches off when the wallet no longer covers it.
    if (!event.driverId) await autoAcceptPriceChanged(autoAcceptDeps(deps), event.rideId, event.counterOfferNgn).catch(() => undefined);
    return;
  }

  if (event.eventType === 'RIDE_OFFER_ACCEPTED') {
    await registry.sendToUser(event.driverUserId, 'ride:offer_accepted', {
      rideId: event.rideId,
      riderId: event.riderId,
      agreedFareNgn: event.agreedFareNgn,
      paymentMethod: event.paymentMethod,
    });
    return;
  }

  if (event.eventType === 'RIDE_BID_TIMEOUT') {
    // FIRST: the rider CHOSE a driver and is adding money for them. This search
    // is not over, it is waiting on a bank transfer — nobody is told anything,
    // least of all that driver, whose card must not read "timed out" while the
    // rider is paying for them. The ride service accepts a driver after its
    // own timeout (it revives the ride), so the deposit landing still confirms
    // them; the chat state is kept for as long as the choice lives.
    const pendingAccept = await getPendingAccept(deps.redisClient, event.riderId).catch(() => null);
    if (pendingAccept?.rideId === event.rideId) {
      console.info('[gateway] bid timeout held — rider is paying for a chosen driver', { rideId: event.rideId, driverId: pendingAccept.driverId });
      return;
    }
    // One booking step at a time on this ride: an accept between its hold and its "sent" mark holds
    // this lock, so the clock never releases a hold an acceptance is about to stand on. Still busy
    // after the wait: an accept is in flight. Nothing is released; if that booking falls through,
    // its RIDE_ASSIGNMENT_FAILED ends the search (see endTimedOutSearch).
    const timeoutLock = await takeBookingLock(deps.redisClient, event.rideId, BOOKING_LOCK_WAIT_MS);
    if (!timeoutLock) {
      console.info('[gateway] bid timeout ignored — a booking is in progress', { rideId: event.rideId });
      return;
    }
    try {
      // An acceptance went out, is being published (or the ride is confirmed) just as the clock ran out:
      // the booking stands — no hold released, no "no driver", nothing cleaned up. The assignment revives the ride.
      const acceptedFor = await acceptSentFor(deps.redisClient, event.rideId);
      const publishing = await acceptPublishingFor(deps.redisClient, event.rideId);
      const timedOutState = await getRideState(deps.redisClient, event.rideId).catch(() => null);
      if (acceptedFor || publishing || timedOutState === 'confirmed' || timedOutState === 'in_progress') {
        console.info('[gateway] bid timeout ignored — an acceptance is going through', { rideId: event.rideId });
        return;
      }

      // The rider is told "no driver found" — but the DRIVERS who bid were
      // never told anything, so their apps showed "waiting for rider" forever
      // over an auction that no longer existed. The bids table knows exactly
      // who has money on this table; tell each of them before resolving.
      const openBids = await driverBidClient.findByRide(event.rideId).catch(() => []);
      for (const bid of openBids) {
        if (!isOpenBid(bid.status)) continue;
        void registry.sendToUser(bid.driverUserId, 'ride:bid_timeout', {
          rideId: event.rideId,
          reason: 'timed_out',
        });
      }

      // A sweep tick landing between an accept and the assignment write used
      // to release the just-created hold. Only an unmatched ride times out.
      const timedOutRide = await rideClient.findById(event.rideId).catch(() => null);
      if (timedOutRide && !['REQUESTED', 'MATCHING', 'CANCELLED'].includes(timedOutRide.status)) {
        console.info('[gateway] bid timeout ignored — ride already matched', {
          rideId: event.rideId,
          status: timedOutRide.status,
        });
        return;
      }
      await endTimedOutSearch(deps, event.rideId, event.riderId, event.timestamp, openBids, rideParticipants);
      return;
    } finally {
      await releaseBookingLock(deps.redisClient, timeoutLock);
    }
  }

  if (event.eventType === 'RIDE_BIDS_DECLINED') {
    const countDeps = offerCountDeps(deps);
    // On the ride page the number on "Your bid is in" is put right when they leave.
    if (countDeps && await isRidePageOpen(deps.redisClient, event.riderId)) {
      if (await hasOffersPageMessage(deps.redisClient, event.rideId).catch(() => false)) {
        await deferUntilPageLeft(deps.redisClient, event.riderId, { kind: 'offer_count', rideId: event.rideId }).catch(() => undefined);
      }
    } else if (countDeps) await showOfferCount(countDeps, event.rideId, event.remainingOffers ?? 0).catch(() => false);
    // The rider declined (one offer or all): each driver's card turns to
    // "Declined" and they can send a new price. Away from the app: a push.
    for (const userId of new Set(event.driverUserIds)) {
      void registry.sendToUser(userId, 'ride:bid_declined', { rideId: event.rideId });
      if (payingStatusEnabled()) await closePaying(deps, event.rideId, 'declined', userId).catch(() => false);
      if (deps.driverStatusPushes) {
        // Deduped like the other driver pushes, and a backgrounded app counts as away.
        await pushDriverIfAway(deps, userId, { title: 'Offer declined', body: 'Send a new price.', type: 'bid_declined', rideId: event.rideId, generation: `declined@${event.timestamp}` });
        continue;
      }
      if (!(await driverIsAway(deps, userId))) continue;
      await deps.publisher.publishNotificationEvent({
        eventType: 'PUSH_SEND',
        notificationId: randomUUID(),
        userId,
        title: 'Offer declined',
        body: 'Send a new price.',
        data: { type: 'bid_declined', rideId: event.rideId },
        priority: 'high',
        timestamp: new Date().toISOString(),
      }).catch(() => {});
    }
    return;
  }

  // The driver the rider chose could not be given the ride (ride-service).
  if (event.eventType === 'RIDE_ASSIGNMENT_FAILED') {
    // The driver the rider was paying for cannot be booked: their card stops saying so.
    if (payingStatusEnabled()) await closePaying(deps, event.rideId, 'failed', event.driverUserId).catch(() => false);
    if (event.reason === 'ride_closed') {
      const ride = await rideClient.findById(event.rideId).catch(() => null);
      if (ride?.status !== 'CANCELLED') {
        // Another driver has this ride (or it is over): that trip is left
        // exactly as it is; this driver only hears they did not get it.
        void registry.sendToUser(event.driverUserId, 'ride:bid_lost', { rideId: event.rideId, reason: 'booked_other' });
        // The money this driver's accept held (if it is still theirs) goes back; the winner's hold is another driver's and stays.
        const losingHold = await walletClient.rideHoldOf(event.rideId).catch(() => null);
        if (losingHold?.status === 'ACTIVE' && losingHold.driverUserId === event.driverUserId) {
          await walletClient.cancelRideHold(event.rideId, event.driverUserId).catch(() => {});
        }
        await pushDriverIfAway(deps, event.driverUserId, { title: 'Not chosen', body: 'Another driver got this ride.', type: 'ride:bid_lost', rideId: event.rideId, generation: `won_by:${ride?.driverId ?? 'none'}` });
        return;
      }
      // The rider ended it first and was told then; the driver, told they
      // won, hears it is off. Undo what the assignment re-set for WhatsApp,
      // and any hold an assignment re-armed (released once, whoever is first).
      void registry.sendToUser(event.driverUserId, 'ride:cancelled', { rideId: event.rideId, reason: 'rider_cancelled', cancelledBy: 'rider' });
      // A WhatsApp rider the chat told "booked" (the card went out, or the booking stood) hears it did not, once.
      const toldBooked = (await hasRideCard(deps.redisClient, event.rideId)) || (await getRideState(deps.redisClient, event.rideId).catch(() => null)) === 'confirmed';
      const closedPhone = toldBooked ? await whatsappRiderPhone(deps, event.riderId, event.rideId).catch(() => null) : null;
      if (closedPhone && deps.whatsappNotifier && await deps.redisClient.setIfNotExists(`ride:${event.rideId}:closed-told`, '1', 24 * 60 * 60).catch(() => true)) {
        const text = "That booking didn't go through: the search had ended. Nothing was charged.";
        if (await isRidePageOpen(deps.redisClient, event.riderId)) {
          await deferUntilPageLeft(deps.redisClient, event.riderId, { kind: 'booking_failed', rideId: event.rideId, text, ended: true }).catch(() => undefined);
        } else {
          await sendMetaWhatsappMessage(deps.whatsappNotifier, closedPhone, text).catch(() => {});
        }
        const cardDeps = offerCountDeps(deps);
        if (cardDeps) await setCardStatus(cardDeps, event.rideId, 'none').catch(() => false);
      }
      // No booking stands on a closed ride: its acceptance mark goes too.
      await clearAcceptSent(deps.redisClient, event.rideId);
      // Closed by the search clock while this acceptance was on its way (the gateway's timeout stood
      // aside for it): the search ends here, as the timeout would have ended it (said once, above, if
      // the chat was told "booked").
      if (isTimedOutOnly(ride) && !(await isSearchEnded(deps.redisClient, event.rideId))) {
        const closedBids = await driverBidClient.findByRide(event.rideId).catch(() => []);
        await endTimedOutSearch(deps, event.rideId, event.riderId, event.timestamp, closedBids, rideParticipants, { alreadyTold: toldBooked });
      }
      await walletClient.cancelRideHold(event.rideId).catch(() => {});
      await clearActiveRideIfMatches(deps.redisClient, event.riderId, event.rideId).catch(() => undefined);
      await cleanupRideKeys(deps.redisClient, event.rideId).catch(() => undefined);
      return;
    }
    // driver_busy: the search goes on. The money comes back, the driver's
    // offer goes, and the rider picks another.
    await driverBidClient.markWithdrawn(event.rideId, event.driverId).catch(() => {});
    void registry.sendToUser(event.driverUserId, 'ride:bid_lost', { rideId: event.rideId });
    // Only once, and only while this driver is still the one being booked: a
    // late or repeated event must not undo the rider's next choice (their
    // hold, their WhatsApp state) or say "couldn't take this ride" twice.
    const [busyRide, hold] = await Promise.all([
      rideClient.findById(event.rideId).catch(() => null),
      walletClient.rideHoldOf(event.rideId).catch(() => null),
    ]);
    const stillChoosing = busyRide?.status === 'REQUESTED' || busyRide?.status === 'MATCHING';
    const holdIsAnothers = hold?.status === 'ACTIVE' && hold.driverUserId != null && hold.driverUserId !== event.driverUserId;
    const first = await deps.redisClient.setIfNotExists(`ride:${event.rideId}:busy:${event.driverId}`, '1', 120).catch(() => true);
    // The search clock ran out while this acceptance was on its way (the timeout stood aside for it),
    // and the driver could not take it: nothing else will end this search, so it ends here.
    if (isTimedOutOnly(busyRide) && !holdIsAnothers && first) {
      await busyAfterSearchTimedOut(deps, event, rideParticipants);
      return;
    }
    if (!stillChoosing || holdIsAnothers || !first) return;
    await walletClient.cancelRideHold(event.rideId, event.driverUserId).catch(() => {});
    // Booked by auto-accept, not by a tap: nobody is told an accept was refused that they never made.
    const byAutoAccept = (await autoBookedDriver(deps.redisClient, event.rideId)) === event.driverId;
    // Its "Your ride is booked" went to the chat (the rider was off the page): then it is unsaid, as for a tap.
    const autoToldChat = byAutoAccept && await autoAcceptToldChat(deps.redisClient, event.rideId);
    // The booking's card went to the chat: its light goes off (a new booking gets a new card).
    const cardWasSent = await hasRideCard(deps.redisClient, event.rideId);
    const cardDeps = offerCountDeps(deps);
    if (cardWasSent && cardDeps) await setCardStatus(cardDeps, event.rideId, 'none').catch(() => false);
    // The search goes on: another accept may go out, and auto-accept may book another driver.
    await clearAcceptSent(deps.redisClient, event.rideId);
    await clearAutoAcceptBooked(deps.redisClient, event.rideId);
    if (!byAutoAccept) {
      void registry.sendToUser(event.riderId, 'ride:accept_offer:rejected', {
        rideId: event.rideId,
        driverId: event.driverId,
        reason: 'driver_unavailable',
        message: 'That driver is no longer available.',
      });
    }
    const phone = await whatsappRiderPhone(deps, event.riderId, event.rideId).catch(() => null);
    if (phone && deps.whatsappNotifier) {
      const chosen = await getAcceptedBid(deps.redisClient, event.rideId).catch(() => null);
      await setRideState(deps.redisClient, event.rideId, 'bidding').catch(() => undefined);
      await clearAcceptedBid(deps.redisClient, event.rideId).catch(() => undefined);
      const pageMessage = await hasOffersPageMessage(deps.redisClient, event.rideId).catch(() => false);
      await dropBidFromWhatsappRide(deps, event.rideId, event.riderId, event.driverId);
      // The chat already had "Your ride is booked": say it did not hold. (Without the
      // offers page or the offers form, dropping the bid above has just said so,
      // with the offers left; with the form it says nothing.)
      const onPage = await isRidePageOpen(deps.redisClient, event.riderId);
      const who = chosen?.driverName ? `*${chosen.driverName}*` : 'That driver';
      const unsay = [`${who} couldn't take this ride after all. Nothing was charged.`, '', 'Pick another offer.'].join('\n');
      if (onPage) {
        // The chat showed the card (or auto-accept said it): unsaid when they leave, if the search is still on.
        if (cardWasSent || autoToldChat) await deferUntilPageLeft(deps.redisClient, event.riderId, { kind: 'booking_failed', rideId: event.rideId, text: unsay }).catch(() => undefined);
      } else if ((!byAutoAccept || autoToldChat) && chosen && (pageMessage || offersFormIsOn(deps.whatsappNotifier))) {
        await sendMetaWhatsappMessage(deps.whatsappNotifier, phone, unsay).catch(() => {});
      }
    }
    // The search goes on: the next driver that qualifies may be booked.
    if (byAutoAccept) await tryAutoAccept(autoAcceptDeps(deps), event.rideId).catch(() => undefined);
    return;
  }

  if (event.eventType === 'RIDE_RIDER_PAYING_ENDED') {
    // The card goes back to waiting. Not a banner: nothing needs the driver to act.
    void registry.sendToUser(event.driverUserId, 'ride:rider_paying_ended', { rideId: event.rideId, reason: event.reason });
    return;
  }

  if (event.eventType === 'RIDE_RIDER_PAYING') {
    // A newer open (another driver) or a close may have overtaken this event: only the holder is told.
    // (A Redis read that fails shows the event: only a read that succeeded and names someone else, or no one, drops it.)
    if (payingStatusEnabled() && event.payingUntil) {
      const held = await readPaying(deps.redisClient, event.rideId);
      if (held !== undefined && held?.driverUserId !== event.driverUserId) return;
    }
    // The rider chose this driver and is adding money: the card says so.
    void registry.sendToUser(event.driverUserId, 'ride:rider_paying', {
      rideId: event.rideId,
      // DRIVER_PAYING_STATUS_ENABLED: when the card stops waiting on the payment (older apps ignore the extras).
      ...(event.payingSince ? { payingSince: event.payingSince } : {}),
      ...(event.payingUntil ? { payingUntil: event.payingUntil } : {}),
      // The driver's own clock cannot be trusted: how long is left, by ours, right now.
      ...(event.payingUntil && payingStatusEnabled() ? { payingRemainingMs: Math.max(0, Date.parse(event.payingUntil) - Date.now()) } : {}),
    });
    // Away from the app: the same news by push (once per event).
    if (deps.driverStatusPushes) {
      await pushDriverIfAway(deps, event.driverUserId, { title: 'Rider accepted', body: 'Paying now', type: 'ride:rider_paying', rideId: event.rideId, generation: event.payingSince ? `paying@${event.payingSince}` : 'paying' });
    }
    return;
  }

  if (event.eventType === 'RIDE_DRIVER_ASSIGNED') {
    await endOfferCount(deps, event.rideId);
    if (payingStatusEnabled()) await clearForBooking(deps, event.rideId, event.driverUserId).catch(() => undefined);
    rideParticipants.set(event.rideId, {
      riderId: event.riderId,
      driverUserId: event.driverUserId,
    });

    // This driver's bid won; every other open bid on the ride lost — and
    // the losers deserve to hear it, not to watch a card silently vanish.
    const losingBids = await driverBidClient.findByRide(event.rideId).catch(() => []);
    await driverBidClient.markAccepted(event.rideId, event.driverId).catch((error) => {
      console.warn('[gateway] could not mark bid accepted', {
        rideId: event.rideId,
        driverId: event.driverId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    for (const losing of losingBids) {
      if (losing.driverId === event.driverId || !isOpenBid(losing.status)) continue;
      void registry.sendToUser(losing.driverUserId, 'ride:bid_lost', {
        rideId: event.rideId,
        reason: 'booked_other',
      });
      // Away from the app: a push, so the driver is not left waiting on this rider.
      await pushDriverIfAway(deps, losing.driverUserId, { title: 'Not chosen', body: 'Another driver got this ride.', type: 'ride:bid_lost', rideId: event.rideId, generation: `won_by:${event.driverId}` });
    }
    // Drivers who were offered it but never bid: their request card closes as
    // "Taken by another driver" instead of lingering until it expires.
    const bidders = new Set(losingBids.map((bid) => bid.driverUserId));
    for (const userId of event.offeredDriverUserIds ?? []) {
      if (userId === event.driverUserId || bidders.has(userId)) continue;
      void registry.sendToUser(userId, 'ride:bid_lost', { rideId: event.rideId, reason: 'booked_other' });
    }

    // The winner is off the market: withdraw their bids on every OTHER ride
    // so no second rider can pay for a driver who just left. Each affected
    // rider's offer list drops the entry.
    const withdrawn = await driverBidClient
      .withdrawAllPendingForDriver(event.driverUserId, event.rideId)
      .catch(() => []);
    for (const gone of withdrawn) {
      void registry.sendToUser(gone.riderId, 'ride:driver_rejected', {
        rideId: gone.rideId,
        driverId: gone.driverId,
        reason: 'driver_unavailable',
      });
      await dropBidFromWhatsappRide(deps, gone.rideId, gone.riderId, gone.driverId);
    }

    // The trip code: issued now, before anyone is told, so the rider's screen
    // and the driver's Start button agree. Not for a group seat.
    const isGroupSeat = Boolean(await getGroupSeat(deps.redisClient, event.rideId).catch(() => null));
    const tripCode = isGroupSeat ? null : await tripCodeClient.ensure(event.rideId).catch(() => null);
    const tripCodeNeeded = tripCode ? await tripCodeStillNeeded(event.rideId).catch(() => false) : false;

    // Notify rider. The app hears "matched" whenever it is open, wherever the
    // search began: a WhatsApp search accepted in the app waited on
    // "Confirming your driver" for a message that only went to the chat.
    const sendMatchedToApp = async () => {
      const riderMatchFees = calculateRideFees(event.agreedFareNgn, await rideClient.pricingVersionOf(event.rideId));
      // Look up driver phone so rider can call them
      let driverPhone: string | undefined;
      try {
        const driver = await driverClient.findById(event.driverId);
        driverPhone = driver.user.phone ?? undefined;
      } catch { /* non-critical */ }
      await registry.sendToUser(event.riderId, 'ride:matched', {
        rideId: event.rideId,
        driverId: event.driverId,
        // Feedback is addressed to a *user*, not a driver record, so without
        // this the rider's app has nobody to attach a rating to.
        driverUserId: event.driverUserId,
        driverName: event.driverName,
        driverRating: event.driverRating,
        vehiclePlate: event.vehiclePlate,
        vehicleModel: event.vehicleModel,
        etaSeconds: event.etaSeconds,
        agreedFareNgn: riderMatchFees.totalNgn,
        lockedFareNgn: event.lockedFareNgn,
        paymentMethod: event.paymentMethod,
        driverPhone,
        // Only ever to the rider: they give it to the driver at pickup.
        tripCode,
      });
    };
    const waRider = (await whatsappRiderPhone(deps, event.riderId, event.rideId)) !== null;
    if (waRider && deps.whatsappNotifier) {
      await sendMatchedToApp();
      await setRideState(deps.redisClient, event.rideId, 'confirmed', IN_TRIP_ACTIVE_RIDE_TTL);
      await setActiveRide(deps.redisClient, event.riderId, event.rideId, IN_TRIP_ACTIVE_RIDE_TTL);

      // Store accepted bid for driver profile flow
      try {
        const driver = await driverClient.findById(event.driverId);
        await storeAcceptedBid(deps.redisClient, event.rideId, {
          driverName: event.driverName,
          driverPhone: driver.user.phone ?? '',
          driverUserId: event.driverUserId,
          vehicleModel: event.vehicleModel,
          vehiclePlate: event.vehiclePlate ?? '',
          vehicleColor: '',
          driverRating: event.driverRating ?? 0,
          totalRides: driver.totalRides ?? 0,
          etaSeconds: event.etaSeconds,
          fareNgn: event.agreedFareNgn,
        });
      } catch {
        // Non-critical
      }

      // The chat already has the ride card (photo, car, plate, Track live trip, SOS) from
      // the accept itself — the chat tap, the offers form, the page and the deposit finisher
      // all send it. A second "Ride confirmed!" text here was the same news twice.
    } else {
      await sendMatchedToApp();

      // Push too — the socket only reaches a foregrounded app, and "driver
      // on the way" is exactly the message a backgrounded rider must see.
      const etaMin = Math.max(1, Math.ceil(event.etaSeconds / 60));
      await deps.publisher.publishNotificationEvent({
        eventType: 'PUSH_SEND',
        notificationId: randomUUID(),
        userId: event.riderId,
        title: 'Driver found!',
        body: `${event.driverName} is on the way — they'll be with you in ~${etaMin} min.`,
        data: { type: 'ride:matched', rideId: event.rideId },
        priority: 'high',
        timestamp: new Date().toISOString(),
      }).catch(() => {});
    }

    // Notify driver via WebSocket (app) — include fee breakdown
    const matchFees = calculateRideFees(event.agreedFareNgn, await rideClient.pricingVersionOf(event.rideId));

    // Look up rider phone so driver can call them
    let riderPhone: string | undefined;
    let riderName: string | undefined;
    try {
      const riderUser = await userClient.findById(event.riderId);
      riderPhone = riderUser?.phone ?? undefined;
      riderName = riderUser?.name?.trim().split(/\s+/)[0] || undefined;
    } catch { /* non-critical */ }

    // Ship the route with the match. The driver app's offer card expires
    // after 30s while the rider takes minutes to pay, so by now the app often
    // has nothing left to rebuild the trip from — the match was dropped with
    // a console warning and the driver kept seeing "waiting for rider".
    const rideSnapshot = await loadDriverRideSnapshot(event.rideId).catch(() => null);

    await registry.sendToUser(event.driverUserId, 'ride:matched', {
      rideId: event.rideId,
      tripId: rideSnapshot?.tripId ?? null,
      riderId: event.riderId,
      rideStatus: 'DRIVER_ASSIGNED',
      pickup: rideSnapshot?.pickup,
      destination: rideSnapshot?.destination,
      stops: rideSnapshot?.stops ?? [],
      driverId: event.driverId,
      driverName: event.driverName,
      driverRating: event.driverRating,
      vehiclePlate: event.vehiclePlate,
      vehicleModel: event.vehicleModel,
      etaSeconds: event.etaSeconds,
      agreedFareNgn: event.agreedFareNgn,
      // The driver's breakdown: booking fee first, then commission and VAT on their share, the WhatsApp fee, then the levy.
      bookingFeeNgn: matchFees.bookingFeeNgn,
      driverShareNgn: matchFees.driverShareNgn,
      pricingVersion: matchFees.pricingVersion,
      commissionNgn: matchFees.commissionNgn,
      whatsappFeeNgn: matchFees.whatsappFeeNgn,
      vatNgn: matchFees.vatNgn,
      // (Old names, for apps not yet updated: commission, booking fee.)
      platformFeeNgn: matchFees.platformFeeNgn,
      stateLevyNgn: matchFees.stateLevyNgn,
      serviceFeeNgn: matchFees.serviceFeeNgn,
      driverEarningsNgn: matchFees.driverPayoutNgn,
      lockedFareNgn: event.lockedFareNgn,
      paymentMethod: event.paymentMethod,
      riderPaid: event.paymentMethod !== 'CASH',
      riderPhone,
      riderName,
      // The Start button asks for the rider's code. Never the code itself.
      tripCodeRequired: tripCodeNeeded,
    });
    // Away from the app: the booking by push too.
    await pushDriverIfAway(deps, event.driverUserId, {
      title: "You're booked",
      body: rideSnapshot?.pickup?.address ? `Pick up at ${rideSnapshot.pickup.address}` : 'Open Wheelers to see the pickup.',
      type: 'ride:matched',
      rideId: event.rideId,
      generation: `${event.driverId}@${event.timestamp}`,
    });

    return;
  }

  if (event.eventType === 'RIDE_ROUTE_UPDATED') {
    // The trip's road from now on (the ride page draws it under the car); a stop reached carries none.
    if (event.route?.coordinates?.length) await storeTripLine(deps.redisClient, event.rideId, event.route.coordinates).catch(() => undefined);
    const routePayload = {
      rideId: event.rideId,
      destination: event.destination,
      stops: event.stops,
      route: event.route,
      plannedDistanceKm: event.plannedDistanceKm,
      plannedDurationSeconds: event.plannedDurationSeconds,
      ...buildRideEstimatePricing(event.plannedDistanceKm, event.plannedDurationSeconds, { destination: event.destination }),
      updatedBy: event.updatedBy,
    };

    await registry.sendToUser(event.riderId, 'ride:route:updated', routePayload);

    const participants = rideParticipants.get(event.rideId);
    if (participants?.driverUserId) {
      await registry.sendToUser(participants.driverUserId, 'ride:route:updated', routePayload);
    }

    return;
  }

  if (event.eventType === 'RIDE_ARRIVED') {
    // The "your driver is outside" moment. WhatsApp riders get a message; app
    // riders get a socket event their ride screen can react to.
    const phone = await whatsappRiderPhone(deps, event.riderId, event.rideId);
    if (phone && deps.whatsappNotifier) {
      await setActiveRide(deps.redisClient, event.riderId, event.rideId, IN_TRIP_ACTIVE_RIDE_TTL);
      // Once per driver on the ride: a redelivered RIDE_ARRIVED says nothing more, but a second
      // driver (the first pulled out) arriving is news.
      if (!(await deps.redisClient.setIfNotExists(`ride:${event.rideId}:arrived:${event.driverId}`, '1', 6 * 60 * 60).catch(() => true))) return;
      // On the ride page, the page shows the car and the code: the chat gets it when they leave.
      if (await isRidePageOpen(deps.redisClient, event.riderId)) {
        await deferUntilPageLeft(deps.redisClient, event.riderId, { kind: 'arrived', rideId: event.rideId, driverId: event.driverId }).catch(() => undefined);
      } else {
        await tellArrivedInChat(deps, phone, event.rideId, event.driverId);
      }
    } else {
      await registry.sendToUser(event.riderId, 'ride:driver_arrived', {
        rideId: event.rideId,
        driverId: event.driverId,
      });
      // A rider waiting indoors has the phone in a pocket, not the app open:
      // the driver at the kerb is said by push as well.
      await tellAppRider(deps, event.riderId, {
        title: 'Your driver is outside',
        body: 'Open Wheelers for your trip code and give it to the driver.',
        type: 'ride:driver_arrived',
        rideId: event.rideId,
      });
    }
    return;
  }

  if (event.eventType === 'RIDE_STARTED') {
    // RIDE_STARTED only has driverId (Driver record ID), not driverUserId.
    // Look up driverUserId from rideParticipants (set by RIDE_DRIVER_ASSIGNED),
    // or from the database after a gateway restart.
    const participants = await participantsFor(event.rideId, rideParticipants);
    const driverUserId = participants?.driverUserId;

    // Notify rider
    const phone = await whatsappRiderPhone(deps, event.riderId, event.rideId);
    if (phone && deps.whatsappNotifier) {
      await setRideState(deps.redisClient, event.rideId, 'in_progress', IN_TRIP_ACTIVE_RIDE_TTL);
      await setActiveRide(deps.redisClient, event.riderId, event.rideId, IN_TRIP_ACTIVE_RIDE_TTL);
      // No "trip started" message: the rider is in the car, and the receipt follows.
    } else {
      await registry.sendToUser(event.riderId, 'ride:started', {
        rideId: event.rideId,
        startedAt: event.startedAt,
      });
    }

    // Notify driver via WebSocket (app)
    if (driverUserId) {
      await registry.sendToUser(driverUserId, 'ride:started', {
        rideId: event.rideId,
        startedAt: event.startedAt,
      });
    }

    return;
  }

  if (event.eventType === 'RIDE_COMPLETED') {
    const settledReferralUsages = await referralClient.settleRideCashback(event.rideId);
    // An XLM ride: the XLM and the rate it was accepted at, for the receipt and the payment on Stellar.
    const xlmRide = event.paymentMethod === 'XLM' ? await rideClient.findById(event.rideId).catch(() => null) : null;
    const paidXlm = xlmRide?.fareXlm != null ? String(Number(xlmRide.fareXlm)) : null;

    // Notify rider
    const phone = await whatsappRiderPhone(deps, event.riderId, event.rideId);
    // The receipt goes even while the rider is on the ride page (the trip is over and it is
    // wanted), but once: a redelivered RIDE_COMPLETED sends nothing more.
    const firstReceipt = phone && deps.whatsappNotifier
      ? await deps.redisClient.setIfNotExists(`ride:${event.rideId}:receipt`, '1', 7 * 24 * 60 * 60).catch(() => true)
      : false;
    if (phone && deps.whatsappNotifier && firstReceipt) {
      {
        const riderWallet = await walletClient.findByUserId(event.riderId).catch(() => null);
        await sendRideCompletedNotification(
          deps.whatsappNotifier, phone, event.fareNgn, event.distanceKm,
          riderWallet ? Number(riderWallet.balanceNgn) : undefined,
          event.rideId,
          formatTripId(await rideClient.tripNumberOf(event.rideId).catch(() => null)),
          paidXlm,
        ).catch(() => {});
        // Arm the rating reply: a bare 1–5 in the next day rates this driver.
        const completedBid = await getAcceptedBid(deps.redisClient, event.rideId).catch(() => null);
        await storeLastCompletedRide(deps.redisClient, event.riderId, {
          rideId: event.rideId,
          driverUserId: event.driverUserId,
          driverName: completedBid?.driverName,
        }).catch(() => {});
      }
      await clearActiveRideIfMatches(deps.redisClient, event.riderId, event.rideId);
      await clearPendingAccept(deps.redisClient, event.riderId).catch(() => {});
    } else {
      const riderFees = calculateRideFees(event.fareNgn, await rideClient.pricingVersionOf(event.rideId));
      await registry.sendToUser(event.riderId, 'ride:completed', {
        rideId: event.rideId,
        fareNgn: riderFees.totalNgn,
        distanceKm: event.distanceKm,
        durationSeconds: event.durationSeconds,
        completedAt: event.completedAt,
        referralCashbackSettled: settledReferralUsages > 0,
      });
    }

    // Notify driver via WebSocket (app) — show earnings breakdown
    const completionFees = calculateRideFees(event.fareNgn, await rideClient.pricingVersionOf(event.rideId));
    await registry.sendToUser(event.driverUserId, 'ride:completed', {
      rideId: event.rideId,
      fareNgn: event.fareNgn,
      bookingFeeNgn: completionFees.bookingFeeNgn,
      driverShareNgn: completionFees.driverShareNgn,
      pricingVersion: completionFees.pricingVersion,
      commissionNgn: completionFees.commissionNgn,
      whatsappFeeNgn: completionFees.whatsappFeeNgn,
      vatNgn: completionFees.vatNgn,
      platformFeeNgn: completionFees.platformFeeNgn,
      stateLevyNgn: completionFees.stateLevyNgn,
      serviceFeeNgn: completionFees.serviceFeeNgn,
      totalChargedNgn: completionFees.totalNgn,
      driverEarningsNgn: completionFees.driverPayoutNgn,
      distanceKm: event.distanceKm,
      durationSeconds: event.durationSeconds,
      completedAt: event.completedAt,
    });

    // Clean up WhatsApp Redis state
    await endOfferCount(deps, event.rideId);
    await cleanupRideKeys(deps.redisClient, event.rideId);

    await announceTripChatClosed(deps, event.rideId, await participantsFor(event.rideId, rideParticipants));

    // On Stellar Testnet, its own ledger: the fare rider → driver, then the commission
    // driver → operations, in XLM at the live rate, memo the trip ID. Not for a group seat.
    if (deps.stellar && event.paymentMethod !== 'CASH' && !(await getGroupSeat(deps.redisClient, event.rideId).catch(() => null))) {
      const fees = calculateRideFees(event.fareNgn, await rideClient.pricingVersionOf(event.rideId));
      const tripId = formatTripId(await rideClient.tripNumberOf(event.rideId).catch(() => null));
      await deps.stellar.settleRide({
        rideId: event.rideId, tripId, riderId: event.riderId, driverUserId: event.driverUserId,
        fareNgn: event.fareNgn, commissionNgn: fees.platformTotalNgn,
        // An XLM ride is PAID this way, at the rate the rider accepted; a naira ride is mirrored at the live rate.
        rateNgnPerXlm: xlmRide?.xlmRateNgn != null ? Number(xlmRide.xlmRateNgn) : null,
      }).catch((error) => console.warn('[stellar] trip settlement not queued', { rideId: event.rideId, error: error instanceof Error ? error.message : String(error) }));
    }
    rideParticipants.delete(event.rideId);
    return;
  }

  if (event.eventType === 'RIDE_CANCELLED') {
    // A driver bailing, delivered again (Kafka), must not touch the search that
    // has gone on since: the next driver's bids, their hold, the accept sent for
    // them, the rider's chat. Once per bail.
    // Marked done only at the end, so a Kafka retry after a failure does the work again.
    const bailKey = event.cancelledBy === 'driver' ? `ride:${event.rideId}:bail:${event.driverId ?? event.driverUserId ?? 'driver'}:${event.timestamp}` : null;
    if (bailKey && await deps.redisClient.get(bailKey).catch(() => null)) return;
    // A rider cancelling BEFORE a match leaves bidders in the same forever-
    // waiting state as a timeout — the assigned-driver notification below
    // only fires when there IS an assigned driver. Same message as a
    // timeout: to a bidder, "request gone" is all that matters.
    const openBids = await driverBidClient.findByRide(event.rideId).catch(() => []);
    if (payingStatusEnabled()) await closePaying(deps, event.rideId, 'cancelled').catch(() => false);
    // Why the search ended, for the driver's card: the rider stopped it (or replaced it with a new one).
    const searchEndReason = event.cancelledBy === 'driver' ? 'timed_out' : 'rider_cancelled';
    for (const bid of openBids) {
      if (!isOpenBid(bid.status)) continue;
      if (event.driverUserId && bid.driverUserId === event.driverUserId) continue;
      void registry.sendToUser(bid.driverUserId, 'ride:bid_timeout', {
        rideId: event.rideId,
        reason: searchEndReason,
      });
      if (searchEndReason === 'rider_cancelled') {
        await pushDriverIfAway(deps, bid.driverUserId, { title: 'Rider cancelled', body: 'This request has ended.', type: 'ride:bid_timeout', rideId: event.rideId, generation: `cancelled@${event.timestamp}` });
      }
    }

    await driverBidClient.resolvePending(event.rideId, 'CANCELLED').catch(() => {});
    // The chosen driver's bid too: the trip it won is gone (see cancelAccepted).
    await driverBidClient.cancelAccepted(event.rideId).catch(() => {});

    // Release wallet hold so locked funds return to rider's balance.
    // wallet-service releases it too (consumer race) — whichever ran first,
    // the result still carries the hold amount and the wallet's balance, so
    // the rider's message can state the refund as a fact, not a hope.
    // A driver bailing puts the ride back into matching under the same id,
    // and the rider gets their money back NOW: the next driver they accept
    // takes a fresh hold (createRideHold re-arms a released one). Keeping it
    // locked for the re-match told nobody, asked the rider to pay a second
    // time, and could leave it locked for good.
    const driverBailed = event.cancelledBy === 'driver';
    if (!driverBailed) await markSearchEnded(deps.redisClient, event.rideId);
    if (driverBailed) {
      // The card's light (🟢 / 💬 / 📞) goes: that trip is over; a new booking gets a new card.
      const cardDeps = offerCountDeps(deps);
      if (cardDeps) await setCardStatus(cardDeps, event.rideId, 'none').catch(() => false);
      // The search goes on: another accept may go out, and auto-accept may book again.
      await clearAcceptSent(deps.redisClient, event.rideId);
      await clearAutoAcceptBooked(deps.redisClient, event.rideId);
      // The search starts again. The offers on the table were the old search's:
      // the driver who just left, and the ones who lost to them. "1 driver found"
      // for the driver who bailed is not an offer.
      await clearBids(deps.redisClient, event.rideId).catch(() => {});
      await storeLastBatch(deps.redisClient, event.rideId, []).catch(() => {});
      await clearPendingAccept(deps.redisClient, event.riderId).catch(() => {});
    }
    // A bail releases only the money held for the driver who left (never a next driver's hold).
    const bailedDriverUserId = driverBailed
      ? event.driverUserId ?? (event.driverId ? (await driverClient.findById(event.driverId).catch(() => null))?.userId : undefined)
      : undefined;
    const holdRelease = await walletClient.cancelRideHold(event.rideId, bailedDriverUserId).catch(() => null);

    const releasedReferralCashback = await referralClient.releaseRideCashback(
      event.rideId,
    );

    // Notify rider
    // A search replaced by the rider's own newer request: clean up, say nothing — they asked for it.
    // A ride for later put back to wait (its rider was busy) is the same: nothing to say.
    const superseded = event.cancelledBy === 'system' && (/newer request/i.test(event.reason ?? '') || event.reason === SCHEDULED_START_HELD_REASON);
    // Cancelled by the rider on the ride page: they did it there, the chat says nothing.
    const cancelledOnPage = await wasCancelledOnPage(deps.redisClient, event.rideId).catch(() => false);
    // Cancelled in the chat with a reason: that chat gets one message, reason and refund together.
    const toldInChat = await takeChatCancellation(deps.redisClient, event.rideId).catch(() => null);
    const phone = toldInChat?.phone ?? await whatsappRiderPhone(deps, event.riderId, event.rideId);
    if (phone && deps.whatsappNotifier) {
      if (!superseded && !cancelledOnPage) {
        const details = {
          reason: event.reason,
          cancelledBy: event.cancelledBy,
          refundedNgn: holdRelease?.holdAmountNgn,
          balanceNgn: holdRelease ? Number(holdRelease.wallet.balanceNgn) : undefined,
          riderReason: toldInChat?.reason,
          searchingAgain: driverBailed,
        };
        // A driver bailed and the search goes on: this one message says so AND
        // carries "See driver offers" — it becomes the search's offers message,
        // with the count of new offers on it. The old "Your bid is in" was closed
        // when the driver was chosen.
        // On the ride page (it shows it): the chat hears it once they leave, if still true.
        // A cancellation (not a bail) is said once, however often it is delivered.
        const firstCancel = driverBailed || await deps.redisClient.setIfNotExists(`ride:${event.rideId}:cancel-told`, '1', 24 * 60 * 60).catch(() => true);
        if (!firstCancel) {
          // Delivered again: already said (or kept for the catch-up).
        } else if (await isRidePageOpen(deps.redisClient, event.riderId)) {
          await deferUntilPageLeft(deps.redisClient, event.riderId, driverBailed
            ? { kind: 'driver_cancelled', rideId: event.rideId, details }
            : { kind: 'cancelled', rideId: event.rideId, details }).catch(() => undefined);
        } else {
          await tellDriverBailedOrCancelled(deps, phone, event.rideId, event.riderId, details, driverBailed);
        }
      }
      // An app open on the same ride hears it too (a WhatsApp search followed in the app).
      if (!superseded) {
        await registry.sendToUser(event.riderId, 'ride:cancelled', {
          rideId: event.rideId,
          reason: event.reason,
          cancelledBy: event.cancelledBy ?? 'rider',
          refundedNgn: holdRelease?.holdAmountNgn ?? 0,
          ...(driverBailed ? { searchingAgain: true } : {}),
        });
      }
      if (driverBailed) {
        // Back to bidding on the same ride: new offers land in the same chat.
        await setRideState(deps.redisClient, event.rideId, 'bidding');
      } else {
        await clearActiveRideIfMatches(deps.redisClient, event.riderId, event.rideId);
        await clearPendingAccept(deps.redisClient, event.riderId).catch(() => {});
      }
    } else {
      await registry.sendToUser(event.riderId, 'ride:cancelled', {
        rideId: event.rideId,
        reason: event.reason,
        cancelledBy: event.cancelledBy ?? 'rider',
        referralCashbackReleasedNgn:
          releasedReferralCashback.releasedCashbackNgn,
        refundedNgn: holdRelease?.holdAmountNgn ?? 0,
        ...(driverBailed ? { searchingAgain: true } : {}),
      });
      // A driver pulling out is news the rider did not cause and must not
      // find out by waiting: said by push, and kept in the app's notifications.
      if (driverBailed) {
        await tellAppRider(deps, event.riderId, {
          title: 'Your driver cancelled',
          body: 'You were not charged. We are looking for another driver; open Wheelers to see the offers.',
          type: 'ride:driver_cancelled',
          rideId: event.rideId,
          inApp: true,
        });
      }
    }

    // Notify driver via WebSocket (app).
    // rideParticipants is in-memory and only filled by RIDE_REQUESTED /
    // RIDE_DRIVER_ASSIGNED, so any gateway restart empties it and the driver
    // silently got nothing. Fall back to the DB, which always knows.
    if (event.driverId) {
      const participants = rideParticipants.get(event.rideId);
      let driverUserId = participants?.driverUserId ?? event.driverUserId;

      if (!driverUserId) {
        const driver = await driverClient.findById(event.driverId).catch((error) => {
          console.warn('[gateway] could not resolve driver user for cancellation', {
            rideId: event.rideId,
            driverId: event.driverId,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        });
        driverUserId = driver?.userId;
      }

      if (driverUserId) {
        await registry.sendToUser(driverUserId, 'ride:cancelled', {
          rideId: event.rideId,
          reason: event.reason,
          cancelledBy: event.cancelledBy ?? 'rider',
        });
        // The rider called off a booked trip: a driver away from the app (driving to them) hears it by push.
        if ((event.cancelledBy ?? 'rider') === 'rider' && driverUserId !== event.driverUserId) {
          await pushDriverIfAway(deps, driverUserId, { title: 'Rider cancelled', body: 'This trip is off.', type: 'ride:cancelled', rideId: event.rideId, generation: `cancelled@${event.timestamp}` });
        }
      } else {
        console.warn('[gateway] ride cancelled but the driver could not be notified', {
          rideId: event.rideId,
          driverId: event.driverId,
        });
      }
    }

    if (!driverBailed) {
      // Clean up WhatsApp Redis state for this ride
      await endOfferCount(deps, event.rideId);
      await cleanupRideKeys(deps.redisClient, event.rideId);
      await clearActiveRideIfMatches(deps.redisClient, event.riderId, event.rideId).catch(() => {});
    }

    await announceTripChatClosed(deps, event.rideId, await participantsFor(event.rideId, rideParticipants));
    rideParticipants.delete(event.rideId);
    if (bailKey) await deps.redisClient.set(bailKey, '1', 24 * 60 * 60).catch(() => undefined);
    return;
  }

  if (event.eventType === 'RIDE_DRIVER_REJECTED') {
    // A driver taking back a bid they'd sent — a timeout is the offer card
    // lapsing, which says nothing about a bid.
    if (event.reason === 'manual_reject') {
      await driverBidClient.markWithdrawn(event.rideId, event.driverId).catch(() => {});
      await dropBidFromWhatsappRide(deps, event.rideId, event.riderId, event.driverId);
    }
    await registry.sendToUser(event.riderId, 'ride:driver_rejected', {
      rideId: event.rideId,
      // Which driver: the app takes their offer off the list when they withdrew it.
      driverId: event.driverId,
      reason: event.reason,
    });
    return;
  }

  if (event.eventType === 'CHAT_MESSAGE_SENT') {
    // Delivered by the trip chat the moment it is sent (src/trip-chat/messages.ts);
    // this event is the record of it. Delivering it here too would show it twice.
    return;
  }
}

async function handleWalletEvent(
  event: WalletEvent,
  deps: StartGatewayConsumerDeps,
  rideParticipants: Map<string, RideParticipantState>,
): Promise<void> {
  const registry = deps.registry;

  if (event.eventType === 'WALLET_CREDITED') {
    await registry.sendToUser(event.userId, 'wallet:updated', {
      walletId: event.walletId,
      balanceNgn: event.newBalanceNgn,
      changeNgn: event.amountNgn,
      changeType: event.creditType,
      direction: 'credit',
      referenceId: event.referenceId,
    });

    // Check if this rider has an active ride — notify driver that rider funded wallet
    const waRider = await isWhatsappRider(deps.redisClient, event.userId);
    let handledByRide = false;

    if (waRider && deps.whatsappNotifier) {
      // Find the active ride and its driver
      for (const [rideId, participants] of rideParticipants) {
        if (participants.riderId === event.userId && participants.driverUserId) {
          const meta = await getRideMeta(deps.redisClient, rideId);
          if (meta && event.newBalanceNgn >= meta.offerNgn) {
            // Rider has enough funds — notify driver via app
            await registry.sendToUser(participants.driverUserId, 'ride:rider_paid', {
              rideId,
              riderFunded: true,
              message: 'Rider has funded their wallet. You can start heading to pickup!',
            });
            // The rider hears of a deposit from the plain confirmation below; any
            // other credit (a refund, a cashback) is not a "payment received".
          }
          break;
        }
      }
    }

    // Adding money to take a driver they tapped: the deposit itself confirms the ride.
    if (!handledByRide && event.creditType === 'deposit' && deps.onWhatsappDeposit) {
      handledByRide = await deps.onWhatsappDeposit({
        userId: event.userId,
        amountNgn: event.amountNgn,
        newBalanceNgn: event.newBalanceNgn,
      }).catch((error) => {
        console.error('[consumer] finishing a ride on deposit failed', { userId: event.userId, error: error instanceof Error ? error.message : String(error) });
        return false;
      });
    }

    // No active ride — send generic deposit confirmation to WhatsApp users
    // Not while they are on the ride page (it shows the balance), and once per deposit.
    if (!handledByRide && deps.whatsappNotifier && event.creditType === 'deposit' && !(await isRidePageOpen(deps.redisClient, event.userId))
      && await deps.redisClient.setIfNotExists(`deposit:told:${event.referenceId ?? `${event.walletId}:${event.newBalanceNgn}:${event.amountNgn}`}`, '1', 7 * 24 * 60 * 60).catch(() => true)) {
      const phone = await lookupPhoneByUserId(deps.redisClient, event.userId);
      if (phone) {
        await sendDepositConfirmation(deps.whatsappNotifier, phone, event.amountNgn, event.newBalanceNgn)
          .catch(() => {});
      }
    }

    return;
  }

  if (event.eventType === 'WALLET_DEBITED') {
    await registry.sendToUser(event.userId, 'wallet:updated', {
      walletId: event.walletId,
      balanceNgn: event.newBalanceNgn,
      changeNgn: event.amountNgn,
      changeType: event.debitType,
      direction: 'debit',
      referenceId: event.referenceId,
    });
    return;
  }

  if (event.eventType === 'WALLET_LOCKED') {
    await registry.sendToUser(event.userId, 'wallet:updated', {
      walletId: event.walletId,
      rideId: event.rideId,
      lockedAmountNgn: event.lockedAmountNgn,
      reason: event.reason,
      direction: 'lock',
    });
    return;
  }

  if (event.eventType === 'WALLET_HOLD_ADJUSTED') {
    await registry.sendToUser(event.userId, 'wallet:updated', {
      walletId: event.walletId,
      rideId: event.rideId,
      previousLockedAmountNgn: event.previousLockedAmountNgn,
      lockedAmountNgn: event.lockedAmountNgn,
      reason: event.reason,
      direction: 'lock_adjustment',
    });
    return;
  }

  await registry.sendToUser(event.userId, 'wallet:updated', {
    walletId: event.walletId,
    rideId: event.rideId,
    unlockedAmountNgn: event.unlockedAmountNgn,
    reason: event.reason,
    direction: 'unlock',
  });
}

async function handleNotificationEvent(event: NotificationEvent, registry: SocketRegistry): Promise<void> {
  if (event.eventType !== 'IN_APP_SEND') return;

  await registry.sendToUser(event.userId, 'notification:new', {
    notificationId: event.notificationId,
    title: event.title,
    body: event.body,
    category: event.category,
    referenceId: event.referenceId,
    referenceType: event.referenceType,
    read: event.read,
  });
}

async function handleGpsProcessedEvent(
  event: GpsProcessedEvent,
  registry: SocketRegistry,
  rideParticipants: Map<string, RideParticipantState>,
): Promise<void> {
  const participants = await participantsFor(event.rideId, rideParticipants);
  if (!participants?.riderId) {
    return;
  }

  // Send to rider — full location data
  await registry.sendToUser(participants.riderId, 'ride:driver_location', {
    rideId: event.rideId,
    lat: event.lat,
    lng: event.lng,
    heading: event.headingDeg,
    speedKmh: event.speedKmh,
    distanceFromLastKm: event.distanceFromLastKm,
    totalDistanceKm: event.totalDistanceKm,
    isStale: event.isStale,
    isConsistent: event.isConsistent,
    inconsistencyReason: event.inconsistencyReason,
    ignoredDistanceKm: event.ignoredDistanceKm,
    distanceToNextStopKm: event.distanceToNextStopKm,
    nextStopAddress: event.nextStopAddress,
    nextStopOrder: event.nextStopOrder,
    remainingStopCount: event.remainingStopCount,
  });

  // Send to driver — live distance for trip screen
  if (participants.driverUserId) {
    await registry.sendToUser(participants.driverUserId, 'ride:gps_update', {
      rideId: event.rideId,
      totalDistanceKm: event.totalDistanceKm,
      distanceToNextStopKm: event.distanceToNextStopKm,
    });
  }
}

async function handleComplianceEvent(event: ComplianceEvent, registry: SocketRegistry): Promise<void> {
  if (event.eventType === 'FEEDBACK_LOGGED') {
    // Ratings were decorative: nothing consumed this event, every driver sat
    // at 5.0 forever, riders had no rating at all. One vote per reviewer per
    // ride (the unique constraint absorbs repeats), aggregates on both sides.
    const result = await complianceClient
      .recordFeedbackAndAggregate({
        id: event.feedbackId,
        rideId: event.rideId,
        reviewerId: event.reviewerId,
        reviewerRole: event.reviewerRole,
        revieweeId: event.revieweeId,
        rating: event.rating,
        comment: event.comment,
      })
      .catch((error) => {
        console.warn('[gateway] feedback aggregate failed', {
          rideId: event.rideId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
    if (result) riderOfferInfoCache.delete(event.revieweeId);
    return;
  }

  if (event.eventType !== 'GPS_STALE_WARNING') return;

  await registry.sendToUser(event.riderId, 'gps:stale_warning', {
    rideId: event.rideId,
    staleMinutes: event.staleMinutes,
    lastKnownLat: event.lastKnownLat,
    lastKnownLng: event.lastKnownLng,
  });
}

/**
 * A group rider who booked over WhatsApp has no socket — resolve their phone
 * so status updates reach the channel they actually used.
 */
async function resolveGroupRiderPhone(
  deps: StartGatewayConsumerDeps,
  riderId: string,
): Promise<string | null> {
  const isGroupWhatsappRider = await getGroupRequestRider(deps.redisClient, riderId).catch(() => null);
  if (!isGroupWhatsappRider) return null;

  const cached = await lookupPhoneByUserId(deps.redisClient, riderId);
  if (cached) return cached;

  try {
    const user = await userClient.findById(riderId);
    return user?.phone ?? null;
  } catch {
    return null;
  }
}

async function handleGroupRideEvent(
  event: GroupRideEvent,
  deps: StartGatewayConsumerDeps,
): Promise<void> {
  const registry = deps.registry;

  if (event.eventType === 'GROUP_RIDE_DRIVER_DISPATCH_REQUESTED') {
    // Per-seat bidding: every member negotiates their own seat with the
    // driver. Each WhatsApp member gets their own bid state keyed by THEIR
    // match-request id, so driver seat-bids arrive on their own phone and
    // their replies answer only for themselves.
    const members = event.members ?? [];
    if (members.length === 0) return;

    const seatMembers: Array<{ memberRideId: string; riderId: string; phone: string | null; offerNgn: number }> = [];

    for (const member of members) {
      const isWhatsappGroupRider = await getGroupRequestRider(deps.redisClient, member.riderId).catch(() => null);
      const phone = isWhatsappGroupRider ? await resolveGroupRiderPhone(deps, member.riderId) : null;
      seatMembers.push({
        memberRideId: member.rideId,
        riderId: member.riderId,
        phone,
        offerNgn: member.offerNgn,
      });
    }

    // Only members who can actually answer count toward "all seats agreed" —
    // an unreachable member would deadlock the group forever.
    const reachable = seatMembers.filter((m) => m.phone !== null);
    if (reachable.length === 0) return;

    for (const member of reachable) {
      const seat = members.find((m) => m.rideId === member.memberRideId)!;
      await storeWhatsappRide(deps.redisClient, member.memberRideId, {
        riderId: member.riderId,
        phone: member.phone!,
        pickupAddress: seat.pickup.address,
        destinationAddress: seat.dropoff.address,
        offerNgn: member.offerNgn,
        suggestedFareNgn: member.offerNgn,
        paymentMethod: 'WALLET',
        createdAt: new Date().toISOString(),
      });
      await setActiveRide(deps.redisClient, member.riderId, member.memberRideId);
      await storeGroupSeat(deps.redisClient, member.memberRideId, {
        anchorRideId: event.anchorRideId,
        groupId: event.groupId,
        memberCount: reachable.length,
      });

      if (deps.whatsappNotifier) {
        await sendGroupRideDispatchNotification(deps.whatsappNotifier, member.phone!, member.offerNgn).catch(() => {});
      }
    }

    await storeGroupSeatMembers(deps.redisClient, event.anchorRideId, seatMembers);
    return;
  }

  if (event.eventType === 'GROUP_RIDE_ROUTE_BUILT') {
    const riderCount = event.riderIds.length;
    for (const riderId of event.riderIds) {
      const phone = deps.whatsappNotifier ? await resolveGroupRiderPhone(deps, riderId) : null;
      if (phone && deps.whatsappNotifier) {
        await sendGroupRideGroupedNotification(
          deps.whatsappNotifier, phone,
          riderCount, event.totalDistanceKm, event.totalDurationSeconds,
        ).catch(() => {});
      } else {
        await registry.sendToUser(riderId, 'group-ride:grouped', {
          groupId: event.groupId,
          rideIds: event.rideIds,
          riderCount,
          totalDistanceKm: event.totalDistanceKm,
          totalDurationSeconds: event.totalDurationSeconds,
        });
      }
    }
    return;
  }

  if (event.eventType === 'GROUP_RIDE_DRIVER_ASSIGNED') {
    const payload = {
      groupId: event.groupId,
      rideIds: event.rideIds,
      driverId: event.driverId,
      driverUserId: event.driverUserId,
      driverName: event.driverName,
      driverRating: event.driverRating,
      vehiclePlate: event.vehiclePlate,
      vehicleModel: event.vehicleModel,
      etaSeconds: event.etaSeconds,
    };

    // Notify ALL riders in the group — WhatsApp riders on WhatsApp
    for (const riderId of event.riderIds) {
      const phone = deps.whatsappNotifier ? await resolveGroupRiderPhone(deps, riderId) : null;
      if (phone && deps.whatsappNotifier) {
        await sendGroupRideDriverAssignedNotification(
          deps.whatsappNotifier, phone,
          event.driverName, event.vehicleModel, event.vehiclePlate,
          event.driverRating, event.etaSeconds,
        ).catch(() => {});
      } else {
        await registry.sendToUser(riderId, 'group-ride:driver-assigned', payload);
      }
    }
  }
}


/**
 * The trip ended or was cancelled: its chat is closed, and both people's
 * screens (the driver's app, the rider's app or Trip chat page) are told at
 * once instead of finding out on their next message. Nothing is said while
 * the chat is still open: a ride whose driver bailed goes back to searching.
 */
async function announceTripChatClosed(
  deps: StartGatewayConsumerDeps,
  rideId: string,
  participants: RideParticipantState | undefined,
): Promise<void> {
  const { registry } = deps;
  const info = await loadTripChat(rideId).catch(() => null);
  if (!info || info.open) return;
  // The WhatsApp ride card's status light goes out with the trip.
  if (info.channel === 'WHATSAPP' && deps.whatsappNotifier) {
    await setCardStatus({ redis: deps.redisClient, meta: deps.whatsappNotifier }, rideId, 'none').catch(() => false);
  }
  const people = new Set(
    [participants?.riderId, participants?.driverUserId, info.rider.userId, info.driver?.userId].filter((id): id is string => Boolean(id)),
  );
  await Promise.all([...people].map((userId) => registry.sendToUser(userId, 'chat:closed', { rideId }).catch(() => undefined)));
}

/**
 * The rider's WhatsApp number when this ride is a WhatsApp ride, else null.
 *
 * The Redis note that says "this rider is on WhatsApp" expires 3 hours into
 * a trip (and goes with a Redis restart), so a trip that ran longer ended in
 * silence: no "trip ended", no receipt. The ride itself records how it was
 * booked, so that decides once a driver is assigned; the note stays only as
 * the quick answer. Before a driver, the note alone decides: a search the
 * rider cancelled in the chat clears it on purpose, to say nothing twice.
 */
async function whatsappRiderPhone(
  deps: StartGatewayConsumerDeps,
  riderId: string,
  rideId: string,
): Promise<string | null> {
  if (!deps.whatsappNotifier) return null;
  let onWhatsapp = await isWhatsappRider(deps.redisClient, riderId).catch(() => false);
  if (!onWhatsapp) {
    const ride = await rideClient.findById(rideId).catch(() => null);
    onWhatsapp = ride?.channel === 'WHATSAPP' && Boolean(ride.driverId);
  }
  if (!onWhatsapp) return null;
  const cached = await lookupPhoneByUserId(deps.redisClient, riderId).catch(() => null);
  if (cached) return cached;
  const user = await userClient.findById(riderId).catch(() => null);
  return user?.phone ?? null;
}

/**
 * Participants of a ride, from memory or — after a gateway restart emptied
 * the map — from the database. Chat, live distance and trip events used to
 * go silent for the rest of every in-flight trip after a deploy.
 */
async function participantsFor(
  rideId: string,
  rideParticipants: Map<string, RideParticipantState>,
): Promise<RideParticipantState | undefined> {
  const cached = rideParticipants.get(rideId);
  if (cached?.riderId && cached.driverUserId) return cached;
  const ride = await rideClient.findById(rideId).catch(() => null);
  if (!ride) return cached;
  let driverUserId = cached?.driverUserId;
  if (!driverUserId && ride.driverId) {
    const driver = await driverClient.findById(ride.driverId).catch(() => null);
    driverUserId = driver?.userId;
  }
  const merged: RideParticipantState = { ...cached, riderId: ride.riderId, driverUserId };
  rideParticipants.set(rideId, merged);
  return merged;
}

/**
 * A bid that is gone on the app side must be gone on the WhatsApp side too,
 * or the rider can still "pay" for a driver who withdrew.
 */
/** What the offer count on "Your bid is in" needs: Redis and the WhatsApp sender. */
function offerCountDeps(deps: Pick<StartGatewayConsumerDeps, 'redisClient' | 'whatsappNotifier'>) {
  if (!deps.whatsappNotifier) return null;
  return { redis: deps.redisClient, meta: { metaAccessToken: deps.whatsappNotifier.metaAccessToken, metaPhoneNumberId: deps.whatsappNotifier.metaPhoneNumberId } };
}

/** The search is over: the number on "Your bid is in" goes. */
async function endOfferCount(deps: StartGatewayConsumerDeps, rideId: string): Promise<void> {
  const countDeps = offerCountDeps(deps);
  if (countDeps) await clearOfferCount(countDeps, rideId).catch(() => undefined);
}

export async function dropBidFromWhatsappRide(
  deps: Pick<StartGatewayConsumerDeps, 'redisClient' | 'whatsappNotifier'>,
  rideId: string,
  riderId: string,
  driverId: string,
): Promise<void> {
  const bids = await getBids(deps.redisClient, rideId).catch(() => []);
  const gone = bids.find((b) => b.driverId === driverId);
  if (!gone) return;
  const remaining = await removeBid(deps.redisClient, rideId, driverId).catch(() => bids);
  await storeLastBatch(deps.redisClient, rideId, remaining).catch(() => {});
  if (!deps.whatsappNotifier) return;
  if (await hasOffersPageMessage(deps.redisClient, rideId)) {
    // On the ride page the number is put right when they leave.
    if (await isRidePageOpen(deps.redisClient, riderId)) await deferUntilPageLeft(deps.redisClient, riderId, { kind: 'offer_count', rideId }).catch(() => undefined);
    else await showOfferCount(offerCountDeps(deps)!, rideId, remaining.length);
    return;
  }
  const isWa = await isWhatsappRider(deps.redisClient, riderId);
  if (!isWa) return;
  // On the ride page the offer simply leaves the list there: nothing in the chat.
  if (await isRidePageOpen(deps.redisClient, riderId)) return;
  const phone = await lookupPhoneByUserId(deps.redisClient, riderId);
  if (!phone) return;
  // With the offers form nothing needs saying: it opens on the live list, and
  // picking a driver who has gone is refused there. A message per withdrawal is noise.
  if (offersFormIsOn(deps.whatsappNotifier) && !(await getGroupSeat(deps.redisClient, rideId).catch(() => null))) return;
  await sendOfferWithdrawnNotification(deps.whatsappNotifier, phone, gone.driverName, remaining.length).catch(() => {});
  // The message they were about to tap still lists the driver who left. Give
  // them a fresh one rather than a tap that answers "no longer available".
  if (remaining.length === 0) return;
  const meta = await getRideMeta(deps.redisClient, rideId).catch(() => null);
  if (!meta || meta.source === 'flow') return;
  const stillThere = sortOffers(remaining);
  await storeLastBatch(deps.redisClient, rideId, stillThere).catch(() => {});
  await announceOffers(deps, phone, rideId, riderId, stillThere, meta.offerNgn).catch(() => {});
}
