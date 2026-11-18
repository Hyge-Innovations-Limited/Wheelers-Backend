import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import Jimp from 'jimp';

/**
 * Faces in a photo, with the free @vladmandic/face-api (MIT) on TensorFlow.js's WebAssembly backend: no native
 * build, the same on a laptop and the server. Models (~12 MB, MIT) load from the package once, on first use.
 * One photo at a time per process (a queue): a burst of drivers never piles up memory or slows rides.
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

export interface FaceEngine {
  faces(image: Buffer): Promise<FoundFace[]>;
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

export const faceEngine: FaceEngine = {
  faces(image: Buffer): Promise<FoundFace[]> {
    return oneAtATime(async () => {
      const faceapi = await load();
      const img = await Jimp.read(image);
      if (Math.max(img.bitmap.width, img.bitmap.height) > MAX_SIDE) img.scaleToFit(MAX_SIDE, MAX_SIDE);
      const { width, height, data } = img.bitmap;
      const rgb = new Uint8Array(width * height * 3);
      for (let i = 0, j = 0; i < data.length; i += 4) { rgb[j++] = data[i]; rgb[j++] = data[i + 1]; rgb[j++] = data[i + 2]; }
      const tensor = faceapi.tf.tensor3d(rgb, [height, width, 3], 'int32');
      try {
        const found = await faceapi
          .detectAllFaces(tensor as never, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
          .withFaceLandmarks()
          .withFaceDescriptors();
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
    });
  },
};

export function faceDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}
