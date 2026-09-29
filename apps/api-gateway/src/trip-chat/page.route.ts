import type { IncomingMessage, ServerResponse } from 'http';
import { verifyWalletPageToken } from '../auth/local';
import { extractBearerToken } from '../http/authenticate';
import { readJsonBody, sendJson } from '../http/utils';
import { isRecord } from '../utils/object';
import { TripChatError } from './errors';
import type { TripChatService } from './service';

/**
 * The WhatsApp rider's Trip chat page (widget/trip/chat.html), over HTTP.
 * The page opens a socket with the same link for everything live: messages as
 * they arrive, and calls. These two are for opening, and for when a socket
 * cannot be had:
 *
 *   GET  /trip-chat/state   the trip, who they are talking to, the messages, any call ringing
 *   POST /trip-chat/send    { content }  a message
 */

export interface TripChatPageRouteDeps {
  jwtSecret: string;
  tripChat: TripChatService;
}

class LinkError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

function authenticate(req: IncomingMessage, deps: TripChatPageRouteDeps): { userId: string; rideId: string } {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) throw new LinkError('This link is not valid. Tap the button in your ride message again.', 401, 'LINK_INVALID');
  let session;
  try {
    session = verifyWalletPageToken(token, deps.jwtSecret);
  } catch {
    throw new LinkError('This link has expired. Tap Chat or call driver on your ride message for a new one.', 401, 'LINK_EXPIRED');
  }
  if (session.scope !== 'trip' || !session.rideId) throw new LinkError('This link cannot be used for that.', 403, 'LINK_WRONG_SCOPE');
  return { userId: session.userId, rideId: session.rideId };
}

async function handleState(req: IncomingMessage, res: ServerResponse, deps: TripChatPageRouteDeps): Promise<void> {
  const { userId, rideId } = authenticate(req, deps);
  const [state, current] = await Promise.all([
    deps.tripChat.history(rideId, userId),
    deps.tripChat.calls.current({ rideId, userId }).catch(() => ({ call: null })),
  ]);
  if (state.open) void deps.tripChat.pageOpened(rideId);
  sendJson(res, 200, { ...state, call: current.call });
}

async function handleSend(req: IncomingMessage, res: ServerResponse, deps: TripChatPageRouteDeps): Promise<void> {
  const { userId, rideId } = authenticate(req, deps);
  const body = await readJsonBody(req).catch(() => null);
  const message = await deps.tripChat.sendMessage({ rideId, userId, content: isRecord(body) ? body['content'] : '' });
  sendJson(res, 200, { message });
}

const ROUTES: Record<string, { method: 'GET' | 'POST'; run: (req: IncomingMessage, res: ServerResponse, deps: TripChatPageRouteDeps) => Promise<void> }> = {
  '/trip-chat/state': { method: 'GET', run: handleState },
  '/trip-chat/send': { method: 'POST', run: handleSend },
};

/** Every /trip-chat/* request. Returns false when the path is not ours. */
export async function handleTripChatPageRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TripChatPageRouteDeps,
  url: URL,
): Promise<boolean> {
  const route = ROUTES[url.pathname];
  if (!route) return false;
  if (req.method !== route.method) {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }
  // Messages between two people: never cached.
  res.setHeader('Cache-Control', 'no-store');
  try {
    await route.run(req, res, deps);
  } catch (error) {
    if (error instanceof LinkError || error instanceof TripChatError) {
      sendJson(res, error.status, { error: error.message, code: error.code });
    } else {
      console.error('[trip-chat] page request failed', { path: url.pathname, error: error instanceof Error ? error.message : String(error) });
      sendJson(res, 500, { error: 'Something went wrong on our side. Please try again.', code: 'INTERNAL' });
    }
  }
  return true;
}
