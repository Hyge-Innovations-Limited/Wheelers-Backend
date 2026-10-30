import { Prisma } from '@prisma/client';
import { CURRENT_PRICING_VERSION, pricingVersionOf, type PricingVersion } from '@wheleers/config';
import { driverPresence } from './driver-presence';
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

/** Statuses in which a route change may move the agreed fare. */
export const PRICE_CHANGEABLE_STATUSES: RideStatus[] = ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'];

export const rideClient = {
  /**
   * Which pricing rules a ride settles by (see Ride.pricingVersion). A ride
   * that cannot be found (a group seat has no Ride row yet) is priced by the
   * current rules.
   */
  pricingVersionOf: async (rideId: string): Promise<PricingVersion> => {
    const row = await prisma.ride.findUnique({ where: { id: rideId }, select: { pricingVersion: true } }).catch(() => null);
    return row ? pricingVersionOf(row.pricingVersion) : CURRENT_PRICING_VERSION;
  },

  /** The ride's short trip number (shown as WH-01234), or null if there is no such ride. */
  tripNumberOf: (rideId: string): Promise<number | null> =>
    prisma.ride
      .findUnique({ where: { id: rideId }, select: { tripNumber: true } })
      .then((ride) => ride?.tripNumber ?? null),


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

  /** The offers still open on a search, cheapest first, with who made each. */
  pendingBids: (rideId: string) =>
    prisma.driverBid.findMany({
      where: { rideId, status: 'PENDING' },
      orderBy: [{ amountNgn: 'asc' }, { etaSeconds: 'asc' }],
      include: { driver: { select: { rating: true, vehicleMake: true, vehicleModel: true, vehiclePlate: true, user: { select: { name: true } } } } },
    }),

  findWithDriver: async (rideId: string) => {
    const ride = await prisma.ride.findUniqueOrThrow({
      where:   { id: rideId },
      include: {
        driver: { include: { user: true } },
        routeStops: {
          orderBy: { stopOrder: 'asc' },
        },
      },
    });
    // The driver's position and last-seen time, as fresh as Redis has them.
    await driverPresence.overlay(ride.driver);
    return ride;
  },

  // A ride still in REQUESTED/MATCHING long after the bid window is dead —
  // nobody accepted and the timeout should have cancelled it. Don't let a
  // stale one block a rider from booking again while the sweeper catches up.
  // A search runs 30 minutes (RIDE.BID_TIMEOUT_SECONDS): an unmatched ride is live that long, plus a margin.
  // A trip with a driver comes first: a rider mid-trip whose scheduled ride
  // has just started searching must get their trip (and its code) back, not
  // the search.
  findActiveByRider: async (riderId: string, unmatchedMaxAgeMs = 35 * 60 * 1000) =>
    (await prisma.ride.findFirst({
      where: { riderId, status: { in: ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'] } },
      orderBy: { createdAt: 'desc' },
    })) ??
    prisma.ride.findFirst({
      where: {
        riderId,
        status: { in: ['REQUESTED', 'MATCHING'] },
        createdAt: { gte: new Date(Date.now() - unmatchedMaxAgeMs) },
      },
      orderBy: { createdAt: 'desc' },
    }),

  /**
   * Is the rider busy with another ride: on a trip (a driver assigned, on the
   * way, outside or driving), or searching (an unmatched ride inside the search
   * window, a booking being confirmed included)? The scheduler holds a ride for
   * later while this answers one; `excludeRideId` is the ride asking.
   */
  findOtherLiveRide: async (riderId: string, excludeRideId?: string, unmatchedMaxAgeMs = 35 * 60 * 1000) =>
    (await prisma.ride.findFirst({
      where: {
        riderId,
        status: { in: ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'] },
        ...(excludeRideId ? { NOT: { id: excludeRideId } } : {}),
      },
      orderBy: { createdAt: 'desc' },
    })) ??
    prisma.ride.findFirst({
      where: {
        riderId,
        status: { in: ['REQUESTED', 'MATCHING'] },
        createdAt: { gte: new Date(Date.now() - unmatchedMaxAgeMs) },
        ...(excludeRideId ? { NOT: { id: excludeRideId } } : {}),
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
    plannedDistanceKm?: number;
    /** The km of the route as priced at booking. */
    pricedPlannedKm?: number;
    /** Our suggested fare for the route at booking (the negotiated rate's base). */
    bookingSuggestedFareNgn?: number;
    status?:          RideStatus;
    paymentMethod?:   RidePaymentMethod;
    riderOfferNgn?:   number;
    channel?:         'APP' | 'WHATSAPP' | 'MCP' | 'UNKNOWN';
    pickupZone?:      string | null;
    destZone?:        string | null;
  }) =>
    prisma.$transaction(async (tx) => {
      const { stops, ...rideData } = data;
      // Stamped with the rules it is priced under now, so it settles by them whenever it ends.
      const ride = await tx.ride.create({ data: { pricingVersion: CURRENT_PRICING_VERSION, ...rideData } });
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

  /**
   * The rider changed their price during the search: the ride keeps the
   * CURRENT price, so every check (and a search rebuilt after a restart) uses
   * it, never the first one. Only while the search is open.
   */
  updateRiderOffer: (rideId: string, riderOfferNgn: number) =>
    prisma.ride.updateMany({
      where: { id: rideId, status: { in: ['REQUESTED', 'MATCHING'] } },
      data:  { riderOfferNgn: new Prisma.Decimal(riderOfferNgn) },
    }),

  /**
   * Back to matching after the assigned driver cancelled: the driver who left
   * is no longer this ride's driver (a later cancel used to re-notify them).
   */
  reopenForMatching: (rideId: string, fromDriverId?: string) =>
    // Only while the ride is still that driver's: a cancel delivered again must
    // never take a ride away from the driver who has it since.
    prisma.ride.updateMany({
      where: { id: rideId, ...(fromDriverId ? { driverId: fromDriverId } : {}) },
      data:  { status: 'MATCHING', driverId: null },
    }),

  /** Who owns a ride id and where it stands; null when no ride has that id. Errors propagate. */
  findStanding: (rideId: string) =>
    prisma.ride.findUnique({
      where: { id: rideId },
      select: { id: true, riderId: true, status: true, cancelStage: true, cancelReason: true },
    }),

  /**
   * The rider's own open search (REQUESTED or MATCHING) is MATCHING: the only thing written.
   * Any other ride, status or owner is untouched (count 0). The route, fare and payment method
   * are never rewritten here, so a repeated request cannot change a ride under its bids.
   */
  restartSearch: (id: string, riderId: string) =>
    prisma.ride.updateMany({
      where: { id, riderId, status: { in: ['REQUESTED', 'MATCHING'] } },
      data: { status: 'MATCHING' },
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
    /** The rider the assignment is for: another rider's ride is never assigned. */
    riderId?: string;
  }) => (async () => {
    // The negotiated rate is fixed here, once, with the agreed fare: agreed / our suggested fare at booking.
    let bargainRate: number | null = null;
    if (opts?.agreedFareNgn !== undefined && opts.agreedFareNgn > 0) {
      const row = await prisma.ride.findUnique({ where: { id: rideId }, select: { bookingSuggestedFareNgn: true, bargainRate: true } });
      const suggested = row?.bookingSuggestedFareNgn != null ? Number(row.bookingSuggestedFareNgn) : 0;
      // The rate of the ride is its first bargain: a re-match (a driver bailed) keeps it, and a missing one never overwrites a value.
      if (row?.bargainRate != null && row.bargainRate > 0) bargainRate = row.bargainRate;
      else if (suggested > 0) bargainRate = opts.agreedFareNgn / suggested;
    }
    return prisma.ride.updateMany({
      where: {
        id: rideId,
        ...(opts?.riderId !== undefined ? { riderId: opts.riderId } : {}),
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
        ...(bargainRate !== null ? { bargainRate } : {}),
        ...(opts?.paymentMethod !== undefined ? { paymentMethod: opts.paymentMethod } : {}),
      },
    });
  })(),

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

  /**
   * How the rider is paying, set when they accept a driver: naira from the
   * wallet, or XLM from their Stellar balance (with the rate it was accepted at
   * and the fare in XLM). Accepting again resets it — a driver who bailed means
   * the next acceptance chooses afresh.
   */
  setPayment: (rideId: string, payment: { method: 'WALLET' | 'XLM'; xlmRateNgn?: number | null; fareXlm?: string | null }) =>
    prisma.ride.update({
      where: { id: rideId },
      data: {
        paymentMethod: payment.method,
        xlmRateNgn: payment.method === 'XLM' ? payment.xlmRateNgn ?? null : null,
        fareXlm: payment.method === 'XLM' ? payment.fareXlm ?? null : null,
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
    /** The fare the rider accepted for the new route: settlement uses agreedFareNgn first. */
    agreedFareNgn?: number;
    /** The km the agreed fare is measured against. Written with a priced change, or alone by an unpriced one (so the driven distance is kept), only while the trip can still change price. */
    plannedDistanceKm?: number;
    /** With a priced change: the ride must still be as it was when the price was set, else nothing is changed (null returned). */
    base?: { agreedFareNgn?: number; plannedDistanceKm?: number | null; doneStops?: number };
  }) =>
    prisma.$transaction(async (tx) => {
      if (data.base) {
        // One guarded update decides (a concurrent change makes it match zero rows); then the stop count.
        const claimed = await tx.ride.updateMany({
          where: {
            id: rideId,
            status: { in: PRICE_CHANGEABLE_STATUSES },
            ...(data.base.agreedFareNgn !== undefined ? { agreedFareNgn: data.base.agreedFareNgn } : {}),
            ...(data.base.plannedDistanceKm !== undefined ? { plannedDistanceKm: data.base.plannedDistanceKm } : {}),
          },
          data: { updatedAt: new Date() },
        });
        if (claimed.count === 0) return null;
        if (data.base.doneStops !== undefined) {
          const done = await tx.rideStop.count({ where: { rideId, status: 'COMPLETED' } });
          if (done !== data.base.doneStops) return null;
        }
      }
      const existingCompletedStops = await tx.rideStop.findMany({
        where: {
          rideId,
          status: 'COMPLETED',
        },
        orderBy: { stopOrder: 'asc' },
      });

      // The agreed fare moves only on a trip that is booked and not over: never a finished or cancelled ride.
      const current = await tx.ride.findUnique({ where: { id: rideId }, select: { status: true, plannedDistanceKm: true, pricedPlannedKm: true } });
      const priceWritable = !!current && PRICE_CHANGEABLE_STATUSES.includes(current.status);

      await tx.ride.update({
        where: { id: rideId },
        data: {
          destLat: data.destination.lat,
          destLng: data.destination.lng,
          destAddress: data.destination.address,
          ...(data.fareEstimateNgn !== undefined ? { fareEstimateNgn: data.fareEstimateNgn } : {}),
          ...(priceWritable && data.agreedFareNgn !== undefined ? { agreedFareNgn: data.agreedFareNgn } : {}),
          ...(priceWritable && data.plannedDistanceKm !== undefined ? { plannedDistanceKm: data.plannedDistanceKm } : {}),
          // The priced baseline moves only with a PRICED change. An unpriced one pins it (once) to the km as they stood.
          ...(priceWritable && data.plannedDistanceKm !== undefined && data.agreedFareNgn !== undefined ? { pricedPlannedKm: data.plannedDistanceKm } : {}),
          ...(priceWritable && data.plannedDistanceKm !== undefined && data.agreedFareNgn === undefined && current?.pricedPlannedKm == null && current?.plannedDistanceKm != null ? { pricedPlannedKm: current.plannedDistanceKm } : {}),
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

  /** The newest recorded point of the ride (uses the (rideId, timestamp) index). */
  lastGpsPoint: (rideId: string) =>
    prisma.gpsLog.findFirst({ where: { rideId }, orderBy: { timestamp: 'desc' }, select: { lat: true, lng: true, timestamp: true } }),

  findGpsLogs: (rideId: string) =>
    prisma.gpsLog.findMany({
      where:   { rideId },
      orderBy: { timestamp: 'asc' },
    }),
};
