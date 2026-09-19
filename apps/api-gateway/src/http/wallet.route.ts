import type { IncomingMessage, ServerResponse } from "http";
import {
  walletClient,
  withdrawalClient,
  virtualAccountClient,
  userClient,
} from "@wheleers/db";
import { authenticateHttpUser } from "./authenticate";
import { runIdempotentJsonRequest } from "./idempotency";
import { readJsonBody, sendJson } from "./utils";
import { isRecord, pickNumber, pickString } from "../utils/object";
import { logActivity } from "../analytics/log-activity";
import type { GatewayPublisher } from "../websocket/publisher";
import {
  classifyPayoutStatus,
  transferFeeNgn,
  type PaymentBank,
  type PaymentPayout,
  type PaymentsClient,
} from "@wheleers/payments";
import { provisionDepositAccount } from "../onboarding/user-onboarding";
import { submitWithdrawal, WithdrawalError } from "../payments/withdrawal";
import { getBanks } from "../payments/banks";
import type { RedisClient } from "../redis/client";
import type { PayoutCreatedEvent } from "@wheleers/kafka-schemas";
import { MIN_WITHDRAWAL_NGN } from "@wheleers/config";

// ─── Deps ──────────────────────────────────────────────────────────

interface WalletRouteDeps {
  jwtSecret: string;
  publisher: GatewayPublisher;
  paymentsClient: PaymentsClient;
  redisClient?: RedisClient;
}

// ─── Constants ─────────────────────────────────────────────────────

const BANK_NETWORKS_CACHE_TTL_SECONDS = 6 * 60 * 60;

const PREFERRED_BANK_TERMS = [
  "opay",
  "palmpay",
  "moniepoint",
  "access bank",
  "guaranty trust bank",
  "gtbank",
  "gt bank",
  "first bank of nigeria",
  "first city monument bank",
  "fcmb",
  "united bank for africa",
  "uba",
  "zenith bank",
  "wema bank",
  "sterling bank",
  "fidelity bank",
  "union bank of nigeria",
  "ecobank nigeria",
  "stanbic ibtc bank",
  "providus bank",
  "keystone bank",
  "polaris bank",
  "premiumtrust bank",
  "premium trust bank",
  "kuda",
  "paga",
  "jaiz bank",
  "taj bank",
];

const BANK_SEARCH_ALIASES: Record<string, string[]> = {
  opay: ["opay"],
  palmpay: ["palmpay"],
  moniepoint: ["moniepoint"],
  access: ["access bank", "access bank diamond", "access money", "accessmobile"],
  gtbank: ["gtbank", "gt bank", "guaranty trust bank", "gtmobile"],
  gt: ["gtbank", "gt bank", "guaranty trust bank", "gtmobile"],
  uba: ["uba", "united bank for africa"],
  firstbank: ["first bank", "first bank of nigeria", "fbnmobile"],
  first: ["first bank", "first bank of nigeria", "fbnmobile"],
  fcmb: ["fcmb", "first city monument bank", "fcmb easy account"],
  zenith: ["zenith bank", "zenithmobile"],
  sterling: ["sterling bank", "sterling mobile"],
  stanbic: ["stanbic ibtc bank", "stanbic ibtc ease wallet", "stanbic mobile money"],
  ecobank: ["ecobank nigeria", "ecobank xpress account", "ecomobile"],
  fidelity: ["fidelity bank", "fidelity mobile"],
  union: ["union bank of nigeria"],
  kuda: ["kuda microfinance bank", "kuda"],
  paga: ["paga"],
};

// ─── Helpers ───────────────────────────────────────────────────────

function parseLimit(value: string | null): number {
  if (!value) {
    return 20;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 20;
  }

  return Math.min(parsed, 50);
}

function parseCountryCode(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim().toUpperCase();
  return normalized && normalized.length >= 2 ? normalized : fallback;
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
    "toNumber" in value &&
    typeof value.toNumber === "function"
  ) {
    const parsed = value.toNumber();
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function roundNgn(value: number): number {
  return Math.round(value * 100) / 100;
}

// ─── Bank network helpers ──────────────────────────────────────────

function getBankCacheKey(country: string): string {
  return `payments:banks:v1:${country.toUpperCase()}`;
}

function normalizeBankTerm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function getBankSearchNeedles(query: string): string[] {
  const normalized = normalizeBankTerm(query);
  if (!normalized) {
    return [];
  }

  const compact = normalized.replace(/\s+/g, "");
  const aliases = new Set<string>([normalized, compact]);

  for (const [key, values] of Object.entries(BANK_SEARCH_ALIASES)) {
    if (normalized === key || compact === key.replace(/\s+/g, "")) {
      for (const value of values) {
        aliases.add(normalizeBankTerm(value));
      }
    }
  }

  return [...aliases];
}

function dedupeBanks(banks: PaymentBank[]): PaymentBank[] {
  const seen = new Set<string>();
  const deduped: PaymentBank[] = [];

  for (const bank of banks) {
    const name = typeof bank.name === "string" ? normalizeBankTerm(bank.name) : "";
    const code = typeof bank.code === "string" ? normalizeBankTerm(bank.code) : "";
    const key = `${name}|${code}`;
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(bank);
  }

  return deduped;
}

function getPreferredBankPriority(bank: PaymentBank): number {
  const name = typeof bank.name === "string" ? normalizeBankTerm(bank.name) : "";
  if (!name) {
    return Number.MAX_SAFE_INTEGER;
  }

  const index = PREFERRED_BANK_TERMS.findIndex((term) => name.includes(term));
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function scoreBankMatch(bank: PaymentBank, query: string): number {
  const name = typeof bank.name === "string" ? normalizeBankTerm(bank.name) : "";
  const code = typeof bank.code === "string" ? normalizeBankTerm(bank.code) : "";
  const needles = getBankSearchNeedles(query);

  if (!needles.length) {
    return 0;
  }

  let best = Number.MAX_SAFE_INTEGER;

  for (const needle of needles) {
    if (!needle) {
      continue;
    }

    if (name === needle || code === needle) {
      best = Math.min(best, 0);
      continue;
    }

    if (name.startsWith(needle) || code.startsWith(needle)) {
      best = Math.min(best, 1);
      continue;
    }

    if (name.includes(needle) || code.includes(needle)) {
      best = Math.min(best, 2);
    }
  }

  return best;
}

function sortBanks(banks: PaymentBank[], query: string): PaymentBank[] {
  const normalizedQuery = query.trim();

  return [...banks].sort((left, right) => {
    const leftName = typeof left.name === "string" ? left.name : "";
    const rightName = typeof right.name === "string" ? right.name : "";

    if (normalizedQuery) {
      const leftScore = scoreBankMatch(left, normalizedQuery);
      const rightScore = scoreBankMatch(right, normalizedQuery);
      if (leftScore !== rightScore) {
        return leftScore - rightScore;
      }
    } else {
      const leftPriority = getPreferredBankPriority(left);
      const rightPriority = getPreferredBankPriority(right);
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }
    }

    return leftName.localeCompare(rightName);
  });
}

async function getBanksFromCacheOrProvider(
  deps: WalletRouteDeps,
  _country: string,
  _currency: string,
): Promise<PaymentBank[]> {
  return dedupeBanks(await getBanks(deps.paymentsClient, deps.redisClient));
}

// ─── Mapping helpers ───────────────────────────────────────────────

function mapBankAccount(bank: PaymentBank) {
  const uuid = typeof bank.uuid === "string" ? bank.uuid : "";
  return {
    id: uuid,
    uuid,
    name: typeof bank.name === "string" ? bank.name : "",
    code: typeof bank.code === "string" ? bank.code : null,
    country: typeof bank.country === "string" ? bank.country : null,
    currency: typeof bank.currency === "string" ? bank.currency : null,
    provider: typeof bank.provider === "string" ? bank.provider : null,
  };
}

function mapWithdrawalRequest(
  request: {
    id: string;
    status: string;
    requestedAmountNgn: unknown;
    reservedAmountNgn?: unknown;
    bankAccountNumber: string;
    bankAccountName: string;
    bankNetworkId: string;
    providerReference: string | null;
    failureReason: string | null;
    createdAt: Date;
    updatedAt: Date;
    settledAt?: Date | null;
    failedAt?: Date | null;
  },
) {
  return {
    id: request.id,
    status: request.status,
    amountNgn: decimalToNumber(request.requestedAmountNgn) ?? 0,
    bankAccount: {
      accountNumber: request.bankAccountNumber,
      accountName: request.bankAccountName,
      networkId: request.bankNetworkId,
    },
    providerReference: request.providerReference,
    failureReason: request.failureReason,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
    settledAt: request.settledAt?.toISOString() ?? null,
    failedAt: request.failedAt?.toISOString() ?? null,
  };
}

// ─── Payout status sync ────────────────────────────────────────────

async function syncPayoutStatus(
  deps: WalletRouteDeps,
  reference: string,
  amountNgn: number,
): Promise<PaymentPayout | null> {
  const payout = await deps.paymentsClient.getPayout(reference);
  if (!payout) return null;
  const outcome = classifyPayoutStatus(payout.status);

  if (outcome === "settled") {
    await withdrawalClient.settle(reference, {
      providerFeeNgn: payout.feeNgn ?? transferFeeNgn(amountNgn),
    });
  } else if (outcome === "failed") {
    await withdrawalClient.releaseFailedRequest({
      providerReference: reference,
      failureReason: payout.failureReason ?? `Payout ${(payout.status || "failed").toLowerCase()}`,
      status: "FAILED",
    });
  } else {
    await withdrawalClient.markProcessing(reference);
  }

  return payout;
}

// ─── Route handlers ────────────────────────────────────────────────

export async function handleWalletOverviewRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WalletRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const wallet = await walletClient.findByUserId(user.id);

    if (!wallet) {
      sendJson(res, 200, {
        walletId: null,
        balanceNgn: 0,
        lockedNgn: 0,
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    const balanceNgn = decimalToNumber(wallet.balanceNgn) ?? 0;
    const lockedNgn = decimalToNumber(wallet.lockedNgn) ?? 0;

    sendJson(res, 200, {
      walletId: wallet.id,
      balanceNgn,
      lockedNgn,
      updatedAt: wallet.updatedAt.toISOString(),
    });
  } catch (error) {
    sendJson(res, 401, {
      error:
        error instanceof Error ? error.message : "Could not load wallet overview",
    });
  }
}

export async function handleWalletTransactionsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WalletRouteDeps,
  url: URL,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const wallet = await walletClient.findByUserId(user.id);

    if (!wallet) {
      sendJson(res, 200, { items: [], nextCursor: null });
      return;
    }

    const limit = parseLimit(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const transactions = await walletClient.findTransactions(wallet.id, limit, cursor);

    sendJson(res, 200, {
      items: transactions.map((transaction) => ({
        id: transaction.id,
        type: transaction.type,
        direction: transaction.direction,
        amountNgn: decimalToNumber(transaction.amountNgn) ?? 0,
        balanceAfterNgn: decimalToNumber(transaction.balanceAfterNgn) ?? 0,
        referenceId: transaction.referenceId,
        metadata: transaction.metadata ?? null,
        createdAt: transaction.createdAt.toISOString(),
      })),
      nextCursor:
        transactions.length === limit
          ? (transactions[transactions.length - 1]?.id ?? null)
          : null,
    });
  } catch (error) {
    sendJson(res, 401, {
      error:
        error instanceof Error
          ? error.message
          : "Could not load wallet transactions",
    });
  }
}

export async function handleCreateWalletWithdrawalRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WalletRouteDeps,
): Promise<void> {
  let reservedRequestId: string | undefined;
  let auditUserId: string | undefined;
  let auditAmountNgn: number | undefined;

  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    auditUserId = user.id;
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: "Body must be a JSON object" });
      return;
    }

    const wallet = await walletClient.findByUserId(user.id);

    if (!wallet) {
      sendJson(res, 400, { error: "No wallet found. Fund your account first." });
      return;
    }

    // Parse amount
    const amountNgn = pickNumber(rawBody, ["amountNgn", "amountLocal", "amount"]);
    if (!amountNgn || amountNgn <= 0) {
      console.warn("[api-gateway][wallet-withdrawal] rejected: invalid amount", {
        userId: user.id,
        walletId: wallet.id,
        rawAmount: rawBody["amountNgn"] ?? rawBody["amountLocal"] ?? rawBody["amount"] ?? null,
      });
      sendJson(res, 400, { error: "amountNgn must be a positive number." });
      return;
    }

    const requestedAmountNgn = roundNgn(amountNgn);
    auditAmountNgn = requestedAmountNgn;

    // Reject before reserving funds, so money is never locked for a payout
    // that was always going to be refused.
    if (requestedAmountNgn < MIN_WITHDRAWAL_NGN) {
      console.warn("[api-gateway][wallet-withdrawal] rejected: below minimum", {
        userId: user.id,
        walletId: wallet.id,
        requestedAmountNgn,
        minimumNgn: MIN_WITHDRAWAL_NGN,
        shortfallNgn: roundNgn(MIN_WITHDRAWAL_NGN - requestedAmountNgn),
        availableBalanceNgn: roundNgn(decimalToNumber(wallet.balanceNgn) ?? 0),
      });
      sendJson(res, 400, {
        error: `Banks can't receive less than NGN ${MIN_WITHDRAWAL_NGN.toLocaleString("en-NG")}. Enter a higher amount.`,
        minimumNgn: MIN_WITHDRAWAL_NGN,
        requestedAmountNgn,
      });
      return;
    }

    // Check balance
    const balanceNgn = decimalToNumber(wallet.balanceNgn) ?? 0;
    if (balanceNgn < requestedAmountNgn) {
      console.warn("[api-gateway][wallet-withdrawal] rejected: insufficient balance", {
        userId: user.id,
        walletId: wallet.id,
        requestedAmountNgn,
        availableBalanceNgn: roundNgn(balanceNgn),
        lockedNgn: roundNgn(decimalToNumber(wallet.lockedNgn) ?? 0),
        shortfallNgn: roundNgn(requestedAmountNgn - balanceNgn),
      });
      sendJson(res, 400, {
        error: "Insufficient balance for this withdrawal.",
        availableBalanceNgn: roundNgn(balanceNgn),
        requestedAmountNgn,
      });
      return;
    }

    // Parse bank account
    const bankAccountBody = isRecord(rawBody["bankAccount"])
      ? rawBody["bankAccount"]
      : null;
    if (!bankAccountBody) {
      sendJson(res, 400, { error: "bankAccount is required." });
      return;
    }

    const accountNumber = pickString(bankAccountBody, ["accountNumber"]);
    const accountName = pickString(bankAccountBody, ["accountName"]);
    const bankUuid = pickString(bankAccountBody, ["bankUuid", "networkId"]);

    if (!accountNumber || !accountName || !bankUuid) {
      sendJson(res, 400, {
        error:
          "bankAccount.accountNumber, accountName, and bankUuid are required.",
      });
      return;
    }

    const result = await runIdempotentJsonRequest({
      req,
      redisClient: deps.redisClient!,
      userId: user.id,
      routeKey: "wallet:withdrawals:create",
      requestBody: rawBody,
      execute: async () => {
        const { requestId } = await submitWithdrawal(
          { paymentsClient: deps.paymentsClient, publisher: deps.publisher },
          {
            userId: user.id,
            walletId: wallet.id,
            amountNgn: requestedAmountNgn,
            bankCode: bankUuid,
            accountNumber,
            accountName,
          },
        );
        reservedRequestId = requestId;
        const createdRequest = await withdrawalClient.findById(requestId);
        return {
          statusCode: 200,
          body: {
            withdrawal: createdRequest ? mapWithdrawalRequest(createdRequest) : null,
          },
        };
      },
    });

    sendJson(res, result.statusCode, result.body);

    logActivity({
      userId: user.id,
      eventType: "withdrawal_created",
      metadata: { amountNgn: requestedAmountNgn },
    });
  } catch (error) {
    // Previously silent: a failed payout returned a 400 to the client and left
    // no server-side trace at all, so provider rejections were invisible.
    console.error("[api-gateway][wallet-withdrawal] withdrawal failed", {
      withdrawalRequestId: reservedRequestId ?? null,
      fundsStillReserved: error instanceof WithdrawalError ? error.fundsStillReserved : false,
      error: error instanceof Error ? error.message : String(error),
      providerStatus: (error as { status?: number })?.status ?? null,
      providerCode: (error as { code?: string })?.code ?? null,
    });

    if (auditUserId) {
      logActivity({
        userId: auditUserId,
        eventType: "withdrawal_failed",
        metadata: {
          amountNgn: auditAmountNgn ?? null,
          reason: error instanceof Error ? error.message : "unknown",
        },
      });
    }

    sendJson(res, 400, {
      error:
        error instanceof Error
          ? error.message
          : "Could not create wallet withdrawal.",
      code: error instanceof WithdrawalError ? error.code : "WITHDRAWAL_FAILED",
    });
  }
}

export async function handleListWalletWithdrawalsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WalletRouteDeps,
  url: URL,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const limit = parseLimit(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const items = await withdrawalClient.listByUser(user.id, limit, cursor);

    sendJson(res, 200, {
      items: items.map(mapWithdrawalRequest),
      nextCursor:
        items.length === limit ? (items[items.length - 1]?.id ?? null) : null,
    });
  } catch (error) {
    sendJson(res, 401, {
      error:
        error instanceof Error
          ? error.message
          : "Could not load wallet withdrawals",
    });
  }
}

export async function handleGetWalletWithdrawalRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WalletRouteDeps,
  withdrawalRequestId: string,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const request = await withdrawalClient.findById(withdrawalRequestId);

    if (!request || request.userId !== user.id) {
      sendJson(res, 404, { error: "Withdrawal not found." });
      return;
    }

    // Ask the provider for the latest word on anything still in flight. The
    // reference is the request id, so this works even if the payout was
    // never recorded on our side.
    if (["PAYOUT_CREATED", "PROCESSING"].includes(request.status)) {
      await syncPayoutStatus(deps, request.id, Number(request.requestedAmountNgn)).catch((syncError) => {
        console.warn("[api-gateway][wallet-withdrawal] status sync failed", {
          withdrawalRequestId: request.id,
          error: syncError instanceof Error ? syncError.message : String(syncError),
        });
      });
    }

    const latestRequest = await withdrawalClient.findById(withdrawalRequestId);
    sendJson(res, 200, {
      withdrawal: latestRequest ? mapWithdrawalRequest(latestRequest) : null,
    });
  } catch (error) {
    sendJson(res, 400, {
      error:
        error instanceof Error
          ? error.message
          : "Could not load wallet withdrawal.",
    });
  }
}

export async function handleListWithdrawalBankNetworksRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WalletRouteDeps,
  url: URL,
): Promise<void> {
  let user;
  try {
    user = await authenticateHttpUser(req, deps.jwtSecret);
  } catch (error) {
    sendJson(res, 401, {
      error:
        error instanceof Error ? error.message : "Unauthorized",
    });
    return;
  }

  try {
    const country = parseCountryCode(url.searchParams.get("country"), "NG");
    const currency = url.searchParams.get("currency")?.toUpperCase() ?? "NGN";
    const query = url.searchParams.get("query")?.trim().toLowerCase() ?? "";
    const limit = parseLimit(url.searchParams.get("limit"));

    const banks = await getBanksFromCacheOrProvider(deps, country, currency);
    const needles = getBankSearchNeedles(query);
    const filtered = query
      ? banks.filter(
          (bank) => scoreBankMatch(bank, query) !== Number.MAX_SAFE_INTEGER,
        )
      : banks;
    const ranked = sortBanks(filtered, query);

    console.log("[api-gateway][wallet] bank search", {
      country,
      currency,
      query,
      total: banks.length,
      matched: filtered.length,
      limit,
      needles,
    });

    sendJson(res, 200, {
      country,
      items: ranked
        .slice(0, limit)
        .map(mapBankAccount)
        .filter((item) => item.uuid && item.name),
    });
  } catch (error) {
    console.error("[api-gateway][wallet] bank networks error", error);
    sendJson(res, 500, {
      error:
        error instanceof Error
          ? error.message
          : "Could not load withdrawal bank networks.",
    });
  }
}

export async function handleVerifyWithdrawalBankAccountRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WalletRouteDeps,
): Promise<void> {
  try {
    await authenticateHttpUser(req, deps.jwtSecret);
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: "Body must be a JSON object" });
      return;
    }

    const accountNumber = pickString(rawBody, ["accountNumber"])?.replace(
      /\D/g,
      "",
    );
    const bankUuid = pickString(rawBody, ["bankUuid", "networkId", "id"]);

    if (!accountNumber || !bankUuid) {
      sendJson(res, 400, {
        error: "accountNumber and bankUuid are required.",
      });
      return;
    }

    // "bankUuid" is the bank CODE — the field name is kept so the apps did
    // not need a release for the provider switch. The provider answers an
    // unknown account with a 4xx; treat that as "not found", not as an outage.
    const verified = await deps.paymentsClient
      .validateBankAccount({ accountNumber, bankCode: bankUuid })
      .catch((verifyError) => {
        const status = (verifyError as { status?: number })?.status;
        if (typeof status === "number" && status >= 400 && status < 500 && status !== 429) {
          return { account_number: accountNumber, account_name: "", bank_code: bankUuid };
        }
        throw verifyError;
      });

    // A missing account_name means the account could not be resolved — report
    // that plainly instead of letting clients invent a placeholder name.
    if (typeof verified.account_name !== "string" || !verified.account_name.trim()) {
      sendJson(res, 404, {
        error: "Account not found. Check the account number and bank.",
        code: "BANK_ACCOUNT_NOT_FOUND",
      });
      return;
    }

    // The provider's name check does not say which bank it was; the cached
    // bank list does.
    const resolvedBankName =
      (await getBanks(deps.paymentsClient, deps.redisClient).catch(() => []))
        .find((bank) => bank.code === bankUuid)?.name ?? null;

    sendJson(res, 200, {
      bankAccount: {
        accountNumber:
          typeof verified.account_number === "string"
            ? verified.account_number
            : accountNumber,
        accountName:
          typeof verified.account_name === "string"
            ? verified.account_name
            : null,
        bankName: resolvedBankName,
        networkId: bankUuid,
        bankUuid,
      },
    });
  } catch (error) {
    sendJson(res, 400, {
      error:
        error instanceof Error
          ? error.message
          : "Could not verify withdrawal bank account.",
    });
  }
}

export async function handleWalletDepositInfoRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WalletRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const virtualAccount = await virtualAccountClient.findByUserId(user.id);

    if (!virtualAccount) {
      sendJson(res, 404, {
        error: "Account not found. Please complete onboarding first.",
        code: "VIRTUAL_ACCOUNT_NOT_FOUND",
      });
      return;
    }

    sendJson(res, 200, {
      accountNumber: virtualAccount.accountNumber,
      accountName: virtualAccount.accountName,
      bankName: virtualAccount.bankName,
      currency: virtualAccount.currency,
    });
  } catch (error) {
    sendJson(res, 401, {
      error:
        error instanceof Error
          ? error.message
          : "Could not load deposit information.",
    });
  }
}

export async function handleProvisionVirtualAccountRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WalletRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);

    // Check if virtual account already exists
    const existing = await virtualAccountClient.findByUserId(user.id);
    if (existing) {
      sendJson(res, 200, {
        accountNumber: existing.accountNumber,
        accountName: existing.accountName,
        bankName: existing.bankName,
        currency: existing.currency,
        alreadyProvisioned: true,
      });
      return;
    }

    // Ensure wallet exists (catch P2002 in case of concurrent creation)
    const wallet = await walletClient.findByUserId(user.id);
    if (!wallet) {
      await walletClient.create(user.id).catch((err) => {
        if (err && typeof err === "object" && "code" in err && err.code === "P2002") return;
        throw err;
      });
    }

    // One provisioner for every entry point (signup, WhatsApp, phone verify,
    // this route), so they cannot disagree about names or idempotency.
    const fullUser = await userClient.findById(user.id);
    const provisionStatus = await provisionDepositAccount(
      deps.paymentsClient,
      user.id,
      fullUser?.name ?? undefined,
      fullUser?.phone ?? undefined,
    );
    if (provisionStatus === "needs_phone") {
      sendJson(res, 409, {
        error: "Verify your phone number to get your account number. The bank needs one to open an account.",
        code: "PHONE_REQUIRED",
      });
      return;
    }

    const created = await virtualAccountClient.findByUserId(user.id);
    if (!created) {
      // The provider accepted the request and will announce the account by
      // webhook. The app polls deposit-info, so tell it to come back.
      sendJson(res, 202, {
        pending: true,
        message: "Your account number is being prepared. Check back in a moment.",
      });
      return;
    }

    logActivity({
      userId: user.id,
      eventType: "virtual_account_provisioned",
      metadata: {},
    });

    sendJson(res, 201, {
      accountNumber: created.accountNumber,
      accountName: created.accountName,
      bankName: created.bankName,
      currency: created.currency,
      alreadyProvisioned: false,
    });
  } catch (error) {
    sendJson(res, 400, {
      error:
        error instanceof Error
          ? error.message
          : "Could not provision virtual account.",
    });
  }
}
