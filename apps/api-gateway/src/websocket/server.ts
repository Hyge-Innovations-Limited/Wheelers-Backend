import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Duplex } from 'stream';
import WebSocket, { Server as WebSocketServer } from 'ws';
import { driverBidClient, driverClient, userClient } from '@wheleers/db';
import { DriverOfflineEvent } from '@wheleers/kafka-schemas';
import type { GoogleMapsRoutePlanner } from '@wheleers/config';
import { buildGatewayAuthContext } from '../auth/context';
import { verifyLocalAccessToken } from '../auth/local';
import type { InboundWsMessage } from '../types';
import { isRecord } from '../utils/object';
import { handleDriverMessage } from './handlers/driver.handler';
import { handleRideMessage } from './handlers/ride.handler';
import { handleWalletMessage } from './handlers/wallet.handler';
import { resyncDriverActiveRide } from './driver-ride-sync';
import type { GatewayPublisher } from './publisher';
import { SocketRegistry } from './registry';

interface WebSocketServerDeps {
  server: HttpServer;
  jwtSecret: string;
  allowedOrigins: Set<string>;
  idleTimeoutMs: number;
  registry: SocketRegistry;
  publisher: GatewayPublisher;
  routePlanner: GoogleMapsRoutePlanner;
}

/**
 * A driver whose socket died gets a short grace to reconnect (network blips
 * are normal); after it, they are OFF the market: marked offline and their
 * open bids withdrawn, each affected rider told. Without this, dead phones
 * stayed ONLINE in the DB forever — ghost drivers absorbed candidate slots
 * and riders paid for drivers who no longer existed.
 */
const DRIVER_OFFLINE_GRACE_MS = 45_000;
const pendingDriverOffline = new Map<string, ReturnType<typeof setTimeout>>();

function cancelPendingDriverOffline(driverId: string): void {
  const timer = pendingDriverOffline.get(driverId);
  if (timer) {
    clearTimeout(timer);
    pendingDriverOffline.delete(driverId);
  }
}

async function withdrawDriverFromMarket(
  deps: WebSocketServerDeps,
  driverUserId: string,
): Promise<void> {
  const affected = await driverBidClient
    .withdrawAllPendingForDriver(driverUserId)
    .catch(() => []);
  for (const bid of affected) {
    void deps.registry.sendToUser(bid.riderId, 'ride:driver_rejected', {
      rideId: bid.rideId,
      driverId: bid.driverId,
      reason: 'driver_unavailable',
    });
    // The driver was never told their bid was pulled; the app showed
    // "waiting on rider" for half an hour.
    void deps.registry.sendToUser(driverUserId, 'ride:bid_withdrawn', {
      rideId: bid.rideId,
      reason: 'driver_offline',
    });
  }
}

function scheduleDriverOffline(
  deps: WebSocketServerDeps,
  auth: { userId: string; driverId: string },
): void {
  cancelPendingDriverOffline(auth.driverId);
  const timer = setTimeout(() => {
    pendingDriverOffline.delete(auth.driverId);
    void (async () => {
    if (deps.registry.hasUser(auth.userId)) return; // reconnected in time

    // The socket is not the only heartbeat: driver apps POST their location
    // every few seconds over HTTP. A driver whose lastSeenAt is fresh is
    // sitting right there behind a flapping WebSocket — do NOT pull their
    // bids mid-negotiation; give them another grace window instead.
    const driver = await driverClient.findById(auth.driverId).catch(() => null);
    const seenMsAgo = driver?.lastSeenAt ? Date.now() - driver.lastSeenAt.getTime() : Infinity;
    if (seenMsAgo < 90_000) {
      console.info('[ws] socket gone but driver alive via HTTP — keeping online', {
        driverId: auth.driverId,
        seenMsAgo,
      });
      scheduleDriverOffline(deps, auth);
      return;
    }

    console.info('[ws] driver offline after disconnect grace', {
      driverId: auth.driverId,
      userId: auth.userId,
    });
    void deps.publisher
      .publishDriverEvent(
        DriverOfflineEvent.parse({
          eventType: 'DRIVER_OFFLINE',
          driverId: auth.driverId,
          reason: 'inactivity',
          timestamp: new Date().toISOString(),
        }),
      )
      .catch(() => undefined);
    void withdrawDriverFromMarket(deps, auth.userId);
    })();
  }, DRIVER_OFFLINE_GRACE_MS);
  timer.unref?.();
  pendingDriverOffline.set(auth.driverId, timer);
}

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

export function createGatewayWebSocketServer(deps: WebSocketServerDeps): void {
  const wsServer = new WebSocketServer({ noServer: true });

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

      if (deps.allowedOrigins.size > 0 && requestOrigin && !deps.allowedOrigins.has(requestOrigin)) {
        console.warn('[ws] reject: origin not allowed', {
          allowedOrigins: Array.from(deps.allowedOrigins),
          ...getRequestLogContext(request, requestOrigin),
        });
        rejectUpgrade(socket, 403, 'Forbidden');
        return;
      }

      const token = getConnectionToken(request, url.searchParams);
      if (!token) {
        console.warn('[ws] reject: missing access token', getRequestLogContext(request, requestOrigin));
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }

      try {
        const localToken = verifyLocalAccessToken(token, deps.jwtSecret);
        const user = await userClient.findById(localToken.sub);

        const driver = await driverClient.findByUserId(user.id);

        const auth = buildGatewayAuthContext({
          user,
          driverId: driver?.id,
        });

        wsServer.handleUpgrade(request, socket as never, head, (ws: WebSocket) => {
          void deps.registry.register(ws, auth).then(() => {
            console.info('[ws] connected', {
              userId: user.id,
              driverId: driver?.id ?? null,
              ...getRequestLogContext(request, requestOrigin),
            });
            wsServer.emit('connection', ws, request);
            // A driver reconnecting mid-trip (or after missing the match
            // while backgrounded) gets their assigned ride back immediately.
            if (driver) {
              cancelPendingDriverOffline(driver.id);
              void resyncDriverActiveRide(deps.registry, ws, driver.id);
            }
          }).catch((error) => {
            console.error('[ws] registry error', {
              message: error instanceof Error ? error.message : String(error),
              userId: user.id,
              ...getRequestLogContext(request, requestOrigin),
            });
            ws.close(1011, error instanceof Error ? error.message : 'Socket registry error');
          });
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid auth token';
        console.warn('[ws] reject: invalid access token', {
          message,
          ...getRequestLogContext(request, requestOrigin),
        });
        rejectUpgrade(socket, 401, message);
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

    socket.on('pong', () => {
      pongsSeen += 1;
      touch();
    });

    socket.on('message', async (raw) => {
      touch();

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

        console.info('[ws] message', {
          type: parsed.type,
          userId: auth.userId,
          driverId: auth.driverId ?? null,
        });

        const response =
          (await handleRideMessage(
            parsed.type,
            payload,
            auth,
            deps.publisher,
            deps.routePlanner,
          )) ??
          (await handleDriverMessage(parsed.type, payload, auth, deps.publisher)) ??
          (await handleWalletMessage(parsed.type, payload));

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
          cancelPendingDriverOffline(auth.driverId);
          void withdrawDriverFromMarket(deps, auth.userId);
        }

      } catch (error) {
        console.warn('[ws] message error', {
          message: error instanceof Error ? error.message : 'Unknown message handling error',
        });
        deps.registry.sendToSocket(socket, 'error', {
          message: error instanceof Error ? error.message : 'Unknown message handling error',
        });
      }
    });

    socket.on('close', (code, reason) => {
      clearInterval(heartbeat);
      const auth = deps.registry.getAuthContext(socket);
      console.info('[ws] closed', {
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
        // unregister is async; the grace timer re-checks liveness at fire
        // time, so scheduling immediately is safe either way.
        scheduleDriverOffline(deps, { userId: auth.userId, driverId: auth.driverId });
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
}
