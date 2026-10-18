#!/usr/bin/env node
/**
 * The Stellar Testnet evidence for one demo trip, ready to paste into the
 * grant report: the rider's, the driver's and operations' addresses, and the
 * five transactions (both account openings, the fare with the trip ID as its
 * memo, the commission, and the driver's latest withdrawal), each with its
 * stellar.expert link. Reads only; changes nothing.
 *
 *   node scripts/run-with-env.cjs node scripts/stellar-evidence.mjs WH-01234
 *   node scripts/run-with-env.cjs node scripts/stellar-evidence.mjs WH-01234 > stellar-evidence.md
 *
 * The trip can also be given by its ride id (the uuid).
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { prisma } = require('@wheleers/db');

const EXPLORER = 'https://stellar.expert/explorer/testnet';
const account = (key) => `${EXPLORER}/account/${key}`;
const tx = (hash) => `${EXPLORER}/tx/${hash}`;

async function findRide(given) {
  const number = /^WH-?(\d+)$/i.exec(given.trim());
  if (number) return prisma.ride.findUnique({ where: { tripNumber: Number(number[1]) } });
  return prisma.ride.findUnique({ where: { id: given.trim() } });
}

function line(t) {
  if (!t) return '_not found_';
  const parts = [`${t.kind} · ${t.status}`, `${Number(t.amountXlm)} XLM`];
  if (t.amountNgn !== null) parts.push(`(₦${Number(t.amountNgn).toLocaleString('en-NG')} at ₦${Number(t.rateNgnPerXlm ?? 0).toLocaleString('en-NG')}/XLM)`);
  if (t.memo) parts.push(`memo "${t.memo}"`);
  return t.txHash ? `${parts.join(' · ')}\n  \`${t.txHash}\`\n  ${tx(t.txHash)}` : `${parts.join(' · ')} · no hash yet`;
}

async function main() {
  const given = process.argv[2];
  if (!given) throw new Error('Give the trip: node scripts/run-with-env.cjs node scripts/stellar-evidence.mjs WH-01234');
  const ride = await findRide(given);
  if (!ride) throw new Error(`No trip ${given}`);
  if (!ride.driverId) throw new Error(`Trip ${given} has no driver`);
  const driver = await prisma.driver.findUnique({ where: { id: ride.driverId }, select: { userId: true } });
  const tripId = `WH-${String(ride.tripNumber).padStart(5, '0')}`;

  const [riderAcct, driverAcct, opsAcct] = await Promise.all([
    prisma.stellarAccount.findUnique({ where: { userId: ride.riderId } }),
    prisma.stellarAccount.findUnique({ where: { userId: driver.userId } }),
    prisma.stellarAccount.findFirst({ where: { role: 'operations' } }),
  ]);
  const [riderOpen, driverOpen, fare, commission, withdrawal] = await Promise.all([
    prisma.stellarTransfer.findFirst({ where: { kind: 'ACCOUNT_OPEN', userId: ride.riderId }, orderBy: { createdAt: 'asc' } }),
    prisma.stellarTransfer.findFirst({ where: { kind: 'ACCOUNT_OPEN', userId: driver.userId }, orderBy: { createdAt: 'asc' } }),
    prisma.stellarTransfer.findFirst({ where: { kind: 'FARE', rideId: ride.id } }),
    prisma.stellarTransfer.findFirst({ where: { kind: 'COMMISSION', rideId: ride.id } }),
    prisma.stellarTransfer.findFirst({ where: { kind: 'WITHDRAWAL', userId: driver.userId }, orderBy: { createdAt: 'desc' } }),
  ]);

  const addr = (label, a) => (a ? `- **${label}:** \`${a.publicKey}\`\n  ${account(a.publicKey)}` : `- **${label}:** _no Stellar account_`);
  console.log(`# Wheelers on Stellar Testnet: trip ${tripId}

All Stellar activity below is on **Testnet** (test XLM, no real money).

## Addresses
${addr('Rider wallet', riderAcct)}
${addr('Driver wallet', driverAcct)}
${addr('Operations account', opsAcct)}

## Transactions
1. **Rider account created:** ${line(riderOpen)}
2. **Driver account created:** ${line(driverOpen)}
3. **Fare, rider → driver (memo = trip ID ${tripId}):** ${line(fare)}
4. **Commission, driver → operations:** ${line(commission)}
5. **Driver withdrawal:** ${line(withdrawal)}
`);
  const missing = [riderAcct, driverAcct, opsAcct, riderOpen, driverOpen, fare, commission, withdrawal].filter((x) => !x).length;
  const unconfirmed = [riderOpen, driverOpen, fare, commission, withdrawal].filter((t) => t && t.status !== 'CONFIRMED');
  if (missing) console.error(`Note: ${missing} item(s) not found. Was this trip paid from the wallet, and has the driver made a withdrawal?`);
  if (unconfirmed.length) console.error(`Note: not confirmed yet: ${unconfirmed.map((t) => `${t.kind} (${t.status}${t.lastError ? `: ${t.lastError}` : ''})`).join(', ')}. Wait a minute and run again.`);
}

main()
  .catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
