import { Socket } from 'net';

type RespValue = string | number | null | RespValue[];

interface PendingRequest {
  resolve: (value: RespValue) => void;
  reject: (error: Error) => void;
}

function toBuffer(value: string): Buffer {
  return Buffer.from(value, 'utf8');
}

function encodeCommand(args: string[]): Buffer {
  const parts: Buffer[] = [toBuffer(`*${args.length}\r\n`)];

  for (const arg of args) {
    const argBuffer = toBuffer(arg);
    parts.push(toBuffer(`$${argBuffer.byteLength}\r\n`));
    parts.push(argBuffer);
    parts.push(toBuffer('\r\n'));
  }

  return Buffer.concat(parts);
}

function readLine(buffer: Buffer, start: number): { line: string; next: number } | null {
  const end = buffer.indexOf('\r\n', start, 'utf8');
  if (end === -1) return null;

  return {
    line: buffer.toString('utf8', start, end),
    next: end + 2,
  };
}

function parseRespValue(buffer: Buffer, offset = 0): { value: RespValue; next: number } | null {
  if (offset >= buffer.length) return null;

  const prefix = String.fromCharCode(buffer[offset]);

  if (prefix === '+' || prefix === '-' || prefix === ':') {
    const line = readLine(buffer, offset + 1);
    if (!line) return null;

    if (prefix === '+') return { value: line.line, next: line.next };
    if (prefix === '-') return { value: `ERR:${line.line}`, next: line.next };
    return { value: Number(line.line), next: line.next };
  }

  if (prefix === '$') {
    const line = readLine(buffer, offset + 1);
    if (!line) return null;

    const length = Number(line.line);
    if (length === -1) {
      return { value: null, next: line.next };
    }

    const end = line.next + length;
    if (buffer.length < end + 2) return null;

    const value = buffer.toString('utf8', line.next, end);
    return {
      value,
      next: end + 2,
    };
  }

  if (prefix === '*') {
    const line = readLine(buffer, offset + 1);
    if (!line) return null;

    const count = Number(line.line);
    if (count === -1) {
      return { value: null, next: line.next };
    }

    const values: RespValue[] = [];
    let cursor = line.next;

    for (let i = 0; i < count; i += 1) {
      const parsed = parseRespValue(buffer, cursor);
      if (!parsed) return null;

      values.push(parsed.value);
      cursor = parsed.next;
    }

    return {
      value: values,
      next: cursor,
    };
  }

  throw new Error(`Unsupported RESP prefix: ${prefix}`);
}

interface RedisConnectionOptions {
  host: string;
  port: number;
  password?: string;
  db?: number;
}

function parseRedisUrl(redisUrl: string): RedisConnectionOptions {
  const parsed = new URL(redisUrl);

  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error('REDIS_URL must use redis:// or rediss://');
  }

  if (parsed.protocol === 'rediss:') {
    throw new Error('rediss:// is not yet supported by the built-in Redis client');
  }

  const host = parsed.hostname;
  const port = parsed.port ? Number(parsed.port) : 6379;
  const db = parsed.pathname && parsed.pathname !== '/' ? Number(parsed.pathname.slice(1)) : undefined;

  return {
    host,
    port,
    password: parsed.password || undefined,
    db: Number.isFinite(db) ? db : undefined,
  };
}

/** How long a command waits for a dropped connection to come back before it fails. */
const WAIT_FOR_RECONNECT_MS = 3_000;
const RECONNECT_MIN_MS = 200;
const RECONNECT_MAX_MS = 5_000;

/**
 * A small Redis client over one socket.
 *
 * It reconnects by itself. It used not to: when Redis restarted, the socket
 * closed, `connected` went false and every command after that threw, for as
 * long as the gateway stayed up. Now a dropped connection is retried (200 ms
 * doubling to 5 s, scattered), AUTH and SELECT are replayed, and the channels
 * it was subscribed to are subscribed again. Commands sent while it is down
 * wait up to three seconds for it to return, then fail, so callers are never
 * left hanging.
 */
export class RedisClient {
  private socket: Socket | null = null;
  private pending: PendingRequest[] = [];
  private receiveBuffer: Buffer = Buffer.alloc(0);
  private connected = false;
  private closedByUs = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private waiters: Array<() => void> = [];
  private readonly channels = new Set<string>();
  private messageListener?: (channel: string, payload: string) => void;

  constructor(private readonly redisUrl: string) {}

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.closedByUs = false;
    await this.open();
  }

  private open(): Promise<void> {
    const options = parseRedisUrl(this.redisUrl);

    return new Promise<void>((resolve, reject) => {
      const socket = new Socket();
      socket.setKeepAlive(true, 15_000);

      const onError = (error: Error) => {
        socket.destroy();
        reject(error);
      };

      socket.once('error', onError);
      socket.connect(options.port, options.host, async () => {
        socket.off('error', onError);
        this.socket = socket;
        this.receiveBuffer = Buffer.alloc(0);

        socket.on('data', (chunk) => {
          this.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        socket.on('error', (error) => this.failPending(error));
        socket.on('close', () => this.onClose(socket));

        this.connected = true;

        try {
          if (options.password) {
            await this.write('AUTH', options.password);
          }

          if (typeof options.db === 'number' && Number.isFinite(options.db)) {
            await this.write('SELECT', String(options.db));
          }

          for (const channel of this.channels) {
            await this.write('SUBSCRIBE', channel);
          }

          this.reconnectAttempt = 0;
          const waiting = this.waiters;
          this.waiters = [];
          for (const wake of waiting) wake();
          resolve();
        } catch (error) {
          socket.destroy();
          reject(error);
        }
      });
    });
  }

  private onClose(socket: Socket): void {
    if (this.socket !== socket) return;
    this.connected = false;
    this.socket = null;
    // Whatever was waiting on this connection will never be answered by it.
    this.failPending(new Error('Redis connection closed'));
    if (!this.closedByUs) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closedByUs) return;
    const step = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(this.reconnectAttempt, 10));
    const delay = Math.round(step / 2 + (step / 2) * Math.random());
    this.reconnectAttempt += 1;
    if (this.reconnectAttempt === 1) console.warn('[redis] connection lost; reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closedByUs || this.connected) return;
      this.open()
        .then(() => console.info('[redis] reconnected'))
        .catch(() => this.scheduleReconnect());
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private waitUntilConnected(): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== wake);
        reject(new Error('Redis client is not connected'));
      }, WAIT_FOR_RECONNECT_MS);
      timer.unref?.();
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(wake);
    });
  }

  async disconnect(): Promise<void> {
    this.closedByUs = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.socket) return;

    try {
      await this.write('QUIT');
    } catch {
      // ignore disconnect errors
    }

    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
  }

  onMessage(listener: (channel: string, payload: string) => void): void {
    this.messageListener = listener;
  }

  async subscribe(channel: string): Promise<void> {
    this.channels.add(channel);
    await this.send('SUBSCRIBE', channel);
  }

  async publish(channel: string, payload: string): Promise<number> {
    const result = await this.send('PUBLISH', channel, payload);
    return typeof result === 'number' ? result : 0;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds && ttlSeconds > 0) {
      await this.send('SET', key, value, 'EX', String(ttlSeconds));
      return;
    }

    await this.send('SET', key, value);
  }

  async setIfNotExists(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.send('SET', key, value, 'EX', String(ttlSeconds), 'NX');
    return result === 'OK';
  }

  async get(key: string): Promise<string | null> {
    const result = await this.send('GET', key);
    return typeof result === 'string' ? result : null;
  }

  async del(key: string): Promise<void> {
    await this.send('DEL', key);
  }

  async sadd(key: string, value: string): Promise<void> {
    await this.send('SADD', key, value);
  }

  async srem(key: string, value: string): Promise<void> {
    await this.send('SREM', key, value);
  }

  async smembers(key: string): Promise<string[]> {
    const result = await this.send('SMEMBERS', key);
    if (!Array.isArray(result)) return [];

    return result
      .filter((entry): entry is string => typeof entry === 'string')
      .filter((entry) => entry.length > 0);
  }

  async send(...args: string[]): Promise<RespValue> {
    if (!this.connected) {
      if (this.closedByUs) throw new Error('Redis client is not connected');
      await this.waitUntilConnected();
    }
    return this.write(...args);
  }

  /** Write on the current socket, connected or not yet announced as such (AUTH, SELECT, SUBSCRIBE on open). */
  private write(...args: string[]): Promise<RespValue> {
    const socket = this.socket;
    if (!socket) {
      return Promise.reject(new Error('Redis client is not connected'));
    }

    const payload = encodeCommand(args);

    return new Promise<RespValue>((resolve, reject) => {
      const request: PendingRequest = { resolve, reject };
      this.pending.push(request);
      socket.write(payload, (error) => {
        if (error) {
          const index = this.pending.indexOf(request);
          if (index !== -1) this.pending.splice(index, 1);
          reject(error);
        }
      });
    });
  }

  private onData(chunk: Buffer): void {
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);

    while (true) {
      const parsed = parseRespValue(this.receiveBuffer, 0);
      if (!parsed) {
        return;
      }

      this.receiveBuffer = this.receiveBuffer.subarray(parsed.next);
      this.handleResponse(parsed.value);
    }
  }

  private handleResponse(value: RespValue): void {
    if (Array.isArray(value) && value.length >= 3 && value[0] === 'message') {
      const channel = typeof value[1] === 'string' ? value[1] : '';
      const payload = typeof value[2] === 'string' ? value[2] : '';

      if (channel && this.messageListener) {
        this.messageListener(channel, payload);
      }
      return;
    }

    const pending = this.pending.shift();
    if (!pending) {
      return;
    }

    if (typeof value === 'string' && value.startsWith('ERR:')) {
      pending.reject(new Error(value.slice(4)));
      return;
    }

    pending.resolve(value);
  }

  private failPending(error: Error): void {
    while (this.pending.length > 0) {
      const pending = this.pending.shift();
      pending?.reject(error);
    }
  }
}
