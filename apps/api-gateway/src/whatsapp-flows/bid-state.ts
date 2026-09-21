import type { RedisClient } from '../redis/client';

export type RideState = 'setup' | 'searching' | 'bidding' | 'confirmed' | 'in_progress' | 'completed';

export interface PendingLocation {
  lat: number;
  lng: number;
  address: string;
  savedAt: string;
  /**
   * A destination the rider already named in their first message, carried
   * forward so "yes" at the destination prompt confirms it instead of being
   * geocoded as a place called "Yes".
   */
  suggestedDestination?: string;
}

export interface WhatsappRideMeta {
  riderId: string;
  phone: string;
  /** 'flow' = booked inside the WhatsApp form; bid chat spam is suppressed. */
  source?: 'chat' | 'flow';
  pickupAddress: string;
  pickupLat?: number;
  pickupLng?: number;
  destinationAddress: string;
  destinationLat?: number;
  destinationLng?: number;
  distanceKm?: number;
  durationSeconds?: number;
  offerNgn: number;
  suggestedFareNgn: number;
  paymentMethod: 'CASH' | 'WALLET';
  createdAt: string;
}

export interface WhatsappBid {
  /** Durable DriverBid.id — acceptance names this exact bid and price. */
  bidId?: string;
  driverId: string;
  driverUserId: string;
  counterOfferNgn: number;
  driverName: string;
  driverRating: number;
  vehiclePlate: string;
  vehicleModel: string;
  etaSeconds: number;
  /** Driver→pickup km at bid time — shown next to the ETA in the bid list. */
  distanceKm?: number;
  receivedAt: string;
}

const RIDE_META_TTL = 900;           // 15 minutes
const BIDS_TTL = 900;                // 15 minutes
const RIDE_STATE_TTL = 1800;         // 30 minutes
const ACTIVE_RIDE_TTL = 1800;        // 30 minutes — while still looking for a driver
/**
 * Once a driver is assigned the pointer must outlive the trip. It used to
 * expire 30 minutes after booking, so on a long ride "cancel" fell into the
 * booking flow and the completion message never came.
 */
export const IN_TRIP_ACTIVE_RIDE_TTL = 3 * 60 * 60;
const PENDING_LOCATION_TTL = 600;    // 10 minutes
const PHONE_LOOKUP_TTL = 86400;      // 24 hours
const DEBOUNCE_TTL = 30;             // 30 seconds
const BID_BATCH_TTL = 900;           // 15 minutes — stores last batch sent to rider

function rideMetaKey(rideId: string): string {
  return `whatsapp:ride:${rideId}:meta`;
}

function rideBidsKey(rideId: string): string {
  return `whatsapp:ride:${rideId}:bids`;
}

function rideStateKey(rideId: string): string {
  return `whatsapp:ride:${rideId}:state`;
}

function activeRideKey(userId: string): string {
  return `whatsapp:user:${userId}:active_ride`;
}

function pendingLocationKey(userId: string): string {
  return `whatsapp:user:${userId}:pending_location`;
}

function areaHintKey(userId: string): string {
  return `whatsapp:user:${userId}:area_hint`;
}

function phoneLookupKey(userId: string): string {
  return `whatsapp:phone_by_user:${userId}`;
}

function debounceKey(rideId: string): string {
  return `whatsapp:ride:${rideId}:last_notified`;
}

export async function storeWhatsappRide(
  redis: RedisClient,
  rideId: string,
  meta: WhatsappRideMeta,
): Promise<void> {
  await Promise.all([
    redis.set(rideMetaKey(rideId), JSON.stringify(meta), RIDE_META_TTL),
    redis.set(rideBidsKey(rideId), JSON.stringify([]), BIDS_TTL),
    redis.set(rideStateKey(rideId), 'searching' as RideState, RIDE_STATE_TTL),
  ]);
}

export async function getRideMeta(
  redis: RedisClient,
  rideId: string,
): Promise<WhatsappRideMeta | null> {
  const raw = await redis.get(rideMetaKey(rideId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WhatsappRideMeta;
  } catch {
    console.warn('[bid-state] Corrupted ride meta, clearing', { rideId });
    await redis.del(rideMetaKey(rideId)).catch(() => {});
    return null;
  }
}

export async function addBid(
  redis: RedisClient,
  rideId: string,
  bid: WhatsappBid,
): Promise<number> {
  const bids = await getBids(redis, rideId);
  // Replace if same driver already bid, otherwise append
  const existing = bids.findIndex((b) => b.driverId === bid.driverId);
  if (existing >= 0) {
    bids[existing] = bid;
  } else {
    bids.push(bid);
  }
  await redis.set(rideBidsKey(rideId), JSON.stringify(bids), BIDS_TTL);
  return bids.length;
}

export async function getBids(
  redis: RedisClient,
  rideId: string,
): Promise<WhatsappBid[]> {
  const raw = await redis.get(rideBidsKey(rideId));
  if (!raw) return [];
  try {
    return JSON.parse(raw) as WhatsappBid[];
  } catch {
    console.warn('[bid-state] Corrupted bids data, clearing', { rideId });
    await redis.del(rideBidsKey(rideId)).catch(() => {});
    return [];
  }
}

export async function clearBids(
  redis: RedisClient,
  rideId: string,
): Promise<void> {
  await redis.set(rideBidsKey(rideId), JSON.stringify([]), BIDS_TTL);
}

export async function removeBid(
  redis: RedisClient,
  rideId: string,
  driverId: string,
): Promise<WhatsappBid[]> {
  const bids = await getBids(redis, rideId);
  const filtered = bids.filter((b) => b.driverId !== driverId);
  await redis.set(rideBidsKey(rideId), JSON.stringify(filtered), BIDS_TTL);
  return filtered;
}

export async function setActiveRide(
  redis: RedisClient,
  userId: string,
  rideId: string,
  ttlSeconds: number = ACTIVE_RIDE_TTL,
): Promise<void> {
  await redis.set(activeRideKey(userId), rideId, ttlSeconds);
}

/**
 * Clear the pointer only if it still names this ride. Cleanup for a ride
 * that ended used to wipe whatever the rider had moved on to.
 */
export async function clearActiveRideIfMatches(
  redis: RedisClient,
  userId: string,
  rideId: string,
): Promise<boolean> {
  const current = await redis.get(activeRideKey(userId)).catch(() => null);
  if (current !== null && current !== rideId) return false;
  await redis.del(activeRideKey(userId));
  return true;
}

export async function getActiveRide(
  redis: RedisClient,
  userId: string,
): Promise<string | null> {
  return redis.get(activeRideKey(userId));
}

export async function clearActiveRide(
  redis: RedisClient,
  userId: string,
): Promise<void> {
  await redis.del(activeRideKey(userId));
}

export async function isWhatsappRider(
  redis: RedisClient,
  riderId: string,
): Promise<boolean> {
  const activeRide = await redis.get(activeRideKey(riderId)).catch(() => null);
  return activeRide !== null;
}

export async function setPhoneLookup(
  redis: RedisClient,
  userId: string,
  phone: string,
): Promise<void> {
  await redis.set(phoneLookupKey(userId), phone, PHONE_LOOKUP_TTL);
}

export async function lookupPhoneByUserId(
  redis: RedisClient,
  userId: string,
): Promise<string | null> {
  return redis.get(phoneLookupKey(userId));
}

export async function cleanupRideKeys(
  redis: RedisClient,
  rideId: string,
): Promise<void> {
  await Promise.all([
    redis.del(rideMetaKey(rideId)),
    redis.del(rideBidsKey(rideId)),
    redis.del(rideStateKey(rideId)),
    redis.del(debounceKey(rideId)),
    redis.del(lastBatchKey(rideId)),
    redis.del(acceptedBidKey(rideId)),
  ]).catch(() => {});
}

export async function shouldNotify(
  redis: RedisClient,
  rideId: string,
): Promise<boolean> {
  const existing = await redis.get(debounceKey(rideId)).catch(() => null);
  if (existing) return false;
  await redis.set(debounceKey(rideId), Date.now().toString(), DEBOUNCE_TTL);
  return true;
}

// ── Accepted bid (stored so driver profile flow can read it) ──────────────

export interface AcceptedBidInfo {
  driverName: string;
  driverPhone: string;
  driverUserId: string;
  vehicleModel: string;
  vehiclePlate: string;
  vehicleColor: string;
  driverRating: number;
  totalRides: number;
  etaSeconds: number;
  fareNgn: number;
}

function acceptedBidKey(rideId: string): string {
  return `whatsapp:ride:${rideId}:accepted_bid`;
}

export async function storeAcceptedBid(
  redis: RedisClient,
  rideId: string,
  info: AcceptedBidInfo,
): Promise<void> {
  await redis.set(acceptedBidKey(rideId), JSON.stringify(info), RIDE_STATE_TTL);
}

export async function getAcceptedBid(
  redis: RedisClient,
  rideId: string,
): Promise<AcceptedBidInfo | null> {
  const raw = await redis.get(acceptedBidKey(rideId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AcceptedBidInfo;
  } catch {
    return null;
  }
}

// ── Ride state machine ─────────────────────────────────────────────────────

export async function setRideState(
  redis: RedisClient,
  rideId: string,
  state: RideState,
  ttlSeconds: number = RIDE_STATE_TTL,
): Promise<void> {
  await redis.set(rideStateKey(rideId), state, ttlSeconds);
}

export async function getRideState(
  redis: RedisClient,
  rideId: string,
): Promise<RideState | null> {
  const raw = await redis.get(rideStateKey(rideId));
  return (raw as RideState) ?? null;
}

// ── Pending location (saved when rider shares WhatsApp location pin) ────

export async function setPendingLocation(
  redis: RedisClient,
  userId: string,
  location: PendingLocation,
): Promise<void> {
  await redis.set(pendingLocationKey(userId), JSON.stringify(location), PENDING_LOCATION_TTL);
}

export async function getPendingLocation(
  redis: RedisClient,
  userId: string,
): Promise<PendingLocation | null> {
  const raw = await redis.get(pendingLocationKey(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingLocation;
  } catch {
    return null;
  }
}

export async function clearPendingLocation(
  redis: RedisClient,
  userId: string,
): Promise<void> {
  await redis.del(pendingLocationKey(userId));
}

// ── Rider booking stage (tracks where the rider is in the booking flow) ───

export type BookingStage = 'awaiting_pickup' | 'awaiting_destination' | 'awaiting_route_confirmation' | 'awaiting_price' | 'awaiting_payment' | 'awaiting_cancel_reason' | 'awaiting_withdrawal_amount' | 'awaiting_withdrawal_bank' | 'awaiting_withdrawal_account' | 'awaiting_withdrawal_confirmation' | 'searching' | 'bidding' | 'editing_pickup' | 'editing_destination' | 'group_awaiting_pickup' | 'group_awaiting_destination' | 'group_awaiting_confirm' | 'group_awaiting_face_photo';

function bookingStageKey(userId: string): string {
  return `whatsapp:user:${userId}:booking_stage`;
}

export async function setBookingStage(
  redis: RedisClient,
  userId: string,
  stage: BookingStage,
): Promise<void> {
  // Group-ride stages get a longer window: riders answer the pickup and
  // selfie prompts on their own time, and a 10-minute expiry silently dumped
  // them into the solo flow mid-conversation.
  const ttl = stage.startsWith('group_') ? 1800 : PENDING_LOCATION_TTL;
  await redis.set(bookingStageKey(userId), stage, ttl);
}

export async function getBookingStage(
  redis: RedisClient,
  userId: string,
): Promise<BookingStage | null> {
  const raw = await redis.get(bookingStageKey(userId));
  return (raw as BookingStage) ?? null;
}

export async function clearBookingStage(
  redis: RedisClient,
  userId: string,
): Promise<void> {
  await redis.del(bookingStageKey(userId));
}

// ── Pending WhatsApp wallet withdrawal ────────────────────────────────────

export interface PendingWhatsappWithdrawal {
  amountNgn: number;
  bankUuid?: string;
  bankName?: string;
  accountNumber?: string;
  accountName?: string;
}

const PENDING_WITHDRAWAL_TTL = 600; // 10 minutes

function pendingWithdrawalKey(userId: string): string {
  return `whatsapp:user:${userId}:pending_withdrawal`;
}

export async function storePendingWhatsappWithdrawal(
  redis: RedisClient,
  userId: string,
  data: PendingWhatsappWithdrawal,
): Promise<void> {
  await redis.set(pendingWithdrawalKey(userId), JSON.stringify(data), PENDING_WITHDRAWAL_TTL);
}

export async function getPendingWhatsappWithdrawal(
  redis: RedisClient,
  userId: string,
): Promise<PendingWhatsappWithdrawal | null> {
  const raw = await redis.get(pendingWithdrawalKey(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingWhatsappWithdrawal;
  } catch {
    return null;
  }
}

export async function clearPendingWhatsappWithdrawal(
  redis: RedisClient,
  userId: string,
): Promise<void> {
  await redis.del(pendingWithdrawalKey(userId));
}

// ── Pending route (stored after destination pin, awaiting rider's price) ──

export interface PendingRouteData {
  pickupLat: number;
  pickupLng: number;
  pickupAddress: string;
  destLat: number;
  destLng: number;
  destAddress: string;
  distanceKm: number;
  durationSeconds: number;
  suggestedFareNgn: number;
  minOfferNgn: number;
  ratePerKmNgn: number;
  route: unknown;
  /** Price the rider already named, held across the confirmation step. */
  offerNgn?: number;
}

const PENDING_ROUTE_TTL = 600; // 10 minutes

function pendingRouteKey(userId: string): string {
  return `whatsapp:user:${userId}:pending_route`;
}

export async function storePendingRoute(
  redis: RedisClient,
  userId: string,
  data: PendingRouteData,
): Promise<void> {
  await redis.set(pendingRouteKey(userId), JSON.stringify(data), PENDING_ROUTE_TTL);
}

export async function getPendingRoute(
  redis: RedisClient,
  userId: string,
): Promise<PendingRouteData | null> {
  const raw = await redis.get(pendingRouteKey(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingRouteData;
  } catch {
    return null;
  }
}

export async function clearPendingRoute(
  redis: RedisClient,
  userId: string,
): Promise<void> {
  await redis.del(pendingRouteKey(userId));
}

// ── Pending accept (rider picked a driver, awaiting wallet payment) ───────

export interface PendingAcceptData {
  bidId?: string;
  rideId: string;
  driverId: string;
  driverUserId: string;
  driverName: string;
  driverPhone: string;
  driverRating: number;
  totalRides: number;
  vehicleModel: string;
  vehiclePlate: string;
  etaSeconds: number;
  fareNgn: number;
}

const PENDING_ACCEPT_TTL = 300; // 5 minutes

function pendingAcceptKey(userId: string): string {
  return `whatsapp:user:${userId}:pending_accept`;
}

export interface LastCompletedRide {
  rideId: string;
  driverUserId: string;
  driverName?: string;
}

const lastCompletedKey = (userId: string) => `wa:lastcompleted:${userId}`;
const LAST_COMPLETED_TTL = 24 * 3600; // the rating window

export async function storeLastCompletedRide(
  redis: RedisClient,
  userId: string,
  data: LastCompletedRide,
): Promise<void> {
  await redis.set(lastCompletedKey(userId), JSON.stringify(data), LAST_COMPLETED_TTL);
}

export async function getLastCompletedRide(
  redis: RedisClient,
  userId: string,
): Promise<LastCompletedRide | null> {
  const raw = await redis.get(lastCompletedKey(userId));
  if (!raw) return null;
  try { return JSON.parse(raw) as LastCompletedRide; } catch { return null; }
}

export async function clearLastCompletedRide(redis: RedisClient, userId: string): Promise<void> {
  await redis.del(lastCompletedKey(userId));
}

export interface LastRouteData {
  pickupLat: number;
  pickupLng: number;
  pickupAddress: string;
  destLat: number;
  destLng: number;
  destAddress: string;
  distanceKm: number;
  durationSeconds: number;
  suggestedFareNgn: number;
  minOfferNgn: number;
  ratePerKmNgn: number;
  route?: unknown;
  offerNgn: number;
}

const lastRouteKey = (userId: string) => `wa:lastroute:${userId}`;
const LAST_ROUTE_TTL = 86_400; // a day — "search again" should survive a nap

/** The route the rider last searched with — fuel for "search again". */
export async function storeLastRoute(
  redis: RedisClient,
  userId: string,
  data: LastRouteData,
): Promise<void> {
  await redis.set(lastRouteKey(userId), JSON.stringify(data), LAST_ROUTE_TTL);
}

export async function getLastRoute(
  redis: RedisClient,
  userId: string,
): Promise<LastRouteData | null> {
  const raw = await redis.get(lastRouteKey(userId));
  if (!raw) return null;
  try { return JSON.parse(raw) as LastRouteData; } catch { return null; }
}

export async function storePendingAccept(
  redis: RedisClient,
  userId: string,
  data: PendingAcceptData,
): Promise<void> {
  await redis.set(pendingAcceptKey(userId), JSON.stringify(data), PENDING_ACCEPT_TTL);
}

export async function getPendingAccept(
  redis: RedisClient,
  userId: string,
): Promise<PendingAcceptData | null> {
  const raw = await redis.get(pendingAcceptKey(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingAcceptData;
  } catch {
    return null;
  }
}

export async function clearPendingAccept(
  redis: RedisClient,
  userId: string,
): Promise<void> {
  await redis.del(pendingAcceptKey(userId));
}

// ── Last bid batch sent to rider (for numbered accept/counter) ────────────

function lastBatchKey(rideId: string): string {
  return `whatsapp:ride:${rideId}:last_batch`;
}

export async function storeLastBatch(
  redis: RedisClient,
  rideId: string,
  bids: WhatsappBid[],
): Promise<void> {
  await redis.set(lastBatchKey(rideId), JSON.stringify(bids), BID_BATCH_TTL);
}

export async function getLastBatch(
  redis: RedisClient,
  rideId: string,
): Promise<WhatsappBid[]> {
  const raw = await redis.get(lastBatchKey(rideId));
  if (!raw) return [];
  try {
    return JSON.parse(raw) as WhatsappBid[];
  } catch {
    return [];
  }
}

/**
 * The broad area a rider named when they were not specific enough to geocode —
 * "Allen", "Lekki", "Ikeja". Held so the follow-up answer can be resolved
 * against it: someone who says "from Allen" and is asked "whereabouts in
 * Allen?" replies "roundabout", which only means anything combined with the
 * area they already gave. Without this the reply is geocoded on its own and
 * lands nowhere, and the rider has to retype the whole thing.
 */
export type PendingAreaHint = {
  kind: 'pickup' | 'destination';
  area: string;
  /** The other end of the trip, if they already gave it. */
  counterpartAddress?: string;
};

export async function setPendingAreaHint(
  redis: RedisClient,
  userId: string,
  hint: PendingAreaHint,
): Promise<void> {
  await redis.set(areaHintKey(userId), JSON.stringify(hint), PENDING_LOCATION_TTL);
}

export async function getPendingAreaHint(
  redis: RedisClient,
  userId: string,
): Promise<PendingAreaHint | null> {
  const raw = await redis.get(areaHintKey(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingAreaHint;
  } catch {
    return null;
  }
}

export async function clearPendingAreaHint(
  redis: RedisClient,
  userId: string,
): Promise<void> {
  await redis.del(areaHintKey(userId));
}

// ── Pending group ride (WhatsApp group-ride booking flow state) ───────────

export interface PendingGroupRide {
  pickupLat?: number;
  pickupLng?: number;
  pickupAddress?: string;
  destLat?: number;
  destLng?: number;
  destAddress?: string;
  plannedDistanceKm?: number;
  plannedDurationSeconds?: number;
  fareEstimateNgn?: number;
  /** Set once the match request row exists and we're waiting on the selfie. */
  matchRequestId?: string;
  /** Rejected selfie attempts — the flow gives up after a few. */
  faceAttempts?: number;
}

const PENDING_GROUP_TTL = 1800; // 30 minutes — matches the group booking stages

function pendingGroupKey(userId: string): string {
  return `whatsapp:user:${userId}:pending_group`;
}

export async function storePendingGroupRide(
  redis: RedisClient,
  userId: string,
  data: PendingGroupRide,
): Promise<void> {
  await redis.set(pendingGroupKey(userId), JSON.stringify(data), PENDING_GROUP_TTL);
}

export async function getPendingGroupRide(
  redis: RedisClient,
  userId: string,
): Promise<PendingGroupRide | null> {
  const raw = await redis.get(pendingGroupKey(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingGroupRide;
  } catch {
    return null;
  }
}

export async function clearPendingGroupRide(
  redis: RedisClient,
  userId: string,
): Promise<void> {
  await redis.del(pendingGroupKey(userId));
}

// Marks a rider as having an active WhatsApp group-ride request, so group
// events for them are delivered over WhatsApp instead of a websocket.

function groupRequestRiderKey(userId: string): string {
  return `whatsapp:group_request_rider:${userId}`;
}

export async function setGroupRequestRider(
  redis: RedisClient,
  userId: string,
  matchRequestId: string,
): Promise<void> {
  await redis.set(groupRequestRiderKey(userId), matchRequestId, 86400);
}

export async function getGroupRequestRider(
  redis: RedisClient,
  userId: string,
): Promise<string | null> {
  return redis.get(groupRequestRiderKey(userId));
}

export async function clearGroupRequestRider(
  redis: RedisClient,
  userId: string,
): Promise<void> {
  await redis.del(groupRequestRiderKey(userId));
}

// ── Pending geocode disambiguation (numbered "which one did you mean?") ───

export interface PendingGeoChoices {
  /** Which field the answer fills. */
  context: 'group_pickup' | 'group_destination' | 'pickup' | 'destination' | 'edit_pickup' | 'edit_destination';
  options: Array<{ lat: number; lng: number; address: string }>;
}

function geoChoicesKey(userId: string): string {
  return `whatsapp:user:${userId}:geo_choices`;
}

export async function storePendingGeoChoices(
  redis: RedisClient,
  userId: string,
  data: PendingGeoChoices,
): Promise<void> {
  await redis.set(geoChoicesKey(userId), JSON.stringify(data), 600);
}

export async function getPendingGeoChoices(
  redis: RedisClient,
  userId: string,
): Promise<PendingGeoChoices | null> {
  const raw = await redis.get(geoChoicesKey(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingGeoChoices;
  } catch {
    return null;
  }
}

export async function clearPendingGeoChoices(
  redis: RedisClient,
  userId: string,
): Promise<void> {
  await redis.del(geoChoicesKey(userId));
}

// ── A place in another city, waiting for the rider to say "yes, really" ────

/**
 * The bot found the place the rider typed — hundreds of kilometres from the
 * other end of the trip. It is held here, not applied, until they confirm.
 */
export interface PendingFarPlace {
  field: 'pickup' | 'destination';
  lat: number;
  lng: number;
  address: string;
  distanceKm: number;
}

function farPlaceKey(userId: string): string {
  return `whatsapp:user:${userId}:far_place`;
}

export async function storePendingFarPlace(redis: RedisClient, userId: string, data: PendingFarPlace): Promise<void> {
  await redis.set(farPlaceKey(userId), JSON.stringify(data), 600);
}

export async function getPendingFarPlace(redis: RedisClient, userId: string): Promise<PendingFarPlace | null> {
  const raw = await redis.get(farPlaceKey(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingFarPlace;
  } catch {
    return null;
  }
}

export async function clearPendingFarPlace(redis: RedisClient, userId: string): Promise<void> {
  await redis.del(farPlaceKey(userId));
}

// ── Is the rider looking at the bidding page right now? ────────────────────

const RIDE_PAGE_SEEN_TTL = 25; // the page asks for news every 3 s; 25 s of silence = gone

function ridePageSeenKey(userId: string): string {
  return `whatsapp:user:${userId}:ride_page_seen`;
}

/** Every request from the bidding page doubles as "still here". */
export async function markRidePageSeen(redis: RedisClient, userId: string): Promise<void> {
  await redis.set(ridePageSeenKey(userId), String(Date.now()), RIDE_PAGE_SEEN_TTL);
}

/**
 * While this is true, offers reach the rider as toasts on the page and the chat
 * stays quiet. The moment they leave, chat notifications resume on their own.
 */
export async function isRidePageOpen(redis: RedisClient, userId: string): Promise<boolean> {
  return (await redis.get(ridePageSeenKey(userId)).catch(() => null)) !== null;
}

// ── Not getting anywhere ───────────────────────────────────────────────────

function bookingMissKey(userId: string): string {
  return `whatsapp:user:${userId}:booking_misses`;
}

/**
 * Count one reply the booking flow could not use. Read-then-write is fine: one
 * rider sends one message at a time, and an off-by-one only changes which
 * reply first shows the way out.
 */
export async function noteBookingMiss(redis: RedisClient, userId: string): Promise<number> {
  const current = Number(await redis.get(bookingMissKey(userId))) || 0;
  const next = current + 1;
  await redis.set(bookingMissKey(userId), String(next), 600);
  return next;
}

export async function clearBookingMisses(redis: RedisClient, userId: string): Promise<void> {
  await redis.del(bookingMissKey(userId));
}

// ── Group seat bidding (per-rider negotiation on shared rides) ────────────

export interface GroupSeatInfo {
  /** The group's anchor ride id — the id drivers and assignment run on. */
  anchorRideId: string;
  groupId: string;
  memberCount: number;
}

function groupSeatKey(memberRideId: string): string {
  return `whatsapp:group_seat:${memberRideId}`;
}

export async function storeGroupSeat(
  redis: RedisClient,
  memberRideId: string,
  info: GroupSeatInfo,
): Promise<void> {
  await redis.set(groupSeatKey(memberRideId), JSON.stringify(info), 1800);
}

export async function getGroupSeat(
  redis: RedisClient,
  memberRideId: string,
): Promise<GroupSeatInfo | null> {
  const raw = await redis.get(groupSeatKey(memberRideId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GroupSeatInfo;
  } catch {
    return null;
  }
}

export interface AcceptedSeat {
  memberRideId: string;
  riderId: string;
  driverId: string;
  driverUserId: string;
  driverName: string;
  amountNgn: number;
  etaSeconds: number;
}

function acceptedSeatsKey(anchorRideId: string): string {
  return `whatsapp:group:${anchorRideId}:accepted_seats`;
}

/** Record one member's seat acceptance; returns all seats accepted so far. */
export async function recordAcceptedSeat(
  redis: RedisClient,
  anchorRideId: string,
  seat: AcceptedSeat,
): Promise<AcceptedSeat[]> {
  const raw = await redis.get(acceptedSeatsKey(anchorRideId));
  let seats: AcceptedSeat[] = [];
  if (raw) {
    try {
      seats = JSON.parse(raw) as AcceptedSeat[];
    } catch {
      seats = [];
    }
  }
  const existing = seats.findIndex((s) => s.memberRideId === seat.memberRideId);
  if (existing >= 0) {
    seats[existing] = seat;
  } else {
    seats.push(seat);
  }
  await redis.set(acceptedSeatsKey(anchorRideId), JSON.stringify(seats), 1800);
  return seats;
}

export async function clearAcceptedSeats(
  redis: RedisClient,
  anchorRideId: string,
): Promise<void> {
  await redis.del(acceptedSeatsKey(anchorRideId));
}

export interface GroupSeatMember {
  memberRideId: string;
  riderId: string;
  phone: string | null;
  offerNgn: number;
}

function groupMembersKey(anchorRideId: string): string {
  return `whatsapp:group:${anchorRideId}:members`;
}

export async function storeGroupSeatMembers(
  redis: RedisClient,
  anchorRideId: string,
  members: GroupSeatMember[],
): Promise<void> {
  await redis.set(groupMembersKey(anchorRideId), JSON.stringify(members), 1800);
}

export async function getGroupSeatMembers(
  redis: RedisClient,
  anchorRideId: string,
): Promise<GroupSeatMember[]> {
  const raw = await redis.get(groupMembersKey(anchorRideId));
  if (!raw) return [];
  try {
    return JSON.parse(raw) as GroupSeatMember[];
  } catch {
    return [];
  }
}

// ── Flow fare estimate (RIDE_SETUP -> FARE_CONFIRM handoff) ───────────────
// The estimate step geocodes and plans the route; Find Drivers reuses that
// work instead of paying for a second geocode + route call.

export interface FlowEstimate {
  pickupAddress: string;
  pickupLat: number;
  pickupLng: number;
  destinationAddress: string;
  destinationLat: number;
  destinationLng: number;
  distanceKm: number;
  durationSeconds: number;
  suggestedFareNgn: number;
  minOfferNgn: number;
  ratePerKmNgn: number;
  geometry: unknown;
}

const flowEstimateKey = (userId: string) => `whatsapp:flow:estimate:${userId}`;
const FLOW_ESTIMATE_TTL = 15 * 60;

export async function storeFlowEstimate(
  redis: RedisClient,
  userId: string,
  estimate: FlowEstimate,
): Promise<void> {
  await redis.set(flowEstimateKey(userId), JSON.stringify(estimate), FLOW_ESTIMATE_TTL);
}

export async function getFlowEstimate(
  redis: RedisClient,
  userId: string,
): Promise<FlowEstimate | null> {
  const raw = await redis.get(flowEstimateKey(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FlowEstimate;
  } catch {
    return null;
  }
}

export async function clearFlowEstimate(redis: RedisClient, userId: string): Promise<void> {
  await redis.del(flowEstimateKey(userId));
}

// ── Flow pending accept (BID_LIST -> TOP_UP -> re-check handoff) ──────────

export interface FlowPendingAccept {
  rideId: string;
  driverId: string;
}

const flowPendingAcceptKey = (userId: string) => `whatsapp:flow:pendingaccept:${userId}`;
const FLOW_PENDING_ACCEPT_TTL = 30 * 60;

export async function storeFlowPendingAccept(
  redis: RedisClient,
  userId: string,
  pending: FlowPendingAccept,
): Promise<void> {
  await redis.set(flowPendingAcceptKey(userId), JSON.stringify(pending), FLOW_PENDING_ACCEPT_TTL);
}

export async function getFlowPendingAccept(
  redis: RedisClient,
  userId: string,
): Promise<FlowPendingAccept | null> {
  const raw = await redis.get(flowPendingAcceptKey(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FlowPendingAccept;
  } catch {
    return null;
  }
}

export async function clearFlowPendingAccept(redis: RedisClient, userId: string): Promise<void> {
  await redis.del(flowPendingAcceptKey(userId));
}
