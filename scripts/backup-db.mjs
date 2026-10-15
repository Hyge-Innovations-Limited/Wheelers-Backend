#!/usr/bin/env node
/**
 * The database, copied off the server every night.
 *
 *   node scripts/run-with-env.cjs node scripts/backup-db.mjs              back up now
 *   node scripts/run-with-env.cjs node scripts/backup-db.mjs --local-only a copy on this server only (no upload)
 *   node scripts/run-with-env.cjs node scripts/backup-db.mjs --list       what is in the bucket; nothing is backed up
 *
 * Each run: pg_dump from the Postgres container (its own user and database,
 * read inside the container, so no password is typed or logged), checked by
 * reading it back with pg_restore --list, uploaded to Cloudflare R2 under
 * daily/, then old copies are let go: 14 nightly copies in the bucket, the
 * newest 3 on this server. Each copy is the whole database (users, wallets,
 * rides, payments) as it stood that night; 14 is how far back one can go.
 * Documents and photos are not in it: they live in the app's R2 bucket, which
 * this script never touches. A copy only on this server dies with it, so the
 * upload is the part that matters.
 *
 * Settings (.env), its own and never the app's R2_* keys: backups live in a
 * bucket of their own, with a token that can reach nothing else, and the run
 * refuses a bucket the app stores documents in.
 *   BACKUP_R2_ACCOUNT_ID, BACKUP_R2_ACCESS_KEY_ID, BACKUP_R2_SECRET_ACCESS_KEY
 *                        an R2 token with Object Read & Write on the backup bucket only
 *   BACKUP_R2_BUCKET     the backup bucket, e.g. wheelers-backups
 *   BACKUP_R2_JURISDICTION  only for a bucket made in a jurisdiction: eu (or fedramp)
 *   BACKUP_DIR           default ~/backups
 *   POSTGRES_CONTAINER   default infra-postgres-1
 *
 * Nightly at 3am, server time (crontab -e). A login shell, so cron finds
 * node and npm wherever they were installed (nvm included):
 *   0 3 * * * bash -lc 'cd ~/Wheelers-Backend && npm run --silent db:backup' >> ~/backups/backup.log 2>&1
 *
 * Each run writes BACKUP_DIR/last-backup.json; a run that fails exits non-zero
 * with one "[backup] FAILED" line saying why.
 */
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

/** Nightly copies kept in the bucket: two weeks. */
const KEEP_DAILY = 14;
const KEEP_LOCAL = 3;

const args = new Set(process.argv.slice(2));
const container = process.env.POSTGRES_CONTAINER || 'infra-postgres-1';
const bucket = process.env.BACKUP_R2_BUCKET || '';
const dir = (process.env.BACKUP_DIR || '~/backups').replace(/^~/, homedir());

const log = (...parts) => console.log(`[backup] ${new Date().toISOString()}`, ...parts);

function run(command, commandArgs, { output } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    if (output) child.stdout.pipe(output);
    else child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${command} ${commandArgs[0]} exited ${code}: ${stderr.trim().slice(0, 400)}`));
      // The file is only whole once everything written to it has reached the disk.
      if (output && !output.writableFinished) output.once('finish', () => resolve(stdout));
      else resolve(stdout);
    });
  });
}

function r2() {
  const { BACKUP_R2_ACCOUNT_ID, BACKUP_R2_ACCESS_KEY_ID, BACKUP_R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
  if (!BACKUP_R2_ACCOUNT_ID || !BACKUP_R2_ACCESS_KEY_ID || !BACKUP_R2_SECRET_ACCESS_KEY || !bucket) {
    throw new Error('BACKUP_R2_ACCOUNT_ID, BACKUP_R2_ACCESS_KEY_ID, BACKUP_R2_SECRET_ACCESS_KEY and BACKUP_R2_BUCKET must be set in .env (or run with --local-only)');
  }
  // The app's own bucket holds drivers' papers and faces: a backup, and its clean-up, never go near it.
  if (R2_BUCKET && bucket === R2_BUCKET) {
    throw new Error(`BACKUP_R2_BUCKET is the app's storage bucket (${bucket}); backups need a bucket of their own`);
  }
  // A bucket made in a jurisdiction (EU) lives at its own address.
  const jurisdiction = (process.env.BACKUP_R2_JURISDICTION || '').trim().toLowerCase();
  return new S3Client({
    region: 'auto',
    endpoint: `https://${BACKUP_R2_ACCOUNT_ID}${jurisdiction ? `.${jurisdiction}` : ''}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: BACKUP_R2_ACCESS_KEY_ID, secretAccessKey: BACKUP_R2_SECRET_ACCESS_KEY },
  });
}

async function listKeys(client, prefix) {
  const keys = [];
  let token;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const item of page.Contents ?? []) keys.push({ key: item.Key, bytes: item.Size ?? 0 });
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys.sort((a, b) => a.key.localeCompare(b.key));
}

/** All but the newest `keep` under a prefix. Names sort by date, so the oldest go first. */
async function letGo(client, prefix, keep) {
  const keys = await listKeys(client, prefix);
  const old = keys.slice(0, Math.max(0, keys.length - keep));
  if (old.length === 0) return 0;
  await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: old.map(({ key }) => ({ Key: key })) } }));
  return old.length;
}

async function main() {
  if (args.has('--list')) {
    const client = r2();
    for (const prefix of ['daily/']) {
      const keys = await listKeys(client, prefix);
      console.log(`${prefix} ${keys.length} copies`);
      for (const { key, bytes } of keys) console.log(`  ${key}  ${(bytes / 1024 / 1024).toFixed(1)} MB`);
    }
    return;
  }

  const client = args.has('--local-only') ? null : r2();
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/:\d\d\.\d+Z$/, 'Z').replace(/[:]/g, '');
  const name = `wheelers-${stamp}.dump`;
  const file = join(dir, name);

  // 1. The dump, streamed straight to a file. -Fc is compressed and restores table by table.
  log('dumping from', container);
  await run('docker', ['exec', container, 'sh', '-c', 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc'], { output: createWriteStream(file) });
  const bytes = statSync(file).size;
  if (bytes < 1024) throw new Error(`the dump is only ${bytes} bytes`);

  // 2. Read back: a file pg_restore cannot list is not a backup. Copied in
  // rather than piped: docker exec -i can wait on a pipe pg_restore let go of.
  const inside = `/tmp/${name}`;
  await run('docker', ['cp', file, `${container}:${inside}`]);
  const listing = await run('docker', ['exec', container, 'pg_restore', '--list', inside]).finally(() =>
    run('docker', ['exec', container, 'rm', '-f', inside]).catch(() => undefined),
  );
  const tables = (listing.match(/ TABLE DATA /g) ?? []).length;
  if (tables === 0) throw new Error('the dump reads back with no table data in it');
  log(`dump ok: ${(bytes / 1024 / 1024).toFixed(1)} MB, ${tables} tables`);

  // 3. Off the server.
  let key = null;
  if (client) {
    key = `daily/${name}`;
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: createReadStream(file), ContentLength: bytes, ContentType: 'application/octet-stream' }));
    log('uploaded', `${bucket}/${key}`);
    const gone = await letGo(client, 'daily/', KEEP_DAILY);
    if (gone) log(`let ${gone} old cop${gone === 1 ? 'y' : 'ies'} go`);
  }

  // 4. The newest few stay here too, for a quick restore without downloading.
  const local = readdirSync(dir).filter((f) => /^wheelers-.*\.dump$/.test(f)).sort();
  for (const old of local.slice(0, Math.max(0, local.length - KEEP_LOCAL))) unlinkSync(join(dir, old));

  writeFileSync(join(dir, 'last-backup.json'), JSON.stringify({ at: new Date().toISOString(), file, key, bytes, tables }, null, 2));
  log('done');
}

/** Cloudflare's own words, plus what usually causes them. */
function explain(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error?.name === 'NoSuchBucket' || /specified bucket does not exist/i.test(message)) {
    return `${message} Cloudflare has no bucket named "${bucket}" in account ${process.env.BACKUP_R2_ACCOUNT_ID}`
      + `${process.env.BACKUP_R2_JURISDICTION ? ` (jurisdiction ${process.env.BACKUP_R2_JURISDICTION})` : ''}. `
      + 'Check R2 > Overview: is it there, spelt the same, and made in that account? '
      + 'A bucket made with location EU also needs BACKUP_R2_JURISDICTION=eu.';
  }
  if (error?.name === 'InvalidAccessKeyId' || error?.name === 'SignatureDoesNotMatch' || /access denied|unauthorized/i.test(message)) {
    return `${message} The key is refused: check BACKUP_R2_ACCESS_KEY_ID and BACKUP_R2_SECRET_ACCESS_KEY, and that the token covers "${bucket}".`;
  }
  return message;
}

main().catch((error) => {
  console.error(`[backup] ${new Date().toISOString()} FAILED: ${explain(error)}`);
  process.exit(1);
});
