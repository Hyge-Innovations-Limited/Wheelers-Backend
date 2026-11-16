import type { IncomingMessage, ServerResponse } from 'http';
import { prisma } from '@wheleers/db';
import { authenticateHttpUser, HttpAuthError } from './authenticate';
import { readJsonBody, sendJson } from './utils';
import type { RedisClient } from '../redis/client';
import { checkRiderNin, cleanNin, type RiderNinDeps } from '../verification/rider-nin';

/**
 * POST /auth/nin { nin } — the NIN typed at the app's Create account (Timi, 16 Nov 2026). Never required:
 * the app only sends it when one was typed. Answers 202 at once; Prembly is asked in the background (it can
 * take a minute) and the outcome is written on the rider (verification/rider-nin.ts).
 */
export async function handleRiderNinRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { jwtSecret: string; redisClient: RedisClient; check?: typeof checkRiderNin; nin?: Partial<RiderNinDeps> },
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const body = await readJsonBody(req).catch(() => null);
    const nin = cleanNin(body && typeof body === 'object' ? (body as Record<string, unknown>).nin : null);
    if (!nin) {
      sendJson(res, 400, { error: 'NIN is 11 digits.', code: 'NIN_INVALID' });
      return;
    }
    const row = await prisma.user.findUnique({ where: { id: user.id }, select: { name: true } });
    const check = deps.check ?? checkRiderNin;
    void check(user.id, nin, row?.name ?? '', { redis: deps.redisClient, ...deps.nin });
    sendJson(res, 202, { ok: true });
  } catch (error) {
    if (error instanceof HttpAuthError) {
      sendJson(res, 401, { error: error.message });
      return;
    }
    sendJson(res, 500, { error: 'Could not save your NIN.' });
  }
}
