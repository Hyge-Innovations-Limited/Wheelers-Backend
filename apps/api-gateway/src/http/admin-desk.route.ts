import type { IncomingMessage, ServerResponse } from 'http';
import { prisma } from '@wheleers/db';
import { verifyAdminAuth } from './admin-auth.route';
import { sendJson } from './utils';
import { OUTCOME_FAILED, OUTCOME_OK } from '../analytics/user-outcomes';

/**
 * The support desk's look-ups: people, with the phone number and email to
 * reach them, and trips; nothing about money (wallets, fares, fees, deposit
 * accounts), bank details or identity documents. Anyone on the dashboard
 * may use them; they are all a SUPPORT login gets besides the inbox (where
 * it also messages people, /admin/support/people/:id/messages) and the
 * Activity page.
 *
 *   GET  /admin/desk/people?q=&role=&page=  everyone, newest first, 50 a page; or by name, phone, email or username
 *   GET  /admin/desk/people/:id             one person: who they are, their trips, what they tried in the app, their chats
 *   GET  /admin/desk/trips/:ref             one trip by WH-01234 or its id: who, where, when and how it ended
 *
 * Returns false when the path is not one of these.
 */
interface DeskDeps {
  jwtSecret: string;
  adminApiKey: string;
}

/** People per page of the list. */
const PAGE = 50;

const tripLabel = (n: number) => `WH-${String(n).padStart(5, '0')}`;
const LIVE = ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'];

export async function handleAdminDeskRoute(req: IncomingMessage, res: ServerResponse, deps: DeskDeps, url: URL): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/admin/desk/')) return false;

  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }

  if (path === '/admin/desk/people' && req.method === 'GET') {
    const q = (url.searchParams.get('q') ?? '').trim();
    const digits = q.replace(/\D/g, '');
    const roleWanted = url.searchParams.get('role');
    const page = Math.max(0, Number.parseInt(url.searchParams.get('page') ?? '0', 10) || 0);
    const byRole = roleWanted === 'drivers' ? { driver: { isNot: null } } : roleWanted === 'riders' ? { driver: { is: null } } : {};
    const byText = q.length < 2
      ? {}
      : {
          OR: [
            { name: { contains: q, mode: 'insensitive' as const } },
            { email: { contains: q, mode: 'insensitive' as const } },
            { username: { contains: q, mode: 'insensitive' as const } },
            // A number as people say it: 0708…, 708…, +234708…
            ...(digits.length >= 4 ? [{ phone: { contains: digits.replace(/^0/, '').replace(/^234/, '') } }] : []),
          ],
        };
    const where = { AND: [byRole, byText] };
    const [people, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: page * PAGE,
        take: PAGE,
        select: { id: true, name: true, role: true, phone: true, email: true, createdAt: true, driver: { select: { status: true, kycStatus: true } } },
      }),
      prisma.user.count({ where }),
    ]);
    sendJson(res, 200, {
      total,
      page,
      pageSize: PAGE,
      people: people.map((p) => ({
        id: p.id,
        name: p.name ?? 'No name yet',
        role: p.role,
        phone: p.phone,
        email: p.email,
        joinedAt: p.createdAt.toISOString(),
        driver: p.driver ? { online: p.driver.status !== 'OFFLINE', documents: p.driver.kycStatus } : null,
      })),
    });
    return true;
  }

  const personMatch = /^\/admin\/desk\/people\/([^/]+)$/.exec(path);
  if (personMatch && req.method === 'GET') {
    const id = personMatch[1]!;
    const person = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true, name: true, role: true, phone: true, email: true, createdAt: true,
        driver: { select: { id: true, status: true, kycStatus: true, vehicleMake: true, vehicleModel: true, vehiclePlate: true, rating: true } },
      },
    });
    if (!person) {
      sendJson(res, 404, { error: 'No such person' });
      return true;
    }
    const [rides, events, chats] = await Promise.all([
      prisma.ride.findMany({
        where: { OR: [{ riderId: id }, ...(person.driver ? [{ driverId: person.driver.id }] : [])] },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: tripSelect,
      }),
      prisma.userActivityEvent.findMany({
        where: { userId: id, eventType: { in: [OUTCOME_FAILED, OUTCOME_OK] } },
        orderBy: { createdAt: 'desc' },
        take: 40,
        select: { id: true, eventType: true, metadata: true, rideId: true, createdAt: true },
      }),
      prisma.supportConversation.findMany({
        where: { userId: id },
        orderBy: { lastMessageAt: 'desc' },
        take: 10,
        select: { id: true, status: true, topic: true, lastMessageAt: true, lastMessagePreview: true },
      }),
    ]);
    sendJson(res, 200, {
      person: {
        id: person.id,
        name: person.name ?? 'No name yet',
        role: person.role,
        phone: person.phone,
        email: person.email,
        joinedAt: person.createdAt.toISOString(),
      },
      driver: person.driver ? {
        online: person.driver.status !== 'OFFLINE',
        status: person.driver.status,
        documents: person.driver.kycStatus,
        car: [person.driver.vehicleMake, person.driver.vehicleModel].filter(Boolean).join(' ') || null,
        plate: person.driver.vehiclePlate,
        rating: person.driver.rating,
      } : null,
      trips: await withRiders(rides),
      activity: events.map((e) => {
        const meta = (e.metadata ?? {}) as Record<string, unknown>;
        const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
        return {
          id: e.id,
          at: e.createdAt.toISOString(),
          ok: e.eventType !== OUTCOME_FAILED,
          action: [text(meta.action) ?? 'Used the app', text(meta.detail)].filter(Boolean).join(': '),
          message: e.eventType === OUTCOME_FAILED ? text(meta.message) : null,
          rideId: e.rideId,
        };
      }),
      chats: chats.map((c) => ({
        id: c.id,
        status: c.status === 'OPEN' ? 'open' : 'resolved',
        topic: c.topic,
        lastMessageAt: c.lastMessageAt.toISOString(),
        lastMessagePreview: c.lastMessagePreview,
      })),
    });
    return true;
  }

  const tripMatch = /^\/admin\/desk\/trips\/([^/]+)$/.exec(path);
  if (tripMatch && req.method === 'GET') {
    const ref = decodeURIComponent(tripMatch[1]!).trim();
    const number = /^WH-?(\d+)$/i.exec(ref);
    const ride = number
      ? await prisma.ride.findUnique({ where: { tripNumber: Number(number[1]) }, select: tripSelect })
      : await prisma.ride.findUnique({ where: { id: ref }, select: tripSelect }).catch(() => null);
    if (!ride) {
      sendJson(res, 404, { error: 'No such trip' });
      return true;
    }
    sendJson(res, 200, { trip: (await withRiders([ride]))[0] });
    return true;
  }

  sendJson(res, 404, { error: 'Not found' });
  return true;
}

/** A trip as support sees it: no fare, no fees, no payment. */
const tripSelect = {
  id: true, tripNumber: true, status: true, channel: true,
  pickupAddress: true, destAddress: true, distanceKm: true,
  createdAt: true, matchedAt: true, arrivedAt: true, startedAt: true, completedAt: true, cancelledAt: true,
  cancelStage: true, cancelReason: true,
  riderId: true,
  driver: { select: { vehicleMake: true, vehicleModel: true, vehiclePlate: true, user: { select: { id: true, name: true } } } },
} as const;

type TripRow = {
  id: string; tripNumber: number; status: string; channel: string;
  pickupAddress: string; destAddress: string; distanceKm: number | null;
  createdAt: Date; matchedAt: Date | null; arrivedAt: Date | null; startedAt: Date | null; completedAt: Date | null; cancelledAt: Date | null;
  cancelStage: string | null; cancelReason: string | null;
  riderId: string;
  driver: { vehicleMake: string | null; vehicleModel: string | null; vehiclePlate: string | null; user: { id: string; name: string | null } } | null;
};

/** Trips with their riders' names (a ride keeps only the rider's id). */
async function withRiders(rows: TripRow[]) {
  const riders = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.riderId))] } }, select: { id: true, name: true } });
  const nameOf = new Map(riders.map((r) => [r.id, r.name]));
  return rows.map((r) => tripView(r, nameOf.get(r.riderId) ?? null));
}

function tripView(r: TripRow, riderName: string | null) {
  const at = (d: Date | null) => d?.toISOString() ?? null;
  return {
    id: r.id,
    trip: tripLabel(r.tripNumber),
    status: r.status,
    live: LIVE.includes(r.status),
    channel: r.channel,
    pickupAddress: r.pickupAddress,
    destAddress: r.destAddress,
    distanceKm: r.distanceKm,
    requestedAt: at(r.createdAt),
    driverFoundAt: at(r.matchedAt),
    arrivedAt: at(r.arrivedAt),
    startedAt: at(r.startedAt),
    completedAt: at(r.completedAt),
    cancelledAt: at(r.cancelledAt),
    cancelStage: r.cancelStage,
    cancelReason: r.cancelReason,
    rider: { id: r.riderId, name: riderName ?? 'No name yet' },
    driver: r.driver ? {
      id: r.driver.user.id,
      name: r.driver.user.name ?? 'No name yet',
      car: [r.driver.vehicleMake, r.driver.vehicleModel].filter(Boolean).join(' ') || null,
      plate: r.driver.vehiclePlate,
    } : null,
  };
}
