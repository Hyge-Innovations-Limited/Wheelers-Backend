/**
 * The WhatsApp booking page, live: a page open on a phone listens on its own
 * socket channel, and after every ride or wallet event for that rider the
 * server sends it the page's whole state (the same answer as GET
 * /ride-page/state), so an offer shows the moment it exists, with no second
 * request. The page's 3s poll stays as the backup.
 *
 * Its own channel, not the rider's id: "the rider has a socket" means an app
 * rider to the consumer, and a WhatsApp rider must stay a WhatsApp rider.
 */
import type { SocketRegistry } from '../websocket/registry';

export const RIDE_PAGE_STATE_EVENT = 'ride-page:state';

export function ridePageChannel(riderId: string): string {
  return `ride-page:${riderId}`;
}

type StateBuilder = (riderId: string) => Promise<Record<string, unknown>>;
/** Set once at start-up by the ride-page route (it owns what the page is shown). */
let buildState: StateBuilder | undefined;
export function setRidePageStateBuilder(builder: StateBuilder | undefined): void {
  buildState = builder;
}

/** Sends the rider's open page its state now; nothing when no page listens. Never throws. */
export async function tellRidePage(registry: Pick<SocketRegistry, 'isUserConnected' | 'sendToUser'>, riderId: string): Promise<void> {
  if (!buildState) return;
  try {
    const channel = ridePageChannel(riderId);
    if (!(await registry.isUserConnected(channel))) return;
    await registry.sendToUser(channel, RIDE_PAGE_STATE_EVENT, await buildState(riderId));
  } catch {
    // The poll brings it a moment later.
  }
}
