import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { faceCheckMode, loadWorkspaceEnv } from '@wheleers/config';
import { localFaceEngine, NotAPhoto } from './engine';

/**
 * face-service (pm2): the face library in a process of its own, so its ~450 MB never counts against the gateway
 * (face/engine.ts says why). Listens on 127.0.0.1 only; the gateway is its one caller.
 *
 *   POST /faces  a photo's bytes  → { faces }          (the KYC selfie)
 *   POST /scan   a photo's bytes  → { faces, jpeg }    (a scan frame, and its 720-pixel copy in base64)
 *   GET  /health                  → { ok, loaded }
 * A body that is not a photo: 422. Models load at start when FACE_CHECK is shadow or on, so the first scan is quick.
 */
loadWorkspaceEnv();
const port = Number(process.env.FACE_PORT || 3040);
const MAX_BODY = 12_000_000;
let loaded = false;

function send(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) { resolve(null); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = createServer((req, res) => {
  void (async () => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true, loaded });
    if (req.method !== 'POST' || (path !== '/faces' && path !== '/scan')) return send(res, 404, { error: 'not found' });
    const body = await readBody(req).catch(() => null);
    if (!body || body.length === 0) return send(res, 422, { error: 'not a photo' });
    try {
      if (path === '/faces') {
        const faces = await localFaceEngine.faces(body);
        loaded = true;
        return send(res, 200, { faces });
      }
      const scanned = await localFaceEngine.scan(body);
      loaded = true;
      return send(res, 200, { faces: scanned.faces, jpeg: scanned.jpeg.toString('base64') });
    } catch (error) {
      if (error instanceof NotAPhoto) return send(res, 422, { error: 'not a photo' });
      console.error('[face-service] could not read the photo', { error: error instanceof Error ? error.message : String(error) });
      return send(res, 500, { error: 'face library failed' });
    }
  })();
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[face-service] listening on 127.0.0.1:${port}`);
  if (faceCheckMode() !== 'off') {
    const started = Date.now();
    void localFaceEngine.warm().then(
      () => { loaded = true; console.log(`[face-service] models ready in ${Date.now() - started} ms`); },
      (error) => console.error('[face-service] CRITICAL: models did not load', { error: error instanceof Error ? error.message : String(error) }),
    );
  }
});

const stop = () => server.close(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
