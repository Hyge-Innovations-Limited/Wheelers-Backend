import type { IncomingMessage, ServerResponse } from 'http';
import { driverClient, driverLocationClient, rideClient, walletClient, driverBidClient } from '@wheleers/db';
import { authenticateHttpUser, HttpAuthError } from './authenticate';
import { readJsonBody, sendJson } from './utils';
import { loadDriverActiveRideSnapshot } from '../websocket/driver-ride-sync';

interface DriverRouteDeps {
  jwtSecret: string;
}

/**
 * 401 only for real auth failures. Anything else is our fault, not the
 * client's — reporting it as 401 makes the app treat a server error as an
 * expired session and sign the driver out.
 */
function sendDriverRouteError(
  res: ServerResponse,
  route: string,
  error: unknown,
  fallbackMessage: string,
): void {
  if (error instanceof HttpAuthError) {
    sendJson(res, 401, { error: error.message });
    return;
  }

  console.error(`[api-gateway][driver] ${route} failed`, {
    error: error instanceof Error ? error.message : String(error),
  });
  sendJson(res, 500, { error: fallbackMessage });
}

function decimalToNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  if (
    value &&
    typeof value === 'object' &&
    'toNumber' in value &&
    typeof value.toNumber === 'function'
  ) {
    const parsed = value.toNumber();
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function parseLimit(value: string | null): number {
  if (!value) return 20;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 20;
  return Math.min(parsed, 50);
}

// GET /drivers/me/stats
export async function handleGetDriverStatsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DriverRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const driver = await driverClient.findByUserId(user.id);

    if (!driver) {
      sendJson(res, 404, { error: 'No driver profile found.' });
      return;
    }

    const wallet = await walletClient.findByUserId(user.id);
    const [completedRides, cancelledRides] = await Promise.all([
      rideClient.countCompletedByDriver(driver.id).catch(() => 0),
      rideClient.countCancelledByDriver(driver.id).catch(() => 0),
    ]);
    const decidedRides = completedRides + cancelledRides;

    sendJson(res, 200, {
      driverId: driver.id,
      userId: driver.userId,
      status: driver.status,
      kycStatus: driver.kycStatus,
      rating: driver.rating,
      totalRides: driver.totalRides,
      totalEarningsNgn: decimalToNumber(driver.totalEarningsNgn),
      ratingCount: driver.ratingCount,
      completedRides,
      cancelledRides,
      // Share of decided trips that ended cancelled. Accountability starts
      // as a number on your own profile before it's ever a policy.
      cancellationRate: decidedRides > 0 ? Math.round((cancelledRides / decidedRides) * 100) / 100 : 0,
      vehicleMake: driver.vehicleMake,
      vehicleModel: driver.vehicleModel,
      vehiclePlate: driver.vehiclePlate,
      vehicleYear: driver.vehicleYear,
      balanceNgn: wallet ? decimalToNumber(wallet.balanceNgn) : 0,
      lockedNgn: wallet ? decimalToNumber(wallet.lockedNgn) : 0,
    });
  } catch (error) {
    sendDriverRouteError(res, 'GET /drivers/me/stats', error, 'Could not load driver stats.');
  }
}

// GET /drivers/me/rides/active — the ride this driver is assigned to right
// now, or null. The socket is the primary channel, but it is fire-and-forget:
// a driver whose app was backgrounded (or restarted) when the rider paid
// never got `ride:matched`. This is how the app catches up on reconnect,
// on foreground, and when it is unsure what a stale "bid sent" card means.
export async function handleGetDriverActiveRideRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DriverRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const driver = await driverClient.findByUserId(user.id);

    if (!driver) {
      sendJson(res, 404, { error: 'No driver profile found.' });
      return;
    }

    const ride = await loadDriverActiveRideSnapshot(driver.id);
    sendJson(res, 200, { ride });
  } catch (error) {
    sendDriverRouteError(res, 'GET /drivers/me/rides/active', error, 'Could not load active ride.');
  }
}

// GET /drivers/me/bids?limit=20&cursor= — every bid this driver has sent,
// newest first, with how each one ended and the trip it was on.
export async function handleGetDriverBidsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DriverRouteDeps,
  url: URL,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const driver = await driverClient.findByUserId(user.id);

    if (!driver) {
      sendJson(res, 404, { error: 'No driver profile found.' });
      return;
    }

    const limit = parseLimit(url.searchParams.get('limit'));
    const cursor = url.searchParams.get('cursor') ?? undefined;
    const bids = await driverBidClient.findForDriver(driver.id, limit + 1, cursor);
    const hasMore = bids.length > limit;
    const page = hasMore ? bids.slice(0, limit) : bids;

    sendJson(res, 200, {
      items: page.map((bid) => ({
        id: bid.id,
        rideId: bid.rideId,
        // The rider's id — without it a re-bid from a backfilled card had
        // nothing to address and the gateway rejected it.
        riderId: bid.riderId,
        amountNgn: decimalToNumber(bid.amountNgn),
        etaSeconds: bid.etaSeconds,
        distanceKm: bid.distanceKm ?? null,
        status: bid.status,
        createdAt: bid.createdAt.toISOString(),
        resolvedAt: bid.resolvedAt?.toISOString() ?? null,
        ride: {
          status: bid.ride.status,
          pickupAddress: bid.ride.pickupAddress,
          destAddress: bid.ride.destAddress,
          riderOfferNgn:
            bid.ride.riderOfferNgn === null ? null : decimalToNumber(bid.ride.riderOfferNgn),
          agreedFareNgn:
            bid.ride.agreedFareNgn === null ? null : decimalToNumber(bid.ride.agreedFareNgn),
          fareEstimateNgn:
            bid.ride.fareEstimateNgn === null ? null : decimalToNumber(bid.ride.fareEstimateNgn),
          distanceKm: bid.ride.distanceKm ?? null,
          matchedAt: bid.ride.matchedAt?.toISOString() ?? null,
          completedAt: bid.ride.completedAt?.toISOString() ?? null,
          cancelledAt: bid.ride.cancelledAt?.toISOString() ?? null,
        },
      })),
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    });
  } catch (error) {
    sendDriverRouteError(res, 'GET /drivers/me/bids', error, 'Could not load your bids.');
  }
}

// POST /drivers/me/location — background heartbeat. The WebSocket dies when
// the app is backgrounded; this is how a pocketed phone stays a live driver
// (matching requires lastSeenAt within 90s). Body: { lat, lng }.
export async function handlePostDriverLocationRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DriverRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const driver = await driverClient.findByUserId(user.id);
    if (!driver) {
      sendJson(res, 404, { error: 'No driver profile found.' });
      return;
    }
    const body = await readJsonBody(req).catch(() => null);
    const record = (body ?? {}) as Record<string, unknown>;
    const lat = typeof record.lat === 'number' ? record.lat : Number(record.lat);
    const lng = typeof record.lng === 'number' ? record.lng : Number(record.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      sendJson(res, 400, { error: 'lat and lng are required numbers.' });
      return;
    }
    await driverClient.updateLocation(driver.id, lat, lng);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendDriverRouteError(res, 'POST /drivers/me/location', error, 'Could not update location.');
  }
}

function readLatLng(body: unknown): { lat: number; lng: number } | null {
  const record = (body ?? {}) as Record<string, unknown>;
  const lat = typeof record.lat === 'number' ? record.lat : Number(record.lat);
  const lng = typeof record.lng === 'number' ? record.lng : Number(record.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function serialiseStandby(state: { standbyEnabled: boolean; standbyConsentAt: Date | null; standbySeenAt: Date | null }) {
  return {
    enabled: state.standbyEnabled,
    consentAt: state.standbyConsentAt?.toISOString() ?? null,
    lastSentAt: state.standbySeenAt?.toISOString() ?? null,
  };
}

// GET /drivers/me/standby  — is "Nearby ride alerts" on?
// PUT /drivers/me/standby  — { enabled }. Off also erases the stored position.
export async function handleDriverStandbyRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DriverRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const driver = await driverClient.findByUserId(user.id);
    if (!driver) {
      sendJson(res, 404, { error: 'No driver profile found.' });
      return;
    }
    if (req.method === 'GET') {
      const state = await driverLocationClient.getStandby(driver.id);
      sendJson(res, 200, serialiseStandby(state ?? { standbyEnabled: false, standbyConsentAt: null, standbySeenAt: null }));
      return;
    }
    const body = (await readJsonBody(req).catch(() => null)) as Record<string, unknown> | null;
    if (typeof body?.enabled !== 'boolean') {
      sendJson(res, 400, { error: 'enabled must be true or false.' });
      return;
    }
    const state = await driverLocationClient.setStandby(driver.id, body.enabled);
    console.info('[driver] nearby ride alerts ' + (body.enabled ? 'on' : 'off'), { driverId: driver.id });
    sendJson(res, 200, serialiseStandby(state));
  } catch (error) {
    sendDriverRouteError(res, 'PUT /drivers/me/standby', error, 'Could not update nearby ride alerts.');
  }
}

// POST /drivers/me/standby-location — rough position while OFF shift. Never
// touches lat/lng/lastSeenAt, so it cannot make an offline driver matchable.
// 409 STANDBY_OFF tells the app to stop its background task.
export async function handlePostDriverStandbyLocationRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DriverRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const driver = await driverClient.findByUserId(user.id);
    if (!driver) {
      sendJson(res, 404, { error: 'No driver profile found.' });
      return;
    }
    const point = readLatLng(await readJsonBody(req).catch(() => null));
    if (!point) {
      sendJson(res, 400, { error: 'lat and lng are required numbers.' });
      return;
    }
    const stored = await driverLocationClient.updateStandbyLocation(driver.id, point.lat, point.lng);
    if (!stored) {
      sendJson(res, 409, { error: 'Nearby ride alerts are off.', code: 'STANDBY_OFF' });
      return;
    }
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendDriverRouteError(res, 'POST /drivers/me/standby-location', error, 'Could not update location.');
  }
}

// GET /drivers/me/earnings?period=today|week|month
export async function handleGetDriverEarningsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DriverRouteDeps,
  url: URL,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const driver = await driverClient.findByUserId(user.id);

    if (!driver) {
      sendJson(res, 404, { error: 'No driver profile found.' });
      return;
    }

    const period = url.searchParams.get('period') ?? 'today';
    const now = new Date();
    let since: Date;

    if (period === 'week') {
      since = new Date(now);
      since.setDate(since.getDate() - 7);
      since.setHours(0, 0, 0, 0);
    } else if (period === 'month') {
      since = new Date(now.getFullYear(), now.getMonth(), 1);
    } else {
      since = new Date(now);
      since.setHours(0, 0, 0, 0);
    }

    const wallet = await walletClient.findByUserId(user.id);
    const earningTransactions = wallet
      ? await walletClient.findDriverPayoutsSince(wallet.id, since)
      : [];

    const totalEarningsNgn = earningTransactions.reduce(
      (sum, tx) => sum + decimalToNumber(tx.amountNgn),
      0,
    );

    sendJson(res, 200, {
      period,
      totalEarningsNgn: Math.round(totalEarningsNgn * 100) / 100,
      rideCount: earningTransactions.length,
      items: earningTransactions.map((tx) => ({
        id: tx.id,
        amountNgn: decimalToNumber(tx.amountNgn),
        referenceId: tx.referenceId,
        createdAt: tx.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    sendDriverRouteError(res, 'GET /drivers/me/earnings', error, 'Could not load driver earnings.');
  }
}

// GET /drivers/me/rides/history?limit=20&cursor=
export async function handleGetDriverRideHistoryRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DriverRouteDeps,
  url: URL,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const driver = await driverClient.findByUserId(user.id);

    if (!driver) {
      sendJson(res, 404, { error: 'No driver profile found.' });
      return;
    }

    const limit = parseLimit(url.searchParams.get('limit'));
    const cursor = url.searchParams.get('cursor') ?? undefined;
    const rides = await rideClient.findDriverHistory(driver.id, limit, cursor);

    sendJson(res, 200, {
      items: rides.map((ride) => ({
        id: ride.id,
        status: ride.status,
        pickupAddress: ride.pickupAddress,
        destAddress: ride.destAddress,
        fareEstimateNgn: decimalToNumber(ride.fareEstimateNgn),
        fareFinalNgn: ride.fareFinalNgn ? decimalToNumber(ride.fareFinalNgn) : null,
        distanceKm: ride.distanceKm ? decimalToNumber(ride.distanceKm) : null,
        durationSeconds: ride.durationSeconds,
        matchedAt: ride.matchedAt?.toISOString() ?? null,
        startedAt: ride.startedAt?.toISOString() ?? null,
        completedAt: ride.completedAt?.toISOString() ?? null,
        cancelledAt: ride.cancelledAt?.toISOString() ?? null,
        cancelReason: ride.cancelReason,
        createdAt: ride.createdAt.toISOString(),
      })),
      nextCursor:
        rides.length === limit ? (rides[rides.length - 1]?.id ?? null) : null,
    });
  } catch (error) {
    sendDriverRouteError(res, 'GET /drivers/me/rides/history', error, 'Could not load driver ride history.');
  }
}
