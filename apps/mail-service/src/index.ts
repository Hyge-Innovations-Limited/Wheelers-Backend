import { loadWorkspaceEnv } from '@wheleers/config';
import { prisma } from '@wheleers/db';
import { createApi } from './api';
import { ConfigError, readConfig } from './config';
import { createInboundServer } from './inbound';
import { createWorker } from './worker';

export { readConfig } from './config';
export { createApi } from './api';
export { createInboundServer } from './inbound';
export { createWorker, bounceAddress, deliveryFromBounceAddress, isHardBounce, nextTryAfter } from './worker';
export { enqueue, SendError } from './outbox';
export type { SendInput, Queued } from './outbox';
export { inbox } from './inbox';
export { drafts, DraftError } from './drafts';
export { createRouter } from './route';
export { generateDkimKey, dkimDnsValue, signMessage } from './dkim';
export { dnsRecords } from './records';
export { parseDeliveryStatus, parseFeedbackReport } from './reports';
export { normaliseAddress } from './address';

/**
 * The mail service: MAIL_ROLES picks the parts this process runs (all three
 * by default). api: the internal API on 127.0.0.1:4400. worker: sends the
 * queue. smtp: receives on port 25 (binding a port under 1024 needs
 * `sudo setcap cap_net_bind_service=+ep $(which node)` once, or MAIL_SMTP_PORT
 * 2525 with the firewall forwarding 25 to it).
 */
async function main() {
  loadWorkspaceEnv();
  let config;
  try {
    config = readConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[mail] not started: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
  if (!config.dkim.privateKey) console.warn('[mail] no DKIM key (MAIL_DKIM_KEY_PATH): nothing will be sent until there is one');
  if (config.smartHost) console.warn(`[mail] MAIL_SMART_HOST is set: every email goes to ${config.smartHost.host}:${config.smartHost.port}, not to its real server`);

  const worker = config.roles.has('worker') ? createWorker(config) : null;
  const inbound = config.roles.has('smtp') ? createInboundServer(config) : null;
  const api = config.roles.has('api') ? createApi(config, { health: () => ({ worker: worker?.status() ?? null, roles: [...config.roles] }) }) : null;

  if (api) console.log(`[mail] api on ${config.api.host}:${await api.listen()}`);
  if (inbound) console.log(`[mail] receiving on port ${await inbound.listen()} for ${config.inboundDomains.join(', ')}`);
  if (worker) {
    worker.start();
    console.log(`[mail] sending as ${config.domain} from ${config.hostname}`);
  }

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[mail] ${signal}: stopping`);
    const force = setTimeout(() => process.exit(1), 25_000);
    await Promise.allSettled([worker?.stop(), inbound?.close(), api?.close()]);
    await prisma.$disconnect().catch(() => undefined);
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('unhandledRejection', (error) => console.error('[mail] unhandled rejection', error));
}

if (require.main === module) {
  void main();
}
