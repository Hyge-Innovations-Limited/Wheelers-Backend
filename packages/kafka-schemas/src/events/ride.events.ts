import { z } from 'zod';

const BaseRideEvent = z.object({
  rideId:    z.string().uuid(),
  timestamp: z.string().datetime(),
});

const LatLng = z.object({
  lat:     z.number(),
  lng:     z.number(),
  address: z.string(),
});

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

const RideStopSnapshot = LatLng.extend({
  stopId: z.string().uuid(),
  stopOrder: z.number().int().nonnegative(),
  type: z.enum(['intermediate', 'final']),
  status: z.enum(['pending', 'completed', 'skipped']),
  completedAt: z.string().datetime().optional(),
});

const PaymentMethod = z.enum(['CASH', 'WALLET']);

// Fired by api-gateway when rider submits a ride request via WebSocket.
// Consumed by: ride-service (broadcast to nearby drivers for bidding).
export const RideRequestedEvent = BaseRideEvent.extend({
  eventType:        z.literal('RIDE_REQUESTED'),
  riderId:          z.string().uuid(),
  pickup:           LatLng,
  destination:      LatLng,
  stops:            z.array(LatLng).max(5).default([]),
  plannedDistanceKm: z.number().optional(),
  plannedDurationSeconds: z.number().int().optional(),
  fareEstimateNgn:  z.number(),
  paymentMethod:    PaymentMethod,
  riderOfferNgn:    z.number(),
  suggestedFareNgn: z.number(),
  minOfferNgn:      z.number(),
  ratePerKmNgn:     z.number(),
  fareBeforeCashbackNgn: z.number().optional(),
  referralCashbackAppliedNgn: z.number().optional(),
  route:            RouteGeometry.optional(),
});

export const RideRouteUpdateRequestedEvent = BaseRideEvent.extend({
  eventType:        z.literal('RIDE_ROUTE_UPDATE_REQUESTED'),
  riderId:          z.string().uuid(),
  driverId:         z.string().uuid().optional(),
  destination:      LatLng,
  stops:            z.array(LatLng).max(5).default([]),
  plannedDistanceKm: z.number().optional(),
  plannedDurationSeconds: z.number().int().optional(),
  fareEstimateNgn:  z.number().optional(),
  route:            RouteGeometry.optional(),
  updatedBy:        z.enum(['rider', 'driver', 'system']),
});

export const RideStopConfirmedEvent = BaseRideEvent.extend({
  eventType:   z.literal('RIDE_STOP_CONFIRMED'),
  riderId:     z.string().uuid(),
  driverId:    z.string().uuid(),
  confirmedBy: z.enum(['driver', 'rider']).default('driver'),
});

// Fired by ride-service after broadcasting ride to nearby drivers.
// Consumed by: api-gateway (push to driver via WebSocket as ride:offer).
export const RideOfferSentEvent = BaseRideEvent.extend({
  eventType:             z.literal('RIDE_OFFER_SENT'),
  riderId:               z.string().uuid(),
  driverId:              z.string().uuid(),
  driverUserId:          z.string().uuid(),
  pickup:                LatLng,
  destination:           LatLng,
  stops:                 z.array(LatLng).max(5).default([]),
  fareEstimateNgn:       z.number(),
  paymentMethod:         PaymentMethod,
  riderOfferNgn:         z.number(),
  suggestedFareNgn:      z.number(),
  // The lowest bid the server will accept on this trip. Without it the driver
  // app could only guess: a bid under the floor was typed, sent, and bounced.
  minOfferNgn:           z.number().optional(),
  ratePerKmNgn:          z.number(),
  plannedDistanceKm:     z.number().optional(),
  plannedDurationSeconds: z.number().int().optional(),
  // Driver→pickup at the moment of matching — a seed for the driver app's
  // live "to pickup" card (the app recomputes from its own GPS after that).
  pickupDistanceKm:      z.number().optional(),
  pickupEtaSeconds:      z.number().int().optional(),
  // This driver is still carrying a passenger and was matched because the
  // pickup is near their drop-off. Their app labels the card so nobody
  // abandons the rider they have; the distances above are from that drop-off.
  afterCurrentTrip:      z.boolean().optional(),
  expiresAt:             z.string().datetime(),
  // One auction clock for every surface — apps render it, chat enforces it.
  bidsCloseAt:           z.string().datetime().optional(),
  // The person asking: drivers commit a car and half an hour to this request,
  // so it carries a name and a track record, not just coordinates.
  riderName:             z.string().optional(),
  riderRating:           z.number().optional(),
  riderTripCount:        z.number().int().optional(),
  route:                 RouteGeometry.optional(),
  // Group rides ride the same offer pipeline as solo ones. Without these the
  // driver cannot tell a 17km solo trip from a 17km three-pickup shared trip —
  // very different jobs at the same distance and fare.
  isGroupRide:           z.boolean().optional(),
  riderCount:            z.number().int().positive().optional(),
  // Parallel to `stops` — tells the driver which waypoints are pickups and
  // which are drop-offs, so a shared route reads as a plan rather than a
  // list of anonymous coordinates.
  stopKinds:             z.array(z.enum(['pickup', 'dropoff'])).max(5).optional(),
  // Group rides: each member's own leg and seat offer, so the driver can
  // accept or bid per rider instead of on a lump sum.
  groupMembers: z.array(z.object({
    rideId: z.string().uuid(),
    riderId: z.string().uuid(),
    pickup: LatLng,
    dropoff: LatLng,
    offerNgn: z.number().nonnegative(),
  })).max(5).optional(),
});

// Fired by api-gateway when driver sends a counter-offer via WebSocket.
// Consumed by: ride-service (store bid), api-gateway (forward to rider).
export const RideCounterOfferEvent = BaseRideEvent.extend({
  eventType:        z.literal('RIDE_COUNTER_OFFER'),
  riderId:          z.string().uuid(),
  driverId:         z.string().uuid(),
  driverUserId:     z.string().uuid(),
  // Durable identity of this exact bid (DriverBid.id) — acceptance references
  // it so a stale price can never be the one that gets paid.
  bidId:            z.string().uuid().optional(),
  counterOfferNgn:  z.number(),
  driverName:       z.string(),
  driverRating:     z.number(),
  vehiclePlate:     z.string(),
  vehicleModel:     z.string(),
  etaSeconds:       z.number().int(),
  // Driver→pickup distance behind etaSeconds, so riders see "2.3 km · 6 min
  // away" instead of a bare minutes figure.
  distanceKm:       z.number().optional(),
});

// Fired by api-gateway when rider picks a driver's offer via WebSocket.
// Consumed by: ride-service (publish RIDE_DRIVER_ASSIGNED, clean up bids).
export const RideOfferAcceptedEvent = BaseRideEvent.extend({
  eventType:      z.literal('RIDE_OFFER_ACCEPTED'),
  riderId:        z.string().uuid(),
  driverId:       z.string().uuid(),
  driverUserId:   z.string().uuid(),
  bidId:          z.string().uuid().optional(),
  agreedFareNgn:  z.number(),
  paymentMethod:  PaymentMethod,
});

// Fired by ride-service after rider accepts a driver's bid.
// Consumed by: wallet-service (lock ride fare in rider wallet if WALLET),
// notification-worker (push to rider), api-gateway (push to rider WebSocket).
export const RideDriverAssignedEvent = BaseRideEvent.extend({
  eventType:      z.literal('RIDE_DRIVER_ASSIGNED'),
  riderId:        z.string().uuid(),
  driverId:       z.string().uuid(),
  driverUserId:   z.string().uuid(),
  driverName:     z.string(),
  driverRating:   z.number(),
  vehiclePlate:   z.string(),
  vehicleModel:   z.string(),
  etaSeconds:     z.number().int(),
  agreedFareNgn:  z.number(),
  lockedFareNgn:  z.number(),
  paymentMethod:  PaymentMethod,
});

export const RideRouteUpdatedEvent = BaseRideEvent.extend({
  eventType:        z.literal('RIDE_ROUTE_UPDATED'),
  riderId:          z.string().uuid(),
  driverId:         z.string().uuid().optional(),
  destination:      LatLng,
  stops:            z.array(RideStopSnapshot),
  plannedDistanceKm: z.number().optional(),
  plannedDurationSeconds: z.number().int().optional(),
  fareEstimateNgn:  z.number().optional(),
  route:            RouteGeometry.optional(),
  updatedBy:        z.enum(['rider', 'driver', 'system']),
});

// Fired when the driver reports arrival at the pickup point.
// Consumed by: ride-service (persist ARRIVED), api-gateway (tell the rider —
// this is the "your driver is outside" moment, previously never sent).
export const RideArrivedEvent = BaseRideEvent.extend({
  eventType: z.literal('RIDE_ARRIVED'),
  riderId:   z.string().uuid(),
  driverId:  z.string().uuid(),
});

export const RideStartedEvent = BaseRideEvent.extend({
  eventType:     z.literal('RIDE_STARTED'),
  riderId:       z.string().uuid(),
  driverId:      z.string().uuid(),
  lockedFareNgn: z.number(),
  paymentMethod: PaymentMethod,
  startedAt:     z.string().datetime(),
});

export const RideCompletionRequestedEvent = BaseRideEvent.extend({
  eventType:    z.literal('RIDE_COMPLETION_REQUESTED'),
  riderId:      z.string().uuid(),
  driverId:     z.string().uuid(),
  fareNgn:      z.number().optional(),
  endedBy:      z.enum(['both_confirmed', 'auto_gps', 'admin']),
  completedAt:  z.string().datetime().optional(),
});

// Fired by ride-service when both parties end the trip (or auto-end triggers).
// Consumed by: wallet-service (unlock rider funds, debit final fare, credit driver),
// notification-worker (completion push to both).
export const RideCompletedEvent = BaseRideEvent.extend({
  eventType:       z.literal('RIDE_COMPLETED'),
  riderId:         z.string().uuid(),
  driverId:        z.string().uuid(),
  driverUserId:    z.string().uuid(),
  fareNgn:         z.number(),
  distanceKm:      z.number(),
  durationSeconds: z.number().int(),
  endedBy:         z.enum(['both_confirmed', 'auto_gps', 'admin']),
  completedAt:     z.string().datetime(),
  paymentMethod:   PaymentMethod,
});

// Fired by api-gateway when rider cancels.
// Consumed by: wallet-service (unlock fare hold), ride-service (free driver),
// notification-worker (push to driver).
export const RideCancelledEvent = BaseRideEvent.extend({
  eventType:    z.literal('RIDE_CANCELLED'),
  riderId:      z.string().uuid(),
  driverId:     z.string().uuid().optional(),
  reason:       z.string().optional(),
  // Who pressed cancel. riderId/driverId say who is ON the ride, never who
  // ended it, so without this the gateway cannot tell which side still needs
  // telling — and it used to notify whoever cancelled instead of the other party.
  cancelledBy:  z.enum(['rider', 'driver', 'system']).optional(),
  /** Set when a driver cancels after accepting, so the ride can be re-matched. */
  driverUserId: z.string().uuid().optional(),
});

// Fired by ride-service when it offers a ride to a specific driver.
// Consumed by: api-gateway (relay to driver via WebSocket as ride:offer).
export const RideDriverRejectedEvent = BaseRideEvent.extend({
  eventType:  z.literal('RIDE_DRIVER_REJECTED'),
  riderId:    z.string().uuid(),
  driverId:   z.string().uuid(),
  reason:     z.enum(['timeout', 'manual_reject']),
});

// Fired by api-gateway when rider sends a counter-offer.
// driverId is optional — if omitted, ride-service broadcasts to ALL candidate drivers.
// Consumed by: ride-service (update pending match, re-broadcast to driver(s)).
export const RideRiderCounterOfferEvent = BaseRideEvent.extend({
  eventType:        z.literal('RIDE_RIDER_COUNTER_OFFER'),
  riderId:          z.string().uuid(),
  driverId:         z.string().uuid().optional(),
  counterOfferNgn:  z.number(),
});

// Fired by ride-service after 3 minutes with no counter-offers.
// Consumed by: api-gateway (relay to rider as ride:bid_timeout).
export const RideBidTimeoutEvent = BaseRideEvent.extend({
  eventType: z.literal('RIDE_BID_TIMEOUT'),
  riderId:   z.string().uuid(),
});

// Fired by api-gateway when a rider or driver sends a chat message during a ride.
// Consumed by: api-gateway (relay to both rider and driver via WebSocket as chat:message).
export const ChatMessageSentEvent = BaseRideEvent.extend({
  eventType:  z.literal('CHAT_MESSAGE_SENT'),
  messageId:  z.string().uuid(),
  senderId:   z.string().uuid(),
  senderRole: z.enum(['RIDER', 'DRIVER']),
  content:    z.string().min(1).max(1000),
});

export const RideEvent = z.discriminatedUnion('eventType', [
  RideRequestedEvent,
  RideRouteUpdateRequestedEvent,
  RideStopConfirmedEvent,
  RideOfferSentEvent,
  RideCounterOfferEvent,
  RideRiderCounterOfferEvent,
  RideOfferAcceptedEvent,
  RideDriverAssignedEvent,
  RideRouteUpdatedEvent,
  RideArrivedEvent,
  RideStartedEvent,
  RideCompletionRequestedEvent,
  RideCompletedEvent,
  RideCancelledEvent,
  RideDriverRejectedEvent,
  RideBidTimeoutEvent,
  ChatMessageSentEvent,
]);

export type RideRequestedEvent       = z.infer<typeof RideRequestedEvent>;
export type RideRouteUpdateRequestedEvent = z.infer<typeof RideRouteUpdateRequestedEvent>;
export type RideStopConfirmedEvent   = z.infer<typeof RideStopConfirmedEvent>;
export type RideOfferSentEvent       = z.infer<typeof RideOfferSentEvent>;
export type RideCounterOfferEvent    = z.infer<typeof RideCounterOfferEvent>;
export type RideOfferAcceptedEvent   = z.infer<typeof RideOfferAcceptedEvent>;
export type RideDriverAssignedEvent  = z.infer<typeof RideDriverAssignedEvent>;
export type RideRouteUpdatedEvent    = z.infer<typeof RideRouteUpdatedEvent>;
export type RideArrivedEvent       = z.infer<typeof RideArrivedEvent>;
export type RideStartedEvent         = z.infer<typeof RideStartedEvent>;
export type RideCompletionRequestedEvent = z.infer<typeof RideCompletionRequestedEvent>;
export type RideCompletedEvent       = z.infer<typeof RideCompletedEvent>;
export type RideCancelledEvent       = z.infer<typeof RideCancelledEvent>;
export type RideDriverRejectedEvent  = z.infer<typeof RideDriverRejectedEvent>;
export type RideRiderCounterOfferEvent = z.infer<typeof RideRiderCounterOfferEvent>;
export type RideBidTimeoutEvent      = z.infer<typeof RideBidTimeoutEvent>;
export type ChatMessageSentEvent     = z.infer<typeof ChatMessageSentEvent>;
export type RideEvent                = z.infer<typeof RideEvent>;
