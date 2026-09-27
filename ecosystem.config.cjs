/**
 * pm2 process list for the Wheelers backend.
 *
 * Three rules this file holds to, each learned the hard way:
 *
 * 1. `.env` IS THE ONLY SOURCE OF SETTINGS. Nothing from it is handed to pm2.
 *    pm2 saves whatever env it is given, and every service only reads a key
 *    from `.env` when it is not already set — so a copy in pm2 silently beats
 *    the file. That once kept a development ngrok address going out to riders
 *    after `.env` had been corrected. Every service calls loadWorkspaceEnv()
 *    at boot and finds `.env` relative to its own code, so any restart picks
 *    up an edit, and no secret ever lands in ~/.pm2/dump.pm2.
 *
 * 2. pm2 RUNS NODE, NOT NPM. With `script: "npm"` pm2 supervises the npm
 *    wrapper: memory limits measure npm, signals reach npm first ("failed to
 *    kill — retrying" in the pm2 log), and a graceful shutdown is a race.
 *    Each app is `node dist/index.js` from its own folder — exactly what its
 *    `npm start` did — so pm2 now sees the real process.
 *
 * 3. A SERVICE MAY CRASH; IT MAY NOT STAY DOWN. Restarts back off (so a
 *    crash loop cannot melt a 2-core box) but never stop, and a process that
 *    leaks is recycled before Linux's OOM killer takes out something else.
 *
 * Apply a change to this file:   npm run pm2:reload
 * Apply a change to `.env`:       npm run pm2:restart   (checks `.env` first)
 */
const fs = require("fs");
const path = require("path");

const root = __dirname;

/** Only used to decide which FALLBACKS pm2 must supply — never to copy values. */
function keysIn(filePath) {
  if (!fs.existsSync(filePath)) return new Set();
  return new Set(
    fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.indexOf("=") > 0)
      .map((line) => line.slice(0, line.indexOf("=")).trim()),
  );
}

function valueOf(filePath, key) {
  if (!fs.existsSync(filePath)) return undefined;
  const line = fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith(`${key}=`));
  return line ? line.slice(line.indexOf("=") + 1).trim().replace(/^['"]|['"]$/g, "") : undefined;
}

const envFile = path.join(root, ".env");
const defined = keysIn(envFile);

// Supplied ONLY when `.env` is silent, so a bare checkout still boots.
const fallbackEnv = {};
if (!defined.has("DATABASE_URL")) fallbackEnv.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/wheelers";
if (!defined.has("REDIS_URL")) fallbackEnv.REDIS_URL = "redis://localhost:6379";
if (!defined.has("KAFKA_BROKERS")) fallbackEnv.KAFKA_BROKERS = "localhost:29092";

function app(name, { memory = "350M", extraEnv = {}, instances = 1 } = {}) {
  return {
    name,
    cwd: path.join(root, "apps", name),
    script: "dist/index.js",
    interpreter: "node",

    // More than one process shares the port (pm2 cluster mode). Each holds its
    // own sockets; a message for a user on another process crosses by Redis.
    ...(instances > 1 ? { instances, exec_mode: "cluster" } : {}),

    // Stay up.
    autorestart: true,
    min_uptime: "15s",               // shorter than this counts as a failed start
    exp_backoff_restart_delay: 500,  // 0.5s, 1s, 2s … capped at 15s; resets once stable
    max_restarts: 1000,              // effectively "never give up"; the backoff keeps it cheap
    max_memory_restart: memory,      // recycle a leak before the OOM killer picks a victim

    // Go down cleanly: Kafka consumers must leave their group, or the next
    // start waits out a ~25s session timeout before it is assigned anything.
    kill_timeout: 12000,

    // Logs you can read later.
    time: true,
    merge_logs: true,

    env: {
      NODE_ENV: "production",
      KAFKAJS_NO_PARTITIONER_WARNING: "1",
      ...fallbackEnv,
      ...extraEnv,
    },
  };
}

const gatewayPort = valueOf(envFile, "PORT") || "3000";

// How many gateway processes, and how much memory each may use before it is
// recycled. Both are about THIS machine, not about the app, so they are read
// from `.env` here and never handed on as environment.
//
//   GATEWAY_INSTANCES=2        one per CPU core the box can spare
//   GATEWAY_MAX_MEMORY=1000M   twice what a process was seen to need
//
// Measured with scripts/ws-load-test.mjs (30% drivers, heartbeats every 30 s):
//   20,000 sockets on two processes: ~410 MB each at the worst moment, answers
//   in 2 ms, everyone back 28 s after every socket was cut at once.
//   20,000 on one process: 490 MB, but a whole core busy, and 53 s to recover.
// The old 600M limit was inside that range: a process doing nothing wrong
// would have been restarted, dropping every socket it held.
//
// One process holding every socket is one restart away from dropping everyone
// at once; two halve that, and let a deploy roll one at a time.
const gatewayInstances = Math.max(1, Number.parseInt(valueOf(envFile, "GATEWAY_INSTANCES") || "1", 10) || 1);
const gatewayMemory = valueOf(envFile, "GATEWAY_MAX_MEMORY") || "600M";

module.exports = {
  apps: [
    // The gateway holds every driver socket and serves every request.
    app("api-gateway", {
      memory: gatewayMemory,
      instances: gatewayInstances,
      extraEnv: defined.has("PORT") ? {} : { PORT: "3000" },
    }),
    app("ride-service"),
    app("group-ride"),
    app("payment-service"),
    app("wallet-service"),
    app("notification-worker"),
    app("analytics-worker"),
    app("mcp-server", {
      memory: "250M",
      extraEnv: {
        ...(defined.has("MCP_PORT") ? {} : { MCP_PORT: "3020" }),
        ...(defined.has("MCP_GATEWAY_BASE_URL") ? {} : { MCP_GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}` }),
      },
    }),
  ],
};
