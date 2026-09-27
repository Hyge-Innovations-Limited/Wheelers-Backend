import { randomUUID } from 'crypto';
import type WebSocket from 'ws';
import type { GatewayAuthContext, OutboundWsMessage } from '../types';
import { isRecord } from '../utils/object';
import { RedisClient } from '../redis/client';

const REGISTRY_TTL_SECONDS = 60 * 60 * 24;

interface RemoteSocketMessage {
  userId: string;
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

function userSocketsKey(userId: string): string {
  return `gateway:user:${userId}:sockets`;
}

function userInstancesKey(userId: string): string {
  return `gateway:user:${userId}:instances`;
}

function socketMetadataKey(connectionId: string): string {
  return `gateway:socket:${connectionId}`;
}

function instanceChannel(instanceId: string): string {
  return `gateway:instance:${instanceId}`;
}

/**
 * "This gateway process is running." Refreshed every few seconds and gone
 * within half a minute of the process dying, so another process can tell a
 * user who is connected elsewhere from one whose gateway crashed and left its
 * name behind in their set.
 */
function instanceAliveKey(instanceId: string): string {
  return `gateway:instance:${instanceId}:alive`;
}

const INSTANCE_ALIVE_TTL_SECONDS = 30;
const INSTANCE_ALIVE_EVERY_MS = 10_000;

interface SocketRegistryDeps {
  instanceId: string;
  commandRedis: RedisClient;
  subscriberRedis: RedisClient;
}

export class SocketRegistry {
  private socketsByConnectionId = new Map<string, WebSocket>();
  private connectionIdBySocket = new Map<WebSocket, string>();
  private connectionsByUser = new Map<string, Set<string>>();
  private authBySocket = new Map<WebSocket, GatewayAuthContext>();
  private aliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: SocketRegistryDeps) {}

  get instanceId(): string {
    return this.deps.instanceId;
  }

  /** How many sockets this process holds. */
  get connectionCount(): number {
    return this.socketsByConnectionId.size;
  }

  async start(): Promise<void> {
    this.deps.subscriberRedis.onMessage((_channel, payload) => {
      void this.handleRemoteMessage(payload);
    });

    await this.deps.subscriberRedis.subscribe(instanceChannel(this.deps.instanceId));

    const beat = () =>
      this.deps.commandRedis
        .set(instanceAliveKey(this.deps.instanceId), String(Date.now()), INSTANCE_ALIVE_TTL_SECONDS)
        .catch(() => undefined);
    await beat();
    this.aliveTimer = setInterval(() => void beat(), INSTANCE_ALIVE_EVERY_MS);
    this.aliveTimer.unref?.();
  }

  /**
   * Is this user connected to ANY gateway process? The local answer is free;
   * otherwise Redis says which processes claim them, and a process that has
   * stopped answering is struck from the list.
   */
  async isUserConnected(userId: string): Promise<boolean> {
    if (this.hasUser(userId)) return true;
    try {
      const instances = await this.deps.commandRedis.smembers(userInstancesKey(userId));
      for (const instanceId of instances) {
        if (instanceId === this.deps.instanceId) {
          // Redis says here, memory says not: a leftover from a socket that closed badly.
          void this.deps.commandRedis.srem(userInstancesKey(userId), instanceId).catch(() => undefined);
          continue;
        }
        const alive = await this.deps.commandRedis.get(instanceAliveKey(instanceId));
        if (alive) return true;
        void this.deps.commandRedis.srem(userInstancesKey(userId), instanceId).catch(() => undefined);
      }
    } catch {
      /* Redis cannot say; the local answer stands. */
    }
    return false;
  }

  async register(socket: WebSocket, auth: GatewayAuthContext): Promise<void> {
    const connectionId = randomUUID();

    this.socketsByConnectionId.set(connectionId, socket);
    this.connectionIdBySocket.set(socket, connectionId);
    this.authBySocket.set(socket, auth);

    const userConnections = this.connectionsByUser.get(auth.userId) ?? new Set<string>();
    userConnections.add(connectionId);
    this.connectionsByUser.set(auth.userId, userConnections);

    await Promise.all([
      this.deps.commandRedis.sadd(userSocketsKey(auth.userId), connectionId),
      this.deps.commandRedis.sadd(userInstancesKey(auth.userId), this.deps.instanceId),
      this.deps.commandRedis.set(
        socketMetadataKey(connectionId),
        JSON.stringify({ userId: auth.userId, instanceId: this.deps.instanceId }),
        REGISTRY_TTL_SECONDS,
      ),
    ]);
  }

  async unregister(socket: WebSocket): Promise<void> {
    const connectionId = this.connectionIdBySocket.get(socket);
    const auth = this.authBySocket.get(socket);
    if (!connectionId || !auth) return;

    this.connectionIdBySocket.delete(socket);
    this.authBySocket.delete(socket);
    this.socketsByConnectionId.delete(connectionId);

    const userConnections = this.connectionsByUser.get(auth.userId);
    if (userConnections) {
      userConnections.delete(connectionId);
      if (userConnections.size === 0) {
        this.connectionsByUser.delete(auth.userId);
      }
    }

    await Promise.all([
      this.deps.commandRedis.srem(userSocketsKey(auth.userId), connectionId),
      this.deps.commandRedis.del(socketMetadataKey(connectionId)),
      userConnections && userConnections.size === 0
        ? this.deps.commandRedis.srem(userInstancesKey(auth.userId), this.deps.instanceId)
        : Promise.resolve(),
    ]);
  }

  /**
   * A clean stop: every socket is told the service is restarting (1012), so
   * the apps start their wait-and-retry at once instead of discovering a dead
   * connection a minute later, and this process takes its name out of Redis.
   */
  async shutdown(): Promise<void> {
    if (this.aliveTimer) clearInterval(this.aliveTimer);
    this.aliveTimer = null;
    const userIds = Array.from(this.connectionsByUser.keys());
    for (const socket of this.socketsByConnectionId.values()) {
      try {
        socket.close(1012, 'Service restart');
      } catch {
        /* already closing */
      }
    }
    await Promise.all([
      ...userIds.map((userId) =>
        this.deps.commandRedis.srem(userInstancesKey(userId), this.deps.instanceId).catch(() => undefined),
      ),
      this.deps.commandRedis.del(instanceAliveKey(this.deps.instanceId)).catch(() => undefined),
    ]);
  }

  hasUser(userId: string): boolean {
    return (this.connectionsByUser.get(userId)?.size ?? 0) > 0;
  }

  getAuthContext(socket: WebSocket): GatewayAuthContext | undefined {
    return this.authBySocket.get(socket);
  }

  sendToSocket(socket: WebSocket, type: string, payload: Record<string, unknown>): void {
    if (socket.readyState !== socket.OPEN) return;

    const message: OutboundWsMessage = {
      type,
      payload,
      timestamp: new Date().toISOString(),
    };

    socket.send(JSON.stringify(message));
  }

  async sendToUser(userId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    this.sendToLocalUser(userId, type, payload, new Date().toISOString());

    const instances = await this.deps.commandRedis.smembers(userInstancesKey(userId));
    const remoteInstances = instances.filter((instanceId) => instanceId !== this.deps.instanceId);

    if (remoteInstances.length === 0) {
      return;
    }

    const message: RemoteSocketMessage = {
      userId,
      type,
      payload,
      timestamp: new Date().toISOString(),
    };

    const serialized = JSON.stringify(message);

    await Promise.all(
      remoteInstances.map(async (instanceId) => {
        const receivers = await this.deps.commandRedis.publish(instanceChannel(instanceId), serialized);
        // Nobody listening on that channel: the process is gone. Stop sending it this user's messages.
        if (receivers === 0) {
          void this.deps.commandRedis.srem(userInstancesKey(userId), instanceId).catch(() => undefined);
        }
      }),
    );
  }

  private sendToLocalUser(
    userId: string,
    type: string,
    payload: Record<string, unknown>,
    timestamp: string,
  ): void {
    const userConnectionIds = this.connectionsByUser.get(userId);
    if (!userConnectionIds || userConnectionIds.size === 0) return;

    const outbound: OutboundWsMessage = {
      type,
      payload,
      timestamp,
    };

    const serialized = JSON.stringify(outbound);

    for (const connectionId of userConnectionIds) {
      const socket = this.socketsByConnectionId.get(connectionId);
      if (!socket || socket.readyState !== socket.OPEN) continue;
      socket.send(serialized);
    }
  }

  private async handleRemoteMessage(payload: string): Promise<void> {
    try {
      const parsed = JSON.parse(payload);
      if (!isRecord(parsed)) return;

      const userId = typeof parsed['userId'] === 'string' ? parsed['userId'] : undefined;
      const type = typeof parsed['type'] === 'string' ? parsed['type'] : undefined;
      const timestamp = typeof parsed['timestamp'] === 'string' ? parsed['timestamp'] : undefined;
      const data = isRecord(parsed['payload']) ? parsed['payload'] : undefined;

      if (!userId || !type || !timestamp || !data) {
        return;
      }

      this.sendToLocalUser(userId, type, data, timestamp);
    } catch {
      // ignore malformed relay messages
    }
  }
}
