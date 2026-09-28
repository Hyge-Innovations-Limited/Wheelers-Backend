import type { IncomingMessage, ServerResponse } from 'http';
import { chatClient, rideClient } from '@wheleers/db';
import { authenticateHttpUser } from './authenticate';
import { chatWindow } from '../trip-chat/access';
import { sendJson } from './utils';

interface ChatRouteDeps {
  jwtSecret: string;
  /** Live call is on: the apps show their Call button. */
  liveCallEnabled?: boolean;
}

export function handleGetRideChatMessagesRoute(deps: ChatRouteDeps) {
  return async (req: IncomingMessage, res: ServerResponse, params: { rideId: string }) => {
    let user;
    try {
      user = await authenticateHttpUser(req, deps.jwtSecret);
    } catch {
      return sendJson(res, 401, { error: 'Unauthorized' });
    }

    const { rideId } = params;

    // Verify the user is a participant in this ride
    let ride;
    try {
      ride = await rideClient.findWithDriver(rideId);
    } catch {
      return sendJson(res, 404, { error: 'Ride not found' });
    }

    const isRider = ride.riderId === user.id;
    const isDriver = ride.driver?.user?.id === user.id;
    if (!isRider && !isDriver) {
      return sendJson(res, 403, { error: 'You are not a participant in this ride' });
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const cursor = url.searchParams.get('cursor') ?? undefined;

    // No cursor: the LATEST messages, which is what a chat screen opens on. It
    // used to return the first 50, so a long chat opened on its oldest lines.
    const result = cursor
      ? await chatClient.findByRideId({ rideId, limit, cursor })
      : { items: await chatClient.latestForRide(rideId, limit), nextCursor: null };
    const window = chatWindow(ride);

    return sendJson(res, 200, {
      items: result.items.map((msg) => ({
        id: msg.id,
        rideId: msg.rideId,
        senderId: msg.senderId,
        senderRole: msg.senderRole,
        content: msg.content,
        kind: msg.kind === 'call' ? 'call' : 'text',
        createdAt: msg.createdAt.toISOString(),
      })),
      nextCursor: result.nextCursor,
      // Whether the chat still takes messages, and until when (30 minutes after the trip).
      open: window.open,
      closesAt: window.closesAt ? window.closesAt.toISOString() : null,
      callsEnabled: deps.liveCallEnabled === true,
    });
  };
}
