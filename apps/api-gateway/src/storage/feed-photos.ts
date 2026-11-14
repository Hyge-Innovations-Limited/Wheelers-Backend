import path from 'node:path';
import { Worker } from 'node:worker_threads';

/** The most a Feed photo may be as sent (a phone photo is 2 to 6 MB). */
export const FEED_PHOTO_MAX_BYTES = 12 * 1024 * 1024;
/** Bigger than this many pixels is refused before decoding (it would take hundreds of MB). */
const MAX_PIXELS = 40_000_000;
const WORKER_TIMEOUT_MS = 20_000;

/**
 * A photo's width and height from its header, without decoding it: JPEG (the
 * frame marker) or PNG (IHDR). Null when it is neither.
 */
export function imageSize(bytes: Buffer): { type: 'jpeg' | 'png'; width: number; height: number } | null {
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes.subarray(1, 4).toString('latin1') === 'PNG') {
    return { type: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) { at += 1; continue; }
    const marker = bytes[at + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { at += marker === 0xff ? 1 : 2; continue; }
    const length = bytes.readUInt16BE(at + 2);
    // Start of frame: every SOFn but DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { type: 'jpeg', height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    }
    at += 2 + length;
  }
  return null;
}

export type ShrunkPhoto = { bytes: Buffer; width: number; height: number };

/**
 * A Feed photo as stored: checked (JPEG or PNG, not too big), then made
 * smaller and cleaned in a worker thread. The reason is in the driver's words.
 */
export async function shrinkFeedPhoto(bytes: Buffer, workerFile = path.join(__dirname, 'feed-photo.worker.js')): Promise<{ ok: true; photo: ShrunkPhoto } | { ok: false; error: string }> {
  if (bytes.length === 0) return { ok: false, error: 'A photo did not come through. Try again.' };
  if (bytes.length > FEED_PHOTO_MAX_BYTES) return { ok: false, error: 'A photo is too big. Pick a smaller one.' };
  const size = imageSize(bytes);
  if (!size || size.width < 1 || size.height < 1) return { ok: false, error: 'Send photos only (JPEG or PNG).' };
  if (size.width * size.height > MAX_PIXELS) return { ok: false, error: 'A photo is too big. Pick a smaller one.' };

  return new Promise((resolve) => {
    const worker = new Worker(workerFile);
    const done = (result: { ok: true; photo: ShrunkPhoto } | { ok: false; error: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => done({ ok: false, error: 'A photo took too long. Try again.' }), WORKER_TIMEOUT_MS);
    worker.once('message', (msg: { ok: boolean; bytes?: Uint8Array; width?: number; height?: number; error?: string }) => {
      if (msg.ok && msg.bytes && msg.width && msg.height) done({ ok: true, photo: { bytes: Buffer.from(msg.bytes), width: msg.width, height: msg.height } });
      else {
        console.warn('[feed] photo could not be read', { error: msg.error });
        done({ ok: false, error: 'A photo could not be read. Try another.' });
      }
    });
    worker.once('error', (error: Error) => {
      console.error('[feed] photo worker failed', { error: error.message });
      done({ ok: false, error: 'A photo could not be read. Try another.' });
    });
    worker.postMessage(bytes);
  });
}

/**
 * Photo links last at least 6 hours and stay the same within each 6-hour
 * window (signed from the window's start), so the app's image cache keeps
 * them instead of downloading every photo again on each refresh.
 */
export const PHOTO_WINDOW_MS = 6 * 3600_000;
export function photoSigningWindow(now = Date.now()): { signingDate: Date; expiresInSeconds: number } {
  return { signingDate: new Date(Math.floor(now / PHOTO_WINDOW_MS) * PHOTO_WINDOW_MS), expiresInSeconds: (2 * PHOTO_WINDOW_MS) / 1000 };
}
