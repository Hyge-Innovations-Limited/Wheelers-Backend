import { Prisma } from '@prisma/client';
import { formatTripId } from '@wheleers/config';
import { prisma } from '../prisma';

/**
 * Admin chat history (Timi, 4 Nov 2026): everything a rider did with Wheelers,
 * in order, like a chat. Their WhatsApp chat with the bot (both sides, word for
 * word from 4 Nov; earlier bot turns are what was kept then), their trips'
 * chats and calls with the driver, support chats, what they tapped on the
 * booking page, and each trip's moments. Kept for good.
 */

export type ChatWho = 'rider' | 'bot' | 'driver' | 'support' | 'system';
export type ChatSource = 'whatsapp' | 'trip_chat' | 'call' | 'support' | 'page' | 'trip';

export interface ChatItem {
  at: string;
  who: ChatWho;
  source: ChatSource;
  /** text, tap, form, buttons, list, link, image, reaction, template, location, call, milestone, page … */
  kind: string;
  text: string;
  rideId?: string | null;
  tripId?: string | null;
}

const MAX_PAGE = 300;
const clampLimit = (n: number | undefined) => Math.min(Math.max(1, Math.floor(n ?? 150)), MAX_PAGE);
const naira = (n: unknown) => (n == null ? null : `₦${Number(n).toLocaleString('en-NG', { maximumFractionDigits: 0 })}`);
const minutesSeconds = (s: number | null | undefined) => (s == null ? '' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);

/** The booking page's own event names, as words; the ones that are only the page's own state are left out. */
const PAGE_WORDS: Record<string, string> = {
  page_opened: 'Opened the booking page',
  find_tapped: 'Tapped Find a driver',
  accept_tapped: 'Tapped Accept on an offer',
  cancel_confirmed: 'Cancelled on the booking page',
  price_changed: 'Changed the price',
};
const PAGE_SKIP = new Set(['phase_shown', 'offer_received', 'heartbeat']);

function pageText(event: string, props: unknown): string {
  const p = (props && typeof props === 'object' ? props : {}) as Record<string, unknown>;
  const price = p['priceNgn'] ?? p['amountNgn'] ?? p['fareNgn'];
  const base = PAGE_WORDS[event] ?? event.replace(/_/g, ' ');
  return price != null && Number.isFinite(Number(price)) ? `${base}: ${naira(price)}` : base;
}

type RideRow = {
  id: string; tripNumber: number; riderId: string; driverId: string | null; status: string;
  pickupAddress: string; destAddress: string; agreedFareNgn: Prisma.Decimal | null;
  createdAt: Date; matchedAt: Date | null; arrivedAt: Date | null; startedAt: Date | null; completedAt: Date | null; cancelledAt: Date | null; cancelReason: string | null;
};

/** A trip's moments, as lines in the chat: a divider when it was asked for, then each step. */
function milestones(ride: RideRow, driverName: string | null): ChatItem[] {
  const tripId = formatTripId(ride.tripNumber);
  const base = { source: 'trip' as const, who: 'system' as const, rideId: ride.id, tripId };
  const items: ChatItem[] = [
    { ...base, at: ride.createdAt.toISOString(), kind: 'trip', text: `${tripId ?? 'Trip'} · ${ride.pickupAddress} → ${ride.destAddress}${ride.agreedFareNgn ? ` · ${naira(ride.agreedFareNgn)}` : ''} · ${ride.status.toLowerCase().replace(/_/g, ' ')}` },
  ];
  if (ride.matchedAt) items.push({ ...base, at: ride.matchedAt.toISOString(), kind: 'milestone', text: `Driver accepted${driverName ? `: ${driverName}` : ''}` });
  if (ride.arrivedAt) items.push({ ...base, at: ride.arrivedAt.toISOString(), kind: 'milestone', text: 'Driver arrived' });
  if (ride.startedAt) items.push({ ...base, at: ride.startedAt.toISOString(), kind: 'milestone', text: 'Trip started' });
  if (ride.completedAt) items.push({ ...base, at: ride.completedAt.toISOString(), kind: 'milestone', text: 'Trip completed' });
  if (ride.cancelledAt) items.push({ ...base, at: ride.cancelledAt.toISOString(), kind: 'milestone', text: `Cancelled${ride.cancelReason ? `: ${ride.cancelReason}` : ''}` });
  return items;
}

const RIDE_SELECT = {
  id: true, tripNumber: true, riderId: true, driverId: true, status: true, pickupAddress: true, destAddress: true, agreedFareNgn: true,
  createdAt: true, matchedAt: true, arrivedAt: true, startedAt: true, completedAt: true, cancelledAt: true, cancelReason: true,
} as const;

async function driverNames(driverIds: string[]): Promise<Map<string, { name: string | null; userId: string }>> {
  if (!driverIds.length) return new Map();
  const rows = await prisma.driver.findMany({ where: { id: { in: driverIds } }, select: { id: true, userId: true, user: { select: { name: true } } } });
  return new Map(rows.map((d) => [d.id, { name: d.user?.name ?? null, userId: d.userId }]));
}

/** Everything in [from, before) for one person, newest `limit` first, then returned oldest-first. */
async function collect(userId: string, window: { from?: Date; before: Date }, limit: number, onlyRideIds?: string[]): Promise<ChatItem[]> {
  const time = { lt: window.before, ...(window.from ? { gte: window.from } : {}) };
  const rideWhere = onlyRideIds ? { id: { in: onlyRideIds } } : { OR: [{ riderId: userId }, { driver: { userId } }] };
  const rides = (await prisma.ride.findMany({ where: { ...rideWhere }, select: RIDE_SELECT, orderBy: { createdAt: 'desc' }, take: 500 })) as RideRow[];
  const rideIds = rides.map((r) => r.id);
  const tripOf = new Map(rides.map((r) => [r.id, formatTripId(r.tripNumber)]));
  const drivers = await driverNames([...new Set(rides.map((r) => r.driverId).filter((id): id is string => Boolean(id)))]);

  const [wa, chat, calls, support, page] = await Promise.all([
    prisma.whatsappMessage.findMany({ where: { userId, createdAt: time }, orderBy: { createdAt: 'desc' }, take: limit, select: { role: true, content: true, kind: true, createdAt: true } }),
    rideIds.length ? prisma.chatMessage.findMany({ where: { rideId: { in: rideIds }, createdAt: time }, orderBy: { createdAt: 'desc' }, take: limit, select: { rideId: true, senderRole: true, content: true, kind: true, createdAt: true } }) : [],
    rideIds.length ? prisma.tripCall.findMany({ where: { rideId: { in: rideIds }, createdAt: time }, orderBy: { createdAt: 'desc' }, take: limit, select: { rideId: true, callerRole: true, status: true, durationSeconds: true, calleeChannel: true, createdAt: true } }) : [],
    prisma.supportMessage.findMany({ where: { conversation: { userId, ...(onlyRideIds ? { rideId: { in: onlyRideIds } } : {}) }, createdAt: time }, orderBy: { createdAt: 'desc' }, take: limit, select: { sender: true, senderName: true, content: true, createdAt: true, conversation: { select: { rideId: true } } } }),
    prisma.ridePageEvent.findMany({ where: { userId, createdAt: time, ...(onlyRideIds ? { OR: [{ rideId: { in: onlyRideIds } }, { rideId: null }] } : {}) }, orderBy: { createdAt: 'desc' }, take: limit, select: { event: true, props: true, rideId: true, createdAt: true } }),
  ]);

  const items: ChatItem[] = [
    ...wa.map((m) => ({ at: m.createdAt.toISOString(), who: (m.role === 'user' ? 'rider' : 'bot') as ChatWho, source: 'whatsapp' as const, kind: m.kind, text: m.content })),
    ...chat.map((m) => ({ at: m.createdAt.toISOString(), who: (m.senderRole === 'DRIVER' ? 'driver' : 'rider') as ChatWho, source: 'trip_chat' as const, kind: m.kind === 'call' ? 'call' : 'text', text: m.content, rideId: m.rideId, tripId: tripOf.get(m.rideId) ?? null })),
    ...calls.map((c) => ({
      at: c.createdAt.toISOString(), who: (c.callerRole === 'DRIVER' ? 'driver' : 'rider') as ChatWho, source: 'call' as const, kind: 'call',
      text: `${c.callerRole === 'DRIVER' ? 'Driver' : 'Rider'} called · ${c.status.toLowerCase()}${c.durationSeconds ? ` · ${minutesSeconds(c.durationSeconds)}` : ''}${c.calleeChannel === 'whatsapp' ? ' · answered from WhatsApp link' : ''}`,
      rideId: c.rideId, tripId: tripOf.get(c.rideId) ?? null,
    })),
    ...support.map((m) => ({ at: m.createdAt.toISOString(), who: (String(m.sender) === 'USER' ? 'rider' : 'support') as ChatWho, source: 'support' as const, kind: 'text', text: String(m.sender) === 'USER' ? m.content : `${m.senderName ? `${m.senderName}: ` : ''}${m.content}`, rideId: m.conversation.rideId })),
    ...page.filter((e) => !PAGE_SKIP.has(e.event)).map((e) => ({ at: e.createdAt.toISOString(), who: 'rider' as const, source: 'page' as const, kind: 'page', text: pageText(e.event, e.props), rideId: e.rideId, tripId: e.rideId ? tripOf.get(e.rideId) ?? null : null })),
    ...rides.flatMap((r) => milestones(r, r.driverId ? drivers.get(r.driverId)?.name ?? null : null)).filter((m) => {
      const at = new Date(m.at).getTime();
      return at < window.before.getTime() && (!window.from || at >= window.from.getTime());
    }),
  ];
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit).reverse();
}

export const adminChatClient = {
  /** Riders and drivers by their latest activity (a message, or a trip), with the last thing said. */
  async listPeople(input: { q?: string | null; limit?: number; offset?: number }) {
    const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 50)), 200);
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const q = (input.q ?? '').trim();
    const like = `%${q}%`;
    const rows = await prisma.$queryRaw<Array<{ id: string; name: string | null; phone: string | null; last_at: Date | null; messages: number; trips: number; last_text: string | null; total: bigint | number }>>`
      WITH last_msg AS (SELECT "userId", max("createdAt") AS at, count(*)::int AS n FROM "WhatsappMessage" GROUP BY "userId"),
           last_ride AS (SELECT "riderId" AS "userId", max("createdAt") AS at, count(*)::int AS n FROM "Ride" GROUP BY "riderId")
      SELECT u.id, u.name, u.phone, greatest(lm.at, lr.at) AS last_at, coalesce(lm.n, 0) AS messages, coalesce(lr.n, 0) AS trips,
             (SELECT w.content FROM "WhatsappMessage" w WHERE w."userId" = u.id ORDER BY w."createdAt" DESC LIMIT 1) AS last_text,
             count(*) OVER () AS total
      FROM "User" u
      LEFT JOIN last_msg lm ON lm."userId" = u.id
      LEFT JOIN last_ride lr ON lr."userId" = u.id
      WHERE (lm.at IS NOT NULL OR lr.at IS NOT NULL)
        ${q ? Prisma.sql`AND (u.name ILIKE ${like} OR u.phone ILIKE ${like} OR u.id = ${q})` : Prisma.empty}
      ORDER BY greatest(lm.at, lr.at) DESC NULLS LAST, u.id
      LIMIT ${limit} OFFSET ${offset}`;
    return {
      total: rows.length ? Number(rows[0]!.total) : 0,
      items: rows.map((r) => ({ userId: r.id, name: r.name, phone: r.phone, lastAt: r.last_at?.toISOString() ?? null, messages: r.messages, trips: r.trips, lastText: r.last_text })),
    };
  },

  /** Trips newest first, with who was in them and how much was said. */
  async listTrips(input: { q?: string | null; limit?: number; offset?: number }) {
    const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 50)), 200);
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const q = (input.q ?? '').trim();
    const like = `%${q}%`;
    const tripNumber = /^(?:WH-?)?0*(\d{1,9})$/i.exec(q)?.[1];
    const rows = await prisma.$queryRaw<Array<{ id: string; trip_number: number; status: string; created_at: Date; pickup: string; dest: string; fare: Prisma.Decimal | null; rider_id: string; rider_name: string | null; rider_phone: string | null; driver_name: string | null; driver_phone: string | null; chats: number; calls: number; total: bigint | number }>>`
      SELECT r.id, r."tripNumber" AS trip_number, r.status::text AS status, r."createdAt" AS created_at, r."pickupAddress" AS pickup, r."destAddress" AS dest, r."agreedFareNgn" AS fare,
             r."riderId" AS rider_id, ru.name AS rider_name, ru.phone AS rider_phone, du.name AS driver_name, du.phone AS driver_phone,
             (SELECT count(*)::int FROM "ChatMessage" c WHERE c."rideId" = r.id) AS chats,
             (SELECT count(*)::int FROM "TripCall" t WHERE t."rideId" = r.id) AS calls,
             count(*) OVER () AS total
      FROM "Ride" r
      LEFT JOIN "User" ru ON ru.id = r."riderId"
      LEFT JOIN "Driver" d ON d.id = r."driverId"
      LEFT JOIN "User" du ON du.id = d."userId"
      WHERE TRUE
        ${q ? Prisma.sql`AND (r.id = ${q} ${tripNumber ? Prisma.sql`OR r."tripNumber" = ${Number(tripNumber)}` : Prisma.empty}
          OR ru.name ILIKE ${like} OR ru.phone ILIKE ${like} OR du.name ILIKE ${like} OR du.phone ILIKE ${like})` : Prisma.empty}
      ORDER BY r."createdAt" DESC, r.id
      LIMIT ${limit} OFFSET ${offset}`;
    return {
      total: rows.length ? Number(rows[0]!.total) : 0,
      items: rows.map((r) => ({
        rideId: r.id, tripId: formatTripId(r.trip_number), status: r.status, createdAt: r.created_at.toISOString(), pickup: r.pickup, dest: r.dest,
        fareNgn: r.fare == null ? null : Number(r.fare), riderId: r.rider_id, riderName: r.rider_name, riderPhone: r.rider_phone,
        driverName: r.driver_name, driverPhone: r.driver_phone, chats: r.chats, calls: r.calls,
      })),
    };
  },

  /** One person's whole history, a page at a time going back: `before` is the oldest item already shown. */
  async forUser(userId: string, input: { before?: Date | null; limit?: number }) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, phone: true, role: true, createdAt: true } });
    if (!user) return null;
    const limit = clampLimit(input.limit);
    const items = await collect(userId, { before: input.before ?? new Date(Date.now() + 60_000) }, limit);
    return { user: { userId: user.id, name: user.name, phone: user.phone, joinedAt: user.createdAt.toISOString() }, items, olderBefore: items.length === limit ? items[0]!.at : null };
  },

  /** One trip: the rider's chat from 30 minutes before it was asked for to 30 minutes after it ended, its driver chat and calls. */
  async forRide(rideId: string) {
    const ride = (await prisma.ride.findUnique({ where: { id: rideId }, select: RIDE_SELECT })) as RideRow | null;
    if (!ride) return null;
    const [rider, drivers] = await Promise.all([
      prisma.user.findUnique({ where: { id: ride.riderId }, select: { id: true, name: true, phone: true } }),
      driverNames(ride.driverId ? [ride.driverId] : []),
    ]);
    const end = ride.completedAt ?? ride.cancelledAt ?? new Date();
    const window = { from: new Date(ride.createdAt.getTime() - 30 * 60_000), before: new Date(end.getTime() + 30 * 60_000) };
    const items = await collect(ride.riderId, window, MAX_PAGE, [ride.id]);
    const driver = ride.driverId ? drivers.get(ride.driverId) : undefined;
    return {
      ride: { rideId: ride.id, tripId: formatTripId(ride.tripNumber), status: ride.status, pickup: ride.pickupAddress, dest: ride.destAddress, fareNgn: ride.agreedFareNgn == null ? null : Number(ride.agreedFareNgn), createdAt: ride.createdAt.toISOString(), endedAt: ride.completedAt?.toISOString() ?? ride.cancelledAt?.toISOString() ?? null },
      rider: rider ? { userId: rider.id, name: rider.name, phone: rider.phone } : null,
      driver: driver ? { userId: driver.userId, name: driver.name } : null,
      items,
    };
  },
};
