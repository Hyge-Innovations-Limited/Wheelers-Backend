#!/usr/bin/env node
/**
 * A real load test of the gateway's WebSocket server.
 *
 * It opens thousands of sockets against a running gateway and makes each one
 * behave like a phone:
 *
 *   a rider   holds the socket open and answers the server's pings
 *   a driver  goes online, then every 30 seconds sends its position over the
 *             socket AND over HTTP (the app does both), and answers pings
 *
 * and every one of them, when its socket drops, waits and retries the way the
 * app does (1 s doubling to 30 s, scattered).
 *
 * It reports: how many connected and how fast, how long the gateway takes to
 * answer a message, what the gateway processes cost in memory and CPU, how
 * many rows Postgres actually wrote, how long matching takes with every driver
 * in the index, and (with --storm-at) how long everyone takes to get back in
 * after all the sockets are cut at once.
 *
 *   node scripts/run-with-env.cjs node scripts/ws-load-test.mjs --connections 5000
 *   node scripts/run-with-env.cjs node scripts/ws-load-test.mjs --connections 20000 \
 *        --targets ws://127.0.0.1:3001,ws://[::1]:3001 --storm-at 60
 *   node scripts/run-with-env.cjs node scripts/ws-load-test.mjs --cleanup
 *
 * It creates users called "loadtest:N" in the database it is pointed at, so it
 * refuses a database that is not on this machine unless told --allow-remote-db.
 *
 * Limits of the machine running it (not of the gateway):
 *   open files   each socket is one, on both sides.  `ulimit -n 65536` first.
 *   ports        ~16,000 to ~28,000 outgoing per destination address. Past
 *                that, give more than one address in --targets.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WebSocket = require(path.join(root, 'node_modules/ws'));
const { PrismaClient } = require('@prisma/client');
const local = require(path.join(root, 'apps/api-gateway/dist/auth/local.js'));
const { RedisClient } = require(path.join(root, 'apps/api-gateway/dist/redis/client.js'));
const { driverClient, driverPresence } = require(path.join(root, 'packages/db/dist/index.js'));

// ── Arguments ───────────────────────────────────────────────────────────────

function readArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) out[arg.slice(2, eq)] = arg.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[arg.slice(2)] = argv[(i += 1)];
    else out[arg.slice(2)] = true;
  }
  return out;
}

const args = readArgs(process.argv.slice(2));
const num = (key, fallback) => (args[key] === undefined ? fallback : Number(args[key]));

const port = process.env.PORT || '3000';
const options = {
  connections: num('connections', 1000),
  targets: String(args.targets || `ws://127.0.0.1:${port}`).split(',').map((t) => t.trim().replace(/\/$/, '')),
  rampPerSecond: num('ramp', 250),
  holdSeconds: num('hold', 120),
  driverShare: num('drivers', 0.3),
  heartbeatSeconds: num('heartbeat', 30),
  stormAtSeconds: args['storm-at'] === undefined ? null : Number(args['storm-at']),
  fixedRetryMs: args['fixed-retry-ms'] === undefined ? null : Number(args['fixed-retry-ms']),
  gatewayMatch: String(args['gateway-match'] || 'api-gateway/dist/index.js'),
  out: args.out ? String(args.out) : null,
  offset: num('offset', 0),
  label: String(args.label || ''),
};

const YABA = { lat: 6.5095, lng: 3.3711 };
const USER_PREFIX = '10ad7e57-0000-4000-8000-';
const userIdFor = (i) => `${USER_PREFIX}${i.toString(16).padStart(12, '0')}`;
const driverRowIdFor = (i) => `10ad7e57-d000-4000-8000-${i.toString(16).padStart(12, '0')}`;

// ── Safety ──────────────────────────────────────────────────────────────────

function databaseHost() {
  try {
    return new URL(process.env.DATABASE_URL || '').hostname;
  } catch {
    return '';
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'postgres', 'host.docker.internal']);
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Run through: node scripts/run-with-env.cjs node scripts/ws-load-test.mjs …');
  process.exit(1);
}
if (!LOCAL_HOSTS.has(databaseHost()) && !args['allow-remote-db']) {
  console.error(`The database is on "${databaseHost()}", not this machine. This test creates thousands of users.`);
  console.error('Point it at a test database, or pass --allow-remote-db if that really is one.');
  process.exit(1);
}

const prisma = new PrismaClient();

// ── Users ───────────────────────────────────────────────────────────────────

async function seed(total, drivers) {
  const started = Date.now();
  const CHUNK = 1000;
  let made = 0;
  for (let from = 0; from < total; from += CHUNK) {
    const indexes = Array.from({ length: Math.min(CHUNK, total - from) }, (_, k) => from + k);
    const result = await prisma.user.createMany({
      skipDuplicates: true,
      data: indexes.map((i) => ({
        id: userIdFor(i),
        privyDid: `loadtest:${i}`,
        role: i < drivers ? 'DRIVER' : 'RIDER',
        name: `Load Test ${i}`,
      })),
    });
    made += result.count;
    const driverIndexes = indexes.filter((i) => i < drivers);
    if (driverIndexes.length > 0) {
      await prisma.driver.createMany({
        skipDuplicates: true,
        data: driverIndexes.map((i) => ({
          id: driverRowIdFor(i),
          userId: userIdFor(i),
          kycStatus: 'APPROVED',
          vehiclePlate: `LT${String(i).padStart(5, '0')}`,
          vehicleModel: 'Load Test',
        })),
      });
    }
  }
  console.log(`users ready: ${total} (${drivers} drivers), ${made} new, in ${Date.now() - started} ms`);
}

async function cleanup() {
  const redis = new RedisClient(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
  await redis.connect();
  const drivers = await prisma.driver.findMany({ where: { user: { privyDid: { startsWith: 'loadtest:' } } }, select: { id: true, userId: true } });
  const users = await prisma.user.findMany({ where: { privyDid: { startsWith: 'loadtest:' } }, select: { id: true } });
  for (let i = 0; i < drivers.length; i += 500) {
    const part = drivers.slice(i, i + 500);
    await redis.send('ZREM', 'drivers:geo', ...part.map((d) => d.id));
    await redis.send('ZREM', 'gateway:driver-offline:due', ...part.map((d) => d.id));
    await redis.send('HDEL', 'gateway:driver-offline:meta', ...part.map((d) => d.id));
    await redis.send('DEL', ...part.flatMap((d) => [`driver:presence:${d.id}`, `driver:dbflush:${d.id}`]));
  }
  for (let i = 0; i < users.length; i += 500) {
    const part = users.slice(i, i + 500);
    await redis.send('DEL', ...part.flatMap((u) => [`gateway:user:${u.id}:sockets`, `gateway:user:${u.id}:instances`]));
  }
  const ids = drivers.map((d) => d.id);
  const userIds = users.map((u) => u.id);
  // Open rides in this database were offered to these drivers as they came online.
  const notices = await prisma.notification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => ({ count: 0 }));
  if (notices.count > 0) console.log(`removed ${notices.count} notifications`);
  const points = await prisma.driverLocationPoint.deleteMany({ where: { driverId: { in: ids } } });
  const removedDrivers = await prisma.driver.deleteMany({ where: { id: { in: ids } } });
  const removedUsers = await prisma.user.deleteMany({ where: { privyDid: { startsWith: 'loadtest:' } } });
  await redis.disconnect();
  console.log(`removed ${removedUsers.count} users, ${removedDrivers.count} drivers, ${points.count} trail points, and their Redis keys`);
}

// ── Measuring ───────────────────────────────────────────────────────────────

function series() {
  const values = [];
  return {
    add: (v) => values.push(v),
    get count() { return values.length; },
    summary() {
      if (values.length === 0) return { count: 0 };
      const sorted = Float64Array.from(values).sort();
      const at = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
      return { count: sorted.length, p50: at(50), p95: at(95), p99: at(99), max: Math.round(sorted[sorted.length - 1]) };
    },
    reset: () => { values.length = 0; },
  };
}

/** The processes that are the gateway: whoever listens on its port, and their children (cluster mode). */
let gatewayPids = null;
function findGatewayPids(match) {
  const found = new Set();
  if (args['gateway-pids']) return new Set(String(args['gateway-pids']).split(',').map(Number));
  const gatewayPort = new URL(options.targets[0].replace(/^ws/, 'http')).port;
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${gatewayPort}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const pid of out.split('\n').map(Number).filter(Boolean)) found.add(pid);
  } catch { /* no lsof, or nothing listening here */ }
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const rows = out.split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean);
    if (found.size === 0) {
      for (const m of rows) if (m[3].includes(match) && !m[3].includes('ws-load-test') && !m[3].includes('run-with-env')) found.add(Number(m[1]));
    }
    let grew = true;
    while (grew) {
      grew = false;
      for (const m of rows) if (found.has(Number(m[2])) && !found.has(Number(m[1]))) { found.add(Number(m[1])); grew = true; }
    }
  } catch { /* no ps */ }
  return found;
}

function gatewayProcesses(match) {
  try {
    if (gatewayPids === null || gatewayPids.size === 0) gatewayPids = findGatewayPids(match);
    const out = execFileSync('ps', ['-axo', 'pid=,rss=,pcpu=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return out.split('\n')
      .map((line) => /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line))
      .filter((m) => m && gatewayPids.has(Number(m[1])))
      .map((m) => ({ pid: Number(m[1]), rssMb: Math.round(Number(m[2]) / 1024), cpu: Number(m[3]) }));
  } catch {
    return [];
  }
}

async function driverRowWrites() {
  try {
    const rows = await prisma.$queryRaw`
      SELECT (SELECT n_tup_upd FROM pg_stat_user_tables WHERE relname = 'Driver')::float8 AS "driverUpdates",
             (SELECT n_tup_ins FROM pg_stat_user_tables WHERE relname = 'DriverLocationPoint')::float8 AS "trailInserts",
             (SELECT xact_commit FROM pg_stat_database WHERE datname = current_database())::float8 AS "commits"`;
    return rows[0];
  } catch {
    return null;
  }
}

// ── A phone ─────────────────────────────────────────────────────────────────

const counts = {
  open: 0, connecting: 0, everOpened: 0, connectFailures: 0, refusedBusy: 0, refusedAuth: 0,
  closes: 0, reconnects: 0, pings: 0, errorsFromServer: 0, rateLimited: 0,
  httpOk: 0, httpFailed: 0, sent: 0, acked: 0, neverAnswered: 0,
};
const closeCodes = {};
const connectMs = series();
const reconnectMs = series();
const ackMs = series();
const httpMs = series();
let stopping = false;
let storm = null;

const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

function retryDelay(attempt) {
  if (options.fixedRetryMs !== null) return options.fixedRetryMs;
  const step = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 10));
  return step / 2 + (step / 2) * Math.random();
}

class Phone {
  constructor(index, isDriver) {
    this.index = index;
    this.isDriver = isDriver;
    this.token = local.createLocalAccessToken(userIdFor(index), process.env.JWT_SECRET);
    this.target = options.targets[index % options.targets.length];
    this.attempt = 0;
    this.socket = null;
    this.waiting = new Map();
    this.timer = null;
    this.lostAt = null;
    this.lat = YABA.lat + (Math.random() - 0.5) * 0.2;
    this.lng = YABA.lng + (Math.random() - 0.5) * 0.2;
  }

  connect() {
    if (stopping) return;
    const started = performance.now();
    counts.connecting += 1;
    let settled = false;
    let opened = false;
    const socket = new WebSocket(`${this.target}/ws?token=${this.token}`, { perMessageDeflate: false, handshakeTimeout: 20_000 });
    this.socket = socket;

    const failed = (why) => {
      if (settled) return;
      settled = true;
      counts.connecting -= 1;
      counts.connectFailures += 1;
      if (why === 503) counts.refusedBusy += 1;
      if (why === 401) counts.refusedAuth += 1;
      this.retry();
    };

    socket.on('unexpected-response', (_req, res) => { res.resume(); failed(res.statusCode); _req.destroy(); });
    socket.on('error', () => failed('error'));
    socket.on('ping', () => { counts.pings += 1; });

    socket.on('open', () => {
      if (settled) return;
      settled = true;
      opened = true;
      counts.connecting -= 1;
      counts.open += 1;
      counts.everOpened += 1;
      connectMs.add(performance.now() - started);
      if (this.lostAt !== null) {
        reconnectMs.add(performance.now() - this.lostAt);
        counts.reconnects += 1;
        this.lostAt = null;
        if (storm) storm.back += 1;
      }
      // The app calls a connection that lasted ten seconds a good one and starts its waits over.
      this.stable = setTimeout(() => { this.attempt = 0; }, 10_000);
      if (this.isDriver) {
        this.say('driver:online', { lat: this.lat, lng: this.lng, vehiclePlate: `LT${this.index}`, vehicleModel: 'Load Test' });
        // Each phone beats on its own clock, not all on the same second.
        const beat = options.heartbeatSeconds * 1000;
        this.timer = setTimeout(() => {
          this.beat();
          this.timer = setInterval(() => this.beat(), beat);
        }, Math.random() * beat);
      }
    });

    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.type === 'error') {
        counts.errorsFromServer += 1;
        if (message.payload?.code === 'RATE_LIMITED') counts.rateLimited += 1;
      }
      if (typeof message.type !== 'string') return;
      // "driver:gps:accepted" answers "driver:gps"; an error answers whatever has waited longest.
      let queue = message.type.endsWith(':accepted') ? this.waiting.get(message.type.slice(0, -':accepted'.length)) : undefined;
      if (message.type === 'error') {
        for (const candidate of this.waiting.values()) {
          if (candidate.length > 0 && (!queue || queue.length === 0 || candidate[0] < queue[0])) queue = candidate;
        }
      }
      const sentAt = queue?.shift();
      if (sentAt !== undefined) {
        counts.acked += 1;
        ackMs.add(performance.now() - sentAt);
      }
    });

    socket.on('close', (code) => {
      clearTimeout(this.stable);
      clearTimeout(this.timer);
      clearInterval(this.timer);
      for (const queue of this.waiting.values()) counts.neverAnswered += queue.length;
      this.waiting = new Map();
      // An attempt that never opened has already been counted, and retried, as a failure.
      if (!opened) { failed('closed'); return; }
      counts.open -= 1;
      if (stopping) return;
      counts.closes += 1;
      closeCodes[code] = (closeCodes[code] || 0) + 1;
      if (this.lostAt === null) this.lostAt = performance.now();
      this.retry();
    });
  }

  retry() {
    if (stopping) return;
    const wait = retryDelay(this.attempt);
    this.attempt += 1;
    setTimeout(() => this.connect(), wait);
  }

  say(type, payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const queue = this.waiting.get(type) ?? [];
    queue.push(performance.now());
    this.waiting.set(type, queue);
    counts.sent += 1;
    this.socket.send(JSON.stringify({ type, payload }));
  }

  beat() {
    // A car that moves a little between beats.
    this.lat += (Math.random() - 0.5) * 0.0006;
    this.lng += (Math.random() - 0.5) * 0.0006;
    this.say('driver:gps', { lat: this.lat, lng: this.lng });
    this.post();
  }

  post() {
    const base = new URL(this.target.replace(/^ws/, 'http'));
    const body = JSON.stringify({ lat: this.lat, lng: this.lng });
    const started = performance.now();
    const request = http.request({
      agent, host: base.hostname.replace(/^\[|\]$/g, ''), port: base.port, path: '/drivers/me/location', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `Bearer ${this.token}` },
      timeout: 15_000,
    }, (res) => {
      res.resume();
      res.on('end', () => {
        if (res.statusCode === 200) { counts.httpOk += 1; httpMs.add(performance.now() - started); }
        else counts.httpFailed += 1;
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', () => { counts.httpFailed += 1; });
    request.end(body);
  }

  cut() {
    this.socket?.terminate();
  }

  close() {
    clearTimeout(this.timer);
    clearInterval(this.timer);
    try { this.socket?.close(1000); } catch { /* gone */ }
  }
}

// ── The run ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (args.cleanup) {
    await cleanup();
    return;
  }
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not set.');

  const total = options.connections;
  const drivers = Math.round(total * options.driverShare);
  console.log(`\nload test${options.label ? ` "${options.label}"` : ''}: ${total} sockets (${drivers} drivers, ${total - drivers} riders) against ${options.targets.join(', ')}`);
  console.log(`ramp ${options.rampPerSecond}/s, hold ${options.holdSeconds}s, heartbeat every ${options.heartbeatSeconds}s${options.stormAtSeconds !== null ? `, all sockets cut at ${options.stormAtSeconds}s` : ''}`);
  await seed(options.offset + total, options.offset + drivers);

  // The matching probe reads the same index the services do.
  const probeRedis = new RedisClient(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
  await probeRedis.connect();
  driverPresence.configure((...a) => probeRedis.send(...a));
  const matchMs = series();
  let matchFound = 0;

  // Is this script itself keeping up? If its own clock slips, its numbers are its own fault.
  const lagMs = series();
  let lagAt = performance.now();
  const lagTimer = setInterval(() => {
    const now = performance.now();
    lagMs.add(Math.max(0, now - lagAt - 100));
    lagAt = now;
  }, 100);

  const samples = [];
  const startedAt = Date.now();
  const before = gatewayProcesses(options.gatewayMatch);
  if (before.length === 0) console.log(`(no process matching "${options.gatewayMatch}" on this machine: memory and CPU will not be sampled)`);
  else console.log(`gateway before: ${before.map((p) => `pid ${p.pid} ${p.rssMb} MB`).join(', ')}`);

  let phase = 'ramp';
  const status = setInterval(() => {
    const processes = gatewayProcesses(options.gatewayMatch);
    const ack = ackMs.summary();
    const sample = {
      t: Math.round((Date.now() - startedAt) / 1000), phase, open: counts.open, connecting: counts.connecting,
      failures: counts.connectFailures, ackP50: ack.p50 ?? null, ackP95: ack.p95 ?? null,
      gateway: processes,
    };
    samples.push(sample);
    console.log(
      `${String(sample.t).padStart(4)}s ${phase.padEnd(7)} open ${String(counts.open).padStart(6)}  connecting ${String(counts.connecting).padStart(5)}  failed ${String(counts.connectFailures).padStart(5)}` +
      `  ack p50/p95 ${ack.p50 ?? '-'}/${ack.p95 ?? '-'} ms  gateway ${processes.map((p) => `${p.rssMb}MB ${p.cpu}%`).join(' | ') || '-'}`,
    );
  }, 5_000);

  const probe = setInterval(() => {
    const started = performance.now();
    driverClient.findNearby(YABA.lat, YABA.lng, 5, 10)
      .then((found) => { matchMs.add(performance.now() - started); matchFound = Math.max(matchFound, found.length); })
      .catch(() => undefined);
  }, 2_000);

  // Ramp.
  const phones = [];
  const rampStarted = performance.now();
  const perTick = Math.max(1, Math.round(options.rampPerSecond / 20));
  for (let i = 0; i < total; i += perTick) {
    for (let k = i; k < Math.min(total, i + perTick); k += 1) {
      const phone = new Phone(options.offset + k, k < drivers);
      phones.push(phone);
      phone.connect();
    }
    await sleep(50);
  }
  // Let the stragglers finish (or give up waiting after a minute).
  const settleBy = Date.now() + 60_000;
  while (counts.open < total && Date.now() < settleBy) await sleep(250);
  const rampSeconds = (performance.now() - rampStarted) / 1000;
  const rampResult = {
    seconds: Math.round(rampSeconds * 10) / 10,
    open: counts.open,
    failures: counts.connectFailures,
    refusedBusy: counts.refusedBusy,
    connectMs: connectMs.summary(),
  };
  console.log(`\nramp done: ${counts.open}/${total} open in ${rampResult.seconds}s, ${counts.connectFailures} failed attempts (${counts.refusedBusy} told "busy")\n`);

  // Hold.
  phase = 'hold';
  ackMs.reset();
  const writesBefore = await driverRowWrites();
  const holdStarted = Date.now();
  let stormResult = null;
  let writesAtCut = null;
  let secondsAtCut = null;
  while (Date.now() - holdStarted < options.holdSeconds * 1000) {
    await sleep(500);
    const into = (Date.now() - holdStarted) / 1000;
    if (options.stormAtSeconds !== null && !storm && into >= options.stormAtSeconds) {
      phase = 'storm';
      // The steady state ends here: what Postgres wrote is counted up to this moment.
      writesAtCut = await driverRowWrites();
      secondsAtCut = (Date.now() - holdStarted) / 1000;
      const wasOpen = counts.open;
      const failuresBefore = counts.connectFailures;
      const busyBefore = counts.refusedBusy;
      storm = { back: 0 };
      reconnectMs.reset();
      const cutAt = performance.now();
      console.log(`\n── cutting all ${wasOpen} sockets at once ──\n`);
      for (const phone of phones) phone.cut();
      const marks = {};
      const giveUp = Date.now() + 180_000;
      while (Date.now() < giveUp) {
        await sleep(100);
        const share = storm.back / wasOpen;
        for (const mark of [0.5, 0.9, 0.99, 1]) {
          if (share >= mark && marks[mark] === undefined) marks[mark] = Math.round((performance.now() - cutAt) / 100) / 10;
        }
        if (storm.back >= wasOpen) break;
      }
      stormResult = {
        cut: wasOpen,
        back: storm.back,
        secondsToHalf: marks[0.5] ?? null,
        secondsTo90: marks[0.9] ?? null,
        secondsTo99: marks[0.99] ?? null,
        secondsToAll: marks[1] ?? null,
        failedAttempts: counts.connectFailures - failuresBefore,
        toldBusy: counts.refusedBusy - busyBefore,
        reconnectMs: reconnectMs.summary(),
      };
      console.log(`\n── back: ${storm.back}/${wasOpen}; half in ${stormResult.secondsToHalf}s, 99% in ${stormResult.secondsTo99}s, all in ${stormResult.secondsToAll}s; ${stormResult.failedAttempts} failed attempts ──\n`);
      phase = 'hold';
    }
  }
  const holdSeconds = (Date.now() - holdStarted) / 1000;
  const writesAfter = writesAtCut ?? (await driverRowWrites());
  const writeSeconds = secondsAtCut ?? holdSeconds;
  const after = gatewayProcesses(options.gatewayMatch);

  clearInterval(status);
  clearInterval(probe);
  clearInterval(lagTimer);

  const peak = {};
  for (const sample of samples) for (const p of sample.gateway) {
    peak[p.pid] = peak[p.pid] || { rssMb: 0, cpu: 0 };
    peak[p.pid].rssMb = Math.max(peak[p.pid].rssMb, p.rssMb);
    peak[p.pid].cpu = Math.max(peak[p.pid].cpu, p.cpu);
  }
  const rssBefore = before.reduce((sum, p) => sum + p.rssMb, 0);
  const rssPeak = Object.values(peak).reduce((sum, p) => sum + p.rssMb, 0);

  const overdue = performance.now() - 10_000;
  let unanswered = counts.neverAnswered;
  for (const phone of phones) for (const queue of phone.waiting.values()) unanswered += queue.filter((sentAt) => sentAt < overdue).length;

  const report = {
    label: options.label || null,
    at: new Date().toISOString(),
    asked: { sockets: total, drivers, riders: total - drivers, targets: options.targets, rampPerSecond: options.rampPerSecond, holdSeconds: options.holdSeconds },
    ramp: rampResult,
    hold: {
      seconds: Math.round(holdSeconds),
      openAtEnd: counts.open,
      socketsLost: counts.closes,
      closeCodes,
      serverPingsAnswered: counts.pings,
      messagesSent: counts.sent,
      messagesAnswered: counts.acked,
      messagesNeverAnswered: unanswered,
      answerMs: ackMs.summary(),
      httpHeartbeats: { ok: counts.httpOk, failed: counts.httpFailed, ms: httpMs.summary() },
      errorsFromServer: counts.errorsFromServer,
      rateLimited: counts.rateLimited,
    },
    storm: stormResult,
    matching: { searches: matchMs.count, ms: matchMs.summary(), mostDriversFound: matchFound },
    gateway: {
      processes: Object.entries(peak).map(([pid, p]) => ({ pid: Number(pid), peakRssMb: p.rssMb, peakCpu: p.cpu })),
      rssBeforeMb: rssBefore,
      rssPeakMb: rssPeak,
      kbPerSocket: counts.everOpened > 0 && rssPeak > rssBefore ? Math.round(((rssPeak - rssBefore) * 1024) / total) : null,
      rssAfterMb: after.reduce((sum, p) => sum + p.rssMb, 0),
    },
    postgres: writesBefore && writesAfter ? {
      measuredOverSeconds: Math.round(writeSeconds),
      driverRowUpdatesPerSecond: Math.round(((writesAfter.driverUpdates - writesBefore.driverUpdates) / writeSeconds) * 10) / 10,
      trailInsertsPerSecond: Math.round(((writesAfter.trailInserts - writesBefore.trailInserts) / writeSeconds) * 10) / 10,
      commitsPerSecond: Math.round(((writesAfter.commits - writesBefore.commits) / writeSeconds) * 10) / 10,
      oldDesignDriverRowUpdatesPerSecond: Math.round(((drivers * 3) / options.heartbeatSeconds) * 10) / 10,
    } : null,
    thisScript: { clockSlipMs: lagMs.summary(), rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024) },
  };

  console.log('\n' + JSON.stringify(report, null, 2));
  if (options.out) {
    fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    fs.writeFileSync(options.out, JSON.stringify({ ...report, samples }, null, 2));
    console.log(`\nwritten to ${options.out}`);
  }

  stopping = true;
  for (const phone of phones) phone.close();
  await sleep(1500);
  agent.destroy();
  await probeRedis.disconnect();
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
    process.exit(process.exitCode ?? 0);
  });
