import WebSocket from 'ws';
import type { Redis } from '../redis';

/**
 * Ride booking on Wheelers is a live negotiation over the gateway WebSocket:
 * the rider posts a request, drivers bid (counter-offers), the rider accepts
 * one, and the trip's lifecycle events stream back. None of that is exposed
 * over HTTP. This manager keeps one socket per signed-in user — exactly like
 * the mobile app does — sends commands on the user's behalf, and records
 * every event into Redis so that later, stateless MCP tool calls can read the
 * bids and trip status without a socket of their own.
 */

export interface WsEvent {
  type: string;
  payload: Record<string, unknown>;
  timestamp?: string;
}

export interface RideBid {
  driverId: string;
  driverUserId: string;
  counterOfferNgn: number;
  driverName: string;
  driverRating: number;
  vehiclePlate: string;
  vehicleModel: string;
  etaSeconds: number;
  distanceKm?: number;
  receivedAt: string;
}

export type RidePhase =
  | 'bidding'
  | 'matched'
  | 'arrived'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'bid_timeout';

export interface RideState {
  rideId: string;
  userId: string;
  phase: RidePhase;
  request?: Record<string, unknown>;
  bids: Record<string, RideBid>;
  riderCounterOffers: Record<string, number>;
  matched?: Record<string, unknown>;
  arrived?: Record<string, unknown>;
  started?: Record<string, unknown>;
  completed?: Record<string, unknown>;
  cancelled?: Record<string, unknown>;
  driverRejections: Array<Record<string, unknown>>;
  driverLocation?: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
  events: Array<{ type: string; at: string; payload?: Record<string, unknown> }>;
  createdAt: string;
  updatedAt: string;
}

export const LIVE_PHASES: ReadonlySet<RidePhase> = new Set(['bidding', 'matched', 'arrived', 'in_progress']);

interface Waiter {
  types: Set<string>;
  rideId?: string;
  resolve: (event: WsEvent) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class Session {
  ws: WebSocket | null = null;
  connecting: Promise<WebSocket> | null = null;
  queue: Promise<unknown> = Promise.resolve();
  waiters: Waiter[] = [];
  lastActivityAt = Date.now();
  reconnectAttempts = 0;
  reconnectTimer: NodeJS.Timeout | null = null;
  closedByUs = false;

  constructor(
    readonly userId: string,
    public token: string,
  ) {}
}

export interface RideSessionManagerDeps {
  wsUrl: string;
  redis: Redis;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

const STATE_TTL_S = 60 * 60 * 24;
const ACTIVE_RIDE_TTL_S = 60 * 60 * 6;
const IDLE_CLOSE_MS = 30 * 60 * 1000;
const MAX_RECONNECTS = 6;
const MAX_EVENTS = 100;
const MAX_MESSAGES = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripHeavy(payload: Record<string, unknown>): Record<string, unknown> {
  // Route geometry can be thousands of points; keep the event log readable.
  const { route: _route, ...rest } = payload;
  return rest;
}

export class RideSessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly stateLocks = new Map<string, Promise<unknown>>();
  private readonly sweeper: NodeJS.Timeout;
  private readonly log: (message: string, meta?: Record<string, unknown>) => void;

  constructor(private readonly deps: RideSessionManagerDeps) {
    this.log = deps.log ?? ((message, meta) => console.info(`[mcp][ride-session] ${message}`, meta ?? ''));
    this.sweeper = setInterval(() => void this.sweepIdle(), 60_000);
    this.sweeper.unref();
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Send a command and wait for the gateway's acknowledgement (one of
   * `expect`, or an `error`). Commands for the same user are serialised so a
   * reply can never be attributed to the wrong request.
   */
  async command(
    userId: string,
    token: string,
    type: string,
    payload: Record<string, unknown>,
    expect: string[],
    timeoutMs = 25_000,
  ): Promise<WsEvent> {
    const session = this.sessionFor(userId, token);

    const run = async (): Promise<WsEvent> => {
      const ws = await this.connect(session);
      session.lastActivityAt = Date.now();

      return new Promise<WsEvent>((resolve, reject) => {
        const rideId = typeof payload['rideId'] === 'string' ? payload['rideId'] : undefined;
        const waiter: Waiter = {
          types: new Set([...expect, 'error']),
          rideId,
          resolve,
          reject,
          timer: setTimeout(() => {
            this.removeWaiter(session, waiter);
            reject(new Error(`Wheelers did not acknowledge "${type}" within ${Math.round(timeoutMs / 1000)}s.`));
          }, timeoutMs),
        };
        session.waiters.push(waiter);

        ws.send(JSON.stringify({ type, payload }), (error) => {
          if (error) {
            this.removeWaiter(session, waiter);
            clearTimeout(waiter.timer);
            reject(error);
          }
        });
      });
    };

    const result = session.queue.then(run, run);
    session.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Make sure a socket is open so bids and trip events keep being recorded. */
  async ensureListening(userId: string, token: string): Promise<boolean> {
    const session = this.sessionFor(userId, token);
    try {
      await this.connect(session);
      return true;
    } catch (error) {
      this.log('could not (re)open ride socket', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  isListening(userId: string): boolean {
    const session = this.sessions.get(userId);
    return !!session?.ws && session.ws.readyState === WebSocket.OPEN;
  }

  async getState(rideId: string): Promise<RideState | null> {
    const raw = await this.deps.redis.get(this.stateKey(rideId));
    return raw ? (JSON.parse(raw) as RideState) : null;
  }

  async getActiveRideId(userId: string): Promise<string | null> {
    return this.deps.redis.get(this.activeKey(userId));
  }

  async setActiveRide(userId: string, rideId: string): Promise<void> {
    await this.deps.redis.set(this.activeKey(userId), rideId, 'EX', ACTIVE_RIDE_TTL_S);
  }

  async clearActiveRide(userId: string, rideId?: string): Promise<void> {
    if (rideId) {
      const current = await this.deps.redis.get(this.activeKey(userId));
      if (current && current !== rideId) return;
    }
    await this.deps.redis.del(this.activeKey(userId));
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    for (const session of this.sessions.values()) {
      session.closedByUs = true;
      if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
      session.ws?.close(1001, 'server shutting down');
    }
    this.sessions.clear();
  }

  // ── Connection handling ──────────────────────────────────────────────────

  private sessionFor(userId: string, token: string): Session {
    let session = this.sessions.get(userId);
    if (!session) {
      session = new Session(userId, token);
      this.sessions.set(userId, session);
    } else if (session.token !== token) {
      // Newer credentials win; if the socket was opened with an older token
      // it stays valid until the gateway closes it.
      session.token = token;
    }
    return session;
  }

  private connect(session: Session): Promise<WebSocket> {
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve(session.ws);
    }
    if (session.connecting) return session.connecting;

    session.closedByUs = false;
    const url = new URL(this.deps.wsUrl);
    url.searchParams.set('accessToken', session.token);
    // Rides booked through this socket are labelled Claude (MCP) in the admin analytics.
    url.searchParams.set('client', 'mcp');

    session.connecting = new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url.toString(), { handshakeTimeout: 15_000 });
      let settled = false;

      ws.once('unexpected-response', (_req, res) => {
        if (settled) return;
        settled = true;
        session.connecting = null;
        reject(new Error(`Wheelers refused the ride connection (HTTP ${res.statusCode ?? 'unknown'}). Sign in again if this persists.`));
        ws.terminate();
      });

      ws.once('error', (error) => {
        if (settled) return;
        settled = true;
        session.connecting = null;
        reject(error);
      });

      ws.once('open', () => {
        settled = true;
        session.connecting = null;
        session.ws = ws;
        session.reconnectAttempts = 0;
        session.lastActivityAt = Date.now();
        this.log('connected', { userId: session.userId });
        resolve(ws);
      });

      ws.on('message', (raw) => {
        void this.onMessage(session, raw.toString());
      });

      ws.on('error', (error) => {
        this.log('socket error', { userId: session.userId, error: error.message });
      });

      ws.on('close', (code, reason) => {
        if (session.ws === ws) session.ws = null;
        this.failWaiters(session, new Error(`Ride connection closed (${code}${reason.length ? `: ${reason.toString()}` : ''}).`));
        if (!session.closedByUs) void this.maybeReconnect(session, code);
      });
    });

    return session.connecting;
  }

  private async maybeReconnect(session: Session, closeCode: number): Promise<void> {
    if (closeCode === 1008 || closeCode === 4401) return; // policy/auth — a new token is needed
    const activeRide = await this.getActiveRideId(session.userId).catch(() => null);
    if (!activeRide) return;
    if (session.reconnectAttempts >= MAX_RECONNECTS) {
      this.log('giving up reconnecting', { userId: session.userId, rideId: activeRide });
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** session.reconnectAttempts);
    session.reconnectAttempts += 1;
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = null;
      void this.connect(session).catch((error) => {
        this.log('reconnect failed', {
          userId: session.userId,
          attempt: session.reconnectAttempts,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, delay);
    session.reconnectTimer.unref();
  }

  private async sweepIdle(): Promise<void> {
    const now = Date.now();
    for (const [userId, session] of this.sessions) {
      if (session.waiters.length > 0) continue;
      if (now - session.lastActivityAt < IDLE_CLOSE_MS) continue;
      const activeRide = await this.getActiveRideId(userId).catch(() => null);
      if (activeRide) continue;
      session.closedByUs = true;
      session.ws?.close(1000, 'idle');
      this.sessions.delete(userId);
    }
  }

  private removeWaiter(session: Session, waiter: Waiter): void {
    const index = session.waiters.indexOf(waiter);
    if (index >= 0) session.waiters.splice(index, 1);
  }

  private failWaiters(session: Session, error: Error): void {
    const waiters = session.waiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  // ── Inbound events ───────────────────────────────────────────────────────

  private async onMessage(session: Session, raw: string): Promise<void> {
    let event: WsEvent;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed) || typeof parsed['type'] !== 'string') return;
      event = {
        type: parsed['type'],
        payload: isRecord(parsed['payload']) ? parsed['payload'] : {},
        timestamp: typeof parsed['timestamp'] === 'string' ? parsed['timestamp'] : undefined,
      };
    } catch {
      return;
    }

    session.lastActivityAt = Date.now();

    try {
      await this.record(session.userId, event);
    } catch (error) {
      this.log('failed to record event', {
        type: event.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const eventRideId = typeof event.payload['rideId'] === 'string' ? event.payload['rideId'] : undefined;
    const waiter = session.waiters.find(
      (candidate) =>
        candidate.types.has(event.type) &&
        (event.type === 'error' || !candidate.rideId || !eventRideId || candidate.rideId === eventRideId),
    );
    if (!waiter) return;

    this.removeWaiter(session, waiter);
    clearTimeout(waiter.timer);
    if (event.type === 'error') {
      const message = typeof event.payload['message'] === 'string' ? event.payload['message'] : 'Wheelers rejected the request.';
      waiter.reject(new Error(message));
    } else {
      waiter.resolve(event);
    }
  }

  private async record(userId: string, event: WsEvent): Promise<void> {
    const rideId = typeof event.payload['rideId'] === 'string' ? event.payload['rideId'] : undefined;
    if (!rideId) return;
    const at = event.timestamp ?? new Date().toISOString();

    switch (event.type) {
      case 'ride:request:accepted':
        await this.mutate(rideId, userId, (state) => {
          state.phase = 'bidding';
          state.request = stripHeavy(event.payload);
          this.pushEvent(state, event.type, at);
        });
        await this.setActiveRide(userId, rideId);
        return;

      case 'ride:counter_offer': {
        const driverId = typeof event.payload['driverId'] === 'string' ? event.payload['driverId'] : undefined;
        if (!driverId) return;
        await this.mutate(rideId, userId, (state) => {
          state.bids[driverId] = {
            driverId,
            driverUserId: String(event.payload['driverUserId'] ?? ''),
            counterOfferNgn: Number(event.payload['counterOfferNgn'] ?? 0),
            driverName: String(event.payload['driverName'] ?? 'Driver'),
            driverRating: Number(event.payload['driverRating'] ?? 0),
            vehiclePlate: String(event.payload['vehiclePlate'] ?? ''),
            vehicleModel: String(event.payload['vehicleModel'] ?? ''),
            etaSeconds: Number(event.payload['etaSeconds'] ?? 0),
            distanceKm: typeof event.payload['distanceKm'] === 'number' ? event.payload['distanceKm'] : undefined,
            receivedAt: at,
          };
          if (state.phase !== 'matched' && state.phase !== 'arrived' && state.phase !== 'in_progress') {
            state.phase = 'bidding';
          }
          this.pushEvent(state, event.type, at, { driverId, counterOfferNgn: event.payload['counterOfferNgn'] });
        });
        return;
      }

      case 'ride:rider_counter_offer:confirmed': {
        const driverId = typeof event.payload['driverId'] === 'string' ? event.payload['driverId'] : undefined;
        if (!driverId) return;
        await this.mutate(rideId, userId, (state) => {
          state.riderCounterOffers[driverId] = Number(event.payload['counterOfferNgn'] ?? 0);
          this.pushEvent(state, event.type, at, stripHeavy(event.payload));
        });
        return;
      }

      case 'ride:bid_timeout':
        await this.mutate(rideId, userId, (state) => {
          state.phase = 'bid_timeout';
          this.pushEvent(state, event.type, at);
        });
        await this.clearActiveRide(userId, rideId);
        return;

      case 'ride:matched':
        await this.mutate(rideId, userId, (state) => {
          state.phase = 'matched';
          state.matched = stripHeavy(event.payload);
          this.pushEvent(state, event.type, at, stripHeavy(event.payload));
        });
        await this.setActiveRide(userId, rideId);
        return;

      case 'ride:driver_arrived':
        await this.mutate(rideId, userId, (state) => {
          state.phase = 'arrived';
          state.arrived = stripHeavy(event.payload);
          this.pushEvent(state, event.type, at);
        });
        return;

      case 'ride:started':
        await this.mutate(rideId, userId, (state) => {
          state.phase = 'in_progress';
          state.started = stripHeavy(event.payload);
          this.pushEvent(state, event.type, at);
        });
        return;

      case 'ride:completed':
        await this.mutate(rideId, userId, (state) => {
          state.phase = 'completed';
          state.completed = stripHeavy(event.payload);
          this.pushEvent(state, event.type, at, stripHeavy(event.payload));
        });
        await this.clearActiveRide(userId, rideId);
        return;

      case 'ride:cancelled':
        await this.mutate(rideId, userId, (state) => {
          state.phase = 'cancelled';
          state.cancelled = stripHeavy(event.payload);
          this.pushEvent(state, event.type, at, stripHeavy(event.payload));
        });
        await this.clearActiveRide(userId, rideId);
        return;

      case 'ride:driver_rejected':
        await this.mutate(rideId, userId, (state) => {
          state.driverRejections.push({ ...stripHeavy(event.payload), at });
          this.pushEvent(state, event.type, at, stripHeavy(event.payload));
        });
        return;

      case 'ride:driver_location':
        await this.mutate(rideId, userId, (state) => {
          state.driverLocation = { ...event.payload, at };
        });
        return;

      case 'chat:message':
        await this.mutate(rideId, userId, (state) => {
          state.messages.push({ ...event.payload, at });
          if (state.messages.length > MAX_MESSAGES) state.messages.splice(0, state.messages.length - MAX_MESSAGES);
          this.pushEvent(state, event.type, at);
        });
        return;

      default:
        if (event.type.startsWith('ride:') || event.type.startsWith('gps:')) {
          await this.mutate(rideId, userId, (state) => {
            this.pushEvent(state, event.type, at, stripHeavy(event.payload));
          });
        }
    }
  }

  private pushEvent(state: RideState, type: string, at: string, payload?: Record<string, unknown>): void {
    state.events.push(payload ? { type, at, payload } : { type, at });
    if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  }

  /** Read-modify-write under a per-ride in-process lock (single writer per ride). */
  private mutate(rideId: string, userId: string, fn: (state: RideState) => void): Promise<void> {
    const previous = this.stateLocks.get(rideId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const key = this.stateKey(rideId);
        const raw = await this.deps.redis.get(key);
        const now = new Date().toISOString();
        const state: RideState = raw
          ? (JSON.parse(raw) as RideState)
          : {
              rideId,
              userId,
              phase: 'bidding',
              bids: {},
              riderCounterOffers: {},
              driverRejections: [],
              messages: [],
              events: [],
              createdAt: now,
              updatedAt: now,
            };
        fn(state);
        state.updatedAt = now;
        await this.deps.redis.set(key, JSON.stringify(state), 'EX', STATE_TTL_S);
      });
    this.stateLocks.set(rideId, next);
    void next.finally(() => {
      if (this.stateLocks.get(rideId) === next) this.stateLocks.delete(rideId);
    });
    return next;
  }

  private stateKey(rideId: string): string {
    return `mcp:ride:${rideId}`;
  }

  private activeKey(userId: string): string {
    return `mcp:user:${userId}:active-ride`;
  }
}
