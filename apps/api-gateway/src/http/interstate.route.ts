import type { IncomingMessage, ServerResponse } from 'http';
import {
  driverClient,
  InterstateError,
  interstateClient,
  RATE_PER_KM_NGN,
  VEHICLE_CLASSES,
  priceForBooking,
  minimumOfferNgn,
  type InterstateVehicleType,
} from '@wheleers/db';
import { authenticateHttpUser, HttpAuthError } from './authenticate';
import { runIdempotentJsonRequest } from './idempotency';
import { logActivity } from '../analytics/log-activity';
import { getNumber, getString, isRecord } from '../utils/object';
import { readJsonBody, sendJson } from './utils';
import type { RedisClient } from '../redis/client';

/**
 * Interstate travel — booking a seat (or a whole vehicle) between cities.
 *
 * Money moves through the same wallet the rest of the platform uses. The
 * charge runs *inside* the seat-allocation transaction: if the wallet is short,
 * the seats are never taken, and if seat allocation loses a race, the rider is
 * never charged. That is the whole reason these handlers pass a callback down
 * rather than debiting first and booking afterwards.
 */

interface InterstateDeps {
  jwtSecret: string;
  redisClient: RedisClient;
}

function fail(res: ServerResponse, error: unknown, fallback: string): void {
  if (error instanceof HttpAuthError) {
    sendJson(res, 401, { error: error.message });
    return;
  }
  if (error instanceof InterstateError) {
    const status =
      error.code === 'ROUTE_NOT_FOUND' || error.code === 'DEPARTURE_NOT_FOUND' || error.code === 'BOOKING_NOT_FOUND'
        ? 404
        : error.code === 'SEATS_TAKEN' ||
            error.code === 'NOT_ENOUGH_SEATS' ||
            error.code === 'DEPARTURE_ALREADY_CLAIMED' ||
            error.code === 'DEPARTURE_WRONG_STATE'
          ? 409
          : error.code === 'DEPARTURE_NOT_YOURS' || error.code === 'NOT_A_DRIVER' || error.code === 'KYC_REQUIRED'
            ? 403
            : 400;
    sendJson(res, status, { error: error.message, code: error.code, ...(error.details ?? {}) });
    return;
  }
  // The detail goes to the log, not to the rider. A Prisma stack trace in a
  // toast helps nobody holding a phone at a motor park.
  console.error('[interstate] ' + fallback, {
    error: error instanceof Error ? error.message : String(error),
  });
  sendJson(res, 500, {
    error: 'Something went wrong on our side. Please try again in a moment.',
  });
}

function parseMode(value: unknown): 'SHARED' | 'CHARTER' {
  return String(value ?? '').toUpperCase() === 'CHARTER' ? 'CHARTER' : 'SHARED';
}

/**
 * Debits the rider's wallet for a booking. Returned as a callback so it runs
 * inside the booking transaction — see the note at the top of this file.
 */
function walletCharge(userId: string) {
  return async (amountNgn: number, reference: string, tx: Parameters<Parameters<typeof interstateClient.bookSeats>[0]['chargeWallet']>[2]) => {
    const wallet = await tx.wallet.findUnique({ where: { userId } });
    if (!wallet) {
      throw new InterstateError(
        'You need a Wheelers wallet before booking. Fund your account first.',
        'NO_WALLET',
      );
    }
    if (Number(wallet.balanceNgn) < amountNgn) {
      throw new InterstateError(
        `Insufficient balance. This trip costs ₦${amountNgn.toLocaleString('en-NG')} and your wallet has ₦${Number(wallet.balanceNgn).toLocaleString('en-NG')}.`,
        'INSUFFICIENT_BALANCE',
        { requiredNgn: amountNgn, balanceNgn: Number(wallet.balanceNgn) },
      );
    }

    const updated = await tx.wallet.update({
      where: { id: wallet.id },
      data: { balanceNgn: { decrement: amountNgn } },
    });
    await tx.transaction.create({
      data: {
        walletId: wallet.id,
        type: 'RIDE_PAYMENT',
        direction: 'DEBIT',
        amountNgn,
        balanceAfterNgn: updated.balanceNgn,
        referenceId: reference,
        metadata: { product: 'interstate' },
      },
    });
  };
}

function walletRefund(userId: string) {
  return async (amountNgn: number, reference: string, tx: Parameters<Parameters<typeof interstateClient.bookSeats>[0]['chargeWallet']>[2]) => {
    const wallet = await tx.wallet.findUnique({ where: { userId } });
    if (!wallet) return; // nothing to refund into; the cancel itself still stands
    const updated = await tx.wallet.update({
      where: { id: wallet.id },
      data: { balanceNgn: { increment: amountNgn } },
    });
    await tx.transaction.create({
      data: {
        walletId: wallet.id,
        type: 'REFUND',
        direction: 'CREDIT',
        amountNgn,
        balanceAfterNgn: updated.balanceNgn,
        referenceId: `refund-${reference}`,
        metadata: { product: 'interstate' },
      },
    });
  };
}

/** GET /interstate/routes?origin=&destination=&state= */
export async function handleListInterstateRoutesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InterstateDeps,
  url: URL,
): Promise<void> {
  try {
    await authenticateHttpUser(req, deps.jwtSecret);
    const routes = await interstateClient.listRoutes({
      origin: url.searchParams.get('origin') ?? undefined,
      destination: url.searchParams.get('destination') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    });
    sendJson(res, 200, {
      routes: routes.map((r) => ({
        id: r.id,
        origin: { state: r.originState, city: r.originCity, terminal: r.originTerminal },
        destination: { state: r.destState, city: r.destCity, terminal: r.destTerminal },
        distanceKm: r.distanceKm,
        durationMinutes: r.durationMinutes,
        seatPriceNgn: Number(r.seatPriceNgn),
        charterPriceNgn: Number(r.charterPriceNgn),
      })),
    });
  } catch (error) {
    fail(res, error, 'could not list routes');
  }
}

/** GET /interstate/cities — where you can travel from, and to. */
export async function handleInterstateCitiesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InterstateDeps,
  url: URL,
): Promise<void> {
  try {
    await authenticateHttpUser(req, deps.jwtSecret);
    const from = url.searchParams.get('from');
    if (from) {
      sendJson(res, 200, { from, destinations: await interstateClient.listDestinationsFrom(from) });
      return;
    }
    sendJson(res, 200, { origins: await interstateClient.listOrigins() });
  } catch (error) {
    fail(res, error, 'could not list cities');
  }
}

/** POST /interstate/quote  { routeId, mode?, seats? } */
export async function handleInterstateQuoteRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InterstateDeps,
): Promise<void> {
  try {
    await authenticateHttpUser(req, deps.jwtSecret);
    const body = await readJsonBody(req);
    if (!isRecord(body)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }
    const routeId = getString(body, 'routeId');
    if (!routeId) {
      sendJson(res, 400, { error: 'routeId is required' });
      return;
    }
    const quote = await interstateClient.quote({
      routeId,
      mode: parseMode(body['mode']),
      seats: getNumber(body, 'seats') ?? 1,
    });
    sendJson(res, 200, { ...quote });
  } catch (error) {
    fail(res, error, 'could not price this trip');
  }
}

/** GET /interstate/departures?routeId=&date=&seats= */
export async function handleInterstateDeparturesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InterstateDeps,
  url: URL,
): Promise<void> {
  try {
    await authenticateHttpUser(req, deps.jwtSecret);
    const routeId = url.searchParams.get('routeId');
    if (!routeId) {
      sendJson(res, 400, { error: 'routeId query parameter is required' });
      return;
    }

    // A bare date means "that whole day", which is how people think about travel.
    const dateParam = url.searchParams.get('date');
    let from: Date | undefined;
    let to: Date | undefined;
    if (dateParam) {
      const day = new Date(`${dateParam}T00:00:00`);
      if (Number.isNaN(day.getTime())) {
        sendJson(res, 400, { error: 'date must be YYYY-MM-DD' });
        return;
      }
      from = day;
      to = new Date(day.getTime() + 24 * 60 * 60 * 1000 - 1);
    }

    const seatsRaw = Number.parseInt(url.searchParams.get('seats') ?? '1', 10);
    const departures = await interstateClient.searchDepartures({
      routeId,
      from,
      to,
      seats: Number.isFinite(seatsRaw) ? seatsRaw : 1,
    });
    sendJson(res, 200, { departures });
  } catch (error) {
    fail(res, error, 'could not load departures');
  }
}

/**
 * GET /interstate/vehicles?routeId=&seats=
 *
 * The cars a rider can pick between on this route, each priced from the ₦450/km
 * rate. Everything the booking form needs to render its list in one call, so
 * the app never has to know the pricing rule to show a price.
 */
export async function handleInterstateVehiclesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InterstateDeps,
  url: URL,
): Promise<void> {
  try {
    await authenticateHttpUser(req, deps.jwtSecret);

    const routeId = url.searchParams.get('routeId');
    if (!routeId) {
      sendJson(res, 400, { error: 'Choose where you are travelling to first.' });
      return;
    }

    const route = await interstateClient.findRoute(routeId);
    if (!route || !route.active) {
      sendJson(res, 404, { error: 'We are not running that route right now.' });
      return;
    }

    const seatsRaw = Number.parseInt(url.searchParams.get('seats') ?? '1', 10);
    const seats = Number.isFinite(seatsRaw) ? Math.max(1, seatsRaw) : 1;

    sendJson(res, 200, {
      route: {
        id: route.id,
        origin: {
          state: route.originState,
          city: route.originCity,
          terminal: route.originTerminal,
        },
        destination: {
          state: route.destState,
          city: route.destCity,
          terminal: route.destTerminal,
        },
        distanceKm: route.distanceKm,
        durationMinutes: route.durationMinutes,
      },
      ratePerKmNgn: RATE_PER_KM_NGN,
      vehicles: VEHICLE_CLASSES.map((vehicle) => {
        // Both prices, because the rider has not chosen how they travel yet and
        // the form shows the consequence of each choice side by side.
        const alonePriceNgn = priceForBooking({
          distanceKm: route.distanceKm,
          vehicleType: vehicle.type,
          mode: 'alone',
          seats: vehicle.seats,
        });
        const togetherPriceNgn = priceForBooking({
          distanceKm: route.distanceKm,
          vehicleType: vehicle.type,
          mode: 'together',
          seats,
        });

        return {
          type: vehicle.type,
          label: vehicle.label,
          description: vehicle.description,
          seats: vehicle.seats,
          alonePriceNgn,
          togetherPriceNgn,
          seatPriceNgn: Math.round(togetherPriceNgn / seats),
          minimumOfferAloneNgn: minimumOfferNgn(alonePriceNgn),
          minimumOfferTogetherNgn: minimumOfferNgn(togetherPriceNgn),
        };
      }),
    });
  } catch (error) {
    fail(res, error, 'could not price this route');
  }
}

/**
 * POST /interstate/requests
 *
 * A rider asking to travel, rather than buying into a trip somebody else
 * already scheduled. Creates the trip and puts their booking on it — bidding
 * below the posted fare leaves it for a driver to accept, exactly like an offer
 * on an existing departure.
 */
export async function handleCreateTravelRequestRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InterstateDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const body = await readJsonBody(req);
    if (!isRecord(body)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    // Creating a trip moves money whenever the rider pays the posted fare, so a
    // retried request must not create a second one.
    const result = await runIdempotentJsonRequest({
      req,
      redisClient: deps.redisClient,
      userId: user.id,
      routeKey: 'interstate:travel-request:create',
      requestBody: body,
      execute: async () => createTravelRequest(user, body),
    });

    sendJson(res, result.statusCode, result.body);
  } catch (error) {
    fail(res, error, 'could not create this travel request');
  }
}

async function createTravelRequest(
  user: Awaited<ReturnType<typeof authenticateHttpUser>>,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const routeId = getString(body, 'routeId');
  if (!routeId) {
    return { statusCode: 400, body: { error: 'Choose where you are travelling to.' } };
  }

  const departureAtRaw = getString(body, 'departureAt');
  if (!departureAtRaw) {
    return { statusCode: 400, body: { error: 'Choose when you want to travel.' } };
  }

  const departureAt = new Date(departureAtRaw);
  if (Number.isNaN(departureAt.getTime())) {
    return { statusCode: 400, body: { error: 'That travel time is not valid.' } };
  }

  const vehicleRaw = String(getString(body, 'vehicleType') ?? '').toUpperCase();
  const vehicleType = VEHICLE_CLASSES.some((entry) => entry.type === vehicleRaw)
    ? (vehicleRaw as InterstateVehicleType)
    : null;
  if (!vehicleType) {
    return { statusCode: 400, body: { error: 'Choose a vehicle for this trip.' } };
  }

  const mode = getString(body, 'mode') === 'alone' ? 'alone' : 'together';
  const seats = Math.max(1, Math.floor(getNumber(body, 'seats') ?? 1));
  const offeredNgn = getNumber(body, 'offeredNgn');
  if (offeredNgn !== undefined && (!Number.isFinite(offeredNgn) || offeredNgn <= 0)) {
    return { statusCode: 400, body: { error: 'Enter a valid amount for your offer.' } };
  }

  const result = await interstateClient.createTravelRequest({
    routeId,
    userId: user.id,
    departureAt,
    vehicleType,
    mode,
    seats,
    offeredNgn,
    passengerName: getString(body, 'passengerName'),
    passengerPhone: getString(body, 'passengerPhone'),
    pickupNote: getString(body, 'pickupNote'),
    chargeWallet: walletCharge(user.id),
  });

  logActivity({
    userId: user.id,
    eventType: result.isBid ? 'interstate_request_bid' : 'interstate_request_booked',
    metadata: {
      reference: result.booking.reference,
      route: `${result.route.originCity} → ${result.route.destCity}`,
      vehicleType,
      mode,
      seats: result.booking.seats,
      offeredNgn: Number(result.booking.amountNgn),
      listPriceNgn: result.listPriceNgn,
    },
  });

  return {
    statusCode: 201,
    body: {
      booking: (await interstateClient.findBooking(
        result.booking.id,
        user.id,
      )) as unknown as Record<string, unknown>,
      listPriceNgn: result.listPriceNgn,
      pendingOffer: result.isBid,
    },
  };
}

/** POST /interstate/bookings  { departureId, seats?, passengerName?, ... } */
export async function handleCreateInterstateBookingRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InterstateDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const body = await readJsonBody(req);
    if (!isRecord(body)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    // Booking moves money, so a retried request must not buy the seat twice.
    // The app already sends an idempotency key; this route used to ignore it,
    // which made a double-tap a double charge.
    const result = await runIdempotentJsonRequest({
      req,
      redisClient: deps.redisClient,
      userId: user.id,
      routeKey: 'interstate:booking:create',
      requestBody: body,
      execute: async () => {
        return await createInterstateBooking(user, body);
      },
    });

    sendJson(res, result.statusCode, result.body);
  } catch (error) {
    fail(res, error, 'could not complete this booking');
  }
}

/**
 * The booking itself, split out so the idempotency wrapper above has a single
 * function to memoise. Returns the response rather than writing it, because a
 * replayed request must produce the same body without re-running any of this.
 */
async function createInterstateBooking(
  user: Awaited<ReturnType<typeof authenticateHttpUser>>,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const departureId = getString(body, 'departureId');
    if (!departureId) {
      return { statusCode: 400, body: { error: 'departureId is required' } };
    }
    const seats = Math.max(1, Math.floor(getNumber(body, 'seats') ?? 1));
    if (seats > 10) {
      return {
        statusCode: 400,
        body: {
          error:
            'You can book at most 10 seats at once. Charter a vehicle for a larger group.',
        },
      };
    }

    // A rider may name their own price. Below the posted fare it becomes an
    // offer a driver has to accept; at or above it, the booking is immediate.
    const offeredNgn = getNumber(body, 'offeredNgn');
    if (offeredNgn !== undefined && (!Number.isFinite(offeredNgn) || offeredNgn <= 0)) {
      return { statusCode: 400, body: { error: 'Enter a valid amount for your offer.' } };
    }

    if (offeredNgn !== undefined) {
      const departure = await interstateClient.findDeparture(departureId);
      if (!departure) {
        return { statusCode: 404, body: { error: 'That trip is no longer available.' } };
      }

      const listPriceNgn = Number(departure.seatPriceNgn) * seats;
      if (Math.round(offeredNgn) < listPriceNgn) {
        const offer = await interstateClient.offerForSeats({
          departureId,
          userId: user.id,
          seats,
          offeredNgn,
          passengerName: getString(body, 'passengerName'),
          passengerPhone: getString(body, 'passengerPhone'),
          pickupNote: getString(body, 'pickupNote'),
        });

        logActivity({
          userId: user.id,
          eventType: 'interstate_offer_placed',
          metadata: {
            reference: offer.booking.reference,
            seats,
            offeredNgn: Number(offer.booking.offeredNgn ?? 0),
            listPriceNgn,
            route: `${offer.route.originCity} → ${offer.route.destCity}`,
          },
        });

        return {
          statusCode: 201,
          body: {
            booking: (await interstateClient.findBooking(
              offer.booking.id,
              user.id,
            )) as unknown as Record<string, unknown>,
            pendingOffer: true,
            replacedPreviousOffer: offer.replaced,
          },
        };
      }
    }

    const result = await interstateClient.bookSeats({
      departureId,
      userId: user.id,
      seats,
      offeredNgn,
      passengerName: getString(body, 'passengerName'),
      passengerPhone: getString(body, 'passengerPhone'),
      pickupNote: getString(body, 'pickupNote'),
      chargeWallet: walletCharge(user.id),
    });

    logActivity({
      userId: user.id,
      eventType: 'interstate_booked',
      metadata: {
        reference: result.booking.reference,
        seats,
        mode: 'SHARED',
        route: `${result.route.originCity} → ${result.route.destCity}`,
        amountNgn: Number(result.booking.amountNgn),
      },
    });

    return {
      statusCode: 201,
      body: {
        booking: (await interstateClient.findBooking(
          result.booking.id,
          user.id,
        )) as unknown as Record<string, unknown>,
        seatsRemaining: result.seatsRemaining,
        pendingOffer: false,
      },
    };
}

/** POST /interstate/charters  { routeId, departureAt, vehicleType? } */
export async function handleCreateInterstateCharterRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InterstateDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const body = await readJsonBody(req);
    if (!isRecord(body)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const routeId = getString(body, 'routeId');
    const departureAtRaw = getString(body, 'departureAt');
    if (!routeId || !departureAtRaw) {
      sendJson(res, 400, { error: 'routeId and departureAt are required' });
      return;
    }
    const departureAt = new Date(departureAtRaw);
    if (Number.isNaN(departureAt.getTime())) {
      sendJson(res, 400, { error: 'departureAt must be an ISO datetime string' });
      return;
    }

    const vehicleRaw = String(getString(body, 'vehicleType') ?? 'SUV').toUpperCase();
    const vehicleType = (['SEDAN', 'SUV', 'MINIBUS', 'BUS'] as const).includes(vehicleRaw as 'SUV')
      ? (vehicleRaw as 'SEDAN' | 'SUV' | 'MINIBUS' | 'BUS')
      : 'SUV';

    const result = await interstateClient.charter({
      routeId,
      userId: user.id,
      departureAt,
      vehicleType,
      passengerName: getString(body, 'passengerName'),
      passengerPhone: getString(body, 'passengerPhone'),
      pickupNote: getString(body, 'pickupNote'),
      chargeWallet: walletCharge(user.id),
    });

    logActivity({
      userId: user.id,
      eventType: 'interstate_chartered',
      metadata: {
        reference: result.booking.reference,
        vehicleType,
        route: `${result.route.originCity} → ${result.route.destCity}`,
        amountNgn: Number(result.booking.amountNgn),
      },
    });

    sendJson(res, 201, { booking: await interstateClient.findBooking(result.booking.id, user.id) });
  } catch (error) {
    fail(res, error, 'could not book this charter');
  }
}

/** GET /interstate/bookings?upcoming=true */
export async function handleListInterstateBookingsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InterstateDeps,
  url: URL,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
    const bookings = await interstateClient.listBookings(user.id, {
      limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
      upcoming: url.searchParams.get('upcoming') === 'true',
    });
    sendJson(res, 200, { bookings });
  } catch (error) {
    fail(res, error, 'could not load your bookings');
  }
}

/** GET /interstate/bookings/:bookingId */
export async function handleGetInterstateBookingRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InterstateDeps,
  bookingId: string,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const booking = await interstateClient.findBooking(bookingId, user.id);
    if (!booking) {
      sendJson(res, 404, { error: 'Booking not found.' });
      return;
    }
    sendJson(res, 200, { booking });
  } catch (error) {
    fail(res, error, 'could not load this booking');
  }
}

/** POST /interstate/bookings/:bookingId/cancel  { reason? } */
export async function handleCancelInterstateBookingRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InterstateDeps,
  bookingId: string,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const body = await readJsonBody(req).catch(() => ({}));
    const reason = isRecord(body) ? getString(body, 'reason') : undefined;

    const result = await interstateClient.cancelBooking({
      bookingId,
      userId: user.id,
      reason,
      refundWallet: walletRefund(user.id),
    });

    logActivity({
      userId: user.id,
      eventType: 'interstate_cancelled',
      metadata: { bookingId, refundNgn: result.refundNgn, forfeitedNgn: result.forfeitedNgn },
    });

    sendJson(res, 200, {
      cancelled: true,
      refundNgn: result.refundNgn,
      forfeitedNgn: result.forfeitedNgn,
      refundPercent: Math.round(result.refundFraction * 100),
      booking: await interstateClient.findBooking(bookingId, user.id),
    });
  } catch (error) {
    fail(res, error, 'could not cancel this booking');
  }
}

/* ── Driver side ───────────────────────────────────────────────────────────
 *
 * An interstate driver is not matched to a passenger the way a city driver is.
 * They take a whole departure and run it, so their world is three questions:
 * what can I take, what am I running, and who is on board.
 */

/** The driver record behind the signed-in user, or a clear reason why not. */
async function requireDriver(req: IncomingMessage, jwtSecret: string) {
  const user = await authenticateHttpUser(req, jwtSecret);
  const driver = await driverClient.findByUserId(user.id);

  if (!driver) {
    throw new InterstateError(
      'Finish your driver sign-up before taking interstate trips.',
      'NOT_A_DRIVER',
    );
  }
  if (driver.kycStatus !== 'APPROVED') {
    throw new InterstateError('Finish your verification (KYC) before taking interstate trips.', 'KYC_REQUIRED');
  }

  return { user, driver };
}

function serializeDeparture(
  departure: Awaited<ReturnType<typeof interstateClient.claimDeparture>>,
) {
  return {
    id: departure.id,
    status: departure.status,
    departureAt: departure.departureAt.toISOString(),
    vehicleType: departure.vehicleType,
    vehiclePlate: departure.vehiclePlate,
    totalSeats: departure.totalSeats,
    seatsBooked: departure.seatsBooked,
    seatPriceNgn: Number(departure.seatPriceNgn),
    charterPriceNgn: Number(departure.charterPriceNgn),
    bookingMode: departure.bookingMode,
    // What the driver is actually paid for running it: every seat sold.
    grossNgn: Number(departure.seatPriceNgn) * departure.seatsBooked,
    departedAt: departure.departedAt?.toISOString() ?? null,
    arrivedAt: departure.arrivedAt?.toISOString() ?? null,
    route: {
      id: departure.route.id,
      origin: {
        state: departure.route.originState,
        city: departure.route.originCity,
        terminal: departure.route.originTerminal,
        lat: departure.route.originLat,
        lng: departure.route.originLng,
      },
      destination: {
        state: departure.route.destState,
        city: departure.route.destCity,
        terminal: departure.route.destTerminal,
        lat: departure.route.destLat,
        lng: departure.route.destLng,
      },
      distanceKm: departure.route.distanceKm,
      durationMinutes: departure.route.durationMinutes,
    },
  };
}

/** GET /interstate/driver/available — trips nobody is driving yet. */
export async function handleListClaimableDeparturesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InterstateDeps,
  url: URL,
): Promise<void> {
  try {
    await requireDriver(req, deps.jwtSecret);
    const withinHoursRaw = Number.parseInt(url.searchParams.get('withinHours') ?? '', 10);
    const departures = await interstateClient.listClaimableDepartures({
      withinHours: Number.isFinite(withinHoursRaw) ? withinHoursRaw : undefined,
    });

    sendJson(res, 200, { departures: departures.map(serializeDeparture) });
  } catch (error) {
    fail(res, error, 'could not load available interstate trips');
  }
}

/** GET /interstate/driver/trips?includeFinished=true — what this driver is running. */
export async function handleListDriverDeparturesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InterstateDeps,
  url: URL,
): Promise<void> {
  try {
    const { driver } = await requireDriver(req, deps.jwtSecret);
    const departures = await interstateClient.listDriverDepartures(driver.id, {
      includeFinished: url.searchParams.get('includeFinished') === 'true',
    });

    sendJson(res, 200, { departures: departures.map(serializeDeparture) });
  } catch (error) {
    fail(res, error, 'could not load your interstate trips');
  }
}

/** POST /interstate/driver/departures/:id/claim  { vehiclePlate? } */
export async function handleClaimDepartureRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InterstateDeps,
  departureId: string,
): Promise<void> {
  try {
    const { user, driver } = await requireDriver(req, deps.jwtSecret);
    const body = await readJsonBody(req).catch(() => ({}));
    const vehiclePlate = isRecord(body) ? getString(body, 'vehiclePlate') : undefined;

    const departure = await interstateClient.claimDeparture({
      departureId,
      driverId: driver.id,
      vehiclePlate: vehiclePlate ?? driver.vehiclePlate ?? null,
    });

    await logActivity({
      userId: user.id,
      eventType: 'INTERSTATE_DEPARTURE_CLAIMED',
      source: 'app',
      metadata: { departureId, routeId: departure.routeId },
    });

    sendJson(res, 200, { departure: serializeDeparture(departure) });
  } catch (error) {
    fail(res, error, 'could not take this trip');
  }
}

/** POST /interstate/driver/departures/:id/start */
export async function handleStartDepartureRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InterstateDeps,
  departureId: string,
): Promise<void> {
  try {
    const { driver } = await requireDriver(req, deps.jwtSecret);
    const departure = await interstateClient.advanceDriverDeparture({
      departureId,
      driverId: driver.id,
      to: 'IN_TRANSIT',
    });

    sendJson(res, 200, { departure: serializeDeparture(departure) });
  } catch (error) {
    fail(res, error, 'could not start this trip');
  }
}

/** POST /interstate/driver/departures/:id/complete */
export async function handleCompleteDepartureRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InterstateDeps,
  departureId: string,
): Promise<void> {
  try {
    const { driver } = await requireDriver(req, deps.jwtSecret);
    const departure = await interstateClient.advanceDriverDeparture({
      departureId,
      driverId: driver.id,
      to: 'COMPLETED',
    });

    sendJson(res, 200, { departure: serializeDeparture(departure) });
  } catch (error) {
    fail(res, error, 'could not finish this trip');
  }
}

/** GET /interstate/driver/offers — bids waiting on a decision. */
export async function handleListInterstateOffersRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InterstateDeps,
  url: URL,
): Promise<void> {
  try {
    await requireDriver(req, deps.jwtSecret);
    const offers = await interstateClient.listPendingOffers({
      departureId: url.searchParams.get('departureId') ?? undefined,
    });

    sendJson(res, 200, {
      offers: offers.map((offer) => ({
        bookingId: offer.id,
        reference: offer.reference,
        seats: offer.seats,
        offeredNgn: Number(offer.offeredNgn ?? offer.amountNgn),
        listPriceNgn: Number(offer.listPriceNgn ?? 0),
        pickupNote: offer.pickupNote,
        createdAt: offer.createdAt.toISOString(),
        passenger: {
          name: offer.passengerName ?? offer.user.name ?? 'Passenger',
          // The phone stays hidden until a driver has actually taken the trip.
          // A pending bid is not a reason to hand out a rider's number.
          phone: null,
        },
        departure: {
          id: offer.departure.id,
          departureAt: offer.departure.departureAt.toISOString(),
          seatsAvailable: offer.departure.totalSeats - offer.departure.seatsBooked,
          seatPriceNgn: Number(offer.departure.seatPriceNgn),
          route: {
            id: offer.departure.route.id,
            origin: {
              state: offer.departure.route.originState,
              city: offer.departure.route.originCity,
              terminal: offer.departure.route.originTerminal,
            },
            destination: {
              state: offer.departure.route.destState,
              city: offer.departure.route.destCity,
              terminal: offer.departure.route.destTerminal,
            },
            distanceKm: offer.departure.route.distanceKm,
            durationMinutes: offer.departure.route.durationMinutes,
          },
        },
      })),
    });
  } catch (error) {
    fail(res, error, 'could not load passenger offers');
  }
}

/** POST /interstate/driver/offers/:bookingId/accept */
export async function handleAcceptInterstateOfferRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InterstateDeps,
  bookingId: string,
): Promise<void> {
  try {
    const { user, driver } = await requireDriver(req, deps.jwtSecret);
    let result;
    try {
      result = await interstateClient.acceptOffer({
        bookingId,
        driverId: driver.id,
        // The rider is charged here, not when they made the offer — this is the
        // first moment anyone agreed to carry them at that price.
        chargeWalletFor: (riderUserId) => walletCharge(riderUserId),
      });
    } catch (error) {
      // The wallet error is written for the person who owns the wallet, and
      // that is the passenger, not the driver reading this response. Sending it
      // through untouched would tell the driver *their* balance was short and
      // would put the passenger's balance on the driver's screen.
      if (error instanceof InterstateError && error.code === 'INSUFFICIENT_BALANCE') {
        sendJson(res, 409, {
          error:
            'This passenger does not have enough in their wallet to pay that offer. Nothing was charged.',
          code: 'PASSENGER_INSUFFICIENT_BALANCE',
        });
        return;
      }
      throw error;
    }

    await logActivity({
      userId: user.id,
      eventType: 'interstate_offer_accepted',
      source: 'app',
      metadata: {
        bookingId,
        amountNgn: Number(result.booking.amountNgn),
        route: `${result.route.originCity} → ${result.route.destCity}`,
      },
    });

    sendJson(res, 200, { accepted: true, bookingId: result.booking.id });
  } catch (error) {
    fail(res, error, 'could not accept this offer');
  }
}

/** POST /interstate/driver/offers/:bookingId/decline */
export async function handleDeclineInterstateOfferRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InterstateDeps,
  bookingId: string,
): Promise<void> {
  try {
    await requireDriver(req, deps.jwtSecret);
    const body = await readJsonBody(req).catch(() => ({}));
    const reason = isRecord(body) ? getString(body, 'reason') : undefined;

    await interstateClient.declineOffer({ bookingId, reason });
    sendJson(res, 200, { declined: true, bookingId });
  } catch (error) {
    fail(res, error, 'could not decline this offer');
  }
}

/** GET /interstate/driver/departures/:id/manifest — who is travelling. */
export async function handleDepartureManifestRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InterstateDeps,
  departureId: string,
): Promise<void> {
  try {
    const { driver } = await requireDriver(req, deps.jwtSecret);
    const departure = await interstateClient.departureManifest(departureId, driver.id);

    sendJson(res, 200, {
      departure: serializeDeparture(departure),
      passengers: departure.bookings.map((booking) => ({
        bookingId: booking.id,
        reference: booking.reference,
        // Riders routinely book for family, so the traveller's name is not
        // necessarily the account holder's.
        name: booking.passengerName ?? booking.user.name ?? 'Passenger',
        phone: booking.passengerPhone ?? booking.user.phone ?? null,
        seats: booking.seats,
        mode: booking.mode,
        status: booking.status,
        pickupNote: booking.pickupNote,
      })),
    });
  } catch (error) {
    fail(res, error, 'could not load the passenger list');
  }
}
