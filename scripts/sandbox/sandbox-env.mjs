/**
 * The environment the sandbox runs under.
 *
 * The checked-in root `.env` holds LIVE credentials (Paystack money
 * APIs, Meta WhatsApp, Twilio, R2) and every service auto-loads it via
 * loadWorkspaceEnv(), which only fills keys that are undefined in the process
 * env. So the sandbox works by OVERRIDING the dangerous keys in the child
 * process env — the overrides win, everything else (e.g. the Google Maps key)
 * still comes from `.env`.
 *
 * What is neutralised and why:
 *  - Paystack → pointed at the local stub (paystack-stub.mjs). This is the
 *    real-money path: signup provisions virtual accounts, wallet-service
 *    escrows ride funds. wallet-service gets an EMPTY key, which its
 *    truthiness check treats as "no client" → ledger-only, zero network.
 *  - Resend / R2 → blanked (their schemas trim empty → undefined). No emails,
 *    storage routes return 503.
 *  - Meta / Twilio are left alone: their schemas reject empty strings, and on
 *    a fresh sandbox Redis no rider is a WhatsApp rider and no OTP path runs,
 *    so nothing ever calls them from the app flow.
 *
 * State isolation: a dedicated docker compose project (wheelers-sandbox) on
 * its own ports and volumes — nothing shared with production, normal local
 * dev, or any other stack on this machine.
 */

export const SANDBOX = {
  gatewayPort: 4000,
  paystackStubPort: 4011,
  databaseUrl: 'postgresql://postgres:postgres@localhost:55433/wheelers_sandbox',
  redisUrl: 'redis://localhost:56380/1',
  kafkaBrokers: 'localhost:29093',
  jwtSecret: 'wheelers-sandbox-jwt-secret-not-for-production-0001',
  adminApiKey: 'sandbox-admin',
  baseUrl: 'http://127.0.0.1:4000',
};

/** @param {string} service workspace app name, e.g. 'api-gateway' */
export function sandboxEnv(service) {
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    DATABASE_URL: SANDBOX.databaseUrl,
    REDIS_URL: SANDBOX.redisUrl,
    // wallet-service and notification-worker default to :9092 — always explicit.
    KAFKA_BROKERS: SANDBOX.kafkaBrokers,
    PORT: String(SANDBOX.gatewayPort),
    JWT_SECRET: SANDBOX.jwtSecret,
    ADMIN_API_KEY: SANDBOX.adminApiKey,
    // A phone locked to a background tab shouldn't be dropped mid-test.
    WS_IDLE_TIMEOUT_MS: '600000',
    // Money: local stub instead of the live fiat API.
    PAYSTACK_SECRET_KEY: 'sk_test_sandbox_stub_key',
    PAYSTACK_BASE_URL: `http://127.0.0.1:${SANDBOX.paystackStubPort}`,
    // Blank = undefined after these schemas' trim transform.
    RESEND_API_KEY: '',
    R2_ACCOUNT_ID: '',
    R2_ACCESS_KEY_ID: '',
    R2_SECRET_ACCESS_KEY: '',
    R2_BUCKET: '',
    KAFKAJS_NO_PARTITIONER_WARNING: '1',
  };

  return env;
}
