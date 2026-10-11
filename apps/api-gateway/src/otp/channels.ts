/**
 * Where verification codes actually go.
 *
 * Meta's Cloud API is the cheapest way to reach a rider, but it only delivers
 * free-form messages inside 24 hours of that person last messaging us — and
 * this account is currently blocked from creating the AUTHENTICATION template
 * that would lift the restriction. So a brand-new rider signing up in the app
 * cannot be reached by Meta at all.
 *
 * The fix is a chain rather than a single provider: try the cheap channel
 * first, fall through to one that always works. Twilio SMS has no window and
 * needs no template, so it is the backstop that makes signup reliable.
 *
 * Order is configurable (`OTP_CHANNEL_ORDER`); the default is
 *   meta_whatsapp → twilio_whatsapp → SMS
 * which spends the least money that still reaches the person.
 *
 * SMS has two providers, Termii and Twilio. `SMS_PROVIDER` in .env says
 * which goes first (twilio until told otherwise); the other stays behind it
 * as the fallback, and one that is not configured is skipped. Switching is
 * that one line and a restart:
 *
 *   SMS_PROVIDER=termii        with TERMII_API_KEY and TERMII_SENDER_ID set
 *   SMS_PROVIDER=twilio        with TWILIO_FROM_NUMBER a number the account owns
 */

export type OtpChannel =
  | 'meta_whatsapp'
  | 'twilio_whatsapp'
  | 'twilio_sms'
  | 'termii_sms'
  | 'twilio_verify';

export type SmsProvider = 'twilio' | 'termii';

export interface OtpChannelConfig {
  metaAccessToken?: string;
  metaPhoneNumberId?: string;
  /** Approved Meta AUTHENTICATION template; without it Meta is 24h-window only. */
  metaOtpTemplateName?: string;
  metaOtpTemplateLanguage?: string;

  twilioAccountSid?: string;
  twilioAuthToken?: string;
  /** E.164 number for SMS, e.g. +14155551234 */
  twilioFromNumber?: string;
  /** WhatsApp sender, with or without the whatsapp: prefix. */
  twilioWhatsappNumber?: string;
  /** Twilio Verify service — generates and checks the code for us. */
  twilioVerifyServiceSid?: string;

  /** Termii (SMS built for Nigeria): the key, and the sender name the networks approved. Both are needed. */
  termiiApiKey?: string;
  termiiSenderId?: string;
  /** The address Termii's dashboard gives for the account. */
  termiiBaseUrl?: string;
  /** "dnd" reaches numbers with Do-Not-Disturb on (what a code needs); "generic" does not. */
  termiiChannel?: string;
  /** Which SMS provider goes first. The other is the fallback. */
  smsProvider?: SmsProvider;

  /** Comma-separated channel order. Unknown or unconfigured names are skipped. */
  channelOrder?: string;
}

export interface OtpDeliveryResult {
  channel: OtpChannel;
  /** What the rider will see it arrive as. */
  medium: 'whatsapp' | 'sms';
  /**
   * True when the provider owns the code (Twilio Verify): we never generated
   * it and cannot check it ourselves — verification must go back to Twilio.
   */
  providerManaged: boolean;
}

export class OtpChannelError extends Error {
  constructor(
    message: string,
    readonly channel: OtpChannel,
    /** A closed 24h window is a routing problem, not a broken integration. */
    readonly windowClosed = false,
  ) {
    super(message);
    this.name = 'OtpChannelError';
  }
}

/** Every channel failed. Carries what was tried so the log is useful. */
export class OtpDeliveryFailed extends Error {
  constructor(
    readonly attempts: Array<{ channel: OtpChannel; error: string }>,
    /** True when the only failures were closed 24h windows. */
    readonly allWindowClosed: boolean,
  ) {
    super(
      attempts.length === 0
        ? 'No verification channel is configured. Set META_ACCESS_TOKEN + META_PHONE_NUMBER_ID, TERMII_API_KEY + TERMII_SENDER_ID, or TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM_NUMBER.'
        : `Could not deliver the code. Tried: ${attempts.map((a) => `${a.channel} (${a.error})`).join('; ')}`,
    );
    this.name = 'OtpDeliveryFailed';
  }
}

/** The two SMS channels, the chosen provider first. */
export function smsChannels(config: OtpChannelConfig): OtpChannel[] {
  return config.smsProvider === 'termii' ? ['termii_sms', 'twilio_sms'] : ['twilio_sms', 'termii_sms'];
}

const defaultOrder = (config: OtpChannelConfig): OtpChannel[] => ['meta_whatsapp', 'twilio_whatsapp', ...smsChannels(config)];

function hasMeta(c: OtpChannelConfig): boolean {
  return Boolean(c.metaAccessToken && c.metaPhoneNumberId);
}
function hasTwilio(c: OtpChannelConfig): boolean {
  return Boolean(c.twilioAccountSid && c.twilioAuthToken);
}
function hasTermii(c: OtpChannelConfig): boolean {
  return Boolean(c.termiiApiKey && c.termiiSenderId);
}

/**
 * The channels to try, in order. `order` (from a caller that wants its own,
 * e.g. SMS first for a driver's number) wins over OTP_CHANNEL_ORDER, which
 * wins over the default.
 */
export function availableChannels(config: OtpChannelConfig, wanted?: OtpChannel[]): OtpChannel[] {
  const requested = wanted ?? ((config.channelOrder ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as OtpChannel[]);
  const order = requested.length > 0 ? requested : defaultOrder(config);

  // Verify replaces the plain Twilio channels when it is configured — it does
  // the same job with none of the template problems.
  const withVerify =
    hasTwilio(config) && config.twilioVerifyServiceSid && requested.length === 0
      ? (['meta_whatsapp', 'twilio_verify'] as OtpChannel[])
      : order;

  return withVerify.filter((channel) => {
    switch (channel) {
      case 'meta_whatsapp':
        return hasMeta(config);
      case 'twilio_whatsapp':
        return hasTwilio(config) && Boolean(config.twilioWhatsappNumber);
      case 'twilio_sms':
        return hasTwilio(config) && Boolean(config.twilioFromNumber);
      case 'termii_sms':
        return hasTermii(config);
      case 'twilio_verify':
        return hasTwilio(config) && Boolean(config.twilioVerifyServiceSid);
      default:
        return false;
    }
  });
}

export function isOtpConfigured(config: OtpChannelConfig): boolean {
  return availableChannels(config).length > 0;
}

/* ── Meta ──────────────────────────────────────────────────────────────── */

function describeMetaError(status: number, payload: string): { message: string; windowClosed: boolean } {
  try {
    const parsed = JSON.parse(payload) as {
      error?: { message?: string; code?: number; error_data?: { details?: string } };
    };
    const code = parsed.error?.code;
    const details = parsed.error?.error_data?.details ?? parsed.error?.message ?? payload;
    // 131047 re-engagement, 131026 undeliverable — both mean "outside the window".
    if (code === 131047 || code === 131026) {
      return { message: `outside the 24h window (${code})`, windowClosed: true };
    }
    return { message: `HTTP ${status}${code ? ` code ${code}` : ''}: ${details}`, windowClosed: false };
  } catch {
    return { message: `HTTP ${status}: ${payload.slice(0, 160)}`, windowClosed: false };
  }
}

async function sendViaMeta(
  config: OtpChannelConfig,
  phone: string,
  code: string,
  body: string,
): Promise<OtpDeliveryResult> {
  const recipient = phone.replace(/^\+/, '');
  const message = config.metaOtpTemplateName
    ? {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipient,
        type: 'template',
        template: {
          name: config.metaOtpTemplateName,
          language: { code: config.metaOtpTemplateLanguage ?? 'en_US' },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: code }] },
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
          ],
        },
      }
    : {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipient,
        type: 'text',
        text: { body },
      };

  const response = await fetch(
    `https://graph.facebook.com/v21.0/${config.metaPhoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.metaAccessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(message),
    },
  );

  if (!response.ok) {
    const described = describeMetaError(response.status, await response.text());
    throw new OtpChannelError(described.message, 'meta_whatsapp', described.windowClosed);
  }

  return { channel: 'meta_whatsapp', medium: 'whatsapp', providerManaged: false };
}

/* ── Twilio ────────────────────────────────────────────────────────────── */

function twilioAuthHeader(config: OtpChannelConfig): string {
  return `Basic ${Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`, 'utf8').toString('base64')}`;
}

function describeTwilioError(status: number, payload: string): string {
  try {
    const parsed = JSON.parse(payload) as { message?: string; code?: number; more_info?: string };
    return `HTTP ${status}${parsed.code ? ` code ${parsed.code}` : ''}: ${parsed.message ?? payload.slice(0, 160)}`;
  } catch {
    return `HTTP ${status}: ${payload.slice(0, 160)}`;
  }
}

/** WhatsApp senders must carry the `whatsapp:` prefix Twilio expects. */
function whatsappAddress(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('whatsapp:') ? trimmed : `whatsapp:${trimmed}`;
}

async function sendViaTwilioMessage(
  config: OtpChannelConfig,
  channel: 'twilio_whatsapp' | 'twilio_sms',
  phone: string,
  body: string,
): Promise<OtpDeliveryResult> {
  const isWhatsapp = channel === 'twilio_whatsapp';
  const from = isWhatsapp
    ? whatsappAddress(config.twilioWhatsappNumber ?? '')
    : (config.twilioFromNumber ?? '');
  const to = isWhatsapp ? whatsappAddress(phone) : phone;

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.twilioAccountSid ?? '')}/Messages.json`,
    {
      method: 'POST',
      headers: {
        authorization: twilioAuthHeader(config),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
    },
  );

  if (!response.ok) {
    const payload = await response.text();
    // 63016 is Twilio's own "outside the 24h session" for WhatsApp.
    const windowClosed = payload.includes('63016');
    throw new OtpChannelError(describeTwilioError(response.status, payload), channel, windowClosed);
  }

  return {
    channel,
    medium: isWhatsapp ? 'whatsapp' : 'sms',
    providerManaged: false,
  };
}

/* ── Termii ────────────────────────────────────────────────────────────── */

const TERMII_DEFAULT_BASE_URL = 'https://v3.api.termii.com';

function describeTermiiError(status: number, payload: string): string {
  try {
    const parsed = JSON.parse(payload) as { message?: string; code?: string | number };
    return `HTTP ${status}${parsed.code ? ` code ${parsed.code}` : ''}: ${parsed.message ?? payload.slice(0, 160)}`;
  } catch {
    return `HTTP ${status}: ${payload.slice(0, 160)}`;
  }
}

/**
 * One SMS through Termii, on the route that reaches Do-Not-Disturb numbers.
 * Termii wants the number without its plus, and the sender name exactly as
 * the networks approved it.
 */
async function sendViaTermii(config: OtpChannelConfig, phone: string, body: string): Promise<OtpDeliveryResult> {
  const base = (config.termiiBaseUrl ?? TERMII_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const response = await fetch(`${base}/api/sms/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: config.termiiApiKey,
      to: phone.replace(/^\+/, ''),
      from: config.termiiSenderId,
      sms: body,
      type: 'plain',
      channel: config.termiiChannel ?? 'dnd',
    }),
  });
  const payload = await response.text();
  if (!response.ok) throw new OtpChannelError(describeTermiiError(response.status, payload), 'termii_sms');
  // Termii can answer 200 with a refusal in the body (an unapproved sender, an empty wallet).
  let accepted = true;
  try {
    const parsed = JSON.parse(payload) as { message_id?: string; code?: string; message?: string };
    accepted = Boolean(parsed.message_id) || parsed.code === 'ok' || /success/i.test(parsed.message ?? '');
  } catch {
    accepted = false;
  }
  if (!accepted) throw new OtpChannelError(describeTermiiError(response.status, payload), 'termii_sms');
  return { channel: 'termii_sms', medium: 'sms', providerManaged: false };
}

/**
 * Twilio Verify: Twilio generates, sends and later checks the code. Needs no
 * template approval on either side, which is exactly the wall Meta put up.
 */
async function startTwilioVerify(
  config: OtpChannelConfig,
  phone: string,
  medium: 'whatsapp' | 'sms',
): Promise<OtpDeliveryResult> {
  const response = await fetch(
    `https://verify.twilio.com/v2/Services/${encodeURIComponent(config.twilioVerifyServiceSid ?? '')}/Verifications`,
    {
      method: 'POST',
      headers: {
        authorization: twilioAuthHeader(config),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: phone, Channel: medium }).toString(),
    },
  );

  if (!response.ok) {
    throw new OtpChannelError(
      describeTwilioError(response.status, await response.text()),
      'twilio_verify',
    );
  }

  return { channel: 'twilio_verify', medium, providerManaged: true };
}

/** Ask Twilio whether a code it issued is correct. */
export async function checkTwilioVerify(
  config: OtpChannelConfig,
  phone: string,
  code: string,
): Promise<boolean> {
  const response = await fetch(
    `https://verify.twilio.com/v2/Services/${encodeURIComponent(config.twilioVerifyServiceSid ?? '')}/VerificationCheck`,
    {
      method: 'POST',
      headers: {
        authorization: twilioAuthHeader(config),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: phone, Code: code }).toString(),
    },
  );

  if (!response.ok) {
    // A wrong or expired code comes back 404 — that is a failed check, not an outage.
    if (response.status === 404) return false;
    throw new OtpChannelError(
      describeTwilioError(response.status, await response.text()),
      'twilio_verify',
    );
  }

  const result = (await response.json()) as { status?: string; valid?: boolean };
  return result.valid === true || result.status === 'approved';
}

/* ── the chain ─────────────────────────────────────────────────────────── */

export interface DeliverOptions {
  phone: string;
  code: string;
  body: string;
  /** Preferred medium for Verify, which can do either. */
  prefer?: 'whatsapp' | 'sms';
  /** This caller's own order of channels, in place of the configured one (e.g. SMS first for a driver's number). */
  order?: OtpChannel[];
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * Walk the configured channels until one delivers. Every failure is recorded
 * so a total failure explains itself instead of saying "could not send".
 */
export async function deliverOtp(
  config: OtpChannelConfig,
  options: DeliverOptions,
): Promise<OtpDeliveryResult> {
  const channels = availableChannels(config, options.order);
  const attempts: Array<{ channel: OtpChannel; error: string; windowClosed: boolean }> = [];
  const log = options.log ?? (() => {});

  for (const channel of channels) {
    try {
      switch (channel) {
        case 'meta_whatsapp':
          return await sendViaMeta(config, options.phone, options.code, options.body);
        case 'twilio_whatsapp':
        case 'twilio_sms':
          return await sendViaTwilioMessage(config, channel, options.phone, options.body);
        case 'termii_sms':
          return await sendViaTermii(config, options.phone, options.body);
        case 'twilio_verify':
          return await startTwilioVerify(config, options.phone, options.prefer ?? 'whatsapp');
      }
    } catch (error) {
      const channelError =
        error instanceof OtpChannelError
          ? error
          : new OtpChannelError(error instanceof Error ? error.message : String(error), channel);
      attempts.push({
        channel,
        error: channelError.message,
        windowClosed: channelError.windowClosed,
      });
      log(`[otp] ${channel} failed, trying the next channel`, {
        phone: options.phone,
        error: channelError.message,
      });
    }
  }

  throw new OtpDeliveryFailed(
    attempts.map(({ channel, error }) => ({ channel, error })),
    attempts.length > 0 && attempts.every((a) => a.windowClosed),
  );
}
