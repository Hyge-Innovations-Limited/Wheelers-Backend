import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { readFile } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
import {
  buildTopicList,
  createConsumer,
  createProducer,
  ensureTopics,
  onShutdown,
  registerShutdownHandlers,
  TOPIC_PRESETS,
} from "@wheleers/kafka-client";
import {
  GoogleMapsRoutePlanner,
  loadWorkspaceEnv,
  validateGatewayEnv,
  validateSharedEnv,
} from "@wheleers/config";
import { TOPICS } from "@wheleers/kafka-schemas";
import { Queue } from "bullmq";
import IORedis from "ioredis";

import {
  handleUsernamePasswordSigninRoute,
  handleUsernamePasswordSignupRoute,
} from "./http/auth.route";
import {
  handleAppleAuthRoute,
  handleGoogleAuthRoute,
} from "./http/social-auth.route";
import {
  handleLogoutRoute,
  handleDeleteAccountRoute,
} from "./http/account.route";
import {
  handleForgotPasswordRoute,
  handleVerifyResetCodeRoute,
  handleResetPasswordRoute,
} from "./http/password-reset.route";
import {
  handleGetCurrentProfileRoute,
  handleUpdateCurrentProfileRoute,
} from "./http/profile.route";
import {
  handleListNotificationsRoute,
  handleMarkNotificationsReadRoute,
  handleRegisterPushTokenRoute,
} from "./http/notification.route";
import {
  handleCancelScheduledRideRoute,
  handleCreateScheduledRideRoute,
  handleListScheduledRidesRoute,
  handleRideEstimateRoute,
  handleRiderRideHistoryRoute,
  handleGetRideRoute,
  handleActiveRideRoute,
} from "./http/ride.route";
import {
  handleGetDriverStatsRoute,
  handleGetDriverEarningsRoute,
  handleGetDriverRideHistoryRoute,
  handleGetDriverActiveRideRoute,
  handlePostDriverLocationRoute,
  handleDriverStandbyRoute,
  handlePostDriverStandbyLocationRoute,
  handleGetDriverBidsRoute,
} from "./http/driver.route";
import {
  handleDriverKycSubmitRoute,
  handleDriverKycStatusRoute,
} from "./http/driver-kyc.route";
import {
  handleAdminListDriversRoute,
  handleAdminGetDriverRoute,
  handleAdminApproveDriverRoute,
  handleAdminRejectDriverRoute,
  handleAdminFieldReviewRoute,
} from "./http/admin.route";
import {
  handleAdminLoginRoute,
  handleCreateAdminRoute,
} from "./http/admin-auth.route";
import {
  handleAdminPlatformStatsRoute,
  handleAdminDriverAnalyticsRoute,
  handleAdminRiderAnalyticsRoute,
  handleAdminRecentRidesRoute,
  handleAdminUserActivityRoute,
  handleAdminActivityFeedRoute,
} from "./http/admin-analytics.route";
import {
  handleCancelGroupRideMatchRequestRoute,
  handleCompleteGroupRideFaceUploadRoute,
  handleGroupRideFaceCheckRoute,
  handleCreateGroupRideFaceUploadUrlRoute,
  handleCreateGroupRideMatchRequestRoute,
  handleGetGroupRideMatchRequestRoute,
  handleListGroupRideMatchRequestsRoute,
} from "./http/group-ride.route";
import { handlePaystackWebhookRoute } from "./http/paystack.route";
import { handleWalletPageRoute } from "./http/wallet-page.route";
import { handleWalletSecurityRoute } from "./http/wallet-security.route";
import { attachRequestLog } from "./http/request-log";
import { handleRidePageRoute } from "./http/ride-page.route";
import { describeLlm } from "./LLM/llm";
import {
  handleLiveDriversRoute,
  handleLiveDriverDetailRoute,
  handleLiveDriverTrailRoute,
  handleLiveDispatchRoute,
  handleLiveNudgeRoute,
  handleLiveContactRoute,
  startLocationHistoryCleanup,
} from "./http/live-map.route";
import { sendMetaWhatsappMessage } from "./whatsapp-flows/whatsapp-notifier";
import { lookupUserIdByPhone } from "./whatsapp-flows/bid-state";
import {
  handleCreateWalletWithdrawalRoute,
  handleGetWalletWithdrawalRoute,
  handleListWithdrawalBankNetworksRoute,
  handleListWalletWithdrawalsRoute,
  handleProvisionVirtualAccountRoute,
  handleVerifyWithdrawalBankAccountRoute,
  handleWalletOverviewRoute,
  handleWalletTransactionsRoute,
  handleWalletDepositInfoRoute,
} from "./http/wallet.route";
import { PaymentsClient } from "@wheleers/payments";
import {
  handleListInterstateRoutesRoute,
  handleInterstateCitiesRoute,
  handleInterstateQuoteRoute,
  handleInterstateDeparturesRoute,
  handleCreateInterstateBookingRoute,
  handleCreateInterstateCharterRoute,
  handleListInterstateBookingsRoute,
  handleGetInterstateBookingRoute,
  handleCancelInterstateBookingRoute,
  handleListClaimableDeparturesRoute,
  handleListDriverDeparturesRoute,
  handleClaimDepartureRoute,
  handleStartDepartureRoute,
  handleCompleteDepartureRoute,
  handleDepartureManifestRoute,
  handleInterstateVehiclesRoute,
  handleCreateTravelRequestRoute,
  handleListInterstateOffersRoute,
  handleAcceptInterstateOfferRoute,
  handleDeclineInterstateOfferRoute,
} from "./http/interstate.route";
import {
  handleRaiseSafetyAlertRoute,
  handleActiveSafetyAlertRoute,
  handleListSafetyAlertsRoute,
  handleCancelSafetyAlertRoute,
} from "./http/safety.route";
import {
  handleAdminListUsersRoute,
  handleAdminGetUserRoute,
  handleAdminWithdrawalFreezeRoute,
  handleAdminOverviewRoute,
  handleAdminServiceUsageRoute,
  handleAdminTimeseriesRoute,
  handleAdminCancellationsRoute,
  handleAdminGroupRideMetricsRoute,
  handleAdminListRidesRoute,
  handleAdminListAlertsRoute,
  handleAdminAlertCountRoute,
  handleAdminAcknowledgeAlertRoute,
  handleAdminResolveAlertRoute,
} from "./http/admin-metrics.route";
import {
  handleSendPhoneOtpRoute,
  handleVerifyPhoneOtpRoute,
} from "./http/phone.route";
import {
  handlePhoneLoginSendOtpRoute,
  handlePhoneLoginVerifyOtpRoute,
} from "./http/phone-login.route";
import { handleMetaWhatsappWebhookRoute, handleMetaWhatsappVerify, createRidePageChatNotifier, createWhatsappDepositFinisher, createQuickActionsChatHooks } from "./http/whatsapp.route";
import {
  handleApplyReferralCodeRoute,
  handleGetReferralSummaryRoute,
  handleListReferralCashbackRoute,
  handleListReferralReferralsRoute,
  handlePreviewReferralRideCashbackRoute,
} from "./http/referral.route";
import {
  handleGetKycStatusRoute,
  handleVerifyKycRoute,
} from "./http/kyc.route";
import { handleGetRideChatMessagesRoute } from "./http/chat.route";
import { applyCorsHeaders, sendJson } from "./http/utils";
import { startGatewayKafkaConsumer } from "./kafka/consumer";
import { startGroupRideWaitNudgeSweep } from "./group-ride/wait-nudge";
// WhatsApp Flows (meta-flows branch): tappable booking forms riding on the
// same guarded handlers as the chat bot. main keeps these unmounted.
import { handleWhatsappFlowEndpoint } from "./whatsapp-flows/flow-endpoint";
import { meterOutboundCalls } from "./usage/service-usage";
import { handleRideSearchFlowEndpoint } from "./whatsapp-flows/ride-search-flow-endpoint";
import { RedisClient } from "./redis/client";
import { asRawProducer, startOutboxPublisher } from "./outbox/outbox-publisher";
import { GatewayPublisher } from "./websocket/publisher";
import { SocketRegistry } from "./websocket/registry";
import { createGatewayWebSocketServer } from "./websocket/server";
import { GroupRideFaceStorage } from "./storage/group-ride-face-storage";
import { RiderKycFaceStorage } from "./storage/rider-kyc-face-storage";
import { DriverKycStorage } from "./storage/driver-kyc-storage";
import { startReferralJobs } from "./referrals/jobs";

const SCHEDULED_RIDE_QUEUE = "wheleers-scheduled-rides";

function parseAllowedOrigins(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  );
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function sendMethodNotAllowed(res: ServerResponse): void {
  sendJson(res, 405, { error: "Method not allowed" });
}

const WIDGET_DIR = join(__dirname, "..", "widget");
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  // The bidding page wears the mobile app's typeface, served from here.
  ".ttf": "font/ttf",
};

// The live-trip map draws its pictures from a tile server; that host — and only
// that host — may be loaded as images. Derived from the same MAP_TILE_URL the
// page is told to use, so changing map provider is one setting, not two.
const MAP_TILE_ORIGIN = (() => {
  const template = (process.env.MAP_TILE_URL ?? "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").trim();
  try {
    const url = new URL(template.replace("{s}", "a").replace(/\{[^}]+\}/g, "0"));
    return `${url.protocol}//${template.includes("{s}") ? url.host.replace(/^a\./, "*.") : url.host}`;
  } catch {
    return "https://*.tile.openstreetmap.org";
  }
})();
const WIDGET_CSP =
  // Nothing is loaded from anywhere but us and the map tiles: the pages use the
  // system font stack, so Google Fonts is no longer allowed either.
  `default-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: ${MAP_TILE_ORIGIN}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;

async function serveWidgetFile(pathname: string, res: ServerResponse): Promise<void> {
  // Only allow known extensions to prevent path traversal / serving unexpected files
  const ext = extname(pathname);
  const contentType = MIME_TYPES[ext];
  if (!contentType) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  // Strip leading /widget/ and resolve against widget dir
  const relative = pathname.replace(/^\/widget\//, "");
  if (relative.includes("..") || relative.includes("\0")) {
    sendJson(res, 400, { error: "Invalid path" });
    return;
  }

  const filePath = resolve(WIDGET_DIR, relative);
  // Canonical path must stay inside WIDGET_DIR
  if (!filePath.startsWith(resolve(WIDGET_DIR) + "/")) {
    sendJson(res, 400, { error: "Invalid path" });
    return;
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
      // These pages handle money: never framed by another site, never leak
      // their address (the link token rides in the #fragment, which is not
      // sent anyway), and only ever load their own scripts.
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": WIDGET_CSP,
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

function getHeaderValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  return typeof value === "string" ? value : null;
}

function getClientIp(req: IncomingMessage): string | null {
  // Behind Cloudflare every connection comes FROM Cloudflare; the visitor's own
  // address is in this header. Only nginx can reach this port, so the header
  // is trusted — nobody else can forge it.
  const cloudflare = getHeaderValue(req, "cf-connecting-ip");
  if (cloudflare) return cloudflare.trim();
  const forwardedFor = getHeaderValue(req, "x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() || null;
  }

  return req.socket.remoteAddress ?? null;
}

function getSafePathForLog(url: URL): string {
  if (url.searchParams.size === 0) {
    return url.pathname;
  }

  const queryKeys = Array.from(url.searchParams.keys())
    .filter((key) => !/token|secret|password|authorization|otp|code/i.test(key))
    .sort();

  return queryKeys.length > 0
    ? `${url.pathname}?${queryKeys.map((key) => `${key}=<redacted>`).join("&")}`
    : url.pathname;
}

async function bootstrap(): Promise<void> {
  loadWorkspaceEnv();

  process.env["NODE_ENV"] ??= "development";
  process.env["KAFKA_CLIENT_ID"] ??= "api-gateway";
  process.env["KAFKA_BROKERS"] ??= "localhost:29092";
  process.env["DATABASE_URL"] ??=
    "postgresql://postgres:postgres@localhost:5432/wheelers";
  process.env["REDIS_URL"] ??= "redis://localhost:6379";

  const sharedEnv = validateSharedEnv();
  const gatewayEnv = validateGatewayEnv();

  // BullMQ dispatcher queue.
  // Gateway only enqueues scheduled rides.
  // Ride-service owns the worker that dispatches them.
  const dispatcherRedis = new IORedis(sharedEnv.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  const dispatcherQueue = new Queue(SCHEDULED_RIDE_QUEUE, {
    connection: dispatcherRedis,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 5_000,
      },
      removeOnComplete: {
        count: 200,
      },
      removeOnFail: {
        count: 500,
      },
    },
  });

  const leadTimeMs = gatewayEnv.SCHEDULED_RIDE_DISPATCH_LEAD_TIME_S * 1_000;

  registerShutdownHandlers("api-gateway");

  await ensureTopics(
    buildTopicList([
      [TOPICS.USER_EVENTS, TOPIC_PRESETS.STANDARD],
      [TOPICS.DRIVER_EVENTS, TOPIC_PRESETS.STANDARD],
      [TOPICS.RIDE_EVENTS, TOPIC_PRESETS.STANDARD],
      [TOPICS.PAYMENT_EVENTS, TOPIC_PRESETS.STANDARD],
      [TOPICS.WALLET_EVENTS, TOPIC_PRESETS.STANDARD],
      [TOPICS.NOTIFICATION_EVENTS, TOPIC_PRESETS.LOW_VOLUME],
      [TOPICS.COMPLIANCE_EVENTS, TOPIC_PRESETS.LOW_VOLUME],
      [TOPICS.CRYPTO_WALLET_EVENTS, TOPIC_PRESETS.LOW_VOLUME],
      [TOPICS.GPS_STREAM, TOPIC_PRESETS.GPS],
      [TOPICS.GPS_PROCESSED, TOPIC_PRESETS.GPS],
    ]),
  );

  const producer = await createProducer({
    serviceId: sharedEnv.KAFKA_CLIENT_ID,
  });

  const consumer = await createConsumer({
    groupId: sharedEnv.KAFKA_CLIENT_ID,
  });

  const redisCommandClient = new RedisClient(sharedEnv.REDIS_URL);
  const redisSubscriberClient = new RedisClient(sharedEnv.REDIS_URL);

  await redisCommandClient.connect();
  // Every outbound call to Google, Gemini, Groq, Paystack, Meta… is counted for /admin/usage/services.
  meterOutboundCalls(redisCommandClient);
  await redisSubscriberClient.connect();

  const publisher = new GatewayPublisher(producer);

  const paymentsClient = new PaymentsClient({
    secretKey: gatewayEnv.PAYSTACK_SECRET_KEY,
    baseUrl: gatewayEnv.PAYSTACK_BASE_URL,
    dvaBank: gatewayEnv.PAYSTACK_DVA_BANK,
    emailDomain: gatewayEnv.PAYSTACK_CUSTOMER_EMAIL_DOMAIN,
  });
  // "Your PIN was changed" goes to the rider's WhatsApp, whichever surface did it.
  const notifyUserOnWhatsapp =
    gatewayEnv.META_ACCESS_TOKEN && gatewayEnv.META_PHONE_NUMBER_ID
      ? (phone: string, message: string) =>
          sendMetaWhatsappMessage(
            { metaAccessToken: gatewayEnv.META_ACCESS_TOKEN!, metaPhoneNumberId: gatewayEnv.META_PHONE_NUMBER_ID! },
            phone,
            message,
          )
      : undefined;

  console.log("[api-gateway] payments: Paystack", {
    mode: paymentsClient.isTestMode ? "TEST" : "LIVE",
  });
  // Who answers the bot's questions — so "why is the bot slow/dumb today?" is
  // one glance at the boot log, not a guess.
  console.log("[api-gateway] language model:", describeLlm({
    groqApiKey: gatewayEnv.GROQ_API_KEY,
    groqModel: gatewayEnv.GROQ_MODEL,
    timeoutMs: gatewayEnv.GROQ_TIMEOUT_MS,
  }));

  const routePlanner = new GoogleMapsRoutePlanner(
    gatewayEnv.GOOGLE_MAPS_BASE_URL,
    gatewayEnv.GOOGLE_MAPS_API_KEY,
  );

  const r2Configured = !!(gatewayEnv.R2_ACCOUNT_ID && gatewayEnv.R2_ACCESS_KEY_ID && gatewayEnv.R2_SECRET_ACCESS_KEY && gatewayEnv.R2_BUCKET);

  const groupRideFaceStorage = r2Configured
    ? new GroupRideFaceStorage({
        accountId: gatewayEnv.R2_ACCOUNT_ID!,
        accessKeyId: gatewayEnv.R2_ACCESS_KEY_ID!,
        secretAccessKey: gatewayEnv.R2_SECRET_ACCESS_KEY!,
        bucket: gatewayEnv.R2_BUCKET!,
        prefix: gatewayEnv.GROUP_RIDE_FACE_S3_PREFIX,
        uploadUrlTtlSeconds: gatewayEnv.GROUP_RIDE_FACE_UPLOAD_URL_TTL_S,
      })
    : undefined;

  const riderKycFaceStorage = r2Configured
    ? new RiderKycFaceStorage({
        accountId: gatewayEnv.R2_ACCOUNT_ID!,
        accessKeyId: gatewayEnv.R2_ACCESS_KEY_ID!,
        secretAccessKey: gatewayEnv.R2_SECRET_ACCESS_KEY!,
        bucket: gatewayEnv.R2_BUCKET!,
        prefix: gatewayEnv.RIDER_KYC_S3_PREFIX,
      })
    : null;

  const driverKycStorage = r2Configured
    ? new DriverKycStorage({
        accountId: gatewayEnv.R2_ACCOUNT_ID!,
        accessKeyId: gatewayEnv.R2_ACCESS_KEY_ID!,
        secretAccessKey: gatewayEnv.R2_SECRET_ACCESS_KEY!,
        bucket: gatewayEnv.R2_BUCKET!,
        prefix: 'drivers/kyc',
      })
    : null;

  const registry = new SocketRegistry({
    instanceId: `${sharedEnv.KAFKA_CLIENT_ID}-${process.pid}-${Math.random()
      .toString(16)
      .slice(2, 8)}`,
    commandRedis: redisCommandClient,
    subscriberRedis: redisSubscriberClient,
  });

  await registry.start();

  const allowedOrigins = parseAllowedOrigins(gatewayEnv.CORS_ORIGINS);

  const scheduledRideDeps = {
    jwtSecret: gatewayEnv.JWT_SECRET,
    routePlanner,
    dispatcherQueue,
    leadTimeMs,
    redisClient: redisCommandClient,
  };

  const groupRideDeps = {
    jwtSecret: gatewayEnv.JWT_SECRET,
    routePlanner,
    publisher,
    redisClient: redisCommandClient,
    faceStorage: groupRideFaceStorage,
    // The app's selfie goes through the same vision check as the WhatsApp one.
    groqApiKey: gatewayEnv.GROQ_API_KEY,
    groqModel: gatewayEnv.GROQ_MODEL,
    groqTimeoutMs: gatewayEnv.GROQ_TIMEOUT_MS,
  };

  const walletDeps = {
    jwtSecret: gatewayEnv.JWT_SECRET,
    publisher,
    paymentsClient,
    redisClient: redisCommandClient,
    pinPolicy: gatewayEnv.APP_WITHDRAWAL_PIN_POLICY,
  };

  const kycDeps = {
    jwtSecret: gatewayEnv.JWT_SECRET,
    publisher,
    faceStorage: riderKycFaceStorage,
  };

  // The bidding page, the WhatsApp webhook and the deposit hook all talk to the
  // same chat, so they are built from the same settings.
  const buildMetaWhatsappDeps = () => ({
    jwtSecret: gatewayEnv.JWT_SECRET,
    publisher,
    paymentsClient,
    redisClient: redisCommandClient,
    routePlanner,
    googleMapsApiKey: gatewayEnv.GOOGLE_MAPS_API_KEY,
    metaAccessToken: gatewayEnv.META_ACCESS_TOKEN,
    metaPhoneNumberId: gatewayEnv.META_PHONE_NUMBER_ID,
    metaAppSecret: gatewayEnv.META_APP_SECRET,
    metaWebhookVerifyToken: gatewayEnv.META_WEBHOOK_VERIFY_TOKEN,
    groqApiKey: gatewayEnv.GROQ_API_KEY,
    groqModel: gatewayEnv.GROQ_MODEL,
    groqTimeoutMs: gatewayEnv.GROQ_TIMEOUT_MS,
    appBaseUrl: gatewayEnv.APP_BASE_URL,
    driverKycStorage: driverKycStorage ?? undefined,
    groupRideFaceStorage: groupRideFaceStorage ?? undefined,
    whatsappFlowId: gatewayEnv.WHATSAPP_FLOW_ID,
    whatsappOffersFlowId: gatewayEnv.WHATSAPP_OFFERS_FLOW_ID,
    whatsappEditTripFlowId: gatewayEnv.WHATSAPP_EDIT_TRIP_FLOW_ID,
    whatsappOffersFormFlowId: gatewayEnv.WHATSAPP_OFFERS_FORM_FLOW_ID,
    whatsappQuickActionsFlowId: gatewayEnv.WHATSAPP_QUICK_ACTIONS_FLOW_ID,
  });

  const server = createServer(async (req, res) => {
    const startedAt = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    attachRequestLog(req, res, getSafePathForLog(url), url.pathname, getClientIp(req), startedAt);

    try {
      applyCorsHeaders(req, res, allowedOrigins);

      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, {
          status: "ok",
          service: "api-gateway",
          timestamp: new Date().toISOString(),
        });
        return;
      }

    if (url.pathname === "/auth/signup") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleUsernamePasswordSignupRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
        publisher,
        paymentsClient,
        resendApiKey: gatewayEnv.RESEND_API_KEY,
      });

      return;
    }

    if (url.pathname === "/auth/signin") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleUsernamePasswordSigninRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      });

      return;
    }

    if (url.pathname === "/auth/forgot-password") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleForgotPasswordRoute(req, res, {
        redisClient: redisCommandClient,
        resendApiKey: gatewayEnv.RESEND_API_KEY,
      });

      return;
    }

    if (url.pathname === "/auth/verify-reset-code") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleVerifyResetCodeRoute(req, res, {
        redisClient: redisCommandClient,
      });

      return;
    }

    if (url.pathname === "/auth/reset-password") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleResetPasswordRoute(req, res, {
        redisClient: redisCommandClient,
      });

      return;
    }

    if (url.pathname === "/auth/apple") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleAppleAuthRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
        appleBundleId: gatewayEnv.APPLE_BUNDLE_ID,
        googleClientId: gatewayEnv.GOOGLE_CLIENT_ID,
        paymentsClient,
        resendApiKey: gatewayEnv.RESEND_API_KEY,
      });

      return;
    }

    if (url.pathname === "/auth/google") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleGoogleAuthRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
        appleBundleId: gatewayEnv.APPLE_BUNDLE_ID,
        googleClientId: gatewayEnv.GOOGLE_CLIENT_ID,
        paymentsClient,
        resendApiKey: gatewayEnv.RESEND_API_KEY,
      });

      return;
    }

    if (url.pathname === "/auth/me") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleGetCurrentProfileRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/auth/profile") {
      if (req.method !== "PUT") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleUpdateCurrentProfileRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/auth/logout") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleLogoutRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
        redisClient: redisCommandClient,
      });
      return;
    }

    if (url.pathname === "/auth/delete-account") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleDeleteAccountRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
        redisClient: redisCommandClient,
      });
      return;
    }

    if (url.pathname === "/referrals/me") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleGetReferralSummaryRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/referrals/apply") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleApplyReferralCodeRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/referrals/me/referrals") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleListReferralReferralsRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/referrals/me/cashback") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleListReferralCashbackRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/referrals/me/cashback/ride-preview") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handlePreviewReferralRideCashbackRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/notifications") {
      if (req.method === "GET") {
        await handleListNotificationsRoute(req, res, {
          jwtSecret: gatewayEnv.JWT_SECRET,
        }, url);
        return;
      }

      sendMethodNotAllowed(res);
      return;
    }

    if (url.pathname === "/notifications/read") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleMarkNotificationsReadRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/notifications/device") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleRegisterPushTokenRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    // Passwordless sign-in by phone (WhatsApp riders' identity) — unauthenticated.
    if (url.pathname === "/auth/phone/login/send-otp" || url.pathname === "/auth/phone/login/verify-otp") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }
      const phoneDeps = {
        jwtSecret: gatewayEnv.JWT_SECRET,
        redisClient: redisCommandClient,
        metaAccessToken: gatewayEnv.META_ACCESS_TOKEN,
        metaPhoneNumberId: gatewayEnv.META_PHONE_NUMBER_ID,
        metaOtpTemplateName: gatewayEnv.META_OTP_TEMPLATE_NAME,
        metaOtpTemplateLanguage: gatewayEnv.META_OTP_TEMPLATE_LANGUAGE,
        twilioAccountSid: gatewayEnv.TWILIO_ACCOUNT_SID,
        twilioAuthToken: gatewayEnv.TWILIO_AUTH_TOKEN,
        twilioFromNumber: gatewayEnv.TWILIO_FROM_NUMBER,
        twilioWhatsappNumber: gatewayEnv.TWILIO_WHATSAPP_NUMBER,
        twilioVerifyServiceSid: gatewayEnv.TWILIO_VERIFY_SERVICE_SID,
        otpChannelOrder: gatewayEnv.OTP_CHANNEL_ORDER,
        phoneOtpTtlSeconds: gatewayEnv.WHATSAPP_OTP_TTL_SECONDS,
      };
      if (url.pathname === "/auth/phone/login/send-otp") {
        await handlePhoneLoginSendOtpRoute(req, res, phoneDeps);
      } else {
        await handlePhoneLoginVerifyOtpRoute(req, res, {
          ...phoneDeps,
          onboarding: {
            jwtSecret: gatewayEnv.JWT_SECRET,
            publisher,
            paymentsClient,
          },
        });
      }
      return;
    }

    if (url.pathname === "/auth/phone/send-otp") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleSendPhoneOtpRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
        redisClient: redisCommandClient,
        metaAccessToken: gatewayEnv.META_ACCESS_TOKEN,
        metaPhoneNumberId: gatewayEnv.META_PHONE_NUMBER_ID,
        metaOtpTemplateName: gatewayEnv.META_OTP_TEMPLATE_NAME,
        metaOtpTemplateLanguage: gatewayEnv.META_OTP_TEMPLATE_LANGUAGE,
        twilioAccountSid: gatewayEnv.TWILIO_ACCOUNT_SID,
        twilioAuthToken: gatewayEnv.TWILIO_AUTH_TOKEN,
        twilioFromNumber: gatewayEnv.TWILIO_FROM_NUMBER,
        twilioWhatsappNumber: gatewayEnv.TWILIO_WHATSAPP_NUMBER,
        twilioVerifyServiceSid: gatewayEnv.TWILIO_VERIFY_SERVICE_SID,
        otpChannelOrder: gatewayEnv.OTP_CHANNEL_ORDER,
        phoneOtpTtlSeconds: gatewayEnv.WHATSAPP_OTP_TTL_SECONDS,
      });

      return;
    }

    if (url.pathname.startsWith("/ride-page/")) {
      const handled = await handleRidePageRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
        redisClient: redisCommandClient,
        publisher,
        paymentsClient,
        notifyChat: createRidePageChatNotifier(buildMetaWhatsappDeps()),
      }, url);
      if (handled) return;
    }

    if (url.pathname === "/webhooks/whatsapp") {
      const metaWhatsappDeps = {
        jwtSecret: gatewayEnv.JWT_SECRET,
        publisher,
        paymentsClient,
        redisClient: redisCommandClient,
        routePlanner,
        googleMapsApiKey: gatewayEnv.GOOGLE_MAPS_API_KEY,
        metaAccessToken: gatewayEnv.META_ACCESS_TOKEN,
        metaPhoneNumberId: gatewayEnv.META_PHONE_NUMBER_ID,
        metaAppSecret: gatewayEnv.META_APP_SECRET,
        metaWebhookVerifyToken: gatewayEnv.META_WEBHOOK_VERIFY_TOKEN,
        groqApiKey: gatewayEnv.GROQ_API_KEY,
        groqModel: gatewayEnv.GROQ_MODEL,
        groqTimeoutMs: gatewayEnv.GROQ_TIMEOUT_MS,
        appBaseUrl: gatewayEnv.APP_BASE_URL,
        driverKycStorage: driverKycStorage ?? undefined,
        groupRideFaceStorage: groupRideFaceStorage ?? undefined,
        whatsappFlowId: gatewayEnv.WHATSAPP_FLOW_ID,
        whatsappOffersFlowId: gatewayEnv.WHATSAPP_OFFERS_FLOW_ID,
        whatsappEditTripFlowId: gatewayEnv.WHATSAPP_EDIT_TRIP_FLOW_ID,
        whatsappOffersFormFlowId: gatewayEnv.WHATSAPP_OFFERS_FORM_FLOW_ID,
    whatsappQuickActionsFlowId: gatewayEnv.WHATSAPP_QUICK_ACTIONS_FLOW_ID,
      };

      if (req.method === "GET") {
        handleMetaWhatsappVerify(req, res, metaWhatsappDeps);
        return;
      }

      if (req.method === "POST") {
        await handleMetaWhatsappWebhookRoute(req, res, metaWhatsappDeps);
        return;
      }

      sendMethodNotAllowed(res);
      return;
    }

    if (url.pathname === "/webhooks/whatsapp-flow") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }
      if (!gatewayEnv.WHATSAPP_FLOW_PRIVATE_KEY) {
        sendJson(res, 404, { error: "WhatsApp Flows are not configured." });
        return;
      }
      await handleWhatsappFlowEndpoint(req, res, {
        redisClient: redisCommandClient,
        publisher,
        privateKeyPem: gatewayEnv.WHATSAPP_FLOW_PRIVATE_KEY,
        tokenSecret: gatewayEnv.JWT_SECRET,
        googleMapsApiKey: gatewayEnv.GOOGLE_MAPS_API_KEY,
        routePlanner,
        kycStorage: driverKycStorage ?? undefined,
        ...createQuickActionsChatHooks(buildMetaWhatsappDeps()),
        notifier:
          gatewayEnv.META_ACCESS_TOKEN && gatewayEnv.META_PHONE_NUMBER_ID
            ? {
                metaAccessToken: gatewayEnv.META_ACCESS_TOKEN,
                metaPhoneNumberId: gatewayEnv.META_PHONE_NUMBER_ID,
                offersFlowId: gatewayEnv.WHATSAPP_OFFERS_FLOW_ID,
                flowTokenSecret: gatewayEnv.JWT_SECRET,
                quickActionsFlowId: gatewayEnv.WHATSAPP_QUICK_ACTIONS_FLOW_ID,
                riderIdFor: (phone: string) => lookupUserIdByPhone(redisCommandClient, phone),
              }
            : undefined,
      });
      return;
    }

    if (url.pathname === "/webhooks/whatsapp-ride-search-flow") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }
      const rideSearchKey =
        gatewayEnv.WHATSAPP_RIDE_SEARCH_FLOW_PRIVATE_KEY ?? gatewayEnv.WHATSAPP_FLOW_PRIVATE_KEY;
      if (!rideSearchKey) {
        sendJson(res, 404, { error: "WhatsApp Flows are not configured." });
        return;
      }
      await handleRideSearchFlowEndpoint(req, res, {
        redisClient: redisCommandClient,
        publisher,
        privateKeyPem: rideSearchKey,
        tokenSecret: gatewayEnv.JWT_SECRET,
        googleMapsApiKey: gatewayEnv.GOOGLE_MAPS_API_KEY,
        routePlanner,
      });
      return;
    }




    if (url.pathname === "/auth/phone/verify-otp") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleVerifyPhoneOtpRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
        redisClient: redisCommandClient,
        paymentsClient,
        metaAccessToken: gatewayEnv.META_ACCESS_TOKEN,
        metaPhoneNumberId: gatewayEnv.META_PHONE_NUMBER_ID,
        metaOtpTemplateName: gatewayEnv.META_OTP_TEMPLATE_NAME,
        metaOtpTemplateLanguage: gatewayEnv.META_OTP_TEMPLATE_LANGUAGE,
        twilioAccountSid: gatewayEnv.TWILIO_ACCOUNT_SID,
        twilioAuthToken: gatewayEnv.TWILIO_AUTH_TOKEN,
        twilioFromNumber: gatewayEnv.TWILIO_FROM_NUMBER,
        twilioWhatsappNumber: gatewayEnv.TWILIO_WHATSAPP_NUMBER,
        twilioVerifyServiceSid: gatewayEnv.TWILIO_VERIFY_SERVICE_SID,
        otpChannelOrder: gatewayEnv.OTP_CHANNEL_ORDER,
        phoneOtpTtlSeconds: gatewayEnv.WHATSAPP_OTP_TTL_SECONDS,
      });

      return;
    }

    if (url.pathname === "/drivers/me/stats") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleGetDriverStatsRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/drivers/me/earnings") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleGetDriverEarningsRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      }, url);
      return;
    }

    if (url.pathname === "/drivers/me/location") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }
      await handlePostDriverLocationRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/drivers/me/standby") {
      if (req.method !== "GET" && req.method !== "PUT") {
        sendMethodNotAllowed(res);
        return;
      }
      await handleDriverStandbyRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/drivers/me/standby-location") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }
      await handlePostDriverStandbyLocationRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/drivers/me/bids") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleGetDriverBidsRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      }, url);
      return;
    }

    if (url.pathname === "/drivers/me/rides/active") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleGetDriverActiveRideRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/drivers/me/rides/history") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleGetDriverRideHistoryRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      }, url);
      return;
    }

    // ── Driver KYC routes ──────────────────────────────────────────────────

    if (url.pathname === "/drivers/kyc/submit") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      if (!driverKycStorage) {
        sendJson(res, 503, { error: 'KYC storage not configured' });
        return;
      }

      await handleDriverKycSubmitRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
        kycStorage: driverKycStorage,
      });
      return;
    }

    if (url.pathname === "/drivers/kyc/status") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleDriverKycStatusRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    // ── Admin auth routes ──────────────────────────────────────────────────

    if (url.pathname === "/admin/login") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleAdminLoginRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
        adminApiKey: process.env.ADMIN_API_KEY ?? '',
      });
      return;
    }

    if (url.pathname === "/admin/create-admin") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleCreateAdminRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
        adminApiKey: process.env.ADMIN_API_KEY ?? '',
      });
      return;
    }

    // ── Admin routes ──────────────────────────────────────────────────────

    if (url.pathname === "/admin/drivers") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      if (!driverKycStorage) {
        sendJson(res, 503, { error: 'Storage not configured' });
        return;
      }

      await handleAdminListDriversRoute(req, res, {
        adminApiKey: process.env.ADMIN_API_KEY ?? '',
        jwtSecret: gatewayEnv.JWT_SECRET,
        kycStorage: driverKycStorage,
      });
      return;
    }

    if (url.pathname.startsWith("/admin/drivers/")) {
      const approveMatch = url.pathname.match(/^\/admin\/drivers\/([^/]+)\/approve$/);
      if (approveMatch) {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res);
          return;
        }

        if (!driverKycStorage) {
          sendJson(res, 503, { error: 'Storage not configured' });
          return;
        }

        await handleAdminApproveDriverRoute(req, res, {
          adminApiKey: process.env.ADMIN_API_KEY ?? '',
          jwtSecret: gatewayEnv.JWT_SECRET,
          kycStorage: driverKycStorage,
          resendApiKey: gatewayEnv.RESEND_API_KEY,
        }, approveMatch[1]!);
        return;
      }

      const fieldReviewMatch = url.pathname.match(/^\/admin\/drivers\/([^/]+)\/field-review$/);
      if (fieldReviewMatch) {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res);
          return;
        }

        if (!driverKycStorage) {
          sendJson(res, 503, { error: 'Storage not configured' });
          return;
        }

        await handleAdminFieldReviewRoute(req, res, {
          adminApiKey: process.env.ADMIN_API_KEY ?? '',
          jwtSecret: gatewayEnv.JWT_SECRET,
          kycStorage: driverKycStorage,
        }, fieldReviewMatch[1]!);
        return;
      }

      const rejectMatch = url.pathname.match(/^\/admin\/drivers\/([^/]+)\/reject$/);
      if (rejectMatch) {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res);
          return;
        }

        if (!driverKycStorage) {
          sendJson(res, 503, { error: 'Storage not configured' });
          return;
        }

        await handleAdminRejectDriverRoute(req, res, {
          adminApiKey: process.env.ADMIN_API_KEY ?? '',
          jwtSecret: gatewayEnv.JWT_SECRET,
          kycStorage: driverKycStorage,
        }, rejectMatch[1]!);
        return;
      }

      const driverDetailMatch = url.pathname.match(/^\/admin\/drivers\/([^/]+)$/);
      if (driverDetailMatch) {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res);
          return;
        }

        if (!driverKycStorage) {
          sendJson(res, 503, { error: 'Storage not configured' });
          return;
        }

        await handleAdminGetDriverRoute(req, res, {
          adminApiKey: process.env.ADMIN_API_KEY ?? '',
          jwtSecret: gatewayEnv.JWT_SECRET,
          kycStorage: driverKycStorage,
        }, driverDetailMatch[1]!);
        return;
      }
    }

    // ── Interstate travel ──────────────────────────────────────────────────
    if (url.pathname.startsWith("/safety/alerts")) {
      const safetyDeps = { jwtSecret: gatewayEnv.JWT_SECRET, publisher };

      if (url.pathname === "/safety/alerts/active") {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res);
          return;
        }
        await handleActiveSafetyAlertRoute(req, res, safetyDeps, url);
        return;
      }

      const cancelAlertMatch = url.pathname.match(
        /^\/safety\/alerts\/([^/]+)\/cancel$/,
      );
      if (cancelAlertMatch) {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res);
          return;
        }
        await handleCancelSafetyAlertRoute(
          req,
          res,
          safetyDeps,
          decodeURIComponent(cancelAlertMatch[1]),
        );
        return;
      }

      if (url.pathname === "/safety/alerts") {
        if (req.method === "POST") {
          await handleRaiseSafetyAlertRoute(req, res, safetyDeps);
          return;
        }
        if (req.method === "GET") {
          await handleListSafetyAlertsRoute(req, res, safetyDeps);
          return;
        }
        sendMethodNotAllowed(res);
        return;
      }
    }

    if (url.pathname.startsWith("/interstate")) {
      const interstateDeps = {
        jwtSecret: gatewayEnv.JWT_SECRET,
        redisClient: redisCommandClient,
      };

      if (url.pathname === "/interstate/driver/available") {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res);
          return;
        }
        await handleListClaimableDeparturesRoute(req, res, interstateDeps, url);
        return;
      }

      if (url.pathname === "/interstate/driver/trips") {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res);
          return;
        }
        await handleListDriverDeparturesRoute(req, res, interstateDeps, url);
        return;
      }

      if (url.pathname === "/interstate/driver/offers") {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res);
          return;
        }
        await handleListInterstateOffersRoute(req, res, interstateDeps, url);
        return;
      }

      const acceptOfferMatch = url.pathname.match(
        /^\/interstate\/driver\/offers\/([^/]+)\/accept$/,
      );
      if (acceptOfferMatch) {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res);
          return;
        }
        await handleAcceptInterstateOfferRoute(
          req,
          res,
          interstateDeps,
          decodeURIComponent(acceptOfferMatch[1]),
        );
        return;
      }

      const declineOfferMatch = url.pathname.match(
        /^\/interstate\/driver\/offers\/([^/]+)\/decline$/,
      );
      if (declineOfferMatch) {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res);
          return;
        }
        await handleDeclineInterstateOfferRoute(
          req,
          res,
          interstateDeps,
          decodeURIComponent(declineOfferMatch[1]),
        );
        return;
      }

      const claimMatch = url.pathname.match(
        /^\/interstate\/driver\/departures\/([^/]+)\/claim$/,
      );
      if (claimMatch) {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res);
          return;
        }
        await handleClaimDepartureRoute(
          req,
          res,
          interstateDeps,
          decodeURIComponent(claimMatch[1]),
        );
        return;
      }

      const startMatch = url.pathname.match(
        /^\/interstate\/driver\/departures\/([^/]+)\/start$/,
      );
      if (startMatch) {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res);
          return;
        }
        await handleStartDepartureRoute(
          req,
          res,
          interstateDeps,
          decodeURIComponent(startMatch[1]),
        );
        return;
      }

      const completeMatch = url.pathname.match(
        /^\/interstate\/driver\/departures\/([^/]+)\/complete$/,
      );
      if (completeMatch) {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res);
          return;
        }
        await handleCompleteDepartureRoute(
          req,
          res,
          interstateDeps,
          decodeURIComponent(completeMatch[1]),
        );
        return;
      }

      const manifestMatch = url.pathname.match(
        /^\/interstate\/driver\/departures\/([^/]+)\/manifest$/,
      );
      if (manifestMatch) {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res);
          return;
        }
        await handleDepartureManifestRoute(
          req,
          res,
          interstateDeps,
          decodeURIComponent(manifestMatch[1]),
        );
        return;
      }

      if (url.pathname === "/interstate/vehicles") {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res);
          return;
        }
        await handleInterstateVehiclesRoute(req, res, interstateDeps, url);
        return;
      }

      if (url.pathname === "/interstate/requests") {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res);
          return;
        }
        await handleCreateTravelRequestRoute(req, res, interstateDeps);
        return;
      }

      if (url.pathname === "/interstate/routes") {
        if (req.method !== "GET") { sendMethodNotAllowed(res); return; }
        await handleListInterstateRoutesRoute(req, res, interstateDeps, url);
        return;
      }

      if (url.pathname === "/interstate/cities") {
        if (req.method !== "GET") { sendMethodNotAllowed(res); return; }
        await handleInterstateCitiesRoute(req, res, interstateDeps, url);
        return;
      }

      if (url.pathname === "/interstate/quote") {
        if (req.method !== "POST") { sendMethodNotAllowed(res); return; }
        await handleInterstateQuoteRoute(req, res, interstateDeps);
        return;
      }

      if (url.pathname === "/interstate/departures") {
        if (req.method !== "GET") { sendMethodNotAllowed(res); return; }
        await handleInterstateDeparturesRoute(req, res, interstateDeps, url);
        return;
      }

      if (url.pathname === "/interstate/charters") {
        if (req.method !== "POST") { sendMethodNotAllowed(res); return; }
        await handleCreateInterstateCharterRoute(req, res, interstateDeps);
        return;
      }

      if (url.pathname === "/interstate/bookings") {
        if (req.method === "POST") {
          await handleCreateInterstateBookingRoute(req, res, interstateDeps);
          return;
        }
        if (req.method === "GET") {
          await handleListInterstateBookingsRoute(req, res, interstateDeps, url);
          return;
        }
        sendMethodNotAllowed(res);
        return;
      }

      const cancelMatch = url.pathname.match(/^\/interstate\/bookings\/([^/]+)\/cancel$/);
      if (cancelMatch) {
        if (req.method !== "POST") { sendMethodNotAllowed(res); return; }
        await handleCancelInterstateBookingRoute(req, res, interstateDeps, decodeURIComponent(cancelMatch[1]));
        return;
      }

      const bookingMatch = url.pathname.match(/^\/interstate\/bookings\/([^/]+)$/);
      if (bookingMatch) {
        if (req.method !== "GET") { sendMethodNotAllowed(res); return; }
        await handleGetInterstateBookingRoute(req, res, interstateDeps, decodeURIComponent(bookingMatch[1]));
        return;
      }
    }

    // ── Admin panel: directory + metrics ───────────────────────────────────
    // adminDeps is rebuilt per request so a rotated ADMIN_API_KEY takes effect
    // without a restart, matching the other admin routes.
    {
      const adminDeps = {
        adminApiKey: process.env.ADMIN_API_KEY ?? '',
        jwtSecret: gatewayEnv.JWT_SECRET,
      };

      // ── Live map + dispatch ──
      if (url.pathname.startsWith("/admin/live/")) {
        const liveDeps = { ...adminDeps, publisher };
        const liveDriver = url.pathname.match(/^\/admin\/live\/drivers\/([^/]+)(?:\/(trail|nudge|contacts))?$/);
        const expectPost = liveDriver?.[2] === "nudge" || liveDriver?.[2] === "contacts";
        if (req.method !== (expectPost ? "POST" : "GET")) {
          sendMethodNotAllowed(res);
          return;
        }
        if (url.pathname === "/admin/live/drivers") {
          await handleLiveDriversRoute(req, res, liveDeps);
          return;
        }
        if (url.pathname === "/admin/live/dispatch") {
          await handleLiveDispatchRoute(req, res, liveDeps);
          return;
        }
        if (liveDriver) {
          const driverId = decodeURIComponent(liveDriver[1]);
          if (liveDriver[2] === "trail") await handleLiveDriverTrailRoute(req, res, liveDeps, driverId, url);
          else if (liveDriver[2] === "nudge") await handleLiveNudgeRoute(req, res, liveDeps, driverId);
          else if (liveDriver[2] === "contacts") await handleLiveContactRoute(req, res, liveDeps, driverId);
          else await handleLiveDriverDetailRoute(req, res, liveDeps, driverId);
          return;
        }
      }

      if (url.pathname === "/admin/users") {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res);
          return;
        }
        await handleAdminListUsersRoute(req, res, adminDeps, url);
        return;
      }

      const adminFreezeMatch = url.pathname.match(/^\/admin\/users\/([^/]+)\/withdrawals\/(freeze|unfreeze)$/);
      if (adminFreezeMatch) {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res);
          return;
        }
        await handleAdminWithdrawalFreezeRoute(
          req,
          res,
          adminDeps,
          decodeURIComponent(adminFreezeMatch[1]),
          adminFreezeMatch[2] as "freeze" | "unfreeze",
        );
        return;
      }

      const adminUserMatch = url.pathname.match(/^\/admin\/users\/([^/]+)$/);
      if (adminUserMatch) {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res);
          return;
        }
        await handleAdminGetUserRoute(
          req,
          res,
          adminDeps,
          decodeURIComponent(adminUserMatch[1]),
        );
        return;
      }

      if (url.pathname === "/admin/rides") {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res);
          return;
        }
        await handleAdminListRidesRoute(req, res, adminDeps, url);
        return;
      }

      if (url.pathname === "/admin/usage/services") {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res);
          return;
        }
        await handleAdminServiceUsageRoute(req, res, { ...adminDeps, redisClient: redisCommandClient }, url);
        return;
      }

      if (url.pathname === "/admin/metrics/overview") {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res);
          return;
        }
        await handleAdminOverviewRoute(req, res, adminDeps);
        return;
      }

      if (url.pathname === "/admin/metrics/timeseries") {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res);
          return;
        }
        await handleAdminTimeseriesRoute(req, res, adminDeps, url);
        return;
      }

      if (url.pathname === "/admin/metrics/group-rides") {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res);
          return;
        }
        await handleAdminGroupRideMetricsRoute(req, res, adminDeps);
        return;
      }

      if (url.pathname === "/admin/alerts") {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res);
          return;
        }
        await handleAdminListAlertsRoute(req, res, adminDeps, url);
        return;
      }

      if (url.pathname === "/admin/alerts/count") {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res);
          return;
        }
        await handleAdminAlertCountRoute(req, res, adminDeps);
        return;
      }

      const ackAlertMatch = url.pathname.match(
        /^\/admin\/alerts\/([^/]+)\/acknowledge$/,
      );
      if (ackAlertMatch) {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res);
          return;
        }
        await handleAdminAcknowledgeAlertRoute(
          req,
          res,
          adminDeps,
          decodeURIComponent(ackAlertMatch[1]),
        );
        return;
      }

      const resolveAlertMatch = url.pathname.match(
        /^\/admin\/alerts\/([^/]+)\/resolve$/,
      );
      if (resolveAlertMatch) {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res);
          return;
        }
        await handleAdminResolveAlertRoute(
          req,
          res,
          adminDeps,
          decodeURIComponent(resolveAlertMatch[1]),
        );
        return;
      }

      if (url.pathname === "/admin/metrics/cancellations") {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res);
          return;
        }
        await handleAdminCancellationsRoute(req, res, adminDeps);
        return;
      }
    }

    // ── Admin analytics routes ──────────────────────────────────────────────

    if (url.pathname === "/admin/analytics/platform") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleAdminPlatformStatsRoute(req, res, {
        adminApiKey: process.env.ADMIN_API_KEY ?? '',
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/admin/analytics/drivers") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleAdminDriverAnalyticsRoute(req, res, {
        adminApiKey: process.env.ADMIN_API_KEY ?? '',
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/admin/analytics/riders") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleAdminRiderAnalyticsRoute(req, res, {
        adminApiKey: process.env.ADMIN_API_KEY ?? '',
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/admin/analytics/recent-rides") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleAdminRecentRidesRoute(req, res, {
        adminApiKey: process.env.ADMIN_API_KEY ?? '',
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/admin/analytics/activity") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleAdminUserActivityRoute(req, res, {
        adminApiKey: process.env.ADMIN_API_KEY ?? '',
        jwtSecret: gatewayEnv.JWT_SECRET,
      }, url);
      return;
    }

    if (url.pathname === "/admin/analytics/activity-feed") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleAdminActivityFeedRoute(req, res, {
        adminApiKey: process.env.ADMIN_API_KEY ?? '',
        jwtSecret: gatewayEnv.JWT_SECRET,
      }, url);
      return;
    }

    // GET /rides/:rideId/messages — chat history
    if (url.pathname.startsWith("/rides/") && url.pathname.endsWith("/messages")) {
      const chatMatch = url.pathname.match(/^\/rides\/([^/]+)\/messages$/);
      if (chatMatch) {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res);
          return;
        }

        const handler = handleGetRideChatMessagesRoute({
          jwtSecret: gatewayEnv.JWT_SECRET,
        });
        await handler(req, res, { rideId: chatMatch[1] });
        return;
      }
    }

    if (url.pathname === "/rides/active") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }
      await handleActiveRideRoute(req, res, { jwtSecret: gatewayEnv.JWT_SECRET });
      return;
    }

    // GET /rides/:rideId — single ride detail (after the fixed /rides/* paths)
    const rideDetailMatch = url.pathname.match(/^\/rides\/([^/]+)$/);
    if (rideDetailMatch && !["estimate", "history", "active"].includes(rideDetailMatch[1])) {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }
      await handleGetRideRoute(
        req,
        res,
        { jwtSecret: gatewayEnv.JWT_SECRET },
        decodeURIComponent(rideDetailMatch[1]),
      );
      return;
    }

    if (url.pathname === "/rides/estimate") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleRideEstimateRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
        routePlanner,
      });

      return;
    }

    if (url.pathname === "/rides/history") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleRiderRideHistoryRoute(
        req,
        res,
        {
          jwtSecret: gatewayEnv.JWT_SECRET,
        },
        url,
      );

      return;
    }

    if (url.pathname === "/scheduled-rides") {
      if (req.method === "GET") {
        await handleListScheduledRidesRoute(req, res, scheduledRideDeps, url);
        return;
      }

      if (req.method === "POST") {
        await handleCreateScheduledRideRoute(req, res, scheduledRideDeps);
        return;
      }

      sendMethodNotAllowed(res);
      return;
    }

    if (url.pathname.startsWith("/scheduled-rides/")) {
      const scheduledRideMatch = url.pathname.match(
        /^\/scheduled-rides\/([^/]+)\/cancel$/,
      );

      if (!scheduledRideMatch) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleCancelScheduledRideRoute(
        req,
        res,
        scheduledRideDeps,
        decodeURIComponent(scheduledRideMatch[1]),
      );

      return;
    }

    if (url.pathname === "/group-rides/requests") {
      if (req.method === "GET") {
        await handleListGroupRideMatchRequestsRoute(req, res, groupRideDeps, url);
        return;
      }

      if (req.method === "POST") {
        await handleCreateGroupRideMatchRequestRoute(req, res, groupRideDeps);
        return;
      }

      sendMethodNotAllowed(res);
      return;
    }

    if (url.pathname === "/group-rides/face-check") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleGroupRideFaceCheckRoute(req, res, groupRideDeps);
      return;
    }

    if (url.pathname.startsWith("/group-rides/requests/")) {
      const uploadUrlMatch = url.pathname.match(
        /^\/group-rides\/requests\/([^/]+)\/face-upload-url$/,
      );
      if (uploadUrlMatch) {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res);
          return;
        }

        await handleCreateGroupRideFaceUploadUrlRoute(
          req,
          res,
          groupRideDeps,
          decodeURIComponent(uploadUrlMatch[1]),
        );
        return;
      }

      const completeUploadMatch = url.pathname.match(
        /^\/group-rides\/requests\/([^/]+)\/face-upload-complete$/,
      );
      if (completeUploadMatch) {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res);
          return;
        }

        await handleCompleteGroupRideFaceUploadRoute(
          req,
          res,
          groupRideDeps,
          decodeURIComponent(completeUploadMatch[1]),
        );
        return;
      }

      const cancelMatch = url.pathname.match(
        /^\/group-rides\/requests\/([^/]+)\/cancel$/,
      );
      if (cancelMatch) {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res);
          return;
        }

        await handleCancelGroupRideMatchRequestRoute(
          req,
          res,
          groupRideDeps,
          decodeURIComponent(cancelMatch[1]),
        );
        return;
      }

      const requestMatch = url.pathname.match(/^\/group-rides\/requests\/([^/]+)$/);
      if (!requestMatch) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      if (req.method === "GET") {
        await handleGetGroupRideMatchRequestRoute(
          req,
          res,
          groupRideDeps,
          decodeURIComponent(requestMatch[1]),
        );
        return;
      }

      sendMethodNotAllowed(res);
      return;
    }

    if (url.pathname.startsWith("/wallet-page/")) {
      const handled = await handleWalletPageRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
        redisClient: redisCommandClient,
        paymentsClient,
        publisher,
        resendApiKey: gatewayEnv.RESEND_API_KEY,
        notifyUser: notifyUserOnWhatsapp,
      }, url);
      if (handled) return;
    }

    if (url.pathname === "/wallet/security" || url.pathname.startsWith("/wallet/pin")) {
      const handled = await handleWalletSecurityRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
        redisClient: redisCommandClient,
        resendApiKey: gatewayEnv.RESEND_API_KEY,
        notifyUser: notifyUserOnWhatsapp,
      }, url);
      if (handled) return;
    }

    if (url.pathname === "/webhooks/paystack") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handlePaystackWebhookRoute(req, res, {
        publisher,
        paymentsClient,
        redisClient: redisCommandClient,
      });

      return;
    }

    if (url.pathname === "/wallet/overview") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleWalletOverviewRoute(req, res, walletDeps);
      return;
    }

    if (url.pathname === "/wallet/deposit-info") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleWalletDepositInfoRoute(req, res, walletDeps);
      return;
    }

    if (url.pathname === "/wallet/provision-virtual-account") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleProvisionVirtualAccountRoute(req, res, walletDeps);
      return;
    }

    if (url.pathname === "/wallet/transactions") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleWalletTransactionsRoute(req, res, walletDeps, url);
      return;
    }

    if (url.pathname === "/wallet/withdrawals/bank-networks") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleListWithdrawalBankNetworksRoute(req, res, walletDeps, url);
      return;
    }

    if (url.pathname === "/wallet/withdrawals/verify-bank-account") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleVerifyWithdrawalBankAccountRoute(req, res, walletDeps);
      return;
    }

    if (url.pathname === "/wallet/withdrawals") {
      if (req.method === "GET") {
        await handleListWalletWithdrawalsRoute(req, res, walletDeps, url);
        return;
      }

      if (req.method === "POST") {
        await handleCreateWalletWithdrawalRoute(req, res, walletDeps);
        return;
      }

      sendMethodNotAllowed(res);
      return;
    }

    if (url.pathname.startsWith("/wallet/withdrawals/")) {
      const withdrawalMatch = url.pathname.match(/^\/wallet\/withdrawals\/([^/]+)$/);

      if (!withdrawalMatch) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleGetWalletWithdrawalRoute(
        req, res, walletDeps, decodeURIComponent(withdrawalMatch[1]),
      );
      return;
    }

    // ── KYC routes ──────────────────────────────────────────────────────────
    if (url.pathname === "/kyc/status") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleGetKycStatusRoute(req, res, kycDeps);
      return;
    }

    if (url.pathname === "/kyc/verify") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleVerifyKycRoute(req, res, kycDeps);
      return;
    }

    // ── Widget static files ──────────────────────────────────────────────────
    if (req.method === "GET" && url.pathname.startsWith("/widget/")) {
      await serveWidgetFile(url.pathname, res);
      return;
    }

    sendJson(res, 404, {
      error: "Not found",
    });
    } catch (error) {
      console.error("[http] unhandled request error", {
        method: req.method ?? null,
        path: getSafePathForLog(url),
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      if (!res.headersSent) {
        sendJson(res, 500, { error: "Internal server error" });
        return;
      }

      res.destroy(error instanceof Error ? error : undefined);
    }
  });

  createGatewayWebSocketServer({
    server,
    jwtSecret: gatewayEnv.JWT_SECRET,
    allowedOrigins,
    idleTimeoutMs: Number(gatewayEnv.WS_IDLE_TIMEOUT_MS),
    registry,
    publisher,
    routePlanner,
  });

  const outboxPublisher = startOutboxPublisher({
    producer: asRawProducer(producer),
    intervalMs: 2_000,
    batchSize: 100,
  });

  const referralJobs = startReferralJobs();

  await startGatewayKafkaConsumer({
    consumer,
    registry,
    publisher,
    redisClient: redisCommandClient,
    whatsappNotifier:
      gatewayEnv.META_ACCESS_TOKEN && gatewayEnv.META_PHONE_NUMBER_ID
        ? {
            metaAccessToken: gatewayEnv.META_ACCESS_TOKEN,
            metaPhoneNumberId: gatewayEnv.META_PHONE_NUMBER_ID,
            offersFlowId: gatewayEnv.WHATSAPP_OFFERS_FLOW_ID,
            flowTokenSecret: gatewayEnv.JWT_SECRET,
            offersFormFlowId: gatewayEnv.WHATSAPP_OFFERS_FORM_FLOW_ID,
            quickActionsFlowId: gatewayEnv.WHATSAPP_QUICK_ACTIONS_FLOW_ID,
            riderIdFor: (phone: string) => lookupUserIdByPhone(redisCommandClient, phone),
          }
        : undefined,
    kycStorage: driverKycStorage ?? undefined,
    // A rider who tapped a driver and went to add money: the deposit confirms the ride.
    onWhatsappDeposit: createWhatsappDepositFinisher(buildMetaWhatsappDeps()),
  });

  // Riders stuck in the group matching pool get a "still waiting?" check-in
  // (reply: normal / wait / cancel group) instead of silence.
  startGroupRideWaitNudgeSweep({
    redisClient: redisCommandClient,
    whatsappNotifier:
      gatewayEnv.META_ACCESS_TOKEN && gatewayEnv.META_PHONE_NUMBER_ID
        ? {
            metaAccessToken: gatewayEnv.META_ACCESS_TOKEN,
            metaPhoneNumberId: gatewayEnv.META_PHONE_NUMBER_ID,
            flowTokenSecret: gatewayEnv.JWT_SECRET,
            quickActionsFlowId: gatewayEnv.WHATSAPP_QUICK_ACTIONS_FLOW_ID,
            riderIdFor: (phone: string) => lookupUserIdByPhone(redisCommandClient, phone),
          }
        : undefined,
  });

  const port = Number(gatewayEnv.PORT);

  await new Promise<void>((resolve) => {
    startLocationHistoryCleanup(gatewayEnv.LOCATION_HISTORY_DAYS);

    server.listen(port, () => {
      console.log(`[api-gateway] listening on :${port}`);
      resolve();
    });
  });

  onShutdown(async () => {
    await closeServer(server);
  });

  onShutdown(async () => {
    await dispatcherQueue.close();
  });

  onShutdown(async () => {
    await dispatcherRedis.quit();
  });

  onShutdown(async () => {
    outboxPublisher.shutdown();
  });

  onShutdown(async () => {
    referralJobs.shutdown();
  });

  onShutdown(async () => {
    await producer.disconnect();
  });

  onShutdown(async () => {
    await consumer.disconnect();
  });

  onShutdown(async () => {
    await redisSubscriberClient.disconnect();
  });

  onShutdown(async () => {
    await redisCommandClient.disconnect();
  });
}

process.on("unhandledRejection", (reason) => {
  console.error("[api-gateway] unhandled rejection", {
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

process.on("uncaughtException", (error) => {
  console.error("[api-gateway] uncaught exception", {
    message: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

bootstrap().catch((error) => {
  console.error("[api-gateway] Failed to start:", error);
  process.exit(1);
});
