import { createHash, randomInt, timingSafeEqual } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import {
  DEPOSIT_FEE_NGN,
  DEPOSIT_FEE_NOTICE,
  MIN_WITHDRAWAL_NGN,
  depositNeededFor,
  estimateDepositProviderFee,
  splitDeposit,
} from '@wheleers/config';
import { virtualAccountClient, walletClient, walletSecurityClient, withdrawalClient } from '@wheleers/db';
import type { PaymentsClient } from '@wheleers/payments';
import { verifyWalletPageToken, type WalletPageScope } from '../auth/local';
import { sendEmail } from '../email/resend';
import { provisionDepositAccount } from '../onboarding/user-onboarding';
import { getBanks } from '../payments/banks';
import { submitWithdrawal, WithdrawalError } from '../payments/withdrawal';
import type { RedisClient } from '../redis/client';
import { isRecord, pickNumber, pickString } from '../utils/object';
import {
  WalletSecurityError,
  resetPin,
  setInitialPin,
  verifyPin,
} from '../wallet-security/wallet-pin';
import type { GatewayPublisher } from '../websocket/publisher';
import { extractBearerToken } from './authenticate';
import { runIdempotentJsonRequest } from './idempotency';
import { readJsonBody, sendJson } from './utils';
import { logActivity } from '../analytics/log-activity';

const TAG = '[api-gateway][wallet-page]';
const CODE_TTL_SECONDS = 10 * 60;
const CODE_MAX_TRIES = 5;

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

const hashCode = (code: string) => createHash('sha256').update(code).digest('hex');
const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '••••';
  return `${local.slice(0, 1)}${'•'.repeat(Math.max(2, Math.min(6, local.length - 1)))}@${domain}`;
}

function firstNameOf(name: string | null | undefined): string {
  return name?.trim().split(/\s+/)[0] ?? '';
}

/** One stored code: what it is for, who it went to, how many guesses remain. */
async function storeCode(deps: WalletPageRouteDeps, key: string, email: string): Promise<string> {
  const code = newCode();
  await deps.redisClient.set(key, JSON.stringify({ email, codeHash: hashCode(code), tries: 0 }), CODE_TTL_SECONDS);
  return code;
}

async function consumeCode(deps: WalletPageRouteDeps, key: string, code: unknown): Promise<string> {
  const raw = await deps.redisClient.get(key).catch(() => null);
  if (!raw) throw new PageError('That code has expired. Request a new one.', 400, 'CODE_EXPIRED');
  const stored = JSON.parse(raw) as { email: string; codeHash: string; tries: number };
  if (stored.tries >= CODE_MAX_TRIES) {
    await deps.redisClient.del(key).catch(() => {});
    throw new PageError('Too many wrong codes. Request a new one.', 429, 'CODE_LOCKED');
  }
  const given = Buffer.from(hashCode(typeof code === 'string' ? code.trim() : ''));
  const expected = Buffer.from(stored.codeHash);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    await deps.redisClient.set(key, JSON.stringify({ ...stored, tries: stored.tries + 1 }), CODE_TTL_SECONDS);
    throw new PageError('That code is not right. Check the email and try again.', 400, 'CODE_WRONG');
  }
  await deps.redisClient.del(key).catch(() => {});
  return stored.email;
}

async function emailCode(deps: WalletPageRouteDeps, to: string, code: string, purpose: string): Promise<void> {
  if (!deps.resendApiKey) throw new PageError('Email is not available right now. Please try again later.', 503, 'EMAIL_UNAVAILABLE');
  await sendEmail({
    to,
    subject: `${code} is your Wheelers code`,
    html: `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px;background:#FFF8EC;border-radius:16px">
  <p style="font-size:15px;color:#3A2A1A;margin:0 0 12px">Use this code to ${purpose}:</p>
  <p style="font-size:34px;font-weight:700;letter-spacing:8px;color:#FF7700;margin:0 0 16px">${code}</p>
  <p style="font-size:13px;color:#8A7A6A;margin:0">It expires in 10 minutes. If you did not ask for this, ignore this email — your PIN has not changed.</p>
</div>`,
  }, deps.resendApiKey);
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

  const now = Date.now();
  const future = (d: Date | null) => (d && d.getTime() > now ? d.toISOString() : null);
  sendJson(res, 200, {
    scope,
    firstName: firstNameOf(security.name),
    balanceNgn: wallet ? Number(wallet.balanceNgn) : 0,
    lockedNgn: wallet ? Number(wallet.lockedNgn) : 0,
    account: account ? { bankName: account.bankName, accountNumber: account.accountNumber, accountName: account.accountName } : null,
    needsPhone,
    hasPin: Boolean(security.walletPinHash),
    recoveryEmail: security.recoveryEmail && security.recoveryEmailVerifiedAt ? maskEmail(security.recoveryEmail) : null,
    pinLockedUntil: future(security.walletPinLockedUntil),
    frozenUntil: future(security.withdrawalsFrozenUntil),
    frozenReason: future(security.withdrawalsFrozenUntil) ? security.withdrawalsFrozenReason : null,
    restrictedUntil: future(security.withdrawalsRestrictedUntil),
    minWithdrawalNgn: MIN_WITHDRAWAL_NGN,
    depositFeeNgn: DEPOSIT_FEE_NGN,
    depositFeeNotice: DEPOSIT_FEE_NOTICE,
  });
}

/* ── GET /wallet-page/deposit-preview?amount=&mode=send|receive ───────── */

function handleDepositPreview(req: IncomingMessage, res: ServerResponse, deps: WalletPageRouteDeps, url: URL): void {
  authenticate(req, deps, 'deposit');
  const amount = Number(url.searchParams.get('amount'));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) {
    throw new PageError('Enter an amount.', 400, 'AMOUNT_INVALID');
  }
  // "receive" = I want ₦X in my wallet → how much do I send?
  const sendNgn = url.searchParams.get('mode') === 'receive' ? depositNeededFor(amount) : Math.round(amount * 100) / 100;
  const bankChargeNgn = estimateDepositProviderFee(sendNgn);
  const split = splitDeposit(sendNgn, bankChargeNgn);
  sendJson(res, 200, {
    sendNgn,
    bankChargeNgn: Math.round((sendNgn - split.platformFeeNgn - split.userCreditNgn) * 100) / 100,
    wheelersFeeNgn: split.platformFeeNgn,
    walletGetsNgn: split.userCreditNgn,
    // The bank's cut is an estimate until the transfer really lands.
    estimated: true,
  });
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
  await emailCode(deps, email, await storeCode(deps, recoveryKey(userId), email), 'confirm your Wheelers recovery email');
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

const resetKey = (userId: string) => `wallet-page:pin-reset:${userId}`;

async function handlePinResetStart(req: IncomingMessage, res: ServerResponse, deps: WalletPageRouteDeps): Promise<void> {
  const { userId } = authenticate(req, deps, 'withdraw');
  const state = await walletSecurityClient.getState(userId);
  if (state.recoveryEmail && state.recoveryEmailVerifiedAt) {
    await emailCode(deps, state.recoveryEmail, await storeCode(deps, resetKey(userId), state.recoveryEmail), 'reset your Wheelers wallet PIN');
    sendJson(res, 200, { method: 'email', sentTo: maskEmail(state.recoveryEmail) });
    return;
  }
  // No second factor on file: the reset is allowed, and made worthless to a
  // thief by the pause that follows. Say so BEFORE they commit to it.
  sendJson(res, 200, { method: 'pause', pauseHours: 24 });
}

async function handlePinResetComplete(req: IncomingMessage, res: ServerResponse, deps: WalletPageRouteDeps): Promise<void> {
  const { userId } = authenticate(req, deps, 'withdraw');
  const body = await readBody(req);
  const state = await walletSecurityClient.getState(userId);
  const hasEmail = Boolean(state.recoveryEmail && state.recoveryEmailVerifiedAt);

  // An account WITH a recovery email must use it — otherwise a thief would
  // simply choose the no-email path and its 24h wait.
  let verifiedByEmail = false;
  if (hasEmail) {
    await consumeCode(deps, resetKey(userId), body.code);
    verifiedByEmail = true;
  }
  const outcome = await resetPin(userId, body.newPin, verifiedByEmail);
  logActivity({ userId, eventType: 'wallet_pin_reset', metadata: { verifiedByEmail } });

  if (state.phone && deps.notifyUser) {
    const message = verifiedByEmail
      ? '🔐 Your Wheelers wallet PIN was just changed.\n\nIf this was not you, reply *FREEZE* right now to pause withdrawals.'
      : '🔐 Your Wheelers wallet PIN was just reset.\n\nFor your safety, withdrawals are paused for 24 hours. Deposits and rides work as normal.\n\nIf this was not you, reply *FREEZE* right now and we will keep withdrawals locked.';
    void deps.notifyUser(state.phone, message).catch(() => {});
  }
  sendJson(res, 200, {
    ok: true,
    frozenUntil: outcome.frozenUntil?.toISOString() ?? null,
    restrictedUntil: outcome.restrictedUntil?.toISOString() ?? null,
  });
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
    if (error instanceof PageError) {
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
