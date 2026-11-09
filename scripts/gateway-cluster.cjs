#!/usr/bin/env node
/**
 * Run N gateway processes on one port, on a machine without pm2 (a laptop).
 * It is what pm2's cluster mode does on the server: Node's own cluster module
 * shares the port and hands each new connection to the next process.
 *
 *   node scripts/gateway-cluster.cjs 2
 */
const cluster = require('node:cluster');
const path = require('node:path');

const count = Math.max(1, Number.parseInt(process.argv[2] || '2', 10) || 2);
const app = path.join(__dirname, '..', 'apps', 'api-gateway');

cluster.setupPrimary({ exec: path.join(app, 'dist', 'index.js'), cwd: app });
for (let i = 0; i < count; i += 1) cluster.fork();

let stopping = false;
cluster.on('exit', (worker, code, signal) => {
  if (stopping) return;
  console.warn(`[cluster] gateway process ${worker.process.pid} stopped (${signal || code}); starting another`);
  setTimeout(() => cluster.fork(), 1000);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    for (const worker of Object.values(cluster.workers)) worker.process.kill(signal);
    setTimeout(() => process.exit(0), 13_000).unref();
  });
}
cluster.on('disconnect', () => {
  if (stopping && Object.keys(cluster.workers).length === 0) process.exit(0);
});
