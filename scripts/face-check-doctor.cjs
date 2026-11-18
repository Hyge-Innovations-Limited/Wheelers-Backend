// Before a demo or after a deploy: is the driver face check ready for these drivers?
//   node scripts/run-with-env.cjs node scripts/face-check-doctor.cjs <email or phone> [--unblock]
// Says: FACE_CHECK's mode, whether face-service answers and has its models, and for each driver account with that
// email or phone: their KYC selfie, whether the library finds one face in it (and how long it took), whether their app
// said it can scan, and whether they are held back after a check that could not run. Reads only; --unblock lets a
// held-back driver take rides again.
const path = require('node:path');
const root = path.join(__dirname, '..');
const { PrismaClient } = require('@prisma/client');
const { faceCheckMode } = require(path.join(root, 'packages/config/dist/index.js'));
const { RedisClient } = require(path.join(root, 'apps/api-gateway/dist/redis/client.js'));
const { DriverKycStorage } = require(path.join(root, 'apps/api-gateway/dist/storage/driver-kyc-storage.js'));
const { faceEngine } = require(path.join(root, 'apps/api-gateway/dist/face/engine.js'));

const who = process.argv[2];
const unblock = process.argv.includes('--unblock');
if (!who) {
  console.error('Usage: node scripts/run-with-env.cjs node scripts/face-check-doctor.cjs <email or phone> [--unblock]');
  process.exit(1);
}

(async () => {
  const prisma = new PrismaClient();
  const redis = new RedisClient(process.env.REDIS_URL);
  await redis.connect();
  console.log(`FACE_CHECK            ${faceCheckMode()}`);
  const port = process.env.FACE_PORT || '3040';
  const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()).catch((e) => ({ error: e.cause?.code || e.message }));
  console.log(`face-service          ${health.ok ? `up, models ${health.loaded ? 'loaded' : 'not loaded yet (they load on the first photo)'}` : `NOT ANSWERING (${health.error})`}`);

  const r2 = process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET;
  const kyc = r2 ? new DriverKycStorage({ accountId: process.env.R2_ACCOUNT_ID, accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY, bucket: process.env.R2_BUCKET, prefix: 'drivers/kyc' }) : null;
  if (!kyc) console.log('R2                    NOT SET: no selfie can be read');

  const phone = who.replace(/[^\d+]/g, '');
  const users = await prisma.user.findMany({
    where: { OR: [{ email: who }, ...(phone.length >= 7 ? [{ phone: { endsWith: phone.slice(-10) } }] : [])], role: { in: ['DRIVER', 'BOTH'] } },
    select: { id: true, name: true, role: true, driver: { select: { id: true, kycStatus: true } } },
  });
  if (users.length === 0) console.log(`No driver account with ${who}.`);
  for (const u of users) {
    console.log(`\n${u.name ?? '(no name)'} · ${u.role}`);
    if (!u.driver) { console.log('  no driver profile'); continue; }
    console.log(`  KYC                 ${u.driver.kycStatus}`);
    const sub = await prisma.driverKycSubmission.findUnique({ where: { driverId: u.driver.id }, select: { selfieKey: true } });
    if (!sub?.selfieKey) console.log('  selfie              NONE: with FACE_CHECK=on this driver is held back at every booking');
    else if (kyc && health.ok) {
      const file = await kyc.getFile(sub.selfieKey);
      if (!file) console.log('  selfie              could not be read from R2');
      else {
        const t = Date.now();
        const faces = await faceEngine.faces(file.bytes).catch((e) => e);
        if (faces instanceof Error) console.log(`  selfie              the library failed: ${faces.message}`);
        else console.log(`  selfie              ${faces.length === 1 ? 'one face found: ready' : faces.length === 0 ? 'NO FACE FOUND: this driver cannot pass' : `${faces.length} faces (the biggest is used)`} (${Date.now() - t} ms)`);
      }
    }
    console.log(`  app can scan        ${(await redis.get(`face:capable:${u.id}`)) ? 'yes (said so at its last go online)' : 'not seen yet: update the app, then go online'}`);
    const blocked = await redis.get(`face:blocked:${u.id}`);
    if (blocked && unblock) { await redis.del(`face:blocked:${u.id}`); console.log('  held back           was, now cleared'); }
    else console.log(`  held back           ${blocked ? 'YES (the check could not run): add --unblock to clear' : 'no'}`);
    const last = await prisma.faceCheck.findFirst({ where: { driverId: u.driver.id }, orderBy: { createdAt: 'desc' }, select: { status: true, mode: true, lastReason: true, createdAt: true } });
    if (last) console.log(`  last check          ${last.status} (${last.mode}) ${last.createdAt.toISOString()} ${last.lastReason ?? ''}`);
  }
  await redis.disconnect();
  await prisma.$disconnect();
})().catch((error) => {
  console.error(error.code || error.message);
  process.exit(1);
});
