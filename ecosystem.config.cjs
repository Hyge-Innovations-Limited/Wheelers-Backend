const fs = require("fs");
const path = require("path");

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const content = fs.readFileSync(filePath, "utf8");
  const result = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = rawLine.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = rawLine.slice(0, separatorIndex).trim();
    const value = rawLine.slice(separatorIndex + 1).trim();
    result[key] = value.replace(/^['"]|['"]$/g, "");
  }

  return result;
}

const cwd = __dirname;
const workspaceEnv = parseEnvFile(path.join(cwd, ".env"));
const mergedEnv = {
  ...workspaceEnv,
  ...process.env,
};

/**
 * What pm2 is given — deliberately NOT the contents of .env.
 *
 * This file used to spread every .env value into each app's pm2 env. pm2
 * SAVES that, and every service only reads a key from .env when it is not
 * already set — so pm2's stale copy silently beat the file. Editing .env and
 * restarting changed nothing: a development ngrok address kept being sent to
 * riders, and a lowered connection_limit never applied.
 *
 * Every service calls loadWorkspaceEnv() at boot and reads .env itself. So
 * pm2 carries only what .env does NOT say; the file is the single source of
 * truth, and ANY restart picks up an edit.
 */
const fallbackEnv = {};

if (!workspaceEnv.DATABASE_URL && !process.env.DATABASE_URL) {
  const user = mergedEnv.POSTGRES_USER || "postgres";
  const password = mergedEnv.POSTGRES_PASSWORD || "postgres";
  const database = mergedEnv.POSTGRES_DB || "wheelers";
  fallbackEnv.DATABASE_URL = mergedEnv.DATABASE_URL = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(
    password,
  )}@localhost:5432/${encodeURIComponent(database)}`;
}

if (!workspaceEnv.REDIS_URL && !process.env.REDIS_URL) {
  fallbackEnv.REDIS_URL = mergedEnv.REDIS_URL = "redis://localhost:6379";
}

if (!workspaceEnv.KAFKA_BROKERS && !process.env.KAFKA_BROKERS) {
  fallbackEnv.KAFKA_BROKERS = mergedEnv.KAFKA_BROKERS = "localhost:29092";
}

function app(name, args, extraEnv = {}) {
  return {
    name,
    cwd,
    script: "npm",
    args,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000,
    env: {
      // This IS the production process manager. It used to be listed first and
      // then overridden by a "development" left in .env.
      NODE_ENV: "production",
      KAFKAJS_NO_PARTITIONER_WARNING: "1",
      ...fallbackEnv,
      ...extraEnv,
    },
  };
}

module.exports = {
  apps: [
    app("api-gateway", "run start:api-gateway", workspaceEnv.PORT ? {} : { PORT: "3000" }),
    app("ride-service", "run start:ride-service"),
    app("group-ride", "run start:group-ride"),
    app("payment-service", "run start:payment-service"),
    app("wallet-service", "run start:wallet-service"),
    app("notification-worker", "run start:notification-worker"),
    app("analytics-worker", "run start:analytics-worker"),
    app("mcp-server", "run start:mcp-server", {
      ...(workspaceEnv.MCP_PORT ? {} : { MCP_PORT: "3020" }),
      ...(workspaceEnv.MCP_GATEWAY_BASE_URL
        ? {}
        : { MCP_GATEWAY_BASE_URL: `http://127.0.0.1:${mergedEnv.PORT || "3000"}` }),
    }),
  ],
};
