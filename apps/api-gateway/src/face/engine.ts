import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import Jimp from 'jimp';

/**
 * Faces in a photo, with the free @vladmandic/face-api (MIT) on TensorFlow.js's WebAssembly backend: no native
 * build, the same on a laptop and the server. Models (~12 MB, MIT) load once, on first use.
 *
 * The library needs ~450 MB once loaded, so it never runs inside the gateway (recycled at GATEWAY_MAX_MEMORY, and it
 * holds every socket): it runs in its own process, face-service (face/server.ts, pm2), and the gateway asks it over
 * 127.0.0.1 (faceEngine below). One photo at a time there (a queue).
 *
 * For each face: its descriptor (128 numbers: two photos of one person are close), and how far the head is turned
 * (the nose against the middle of the eyes, as a share of the eye width: 0 looking straight, ± turned).
 */
export interface FoundFace {
  descriptor: number[];
  turn: number;
  score: number;
  /** The face's width as a share of the photo's: a face far away is too small to trust. */
  size: number;
}

/** A scanned photo: its faces, and the photo brought down to 720 pixels (what is kept). */
export interface ScannedPhoto {
  faces: FoundFace[];
  jpeg: Buffer;
}

export interface FaceEngine {
  /** Faces in a photo (the KYC selfie). */
  faces(image: Buffer): Promise<FoundFace[]>;
  /** A scan frame: its faces and the small copy to keep. Throws NotAPhoto when the bytes are not an image. */
  scan(image: Buffer): Promise<ScannedPhoto>;
}

/** The bytes are not a photo (a broken upload): the driver tries again; never a broken check. */
export class NotAPhoto extends Error {
  constructor() { super('not a photo'); }
}

const MAX_SIDE = 720;

type FaceApi = typeof import('@vladmandic/face-api');
let loading: Promise<FaceApi> | null = null;

function load(): Promise<FaceApi> {
  if (!loading) {
    loading = (async () => {
      const req = createRequire(__filename);
      const faceapi = req('@vladmandic/face-api/dist/face-api.node-wasm.js') as FaceApi;
      const wasm = req('@tensorflow/tfjs-backend-wasm') as { setWasmPaths: (path: string) => void };
      wasm.setWasmPaths(join(dirname(req.resolve('@tensorflow/tfjs-backend-wasm/package.json')), 'dist') + '/');
      const tf = faceapi.tf as unknown as { setBackend: (name: string) => Promise<boolean>; ready: () => Promise<void> };
      await tf.setBackend('wasm');
      await tf.ready();
      const models = join(dirname(req.resolve('@vladmandic/face-api/package.json')), 'model');
      await faceapi.nets.tinyFaceDetector.loadFromDisk(models);
      await faceapi.nets.ssdMobilenetv1.loadFromDisk(models);
      await faceapi.nets.faceLandmark68Net.loadFromDisk(models);
      await faceapi.nets.faceRecognitionNet.loadFromDisk(models);
      return faceapi;
    })().catch((error) => {
      loading = null; // tried again next time
      throw error;
    });
  }
  return loading;
}

let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

async function decode(image: Buffer): Promise<Jimp> {
  // Jimp turns a phone photo the right way up from its EXIF orientation.
  const img = await Jimp.read(image).catch(() => { throw new NotAPhoto(); });
  if (Math.max(img.bitmap.width, img.bitmap.height) > MAX_SIDE) img.scaleToFit(MAX_SIDE, MAX_SIDE);
  return img;
}

async function detect(faceapi: FaceApi, img: Jimp): Promise<FoundFace[]> {
  const { width, height, data } = img.bitmap;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4) { rgb[j++] = data[i]; rgb[j++] = data[i + 1]; rgb[j++] = data[i + 2]; }
  const tensor = faceapi.tf.tensor3d(rgb, [height, width, 3], 'int32');
  try {
    // The quick detector first (~0.1 s on a selfie), the careful one (~0.3 s) only when it finds no face: many
    // drivers scanning at once wait for each other here.
    let found = await faceapi
      .detectAllFaces(tensor as never, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptors();
    if (found.length === 0) {
      found = await faceapi
        .detectAllFaces(tensor as never, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
        .withFaceLandmarks()
        .withFaceDescriptors();
    }
    return found.map((f) => {
      const pts = f.landmarks.positions;
      // 68 points: 30 the nose tip, 36 and 45 the outer corners of the eyes.
      const eyesMid = (pts[36].x + pts[45].x) / 2;
      const eyeWidth = Math.max(1, Math.abs(pts[45].x - pts[36].x));
      return {
        descriptor: Array.from(f.descriptor),
        turn: (pts[30].x - eyesMid) / eyeWidth,
        score: f.detection.score,
        size: f.detection.box.width / width,
      };
    });
  } finally {
    tensor.dispose();
  }
}

/** No face upright: a phone that saved the photo sideways without saying so. Tried turned both ways. */
async function detectAnyWayUp(faceapi: FaceApi, img: Jimp): Promise<{ faces: FoundFace[]; img: Jimp }> {
  const faces = await detect(faceapi, img);
  if (faces.length > 0) return { faces, img };
  for (const deg of [90, -90]) {
    const turned = img.clone().rotate(deg);
    const again = await detect(faceapi, turned);
    if (again.length > 0) return { faces: again, img: turned };
  }
  return { faces, img };
}

/** The library itself, in this process: only face-service (face/server.ts) and the tests use it. */
export const localFaceEngine: FaceEngine & { warm(): Promise<void> } = {
  async warm() {
    await oneAtATime(() => load().then(() => undefined));
  },
  faces(image: Buffer): Promise<FoundFace[]> {
    return oneAtATime(async () => {
      const img = await decode(image);
      const faceapi = await load();
      return (await detectAnyWayUp(faceapi, img)).faces;
    });
  },
  scan(image: Buffer): Promise<ScannedPhoto> {
    return oneAtATime(async () => {
      const img = await decode(image);
      const faceapi = await load();
      const found = await detectAnyWayUp(faceapi, img);
      return { faces: found.faces, jpeg: (await found.img.quality(80).getBufferAsync(Jimp.MIME_JPEG)) as Buffer };
    });
  },
};

const serviceUrl = () => (process.env.FACE_SERVICE_URL || `http://127.0.0.1:${process.env.FACE_PORT || '3040'}`).replace(/\/+$/, '');

async function ask(path: '/faces' | '/scan', image: Buffer): Promise<unknown> {
  // One more try when face-service is restarting (a refused or dropped connection), never after its own answer.
  for (let attempt = 0; ; attempt++) {
    let answered = false;
    try {
      const res = await fetch(`${serviceUrl()}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(image), signal: AbortSignal.timeout(60_000),
      });
      answered = true;
      if (res.status === 422) throw new NotAPhoto();
      if (!res.ok) throw new Error(`face-service answered ${res.status}`);
      return await res.json();
    } catch (error) {
      if (answered || attempt >= 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}

/** The gateway's engine: face-service over 127.0.0.1. */
export const faceEngine: FaceEngine = {
  async faces(image: Buffer) {
    return ((await ask('/faces', image)) as { faces: FoundFace[] }).faces;
  },
  async scan(image: Buffer) {
    const answer = (await ask('/scan', image)) as { faces: FoundFace[]; jpeg: string };
    return { faces: answer.faces, jpeg: Buffer.from(answer.jpeg, 'base64') };
  },
};

export function faceDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}
