import type { IncomingMessage, ServerResponse } from 'http';
import { prisma } from '@wheleers/db';
import { authenticateHttpUser, HttpAuthError } from './authenticate';
import { readJsonBody, sendJson } from './utils';
import type { RedisClient } from '../redis/client';
import { checkRiderNin, checkRiderNinLive, type RiderNinDeps } from '../verification/rider-nin';

/**
 * POST /auth/nin { nin, fullName? } — the NIN typed at the app's Create account (Timi, 16 Nov 2026), checked
 * while the rider waits (up to about 7 seconds). 200 { ok, status }: go on (right, or Prembly slow or down: it
 * finishes behind). 422 { error, code }: wrong (not 11 digits, no such NIN, another person's name, too many
 * tries today), the words to show under the box. `fullName` is the name typed on the same screen (the account's
 * own name when absent). Never required: the app only sends it when one was typed.
 */
export async function handleRiderNinRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { jwtSecret: string; redisClient: RedisClient; check?: typeof checkRiderNin; waitMs?: number; nin?: Partial<RiderNinDeps> },
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const body = await readJsonBody(req).catch(() => null);
    const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const typedName = typeof b.fullName === 'string' ? b.fullName.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    const fullName = typedName || (await prisma.user.findUnique({ where: { id: user.id }, select: { name: true } }))?.name || '';
    const answer = await checkRiderNinLive(user.id, b.nin, fullName, { redis: deps.redisClient, check: deps.check, waitMs: deps.waitMs, ...deps.nin });
    if (!answer.ok) {
      sendJson(res, 422, { error: answer.error, code: answer.code });
      return;
    }
    sendJson(res, 200, { ok: true, status: answer.status });
  } catch (error) {
    if (error instanceof HttpAuthError) {
      sendJson(res, 401, { error: error.message });
      return;
    }
    sendJson(res, 500, { error: 'Could not check your NIN. Try again.' });
  }
}
