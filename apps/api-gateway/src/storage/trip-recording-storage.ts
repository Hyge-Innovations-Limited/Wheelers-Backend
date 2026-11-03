import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** One recorded segment, uploaded straight from the driver's phone. */
export const TRIP_RECORDING_MAX_SEGMENT_BYTES = 20 * 1024 * 1024;
export const TRIP_RECORDING_MAX_SEGMENTS = 40;
export const TRIP_RECORDING_CONTENT_TYPE = 'audio/mp4';

export type StoredObject = { size: number; etag: string | null };

/**
 * Trip recordings in their own R2 bucket. The phone gets a signed PUT for one
 * segment (15 minutes), support gets a signed GET for listening (5 minutes);
 * nothing is ever public. The key is built here, never taken from the phone.
 */
export class TripRecordingStorage {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(params: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string; jurisdiction?: string }) {
    this.s3 = new S3Client({
      region: 'auto',
      // A bucket made in a jurisdiction (EU) lives at its own address.
      endpoint: `https://${params.accountId}${params.jurisdiction ? `.${params.jurisdiction}` : ''}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: params.accessKeyId, secretAccessKey: params.secretAccessKey },
      // No checksum of an empty body in the signed PUT: the phone sends the real file, and R2 would refuse it.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    this.bucket = params.bucket;
  }

  /** The R2 bucket, for the admin list (where to look in Cloudflare). */
  get bucketName(): string {
    return this.bucket;
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

  /** Size and ETag, or null when nothing is there. Any other R2 error throws (the phone retries). */
  async stat(key: string): Promise<StoredObject | null> {
    try {
      const head = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: typeof head.ContentLength === 'number' ? head.ContentLength : 0, etag: head.ETag ?? null };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      const name = (error as { name?: string })?.name;
      if (status === 404 || name === 'NotFound' || name === 'NoSuchKey') return null;
      throw error;
    }
  }

  /** The first bytes, to check the file really is an m4a. */
  async head(key: string, bytes = 12): Promise<Buffer> {
    const result = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${bytes - 1}` }));
    const body = result.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
    return Buffer.from((await body?.transformToByteArray?.()) ?? new Uint8Array());
  }

  /** Deletes; returns the keys R2 could not delete. */
  async remove(keys: string[]): Promise<string[]> {
    if (keys.length === 0) return [];
    const result = await this.s3.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }));
    return (result.Errors ?? []).map((item) => item.Key).filter((key): key is string => typeof key === 'string');
  }

  /** Every object under trips/ last written before the cutoff, a page at a time (uploads never confirmed too). */
  async listOlderThan(cutoff: Date, limit = 1000): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: 'trips/', ContinuationToken: token }));
      for (const item of page.Contents ?? []) {
        if (item.Key && item.LastModified && item.LastModified < cutoff) keys.push(item.Key);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token && keys.length < limit);
    return keys;
  }
}

/** An m4a (ISO base media) file says "ftyp" at bytes 4-7. */
export function looksLikeM4a(firstBytes: Buffer): boolean {
  return firstBytes.length >= 8 && firstBytes.subarray(4, 8).toString('latin1') === 'ftyp';
}
