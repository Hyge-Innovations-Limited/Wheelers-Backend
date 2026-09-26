import type { IncomingMessage, ServerResponse } from 'http';
import {
  MIN_WITHDRAWAL_NGN,
  depositNeededFor,
} from '@wheleers/config';
import { virtualAccountClient, walletClient, walletSecurityClient, withdrawalClient } from '@wheleers/db';
import type { PaymentsClient } from '@wheleers/payments';
import { verifyWalletPageToken, type WalletPageScope } from '../auth/local';
import { provisionDepositAccount } from '../onboarding/user-onboarding';
import { getBanks } from '../payments/banks';
import { submitWithdrawal, WithdrawalError } from '../payments/withdrawal';
import type { RedisClient } from '../redis/client';
import { getActiveRide, getPendingAccept } from '../whatsapp-flows/bid-state';
import { isRecord, pickNumber, pickString } from '../utils/object';
import {
  PinFlowError,
  completePinReset,
  consumeCode,
  getSecuritySummary,
  maskEmail,
  sendCode,
  startPinReset,
} from '../wallet-security/pin-flows';
import { WalletSecurityError, setInitialPin, verifyPin } from '../wallet-security/wallet-pin';
import type { GatewayPublisher } from '../websocket/publisher';
import { extractBearerToken } from './authenticate';
import { runIdempotentJsonRequest } from './idempotency';
import { readJsonBody, sendJson } from './utils';
import { logActivity } from '../analytics/log-activity';

const TAG = '[api-gateway][wallet-page]';

export interface WalletPageRouteDeps {
  jwtSecret: string;
  redisClient: RedisClient;
  paymentsClient: PaymentsClient;
  publisher: GatewayPublisher;
  resendApiKey?: string;
  /** Tells the rider in chat that their PIN was reset. Absent in tests. */
  notifyUser?: (phone: string, message: string) => Promise<void>;
}

/** A failure the page should show to the user verbatim. */
class PageError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

/* ── helpers ──────────────────────────────────────────────────────────── */

function authenticate(req: IncomingMessage, deps: WalletPageRouteDeps, needs?: WalletPageScope) {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) throw new PageError('This link is not valid. Ask the Wheelers bot for a new one.', 401, 'LINK_INVALID');
  let session;
  try {
    session = verifyWalletPageToken(token, deps.jwtSecret);
  } catch {
    throw new PageError('This link has expired. Ask the Wheelers bot for a new one.', 401, 'LINK_EXPIRED');
  }
  if (needs && session.scope !== needs) {
    throw new PageError('This link cannot be used for that.', 403, 'LINK_WRONG_SCOPE');
  }
  return session;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readJsonBody(req).catch(() => null);
  if (!isRecord(body)) throw new PageError('Something went wrong sending that. Please try again.', 400, 'BAD_REQUEST');
  return body;
}

function firstNameOf(name: string | null | undefined): string {
  return name?.trim().split(/\s+/)[0] ?? '';
}

/**
 * Adding money to take a driver they tapped in the chat? Then the page skips
 * "how much?" and opens on the figure to send — the shortfall for THAT fare,
 * charges folded in. Null for an ordinary deposit, or once the search is over.
 */
async function rideTopupFor(deps: WalletPageRouteDeps, userId: string, balanceNgn: number) {
  const pending = await getPendingAccept(deps.redisClient, userId).catch(() => null);
  if (!pending || balanceNgn + 0.004 >= pending.fareNgn) return null;
  if ((await getActiveRide(deps.redisClient, userId).catch(() => null)) !== pending.rideId) return null;
  const landsNgn = Math.ceil(pending.fareNgn - balanceNgn);
  return { driverName: pending.driverName, fareNgn: pending.fareNgn, landsNgn, sendNgn: depositNeededFor(landsNgn) };
}

/* ── GET /wallet-page/session ─────────────────────────────────────────── */

async function handleSession(req: IncomingMessage, res: ServerResponse, deps: WalletPageRouteDeps): Promise<void> {
  const { userId, scope } = authenticate(req, deps);
  let [security, wallet, account] = await Promise.all([
    walletSecurityClient.getState(userId),
    walletClient.findByUserId(userId),
    virtualAccountClient.findByUserId(userId),
  ]);

  // Opening the deposit page IS the request for an account number.
  let needsPhone = false;
  if (!account && scope === 'deposit') {
    const status = await provisionDepositAccount(deps.paymentsClient, userId, security.name ?? undefined, security.phone ?? undefined)
      .catch((error) => {
        console.warn(`${TAG} provisioning on page open failed`, { userId, error: error instanceof Error ? error.message : String(error) });
        return 'pending' as const;
      });
    needsPhone = status === 'needs_phone';
    account = await virtualAccountClient.findByUserId(userId);
  }

  const summary = await getSecuritySummary(userId);
  const balanceNgn = wallet ? Number(wallet.balanceNgn) : 0;
  sendJson(res, 200, {
    scope,
    rideTopup: scope === 'deposit' ? await rideTopupFor(deps, userId, balanceNgn) : null,
    firstName: firstNameOf(security.name),
    balanceNgn,
    lockedNgn: wallet ? Number(wallet.lockedNgn) : 0,
    account: account ? { bankName: account.bankName, accountNumber: account.accountNumber, accountName: account.accountName } : null,
    needsPhone,
    ...summary,
    minWithdrawalNgn: MIN_WITHDRAWAL_NGN,
  });
}

/* ── GET /wallet-page/deposit-preview?amount= ─────────────────────────── */

function handleDepositPreview(req: IncomingMessage, res: ServerResponse, deps: WalletPageRouteDeps, url: URL): void {
  authenticate(req, deps, 'deposit');
  const amount = Number(url.searchParams.get('amount'));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) {
    throw new PageError('Enter an amount.', 400, 'AMOUNT_INVALID');
  }
  // The rider says what they want IN their wallet; we say what to send. The
  // charges are worked out here and folded into that one figure — the page
  // shows "send ₦2,051 → ₦2,000 lands", never an itemised list.
  const walletGetsNgn = Math.floor(amount);
  if (walletGetsNgn < 1) throw new PageError('Enter an amount.', 400, 'AMOUNT_INVALID');
  sendJson(res, 200, { walletGetsNgn, sendNgn: depositNeededFor(walletGetsNgn) });
}

/* ── GET /wallet-page/banks?q= ────────────────────────────────────────── */

async function handleBanks(req: IncomingMessage, res: ServerResponse, deps: WalletPageRouteDeps, url: URL): Promise<void> {
  authenticate(req, deps, 'withdraw');
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const banks = await getBanks(deps.paymentsClient, deps.redisClient);
  const matches = q ? banks.filter((b) => b.name.toLowerCase().includes(q)) : banks;
  sendJson(res, 200, { banks: matches.slice(0, 400).map((b) => ({ code: b.code, name: b.name })) });
}

/* ── POST /wallet-page/resolve-account ────────────────────────────────── */

async function handleResolveAccount(req: IncomingMessage, res: ServerResponse, deps: WalletPageRouteDeps): Promise<void> {
  const { userId } = authenticate(req, deps, 'withdraw');
  const body = await readBody(req);
  const bankCode = pickString(body, ['bankCode']);
  const accountNumber = pickString(body, ['accountNumber'])?.replace(/\D/g, '');
  if (!bankCode || !accountNumber || !/^\d{10}$/.test(accountNumber)) {
    throw new PageError('Enter a 10-digit account number and pick a bank.', 400, 'ACCOUNT_INVALID');
  }

  // Name lookups cost the provider money and are a way to enumerate accounts.
  const bucket = `wallet-page:resolve:${userId}:${Math.floor(Date.now() / 60_000)}`;
  const used = Number((await deps.redisClient.get(bucket).catch(() => null)) ?? 0);
  if (used >= 10) throw new PageError('Too many lookups. Wait a minute and try again.', 429, 'RATE_LIMITED');
  await deps.redisClient.set(bucket, String(used + 1), 90).catch(() => {});

  const verified = await deps.paymentsClient.validateBankAccount({ accountNumber, bankCode }).catch((error) => {
    const status = (error as { status?: number })?.status;
    if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) return null;
    throw error;
  });
  if (!verified?.account_name?.trim()) {
    throw new PageError('We could not find that account. Check the number and the bank.', 404, 'ACCOUNT_NOT_FOUND');
  }
  sendJson(res, 200, { accountNumber: verified.account_number || accountNumber, accountName: verified.account_name.trim(), bankCode });
}

/* ── POST /wallet-page/pin ─ first PIN ────────────────────────────────── */

async function handleSetPin(req: IncomingMessage, res: ServerResponse, deps: WalletPageRouteDeps): Promise<void> {
  const { userId } = authenticate(req, deps, 'withdraw');
  const body = await readBody(req);
  await setInitialPin(userId, body.pin);
  logActivity({ userId, eventType: 'wallet_pin_set', metadata: {} });
  sendJson(res, 200, { ok: true });
}

/* ── POST /wallet-page/recovery-email/{start,verify} ──────────────────── */

const recoveryKey = (userId: string) => `wallet-page:recovery-email:${userId}`;

async function handleRecoveryEmailStart(req: IncomingMessage, res: ServerResponse, deps: WalletPageRouteDeps): Promise<void> {
  const { userId } = authenticate(req, deps, 'withdraw');
  const body = await readBody(req);
  // Changing where reset codes go is as sensitive as changing the PIN.
  await verifyPin(userId, body.pin);
  const email = pickString(body, ['email'])?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
    throw new PageError('That does not look like an email address.', 400, 'EMAIL_INVALID');
  }
  await walletSecurityClient.setRecoveryEmail(userId, email);
  await sendCode(deps, recoveryKey(userId), email, 'confirm your Wheelers recovery email');
  sendJson(res, 200, { sentTo: maskEmail(email) });
}

async function handleRecoveryEmailVerify(req: IncomingMessage, res: ServerResponse, deps: WalletPageRouteDeps): Promise<void> {
  const { userId } = authenticate(req, deps, 'withdraw');
  const body = await readBody(req);
  const email = await consumeCode(deps, recoveryKey(userId), body.code);
  const updated = await walletSecurityClient.markRecoveryEmailVerified(userId, email);
  if (updated.count === 0) throw new PageError('That email was changed. Start again.', 409, 'EMAIL_CHANGED');
  logActivity({ userId, eventType: 'wallet_recovery_email_verified', metadata: {} });
  sendJson(res, 200, { recoveryEmail: maskEmail(email) });
}

/* ── POST /wallet-page/pin-reset/{start,complete} ─────────────────────── */

async function handlePinResetStart(req: IncomingMessage, res: ServerResponse, deps: WalletPageRouteDeps): Promise<void> {
  const { userId } = authenticate(req, deps, 'withdraw');
  sendJson(res, 200, await startPinReset(deps, userId));
}

async function handlePinResetComplete(req: IncomingMessage, res: ServerResponse, deps: WalletPageRouteDeps): Promise<void> {
  const { userId } = authenticate(req, deps, 'withdraw');
  const body = await readBody(req);
  sendJson(res, 200, { ok: true, ...(await completePinReset(deps, userId, { code: body.code, newPin: body.newPin })) });
}

/* ── POST /wallet-page/withdraw ───────────────────────────────────────── */

async function handleWithdraw(req: IncomingMessage, res: ServerResponse, deps: WalletPageRouteDeps): Promise<void> {
  const { userId } = authenticate(req, deps, 'withdraw');
  const body = await readBody(req);
  const amountNgn = Math.round((pickNumber(body, ['amountNgn']) ?? 0) * 100) / 100;
  const bankCode = pickString(body, ['bankCode']);
  const accountNumber = pickString(body, ['accountNumber'])?.replace(/\D/g, '');
  const accountName = pickString(body, ['accountName'])?.trim();
  if (!(amountNgn > 0) || !bankCode || !accountNumber || !accountName) {
    throw new PageError('Some details are missing. Go back and check them.', 400, 'BAD_REQUEST');
  }

  const wallet = await walletClient.findByUserId(userId);
  if (!wallet) throw new PageError('You have no wallet balance to withdraw.', 400, 'NO_WALLET');
  if (Number(wallet.balanceNgn) < amountNgn) {
    throw new PageError(`You can withdraw up to ₦${Number(wallet.balanceNgn).toLocaleString('en-NG')}.`, 400, 'INSUFFICIENT_BALANCE');
  }

  // The PIN must not be part of the idempotency fingerprint (it would sit in
  // Redis). The key itself is a fresh UUID per tap of "Withdraw".
  const { pin, ...fingerprint } = body;
  const result = await runIdempotentJsonRequest({
    req,
    redisClient: deps.redisClient,
    userId,
    routeKey: 'wallet-page:withdraw',
    requestBody: fingerprint,
    execute: async () => {
      const { requestId } = await submitWithdrawal(
        { paymentsClient: deps.paymentsClient, publisher: deps.publisher },
        { userId, walletId: wallet.id, amountNgn, bankCode, accountNumber, accountName, pin, pinPolicy: 'required' },
      );
      const request = await withdrawalClient.findById(requestId);
      return { statusCode: 200, body: { withdrawalId: requestId, status: request?.status ?? 'PAYOUT_CREATED', amountNgn } };
    },
  });
  logActivity({ userId, eventType: 'withdrawal_created', metadata: { amountNgn, via: 'wallet_page' } });
  sendJson(res, result.statusCode, result.body);
}

/* ── dispatcher ───────────────────────────────────────────────────────── */

const ROUTES: Record<string, { method: 'GET' | 'POST'; run: (req: IncomingMessage, res: ServerResponse, deps: WalletPageRouteDeps, url: URL) => void | Promise<void> }> = {
  '/wallet-page/session': { method: 'GET', run: handleSession },
  '/wallet-page/deposit-preview': { method: 'GET', run: handleDepositPreview },
  '/wallet-page/banks': { method: 'GET', run: handleBanks },
  '/wallet-page/resolve-account': { method: 'POST', run: handleResolveAccount },
  '/wallet-page/pin': { method: 'POST', run: handleSetPin },
  '/wallet-page/recovery-email/start': { method: 'POST', run: handleRecoveryEmailStart },
  '/wallet-page/recovery-email/verify': { method: 'POST', run: handleRecoveryEmailVerify },
  '/wallet-page/pin-reset/start': { method: 'POST', run: handlePinResetStart },
  '/wallet-page/pin-reset/complete': { method: 'POST', run: handlePinResetComplete },
  '/wallet-page/withdraw': { method: 'POST', run: handleWithdraw },
};

/** Every /wallet-page/* request. Returns false when the path is not ours. */
export async function handleWalletPageRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WalletPageRouteDeps,
  url: URL,
): Promise<boolean> {
  const route = ROUTES[url.pathname];
  if (!route) return false;
  if (req.method !== route.method) {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }

  // These responses carry balances and account numbers: never cache them.
  res.setHeader('Cache-Control', 'no-store');
  try {
    await route.run(req, res, deps, url);
  } catch (error) {
    if (error instanceof PageError || error instanceof PinFlowError) {
      sendJson(res, error.status, { error: error.message, code: error.code });
    } else if (error instanceof WalletSecurityError) {
      const status = error.code === 'PIN_LOCKED' ? 429 : error.code === 'WITHDRAWALS_FROZEN' || error.code === 'DESTINATION_RESTRICTED' ? 403 : 400;
      sendJson(res, status, { error: error.message, code: error.code, ...error.details });
    } else if (error instanceof WithdrawalError) {
      sendJson(res, 400, { error: error.message, code: error.code, fundsStillReserved: error.fundsStillReserved });
    } else {
      console.error(`${TAG} ${url.pathname} failed`, { error: error instanceof Error ? error.message : String(error) });
      sendJson(res, 500, { error: 'Something went wrong on our side. Please try again.', code: 'INTERNAL' });
    }
  }
  return true;
}
