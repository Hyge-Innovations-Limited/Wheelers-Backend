import type { IncomingMessage, ServerResponse } from "http";
import { referralClient } from "@wheleers/db";
import { authenticateHttpUser } from "./authenticate";
import { readJsonBody, sendJson } from "./utils";
import { getNumber, getString, isRecord } from "../utils/object";
import { logActivity } from "../analytics/log-activity";
import { referralChatMessage, referralShareLink } from "../whatsapp/referral";

interface ReferralRouteDeps {
  jwtSecret: string;
}

function decimalToNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (
    value &&
    typeof value === "object" &&
    "toString" in value &&
    typeof value.toString === "function"
  ) {
    const parsed = Number(value.toString());
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function mapReferralItem(
  referral: Awaited<ReturnType<typeof referralClient.listReferrals>>[number],
) {
  const referredUser =
    referral.referredUser.name ??
    referral.referredUser.username ??
    referral.referredUser.phone ??
    referral.referredUser.email ??
    "Referred rider";

  return {
    id: referral.id,
    referredUserId: referral.referredUserId,
    referredUser,
    status: referral.status,
    appliedAt: referral.appliedAt.toISOString(),
    expiresAt: referral.expiresAt.toISOString(),
    closesAt: referral.closesAt.toISOString(),
    firstRideId: referral.firstRideId ?? null,
    qualifiedAt: referral.qualifiedAt?.toISOString() ?? null,
    settledAt: referral.settledAt?.toISOString() ?? null,
    usedToUnlockCashbackId: referral.usedToUnlockCashbackId ?? null,
    unlockedAmountNgn: decimalToNumber(referral.unlockedAmountNgn),
  };
}

function mapCashbackItem(
  cashback: Awaited<ReturnType<typeof referralClient.listCashback>>[number],
) {
  return {
    id: cashback.id,
    sourceReferralId: cashback.sourceReferralId ?? null,
    sourceReferralStatus: cashback.sourceReferral?.status ?? null,
    type: cashback.type,
    amountNgn: decimalToNumber(cashback.amountNgn) ?? 0,
    remainingAmountNgn: decimalToNumber(cashback.remainingAmountNgn) ?? 0,
    status: cashback.status,
    freezesAt: cashback.freezesAt.toISOString(),
    frozenAt: cashback.frozenAt?.toISOString() ?? null,
    usedAt: cashback.usedAt?.toISOString() ?? null,
    createdAt: cashback.createdAt.toISOString(),
  };
}

export async function handleGetReferralSummaryRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ReferralRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const summary = await referralClient.findSummary(user.id);

    // The link a referral QR code holds: it opens a chat with Wheelers with
    // the code already typed. Null when the WhatsApp number is not set.
    sendJson(res, 200, {
      ...summary,
      shareLink: summary.code ? referralShareLink(summary.code) : null,
      shareMessage: summary.code ? referralChatMessage(summary.code) : null,
    });
  } catch (error) {
    sendJson(res, 400, {
      error:
        error instanceof Error
          ? error.message
          : "Could not load referral summary.",
    });
  }
}

export async function handleApplyReferralCodeRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ReferralRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: "Body must be a JSON object" });
      return;
    }

    const code = getString(rawBody, "code");
    if (!code) {
      sendJson(res, 400, { error: "code is required" });
      return;
    }

    const result = await referralClient.applyCode({
      referredUserId: user.id,
      code,
    });

    logActivity({
      userId: user.id,
      eventType: "referral_code_applied",
      metadata: { code },
    });

    sendJson(res, 201, {
      referral: {
        id: result.referral.id,
        referrerId: result.referral.referrerId,
        status: result.referral.status,
        appliedAt: result.referral.appliedAt.toISOString(),
        expiresAt: result.referral.expiresAt.toISOString(),
        closesAt: result.referral.closesAt.toISOString(),
      },
      unlockedCashback: result.unlockedCashback,
    });
  } catch (error) {
    sendJson(res, 400, {
      error:
        error instanceof Error
          ? error.message
          : "Could not apply referral code.",
    });
  }
}

export async function handleListReferralReferralsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ReferralRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const items = await referralClient.listReferrals(user.id);

    sendJson(res, 200, {
      items: items.map(mapReferralItem),
    });
  } catch (error) {
    sendJson(res, 400, {
      error:
        error instanceof Error ? error.message : "Could not load referrals.",
    });
  }
}

export async function handleListReferralCashbackRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ReferralRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const items = await referralClient.listCashback(user.id);

    sendJson(res, 200, {
      items: items.map(mapCashbackItem),
    });
  } catch (error) {
    sendJson(res, 400, {
      error:
        error instanceof Error ? error.message : "Could not load cashback.",
    });
  }
}

export async function handlePreviewReferralRideCashbackRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ReferralRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: "Body must be a JSON object" });
      return;
    }

    const fareNgn = getNumber(rawBody, "fareNgn");
    if (fareNgn === undefined || fareNgn <= 0) {
      sendJson(res, 400, { error: "fareNgn must be greater than zero" });
      return;
    }

    const requestedAmountNgn = getNumber(rawBody, "requestedAmountNgn");
    const preview = await referralClient.previewRideCashback({
      userId: user.id,
      fareNgn,
      requestedAmountNgn,
    });

    sendJson(res, 200, preview);
  } catch (error) {
    sendJson(res, 400, {
      error:
        error instanceof Error
          ? error.message
          : "Could not preview referral cashback.",
    });
  }
}
