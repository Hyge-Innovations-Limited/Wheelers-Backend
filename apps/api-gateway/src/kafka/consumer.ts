import { randomUUID } from 'node:crypto';
import type { WheelersConsumer } from '@wheleers/kafka-client';
import { referralClient, walletClient, virtualAccountClient, driverClient, userClient, driverBidClient, rideClient, complianceClient } from '@wheleers/db';
import {
  ComplianceEvent,
  GroupRideEvent,
  GpsProcessedEvent,
  NotificationEvent,
  RideEvent,
  WalletEvent,
  TOPICS,
} from '@wheleers/kafka-schemas';
import { calculateRideFees } from '@wheleers/config';
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
  hasUnopenedOffersMessage,
  markOffersMessageSent,
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
  storeLastBatch,
  getGroupRequestRider,
  storeWhatsappRide,
  setActiveRide,
  storeGroupSeat,
  storeGroupSeatMembers,
  getAcceptedBid,
  storeLastCompletedRide,
  getLastBatch,
} from '../whatsapp-flows/bid-state';
import type { WhatsappBid } from '../whatsapp-flows/bid-state';
import {
  sendBidNotification,
  sendOffersInChat,
  offersFormIsOn,
  sortOffers,
  sendFlowOffersMessage,
  sendRideMatchedNotification,
  sendDriverArrivedNotification,
  sendRideStartedNotification,
  sendRideCompletedNotification,
  setGroupRideChecker,
  sendRideCancelledNotification,
  sendBidTimeoutNotification,
  sendOfferWithdrawnNotification,
  sendRiderPaidNotification,
  sendDepositConfirmation,
  sendGroupRideGroupedNotification,
  sendGroupRideDriverAssignedNotification,
  sendGroupRideDispatchNotification,
} from '../whatsapp-flows/whatsapp-notifier';
import type { WhatsappNotifierDeps } from '../whatsapp-flows/whatsapp-notifier';
import type { DriverKycStorage } from '../storage/driver-kyc-storage';
import type { GatewayPublisher } from '../websocket/publisher';

export interface StartGatewayConsumerDeps {
  consumer: WheelersConsumer;
  registry: SocketRegistry;
  redisClient: RedisClient;
  publisher: GatewayPublisher;
  whatsappNotifier?: WhatsappNotifierDeps;
  /** Resolves a driver's KYC photos — the car's, shown when they arrive. */
  kycStorage?: DriverKycStorage;
  /**
   * A WhatsApp rider's deposit has landed. Returns true when it was spoken for —
   * the rider had tapped a driver and was adding money to take them, so the chat
   * has already said what happened — and the plain "deposit received" is skipped.
   */
  onWhatsappDeposit?: (deposit: { userId: string; amountNgn: number; newBalanceNgn: number }) => Promise<boolean>;
}

interface RideParticipantState {
  riderId: string;
  driverUserId?: string;
}

export async function startGatewayKafkaConsumer(deps: StartGatewayConsumerDeps): Promise<void> {
  // The receipt's Repeat / Reverse buttons must not be offered for a group seat.
  setGroupRideChecker(async (rideId) => Boolean(await getGroupSeat(deps.redisClient, rideId).catch(() => null)));
  const rideParticipants = new Map<string, RideParticipantState>();

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
  deps: StartGatewayConsumerDeps,
  phone: string,
  rideId: string,
  riderId: string,
  bids: WhatsappBid[],
  riderOfferNgn: number,
  changes?: string[],
): Promise<void> {
  if (!deps.whatsappNotifier) return;
  const groupSeat = await getGroupSeat(deps.redisClient, rideId).catch(() => null);
  if (!groupSeat) {
    // The offers form: ONE unopened message at a time. It opens on the live list,
    // so more offers while it sits unopened need no second message — the next one
    // goes out only after they have looked (opening the form clears the mark).
    if (offersFormIsOn(deps.whatsappNotifier) && await hasUnopenedOffersMessage(deps.redisClient, rideId)) return;
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

/** One ride event, as the Kafka loop feeds it. Exported for the tests that replay events. */
export async function handleRideEvent(
  event: RideEvent,
  deps: StartGatewayConsumerDeps,
  rideParticipants: Map<string, RideParticipantState>,
): Promise<void> {
  const registry = deps.registry;
  if (event.eventType === 'RIDE_REQUESTED') {
    rideParticipants.set(event.rideId, { riderId: event.riderId });
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
    }
    console.info('[consumer] counter-offer', {
      rideId: event.rideId,
      driver: event.driverName,
      offerNgn: event.counterOfferNgn,
      waRider,
      hasNotifier: !!deps.whatsappNotifier,
    });
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
      if (phone && meta) {
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
            console.info('[consumer] sending flow offers message', { rideId: event.rideId, bids: allBids.length });
            await sendFlowOffersMessage(deps.whatsappNotifier, phone, event.riderId, meta, allBids)
              .catch((err) => console.warn('[consumer] WhatsApp flow offers message failed', err));
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

    // The rider is told "no driver found" — but the DRIVERS who bid were
    // never told anything, so their apps showed "waiting for rider" forever
    // over an auction that no longer existed. The bids table knows exactly
    // who has money on this table; tell each of them before resolving.
    const openBids = await driverBidClient.findByRide(event.rideId).catch(() => []);
    for (const bid of openBids) {
      if (bid.status !== 'PENDING') continue;
      void registry.sendToUser(bid.driverUserId, 'ride:bid_timeout', {
        rideId: event.rideId,
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

    await driverBidClient.resolvePending(event.rideId, 'EXPIRED').catch(() => {});

    // Same money cleanup as a cancellation: the fare hold and any reserved
    // referral cashback must go back to the rider now that nobody accepted.
    await walletClient.cancelRideHold(event.rideId).catch(() => {});
    await referralClient.releaseRideCashback(event.rideId).catch((error) => {
      console.warn('[gateway] referral cashback release after bid timeout failed', {
        rideId: event.rideId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    const waRider = await isWhatsappRider(deps.redisClient, event.riderId);
    if (waRider && deps.whatsappNotifier) {
      const phone = await lookupPhoneByUserId(deps.redisClient, event.riderId);
      if (phone) {
        const timedOutMeta = await getRideMeta(deps.redisClient, event.rideId).catch(() => null);
        await sendBidTimeoutNotification(deps.whatsappNotifier, phone, timedOutMeta?.offerNgn).catch(() => {});
      }
      await clearActiveRideIfMatches(deps.redisClient, event.riderId, event.rideId);
      await clearPendingAccept(deps.redisClient, event.riderId).catch(() => {});
      await cleanupRideKeys(deps.redisClient, event.rideId);
    } else {
      await registry.sendToUser(event.riderId, 'ride:bid_timeout', {
        rideId: event.rideId,
      });
    }
    rideParticipants.delete(event.rideId);
    return;
  }

  if (event.eventType === 'RIDE_DRIVER_ASSIGNED') {
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
      if (losing.driverId === event.driverId || losing.status !== 'PENDING') continue;
      void registry.sendToUser(losing.driverUserId, 'ride:bid_lost', {
        rideId: event.rideId,
      });
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

    // Notify rider
    const waRider = await isWhatsappRider(deps.redisClient, event.riderId);
    if (waRider && deps.whatsappNotifier) {
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

      const phone = await lookupPhoneByUserId(deps.redisClient, event.riderId);
      if (phone) {
        const acceptedBid = await getAcceptedBid(deps.redisClient, event.rideId).catch(() => null);
        await sendRideMatchedNotification(
          deps.whatsappNotifier, phone,
          event.driverName, event.vehicleModel,
          event.vehiclePlate ?? '', event.etaSeconds,
          event.agreedFareNgn, event.driverRating ?? 0,
          acceptedBid?.driverPhone,
        ).catch(() => {});
      }
    } else {
      const riderMatchFees = calculateRideFees(event.agreedFareNgn);

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
      });

      // Push too — the socket only reaches a foregrounded app, and "driver
      // on the way" is exactly the message a backgrounded rider must see.
      const etaMin = Math.max(1, Math.ceil(event.etaSeconds / 60));
      await deps.publisher.publishNotificationEvent({
        eventType: 'PUSH_SEND',
        notificationId: randomUUID(),
        userId: event.riderId,
        title: 'Driver found! 🚗',
        body: `${event.driverName} is on the way — they'll be with you in ~${etaMin} min.`,
        data: { type: 'ride:matched', rideId: event.rideId },
        priority: 'high',
        timestamp: new Date().toISOString(),
      }).catch(() => {});
    }

    // Notify driver via WebSocket (app) — include fee breakdown
    const matchFees = calculateRideFees(event.agreedFareNgn);

    // Look up rider phone so driver can call them
    let riderPhone: string | undefined;
    try {
      const riderUser = await userClient.findById(event.riderId);
      riderPhone = riderUser?.phone ?? undefined;
    } catch { /* non-critical */ }

    // Ship the route with the match. The driver app's offer card expires
    // after 30s while the rider takes minutes to pay, so by now the app often
    // has nothing left to rebuild the trip from — the match was dropped with
    // a console warning and the driver kept seeing "waiting for rider".
    const rideSnapshot = await loadDriverRideSnapshot(event.rideId).catch(() => null);

    await registry.sendToUser(event.driverUserId, 'ride:matched', {
      rideId: event.rideId,
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
      vatNgn: matchFees.vatNgn,
      stateLevyNgn: matchFees.stateLevyNgn,
      serviceFeeNgn: matchFees.serviceFeeNgn,
      driverEarningsNgn: matchFees.driverPayoutNgn,
      lockedFareNgn: event.lockedFareNgn,
      paymentMethod: event.paymentMethod,
      riderPaid: event.paymentMethod !== 'CASH',
      riderPhone,
    });

    return;
  }

  if (event.eventType === 'RIDE_ROUTE_UPDATED') {
    const routePayload = {
      rideId: event.rideId,
      destination: event.destination,
      stops: event.stops,
      route: event.route,
      plannedDistanceKm: event.plannedDistanceKm,
      plannedDurationSeconds: event.plannedDurationSeconds,
      ...buildRideEstimatePricing(event.plannedDistanceKm),
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
    const waRider = await isWhatsappRider(deps.redisClient, event.riderId);
    if (waRider && deps.whatsappNotifier) {
      await setActiveRide(deps.redisClient, event.riderId, event.rideId, IN_TRIP_ACTIVE_RIDE_TTL);
      const phone = await lookupPhoneByUserId(deps.redisClient, event.riderId);
      if (phone) {
        const arrivedBid = await getAcceptedBid(deps.redisClient, event.rideId).catch(() => null);
        await sendDriverArrivedNotification(deps.whatsappNotifier, phone, {
          driverName: arrivedBid?.driverName,
          vehicleModel: arrivedBid?.vehicleModel,
          vehiclePlate: arrivedBid?.vehiclePlate,
          driverPhone: arrivedBid?.driverPhone,
          carPhotoUrl: await carPhotoFor(deps, event.driverId),
        }).catch(() => {});
      }
    } else {
      await registry.sendToUser(event.riderId, 'ride:driver_arrived', {
        rideId: event.rideId,
        driverId: event.driverId,
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
    const waRider = await isWhatsappRider(deps.redisClient, event.riderId);
    if (waRider && deps.whatsappNotifier) {
      await setRideState(deps.redisClient, event.rideId, 'in_progress', IN_TRIP_ACTIVE_RIDE_TTL);
      await setActiveRide(deps.redisClient, event.riderId, event.rideId, IN_TRIP_ACTIVE_RIDE_TTL);
      const phone = await lookupPhoneByUserId(deps.redisClient, event.riderId);
      if (phone) {
        await sendRideStartedNotification(deps.whatsappNotifier, phone).catch(() => {});
      }
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

    // Notify rider
    const waRider = await isWhatsappRider(deps.redisClient, event.riderId);
    if (waRider && deps.whatsappNotifier) {
      const phone = await lookupPhoneByUserId(deps.redisClient, event.riderId);
      if (phone) {
        const riderWallet = await walletClient.findByUserId(event.riderId).catch(() => null);
        await sendRideCompletedNotification(
          deps.whatsappNotifier, phone, event.fareNgn, event.distanceKm,
          riderWallet ? Number(riderWallet.balanceNgn) : undefined,
          event.rideId,
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
      const riderFees = calculateRideFees(event.fareNgn);
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
    const completionFees = calculateRideFees(event.fareNgn);
    await registry.sendToUser(event.driverUserId, 'ride:completed', {
      rideId: event.rideId,
      fareNgn: event.fareNgn,
      vatNgn: completionFees.vatNgn,
      stateLevyNgn: completionFees.stateLevyNgn,
      serviceFeeNgn: completionFees.serviceFeeNgn,
      totalChargedNgn: completionFees.totalNgn,
      driverEarningsNgn: completionFees.driverPayoutNgn,
      distanceKm: event.distanceKm,
      durationSeconds: event.durationSeconds,
      completedAt: event.completedAt,
    });

    // Clean up WhatsApp Redis state
    await cleanupRideKeys(deps.redisClient, event.rideId);

    rideParticipants.delete(event.rideId);
    return;
  }

  if (event.eventType === 'RIDE_CANCELLED') {
    // A rider cancelling BEFORE a match leaves bidders in the same forever-
    // waiting state as a timeout — the assigned-driver notification below
    // only fires when there IS an assigned driver. Same message as a
    // timeout: to a bidder, "request gone" is all that matters.
    const openBids = await driverBidClient.findByRide(event.rideId).catch(() => []);
    for (const bid of openBids) {
      if (bid.status !== 'PENDING') continue;
      if (event.driverUserId && bid.driverUserId === event.driverUserId) continue;
      void registry.sendToUser(bid.driverUserId, 'ride:bid_timeout', {
        rideId: event.rideId,
      });
    }

    await driverBidClient.resolvePending(event.rideId, 'CANCELLED').catch(() => {});

    // Release wallet hold so locked funds return to rider's balance.
    // wallet-service releases it too (consumer race) — whichever ran first,
    // the result still carries the hold amount and the wallet's balance, so
    // the rider's message can state the refund as a fact, not a hope.
    // A driver bailing puts the ride back into matching under the same id.
    // The rider's fare stays held for the next driver; releasing it here
    // meant the re-match ran unsecured and completion found no hold.
    const driverBailed = event.cancelledBy === 'driver';
    const holdRelease = driverBailed
      ? null
      : await walletClient.cancelRideHold(event.rideId).catch(() => null);

    const releasedReferralCashback = await referralClient.releaseRideCashback(
      event.rideId,
    );

    // Notify rider
    const waRider = await isWhatsappRider(deps.redisClient, event.riderId);
    if (waRider && deps.whatsappNotifier) {
      const phone = await lookupPhoneByUserId(deps.redisClient, event.riderId);
      if (phone) {
        await sendRideCancelledNotification(deps.whatsappNotifier, phone, {
          reason: event.reason,
          cancelledBy: event.cancelledBy,
          refundedNgn: holdRelease?.holdAmountNgn,
          balanceNgn: holdRelease ? Number(holdRelease.wallet.balanceNgn) : undefined,
        }).catch(() => {});
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
      });
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
      } else {
        console.warn('[gateway] ride cancelled but the driver could not be notified', {
          rideId: event.rideId,
          driverId: event.driverId,
        });
      }
    }

    if (!driverBailed) {
      // Clean up WhatsApp Redis state for this ride
      await cleanupRideKeys(deps.redisClient, event.rideId);
      await clearActiveRideIfMatches(deps.redisClient, event.riderId, event.rideId).catch(() => {});
    }

    rideParticipants.delete(event.rideId);
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
      reason: event.reason,
    });
    return;
  }

  if (event.eventType === 'CHAT_MESSAGE_SENT') {
    const chatPayload = {
      messageId: event.messageId,
      rideId: event.rideId,
      senderId: event.senderId,
      senderRole: event.senderRole,
      content: event.content,
      createdAt: event.timestamp,
    };

    // Send to both participants. The map is in-memory; after a restart it is
    // empty for every in-flight trip, so fall back to the database.
    const participants = await participantsFor(event.rideId, rideParticipants);
    if (participants?.riderId) {
      await registry.sendToUser(participants.riderId, 'chat:message', chatPayload);
    }
    if (participants?.driverUserId) {
      await registry.sendToUser(participants.driverUserId, 'chat:message', chatPayload);
    }
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
            // Also send WhatsApp confirmation to rider
            const phone = await lookupPhoneByUserId(deps.redisClient, event.userId);
            if (phone) {
              await sendRiderPaidNotification(deps.whatsappNotifier, phone, event.newBalanceNgn)
                .catch(() => {});
            }
            handledByRide = true;
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
    if (!handledByRide && deps.whatsappNotifier && event.creditType === 'deposit') {
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
async function dropBidFromWhatsappRide(
  deps: StartGatewayConsumerDeps,
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
  const isWa = await isWhatsappRider(deps.redisClient, riderId);
  if (!isWa) return;
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
