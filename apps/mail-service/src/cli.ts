import { existsSync, writeFileSync } from 'node:fs';
import { loadWorkspaceEnv } from '@wheleers/config';
import { prisma } from '@wheleers/db';
import { normaliseAddress } from './address';
import { readConfig } from './config';
import { generateDkimKey } from './dkim';
import { enqueue } from './outbox';
import { dnsRecords } from './records';

/**
 *   npm -w @wheleers/mail-service run cli -- dkim-keygen /path/to/dkim.key   a new key (the file is never overwritten)
 *   npm -w @wheleers/mail-service run cli -- dns                             the DNS records to set
 *   npm -w @wheleers/mail-service run cli -- mailbox add support@mail.wheelersng.com "Wheelers support"
 *   npm -w @wheleers/mail-service run cli -- mailbox list
 *   npm -w @wheleers/mail-service run cli -- send you@gmail.com "Subject" "Text"   queues a test email
 */
async function main(args: string[]) {
  const [command, ...rest] = args;

  if (command === 'dkim-keygen') {
    const path = rest[0];
    if (!path) throw new Error('Where should the key go? dkim-keygen /home/wheelers/mail/dkim-s2026q4.key');
    if (existsSync(path)) throw new Error(`${path} exists already: a new key would break the DNS record of the old one`);
    const key = generateDkimKey();
    writeFileSync(path, key.privateKeyPem, { mode: 0o600 });
    console.log(`Private key written to ${path} (only this user can read it). Set MAIL_DKIM_KEY_PATH=${path}`);
    console.log(`DNS TXT value for <selector>._domainkey.<domain>:\n\nv=DKIM1; k=rsa; p=${key.publicKeyBase64}\n`);
    return;
  }

  loadWorkspaceEnv();
  const config = readConfig();

  if (command === 'dns') {
    for (const r of dnsRecords(config)) console.log(`${r.type.padEnd(4)} ${r.name}\n     ${r.value}\n     ${r.why}\n`);
    return;
  }
  if (command === 'mailbox' && rest[0] === 'add') {
    const address = normaliseAddress(rest[1] ?? '');
    if (!address) throw new Error('mailbox add <address> [name]');
    if (!config.inboundDomains.includes(address.slice(address.lastIndexOf('@') + 1))) throw new Error(`We receive mail for ${config.inboundDomains.join(', ')} only (MAIL_INBOUND_DOMAINS)`);
    await prisma.mailMailbox.upsert({ where: { address }, create: { address, name: rest[2] ?? null }, update: { name: rest[2] ?? null } });
    console.log(`${address} receives mail now`);
    return;
  }
  if (command === 'mailbox' && rest[0] === 'list') {
    for (const m of await prisma.mailMailbox.findMany({ orderBy: { address: 'asc' } })) console.log(`${m.address}${m.name ? `  (${m.name})` : ''}`);
    return;
  }
  if (command === 'send') {
    const [to, subject, text] = rest;
    if (!to || !subject || !text) throw new Error('send <to> <subject> <text>');
    const queued = await enqueue(config, { to, subject, text, tag: 'cli_test' });
    console.log(`Queued ${queued.id}; the worker sends it. Follow it: GET /messages/${queued.id}`);
    return;
  }
  throw new Error('Commands: dkim-keygen <path>, dns, mailbox add <address> [name], mailbox list, send <to> <subject> <text>');
}

main(process.argv.slice(2))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect().catch(() => undefined));
