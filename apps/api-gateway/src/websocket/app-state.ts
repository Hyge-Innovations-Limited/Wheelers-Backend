import type { GatewayAuthContext } from '../types';
import type { RedisClient } from '../redis/client';
import type { HandlerResponse } from './handlers/types';

/** The app said it is in the background. Gone after this long unless the app says so again. */
export const APP_BACKGROUND_TTL_SECONDS = 2 * 60;

export function appBackgroundKey(userId: string): string {
  return `presence:${userId}:bg`;
}

/**
 * app:state {state:'background'|'active'} (DRIVER_STATUS_PUSHES_ENABLED).
 * A background app has a socket that may still be open, so the gateway cannot
 * tell it is away on its own. The flag expires, so an app killed in the
 * background falls back to plain socket presence. Answers only its own type.
 */
export async function handleAppStateMessage(
  type: string,
  payload: Record<string, unknown>,
  auth: GatewayAuthContext,
  redis: Pick<RedisClient, 'set' | 'del'>,
): Promise<HandlerResponse | null> {
  if (type !== 'app:state') return null;
  const state = payload['state'];
  if (state !== 'background' && state !== 'active') throw new Error("state must be 'background' or 'active'");
  if (state === 'background') await redis.set(appBackgroundKey(auth.userId), '1', APP_BACKGROUND_TTL_SECONDS);
  else await redis.del(appBackgroundKey(auth.userId));
  return { type: 'app:state:ok', payload: { state } };
}
