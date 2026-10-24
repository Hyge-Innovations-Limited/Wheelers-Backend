import { Readable } from 'node:stream';
import SMTPConnection from 'nodemailer/lib/smtp-connection';

export type Attempt =
  /** The server took it. */
  | { kind: 'delivered'; code: number; response: string; tls: boolean }
  /** The server answered no: 4xx (try later) or 5xx (never). */
  | { kind: 'refused'; code: number; enhanced: string | null; response: string; permanent: boolean }
  /** No answer worth the name: refused connection, timeout, dropped line. Try the next server. */
  | { kind: 'unreachable'; reason: string }
  /**
   * The whole message went out, then the line dropped before the server said yes or no. It
   * most likely arrived (RFC 1047): sending it again is how people get an email twice.
   */
  | { kind: 'unconfirmed'; reason: string };

export type AttemptInput = {
  ip: string;
  /** The MX host's name: for TLS (SNI) and the log. */
  hostName: string;
  port: number;
  helo: string;
  localAddress: string | null;
  envelopeFrom: string;
  recipient: string;
  raw: Buffer;
  /** Called the moment the whole message has gone out, before the server's answer. */
  onBodySent?: () => void;
};

export const enhancedCode = (text: string) => /\b([245]\.\d{1,3}\.\d{1,3})\b/.exec(text)?.[1] ?? null;
const oneLine = (text: string | undefined) => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);

/**
 * One delivery to one server: connect on port 25, EHLO as our hostname,
 * STARTTLS when offered (and on without it if the upgrade fails: most mail
 * servers' certificates are not for the name we reach them by, which is why
 * mail between servers does not check them), MAIL FROM our bounce address,
 * RCPT TO, DATA. Never throws.
 */
export function attemptDelivery(input: AttemptInput): Promise<Attempt> {
  return new Promise((resolve) => {
    let settled = false;
    let bodySent = false;
    const connection = new SMTPConnection({
      host: input.ip,
      port: input.port,
      name: input.helo,
      localAddress: input.localAddress ?? undefined,
      servername: input.hostName,
      opportunisticTLS: true,
      tls: { rejectUnauthorized: false, servername: input.hostName, minVersion: 'TLSv1.2' },
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      // RFC 5321 4.5.3.2: a server may take up to 10 minutes to answer the end of the message.
      // Giving up sooner is the classic way to send an email twice.
      socketTimeout: 10 * 60_000,
      logger: false,
    });

    const finish = (result: Attempt) => {
      if (settled) return;
      settled = true;
      try {
        if (result.kind === 'delivered') connection.quit();
        else connection.close();
      } catch {
        // already closed
      }
      resolve(result);
    };

    const fromError = (error: unknown): Attempt => {
      const e = error as { responseCode?: number; response?: string; message?: string; code?: string; rejectedErrors?: Array<{ responseCode?: number; response?: string }> };
      const rejected = e.rejectedErrors?.[0];
      const code = e.responseCode ?? rejected?.responseCode;
      const response = oneLine(e.response ?? rejected?.response ?? e.message);
      if (typeof code === 'number' && code >= 400) {
        // 5xx is for good, except 503 (a command out of order: our side, worth another go).
        return { kind: 'refused', code, enhanced: enhancedCode(response), response, permanent: code >= 500 && code !== 503 };
      }
      const reason = `${e.code ?? 'ERROR'}: ${oneLine(e.message)}`;
      return bodySent ? { kind: 'unconfirmed', reason } : { kind: 'unreachable', reason };
    };

    connection.on('error', (error) => finish(fromError(error)));
    // A server that refuses (Gmail's "421 slow down") often hangs up straight after: the
    // close can come before the refusal reaches us, and the refusal is what counts.
    connection.on('end', () => setTimeout(() => finish(bodySent
      ? { kind: 'unconfirmed', reason: 'the connection closed after the message, before the answer' }
      : { kind: 'unreachable', reason: 'the connection closed early' }), 200));

    connection.connect((connectError) => {
      if (connectError) return finish(fromError(connectError));
      const body = Readable.from([input.raw], { objectMode: false });
      body.once('end', () => {
        bodySent = true;
        input.onBodySent?.();
      });
      connection.send(
        { from: input.envelopeFrom, to: [input.recipient], size: input.raw.length },
        body,
        (sendError, info) => {
          if (sendError) return finish(fromError(sendError));
          const response = oneLine(info?.response);
          finish({ kind: 'delivered', code: Number(response.slice(0, 3)) || 250, response, tls: Boolean((connection as unknown as { secure?: boolean }).secure) });
        },
      );
    });
  });
}
