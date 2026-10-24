import type { IncomingMessage, ServerResponse } from "http";
import { referralClient } from "@wheleers/db";
import { authenticateHttpUser } from "./authenticate";
import { readJsonBody, sendJson } from "./utils";
import { getNumber, getString, isRecord } from "../utils/object";
import { logActivity } from "../analytics/log-activity";
import { noteRequestDetail } from "../analytics/user-outcomes";
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
  // Their first name only: a friend's phone number or email is not the referrer's to see.
  const referredUser =
    referral.referredUser.name?.trim().split(/\s+/)[0] ||
    referral.referredUser.username ||
    "A friend";

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
    // the code already typed.
    sendJson(res, 200, {
      ...summary,
      shareLink: summary.code ? referralShareLink(summary.code) : null,
      shareMessage: summary.code ? referralChatMessage(summary.code) : null,
      // Whether someone else's code is already on this account: one per person.
      hasAppliedCode: await referralClient.hasAppliedCode(user.id),
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

/** PUT /referrals/me/code { code } — the person's own choice of referral code. */
export async function handleSetReferralCodeRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ReferralRouteDeps,
): Promise<void> {
  let userId: string;
  try {
    userId = (await authenticateHttpUser(req, deps.jwtSecret)).id;
  } catch {
    sendJson(res, 401, { error: "Please sign in again." });
    return;
  }
  try {
    const rawBody = await readJsonBody(req);
    const wanted = isRecord(rawBody) ? getString(rawBody, "code") : undefined;
    if (!wanted) {
      sendJson(res, 400, { error: "Type the code you want." });
      return;
    }
    const saved = await referralClient.setCustomCode(userId, wanted);
    logActivity({ userId, eventType: "referral_code_changed", metadata: { code: saved.code } });
    sendJson(res, 200, {
      code: saved.code,
      shareLink: referralShareLink(saved.code),
      shareMessage: referralChatMessage(saved.code),
    });
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : "Could not change your referral code." });
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
    // The Activity page shows the code they entered, worked or not.
    noteRequestDetail(res, referralClient.normalizeCode(code));

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
