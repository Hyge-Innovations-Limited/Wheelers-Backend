/**
 * Sending a push through Expo, and finding out whether it arrived.
 *
 * Expo answers in two steps. The send returns a TICKET per phone: "ok" there
 * only means Expo took the message. Whether Google (FCM) or Apple (APNs)
 * delivered it is in the RECEIPT, fetched a little later. The usual reason a
 * push never shows up — the app's Android push credentials missing in Expo —
 * only appears in the receipt, so a worker that read tickets alone logged
 * success for pushes that went nowhere.
 */

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPTS_ENDPOINT = 'https://exp.host/--/api/v2/push/getReceipts';
/** Expo has receipts ready within seconds; a quarter of a minute is plenty. */
export const RECEIPT_DELAY_MS = 15_000;

const TAG = '[notification-worker]';

/** What a receipt error means, for the person reading the logs. */
const RECEIPT_HINTS: Record<string, string> = {
  InvalidCredentials: "the app's push credentials are missing or wrong in Expo (Android: upload the FCM V1 service account key with `eas credentials`; iOS: the APNs key)",
  MismatchSenderId: "the FCM credentials in Expo belong to a different Firebase project than the app's google-services.json",
  DeviceNotRegistered: 'the app was uninstalled or its push token changed; the token is switched off',
  MessageTooBig: 'the notification is over 4096 bytes',
  MessageRateExceeded: 'too many pushes to this phone too fast',
};

export interface PushDevice { expoPushToken: string }
export interface PushMessage { title: string; body: string; data?: Record<string, unknown>; priority?: string }
export interface PushDeps {
  fetch: typeof fetch;
  accessToken?: string;
  markDelivered: (token: string) => Promise<unknown>;
  disable: (token: string) => Promise<unknown>;
  log: (message: string) => void;
  warn: (message: string) => void;
  /** When receipts are fetched. Tests pass a direct call. */
  later: (fn: () => Promise<void>, ms: number) => void;
}

type Ticket = { status?: string; id?: string; message?: string; details?: { error?: string } };
type Receipt = { status?: string; message?: string; details?: { error?: string } };

function headers(accessToken?: string): Record<string, string> {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    // Only a REAL token: with Expo's enhanced security off, no header is accepted, and a fake one is refused.
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
  };
}

/**
 * Send to every phone the user has, and arrange for the receipts to be read.
 * Returns how many phones it went to (0: none registered — said in the log).
 */
export async function sendPush(deps: PushDeps, userId: string, devices: PushDevice[], message: PushMessage): Promise<number> {
  if (devices.length === 0) {
    deps.log(`${TAG} push skipped -> user=${userId}: no phone registered for notifications (permission off, or the app never saved a token)`);
    return 0;
  }

  const response = await deps.fetch(EXPO_PUSH_ENDPOINT, {
    method: 'POST',
    headers: headers(deps.accessToken),
    body: JSON.stringify(devices.map((device) => ({
      to: device.expoPushToken,
      title: message.title,
      body: message.body,
      data: message.data,
      priority: message.priority === 'high' ? 'high' : 'default',
      sound: 'default',
    }))),
  });
  const payload = (await response.json().catch(() => null)) as { data?: Ticket[]; errors?: Array<{ message?: string }> } | null;
  if (!response.ok) {
    throw new Error(payload?.errors?.map((error) => error.message).filter(Boolean).join('; ') || `Expo push send failed with status ${response.status}`);
  }

  const tickets = Array.isArray(payload?.data) ? payload.data : [];
  const waiting = new Map<string, string>(); // receipt id -> token
  await Promise.all(devices.map(async (device, index) => {
    const ticket = tickets[index];
    if (!ticket) return;
    if (ticket.status === 'ok') {
      if (ticket.id) waiting.set(ticket.id, device.expoPushToken);
      return;
    }
    await handleError(deps, userId, device.expoPushToken, ticket.details?.error, ticket.message, 'ticket');
  }));
  deps.log(`${TAG} push sent -> user=${userId} phones=${devices.length} accepted=${waiting.size}`);

  if (waiting.size > 0) {
    deps.later(() => checkReceipts(deps, userId, waiting).catch((error) => {
      deps.warn(`${TAG} push receipts unreadable -> user=${userId}: ${error instanceof Error ? error.message : String(error)}`);
    }), RECEIPT_DELAY_MS);
  }
  return devices.length;
}

/** Did Google / Apple deliver it? Delivered: noted on the device. Not: said, with what to do about it. */
export async function checkReceipts(deps: PushDeps, userId: string, waiting: Map<string, string>): Promise<void> {
  const response = await deps.fetch(EXPO_RECEIPTS_ENDPOINT, {
    method: 'POST',
    headers: headers(deps.accessToken),
    body: JSON.stringify({ ids: [...waiting.keys()] }),
  });
  const payload = (await response.json().catch(() => null)) as { data?: Record<string, Receipt> } | null;
  const receipts = payload?.data ?? {};
  await Promise.all([...waiting].map(async ([id, token]) => {
    const receipt = receipts[id];
    if (!receipt) return; // not ready: Expo keeps it a day, nothing to act on
    if (receipt.status === 'ok') {
      await deps.markDelivered(token).catch(() => undefined);
      return;
    }
    await handleError(deps, userId, token, receipt.details?.error, receipt.message, 'receipt');
  }));
}

async function handleError(deps: PushDeps, userId: string, token: string, error: string | undefined, message: string | undefined, step: 'ticket' | 'receipt'): Promise<void> {
  if (error === 'DeviceNotRegistered') await deps.disable(token).catch(() => undefined);
  const hint = (error && RECEIPT_HINTS[error]) || message || 'unknown';
  deps.warn(`${TAG} push NOT delivered (${step}) -> user=${userId} token=${token.slice(0, 22)}… error=${error ?? 'unknown'}: ${hint}`);
}
