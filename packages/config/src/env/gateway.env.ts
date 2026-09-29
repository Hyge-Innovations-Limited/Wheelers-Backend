import { z } from 'zod';

/** Where the API and its hosted pages live in production. */
export const PUBLIC_BASE_URL_DEFAULT = 'https://app.wheelersng.com';

const GatewayEnvSchema = z.object({
  PORT:               z.string().default('3000'),
  AWS_REGION:         z.string().min(1).optional(),
  JWT_SECRET:         z.string().min(32),
  WHATSAPP_GATEWAY_URL: z.string().url().optional(),
  WHATSAPP_GATEWAY_TOKEN: z.string().min(1).optional(),
  WHATSAPP_OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
  TWILIO_AUTH_TOKEN:  z.string().min(1).optional(),
  TWILIO_FROM_NUMBER: z.string().min(1).optional(),
  GROQ_API_KEY:       z.string().min(1).optional(),
  // Gemini is the bot's primary model when set; Groq then only answers when
  // Gemini cannot. Unset = Groq only, exactly as before.
  GEMINI_API_KEY:      z.string().min(1).optional(),
  GEMINI_MODEL:        z.string().min(1).optional(),
  GEMINI_INTENT_MODEL: z.string().min(1).optional(),
  // llama-3.3-70b-versatile was decommissioned by Groq — every ride-intent
  // parse failed with "model does not exist" and silently fell back to regex,
  // so "take me from Ikeja to Lekki" was only understood when it matched a
  // hard-coded pattern. Measured ~0.8-2.2s, inside GROQ_TIMEOUT_MS.
  GROQ_MODEL:         z.string().min(1).default('openai/gpt-oss-120b'),
  GROQ_TIMEOUT_MS:    z.coerce.number().int().positive().default(6000),
  // The PUBLIC address riders are sent to (wallet pages, KYC). It ends up in
  // links inside WhatsApp, so it must be the real domain.
  APP_BASE_URL:       z.string().url().default(PUBLIC_BASE_URL_DEFAULT),
  TWILIO_WHATSAPP_NUMBER: z.string().min(1).optional(),
  // Twilio Verify issues and checks the code itself — no template approval on
  // either side, which is the wall Meta's AUTHENTICATION category puts up.
  TWILIO_VERIFY_SERVICE_SID: z.string().optional().transform(v => v?.trim() || undefined),
  // Cheapest reachable channel first. Unknown or unconfigured names are skipped.
  OTP_CHANNEL_ORDER: z.string().optional().transform(v => v?.trim() || undefined),
  TWILIO_KYC_CONTENT_SID: z.string().min(1).optional(),
  // WhatsApp Flows
  WHATSAPP_FLOW_PRIVATE_KEY: z.string().min(1).optional(),
  // The forms that are ON are the ones whose id is set: WHATSAPP_EDIT_TRIP_FLOW_ID,
  // WHATSAPP_OFFERS_FORM_FLOW_ID, WHATSAPP_QUICK_ACTIONS_FLOW_ID. The two original
  // flows (booking + "Driver Offers", the ids below) stay off unless this says so.
  WHATSAPP_LEGACY_FLOWS_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  WHATSAPP_FLOW_ID: z.string().min(1).optional(),
  WHATSAPP_OFFERS_FLOW_ID: z.string().min(1).optional(),
  WHATSAPP_EDIT_TRIP_FLOW_ID: z.string().min(1).optional(),
  WHATSAPP_OFFERS_FORM_FLOW_ID: z.string().min(1).optional(),
  WHATSAPP_QUICK_ACTIONS_FLOW_ID: z.string().min(1).optional(),
  WHATSAPP_DRIVER_PROFILE_FLOW_ID: z.string().min(1).optional(),
  WHATSAPP_FLOW_CONTENT_SID: z.string().min(1).optional(),
  WHATSAPP_RIDE_SEARCH_FLOW_PRIVATE_KEY: z.string().min(1).optional(),
  WHATSAPP_RIDE_SEARCH_FLOW_ID: z.string().min(1).optional(),
  META_ACCESS_TOKEN: z.string().min(1).optional(),
  META_PHONE_NUMBER_ID: z.string().min(1).optional(),
  META_APP_SECRET: z.string().min(1).optional(),
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(1).optional(),
  // Approved WhatsApp AUTHENTICATION template for sign-in codes (Meta only
  // delivers free-form text within 24h of the rider's last message).
  META_OTP_TEMPLATE_NAME: z.string().optional().transform(v => v?.trim() || undefined),
  META_OTP_TEMPLATE_LANGUAGE: z.string().min(2).default('en_US'),
  // Paystack: dedicated deposit accounts, transfers, and the webhook that
  // reports both. One secret key signs requests AND webhook bodies.
  PAYSTACK_SECRET_KEY: z.string().regex(/^sk_(test|live)_/, 'must be a Paystack secret key (sk_test_… or sk_live_…)'),
  PAYSTACK_BASE_URL: z.string().url().default('https://api.paystack.co'),
  // Which bank issues deposit accounts on a LIVE key. Test keys always use
  // Paystack's "test-bank", whatever this says.
  PAYSTACK_DVA_BANK: z.enum(['wema-bank', 'titan-paystack']).default('wema-bank'),
  PAYSTACK_CUSTOMER_EMAIL_DOMAIN: z.string().min(3).default('users.wheelersng.com'),
  // Wallet PIN on the MOBILE APP's withdrawal route. "required" (default):
  // no PIN, no withdrawal — an app build without the PIN screens must update.
  // "if_set": a user who never set a PIN may still withdraw without one; only
  // for the window while old builds are still in drivers' hands.
  APP_WITHDRAWAL_PIN_POLICY: z.enum(['required', 'if_set']).default('required'),
  // How long the admin map keeps a driver's trail before the nightly cleanup drops it.
  LOCATION_HISTORY_DAYS: z.coerce.number().int().positive().default(14),
  GOOGLE_MAPS_API_KEY: z.string().min(1),
  GOOGLE_MAPS_BASE_URL: z.string().url().default('https://routes.googleapis.com'),
  GROUP_RIDE_FACE_S3_BUCKET: z.string().min(1).optional(),
  GROUP_RIDE_FACE_S3_PREFIX: z.string().min(1).default('group-rides/face-verification'),
  GROUP_RIDE_FACE_UPLOAD_URL_TTL_S: z.coerce.number().int().positive().default(900),
  RIDER_KYC_S3_BUCKET: z.string().min(1).optional(),
  RIDER_KYC_S3_PREFIX: z.string().min(1).default('rider-kyc/face-verification'),
  SCHEDULED_RIDE_DISPATCH_LEAD_TIME_S: z.coerce.number().int().positive().default(300),
  CORS_ORIGINS:       z.string().default('http://localhost:19006,http://localhost:3000,https://app.wheelersng.com'),
  WS_IDLE_TIMEOUT_MS: z.string().default('60000'),
  // Limits on the socket server. A message larger than this closes the socket;
  // each socket may send this many messages a second, with a burst on top;
  // and this many sign-ins may be in flight at once before new ones are told
  // to come back (the apps wait and retry by themselves).
  WS_MAX_PAYLOAD_BYTES:     z.coerce.number().int().positive().default(128 * 1024),
  WS_RATE_LIMIT_PER_SECOND: z.coerce.number().positive().default(10),
  WS_RATE_LIMIT_BURST:      z.coerce.number().int().positive().default(40),
  WS_MAX_PENDING_UPGRADES:  z.coerce.number().int().positive().default(400),
  // 'true' logs every connect, close and message, as before. Off, the log gets
  // warnings and one summary line a minute.
  WS_VERBOSE_LOG: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // Stellar TESTNET (grant deliverable 3): a testnet mirror of every fare,
  // commission, top-up and driver withdrawal. Testnet only; see
  // apps/api-gateway/src/stellar/config.ts, which refuses anything else.
  STELLAR_ENABLED:     z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // Checked only when STELLAR_ENABLED is on (apps/api-gateway/src/stellar/config.ts,
  // which accepts "testnet" in any case and refuses anything else). A switched-off
  // feature must never stop the gateway booting.
  STELLAR_NETWORK:     z.string().optional(),
  STELLAR_MASTER_SEED: z.string().optional().transform(v => v?.trim() || undefined),
  STELLAR_NGN_PER_XLM: z.coerce.number().positive().default(1000),
  STELLAR_HORIZON_URL: z.string().optional(),
  // The rider's 4-digit trip code must be entered to start a trip. Switch on
  // only once drivers have the app with the keypad.
  TRIP_CODE_REQUIRED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // Minutes the trip chat stays open after a trip ends or is cancelled. 0 (the
  // default): it closes with the trip, on both sides at once.
  TRIP_CHAT_AFTER_TRIP_MINUTES: z.coerce.number().int().min(0).max(24 * 60).default(0),
  // Live call: the rider and driver of a trip call each other through Wheelers.
  // Off until the TURN server below is set; chat works either way.
  LIVE_CALL_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // Our own STUN/TURN server (coturn, infra/turn). The secret is the
  // static-auth-secret in /etc/turnserver.conf on that machine.
  TURN_HOST:          z.string().optional().transform(v => v?.trim() || undefined),
  TURN_SHARED_SECRET: z.string().optional().transform(v => v?.trim() || undefined),
  // How long one call's TURN login lasts. Longer than the longest call.
  TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().positive().default(2 * 60 * 60),
  // Social Auth
  APPLE_BUNDLE_ID:    z.string().optional().transform(v => v?.trim() || undefined),
  GOOGLE_CLIENT_ID:   z.string().optional().transform(v => v?.trim() || undefined),
  // Resend Email
  RESEND_API_KEY:     z.string().optional().transform(v => v?.trim() || undefined),
  // Cloudflare R2 Storage
  R2_ACCOUNT_ID:      z.string().optional().transform(v => v?.trim() || undefined),
  R2_ACCESS_KEY_ID:   z.string().optional().transform(v => v?.trim() || undefined),
  R2_SECRET_ACCESS_KEY: z.string().optional().transform(v => v?.trim() || undefined),
  R2_BUCKET:          z.string().optional().transform(v => v?.trim() || undefined),
});

export type GatewayEnv = z.infer<typeof GatewayEnvSchema>;

/**
 * A development tunnel in APP_BASE_URL is fine on a laptop and a disaster on
 * the server: riders were sent wallet links on an ngrok address — a domain
 * they have never seen, that dies when the tunnel does, asking for their PIN.
 * In production a tunnel or localhost address is refused and the real domain
 * is used instead, loudly.
 */
const TUNNEL_OR_LOCAL = /(^|\.)(ngrok(-free)?\.(io|app|dev)|ngrok\.com|trycloudflare\.com|loca\.lt|localtunnel\.me|serveo\.net)$|^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/i;

export function resolvePublicBaseUrl(configured: string, nodeEnv: string | undefined): string {
  let host = '';
  try {
    host = new URL(configured).hostname;
  } catch {
    return PUBLIC_BASE_URL_DEFAULT;
  }
  if (nodeEnv === 'production' && TUNNEL_OR_LOCAL.test(host)) {
    console.error(
      `[config] APP_BASE_URL points at "${host}", a tunnel/local address, while NODE_ENV=production. ` +
      `Riders would be sent links on that domain. Using ${PUBLIC_BASE_URL_DEFAULT} instead — fix APP_BASE_URL in .env.`,
    );
    return PUBLIC_BASE_URL_DEFAULT;
  }
  return configured.replace(/\/+$/, '');
}

export function validateGatewayEnv(): GatewayEnv {
  const result = GatewayEnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('[config] api-gateway env errors:\n', result.error.format());
    process.exit(1);
  }
  return { ...result.data, APP_BASE_URL: resolvePublicBaseUrl(result.data.APP_BASE_URL, process.env.NODE_ENV) };
}
