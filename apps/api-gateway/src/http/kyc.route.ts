import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { riderKycClient } from '@wheleers/db';
import { RiderKycVerifiedEvent } from '@wheleers/kafka-schemas';
import { authenticateHttpUser } from './authenticate';
import { readJsonBody, sendJson } from './utils';
import { isRecord, getString, getNumber, getRecord } from '../utils/object';
import type { RiderKycFaceStorage } from '../storage/rider-kyc-face-storage';
import type { GatewayPublisher } from '../websocket/publisher';

interface KycRouteDeps {
  jwtSecret: string;
  publisher: GatewayPublisher;
  faceStorage: RiderKycFaceStorage | null;
}

export async function handleGetKycStatusRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: KycRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const kycData = await riderKycClient.getStatus(user.id);

    sendJson(res, 200, {
      status: kycData.riderKycStatus,
      verifiedAt: kycData.kycVerifiedAt?.toISOString() ?? null,
    });
  } catch (error) {
    sendJson(res, 401, {
      error: error instanceof Error ? error.message : 'Could not get KYC status',
    });
  }
}

export async function handleVerifyKycRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: KycRouteDeps,
): Promise<void> {
  let user: Awaited<ReturnType<typeof authenticateHttpUser>>;
  try {
    user = await authenticateHttpUser(req, deps.jwtSecret);
  } catch (error) {
    sendJson(res, 401, {
      error: error instanceof Error ? error.message : 'Authentication failed',
    });
    return;
  }

  try {

    // Already verified — idempotent
    if (user.riderKycStatus === 'VERIFIED') {
      sendJson(res, 200, {
        status: 'VERIFIED',
        alreadyVerified: true,
        verifiedAt: user.kycVerifiedAt?.toISOString() ?? null,
      });
      return;
    }

    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const selfieData = getString(rawBody, 'selfieData');
    if (!selfieData) {
      sendJson(res, 400, { error: 'selfieData is required' });
      return;
    }

    // Validate and extract base64 image
    const imageResult = parseBase64Image(selfieData);
    if (!imageResult.ok) {
      sendJson(res, 400, { error: imageResult.error });
      return;
    }

    // Validate liveness challenge results
    const challengeResults = getRecord(rawBody, 'challengeResults');
    if (!challengeResults) {
      sendJson(res, 400, { error: 'challengeResults is required' });
      return;
    }

    const blinksDetected = getNumber(challengeResults, 'blinksDetected') ?? 0;
    const headTurnLeft = challengeResults['headTurnLeft'] === true;
    const headTurnRight = challengeResults['headTurnRight'] === true;
    const durationMs = getNumber(challengeResults, 'durationMs') ?? 0;

    // Verify liveness challenges were plausibly completed
    if (blinksDetected < 2 || !headTurnLeft || !headTurnRight) {
      await riderKycClient.logAttempt({
        userId: user.id,
        status: 'NONE',
        failureReason: 'Liveness challenges incomplete',
        ipAddress: extractIp(req),
        userAgent: req.headers['user-agent'] ?? undefined,
      });
      sendJson(res, 400, { error: 'Liveness challenges were not completed' });
      return;
    }

    // Timing check: challenges should take at least 3 seconds
    if (durationMs < 3000) {
      await riderKycClient.logAttempt({
        userId: user.id,
        status: 'NONE',
        failureReason: 'Liveness duration too short',
        ipAddress: extractIp(req),
        userAgent: req.headers['user-agent'] ?? undefined,
      });
      sendJson(res, 400, { error: 'Verification completed too quickly' });
      return;
    }

    // Upload selfie to S3 (or skip if no storage configured)
    let selfieCid = `local:${user.id}:${Date.now()}`;
    if (deps.faceStorage) {
      selfieCid = await deps.faceStorage.uploadSelfie({
        userId: user.id,
        imageBuffer: imageResult.buffer,
        mimeType: imageResult.mimeType,
      });
    }

    // Mark user verified
    await riderKycClient.markVerified(user.id, selfieCid);

    // Log successful attempt
    const livenessScore = Math.min(1.0, (blinksDetected / 2) * 0.33 + (headTurnLeft ? 0.33 : 0) + (headTurnRight ? 0.34 : 0));
    await riderKycClient.logAttempt({
      userId: user.id,
      status: 'VERIFIED',
      selfieKey: selfieCid,
      livenessScore,
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'] ?? undefined,
    });

    // Publish Kafka event
    const verifiedAt = new Date().toISOString();
    const kycEvent = RiderKycVerifiedEvent.parse({
      eventType: 'RIDER_KYC_VERIFIED',
      userId: user.id,
      verifiedAt,
      timestamp: verifiedAt,
    });
    await deps.publisher.publishUserEvent(kycEvent).catch((err) =>
      console.warn('[api-gateway] KYC verified event publish failed:', err),
    );

    // Send push notification
    await deps.publisher.publishNotificationEvent({
      eventType: 'PUSH_SEND',
      notificationId: randomUUID(),
      userId: user.id,
      title: 'Identity Verified',
      body: 'Your identity has been verified. You can now request rides!',
      priority: 'normal',
      timestamp: verifiedAt,
    }).catch((err) =>
      console.warn('[api-gateway] KYC push notification failed:', err),
    );

    sendJson(res, 200, {
      status: 'VERIFIED',
      verifiedAt,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Verification failed';
    // Concurrent call already verified — treat as idempotent success
    if (msg === 'User is already verified') {
      sendJson(res, 200, { status: 'VERIFIED', alreadyVerified: true });
      return;
    }
    sendJson(res, 400, { error: msg });
  }
}

type ImageParseResult =
  | { ok: true; buffer: Buffer; mimeType: string }
  | { ok: false; error: string };

function parseBase64Image(dataUrl: string): ImageParseResult {
  // Accept data:image/jpeg;base64,... or data:image/png;base64,...
  const match = dataUrl.match(/^data:(image\/(?:jpeg|png|jpg));base64,(.+)$/);
  if (!match || !match[1] || !match[2]) {
    return { ok: false, error: 'Invalid selfie format. Must be a JPEG or PNG data URL.' };
  }

  const mimeType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
  let buffer: Buffer;
  try {
    buffer = Buffer.from(match[2], 'base64');
  } catch {
    return { ok: false, error: 'Invalid base64 encoding' };
  }

  // Size check: at least 5KB (not an empty image), at most 500KB
  if (buffer.byteLength < 5_000) {
    return { ok: false, error: 'Image is too small' };
  }
  if (buffer.byteLength > 500_000) {
    return { ok: false, error: 'Image is too large' };
  }

  return { ok: true, buffer, mimeType };
}

function extractIp(req: IncomingMessage): string | undefined {
  const cloudflare = req.headers['cf-connecting-ip'];
  if (typeof cloudflare === 'string' && cloudflare) return cloudflare.trim();
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0]?.trim();
  }
  return req.socket.remoteAddress ?? undefined;
}
