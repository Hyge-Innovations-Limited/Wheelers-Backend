import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { driverLocationClient, userClient } from '@wheleers/db';
import type { ActiveRide, MapDriverRow } from '@wheleers/db';
import { verifyAdminAuth } from './admin-auth.route';
import { readJsonBody, sendJson } from './utils';
import { isRecord } from '../utils/object';
import { haversineKm, estimateEtaSeconds } from '../utils/geo';
import type { GatewayPublisher } from '../websocket/publisher';

/**
 * The admin live map and dispatch panel.
 *
 *   GET  /admin/live/drivers                 every driver with a known position
 *   GET  /admin/live/drivers/:id             one driver + recent dispatch contacts
 *   GET  /admin/live/drivers/:id/trail       where they have been (?minutes=)
 *   GET  /admin/live/dispatch                rides with no driver + nearest drivers
 *   POST /admin/live/drivers/:id/nudge       "ride near you" push
 *   POST /admin/live/drivers/:id/contacts    log a phone call and how it went
 *
 * Read-only towards matching: nothing here changes a driver's status, position
 * or availability. An operator calls or nudges; the driver decides.
 */

interface LiveMapDeps {
  adminApiKey: string;
  jwtSecret: string;
  publisher: GatewayPublisher;
}

/** Matching treats a driver as live for 90s; the map allows a little slack. */
const FRESH_ONLINE_MS = 120_000;
/** Standby pings arrive every 10–15 min; two missed pings means we lost them. */
const FRESH_STANDBY_MS = 45 * 60_000;
const NUDGE_COOLDOWN_MS = 2 * 60_000;
const DISPATCH_LOOKBACK_MS = 60 * 60_000;
const NEAREST_PER_RIDE = 6;
/** Beyond this a driver is not "nearby", however available they are. */
const MAX_DISPATCH_KM = 30;
const MAX_TRAIL_MINUTES = 14 * 24 * 60;

const CALL_OUTCOMES = new Set(['accepted', 'declined', 'no_answer', 'unreachable']);

export type Presence = 'on_trip' | 'online' | 'stale' | 'standby' | 'offline';

export interface PresenceInput {
  status: string;
  lat: number | null;
  lng: number | null;
  lastSeenAt: Date | null;
  standbyEnabled: boolean;
  standbyLat: number | null;
  standbyLng: number | null;
  standbySeenAt: Date | null;
}

export interface ResolvedPosition {
  presence: Presence;
  lat: number;
  lng: number;
  seenAt: Date;
  /** Which feed the position came from. */
  source: 'online' | 'standby';
}

/**
 * One driver, one pin. On shift the online position always wins; off shift we
 * show whichever fix is newer, and only call it "standby" while it is fresh.
 */
export function resolvePosition(driver: PresenceInput, now: number): ResolvedPosition | null {
  const online =
    driver.lat !== null && driver.lng !== null && driver.lastSeenAt
      ? { lat: driver.lat, lng: driver.lng, seenAt: driver.lastSeenAt, source: 'online' as const }
      : null;
  const standby =
    driver.standbyEnabled && driver.standbyLat !== null && driver.standbyLng !== null && driver.standbySeenAt
      ? { lat: driver.standbyLat, lng: driver.standbyLng, seenAt: driver.standbySeenAt, source: 'standby' as const }
      : null;

  const onShift = driver.status === 'ONLINE' || driver.status === 'ON_RIDE';
  if (onShift && online) {
    const fresh = now - online.seenAt.getTime() <= FRESH_ONLINE_MS;
    const presence: Presence = !fresh ? 'stale' : driver.status === 'ON_RIDE' ? 'on_trip' : 'online';
    return { presence, ...online };
  }

  const latest =
    online && standby
      ? (standby.seenAt.getTime() >= online.seenAt.getTime() ? standby : online)
      : (standby ?? online);
  if (!latest) return null;

  const standbyFresh =
    latest.source === 'standby' && now - latest.seenAt.getTime() <= FRESH_STANDBY_MS;
  return { presence: standbyFresh ? 'standby' : 'offline', ...latest };
}

function toMapDriver(row: MapDriverRow, ride: ActiveRide | undefined, now: number) {
  const position = resolvePosition(row, now);
  if (!position) return null;
  return {
    id: row.id,
    userId: row.userId,
    name: row.user.name ?? 'Unnamed driver',
    phone: row.user.phone,
    photoUrl: row.user.photoUrl,
    status: row.status,
    kycStatus: row.kycStatus,
    presence: position.presence,
    lat: position.lat,
    lng: position.lng,
    positionSource: position.source,
    seenAt: position.seenAt.toISOString(),
    secondsSinceSeen: Math.max(0, Math.round((now - position.seenAt.getTime()) / 1000)),
    standbyEnabled: row.standbyEnabled,
    vehicle: [row.vehicleMake, row.vehicleModel].filter(Boolean).join(' ') || null,
    plate: row.vehiclePlate,
    rating: row.rating,
    totalRides: row.totalRides,
    ride: ride
      ? {
          id: ride.id,
          status: ride.status,
          pickupAddress: ride.pickupAddress,
          destAddress: ride.destAddress,
          destLat: ride.destLat,
          destLng: ride.destLng,
        }
      : null,
  };
}

type MapDriver = NonNullable<ReturnType<typeof toMapDriver>>;

async function loadMapDrivers(now: number): Promise<MapDriver[]> {
  const rows = await driverLocationClient.listForMap();
  const onRide = rows.filter((row) => row.status === 'ON_RIDE').map((row) => row.id);
  const rides = await driverLocationClient.activeRidesByDriver(onRide);
  return rows
    .map((row) => toMapDriver(row, rides.get(row.id), now))
    .filter((driver): driver is MapDriver => driver !== null);
}

function summarise(drivers: MapDriver[]) {
  const counts: Record<Presence, number> = { on_trip: 0, online: 0, stale: 0, standby: 0, offline: 0 };
  for (const driver of drivers) counts[driver.presence] += 1;
  return { total: drivers.length, ...counts };
}

async function requireAdminName(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LiveMapDeps,
): Promise<string | null> {
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return null;
  }
  return auth.adminName;
}

function fail(res: ServerResponse, error: unknown, message: string): void {
  console.error(`[live-map] ${message}`, {
    error: error instanceof Error ? error.message : String(error),
  });
  sendJson(res, 500, { error: message });
}

/** GET /admin/live/drivers */
export async function handleLiveDriversRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LiveMapDeps,
): Promise<void> {
  if (!(await requireAdminName(req, res, deps))) return;
  try {
    const now = Date.now();
    const drivers = await loadMapDrivers(now);
    sendJson(res, 200, { generatedAt: new Date(now).toISOString(), summary: summarise(drivers), drivers });
  } catch (error) {
    fail(res, error, 'Could not load the live map');
  }
}

/** GET /admin/live/drivers/:id */
export async function handleLiveDriverDetailRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LiveMapDeps,
  driverId: string,
): Promise<void> {
  if (!(await requireAdminName(req, res, deps))) return;
  try {
    const row = await driverLocationClient.findForMap(driverId);
    if (!row) {
      sendJson(res, 404, { error: 'Driver not found' });
      return;
    }
    const now = Date.now();
    const rides = await driverLocationClient.activeRidesByDriver([row.id]);
    const contacts = await driverLocationClient.contactsForDriver(row.id);
    sendJson(res, 200, {
      driver: toMapDriver(row, rides.get(row.id), now),
      // A driver with no position yet still has a profile worth showing.
      profile: { id: row.id, name: row.user.name, phone: row.user.phone, status: row.status },
      contacts: contacts.map(serialiseContact),
    });
  } catch (error) {
    fail(res, error, 'Could not load the driver');
  }
}

/** GET /admin/live/drivers/:id/trail?minutes=60 */
export async function handleLiveDriverTrailRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LiveMapDeps,
  driverId: string,
  url: URL,
): Promise<void> {
  if (!(await requireAdminName(req, res, deps))) return;
  try {
    const requested = Number.parseInt(url.searchParams.get('minutes') ?? '60', 10);
    const minutes = Math.min(Math.max(Number.isFinite(requested) ? requested : 60, 5), MAX_TRAIL_MINUTES);
    const points = await driverLocationClient.trail(driverId, new Date(Date.now() - minutes * 60_000));
    sendJson(res, 200, {
      driverId,
      minutes,
      points: points.map((point) => ({
        lat: point.lat,
        lng: point.lng,
        source: point.source,
        at: point.recordedAt.toISOString(),
      })),
    });
  } catch (error) {
    fail(res, error, 'Could not load the trail');
  }
}

/**
 * GET /admin/live/dispatch — rides nobody has taken, each with the drivers
 * closest to the pickup. Drivers on a trip or with a dead signal are left out:
 * there is no point ringing someone who cannot take it.
 */
export async function handleLiveDispatchRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LiveMapDeps,
): Promise<void> {
  if (!(await requireAdminName(req, res, deps))) return;
  try {
    const now = Date.now();
    const since = new Date(now - DISPATCH_LOOKBACK_MS);
    const [rides, drivers, contacts] = await Promise.all([
      driverLocationClient.unmatchedRides(since),
      loadMapDrivers(now),
      driverLocationClient.contactsSince(since),
    ]);

    // Only drivers who are cleared to drive: an unverified account can have a
    // position (they opened the app) but must never be offered a rider.
    const reachable = drivers.filter(
      (driver) => driver.kycStatus === 'APPROVED' && driver.phone && (driver.presence === 'online' || driver.presence === 'standby' || driver.presence === 'offline'),
    );

    sendJson(res, 200, {
      generatedAt: new Date(now).toISOString(),
      rides: rides.map((ride) => {
        const nearest = reachable
          .map((driver) => ({ driver, km: haversineKm(ride.pickupLat, ride.pickupLng, driver.lat, driver.lng) }))
          // Distance gates first, availability ranks second: an online driver in
          // another city must never outrank an off-shift one round the corner.
          .filter(({ km }) => km <= MAX_DISPATCH_KM)
          .sort((a, b) => rankPresence(a.driver.presence) - rankPresence(b.driver.presence) || a.km - b.km)
          .slice(0, NEAREST_PER_RIDE)
          .map(({ driver, km }) => ({
            id: driver.id,
            name: driver.name,
            phone: driver.phone,
            presence: driver.presence,
            vehicle: driver.vehicle,
            plate: driver.plate,
            distanceKm: Math.round(km * 10) / 10,
            etaMinutes: Math.round(estimateEtaSeconds(km) / 60),
            secondsSinceSeen: driver.secondsSinceSeen,
            contacts: contacts
              .filter((contact) => contact.driverId === driver.id && (contact.rideId === ride.id || contact.rideId === null))
              .slice(0, 3)
              .map(serialiseContact),
          }));
        return {
          id: ride.id,
          status: ride.status,
          pickupAddress: ride.pickupAddress,
          destAddress: ride.destAddress,
          pickupLat: ride.pickupLat,
          pickupLng: ride.pickupLng,
          offerNgn: ride.riderOfferNgn === null ? null : Number(ride.riderOfferNgn),
          estimateNgn: ride.fareEstimateNgn === null ? null : Number(ride.fareEstimateNgn),
          distanceKm: ride.distanceKm,
          bidCount: ride._count.bids,
          waitingSeconds: Math.max(0, Math.round((now - ride.createdAt.getTime()) / 1000)),
          nearest,
        };
      }),
    });
  } catch (error) {
    fail(res, error, 'Could not load dispatch');
  }
}

// Someone already on shift beats someone who has to be talked into going online,
// who in turn beats a last-known position that may be hours old.
function rankPresence(presence: Presence): number {
  return presence === 'online' ? 0 : presence === 'standby' ? 1 : 2;
}

/** POST /admin/live/drivers/:id/nudge  { rideId? } */
export async function handleLiveNudgeRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LiveMapDeps,
  driverId: string,
): Promise<void> {
  const adminName = await requireAdminName(req, res, deps);
  if (!adminName) return;
  try {
    const body = await readJsonBody(req).catch(() => null);
    const rideId = isRecord(body) && typeof body.rideId === 'string' && body.rideId ? body.rideId : null;

    const row = await driverLocationClient.findForMap(driverId);
    if (!row) {
      sendJson(res, 404, { error: 'Driver not found' });
      return;
    }
    if (row.status === 'ON_RIDE') {
      sendJson(res, 409, { error: 'This driver is on a trip.', code: 'ON_TRIP' });
      return;
    }

    // "Sent" must mean it can arrive. No registered phone → say so, and the
    // operator picks up the phone instead of waiting on a push that went nowhere.
    const devices = await userClient.listActiveNotificationDevices(row.userId);
    if (devices.length === 0) {
      sendJson(res, 409, {
        error: 'This driver has notifications off on their phone. Call them instead.',
        code: 'NO_PUSH_DEVICE',
      });
      return;
    }

    const lastNudge = await driverLocationClient.lastNudgeAt(driverId);
    if (lastNudge && Date.now() - lastNudge.getTime() < NUDGE_COOLDOWN_MS) {
      sendJson(res, 429, { error: 'This driver was nudged a moment ago. Give them a minute.', code: 'NUDGE_COOLDOWN' });
      return;
    }

    const alreadyOnline = row.status === 'ONLINE';
    await deps.publisher.publishNotificationEvent({
      eventType: 'PUSH_SEND',
      notificationId: randomUUID(),
      userId: row.userId,
      title: 'Ride request near you',
      body: alreadyOnline
        ? 'A rider close to you is waiting. Open Wheelers to send your offer.'
        : 'A rider close to you is waiting. Go online to take it.',
      data: { type: 'dispatch_nudge', ...(rideId ? { rideId } : {}) },
      priority: 'high',
      timestamp: new Date().toISOString(),
    });

    const contact = await driverLocationClient.logContact({
      driverId,
      rideId,
      adminName,
      kind: 'nudge',
      outcome: 'sent',
    });
    console.info('[live-map] nudge sent', { driverId, rideId, adminName });
    sendJson(res, 200, { ok: true, contact: serialiseContact(contact) });
  } catch (error) {
    fail(res, error, 'Could not send the nudge');
  }
}

/** POST /admin/live/drivers/:id/contacts  { rideId?, outcome, note? } */
export async function handleLiveContactRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LiveMapDeps,
  driverId: string,
): Promise<void> {
  const adminName = await requireAdminName(req, res, deps);
  if (!adminName) return;
  try {
    const body = await readJsonBody(req).catch(() => null);
    if (!isRecord(body) || typeof body.outcome !== 'string' || !CALL_OUTCOMES.has(body.outcome)) {
      sendJson(res, 400, { error: `outcome must be one of: ${[...CALL_OUTCOMES].join(', ')}` });
      return;
    }
    const row = await driverLocationClient.findForMap(driverId);
    if (!row) {
      sendJson(res, 404, { error: 'Driver not found' });
      return;
    }
    const contact = await driverLocationClient.logContact({
      driverId,
      rideId: typeof body.rideId === 'string' && body.rideId ? body.rideId : null,
      adminName,
      kind: 'call',
      outcome: body.outcome,
      note: typeof body.note === 'string' ? body.note.trim().slice(0, 500) || null : null,
    });
    sendJson(res, 200, { ok: true, contact: serialiseContact(contact) });
  } catch (error) {
    fail(res, error, 'Could not save the call');
  }
}

function serialiseContact(contact: {
  id: string;
  driverId: string;
  rideId: string | null;
  adminName: string;
  kind: string;
  outcome: string;
  note: string | null;
  createdAt: Date;
}) {
  return {
    id: contact.id,
    driverId: contact.driverId,
    rideId: contact.rideId,
    adminName: contact.adminName,
    kind: contact.kind,
    outcome: contact.outcome,
    note: contact.note,
    at: contact.createdAt.toISOString(),
  };
}

// ── Retention ────────────────────────────────────────────────────────────────

/**
 * Drop location history past its keep-by date. Runs once shortly after boot and
 * then daily; unref'd so it never holds the process open on shutdown.
 */
export function startLocationHistoryCleanup(days: number): void {
  const run = async () => {
    try {
      const removed = await driverLocationClient.pruneOlderThan(new Date(Date.now() - days * 86_400_000));
      if (removed > 0) console.info('[live-map] pruned location history', { removed, olderThanDays: days });
    } catch (error) {
      console.warn('[live-map] location history cleanup failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  setTimeout(run, 60_000).unref();
  setInterval(run, 24 * 60 * 60_000).unref();
}
