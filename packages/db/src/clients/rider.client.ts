import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import type { RidePaymentMethod, RideStatus, RideStopStatus, RideStopType } from '@prisma/client';

type RouteStopInput = {
  lat: number;
  lng: number;
  address: string;
};

type CompletedRouteStopInput = RouteStopInput & {
  type: RideStopType;
  status: RideStopStatus;
  completedAt: Date | null;
};

type RouteDestinationInput = RouteStopInput;

function buildRouteStops(params: {
  rideId: string;
  completedStops?: CompletedRouteStopInput[];
  stops?: RouteStopInput[];
  destination: RouteDestinationInput;
}) {
  const completedStops = params.completedStops ?? [];
  const requestedStops = params.stops ?? [];
  const routeStops = [
    ...completedStops.map((stop, index) => ({
      rideId: params.rideId,
      stopOrder: index,
      type: stop.type,
      status: stop.status,
      lat: stop.lat,
      lng: stop.lng,
      address: stop.address,
      completedAt: stop.completedAt,
    })),
    ...requestedStops.map((stop, index) => ({
      rideId: params.rideId,
      stopOrder: completedStops.length + index,
      type: 'INTERMEDIATE' as const,
      status: 'PENDING' as const,
      lat: stop.lat,
      lng: stop.lng,
      address: stop.address,
      completedAt: null,
    })),
    {
      rideId: params.rideId,
      stopOrder: completedStops.length + requestedStops.length,
      type: 'FINAL' as const,
      status: 'PENDING' as const,
      lat: params.destination.lat,
      lng: params.destination.lng,
      address: params.destination.address,
      completedAt: null,
    },
  ];

  return routeStops;
}

/** The one cancel reason a later assignment may undo: the search timed out, nobody chose to cancel. */
export const SEARCH_TIMED_OUT_REASON = 'No driver accepted in time';

export const rideClient = {

  // ── Reads ──────────────────────────────────────────────────────────────────

  findById: (rideId: string) =>
    prisma.ride.findUniqueOrThrow({
      where: { id: rideId },
      include: {
        routeStops: {
          orderBy: { stopOrder: 'asc' },
        },
      },
    }),

  findWithDriver: (rideId: string) =>
    prisma.ride.findUniqueOrThrow({
      where:   { id: rideId },
      include: {
        driver: { include: { user: true } },
        routeStops: {
          orderBy: { stopOrder: 'asc' },
        },
      },
    }),

  // A ride still in REQUESTED/MATCHING long after the bid window is dead —
  // nobody accepted and the timeout should have cancelled it. Don't let a
  // stale one block a rider from booking again while the sweeper catches up.
  // A search runs 30 minutes (RIDE.BID_TIMEOUT_SECONDS): an unmatched ride is live that long, plus a margin.
  findActiveByRider: (riderId: string, unmatchedMaxAgeMs = 35 * 60 * 1000) =>
    prisma.ride.findFirst({
      where: {
        riderId,
        OR: [
          {
            status: { in: ['REQUESTED', 'MATCHING'] },
            createdAt: { gte: new Date(Date.now() - unmatchedMaxAgeMs) },
          },
          { status: { in: ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'] } },
        ],
      },
      orderBy: { createdAt: 'desc' },
    }),

  /** Unmatched rides older than `cutoff`, oldest first — the sweeper's input. */
  // A ride re-dispatched after a driver dropped keeps its createdAt, so the
  // sweep killed it within a minute. Age by last activity instead, and leave
  // a ride alone while a driver's offer is still fresh on the table — the
  // rider may be topping up to pay for it.
  /**
   * Every solo search still inside its window — what a freshly (re)started ride
   * service must pick back up, or riders who change their price mid-search are
   * talking to nobody. Group seats are left out: their auction lives under the
   * group's own id and is rebuilt by the group dispatcher.
   */
  findOpenSearches: async (maxAgeMs: number, riderId?: string, excludeRideId?: string) => {
    const since = new Date(Date.now() - maxAgeMs);
    const [rides, groups] = await Promise.all([
      prisma.ride.findMany({
        where: {
          status: { in: ['REQUESTED', 'MATCHING'] },
          createdAt: { gte: since },
          ...(riderId ? { riderId } : {}),
          ...(excludeRideId ? { NOT: { id: excludeRideId } } : {}),
        },
        include: { routeStops: { orderBy: { stopOrder: 'asc' } } },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.groupRideMatchRequest.findMany({
        where: { updatedAt: { gte: new Date(Date.now() - 2 * 86_400_000) }, NOT: { matchedRideIds: { equals: Prisma.DbNull } } },
        select: { matchedRideIds: true },
      }),
    ]);
    const seats = new Set<string>();
    for (const group of groups) for (const id of (Array.isArray(group.matchedRideIds) ? group.matchedRideIds : []) as unknown[]) if (typeof id === 'string') seats.add(id);
    return rides.filter((ride) => !seats.has(ride.id));
  },

  findStaleUnmatched: (cutoff: Date, limit = 200, pendingBidGraceMs = 10 * 60_000) =>
    prisma.ride.findMany({
      where: {
        status: { in: ['REQUESTED', 'MATCHING'] },
        updatedAt: { lt: cutoff },
        NOT: {
          bids: {
            some: {
              status: 'PENDING',
              createdAt: { gt: new Date(Date.now() - pendingBidGraceMs) },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true, riderId: true, status: true, createdAt: true },
    }),

  findActiveByDriver: (driverId: string) =>
    prisma.ride.findFirst({
      where: {
        driverId,
        status: { in: ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'] },
      },
    }),

  /** Trips this driver was assigned that ended cancelled — the raw material
   *  of a cancellation rate. Data first; policy later. */
  countCancelledByDriver: (driverId: string) =>
    prisma.ride.count({ where: { driverId, status: 'CANCELLED' } }),

  countCompletedByDriver: (driverId: string) =>
    prisma.ride.count({ where: { driverId, status: 'COMPLETED' } }),

  countCompletedByRider: (riderId: string) =>
    prisma.ride.count({ where: { riderId, status: 'COMPLETED' } }),

  /**
   * The places a rider has actually been: their last completed trips, newest
   * first, with the stops in order — enough to book the same trip again, or
   * the same trip backwards. Coordinates, not just text, so a renamed street
   * cannot break a repeat.
   */
  recentCompletedForRider: (riderId: string, limit = 5) =>
    prisma.ride.findMany({
      where: { riderId, status: 'COMPLETED' },
      orderBy: { completedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        completedAt: true,
        createdAt: true,
        pickupLat: true, pickupLng: true, pickupAddress: true,
        destLat: true, destLng: true, destAddress: true,
        agreedFareNgn: true, fareFinalNgn: true, riderOfferNgn: true,
        routeStops: {
          where: { type: 'INTERMEDIATE' },
          orderBy: { stopOrder: 'asc' },
          select: { lat: true, lng: true, address: true },
        },
      },
    }),

  findRiderHistory: (riderId: string, limit = 20, cursor?: string) =>
    prisma.ride.findMany({
      where:   { riderId, status: { in: ['COMPLETED', 'CANCELLED'] } },
      orderBy: { createdAt: 'desc' },
      take:    limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),

  findDriverHistory: (driverId: string, limit = 20, cursor?: string) =>
    prisma.ride.findMany({
      where:   { driverId, status: { in: ['COMPLETED', 'CANCELLED'] } },
      orderBy: { createdAt: 'desc' },
      take:    limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),

  // All rides currently in a stale-check-eligible state.
  // GPS monitor cron calls this to know which rides to check.
  findAllInProgress: () =>
    prisma.ride.findMany({
      where: { status: 'IN_PROGRESS' },
      select: {
        id:       true,
        driverId: true,
        riderId:  true,
        startedAt: true,
      },
    }),

  // ── Writes ─────────────────────────────────────────────────────────────────

  create: (data: {
    id:               string;     // UUID from the RIDE_REQUESTED Kafka event
    riderId:          string;
    pickupLat:        number;
    pickupLng:        number;
    pickupAddress:    string;
    destLat:          number;
    destLng:          number;
    destAddress:      string;
    stops?:           RouteStopInput[];
    fareEstimateNgn:  number;
    status?:          RideStatus;
    paymentMethod?:   RidePaymentMethod;
    riderOfferNgn?:   number;
  }) =>
    prisma.$transaction(async (tx) => {
      const { stops, ...rideData } = data;
      const ride = await tx.ride.create({ data: rideData });
      await tx.rideStop.createMany({
        data: buildRouteStops({
          rideId: data.id,
          stops,
          destination: {
            lat: data.destLat,
            lng: data.destLng,
            address: data.destAddress,
          },
        }),
      });
      return ride;
    }),

  markMatching: (rideId: string) =>
    prisma.ride.update({
      where: { id: rideId },
      data:  { status: 'MATCHING' },
    }),

  // Assign driver once matched — also sets matchedAt timestamp.
  //
  // A ride the SEARCH gave up on (see cancelIfUnmatched — "No driver accepted in
  // time") is not dead: a rider still adding money for a driver they chose, or a
  // driver bidding late, can win it. It is revived here. A ride the RIDER
  // cancelled never is — its cancelReason is theirs, not the timeout's.
  assignDriver: (rideId: string, driverId: string, opts?: {
    agreedFareNgn?: number;
    paymentMethod?: RidePaymentMethod;
  }) =>
    prisma.ride.updateMany({
      where: {
        id: rideId,
        OR: [
          { status: { in: ['REQUESTED', 'MATCHING'] } },
          { status: 'CANCELLED', cancelStage: 'BEFORE_MATCH', cancelReason: SEARCH_TIMED_OUT_REASON },
        ],
      },
      data: {
        driverId,
        status:    'DRIVER_ASSIGNED',
        matchedAt: new Date(),
        cancelStage: null,
        cancelReason: null,
        cancelledAt: null,
        ...(opts?.agreedFareNgn !== undefined ? { agreedFareNgn: opts.agreedFareNgn } : {}),
        ...(opts?.paymentMethod !== undefined ? { paymentMethod: opts.paymentMethod } : {}),
      },
    }),

  markDriverEnRoute: (rideId: string) =>
    prisma.ride.update({
      where: { id: rideId },
      data:  { status: 'DRIVER_EN_ROUTE' },
    }),

  markArrived: (rideId: string) =>
    prisma.ride.update({
      where: { id: rideId },
      data:  { status: 'ARRIVED', arrivedAt: new Date() },
    }),

  start: (rideId: string) =>
    prisma.ride.update({
      where: { id: rideId },
      data: {
        status:    'IN_PROGRESS',
        startedAt: new Date(),
      },
    }),

  complete: (rideId: string, data: {
    fareFinalNgn:    number;
    distanceKm:      number;
    durationSeconds: number;
    agreedFareNgn?:  number;
    paymentMethod?:  RidePaymentMethod;
  }) =>
    prisma.ride.update({
      where: { id: rideId },
      data: {
        ...data,
        status:      'COMPLETED',
        completedAt: new Date(),
      },
    }),

  cancel: (rideId: string, data: {
    cancelReason?: string;
    cancelStage?: 'BEFORE_MATCH' | 'AFTER_MATCH' | 'DRIVER_EN_ROUTE' | 'ACTIVE_TRIP';
  }) =>
    prisma.ride.update({
      where: { id: rideId },
      data: {
        ...data,
        status:      'CANCELLED',
        cancelledAt: new Date(),
      },
    }),

  /**
   * Cancel only if the ride is still unmatched. Returns the number of rows
   * changed (0 when a driver was assigned in the meantime or it was already
   * closed) so a bid timeout can never clobber a live trip.
   */
  cancelIfUnmatched: (rideId: string, cancelReason: string = SEARCH_TIMED_OUT_REASON) =>
    prisma.ride.updateMany({
      where: { id: rideId, status: { in: ['REQUESTED', 'MATCHING'] } },
      data: {
        status: 'CANCELLED',
        cancelStage: 'BEFORE_MATCH',
        cancelReason,
        cancelledAt: new Date(),
      },
    }),

  markDisputed: (rideId: string) =>
    prisma.ride.update({
      where: { id: rideId },
      data:  { status: 'DISPUTED' },
    }),

  findRouteStops: (rideId: string) =>
    prisma.rideStop.findMany({
      where: { rideId },
      orderBy: { stopOrder: 'asc' },
    }),

  syncRouteStops: (rideId: string, data: {
    destination: RouteDestinationInput;
    stops?: RouteStopInput[];
    fareEstimateNgn?: number;
  }) =>
    prisma.$transaction(async (tx) => {
      const existingCompletedStops = await tx.rideStop.findMany({
        where: {
          rideId,
          status: 'COMPLETED',
        },
        orderBy: { stopOrder: 'asc' },
      });

      await tx.ride.update({
        where: { id: rideId },
        data: {
          destLat: data.destination.lat,
          destLng: data.destination.lng,
          destAddress: data.destination.address,
          ...(data.fareEstimateNgn !== undefined ? { fareEstimateNgn: data.fareEstimateNgn } : {}),
        },
      });

      await tx.rideStop.deleteMany({ where: { rideId } });
      await tx.rideStop.createMany({
        data: buildRouteStops({
          rideId,
          completedStops: existingCompletedStops.map((stop) => ({
            lat: stop.lat,
            lng: stop.lng,
            address: stop.address,
            type: stop.type,
            status: stop.status,
            completedAt: stop.completedAt,
          })),
          stops: data.stops,
          destination: data.destination,
        }),
      });

      return tx.rideStop.findMany({
        where: { rideId },
        orderBy: { stopOrder: 'asc' },
      });
    }),

  completeNextStop: (rideId: string) =>
    prisma.$transaction(async (tx) => {
      const nextPendingStop = await tx.rideStop.findFirst({
        where: {
          rideId,
          type: 'INTERMEDIATE',
          status: 'PENDING',
        },
        orderBy: { stopOrder: 'asc' },
      });

      if (!nextPendingStop) {
        return null;
      }

      const completedStop = await tx.rideStop.update({
        where: { id: nextPendingStop.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
        },
      });

      const routeStops = await tx.rideStop.findMany({
        where: { rideId },
        orderBy: { stopOrder: 'asc' },
      });

      return {
        completedStop,
        routeStops,
      };
    }),

  completeFinalStop: (rideId: string, completedAt = new Date()) =>
    prisma.$transaction(async (tx) => {
      const finalStop = await tx.rideStop.findFirst({
        where: {
          rideId,
          type: 'FINAL',
          status: 'PENDING',
        },
        orderBy: { stopOrder: 'asc' },
      });

      if (!finalStop) {
        return tx.rideStop.findMany({
          where: { rideId },
          orderBy: { stopOrder: 'asc' },
        });
      }

      await tx.rideStop.update({
        where: { id: finalStop.id },
        data: {
          status: 'COMPLETED',
          completedAt,
        },
      });

      return tx.rideStop.findMany({
        where: { rideId },
        orderBy: { stopOrder: 'asc' },
      });
    }),

  // ── GPS logs ───────────────────────────────────────────────────────────────

  // Writes a GPS snapshot for dispute evidence.
  // Not every ping — ride-service samples every 30s.
  logGpsSnapshot: (data: {
    rideId:    string;
    lat:       number;
    lng:       number;
    speedKmh?: number;
    timestamp: Date;
  }) =>
    prisma.gpsLog.create({ data }),

  findGpsLogs: (rideId: string) =>
    prisma.gpsLog.findMany({
      where:   { rideId },
      orderBy: { timestamp: 'asc' },
    }),
};
