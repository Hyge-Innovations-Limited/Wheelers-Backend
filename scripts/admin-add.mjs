#!/usr/bin/env node
/**
 * A dashboard login for someone on the team. The password is made here,
 * shown once, and only its hash is kept: pass it to them privately, and they
 * sign in at wheelersng.com/admin/login.
 *
 *   npm run admin:add -- tife "Tife" support     the support desk: inbox, activity, people, trips; no money
 *   npm run admin:add -- ada "Ada" staff         the dashboard, without the owners' pages
 *   npm run admin:add -- bola "Bola" owner
 *
 * Changing someone's role or switching them off is done on the Team page.
 */
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { adminClient, prisma } = require('@wheleers/db');
const { hashPassword } = require('../apps/api-gateway/dist/auth/local.js');

const ROLES = { owner: 'OWNER', staff: 'STAFF', support: 'SUPPORT' };

async function main() {
  const [rawUsername, name, roleWord = 'support'] = process.argv.slice(2);
  const username = (rawUsername ?? '').trim().toLowerCase();
  const role = ROLES[roleWord.toLowerCase()];
  if (!username || !name || !role) throw new Error('Use: npm run admin:add -- USERNAME "Their name" support|staff|owner');
  if (username.length < 3 || !/^[a-z][a-z0-9_]*$/.test(username)) throw new Error('The username is 3 or more lowercase letters or digits, starting with a letter.');
  if (await adminClient.findByUsername(username)) throw new Error(`${username} already has a login. Change their role on the Team page instead.`);

  // 16 letters and digits, easy to read out: no 0/O or 1/l/I.
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const password = [...randomBytes(16)].map((b) => alphabet[b % alphabet.length]).join('');
  const admin = await adminClient.create({ username, passwordHash: await hashPassword(password), name: name.trim(), role });

  console.log(`Login made for ${admin.name} (${roleWord.toLowerCase()}).`);
  console.log(`  sign in at  https://wheelersng.com/admin/login`);
  console.log(`  username    ${admin.username}`);
  console.log(`  password    ${password}`);
  console.log('The password is not kept anywhere: copy it now and give it to them privately.');
}

main()
  .catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
