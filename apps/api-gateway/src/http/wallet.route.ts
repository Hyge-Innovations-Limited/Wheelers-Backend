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
  PouchLiquifiaClient,
  classifyPouchPayoutStatus,
  type PouchBankAccount,
  type PouchPayout,
  pouchNameParts,
} from "@wheleers/pouch-client";
import type { RedisClient } from "../redis/client";
import type { PayoutCreatedEvent } from "@wheleers/kafka-schemas";
import { MIN_WITHDRAWAL_NGN, POUCH_PAYOUT_FEE_NGN } from "@wheleers/config";

// ─── Deps ──────────────────────────────────────────────────────────

interface WalletRouteDeps {
  jwtSecret: string;
  publisher: GatewayPublisher;
  pouchLiquifiaClient: PouchLiquifiaClient;
  redisClient?: RedisClient;
  /**
   * Platform treasury VA — the single funded Pouch account all payouts draw
   * from. Without it, payouts fall back to the user's own virtual account,
   * which for drivers is empty (earnings are ledger-only) and withdrawals
   * cannot work.
   */
  treasuryVirtualAccountId?: string;
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
  return `pouch-liquifia:banks:${country.toUpperCase()}`;
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

function dedupeBanks(banks: PouchBankAccount[]): PouchBankAccount[] {
  const seen = new Set<string>();
  const deduped: PouchBankAccount[] = [];

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

function getPreferredBankPriority(bank: PouchBankAccount): number {
  const name = typeof bank.name === "string" ? normalizeBankTerm(bank.name) : "";
  if (!name) {
    return Number.MAX_SAFE_INTEGER;
  }

  const index = PREFERRED_BANK_TERMS.findIndex((term) => name.includes(term));
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function scoreBankMatch(bank: PouchBankAccount, query: string): number {
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

function sortBanks(banks: PouchBankAccount[], query: string): PouchBankAccount[] {
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
  country: string,
  currency: string,
): Promise<PouchBankAccount[]> {
  const cacheKey = getBankCacheKey(country);

  if (deps.redisClient) {
    const cached = await deps.redisClient.get(cacheKey).catch(() => null);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as { banks?: PouchBankAccount[] };
        if (Array.isArray(parsed.banks)) {
          console.log("[api-gateway][wallet] bank cache hit", {
            country,
            cacheKey,
            count: parsed.banks.length,
          });
          return parsed.banks;
        }
      } catch {
        // ignore bad cache payload and fall through to provider
      }
    }
  }

  const banks = dedupeBanks(
    await deps.pouchLiquifiaClient.listBanks(country, currency),
  );

  console.log("[api-gateway][wallet] bank cache miss", {
    country,
    cacheKey,
    count: banks.length,
  });

  if (deps.redisClient) {
    await deps.redisClient
      .set(
        cacheKey,
        JSON.stringify({ banks }),
        BANK_NETWORKS_CACHE_TTL_SECONDS,
      )
      .catch(() => undefined);
  }

  return banks;
}

// ─── Mapping helpers ───────────────────────────────────────────────

function mapBankAccount(bank: PouchBankAccount) {
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
  pouchPayoutId: string,
  providerReference: string,
): Promise<PouchPayout> {
  const payout = await deps.pouchLiquifiaClient.getPayout(pouchPayoutId);
  const outcome = classifyPouchPayoutStatus(payout.status);

  if (outcome === "settled") {
    await withdrawalClient.settle(providerReference);
  } else if (outcome === "failed") {
    await withdrawalClient.releaseFailedRequest({
      providerReference,
      failureReason: `Payout ${(payout.status ?? "failed").toLowerCase()}`,
      status: "FAILED",
    });
  } else {
    await withdrawalClient.markProcessing(providerReference);
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
  let payoutMayExist = false;
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

    // Below the provider's floor — reject before reserving funds, so we never
    // lock the user's money for a payout the provider was always going to refuse.
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
        error: `Minimum withdrawal is NGN ${MIN_WITHDRAWAL_NGN.toLocaleString("en-NG")}.`,
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

    // Look up user's virtual account for the payout source
    // With a treasury configured, payouts draw from the platform float and
    // the user needs no personal VA (drivers never have a funded one).
    const virtualAccount = await virtualAccountClient.findByUserId(user.id).catch(() => null);
    const payoutSourceVaId =
      deps.treasuryVirtualAccountId ?? virtualAccount?.pouchVirtualAccountId;
    if (!payoutSourceVaId) {
      sendJson(res, 404, {
        error: "Account not found. Please set up deposits first.",
        code: "VIRTUAL_ACCOUNT_NOT_FOUND",
      });
      return;
    }

    // Pouch pays out of the NAMED virtual account's own balance (confirmed
    // in production: a payout from an empty treasury VA fails with the
    // provider's INSUFFICIENT_BALANCE). Pre-check that exact vault so the
    // user gets an honest message before any ledger reservation.
    const vaBalance = await deps.pouchLiquifiaClient
      .getVirtualAccountBalance(payoutSourceVaId)
      .catch(() => null);
    const vaBalanceNgn = vaBalance ? Number(vaBalance.balance ?? 0) / 100 : null;
    if (vaBalanceNgn !== null && vaBalanceNgn < requestedAmountNgn + POUCH_PAYOUT_FEE_NGN) {
      console.error("[api-gateway][wallet-withdrawal] LIQUIDITY MISMATCH — ledger balance not backed by virtual account", {
        userId: user.id,
        requestedAmountNgn,
        vaBalanceNgn,
        feeNgn: POUCH_PAYOUT_FEE_NGN,
      });
      const withdrawableNgn = Math.floor(vaBalanceNgn - POUCH_PAYOUT_FEE_NGN);
      sendJson(res, 400, {
        error:
          withdrawableNgn >= MIN_WITHDRAWAL_NGN
            ? `You can withdraw up to NGN ${withdrawableNgn.toLocaleString("en-NG")} right now (a NGN ${POUCH_PAYOUT_FEE_NGN} transfer fee applies). Your wallet balance is untouched.`
            : "Withdrawals are temporarily unavailable for your account. Your wallet balance is untouched — please try again later.",
        code: "PAYOUT_ACCOUNT_SHORT",
        withdrawableNgn: Math.max(0, withdrawableNgn),
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
        // Reserve funds on the wallet
        const reserveResult = await withdrawalClient.reserve({
          userId: user.id,
          walletId: wallet.id,
          amountNgn: requestedAmountNgn,
          bankAccountNumber: accountNumber,
          bankAccountName: accountName,
          bankNetworkId: bankUuid,
        });
        reservedRequestId = reserveResult.request.id;

        // Create payout via Pouch Liquifia (from the treasury when configured).
        // A timeout or 5xx AFTER Pouch took the request is ambiguous: releasing
        // the reservation then pays the user twice. Keep it for reconciliation.
        let payout;
        try {
          payout = await deps.pouchLiquifiaClient.createPayout({
            virtualAccountId: payoutSourceVaId,
            reference: reserveResult.request.id,
            amount: requestedAmountNgn,
            destinationAccount: accountNumber,
            destinationBankUuid: bankUuid,
            idempotencyKey: reserveResult.request.id,
          });
        } catch (payoutError) {
          const status = (payoutError as { status?: unknown })?.status;
          if (typeof status !== 'number' || status >= 500 || status === 408) {
            payoutMayExist = true;
            throw new Error(
              'Your withdrawal was submitted but the bank has not confirmed it yet. The amount stays reserved until it does. Your wallet balance is untouched otherwise.',
            );
          }
          throw payoutError;
        }
        payoutMayExist = classifyPouchPayoutStatus(payout.status) !== "failed";

        // Pouch reports rejections inside an HTTP 200 — a payout with
        // status FAILED/REJECTED must not be recorded as created, or the
        // rider is told "submitted" while their money sits locked forever.
        if (classifyPouchPayoutStatus(payout.status) === "failed") {
          throw new Error(
            `The bank transfer was rejected by the payment provider (${payout.status}). Your balance has not been deducted — please check the account details and try again.`,
          );
        }

        // Attach the payout to the withdrawal request
        await withdrawalClient.attachPayout({
          withdrawalRequestId: reserveResult.request.id,
          pouchPayoutId: payout.id,
          providerReference: payout.reference,
        });

        // Publish PAYOUT_CREATED event for payment-service to track lifecycle
        const payoutCreatedEvent: PayoutCreatedEvent = {
          eventType: 'PAYOUT_CREATED',
          userId: user.id,
          pouchPayoutId: payout.id,
          withdrawalId: reserveResult.request.id,
          amountNgn: requestedAmountNgn,
          bankAccountNumber: accountNumber,
          bankAccountName: accountName,
          bankNetworkId: bankUuid,
          timestamp: new Date().toISOString(),
        };
        await deps.publisher.publishPaymentEvent(payoutCreatedEvent);

        console.log("[api-gateway][wallet-withdrawal] payout created", {
          withdrawalRequestId: reserveResult.request.id,
          pouchPayoutId: payout.id,
          providerReference: payout.reference,
          amountNgn: requestedAmountNgn,
        });

        const createdRequest = await withdrawalClient.findById(
          reserveResult.request.id,
        );

        return {
          statusCode: 200,
          body: {
            withdrawal: createdRequest
              ? mapWithdrawalRequest(createdRequest)
              : null,
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
      fundsWereReserved: Boolean(reservedRequestId),
      error: error instanceof Error ? error.message : String(error),
      providerStatus: (error as { status?: number })?.status ?? null,
      providerCode: (error as { code?: string })?.code ?? null,
    });

    if (reservedRequestId && payoutMayExist) {
      console.error("[api-gateway][wallet-withdrawal] payout may exist — reservation kept for reconciliation", {
        withdrawalRequestId: reservedRequestId,
      });
    } else if (reservedRequestId) {
      await withdrawalClient
        .releaseFailedRequest({
          withdrawalRequestId: reservedRequestId,
          failureReason:
            error instanceof Error
              ? error.message
              : "Withdrawal creation failed.",
          status: "FAILED",
        })
        .then(() => {
          console.warn("[api-gateway][wallet-withdrawal] reservation released after failure", {
            withdrawalRequestId: reservedRequestId,
          });
        })
        .catch((releaseErr) => {
          console.error('[api-gateway][wallet-withdrawal] failed to release reservation', {
            withdrawalRequestId: reservedRequestId,
            error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
          });
        });
    }

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
      code: "WITHDRAWAL_FAILED",
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

    // If a payout was attached, check its latest status from the provider
    if (request.pouchPayoutId && request.providerReference) {
      await syncPayoutStatus(
        deps,
        request.pouchPayoutId,
        request.providerReference,
      );
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

    const verified = await deps.pouchLiquifiaClient.validateBankAccount({
      accountNumber,
      bankUuid,
    });

    // Pouch answers an unknown account with an empty body rather than an
    // error. A missing account_name means the account could not be resolved —
    // report that plainly instead of letting clients invent a placeholder name.
    if (typeof verified.account_name !== "string" || !verified.account_name.trim()) {
      sendJson(res, 404, {
        error: "Account not found. Check the account number and bank.",
        code: "BANK_ACCOUNT_NOT_FOUND",
      });
      return;
    }

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
        bankName:
          typeof verified.bank_name === "string" ? verified.bank_name : null,
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

    // Fetch full user for name
    const fullUser = await userClient.findById(user.id);
    const { firstName, lastName } = pouchNameParts(fullUser?.name);

    // Create or retrieve Pouch customer
    let pouchCustomerId = fullUser?.pouchCustomerId;
    if (!pouchCustomerId) {
      const customer = await deps.pouchLiquifiaClient.createCustomer({
        customerReference: user.id,
        firstName,
        lastName,
      });
      pouchCustomerId = customer.id;
      await userClient.updatePouchCustomerId(user.id, pouchCustomerId);
    }

    // Create virtual account (idempotency key = userId to prevent duplicates on retry)
    const va = await deps.pouchLiquifiaClient.createVirtualAccount(
      pouchCustomerId,
      { country: "NG", currency: "NGN", idempotencyKey: `va-provision-${user.id}` },
    );

    let created;
    try {
      created = await virtualAccountClient.create({
        userId: user.id,
        pouchCustomerId,
        pouchVirtualAccountId: va.id,
        bankName: va.bank_name,
        accountNumber: va.account_number,
        accountName: va.account_name,
        currency: va.currency,
        country: va.country,
      });
    } catch (dbError) {
      // Concurrent provisioning race — another request already saved this VA
      if (
        dbError &&
        typeof dbError === "object" &&
        "code" in dbError &&
        dbError.code === "P2002"
      ) {
        const raced = await virtualAccountClient.findByUserId(user.id);
        if (raced) {
          sendJson(res, 200, {
            accountNumber: raced.accountNumber,
            accountName: raced.accountName,
            bankName: raced.bankName,
            currency: raced.currency,
            alreadyProvisioned: true,
          });
          return;
        }
      }
      throw dbError;
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
