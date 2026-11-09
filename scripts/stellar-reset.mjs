#!/usr/bin/env node
/**
 * Bring every rider's and driver's Stellar Testnet account back to the
 * starting 100 test XLM. Whatever is above it goes back to operations, as a
 * RESET transfer the gateway's Stellar job sends (operations pays the fee).
 * Accounts opened under the earlier design got 10,000 from Friendbot.
 *
 *   node scripts/run-with-env.cjs node scripts/stellar-reset.mjs            → dry run: what would move
 *   node scripts/run-with-env.cjs node scripts/stellar-reset.mjs --confirm  → queue the transfers
 *
 * Needs a built tree and STELLAR_ENABLED=true. Testnet only. Running it again
 * on the same day queues nothing new.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const CONFIRM = process.argv.includes('--confirm');
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL missing — run through scripts/run-with-env.cjs'); process.exit(1); }

const { stellarConfigFromEnv } = require('../apps/api-gateway/dist/stellar/config.js');
const { createHorizonNetwork } = require('../apps/api-gateway/dist/stellar/network.js');
const { createRateProvider } = require('../apps/api-gateway/dist/stellar/rates.js');
const { createStellarService } = require('../apps/api-gateway/dist/stellar/service.js');
const { prisma } = require('../packages/db/dist/index.js');

const config = stellarConfigFromEnv(process.env);
if (!config) { console.error('Stellar is off (STELLAR_ENABLED is not true). Nothing to do.'); process.exit(1); }
const stellar = createStellarService({
  config,
  network: createHorizonNetwork(config),
  rates: createRateProvider({ fallbackNgnPerXlm: config.fallbackNgnPerXlm }),
});

try {
  const plan = await stellar.resetBalances({ dryRun: !CONFIRM });
  const total = plan.reduce((sum, row) => sum + row.returnXlm, 0);
  for (const row of plan) {
    console.log(`${row.publicKey.slice(0, 6)}…${row.publicKey.slice(-6)}  ${row.balanceXlm.toFixed(2).padStart(12)} XLM  →  ${config.startingXlm} (returns ${row.returnXlm.toFixed(2)})`);
  }
  console.log(`\n${plan.length} account(s), ${total.toFixed(2)} test XLM back to operations.`);
  console.log(CONFIRM
    ? 'Queued. The gateway sends them within a minute or two; watch the admin Stellar page.'
    : 'Dry run: nothing queued. Add --confirm to do it.');
} finally {
  await prisma.$disconnect();
}
