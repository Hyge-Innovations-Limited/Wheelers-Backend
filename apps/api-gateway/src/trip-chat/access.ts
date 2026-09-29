import { chatClient } from '@wheleers/db';
import { formatTripId } from '@wheleers/config';
import { TripChatError } from './errors';

/**
 * Who may chat and call on a ride, and when.
 *
 * Only the ride's rider and its driver, from the moment a driver is assigned,
 * through arriving, pickup and the trip. It closes when the trip ends or is
 * cancelled. TRIP_CHAT_AFTER_TRIP_MINUTES keeps it open a while longer (for
 * "I left my bag in the car") without a code change; it is 0 by default:
 * lost items go to support.
 */

export const LIVE_TRIP_STATUSES: ReadonlySet<string> = new Set(['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS']);
export const CHAT_AFTER_TRIP_MS = Math.max(0, Number(process.env.TRIP_CHAT_AFTER_TRIP_MINUTES ?? 0) || 0) * 60 * 1000;

export type TripRole = 'RIDER' | 'DRIVER';

export interface TripParty {
  userId: string;
  name: string;
  firstName: string;
  phone: string | null;
}

export interface TripChatInfo {
  rideId: string;
  tripId: string | null;
  status: string;
  channel: string;
  rider: TripParty;
  driver: TripParty | null;
  /** The driver's car, so a rider knows what to look for: "Toyota Corolla", "KJA-123AB". */
  vehicle: { label: string; plate: string } | null;
  open: boolean;
  /** When the chat closes, once the trip is over. Null while it is live, or when it never opened. */
  closesAt: Date | null;
}

interface WindowInput {
  status: string;
  driverId: string | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  updatedAt: Date;
}

/** Is the chat open on this ride right now, and until when? */
export function chatWindow(
  ride: WindowInput,
  now: number = Date.now(),
  afterTripMs: number = CHAT_AFTER_TRIP_MS,
): { open: boolean; closesAt: Date | null } {
  if (!ride.driverId) return { open: false, closesAt: null };
  if (LIVE_TRIP_STATUSES.has(ride.status)) return { open: true, closesAt: null };
  let endedAt: Date | null = null;
  if (ride.status === 'COMPLETED' || ride.status === 'DISPUTED') endedAt = ride.completedAt ?? ride.updatedAt;
  if (ride.status === 'CANCELLED') endedAt = ride.cancelledAt ?? ride.updatedAt;
  if (!endedAt) return { open: false, closesAt: null };
  const closesAt = new Date(endedAt.getTime() + afterTripMs);
  return { open: now < closesAt.getTime(), closesAt };
}

function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

function party(user: { id: string; name: string | null; phone: string | null } | null | undefined, fallback: string): TripParty | null {
  if (!user) return null;
  const name = user.name?.trim() || fallback;
  return { userId: user.id, name, firstName: firstNameOf(name), phone: user.phone ?? null };
}

export async function loadTripChat(rideId: string, now: number = Date.now()): Promise<TripChatInfo | null> {
  if (!rideId) return null;
  const ride = await chatClient.tripParties(rideId).catch(() => null);
  if (!ride) return null;
  const rider = party(ride.rider, 'Your rider');
  if (!rider) return null;
  const window = chatWindow(ride, now);
  return {
    rideId: ride.id,
    tripId: formatTripId(ride.tripNumber),
    status: ride.status,
    channel: ride.channel,
    rider,
    driver: party(ride.driver?.user, 'Your driver'),
    vehicle: ride.driver
      ? { label: [ride.driver.vehicleMake, ride.driver.vehicleModel].filter(Boolean).join(' '), plate: ride.driver.vehiclePlate ?? '' }
      : null,
    open: window.open,
    closesAt: window.closesAt,
  };
}

export function roleOf(info: TripChatInfo, userId: string): TripRole | null {
  if (info.rider.userId === userId) return 'RIDER';
  if (info.driver && info.driver.userId === userId) return 'DRIVER';
  return null;
}

export function otherParty(info: TripChatInfo, role: TripRole): TripParty | null {
  return role === 'RIDER' ? info.driver : info.rider;
}

/**
 * The ride, and this person's place on it — or the reason they have none.
 * Someone who is not on the ride is told only that: whether it exists is not theirs to learn.
 */
export async function requireTripParticipant(
  rideId: string,
  userId: string,
): Promise<{ info: TripChatInfo; role: TripRole; other: TripParty }> {
  const info = await loadTripChat(rideId);
  const role = info ? roleOf(info, userId) : null;
  const other = info && role ? otherParty(info, role) : null;
  if (!info || !role || !other) throw new TripChatError('NOT_ON_TRIP', 'This chat is only for the rider and driver of this trip.');
  return { info, role, other };
}

export function requireOpen(info: TripChatInfo): void {
  if (!info.open) {
    throw new TripChatError('CHAT_CLOSED', info.closesAt
      ? 'This trip has ended, so the chat is closed.'
      : 'This chat opens when a driver is assigned to the trip.');
  }
}
