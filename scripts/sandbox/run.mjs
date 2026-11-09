/**
 * One-command Wheelers sandbox: docker infra + migrations + backend services
 * against an isolated database/redis, with all real-money and messaging
 * integrations stubbed or inert. See sandbox-env.mjs for the safety model.
 *
 *   npm run sandbox            # start (builds only if dist is missing)
 *   npm run sandbox -- --build # force a fresh build first
 *   npm run sandbox -- --all   # also start group-ride, notification, analytics
 *
 * Then in other terminals:
 *   npm run sandbox:seed       # test rider + approved driver + funded wallet
 *   npm run sandbox:e2e        # scripted booking, end to end, asserts each step
 *   npm run sandbox:driver     # interactive driver actor (auto-bids)
 *   npm run sandbox:rider      # interactive rider actor (auto-accepts)
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SANDBOX, sandboxEnv } from './sandbox-env.mjs';
import { startPaystackStub } from './paystack-stub.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const forceBuild = args.includes('--build');
const startAll = args.includes('--all');

const COLORS = ['\x1b[36m', '\x1b[33m', '\x1b[35m', '\x1b[32m', '\x1b[34m', '\x1b[31m'];
const RESET = '\x1b[0m';

function run(cmd, cmdArgs, opts = {}) {
  const result = spawnSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit', ...opts });
  if (result.status !== 0) {
    console.error(`\n[sandbox] "${cmd} ${cmdArgs.join(' ')}" failed — aborting.`);
    process.exit(result.status ?? 1);
  }
}

const compose = ['compose', '-p', 'wheelers-sandbox', '-f', 'scripts/sandbox/docker-compose.sandbox.yml'];

console.log('[sandbox] starting sandbox infra (postgres :55433, redis :56380, kafka :29093)…');
run('docker', [...compose, 'up', '-d', '--wait']);

console.log('[sandbox] applying migrations…');
run('npx', ['prisma', 'migrate', 'deploy'], {
  cwd: resolve(root, 'packages/db'),
  env: { ...process.env, DATABASE_URL: SANDBOX.databaseUrl },
});

const services = ['api-gateway', 'ride-service', 'wallet-service'];
if (startAll) services.push('group-ride', 'notification-worker', 'analytics-worker');

const needsBuild = forceBuild || services.some(
  (svc) => !existsSync(resolve(root, 'apps', svc, 'dist', 'index.js')),
) || !existsSync(resolve(root, 'packages/db/dist/index.js'));
if (needsBuild) {
  console.log('[sandbox] building workspaces (first run — takes a minute)…');
  run('npm', ['run', 'build']);
}

await startPaystackStub(SANDBOX.paystackStubPort);

const children = [];
services.forEach((svc, index) => {
  const color = COLORS[index % COLORS.length];
  const tag = `${color}[${svc}]${RESET}`;
  const child = spawn('node', ['dist/index.js'], {
    cwd: resolve(root, 'apps', svc),
    env: sandboxEnv(svc),
  });
  const pipe = (stream) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) console.log(`${tag} ${line}`);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', (code) => {
    console.error(`${tag} exited with code ${code}`);
  });
  children.push(child);
});

function shutdown() {
  console.log('\n[sandbox] stopping services… (infra stays up; `docker compose -p wheelers-sandbox -f scripts/sandbox/docker-compose.sandbox.yml down` to stop it)');
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Wait for the gateway before declaring victory.
const healthUrl = `${SANDBOX.baseUrl}/health`;
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    const response = await fetch(healthUrl);
    if (response.ok) break;
  } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 1000));
  if (attempt === 59) {
    console.error('[sandbox] gateway never became healthy — check the logs above.');
  }
}

console.log(`
──────────────────────────────────────────────────────────
  Wheelers sandbox is up
  API + WebSocket : ${SANDBOX.baseUrl}  (ws: /ws)
  Database        : ${SANDBOX.databaseUrl}
  Money           : stubbed (nothing leaves this machine)

  Next:
    npm run sandbox:seed     # create test rider + driver
    npm run sandbox:e2e      # automated end-to-end booking
    npm run sandbox:driver   # act as the driver
    npm run sandbox:rider    # act as the rider

  Mobile app (in the Wheelersapp repo):
    npm run start:driver:sandbox   # dev server pointed at this backend
    npm run start:rider:sandbox
    (Settings → Developer → Mock location to pin the simulator to Lagos)
──────────────────────────────────────────────────────────`);
