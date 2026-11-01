import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** One recorded segment, uploaded straight from the driver's phone. */
export const TRIP_RECORDING_MAX_SEGMENT_BYTES = 20 * 1024 * 1024;
export const TRIP_RECORDING_MAX_SEGMENTS = 40;
export const TRIP_RECORDING_CONTENT_TYPE = 'audio/mp4';

/**
 * Trip recordings in their own R2 bucket. The phone gets a signed PUT for one
 * segment (15 minutes), support gets a signed GET for listening (5 minutes);
 * nothing is ever public. The key is built here, never taken from the phone.
 */
export class TripRecordingStorage {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(params: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string }) {
    this.s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${params.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: params.accessKeyId, secretAccessKey: params.secretAccessKey },
    });
    this.bucket = params.bucket;
  }

  keyFor(rideId: string, segmentIndex: number): string {
    return `trips/${rideId}/segment-${String(segmentIndex).padStart(3, '0')}.m4a`;
  }

  async uploadUrl(key: string, bytes: number, expiresInSeconds = 15 * 60): Promise<string> {
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: TRIP_RECORDING_CONTENT_TYPE, ContentLength: bytes });
    return getSignedUrl(this.s3, command, { expiresIn: expiresInSeconds });
  }

  async listenUrl(key: string, expiresInSeconds = 5 * 60): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseContentType: TRIP_RECORDING_CONTENT_TYPE });
    return getSignedUrl(this.s3, command, { expiresIn: expiresInSeconds });
  }

  /** The stored size, or null when nothing is there yet. */
  async sizeOf(key: string): Promise<number | null> {
    try {
      const head = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return typeof head.ContentLength === 'number' ? head.ContentLength : null;
    } catch {
      return null;
    }
  }

  async remove(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.s3.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }));
  }
}
