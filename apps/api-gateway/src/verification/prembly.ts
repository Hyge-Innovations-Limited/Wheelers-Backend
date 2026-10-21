/**
 * Prembly (IdentityPass): the paid checks of a driver's licence and car,
 * run from the admin by an owner. Every call costs money on our Prembly
 * balance, so nothing here runs on its own.
 *
 *   licence      POST /verification/drivers_license/advance   number, dob, first_name, last_name
 *   licenceFace  POST /verification/drivers_license/face      number, dob, image (the driver's selfie)
 *   plate        POST /verification/vehicle                   vehicle_number
 *   insurance    POST /verification/insurance_policy          channel, number
 *
 * The key is PREMBLY_API_KEY in the server's .env (and PREMBLY_APP_ID where
 * the account still has one). Unset, the checks say they are off.
 */
export type PremblyConfig = { apiKey: string; appId: string | null; baseUrl: string; timeoutMs: number };

export function premblyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PremblyConfig | null {
  const apiKey = env.PREMBLY_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    appId: env.PREMBLY_APP_ID?.trim() || null,
    baseUrl: (env.PREMBLY_BASE_URL?.trim() || 'https://api.prembly.com').replace(/\/+$/, ''),
    timeoutMs: 30_000,
  };
}

export type PremblyAnswer =
  /** Found: the record, Prembly's reference, and for a face check whether the faces match. */
  | { kind: 'found'; data: Record<string, unknown>; reference: string | null; detail: string; face: { match: boolean; confidence: number | null; message: string } | null }
  /** Prembly answered: there is no such record. */
  | { kind: 'not_found'; detail: string; reference: string | null }
  /** Prembly could not be reached or refused us (key, balance): nothing was learned about the driver. */
  | { kind: 'error'; detail: string };

type Raw = {
  status?: unknown;
  detail?: unknown;
  message?: unknown;
  response_code?: unknown;
  data?: unknown;
  frsc_data?: unknown;
  verification?: { status?: unknown; reference?: unknown } | null;
  face_data?: { status?: unknown; message?: unknown; confidence?: unknown } | null;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A refusal about our account, not about the driver: never "not found". */
const ACCOUNT_TROUBLE = /balance|wallet|fund|unauthori[sz]|forbidden|permission|api.?key|app.?id|inactive|not enabled|not activated|subscription|limit/i;

/** One POST to Prembly, read into found / not found / error. Never throws. */
export async function premblyPost(config: PremblyConfig, path: string, body: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<PremblyAnswer> {
  let res: Response;
  try {
    res = await fetchImpl(`${config.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-api-key': config.apiKey,
        ...(config.appId ? { 'app-id': config.appId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return { kind: 'error', detail: timedOut ? 'Prembly took too long to answer.' : 'Could not reach Prembly.' };
  }

  let raw: Raw | null = null;
  try { raw = (await res.json()) as Raw; } catch { raw = null; }
  const detail = String((raw && (raw.detail ?? raw.message)) ?? '').trim() || `Prembly answered ${res.status}.`;

  if (res.status === 401 || res.status === 403) return { kind: 'error', detail: `Prembly refused our key: ${detail}` };
  if (res.status === 402) return { kind: 'error', detail: `Prembly balance: ${detail}` };
  if (res.status >= 500 || !raw) return { kind: 'error', detail };

  const reference = raw.verification && raw.verification.reference != null ? String(raw.verification.reference) : null;
  const verified = String(raw.verification?.status ?? '').toUpperCase() === 'VERIFIED';
  const data = isObject(raw.data) ? raw.data : isObject(raw.frsc_data) ? raw.frsc_data : null;

  if (raw.status === true && data && (verified || !raw.verification)) {
    const f = raw.face_data;
    const face = isObject(f)
      ? { match: f.status === true, confidence: typeof f.confidence === 'number' ? f.confidence : f.confidence != null && Number.isFinite(Number(f.confidence)) ? Number(f.confidence) : null, message: String(f.message ?? '') }
      : null;
    return { kind: 'found', data, reference, detail, face };
  }
  if (ACCOUNT_TROUBLE.test(detail) || (res.status >= 400 && ![400, 404, 422].includes(res.status))) return { kind: 'error', detail };
  return { kind: 'not_found', detail, reference };
}

export const prembly = {
  licence: (config: PremblyConfig, input: { number: string; dob: string; firstName: string; lastName: string }, fetchImpl?: typeof fetch) =>
    premblyPost(config, '/verification/drivers_license/advance', { number: input.number, dob: input.dob, first_name: input.firstName, last_name: input.lastName }, fetchImpl),

  licenceFace: (config: PremblyConfig, input: { number: string; dob: string; imageBase64: string }, fetchImpl?: typeof fetch) =>
    premblyPost(config, '/verification/drivers_license/face', { number: input.number, dob: input.dob, image: input.imageBase64 }, fetchImpl),

  plate: (config: PremblyConfig, plate: string, fetchImpl?: typeof fetch) =>
    premblyPost(config, '/verification/vehicle', { vehicle_number: plate }, fetchImpl),

  insurance: (config: PremblyConfig, input: { number: string; channel: string }, fetchImpl?: typeof fetch) =>
    premblyPost(config, '/verification/insurance_policy', { channel: input.channel, number: input.number }, fetchImpl),
};
