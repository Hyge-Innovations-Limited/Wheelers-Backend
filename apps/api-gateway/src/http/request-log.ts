import type { IncomingMessage, ServerResponse } from 'http';

/**
 * HTTP access logging.
 *
 * The gateway used to print a multi-line object when every request arrived and
 * another when it finished. On a two-core box that is real CPU at a few hundred
 * requests a second, it fills the disk, and it buries the one line that
 * matters under thousands of health checks and driver location pings.
 *
 *   HTTP_LOG=quiet  (default in production) one line, and only for a request
 *                   worth reading: it failed, it was slow, or it touched money.
 *   HTTP_LOG=full   (default elsewhere) one line for every request.
 *   HTTP_LOG=off    nothing.
 *
 * Switching is an edit to `.env` and `npm run pm2:restart` — turn `full` on
 * while chasing a bug, and back off afterwards.
 */
type Mode = 'quiet' | 'full' | 'off';

function readMode(): Mode {
  const raw = (process.env['HTTP_LOG'] ?? '').trim().toLowerCase();
  if (raw === 'quiet' || raw === 'full' || raw === 'off') return raw;
  return process.env['NODE_ENV'] === 'production' ? 'quiet' : 'full';
}

const SLOW_MS = Number(process.env['HTTP_LOG_SLOW_MS'] ?? 1000);

/** Anything that moves, or decides about, money is always worth a line. */
const MONEY = /^\/(wallet|wallet-page|webhooks\/paystack|admin\/users\/[^/]+\/withdrawals)(\/|$)/;

export function attachRequestLog(
  req: IncomingMessage,
  res: ServerResponse,
  safePath: string,
  pathname: string,
  clientIp: string | null,
  startedAt: number,
): void {
  const mode = readMode();
  if (mode === 'off') return;

  res.on('finish', () => {
    const ms = Date.now() - startedAt;
    const status = res.statusCode;
    if (mode === 'quiet') {
      const failed = status >= 400;
      const worthALine = failed || ms >= SLOW_MS || (MONEY.test(pathname) && req.method !== 'GET');
      if (!worthALine) return;
    }
    const line = `[http] ${req.method ?? '?'} ${safePath} ${status} ${ms}ms${clientIp ? ` ip=${clientIp}` : ''}`;
    if (status >= 500) console.error(line);
    else if (status >= 400 || ms >= SLOW_MS) console.warn(line);
    else console.info(line);
  });
}
