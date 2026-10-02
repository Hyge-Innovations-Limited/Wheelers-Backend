import { randomUUID } from 'node:crypto';
import Jimp from 'jimp';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export type KycFileType = 'image/jpeg' | 'image/png' | 'application/pdf';

/**
 * What a file really is, from its first bytes: the app sends a licence as a
 * photo or as a PDF, and only the bytes say which.
 */
export function sniffKycFileType(bytes: Buffer): KycFileType {
  if (bytes.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (bytes[0] === 0x89 && bytes.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  return 'image/jpeg';
}

export class DriverKycStorage {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(params: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string; prefix: string }) {
    this.s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${params.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: params.accessKeyId,
        secretAccessKey: params.secretAccessKey,
      },
    });
    this.bucket = params.bucket;
    this.prefix = params.prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  }

  async upload(params: {
    driverId: string;
    type: string;
    imageBuffer: Buffer;
    mimeType: string;
  }): Promise<string> {
    const ext = params.mimeType === 'application/pdf' ? 'pdf' : params.mimeType === 'image/png' ? 'png' : 'jpg';
    const objectKey = `${this.prefix}/${params.driverId}/${params.type}-${Date.now()}-${randomUUID()}.${ext}`;

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: params.imageBuffer,
        ContentType: params.mimeType,
      }),
    );

    return objectKey;
  }

  async getSignedUrl(key: string, expiresInSeconds = 3600, contentType?: KycFileType): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      // A PDF stored before PDFs were recognised was saved as image/jpeg;
      // this makes the browser open it as the PDF it is.
      ...(contentType ? { ResponseContentType: contentType, ResponseContentDisposition: 'inline' } : {}),
    });

    return getSignedUrl(this.s3, command, { expiresIn: expiresInSeconds });
  }

  /**
   * What a stored file really is. New uploads say so in the key; older ones
   * were all named .jpg, so their first bytes are read (8 bytes, not the file).
   */
  async fileTypeOf(key: string): Promise<KycFileType> {
    if (key.endsWith('.pdf')) return 'application/pdf';
    if (key.endsWith('.png')) return 'image/png';
    try {
      const response = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: 'bytes=0-7' }));
      if (!response.Body) return 'image/jpeg';
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
      return sniffKycFileType(Buffer.concat(chunks));
    } catch {
      return 'image/jpeg';
    }
  }

  /**
   * WhatsApp Flow Image components take RAW base64 (a data: URI renders as a
   * broken placeholder) and reject large images (~300KB cap per screen), so
   * camera-sized KYC photos must be downscaled before embedding.
   */
  async getImageAsBase64(key: string): Promise<string | null> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });
      const response = await this.s3.send(command);
      if (!response.Body) return null;

      const chunks: Uint8Array[] = [];
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
      }
      let buffer: Buffer = Buffer.concat(chunks);

      try {
        const image = await Jimp.read(buffer);
        if (image.getWidth() > 640) {
          image.resize(640, Jimp.AUTO);
        }
        buffer = (await image.quality(70).getBufferAsync(Jimp.MIME_JPEG)) as Buffer;
      } catch {
        // Not decodable — fall through with the original bytes
      }

      const base64 = buffer.toString('base64');
      if (base64.length > 280_000) return null; // still too big for a Flow screen
      return base64;
    } catch {
      return null;
    }
  }
}
