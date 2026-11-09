#!/usr/bin/env node
/**
 * Will the database keep up? Read-only — it changes nothing.
 *
 *   node scripts/run-with-env.cjs node scripts/db-capacity.mjs
 *
 * Run it ON the server, ideally while scripts/load-test.mjs is ramping, so the
 * numbers show the database under pressure rather than at rest.
 *
 * What it checks, in the order things actually break:
 *   1. CONNECTIONS  every service keeps its own pool. If the pools added
 *                   together exceed what Postgres accepts, requests start
 *                   failing with "too many clients" under load — long before
 *                   the CPU is busy. This is the usual first wall.
 *   2. PRESSURE     connections in use right now, stuck transactions, locks.
 *   3. HEALTH       cache hit rate, deadlocks, spills to disk.
 *   4. TABLES       the biggest ones, and any large table read without an index.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL missing — run through scripts/run-with-env.cjs');
  process.exit(1);
}
const prisma = new PrismaClient();
const one = async (sql) => (await prisma.$queryRawUnsafe(sql))[0];
const many = (sql) => prisma.$queryRawUnsafe(sql);
const n = (v) => Number(v ?? 0);
const line = (k, v) => console.log(`  ${k.padEnd(34)} ${v}`);

/** Every pm2 app opens its own Prisma pool. */
function serviceCount() {
  try {
    const apps = require('../ecosystem.config.cjs').apps ?? [];
    return { count: apps.reduce((a, app) => a + (Number(app.instances) > 0 ? Number(app.instances) : 1), 0), names: apps.map((a) => a.name) };
  } catch {
    return { count: 8, names: [] };
  }
}

const poolPerService = (() => {
  const match = /[?&]connection_limit=(\d+)/.exec(url);
  if (match) return Number(match[1]);
  return require('node:os').cpus().length * 2 + 1; // Prisma's default
})();

console.log('\n══════════ DATABASE CAPACITY ══════════');

/* 1 ── connections ───────────────────────────────────────────────────── */
const max = n((await one('SHOW max_connections')).max_connections);
const reserved = n((await one('SHOW superuser_reserved_connections')).superuser_reserved_connections);
const usable = max - reserved;
const services = serviceCount();
const demand = services.count * poolPerService;

console.log('\n1. CONNECTIONS');
line('Postgres accepts', `${max} (${usable} usable, ${reserved} reserved for admins)`);
line('services with their own pool', `${services.count}${services.names.length ? `  (${services.names.join(', ')})` : ''}`);
line('pool size per service', `${poolPerService}  (connection_limit in DATABASE_URL)`);
line('worst-case demand', `${services.count} × ${poolPerService} = ${demand}`);
if (demand > usable) {
  const safe = Math.max(2, Math.floor((usable * 0.9) / services.count));
  console.log(`\n OVER-SUBSCRIBED by ${demand - usable}. Under load, services will be refused connections`);
  console.log('     ("too many clients already") while the server still looks idle.');
  console.log(`     Fix: set connection_limit=${safe} in DATABASE_URL (${services.count} × ${safe} = ${services.count * safe} ≤ ${usable}),`);
  console.log(`     or raise max_connections in postgresql.conf, or put PgBouncer in front.`);
} else {
  console.log(`\n fits, with ${usable - demand} connections to spare.`);
}

/* 2 ── pressure right now ────────────────────────────────────────────── */
const activity = await many(`
  SELECT COALESCE(NULLIF(application_name, ''), '(unnamed)') AS app, state, COUNT(*)::int AS count
  FROM pg_stat_activity WHERE datname = current_database() GROUP BY 1, 2 ORDER BY 3 DESC`);
const inUse = activity.reduce((a, r) => a + r.count, 0);
const stuck = await many(`
  SELECT pid, state, EXTRACT(EPOCH FROM (now() - xact_start))::int AS seconds, LEFT(query, 90) AS query
  FROM pg_stat_activity
  WHERE datname = current_database() AND xact_start IS NOT NULL AND now() - xact_start > interval '30 seconds' AND pid <> pg_backend_pid()
  ORDER BY xact_start LIMIT 5`);
const waiting = n((await one(`SELECT COUNT(*)::int AS c FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).c);

console.log('\n2. PRESSURE RIGHT NOW');
line('connections in use', `${inUse} of ${usable} (${Math.round((inUse / usable) * 100)}%)`);
for (const r of activity.slice(0, 6)) line(`  ${r.app} · ${r.state ?? 'background'}`, r.count);
line('queries waiting on a lock', waiting === 0 ? '0 (ok)' : `${waiting} (warning)`);
if (stuck.length === 0) line('transactions open > 30s', '0 (ok)');
else for (const s of stuck) console.log(`  WARNING: open ${s.seconds}s (${s.state}): ${s.query}`);

/* 3 ── health ────────────────────────────────────────────────────────── */
const db = await one(`
  SELECT xact_commit, xact_rollback, deadlocks, temp_files, blks_hit, blks_read
  FROM pg_stat_database WHERE datname = current_database()`);
const hitRate = n(db.blks_hit) + n(db.blks_read) === 0 ? 100 : (n(db.blks_hit) / (n(db.blks_hit) + n(db.blks_read))) * 100;

console.log('\n3. HEALTH (since the last stats reset)');
line('cache hit rate', `${hitRate.toFixed(2)}%  ${hitRate >= 99 ? '(ok)' : hitRate >= 95 ? '— fine' : 'WARNING: the working set no longer fits in memory'}`);
line('deadlocks', `${n(db.deadlocks)} ${n(db.deadlocks) === 0 ? '(ok)' : '(warning)'}`);
line('queries that spilled to disk', `${n(db.temp_files)} ${n(db.temp_files) < 50 ? '(ok)' : 'WARNING: raise work_mem or add an index'}`);
line('rollbacks', `${n(db.xact_rollback)} of ${n(db.xact_commit) + n(db.xact_rollback)} transactions`);

/* 4 ── tables ────────────────────────────────────────────────────────── */
const tables = await many(`
  SELECT relname AS table, n_live_tup::bigint AS rows, pg_size_pretty(pg_total_relation_size(relid)) AS size,
         seq_scan::bigint AS seq_scans, COALESCE(idx_scan, 0)::bigint AS idx_scans
  FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 8`);
console.log('\n4. BIGGEST TABLES');
for (const t of tables) line(`  ${t.table}`, `${String(n(t.rows)).padStart(9)} rows  ${String(t.size).padStart(8)}`);

const unindexed = await many(`
  SELECT relname AS table, n_live_tup::bigint AS rows, seq_scan::bigint AS seq_scans, COALESCE(idx_scan, 0)::bigint AS idx_scans
  FROM pg_stat_user_tables
  WHERE n_live_tup > 20000 AND seq_scan > 1000 AND seq_scan > COALESCE(idx_scan, 0)
  ORDER BY seq_scan * n_live_tup DESC LIMIT 5`);
if (unindexed.length === 0) {
  console.log('\n no large table is being read row-by-row.');
} else {
  console.log('\n large tables mostly read WITHOUT an index — these slow down as they grow:');
  for (const t of unindexed) console.log(`     ${t.table}: ${n(t.rows).toLocaleString()} rows, ${n(t.seq_scans).toLocaleString()} full scans vs ${n(t.idx_scans).toLocaleString()} index reads`);
}

console.log('\n───────────────────────────────────────');
console.log(demand > usable
  ? 'Verdict: fix the connection pools FIRST — that wall comes before any other.'
  : inUse / usable > 0.8
    ? 'Verdict: connections are nearly exhausted right now. Lower the pools or add PgBouncer before adding users.'
    : 'Verdict: the database has room. Re-run this during a load test to see it under pressure.');
console.log('');
await prisma.$disconnect();
