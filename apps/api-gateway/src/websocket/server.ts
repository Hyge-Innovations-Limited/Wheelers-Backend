import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Duplex } from 'stream';
import WebSocket, { Server as WebSocketServer } from 'ws';
import { driverClient, driverPresence, userClient } from '@wheleers/db';
import type { GoogleMapsRoutePlanner } from '@wheleers/config';
import { buildGatewayAuthContext } from '../auth/context';
import { verifyLocalAccessToken, verifyWalletPageToken } from '../auth/local';
import type { GatewayAuthContext, InboundWsMessage } from '../types';
import { isRecord } from '../utils/object';
import { handleDriverMessage } from './handlers/driver.handler';
import { handleRideMessage } from './handlers/ride.handler';
import { handleWalletMessage } from './handlers/wallet.handler';
import type { RedisClient } from '../redis/client';
import { createDriverOfflineGrace, withdrawDriverFromMarket } from './driver-offline-grace';
import { resyncDriverActiveRide } from './driver-ride-sync';
import type { GatewayPublisher } from './publisher';
import { createRateLimiter } from './rate-limit';
import { SocketRegistry } from './registry';

interface WebSocketServerDeps {
  server: HttpServer;
  jwtSecret: string;
  allowedOrigins: Set<string>;
  idleTimeoutMs: number;
  registry: SocketRegistry;
  publisher: GatewayPublisher;
  routePlanner: GoogleMapsRoutePlanner;
  redis: RedisClient;
  /** A larger message closes the socket (code 1009). */
  maxPayloadBytes?: number;
  /** Messages a second each socket may send, and the burst allowed on top. */
  rateLimitPerSecond?: number;
  rateLimitBurst?: number;
  /** Sign-ins in flight at once before new ones are told to come back. */
  maxPendingUpgrades?: number;
  /** Log every connect, close and message. Off, there is one summary line a minute. */
  verboseLog?: boolean;
  /** Trip chat and Live call. Asked first about every message; answers only its own. */
  tripChat?: {
    handleWsMessage(
      type: string,
      payload: Record<string, unknown>,
      auth: GatewayAuthContext,
    ): Promise<{ type: string; payload: Record<string, unknown> } | null>;
  };
  /**
   * Where our own pages are served (APP_BASE_URL). A Trip chat page's socket
   * comes from there, and is let in on its link even if CORS_ORIGINS forgot it.
   */
  pageOrigins?: Set<string>;
}

/** The type of the message that failed, when it can be read: errors name the request they answer. */
function requestTypeOf(raw: WebSocket.RawData): string | null {
  try {
    const parsed = JSON.parse(raw.toString()) as { type?: unknown };
    return typeof parsed?.type === 'string' ? parsed.type : null;
  } catch {
    return null;
  }
}

/** A socket that keeps sending past its limit this many times is closed. */
const RATE_LIMIT_STRIKES_BEFORE_CLOSE = 200;

function getRequestOrigin(request: IncomingMessage): string | null {
  const origin = request.headers.origin;
  return typeof origin === 'string' ? origin : null;
}

function extractBearerToken(value: string | undefined): string | null {
  if (!value) return null;

  const [scheme, token] = value.split(' ');
  if (!scheme || !token) return null;

  if (scheme.toLowerCase() !== 'bearer') return null;
  return token;
}

function getConnectionToken(request: IncomingMessage, params: URLSearchParams): string | null {
  const headerToken = extractBearerToken(
    typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined,
  );

  if (headerToken) return headerToken;

  const queryToken = params.get('accessToken') ?? params.get('token');
  if (queryToken && queryToken.trim().length > 0) {
    return queryToken;
  }

  return null;
}

function rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function getRequestLogContext(request: IncomingMessage, origin: string | null): Record<string, string | null> {
  return {
    origin,
    remoteAddress: request.socket.remoteAddress ?? null,
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
  };
}

export function createGatewayWebSocketServer(deps: WebSocketServerDeps): { stats: () => Record<string, number> } {
  // The default was 100 MiB a message. Nothing the apps send is near a
  // thousandth of that; a socket that tries is closed.
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: deps.maxPayloadBytes ?? 128 * 1024 });
  const verbose = deps.verboseLog === true;
  const maxPendingUpgrades = deps.maxPendingUpgrades ?? 400;
  const grace = createDriverOfflineGrace({ redis: deps.redis, registry: deps.registry, publisher: deps.publisher, verbose });
  grace.start();

  // What happened in the last minute, in one line, instead of a line per event.
  const counts = { opened: 0, closed: 0, messages: 0, rateLimited: 0, refusedBusy: 0, refusedAuth: 0 };
  let pendingUpgrades = 0;
  const summary = setInterval(() => {
    if (counts.opened + counts.closed + counts.messages + counts.rateLimited + counts.refusedBusy === 0 && deps.registry.connectionCount === 0) return;
    console.info('[ws] last minute', { open: deps.registry.connectionCount, ...counts });
    counts.opened = counts.closed = counts.messages = counts.rateLimited = counts.refusedBusy = counts.refusedAuth = 0;
  }, 60_000);
  summary.unref?.();

  deps.server.on('upgrade', (request, socket, head) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const requestOrigin = getRequestOrigin(request);
      if (url.pathname !== '/ws') {
        console.warn('[ws] reject: unsupported path', {
          path: url.pathname,
          ...getRequestLogContext(request, requestOrigin),
        });
        rejectUpgrade(socket, 404, 'Not Found');
        return;
      }

      const token = getConnectionToken(request, url.searchParams);
      if (!token) {
        console.warn('[ws] reject: missing access token', getRequestLogContext(request, requestOrigin));
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }

      // Every sign-in costs database reads. After a restart thousands arrive
      // at once; past this many in flight, the rest are told to come back,
      // and the apps do, a little later each time. The token is checked first:
      // that costs nothing, and a bad one should hear 401, not "busy".
      let tokenSubject: string;
      // A Trip chat page signs in with its link, not a login: that socket may
      // only chat and call, and only on the ride its link names.
      let pageRideId: string | null = null;
      try {
        tokenSubject = verifyLocalAccessToken(token, deps.jwtSecret).sub;
      } catch (error) {
        const page = (() => {
          try {
            return verifyWalletPageToken(token, deps.jwtSecret);
          } catch {
            return null;
          }
        })();
        if (!page || page.scope !== 'trip' || !page.rideId) {
          counts.refusedAuth += 1;
          const message = error instanceof Error ? error.message : 'Invalid auth token';
          if (verbose) console.warn('[ws] reject: invalid access token', { message, ...getRequestLogContext(request, requestOrigin) });
          rejectUpgrade(socket, 401, message);
          return;
        }
        tokenSubject = page.userId;
        pageRideId = page.rideId;
      }

      const originAllowed =
        deps.allowedOrigins.size === 0 ||
        !requestOrigin ||
        deps.allowedOrigins.has(requestOrigin) ||
        (pageRideId !== null && (deps.pageOrigins?.has(requestOrigin) ?? false));
      if (!originAllowed) {
        console.warn('[ws] reject: origin not allowed', {
          allowedOrigins: Array.from(deps.allowedOrigins),
          ...getRequestLogContext(request, requestOrigin),
        });
        rejectUpgrade(socket, 403, 'Forbidden');
        return;
      }
      if (pendingUpgrades >= maxPendingUpgrades) {
        counts.refusedBusy += 1;
        rejectUpgrade(socket, 503, 'Service Unavailable');
        return;
      }

      pendingUpgrades += 1;
      try {
        const user = await userClient.findById(tokenSubject);

        // A page socket is never a driver on shift: no driver record, no presence, no grace.
        const driver = pageRideId ? null : await driverClient.findByUserId(user.id);

        const auth = buildGatewayAuthContext({
          user,
          driverId: driver?.id,
        });
        // The MCP server says so when it connects; used only to label bookings for analytics.
        auth.client = url.searchParams.get('client') === 'mcp' ? 'mcp' : 'app';
        if (pageRideId) auth.page = { scope: 'trip', rideId: pageRideId };

        wsServer.handleUpgrade(request, socket as never, head, (ws: WebSocket) => {
          // Listen FIRST. The app speaks the moment its socket opens ("I am
          // online"), and the listeners used to be attached only after the
          // registry had written to Redis. When that write took longer than
          // the phone did, the first message arrived to nobody and was lost:
          // a driver who believed they were on shift and were not. register()
          // records who this socket is before it waits for anything, so the
          // handlers can run straight away.
          const registered = deps.registry.register(ws, auth);
          counts.opened += 1;
          if (verbose) {
            console.info('[ws] connected', {
              userId: user.id,
              driverId: driver?.id ?? null,
              ...getRequestLogContext(request, requestOrigin),
            });
          }
          // They are back: whatever grace was running for them is over. Said
          // before the listeners exist, so that if this socket closes a
          // moment from now, its new grace is written after this cancel and
          // not wiped out by it.
          if (driver) void grace.cancel(driver.id);
          wsServer.emit('connection', ws, request);

          void registered.then(() => {
            // A driver reconnecting mid-trip (or after missing the match
            // while backgrounded) gets their assigned ride back immediately.
            if (driver && ws.readyState === ws.OPEN) {
              void resyncDriverActiveRide(deps.registry, ws, driver.id);
            }
          }).catch((error) => {
            console.error('[ws] registry error', {
              message: error instanceof Error ? error.message : String(error),
              userId: user.id,
              ...getRequestLogContext(request, requestOrigin),
            });
            ws.close(1011, 'Socket registry error');
          });
        });
      } catch (error) {
        counts.refusedAuth += 1;
        const message = error instanceof Error ? error.message : 'Invalid auth token';
        console.warn('[ws] reject: could not sign in', {
          message,
          ...getRequestLogContext(request, requestOrigin),
        });
        rejectUpgrade(socket, 401, message);
      } finally {
        pendingUpgrades -= 1;
      }
    })();
  });

  wsServer.on('connection', (socket: WebSocket) => {
    const openedAt = Date.now();
    let lastSeenAt = Date.now();
    // socket.terminate() closes without a close frame, which surfaces as code
    // 1006 — indistinguishable in the log from the client vanishing. Recording
    // it is the difference between "we killed an idle socket" and "the network
    // dropped", which are opposite problems with opposite fixes.
    let idleTerminated = false;
    let pongsSeen = 0;
    const limiter = createRateLimiter(deps.rateLimitPerSecond ?? 10, deps.rateLimitBurst ?? 40);
    let strikes = 0;

    const touch = () => {
      lastSeenAt = Date.now();
    };

    const heartbeat = setInterval(() => {
      if (Date.now() - lastSeenAt > deps.idleTimeoutMs) {
        idleTerminated = true;
        console.warn('[ws] idle timeout — terminating', {
          idleMs: Date.now() - lastSeenAt,
          idleTimeoutMs: deps.idleTimeoutMs,
          ageMs: Date.now() - openedAt,
          // Zero pongs on a socket that lived past one heartbeat means the
          // client never answered a single ping — a client-side keepalive
          // problem, not a flaky network.
          pongsSeen,
          userId: deps.registry.getAuthContext(socket)?.userId ?? null,
        });
        socket.terminate();
        return;
      }

      if (socket.readyState === socket.OPEN) {
        socket.ping();
      }
    }, Math.max(10_000, Math.floor(deps.idleTimeoutMs / 2)));

    // A pong proves the phone is there. For a driver on shift that IS presence,
    // so it is written down — at most every 30 s, whatever the ping rate.
    let presenceNotedAt = 0;
    socket.on('pong', () => {
      pongsSeen += 1;
      touch();
      const auth = deps.registry.getAuthContext(socket);
      if (!auth?.driverId || Date.now() - presenceNotedAt < 30_000) return;
      presenceNotedAt = Date.now();
      // Redis hears every one; the row in Postgres is touched every couple of minutes.
      void driverClient.noteAlive(auth.userId, auth.driverId).catch(() => undefined);
    });

    socket.on('message', async (raw) => {
      touch();

      // More than its share: the message is dropped and the sender told. A
      // socket that keeps at it is closed; a real app never gets near this.
      if (!limiter.take()) {
        counts.rateLimited += 1;
        strikes += 1;
        if (strikes === 1 || strikes % 50 === 0) {
          deps.registry.sendToSocket(socket, 'error', { code: 'RATE_LIMITED', message: 'Too many messages. Slow down.' });
        }
        if (strikes >= RATE_LIMIT_STRIKES_BEFORE_CLOSE) {
          console.warn('[ws] closing a socket that would not slow down', {
            userId: deps.registry.getAuthContext(socket)?.userId ?? null,
          });
          socket.close(1008, 'Too many messages');
        }
        return;
      }
      counts.messages += 1;

      try {
        const parsed = JSON.parse(raw.toString()) as InboundWsMessage;

        if (!parsed || typeof parsed.type !== 'string') {
          throw new Error('Invalid message envelope');
        }

        const payload = isRecord(parsed.payload) ? parsed.payload : {};
        const auth = deps.registry.getAuthContext(socket);
        if (!auth) {
          throw new Error('Unauthenticated socket context');
        }

        if (verbose) {
          console.info('[ws] message', {
            type: parsed.type,
            userId: auth.userId,
            driverId: auth.driverId ?? null,
          });
        }

        const tripChatResponse = deps.tripChat ? await deps.tripChat.handleWsMessage(parsed.type, payload, auth) : null;
        const response =
          tripChatResponse ??
          // A Trip chat page's socket does nothing else.
          (auth.page
            ? null
            : (await handleRideMessage(
                parsed.type,
                payload,
                auth,
                deps.publisher,
                deps.routePlanner,
                deps.redis,
              )) ??
              (await handleDriverMessage(parsed.type, payload, auth, deps.publisher)) ??
              (await handleWalletMessage(parsed.type, payload)));

        if (!response) {
          deps.registry.sendToSocket(socket, 'error', {
            message: `Unknown event type: ${parsed.type}`,
          });
          return;
        }

        deps.registry.sendToSocket(socket, response.type, response.payload);

        // Going offline on purpose leaves the market immediately: open bids
        // are withdrawn and their riders told — same rule as a dead socket,
        // without the grace.
        if (parsed.type === 'driver:offline' && auth.driverId) {
          void grace.cancel(auth.driverId);
          void driverPresence.remove(auth.driverId);
          void withdrawDriverFromMarket(deps.registry, auth.userId);
        }

      } catch (error) {
        const rawCode = error instanceof Error ? (error as unknown as { code?: unknown }).code : undefined;
        const code = typeof rawCode === 'string' ? rawCode : undefined;
        console.warn('[ws] message error', {
          message: error instanceof Error ? error.message : 'Unknown message handling error',
          ...(code ? { code } : {}),
        });
        deps.registry.sendToSocket(socket, 'error', {
          message: error instanceof Error ? error.message : 'Unknown message handling error',
          // Which refusal it was, and to which request, so the app can act on it (e.g. "chat closed").
          ...(code ? { code } : {}),
          requestType: requestTypeOf(raw),
        });
      }
    });

    socket.on('close', (code, reason) => {
      clearInterval(heartbeat);
      const auth = deps.registry.getAuthContext(socket);
      counts.closed += 1;
      // An idle timeout or a policy close is worth a line; an ordinary close is counted.
      if (verbose || idleTerminated || code === 1008 || code === 1009) console.info('[ws] closed', {
        code,
        reason: reason.toString() || null,
        // Who ended it, and how long it lasted. A 1006 at roughly the idle
        // timeout with closedBy 'server-idle-timeout' is us; a 1006 well short
        // of it is the peer disappearing (backgrounded app, network switch).
        closedBy: idleTerminated ? 'server-idle-timeout' : 'peer',
        ageMs: Date.now() - openedAt,
        pongsSeen,
        userId: auth?.userId ?? null,
        driverId: auth?.driverId ?? null,
      });
      void deps.registry.unregister(socket);
      if (auth?.driverId) {
        // unregister is async; the grace re-checks liveness when it runs out,
        // so scheduling immediately is safe either way.
        void grace.schedule({ userId: auth.userId, driverId: auth.driverId });
      }
    });

    socket.on('error', (error) => {
      clearInterval(heartbeat);
      const auth = deps.registry.getAuthContext(socket);
      console.warn('[ws] socket error', {
        message: error.message,
        userId: auth?.userId ?? null,
        driverId: auth?.driverId ?? null,
      });
      void deps.registry.unregister(socket);
    });
  });

  return {
    stats: () => ({ open: deps.registry.connectionCount, pendingUpgrades, ...counts }),
  };
}
