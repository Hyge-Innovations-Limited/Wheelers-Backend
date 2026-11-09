import { createDecipheriv, createCipheriv, createHmac, createPrivateKey, privateDecrypt, constants, randomBytes, timingSafeEqual, type KeyObject } from 'crypto';

/**
 * Parse the flow private key however it survived the trip through .env:
 * real newlines, literal \n sequences (the usual casualty of pasting a PEM
 * into an env file), base64-wrapped whole-PEM, and optionally passphrase-
 * protected (WHATSAPP_FLOW_KEY_PASSPHRASE). OpenSSL's raw error for all of
 * these is the useless "DECODER routines::unsupported" — normalize first
 * and fail with words a human can act on.
 */
function parseFlowPrivateKey(privateKeyPem: string): KeyObject {
  let pem = privateKeyPem.trim();
  if (!pem.includes('-----BEGIN')) {
    // Whole PEM stored base64-encoded (a safe way to keep it on one line)
    try {
      const decoded = Buffer.from(pem, 'base64').toString('utf8');
      if (decoded.includes('-----BEGIN')) pem = decoded.trim();
    } catch { /* fall through to the error below */ }
  }
  pem = pem.replace(/\\n/g, '\n').replace(/\r/g, '');
  if (!pem.includes('-----BEGIN')) {
    throw new Error(
      'WHATSAPP_FLOW_PRIVATE_KEY does not look like a PEM key. Paste the full key including the BEGIN/END lines (literal \n for line breaks is fine), or base64-encode the whole file.',
    );
  }
  const passphrase = process.env.WHATSAPP_FLOW_KEY_PASSPHRASE;
  try {
    return createPrivateKey(passphrase ? { key: pem, passphrase } : pem);
  } catch (error) {
    const hint = /ENCRYPTED|bad decrypt|passphrase/i.test(String(error)) || pem.includes('ENCRYPTED')
      ? 'The key is passphrase-protected — set WHATSAPP_FLOW_KEY_PASSPHRASE in .env, or regenerate without a passphrase.'
      : 'Check that the key was pasted completely and line breaks survived (use literal \n or base64-encode the file).';
    throw new Error(`Could not parse WHATSAPP_FLOW_PRIVATE_KEY: ${hint}`);
  }
}

export interface DecryptedFlowRequest {
  decryptedBody: FlowRequestBody;
  aesKey: Buffer;
  iv: Buffer;
}

export interface FlowRequestBody {
  version: string;
  action: 'ping' | 'INIT' | 'data_exchange' | 'BACK';
  flow_token: string;
  screen?: string;
  data?: Record<string, unknown>;
}

interface EncryptedFlowEnvelope {
  encrypted_flow_data: string;
  encrypted_aes_key: string;
  initial_vector: string;
}

export function decryptFlowRequest(
  body: EncryptedFlowEnvelope,
  privateKeyPem: string,
): DecryptedFlowRequest {
  const { encrypted_flow_data, encrypted_aes_key, initial_vector } = body;

  // 1. Decrypt the AES key with RSA-OAEP (SHA-256)
  const aesKey = privateDecrypt(
    {
      key: parseFlowPrivateKey(privateKeyPem),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(encrypted_aes_key, 'base64'),
  );

  // 2. Decrypt the payload with AES-128-GCM
  const iv = Buffer.from(initial_vector, 'base64');
  const encryptedData = Buffer.from(encrypted_flow_data, 'base64');

  // Last 16 bytes are the GCM auth tag
  const AUTH_TAG_LENGTH = 16;
  const authTag = encryptedData.subarray(encryptedData.length - AUTH_TAG_LENGTH);
  const ciphertext = encryptedData.subarray(0, encryptedData.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv('aes-128-gcm', aesKey, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const decryptedBody = JSON.parse(decrypted.toString('utf8')) as FlowRequestBody;

  return { decryptedBody, aesKey, iv };
}

/** Sign a flow token with HMAC-SHA256 to prevent forgery. */
export function signFlowToken(payload: string, secret: string): string {
  const sig = createHmac('sha256', secret).update(payload).digest('hex').slice(0, 16);
  return `${payload}.${sig}`;
}

/** Verify and extract a signed flow token. Returns null if invalid. */
export function verifyFlowToken(token: string, secret: string): string | null {
  const lastDot = token.lastIndexOf('.');
  if (lastDot < 0) return null;
  const payload = token.slice(0, lastDot);
  const provided = token.slice(lastDot + 1);
  const expected = createHmac('sha256', secret).update(payload).digest('hex').slice(0, 16);
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return payload;
}

export function encryptFlowResponse(
  responseData: Record<string, unknown>,
  aesKey: Buffer,
  iv: Buffer,
): string {
  // Flip the IV for the response (Meta's protocol requirement)
  const flippedIv = Buffer.alloc(iv.length);
  for (let i = 0; i < iv.length; i++) {
    flippedIv[i] = ~iv[i] & 0xff;
  }

  const cipher = createCipheriv('aes-128-gcm', aesKey, flippedIv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(responseData), 'utf8'),
    cipher.final(),
  ]);

  // Concatenate ciphertext + auth tag
  return Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64');
}
