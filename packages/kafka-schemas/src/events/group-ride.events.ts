import { z } from 'zod';

const RouteCoordinate = z.object({
  lat: z.number(),
  lng: z.number(),
});

const RouteBounds = z.object({
  northEast: RouteCoordinate,
  southWest: RouteCoordinate,
});

const RouteGeometry = z.object({
  coordinates: z.array(RouteCoordinate).min(2),
  bounds: RouteBounds,
});

const LatLng = z.object({
  lat: z.number(),
  lng: z.number(),
  address: z.string(),
});

export const GroupRideGenderPreference = z.enum([
  'any',
  'women_only',
  'men_only',
]);

const BaseGroupRideEvent = z.object({
  groupId: z.string().uuid(),
  timestamp: z.string().datetime(),
});

export const GroupRideReadyForMatchEvent = z.object({
  eventType: z.literal('GROUP_RIDE_READY_FOR_MATCH'),
  rideId: z.string().uuid(),
  riderId: z.string().uuid(),
  faceVerificationId: z.string().uuid(),
  pickup: LatLng,
  destination: LatLng,
  stops: z.array(LatLng).max(5).default([]),
  plannedDistanceKm: z.number().optional(),
  plannedDurationSeconds: z.number().int().optional(),
  fareEstimateNgn: z.number().optional(),
  genderPreference: GroupRideGenderPreference.default('any'),
  paymentMethod: z.literal('wallet_balance'),
  timestamp: z.string().datetime(),
});

export const GroupRideMatchCancelledEvent = z.object({
  eventType: z.literal('GROUP_RIDE_MATCH_CANCELLED'),
  rideId: z.string().uuid(),
  riderId: z.string().uuid(),
  reason: z.string().optional(),
  timestamp: z.string().datetime(),
});

const GroupRideMember = z.object({
  rideId: z.string().uuid(),
  riderId: z.string().uuid(),
  pickup: LatLng,
  destination: LatLng,
  genderPreference: GroupRideGenderPreference.default('any'),
  headingDeg: z.number(),
  compatibilityScore: z.number().min(0).max(1),
});

const GroupRideStop = LatLng.extend({
  rideId: z.string().uuid(),
  riderId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  kind: z.enum(['pickup', 'dropoff']),
});

const GroupRideLeg = z.object({
  fromSequence: z.number().int().nonnegative(),
  toSequence: z.number().int().nonnegative(),
  distanceKm: z.number().nonnegative(),
  durationSeconds: z.number().int().nonnegative(),
  route: RouteGeometry,
});

export const GroupRideCandidatesIdentifiedEvent = BaseGroupRideEvent.extend({
  eventType: z.literal('GROUP_RIDE_CANDIDATES_IDENTIFIED'),
  anchorRideId: z.string().uuid(),
  rideIds: z.array(z.string().uuid()).min(2),
  members: z.array(GroupRideMember).min(2),
  searchRadiusKm: z.number().positive(),
  maxBearingDeltaDeg: z.number().positive(),
});

export const GroupRidePlannedEvent = BaseGroupRideEvent.extend({
  eventType: z.literal('GROUP_RIDE_PLANNED'),
  anchorRideId: z.string().uuid(),
  rideIds: z.array(z.string().uuid()).min(2),
  riderIds: z.array(z.string().uuid()).min(2),
  stops: z.array(GroupRideStop).min(4),
  heuristicDistanceKm: z.number().nonnegative(),
  sequenceAlgorithm: z.enum(['dp_precedence', 'greedy_nearest_neighbour']),
});

export const GroupRideRouteBuiltEvent = BaseGroupRideEvent.extend({
  eventType: z.literal('GROUP_RIDE_ROUTE_BUILT'),
  anchorRideId: z.string().uuid(),
  rideIds: z.array(z.string().uuid()).min(2),
  riderIds: z.array(z.string().uuid()).min(2),
  stops: z.array(GroupRideStop).min(4),
  legs: z.array(GroupRideLeg).min(1),
  totalDistanceKm: z.number().nonnegative(),
  totalDurationSeconds: z.number().int().nonnegative(),
  route: RouteGeometry,
  routeAlgorithm: z.enum(['google_routes_segments']),
});

// One seat in a shared ride: the member's own leg and their own offer.
// Drivers negotiate per seat, not on a lump sum.
export const GroupRideMemberSeat = z.object({
  rideId: z.string().uuid(),
  riderId: z.string().uuid(),
  pickup: LatLng,
  dropoff: LatLng,
  offerNgn: z.number().nonnegative(),
});

// Emitted by group-ride after the route is built — triggers driver dispatch in ride-service.
export const GroupRideDriverDispatchRequestedEvent = BaseGroupRideEvent.extend({
  eventType: z.literal('GROUP_RIDE_DRIVER_DISPATCH_REQUESTED'),
  anchorRideId: z.string().uuid(),
  rideIds: z.array(z.string().uuid()).min(2),
  riderIds: z.array(z.string().uuid()).min(2),
  firstPickup: LatLng,
  // The full pickup/dropoff sequence the driver will actually drive. Without
  // it the offer they receive shows the first pickup as both origin and
  // destination and claims zero stops.
  stops: z.array(GroupRideStop).min(4).optional(),
  totalDistanceKm: z.number().nonnegative(),
  totalDurationSeconds: z.number().int().nonnegative(),
  fareEstimateNgn: z.number().nonnegative(),
  // Per-seat legs and offers — the driver bids with each rider individually.
  members: z.array(GroupRideMemberSeat).max(5).optional(),
  route: RouteGeometry,
});

// Emitted by ride-service when a driver accepts a group ride.
export const GroupRideDriverAssignedEvent = BaseGroupRideEvent.extend({
  eventType: z.literal('GROUP_RIDE_DRIVER_ASSIGNED'),
  rideIds: z.array(z.string().uuid()).min(2),
  riderIds: z.array(z.string().uuid()).min(2),
  driverId: z.string().uuid(),
  driverUserId: z.string().uuid(),
  driverName: z.string(),
  driverRating: z.number(),
  vehiclePlate: z.string(),
  vehicleModel: z.string(),
  etaSeconds: z.number().int().nonnegative(),
});

// Group ride on live searches (Timi, 16-17 Nov 2026): group-ride found riders, searching right now, who could
// ride together. `groupId` is the offer's id. Consumed by api-gateway: it holds the searches and asks the riders.
const GroupRideLiveStop = LatLng.extend({
  rideId: z.string().uuid(),
  kind: z.enum(['pickup', 'dropoff']),
});
const GroupRideLiveMember = z.object({
  rideId: z.string().uuid(),
  riderId: z.string().uuid(),
  offerNgn: z.number().positive(),
  seatPriceNgn: z.number().positive(),
  soloSeconds: z.number().int().nonnegative(),
  extraSeconds: z.number().int().nonnegative(),
});
export const GroupRideLiveOfferedEvent = BaseGroupRideEvent.extend({
  eventType: z.literal('GROUP_RIDE_LIVE_OFFERED'),
  rideIds: z.array(z.string().uuid()).min(2).max(3),
  members: z.array(GroupRideLiveMember).min(2).max(3),
  stops: z.array(GroupRideLiveStop).min(4).max(6),
  totalSeconds: z.number().int().nonnegative(),
  savedSeconds: z.number().int().nonnegative(),
});

// A group trip was formed (groupId: the TRIP ride's id): ride-service stops the seats' own searches.
export const GroupTripFormedEvent = BaseGroupRideEvent.extend({
  eventType: z.literal('GROUP_TRIP_FORMED'),
  seatRideIds: z.array(z.string().uuid()).min(2).max(3),
});
// A group trip is over (every seat done or gone, or it never got a driver): ride-service frees its driver.
export const GroupTripEndedEvent = BaseGroupRideEvent.extend({
  eventType: z.literal('GROUP_TRIP_ENDED'),
});

export const GroupRideEvent = z.discriminatedUnion('eventType', [
  GroupRideReadyForMatchEvent,
  GroupRideMatchCancelledEvent,
  GroupRideCandidatesIdentifiedEvent,
  GroupRidePlannedEvent,
  GroupRideRouteBuiltEvent,
  GroupRideDriverDispatchRequestedEvent,
  GroupRideDriverAssignedEvent,
  GroupRideLiveOfferedEvent,
  GroupTripFormedEvent,
  GroupTripEndedEvent,
]);

export type GroupRideReadyForMatchEvent = z.infer<typeof GroupRideReadyForMatchEvent>;
export type GroupRideMatchCancelledEvent = z.infer<typeof GroupRideMatchCancelledEvent>;
export type GroupRideCandidatesIdentifiedEvent = z.infer<typeof GroupRideCandidatesIdentifiedEvent>;
export type GroupRidePlannedEvent = z.infer<typeof GroupRidePlannedEvent>;
export type GroupRideRouteBuiltEvent = z.infer<typeof GroupRideRouteBuiltEvent>;
export type GroupRideDriverDispatchRequestedEvent = z.infer<typeof GroupRideDriverDispatchRequestedEvent>;
export type GroupRideDriverAssignedEvent = z.infer<typeof GroupRideDriverAssignedEvent>;
export type GroupRideLiveOfferedEvent = z.infer<typeof GroupRideLiveOfferedEvent>;
export type GroupTripFormedEvent = z.infer<typeof GroupTripFormedEvent>;
export type GroupTripEndedEvent = z.infer<typeof GroupTripEndedEvent>;
export type GroupRideEvent = z.infer<typeof GroupRideEvent>;
