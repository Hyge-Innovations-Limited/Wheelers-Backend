import type { IncomingMessage, ServerResponse } from 'http';
import { userClient, virtualAccountClient, walletClient, withdrawalClient } from '@wheleers/db';
import { transferFeeNgn, type PaymentsClient } from '@wheleers/payments';
import type {
  PayoutCompletedEvent,
  PayoutFailedEvent,
  VirtualAccountCreditedEvent,
} from '@wheleers/kafka-schemas';
import type { GatewayPublisher } from '../websocket/publisher';
import type { RedisClient } from '../redis/client';
import { isRecord } from '../utils/object';
import { parseJsonBuffer, readRawBody, sendJson } from './utils';

const TAG = '[api-gateway][paystack-webhook]';

export interface PaystackWebhookRouteDeps {
  publisher: GatewayPublisher;
  paymentsClient: PaymentsClient;
  redisClient?: RedisClient;
}

/**
 * POST /webhooks/paystack
 *
 * Three rules, each learned the hard way on the previous provider:
 *   1. ONE reference field. The old webhook accepted two event names for the
 *      same transfer and picked its reference from seven candidate fields, so
 *      one transfer could arrive under two references and be credited twice.
 *      Here a deposit is `data.reference` and a payout is `data.reference`
 *      (which is our own withdrawal request id). Nothing else is consulted.
 *   2. The body is a HINT. Amount, fee and status are read back from
 *      Paystack before any money moves, so a forged or stale body is inert.
 *   3. A failure answers 500. Paystack retries for days; every handler below
 *      is idempotent, so a retry is always safe and a swallowed error never is.
 */
export async function handlePaystackWebhookRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PaystackWebhookRouteDeps,
): Promise<void> {
  let dedupKey: string | null = null;
  try {
    const rawBody = await readRawBody(req);
    const header = req.headers['x-paystack-signature'];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!deps.paymentsClient.verifyWebhookSignature(rawBody, signature)) {
      console.warn(`${TAG} rejected: bad or missing signature`);
      sendJson(res, 401, { error: 'Invalid webhook signature' });
      return;
    }

    const body = parseJsonBuffer(rawBody);
    if (!isRecord(body) || typeof body.event !== 'string' || !isRecord(body.data)) {
      sendJson(res, 200, { received: true, processed: false, reason: 'Unrecognised body' });
      return;
    }
    const eventName = body.event;
    const data = body.data;
    const reference = typeof data.reference === 'string' ? data.reference : null;
    console.log(`${TAG} received`, { eventName, reference });

    // Fast path only — the ledger's unique keys are the real guard.
    if (reference && deps.redisClient) {
      dedupKey = `paystack:webhook:${eventName}:${reference}`;
      const fresh = await deps.redisClient.setIfNotExists(dedupKey, '1', 86_400).catch(() => true);
      if (!fresh) {
        sendJson(res, 200, { received: true, processed: false, reason: 'Duplicate event' });
        return;
      }
    }

    switch (eventName) {
      case 'charge.success':
        await handleDeposit(data, deps);
        break;
      case 'transfer.success':
        await handleTransferSuccess(data, deps);
        break;
      case 'transfer.failed':
      case 'transfer.reversed':
        await handleTransferFailed(eventName, data, deps);
        break;
      case 'dedicatedaccount.assign.success':
        await handleAccountAssigned(data);
        break;
      case 'dedicatedaccount.assign.failed':
        console.error(`${TAG} deposit account assignment FAILED`, {
          customer: isRecord(data.customer) ? data.customer.customer_code : null,
        });
        break;
      default:
        sendJson(res, 200, { received: true, processed: false, reason: `Unhandled event: ${eventName}` });
        return;
    }

    sendJson(res, 200, { received: true, processed: true });
  } catch (error) {
    // Let the retry through: a dedup marker left behind would turn one
    // transient failure into a permanently lost deposit.
    if (dedupKey && deps.redisClient) {
      await deps.redisClient.del(dedupKey).catch(() => {});
    }
    console.error(`${TAG} handler failed — provider will retry`, {
      message: error instanceof Error ? error.message : String(error),
    });
    sendJson(res, 500, { error: 'Failed to process webhook' });
  }
}

/* ── Deposits ─────────────────────────────────────────────────────── */

async function handleDeposit(data: Record<string, unknown>, deps: PaystackWebhookRouteDeps): Promise<void> {
  const reference = typeof data.reference === 'string' ? data.reference : null;
  if (!reference) {
    console.warn(`${TAG} charge.success without a reference — ignored`);
    return;
  }

  const verified = await deps.paymentsClient.verifyTransaction(reference);
  if (!verified) {
    console.warn(`${TAG} charge.success for a reference the provider does not know`, { reference });
    return;
  }
  if (verified.status !== 'success') {
    console.warn(`${TAG} charge.success but provider says otherwise`, { reference, status: verified.status });
    return;
  }
  // Wallets are funded by bank transfer into a dedicated account, nothing
  // else. A card or USSD charge on this integration is not a wallet deposit.
  if (verified.channel !== 'dedicated_nuban') {
    console.info(`${TAG} non-deposit charge ignored`, { reference, channel: verified.channel });
    return;
  }
  if (!(verified.amountNgn > 0)) {
    console.warn(`${TAG} deposit with no amount`, { reference });
    return;
  }

  const owner = await resolveDepositOwner(verified.customerId, verified.receiverAccountNumber, verified.customerEmail);
  if (!owner) {
    // Real cash with no owner. Must be seen by a human, and must NOT be
    // retried into oblivion — answering 200 keeps it in the logs once.
    console.error(`${TAG} CRITICAL: deposit received but no user matches it`, {
      reference,
      amountNgn: verified.amountNgn,
      customerId: verified.customerId,
      receiverAccountNumber: verified.receiverAccountNumber,
    });
    return;
  }

  const event: VirtualAccountCreditedEvent = {
    eventType: 'VIRTUAL_ACCOUNT_CREDITED',
    userId: owner.userId,
    providerAccountId: owner.providerAccountId ?? verified.receiverAccountNumber ?? 'unknown',
    amountNgn: verified.amountNgn,
    providerFeeNgn: verified.providerFeeNgn,
    bankName: verified.senderBank ?? undefined,
    senderAccountNumber: verified.senderAccountNumber ?? undefined,
    senderAccountName: verified.senderName ?? undefined,
    providerReference: reference,
    timestamp: new Date().toISOString(),
  };
  await deps.publisher.publishPaymentEvent(event);

  console.log(`${TAG} deposit accepted`, {
    userId: owner.userId,
    reference,
    amountNgn: verified.amountNgn,
    providerFeeNgn: verified.providerFeeNgn,
  });
}

async function resolveDepositOwner(
  customerId: string | null,
  accountNumber: string | null,
  customerEmail: string | null,
): Promise<{ userId: string; providerAccountId: string | null } | null> {
  if (accountNumber) {
    const account = await virtualAccountClient.findByAccountNumber(accountNumber);
    if (account) return { userId: account.userId, providerAccountId: account.providerAccountId };
  }
  if (customerId) {
    const user = await userClient.findByProviderCustomerId(customerId);
    if (user) {
      const account = await virtualAccountClient.findByUserId(user.id);
      return { userId: user.id, providerAccountId: account?.providerAccountId ?? null };
    }
  }
  // The synthetic customer email is "<userId>@domain".
  const localPart = customerEmail?.split('@')[0];
  if (localPart && /^[0-9a-f-]{36}$/i.test(localPart)) {
    const user = await userClient.findById(localPart).catch(() => null);
    if (user) return { userId: user.id, providerAccountId: null };
  }
  return null;
}

/* ── Payouts ──────────────────────────────────────────────────────── */

async function handleTransferSuccess(data: Record<string, unknown>, deps: PaystackWebhookRouteDeps): Promise<void> {
  const reference = typeof data.reference === 'string' ? data.reference : null;
  if (!reference) return;

  const withdrawal = await withdrawalClient.findByProviderReference(reference);
  if (!withdrawal) {
    console.info(`${TAG} transfer.success with no matching withdrawal (manual transfer from the dashboard?)`, { reference });
    return;
  }

  // Confirm with the provider, and learn what the transfer cost us.
  const payout = await deps.paymentsClient.getPayout(reference);
  if (!payout || payout.status.toLowerCase() !== 'success') {
    console.warn(`${TAG} transfer.success but provider says otherwise`, { reference, status: payout?.status ?? null });
    return;
  }
  const amountNgn = Number(withdrawal.requestedAmountNgn);
  const providerFeeNgn = payout.feeNgn ?? transferFeeNgn(amountNgn);

  await withdrawalClient.settle(reference, { providerFeeNgn });

  const event: PayoutCompletedEvent = {
    eventType: 'PAYOUT_COMPLETED',
    userId: withdrawal.userId,
    providerPayoutId: payout.id,
    providerReference: reference,
    amountNgn,
    timestamp: new Date().toISOString(),
  };
  await deps.publisher.publishPaymentEvent(event);
  console.log(`${TAG} withdrawal settled`, { withdrawalId: withdrawal.id, amountNgn, providerFeeNgn });
}

async function handleTransferFailed(
  eventName: string,
  data: Record<string, unknown>,
  deps: PaystackWebhookRouteDeps,
): Promise<void> {
  const reference = typeof data.reference === 'string' ? data.reference : null;
  if (!reference) return;

  const withdrawal = await withdrawalClient.findByProviderReference(reference);
  if (!withdrawal) {
    console.warn(`${TAG} ${eventName} with no matching withdrawal`, { reference });
    return;
  }

  const failureReason =
    (typeof data.gateway_response === 'string' && data.gateway_response) ||
    (typeof data.reason === 'string' && data.reason) ||
    (eventName === 'transfer.reversed' ? 'Transfer reversed by the bank' : 'Transfer failed');

  if (withdrawal.status === 'SETTLED') {
    // The bank took the money, then sent it back. The cash is in our balance
    // again, so the user's wallet must get it back too — once.
    const wallet = await walletClient.findByUserId(withdrawal.userId);
    if (wallet) {
      const refund = await walletClient.credit({
        walletId: wallet.id,
        amountNgn: Number(withdrawal.requestedAmountNgn),
        type: 'REFUND',
        referenceId: `withdrawal-reversed-${withdrawal.id}`,
        metadata: { withdrawalId: withdrawal.id, reason: failureReason },
      });
      console.error(`${TAG} settled withdrawal was REVERSED — wallet refunded`, {
        withdrawalId: withdrawal.id,
        applied: refund.applied,
      });
    }
  } else {
    await withdrawalClient.releaseFailedRequest({
      providerReference: reference,
      failureReason,
      status: 'FAILED',
    });
  }

  const event: PayoutFailedEvent = {
    eventType: 'PAYOUT_FAILED',
    userId: withdrawal.userId,
    providerPayoutId: withdrawal.providerPayoutId ?? reference,
    providerReference: reference,
    failureReason,
    timestamp: new Date().toISOString(),
  };
  await deps.publisher.publishPaymentEvent(event);
  console.log(`${TAG} ${eventName} processed`, { withdrawalId: withdrawal.id, failureReason });
}

/* ── Late account assignment ──────────────────────────────────────── */

async function handleAccountAssigned(data: Record<string, unknown>): Promise<void> {
  const customer = isRecord(data.customer) ? data.customer : null;
  const account = isRecord(data.dedicated_account) ? data.dedicated_account : null;
  const customerId = typeof customer?.customer_code === 'string' ? customer.customer_code : null;
  const accountNumber = typeof account?.account_number === 'string' ? account.account_number : null;
  if (!customerId || !account || !accountNumber) return;

  const user = await userClient.findByProviderCustomerId(customerId);
  if (!user) {
    console.warn(`${TAG} account assigned to a customer we do not know`, { customerId });
    return;
  }
  const bank = isRecord(account.bank) ? account.bank : {};
  await virtualAccountClient.upsertForUser(user.id, {
    providerCustomerId: customerId,
    providerAccountId: String(account.id ?? accountNumber),
    bankName: typeof bank.name === 'string' ? bank.name : '',
    accountNumber,
    accountName: typeof account.account_name === 'string' ? account.account_name : '',
  });
  console.log(`${TAG} deposit account saved`, { userId: user.id, accountNumber });
}
