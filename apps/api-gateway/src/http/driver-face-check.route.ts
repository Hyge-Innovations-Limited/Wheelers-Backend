import type { IncomingMessage, ServerResponse } from 'http';
import { verifyLocalAccessToken } from '../auth/local';
import { getString, isRecord } from '../utils/object';
import { readJsonBody, sendJson } from './utils';
import { submitFaceCheck, type FaceCheckDeps } from '../face/face-check';

/**
 * POST /drivers/face-check { rideId, frames: [straight, turned, straight] } (JPEG, base64): the driver's face scan
 * before a ride (face/face-check.ts). Answers { status: passed | retry | failed | expired | error | none }.
 */
export async function handleDriverFaceCheckRoute(req: IncomingMessage, res: ServerResponse, deps: FaceCheckDeps & { jwtSecret: string }): Promise<void> {
  const header = req.headers.authorization;
  let userId: string | null = null;
  if (header?.startsWith('Bearer ')) {
    try { userId = verifyLocalAccessToken(header.slice(7), deps.jwtSecret).sub; } catch { userId = null; }
  }
  if (!userId) {
    sendJson(res, 401, { error: 'Sign in again.' });
    return;
  }
  const body = await readJsonBody(req).catch(() => null);
  const rideId = isRecord(body) ? getString(body, 'rideId') : undefined;
  if (!isRecord(body) || !rideId || !Array.isArray(body.frames)) {
    sendJson(res, 400, { error: 'Scan again.' });
    return;
  }
  const answer = await submitFaceCheck(deps, { driverUserId: userId, rideId, frames: body.frames });
  sendJson(res, 200, answer as Record<string, unknown>);
}
