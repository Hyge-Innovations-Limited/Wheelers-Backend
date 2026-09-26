import type { IncomingMessage, ServerResponse } from 'http';
import type { PaymentsClient } from '@wheleers/payments';
import type { GatewayPublisher } from '../websocket/publisher';
import { cancelQueued, currentPayoutMode, markQueuedPaid, sendQueuedNow, WithdrawalError } from '../payments/withdrawal';
import type { RedisClient } from '../redis/client';
import { serviceUsage } from '../usage/service-usage';
import { activityClient, adminMetricsClient, safetyAlertClient, walletSecurityClient, withdrawalClient } from '@wheleers/db';
import type { SafetyAlertWithPeople } from '@wheleers/db';
import { verifyAdminAuth } from './admin-auth.route';
import { readJsonBody, sendJson } from './utils';
import { logActivity } from '../analytics/log-activity';
import { isRecord } from '../utils/object';

/**
 * The admin panel's data layer: a real user directory, per-user drill-down,
 * and platform metrics drawn from the transaction ledger.
 *
 * These replace the old top-10 leaderboards, which could not answer the two
 * questions an operator actually asks — "who are my users?" and "where did the
 * money go?".
 */

interface MetricsDeps {
  adminApiKey: string;
  jwtSecret: string;
}

/** The withdrawal queue's actions move money, so they need the payments client and the bus. */
export interface WithdrawalAdminDeps extends MetricsDeps {
  paymentsClient: PaymentsClient;
  publisher: GatewayPublisher;
}

async function requireAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MetricsDeps,
): Promise<boolean> {
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return false;
  }
  return true;
}

function intParam(url: URL, key: string, fallback: number): number {
  const raw = Number.parseInt(url.searchParams.get(key) ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function fail(res: ServerResponse, error: unknown, message: string): void {
  console.error(`[admin-metrics] ${message}`, {
    error: error instanceof Error ? error.message : String(error),
  });
  sendJson(res, 500, {
    error: error instanceof Error ? error.message : message,
  });
}

/** GET /admin/users?role=&q=&limit=&offset=&sort= */
export async function handleAdminListUsersRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MetricsDeps,
  url: URL,
): Promise<void> {
  if (!(await requireAdmin(req, res, deps))) return;

  const roleParam = url.searchParams.get('role');
  const sortParam = url.searchParams.get('sort');
  const role = roleParam === 'rider' || roleParam === 'driver' ? roleParam : 'all';
  const sort =
    sortParam === 'rides' || sortParam === 'spend' || sortParam === 'name'
      ? sortParam
      : 'recent';

  try {
    const result = await adminMetricsClient.listUsers({
      role,
      sort,
      q: url.searchParams.get('q') ?? undefined,
      limit: intParam(url, 'limit', 25),
      offset: intParam(url, 'offset', 0),
    });
    sendJson(res, 200, result);
  } catch (error) {
    fail(res, error, 'could not list users');
  }
}

/** GET /admin/users/:userId — profile, wallet, rides, money and recent activity. */
export async function handleAdminGetUserRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MetricsDeps,
  userId: string,
): Promise<void> {
  if (!(await requireAdmin(req, res, deps))) return;

  try {
    const detail = await adminMetricsClient.getUserDetail(userId);
    if (!detail) {
      sendJson(res, 404, { error: 'User not found' });
      return;
    }

    // Activity lives beside the profile now, instead of behind a page that
    // demanded you paste a uuid before it would show anything.
    const activity = await activityClient
      .listByUser(userId, { limit: 40 })
      .catch(() => ({ items: [], nextCursor: null }));

    // Never the hash — only whether a PIN exists and what is blocking withdrawals.
    const security = await walletSecurityClient.getState(userId).catch(() => null);
    const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;
    const active = (value: Date | null | undefined) => Boolean(value && value.getTime() > Date.now());

    sendJson(res, 200, {
      ...detail,
      security: security
        ? {
            hasPin: Boolean(security.walletPinHash),
            withdrawalsFrozen: active(security.withdrawalsFrozenUntil),
            withdrawalsRestricted: active(security.withdrawalsRestrictedUntil),
            pinLockedUntil: iso(security.walletPinLockedUntil),
            withdrawalsFrozenUntil: iso(security.withdrawalsFrozenUntil),
            withdrawalsFrozenReason: security.withdrawalsFrozenReason,
            withdrawalsRestrictedUntil: iso(security.withdrawalsRestrictedUntil),
          }
        : null,
      activity: {
        items: activity.items.map((row) => ({
          id: row.id,
          eventType: row.eventType,
          source: row.source,
          rideId: row.rideId,
          metadata: row.metadata,
          occurredAt: row.occurredAt.toISOString(),
        })),
        nextCursor: activity.nextCursor,
      },
    });
  } catch (error) {
    fail(res, error, 'could not load user');
  }
}

/** GET /admin/metrics/overview — every headline number in one payload. */
export async function handleAdminOverviewRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MetricsDeps,
): Promise<void> {
  if (!(await requireAdmin(req, res, deps))) return;

  try {
    sendJson(res, 200, await adminMetricsClient.overview());
  } catch (error) {
    fail(res, error, 'could not load overview');
  }
}

/** GET /admin/metrics/timeseries?days=30 */
export async function handleAdminTimeseriesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MetricsDeps,
  url: URL,
): Promise<void> {
  if (!(await requireAdmin(req, res, deps))) return;

  try {
    const days = intParam(url, 'days', 30);
    sendJson(res, 200, { days, points: await adminMetricsClient.timeseries(days) });
  } catch (error) {
    fail(res, error, 'could not load timeseries');
  }
}

/** GET /admin/metrics/cancellations — why requests fail. */
export async function handleAdminCancellationsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MetricsDeps,
): Promise<void> {
  if (!(await requireAdmin(req, res, deps))) return;

  try {
    sendJson(res, 200, { reasons: await adminMetricsClient.cancellationBreakdown() });
  } catch (error) {
    fail(res, error, 'could not load cancellations');
  }
}

/** GET /admin/metrics/group-rides — the group-ride funnel and its drop-offs. */
export async function handleAdminGroupRideMetricsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MetricsDeps,
): Promise<void> {
  if (!(await requireAdmin(req, res, deps))) return;

  try {
    sendJson(res, 200, await adminMetricsClient.groupRideMetrics());
  } catch (error) {
    fail(res, error, 'could not load group ride metrics');
  }
}

/** GET /admin/rides?status=&q=&limit=&offset= */
export async function handleAdminListRidesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MetricsDeps,
  url: URL,
): Promise<void> {
  if (!(await requireAdmin(req, res, deps))) return;

  try {
    const result = await adminMetricsClient.listRides({
      status: url.searchParams.get('status') ?? undefined,
      q: url.searchParams.get('q') ?? undefined,
      limit: intParam(url, 'limit', 25),
      offset: intParam(url, 'offset', 0),
    });
    sendJson(res, 200, result);
  } catch (error) {
    fail(res, error, 'could not list rides');
  }
}

/* ── Safety alerts ─────────────────────────────────────────────────────────
 *
 * The operator's view of the emergency button. Deliberately its own section:
 * every other route in this file answers "how is the business doing", and this
 * one answers "is someone in trouble right now".
 */

function serializeAdminAlert(alert: SafetyAlertWithPeople) {
  return {
    id: alert.id,
    status: alert.status,
    kind: alert.kind,
    raisedByRole: alert.raisedByRole,
    rideId: alert.rideId,
    interstateDepartureId: alert.interstateDepartureId,
    counterpartUserId: alert.counterpartUserId,
    lat: alert.lat,
    lng: alert.lng,
    address: alert.address,
    note: alert.note,
    handledBy: alert.handledBy,
    resolution: alert.resolution,
    createdAt: alert.createdAt.toISOString(),
    acknowledgedAt: alert.acknowledgedAt?.toISOString() ?? null,
    resolvedAt: alert.resolvedAt?.toISOString() ?? null,
    cancelledAt: alert.cancelledAt?.toISOString() ?? null,
    user: {
      id: alert.user.id,
      name: alert.user.name,
      username: alert.user.username,
      phone: alert.user.phone,
      email: alert.user.email,
      photoUrl: alert.user.photoUrl,
      role: alert.user.role,
    },
  };
}

/** GET /admin/alerts?status=LIVE|OPEN|ACKNOWLEDGED|RESOLVED|CANCELLED|ALL */
export async function handleAdminListAlertsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MetricsDeps,
  url: URL,
): Promise<void> {
  if (!(await requireAdmin(req, res, deps))) return;

  try {
    const status = (url.searchParams.get('status') ?? 'LIVE').toUpperCase();
    const [items, counts] = await Promise.all([
      safetyAlertClient.list({
        status: status as Parameters<typeof safetyAlertClient.list>[0]['status'],
        limit: intParam(url, 'limit', 50),
        cursor: url.searchParams.get('cursor') ?? undefined,
      }),
      safetyAlertClient.counts(),
    ]);

    sendJson(res, 200, { items: items.map(serializeAdminAlert), counts });
  } catch (error) {
    fail(res, error, 'could not load safety alerts');
  }
}

/**
 * GET /admin/alerts/count — just the badge number.
 *
 * Split from the list because the nav polls this on every page, and shipping a
 * full alert list (with phone numbers) to render a red dot would be both slow
 * and needlessly leaky.
 */
export async function handleAdminAlertCountRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MetricsDeps,
): Promise<void> {
  if (!(await requireAdmin(req, res, deps))) return;

  try {
    sendJson(res, 200, await safetyAlertClient.counts());
  } catch (error) {
    fail(res, error, 'could not count safety alerts');
  }
}

/** POST /admin/alerts/:id/acknowledge */
export async function handleAdminAcknowledgeAlertRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MetricsDeps,
  alertId: string,
): Promise<void> {
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  try {
    const alert = await safetyAlertClient.acknowledge({
      id: alertId,
      handledBy: auth.adminName,
    });

    if (!alert) {
      sendJson(res, 409, { error: 'This alert is no longer open.' });
      return;
    }

    sendJson(res, 200, { alert: serializeAdminAlert(alert) });
  } catch (error) {
    fail(res, error, 'could not acknowledge alert');
  }
}

/** POST /admin/alerts/:id/resolve */
export async function handleAdminResolveAlertRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MetricsDeps,
  alertId: string,
): Promise<void> {
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  try {
    const rawBody = await readJsonBody(req).catch(() => ({}));
    const resolution =
      isRecord(rawBody) && typeof rawBody['resolution'] === 'string'
        ? rawBody['resolution'].trim()
        : '';

    if (!resolution) {
      // Closing an emergency without saying what happened destroys the only
      // record of how it was handled.
      sendJson(res, 400, { error: 'Say what happened before resolving this alert.' });
      return;
    }

    const alert = await safetyAlertClient.resolve({
      id: alertId,
      handledBy: auth.adminName,
      resolution,
    });

    if (!alert) {
      sendJson(res, 409, { error: 'This alert has already been closed.' });
      return;
    }

    sendJson(res, 200, { alert: serializeAdminAlert(alert) });
  } catch (error) {
    fail(res, error, 'could not resolve alert');
  }
}

/**
 * POST /admin/users/:id/withdrawals/freeze   — lock every withdrawal
 * POST /admin/users/:id/withdrawals/unfreeze — lift a freeze AND any post-reset
 *                                              destination restriction
 *
 * For the call that starts "my phone was stolen". A user can freeze themselves
 * (replying FREEZE in chat); only an admin can undo it.
 */
export async function handleAdminWithdrawalFreezeRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MetricsDeps,
  userId: string,
  action: 'freeze' | 'unfreeze',
): Promise<void> {
  if (!(await requireAdmin(req, res, deps))) return;

  try {
    if (action === 'freeze') {
      await walletSecurityClient.freezeWithdrawals(userId, new Date('2099-12-31T00:00:00Z'), 'admin_freeze');
    } else {
      await walletSecurityClient.unfreezeWithdrawals(userId);
    }
    const state = await walletSecurityClient.getState(userId);
    console.info('[admin] withdrawals ' + action, { userId });
    sendJson(res, 200, {
      userId,
      withdrawalsFrozenUntil: state.withdrawalsFrozenUntil?.toISOString() ?? null,
      withdrawalsFrozenReason: state.withdrawalsFrozenReason,
    });
  } catch (error) {
    fail(res, error, 'Could not change the withdrawal freeze');
  }
}

/**
 * GET /admin/usage/services?days=30 — every outside service the gateway
 * calls, counted per day: calls, failures, average latency. The vendors' own
 * consoles hold the bills; this is the one place to see, before the bill,
 * that something started calling Google ten times as often on Tuesday.
 */
export async function handleAdminServiceUsageRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MetricsDeps & { redisClient: RedisClient },
  url: URL,
): Promise<void> {
  if (!(await requireAdmin(req, res, deps))) return;
  try {
    const days = Math.min(90, Math.max(1, intParam(url, 'days', 30)));
    sendJson(res, 200, { days, services: await serviceUsage(deps.redisClient, days) });
  } catch (error) {
    fail(res, error, 'could not load service usage');
  }
}

/* ── the withdrawal queue ───────────────────────────────────────────────── */

const WITHDRAWAL_STATUSES = new Set(['PENDING', 'FUNDS_RESERVED', 'QUEUED', 'PAYOUT_CREATED', 'PROCESSING', 'SETTLED', 'FAILED', 'EXPIRED', 'CANCELLED']);

function withdrawalRow(request: Awaited<ReturnType<typeof withdrawalClient.listQueued>>[number]) {
  return {
    id: request.id,
    status: request.status,
    amountNgn: Number(request.requestedAmountNgn),
    bank: { code: request.bankNetworkId, accountNumber: request.bankAccountNumber, accountName: request.bankAccountName },
    user: { id: request.user.id, name: request.user.name, phone: request.user.phone },
    providerReference: request.providerReference,
    failureReason: request.failureReason,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
    settledAt: request.settledAt?.toISOString() ?? null,
  };
}

/**
 * GET /admin/withdrawals?status=QUEUED — the withdrawals waiting to be paid (the
 * default), or any other status. Oldest first for the queue, newest first otherwise.
 * Carries the payout mode and the live Paystack float, so the admin knows whether
 * the sweep will send these or whether they are theirs to pay.
 */
export async function handleAdminWithdrawalsRoute(req: IncomingMessage, res: ServerResponse, deps: WithdrawalAdminDeps, url: URL): Promise<void> {
  if (!(await requireAdmin(req, res, deps))) return;
  const status = (url.searchParams.get('status') ?? 'QUEUED').toUpperCase();
  if (!WITHDRAWAL_STATUSES.has(status)) {
    sendJson(res, 400, { error: `Unknown status. One of: ${[...WITHDRAWAL_STATUSES].join(', ')}` });
    return;
  }
  try {
    const [rows, floatNgn] = await Promise.all([
      status === 'QUEUED' ? withdrawalClient.listQueued(200) : withdrawalClient.listByStatus(status as never, 200),
      deps.paymentsClient.getBalanceNgn().catch(() => null),
    ]);
    const queuedNgn = rows.filter((r) => r.status === 'QUEUED').reduce((sum, r) => sum + Number(r.requestedAmountNgn), 0);
    sendJson(res, 200, { status, payoutMode: currentPayoutMode(), floatNgn, queuedNgn, count: rows.length, withdrawals: rows.map(withdrawalRow) });
  } catch (error) {
    fail(res, error, 'Could not list withdrawals');
  }
}

/**
 * POST /admin/withdrawals/:id/mark-paid  { reference? } — the admin sent the money by hand
 * POST /admin/withdrawals/:id/send-now                 — create the Paystack transfer now
 * POST /admin/withdrawals/:id/cancel     { reason? }    — give the money back to the wallet
 * Each only applies to a QUEUED withdrawal.
 */
export async function handleAdminWithdrawalActionRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WithdrawalAdminDeps,
  requestId: string,
  action: 'mark-paid' | 'send-now' | 'cancel',
): Promise<void> {
  if (!(await requireAdmin(req, res, deps))) return;
  const body = await readJsonBody(req).catch(() => ({})) as Record<string, unknown>;
  try {
    if (action === 'mark-paid') {
      const settled = await markQueuedPaid(requestId, typeof body.reference === 'string' ? body.reference : undefined);
      logActivity({ userId: settled?.userId ?? 'admin', eventType: 'withdrawal_marked_paid', source: 'admin', metadata: { requestId } });
      sendJson(res, 200, { id: requestId, status: settled?.status ?? 'SETTLED' });
      return;
    }
    if (action === 'send-now') {
      await sendQueuedNow({ paymentsClient: deps.paymentsClient, publisher: deps.publisher }, requestId);
      const after = await withdrawalClient.findById(requestId);
      sendJson(res, 200, { id: requestId, status: after?.status ?? 'PAYOUT_CREATED' });
      return;
    }
    const released = await cancelQueued(requestId, typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : undefined);
    sendJson(res, 200, { id: requestId, status: released ? 'CANCELLED' : 'unknown' });
  } catch (error) {
    if (error instanceof WithdrawalError) {
      sendJson(res, 409, { error: error.message, code: error.code });
      return;
    }
    fail(res, error, `Could not ${action} withdrawal`);
  }
}
