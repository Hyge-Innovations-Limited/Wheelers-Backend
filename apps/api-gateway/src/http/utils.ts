import type { IncomingMessage, ServerResponse } from 'http';
import { noteShownError } from '../analytics/user-outcomes';

const MAX_BODY_SIZE_BYTES = 50_000_000;

export async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;

    if (size > MAX_BODY_SIZE_BYTES) {
      throw new Error('Request body too large');
    }

    chunks.push(buffer);
  }

  return chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks);
}

export function parseJsonBuffer(buffer: Buffer): unknown {
  if (buffer.length === 0) {
    return {};
  }

  const body = buffer.toString('utf8');
  if (!body.trim()) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error('Invalid JSON body');
  }
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return parseJsonBuffer(await readRawBody(req));
}

export function sendJson(res: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  // The sentence a refusal shows the person, kept for the admin Activity page.
  if (statusCode >= 400) noteShownError(res, payload.error ?? payload.message);
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

export function applyCorsHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigins: Set<string>,
): void {
  const requestOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : null;

  if (requestOrigin && allowedOrigins.has(requestOrigin)) {
    res.setHeader('access-control-allow-origin', requestOrigin);
  } else if (allowedOrigins.size > 0) {
    const first = allowedOrigins.values().next().value;
    if (typeof first === 'string') {
      res.setHeader('access-control-allow-origin', first);
    }
  }

  res.setHeader('vary', 'origin');
  res.setHeader('access-control-allow-methods', 'POST,GET,PUT,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,authorization,x-admin-key,ngrok-skip-browser-warning');
}
