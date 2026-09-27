import type { IncomingMessage } from 'http';
import { userClient } from '@wheleers/db';
import { verifyLocalAccessToken } from '../auth/local';

/**
 * Thrown only when the caller is genuinely not authenticated. Routes use this
 * to tell "your token is bad" (401 — the client should re-auth) apart from
 * "the database blew up" (500), which used to be reported as 401 and would log
 * a driver out mid-shift on any transient error.
 */
export class HttpAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HttpAuthError';
  }
}

export function extractBearerToken(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const [scheme, token] = value.split(' ');
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') {
    return undefined;
  }

  return token;
}

export async function authenticateHttpUser(
  req: IncomingMessage,
  jwtSecret: string,
): Promise<NonNullable<Awaited<ReturnType<typeof userClient.findByPrivyDid>>>> {
  const authorization =
    typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
  const token = extractBearerToken(authorization);

  if (!token) {
    throw new HttpAuthError('Authorization bearer token is required');
  }

  let localToken: ReturnType<typeof verifyLocalAccessToken>;
  try {
    localToken = verifyLocalAccessToken(token, jwtSecret);
  } catch (error) {
    throw new HttpAuthError(
      error instanceof Error ? error.message : 'Invalid access token.',
    );
  }

  return await userClient.findById(localToken.sub);
}

/**
 * Who is asking, from the token alone: no database read. For endpoints called
 * constantly by the same signed-in phone (the driver heartbeat), where looking
 * the user up on every call was most of the cost of the call. The token is
 * still verified in full; what is skipped is re-reading a user row that the
 * endpoint does not need.
 */
export function authenticateHttpToken(req: IncomingMessage, jwtSecret: string): { userId: string } {
  const authorization =
    typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
  const token = extractBearerToken(authorization);
  if (!token) {
    throw new HttpAuthError('Authorization bearer token is required');
  }
  try {
    return { userId: verifyLocalAccessToken(token, jwtSecret).sub };
  } catch (error) {
    throw new HttpAuthError(error instanceof Error ? error.message : 'Invalid access token.');
  }
}
