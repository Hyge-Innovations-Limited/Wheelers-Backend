import { parentPort } from 'node:worker_threads';
import Jimp from 'jimp';

/**
 * Runs in its own thread (feed-photos.ts): Jimp decodes in plain JavaScript,
 * and a phone photo takes a second or two that would otherwise hold up every
 * other request. Brings a Feed photo down to 1280 pixels on its longest side
 * and writes it again as a JPEG, which also drops what the camera wrote in it
 * (where it was taken, the phone).
 */
const LONGEST_SIDE = 1280;

parentPort?.on('message', async (bytes: Uint8Array) => {
  try {
    const image = await Jimp.read(Buffer.from(bytes));
    const longest = Math.max(image.getWidth(), image.getHeight());
    if (longest > LONGEST_SIDE) {
      if (image.getWidth() >= image.getHeight()) image.resize(LONGEST_SIDE, Jimp.AUTO);
      else image.resize(Jimp.AUTO, LONGEST_SIDE);
    }
    const out = (await image.quality(78).getBufferAsync(Jimp.MIME_JPEG)) as Buffer;
    parentPort?.postMessage({ ok: true, bytes: out, width: image.getWidth(), height: image.getHeight() });
  } catch (error) {
    parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
