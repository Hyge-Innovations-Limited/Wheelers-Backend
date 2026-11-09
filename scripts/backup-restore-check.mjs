#!/usr/bin/env node
/**
 * Proof a backup can be brought back: load it into a separate, throwaway
 * database next to the real one, count the rows that matter, compare with the
 * live database, and drop the throwaway again. The live database is only read.
 *
 *   node scripts/run-with-env.cjs node scripts/backup-restore-check.mjs              the newest copy in BACKUP_DIR
 *   node scripts/run-with-env.cjs node scripts/backup-restore-check.mjs <file.dump>  that one
 *
 * Once a month is enough. A backup never restored is a hope, not a backup.
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CHECK_DB = 'wheelers_restore_check';
const container = process.env.POSTGRES_CONTAINER || 'infra-postgres-1';
const dir = (process.env.BACKUP_DIR || '~/backups').replace(/^~/, homedir());
const COUNTED = ['User', 'Ride', 'Driver', 'Wallet'];

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim().slice(0, 400) || `exited ${code}`))));
  });
}

const sql = (database, query) =>
  run(['exec', container, 'sh', '-c', `psql -U "$POSTGRES_USER" -d ${database} -tAc '${query.replace(/'/g, "'\\''")}'`]);

async function main() {
  const file =
    process.argv[2] ??
    readdirSync(dir).filter((f) => /^wheelers-.*\.dump$/.test(f)).sort().map((f) => join(dir, f)).pop();
  if (!file) throw new Error(`no backup in ${dir}; run scripts/backup-db.mjs first`);

  const live = await run(['exec', container, 'printenv', 'POSTGRES_DB']);
  if (!live || live === CHECK_DB) throw new Error('the live database has the check database\'s name; refusing to touch it');

  console.log(`[restore-check] loading ${file} into ${CHECK_DB} (the live database ${live} is only read)`);
  await run(['exec', container, 'sh', '-c', `dropdb --if-exists -U "$POSTGRES_USER" ${CHECK_DB} && createdb -U "$POSTGRES_USER" ${CHECK_DB}`]);
  try {
    await run(['cp', file, `${container}:/tmp/restore-check.dump`]);
    await run(['exec', container, 'sh', '-c', `pg_restore -U "$POSTGRES_USER" -d ${CHECK_DB} --no-owner --no-privileges /tmp/restore-check.dump; status=$?; rm -f /tmp/restore-check.dump; exit $status`]);
    let ok = true;
    for (const table of COUNTED) {
      const exists = await sql(CHECK_DB, `select to_regclass('public."${table}"') is not null`);
      if (exists !== 't') continue;
      const restored = Number(await sql(CHECK_DB, `select count(*) from "${table}"`));
      const now = Number(await sql(live, `select count(*) from "${table}"`));
      // The live database has had time to grow since the copy; it should never have fewer.
      const fine = restored > 0 && restored <= now;
      if (!fine) ok = false;
      console.log(`  ${table.padEnd(8)} backup ${String(restored).padStart(7)}   live ${String(now).padStart(7)}   ${fine ? 'ok' : 'CHECK THIS'}`);
    }
    console.log(ok ? '[restore-check] the backup restores and its numbers make sense' : '[restore-check] restored, but some numbers look wrong: see above');
    if (!ok) process.exitCode = 1;
  } finally {
    await run(['exec', container, 'sh', '-c', `dropdb --if-exists -U "$POSTGRES_USER" ${CHECK_DB}`]).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(`[restore-check] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
