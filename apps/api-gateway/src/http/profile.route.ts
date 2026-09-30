import type { IncomingMessage, ServerResponse } from "http";
import { userClient } from "@wheleers/db";
import { authenticateHttpUser } from "./authenticate";
import { readJsonBody, sendJson } from "./utils";
import { getString, isRecord } from "../utils/object";
import { logActivity } from "../analytics/log-activity";
import { fillMissingName } from '../auth/display-name';

interface ProfileRouteDeps {
  jwtSecret: string;
}

function serializeUser(user: {
  id: string;
  privyDid: string;
  username?: string | null;
  email: string | null;
  role: string;
  name: string | null;
  phone: string | null;
}) {
  return {
    id: user.id,
    privyDid: user.privyDid,
    username: user.username ?? null,
    email: user.email,
    role: user.role,
    name: user.name,
    phone: user.phone,
  };
}

function normalizeUsername(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }

  if (!/^[a-z0-9_]{3,24}$/.test(trimmed)) {
    throw new Error(
      "username must be 3-24 characters and use only lowercase letters, numbers, or underscores.",
    );
  }

  return trimmed;
}

function normalizeName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.length < 2 || trimmed.length > 80) {
    throw new Error("fullName must be between 2 and 80 characters.");
  }

  return trimmed;
}

function normalizeEmail(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new Error("email must be a valid email address.");
  }

  return trimmed;
}

function normalizePhone(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.length < 7 || trimmed.length > 24) {
    throw new Error("phone number must be between 7 and 24 characters.");
  }

  return trimmed;
}

export async function handleGetCurrentProfileRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ProfileRouteDeps,
): Promise<void> {
  try {
    // Accounts made before names were filled in get one the next time the app asks.
    const user = await fillMissingName(await authenticateHttpUser(req, deps.jwtSecret));

    sendJson(res, 200, {
      user: serializeUser(user),
    });
  } catch (error) {
    sendJson(res, 401, {
      error:
        error instanceof Error ? error.message : "Could not load your profile.",
    });
  }
}

export async function handleUpdateCurrentProfileRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ProfileRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const rawBody = await readJsonBody(req);

    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: "Body must be a JSON object" });
      return;
    }

    const username = normalizeUsername(getString(rawBody, "username"));
    const name = normalizeName(
      getString(rawBody, "fullName") ?? getString(rawBody, "name"),
    );
    const email = normalizeEmail(getString(rawBody, "email"));
    const phone = normalizePhone(getString(rawBody, "phone"));

    if (!username && !name && !email && !phone) {
      sendJson(res, 400, {
        error: "username, email, phone, or fullName is required.",
      });
      return;
    }

    const updated = await userClient.updateProfile(user.id, {
      username,
      name,
      email,
      phone,
    });

    logActivity({
      userId: user.id,
      eventType: "profile_updated",
      metadata: {
        fields: Object.entries({ username, name, email, phone })
          .filter(([, value]) => value !== undefined)
          .map(([key]) => key),
      },
    });

    sendJson(res, 200, {
      user: serializeUser(updated),
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2002"
    ) {
      sendJson(res, 409, {
        error: "That username or email is already taken.",
      });
      return;
    }

    sendJson(res, 400, {
      error:
        error instanceof Error ? error.message : "Could not update your profile.",
    });
  }
}
