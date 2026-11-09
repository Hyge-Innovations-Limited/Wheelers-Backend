import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { dkimSign } from 'mailauth';

/** A new 2048-bit RSA key: the private half for the server, the public half for DNS. */
export function generateDkimKey(): { privateKeyPem: string; publicKeyBase64: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

/** The TXT value for <selector>._domainkey.<domain>, from the private key. */
export function dkimDnsValue(privateKeyPem: string): string {
  const der = createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'der' });
  return `v=DKIM1; k=rsa; p=${der.toString('base64')}`;
}

/**
 * Signs a message as `domain` (relaxed/relaxed, rsa-sha256): the DKIM-Signature
 * header goes on top. The From header is signed twice over, so no one can add
 * a second From and keep the signature valid.
 */
export async function signMessage(raw: Buffer, domain: string, selector: string, privateKey: string): Promise<Buffer> {
  const result = await dkimSign(raw, {
    canonicalization: 'relaxed/relaxed',
    headerList: ['From', 'From', 'To', 'Cc', 'Reply-To', 'Subject', 'Date', 'Message-ID', 'In-Reply-To', 'References', 'MIME-Version', 'Content-Type', 'Content-Transfer-Encoding', 'List-Unsubscribe', 'List-Unsubscribe-Post', 'Feedback-ID'],
    signatureData: [{ signingDomain: domain, selector, privateKey }],
  });
  if (!result.signatures) {
    const why = (result as { errors?: Array<{ message?: string }> }).errors?.map((e) => e.message).join('; ');
    throw new Error(`DKIM signing failed${why ? `: ${why}` : ''}`);
  }
  return Buffer.concat([Buffer.from(result.signatures), raw]);
}
