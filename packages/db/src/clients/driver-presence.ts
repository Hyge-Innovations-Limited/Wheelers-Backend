/**
 * Where on-shift drivers are and when they were last heard from, in Redis.
 *
 * Every online driver sends three heartbeats every 30 seconds (the socket's
 * pong, a location over the socket, a location over HTTP). Each used to be an
 * UPDATE on the driver's row: three writes a driver, every 30 seconds, through
 * a pool of 20 connections. At 6,000 drivers online that is 600 writes a second
 * that change nothing anyone reads from Postgres in that time.
 *
 * Now a heartbeat is a Redis write, and the row in Postgres is brought up to
 * date at most once every DB_FLUSH_SECONDS per driver. Matching reads Redis:
 * a geo index for "who is near this pickup", and the presence record for "were
 * they heard from in the last 90 seconds".
 *
 *   driver:presence:{driverId}   HASH  seenAt, lat, lng      expires by itself
 *   drivers:geo                  GEO   driverId -> position
 *   driver:dbflush:{driverId}    the right to write the row, once per window
 *
 * Postgres stays the record of WHO a driver is and what STATUS they are in;
 * those change rarely. Redis is only "where, and how recently".
 *
 * Nothing here throws. If Redis is not configured (scripts, tests) or is down,
 * every call says "write the row yourself" and "ask Postgres", which is how
 * the system worked before.
 */

/** Send one Redis command. The gateway and ride-service each adapt their own client to this. */
export type RedisSend = (...args: string[]) => Promise<unknown>;

/** A driver counts as live if heard from within this window. Matching has always used 90s. */
export const PRESENCE_FRESH_MS = 90_000;
/** The presence record outlives the window a little, so "just went stale" is still readable. */
const PRESENCE_TTL_SECONDS = 180;
/** How often, at most, a heartbeat brings the driver's row in Postgres up to date. */
export const DB_FLUSH_SECONDS = 120;

const GEO_KEY = 'drivers:geo';
const presenceKey = (driverId: string) => `driver:presence:${driverId}`;
const flushKey = (driverId: string) => `driver:dbflush:${driverId}`;

let send: RedisSend | null = null;

export interface PresenceRecord {
  seenAt: number;
  lat: number | null;
  lng: number | null;
}

export interface NearbyDriver {
  driverId: string;
  distanceKm: number;
  lat: number;
  lng: number;
}

const validPoint = (lat: number, lng: number) =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 85.05 && Math.abs(lng) <= 180;

function toRecord(values: unknown): PresenceRecord | null {
  if (!Array.isArray(values)) return null;
  const seenAt = Number(values[0]);
  if (!Number.isFinite(seenAt) || seenAt <= 0) return null;
  const lat = values[1] == null ? NaN : Number(values[1]);
  const lng = values[2] == null ? NaN : Number(values[2]);
  const located = Number.isFinite(lat) && Number.isFinite(lng);
  return { seenAt, lat: located ? lat : null, lng: located ? lng : null };
}

async function read(driverIds: string[]): Promise<Array<PresenceRecord | null>> {
  if (!send || driverIds.length === 0) return driverIds.map(() => null);
  const run = send;
  return Promise.all(
    driverIds.map((id) =>
      run('HMGET', presenceKey(id), 'seenAt', 'lat', 'lng')
        .then(toRecord)
        .catch(() => null),
    ),
  );
}

interface Overlayable {
  id: string;
  status: string;
  lat: number | null;
  lng: number | null;
  lastSeenAt: Date | null;
}

function applyOverlay<T extends Overlayable>(row: T, record: PresenceRecord | null): T {
  if (!record) return row;
  if (row.status !== 'ONLINE' && row.status !== 'ON_RIDE') return row;
  if (row.lastSeenAt && row.lastSeenAt.getTime() >= record.seenAt) return row;
  row.lastSeenAt = new Date(record.seenAt);
  if (record.lat !== null && record.lng !== null) {
    row.lat = record.lat;
    row.lng = record.lng;
  }
  return row;
}

export const driverPresence = {
  /** Called once at boot by a service that has a Redis connection. Pass null to switch it off. */
  configure(redisSend: RedisSend | null): void {
    send = redisSend;
  },

  get configured(): boolean {
    return send !== null;
  },

  /**
   * A heartbeat that says where the driver is. Returns whether the caller
   * should also write the driver's row (true at most once per window, and
   * always when Redis cannot be reached).
   */
  async noteLocation(driverId: string, lat: number, lng: number, now = Date.now()): Promise<{ flushDb: boolean }> {
    if (!send || !validPoint(lat, lng)) return { flushDb: true };
    try {
      const key = presenceKey(driverId);
      const [, , , claimed] = await Promise.all([
        send('HSET', key, 'seenAt', String(now), 'lat', String(lat), 'lng', String(lng)),
        send('EXPIRE', key, String(PRESENCE_TTL_SECONDS)),
        send('GEOADD', GEO_KEY, String(lng), String(lat), driverId),
        send('SET', flushKey(driverId), '1', 'EX', String(DB_FLUSH_SECONDS), 'NX'),
      ]);
      return { flushDb: claimed === 'OK' };
    } catch {
      return { flushDb: true };
    }
  },

  /**
   * A heartbeat with no position: the socket answered a ping. It shares the
   * one write window with the position heartbeats, so a driver's row is
   * written once per window, not once per kind of heartbeat. When it is this
   * heartbeat that wins the window, it carries the last position Redis has, so
   * the row never falls behind on where the driver is.
   */
  async noteAlive(driverId: string, now = Date.now()): Promise<{ flushDb: boolean; lat: number | null; lng: number | null }> {
    if (!send) return { flushDb: true, lat: null, lng: null };
    try {
      const key = presenceKey(driverId);
      const [, , claimed, position] = await Promise.all([
        send('HSET', key, 'seenAt', String(now)),
        send('EXPIRE', key, String(PRESENCE_TTL_SECONDS)),
        send('SET', flushKey(driverId), '1', 'EX', String(DB_FLUSH_SECONDS), 'NX'),
        send('HMGET', key, 'lat', 'lng'),
      ]);
      const lat = Array.isArray(position) && position[0] != null ? Number(position[0]) : NaN;
      const lng = Array.isArray(position) && position[1] != null ? Number(position[1]) : NaN;
      const located = Number.isFinite(lat) && Number.isFinite(lng);
      return { flushDb: claimed === 'OK', lat: located ? lat : null, lng: located ? lng : null };
    } catch {
      return { flushDb: true, lat: null, lng: null };
    }
  },

  /** The driver went off shift: out of the geo index, and forgotten. */
  async remove(driverId: string): Promise<void> {
    if (!send) return;
    try {
      await Promise.all([
        send('ZREM', GEO_KEY, driverId),
        send('DEL', presenceKey(driverId), flushKey(driverId)),
      ]);
    } catch {
      /* it expires by itself */
    }
  },

  /** When this driver was last heard from, and where, if Redis knows. */
  async get(driverId: string): Promise<PresenceRecord | null> {
    const [record] = await read([driverId]);
    return record ?? null;
  },

  /** Heard from inside the freshness window? Null when Redis has no record of them. */
  async isFresh(driverId: string, now = Date.now()): Promise<boolean | null> {
    const record = await driverPresence.get(driverId);
    if (!record) return null;
    return now - record.seenAt < PRESENCE_FRESH_MS;
  },

  /**
   * Live drivers near a point, nearest first. Null means "Redis cannot answer"
   * (not configured, unreachable, or its index is empty, as right after a
   * restart of Redis): the caller asks Postgres instead. An empty list means
   * Redis answered and nobody live is near.
   */
  async nearby(lat: number, lng: number, radiusKm: number, count: number, now = Date.now()): Promise<NearbyDriver[] | null> {
    if (!send || !validPoint(lat, lng)) return null;
    try {
      const found = await send(
        'GEORADIUS', GEO_KEY, String(lng), String(lat), String(radiusKm), 'km',
        'WITHDIST', 'WITHCOORD', 'ASC', 'COUNT', String(Math.max(1, Math.floor(count))),
      );
      if (!Array.isArray(found)) return null;
      if (found.length === 0) {
        const size = Number(await send('ZCARD', GEO_KEY));
        return size > 0 ? [] : null;
      }
      const candidates: NearbyDriver[] = [];
      for (const entry of found) {
        if (!Array.isArray(entry)) continue;
        const driverId = String(entry[0]);
        const distanceKm = Number(entry[1]);
        const coord = Array.isArray(entry[2]) ? entry[2] : [];
        const cLng = Number(coord[0]);
        const cLat = Number(coord[1]);
        if (!driverId || !Number.isFinite(distanceKm) || !Number.isFinite(cLat) || !Number.isFinite(cLng)) continue;
        candidates.push({ driverId, distanceKm: Math.round(distanceKm * 1000) / 1000, lat: cLat, lng: cLng });
      }
      const records = await read(candidates.map((c) => c.driverId));
      const live: NearbyDriver[] = [];
      const gone: string[] = [];
      candidates.forEach((candidate, i) => {
        const record = records[i];
        if (record && now - record.seenAt < PRESENCE_FRESH_MS) live.push(candidate);
        else if (!record) gone.push(candidate.driverId);
      });
      // A phone that died without saying so leaves its pin behind; take it out of the index.
      if (gone.length > 0) void send('ZREM', GEO_KEY, ...gone).catch(() => undefined);
      return live;
    } catch {
      return null;
    }
  },

  /**
   * A driver's row as the system should see it: when Redis heard from them more
   * recently than the row says, the row's lastSeenAt and position are brought
   * forward. Only for drivers on shift, so an off-shift driver never looks live.
   */
  async overlay<T extends Overlayable>(row: T | null): Promise<T | null> {
    if (!row || !send) return row;
    if (row.status !== 'ONLINE' && row.status !== 'ON_RIDE') return row;
    return applyOverlay(row, await driverPresence.get(row.id));
  },

  async overlayMany<T extends Overlayable>(rows: T[]): Promise<T[]> {
    if (!send || rows.length === 0) return rows;
    const onShift = rows.filter((row) => row.status === 'ONLINE' || row.status === 'ON_RIDE');
    if (onShift.length === 0) return rows;
    const records = await read(onShift.map((row) => row.id));
    onShift.forEach((row, i) => applyOverlay(row, records[i] ?? null));
    return rows;
  },
};
