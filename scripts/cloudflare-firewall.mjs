#!/usr/bin/env node
/**
 * Once app.wheelersng.com is behind Cloudflare: let web traffic (80, 443)
 * reach the server from Cloudflare's addresses only, so nobody can go round
 * Cloudflare to the server's own IP. Prints the commands; runs nothing.
 *
 *   node scripts/cloudflare-firewall.mjs
 *
 * Cloudflare publishes its ranges at cloudflare.com/ips; they change rarely.
 * Run this again every few months and re-apply if the list moved.
 * SSH (22) and the call relay (TURN) are left alone: they never go through Cloudflare.
 */
const get = async (url) => (await (await fetch(url)).text()).split('\n').map((line) => line.trim()).filter(Boolean);
const v4 = await get('https://www.cloudflare.com/ips-v4');
const v6 = await get('https://www.cloudflare.com/ips-v6');
const ranges = [...v4, ...v6].join(',');

console.log(`Cloudflare ranges today: ${v4.length} IPv4, ${v6.length} IPv6\n`);
console.log('1. See which Google Cloud rules open 80/443 to everyone now:\n');
console.log('   gcloud compute firewall-rules list --format="table(name,sourceRanges.list(),allowed[].map().firewall_rule().list())"\n');
console.log('2. Narrow those rules (usually default-allow-http and default-allow-https) to Cloudflare:\n');
for (const rule of ['default-allow-http', 'default-allow-https']) {
  console.log(`   gcloud compute firewall-rules update ${rule} --source-ranges="${ranges}"\n`);
}
console.log('3. Then set TRUST_CLOUDFLARE_IP=true in .env and run: npm run pm2:restart');
console.log('\nTo undo step 2:  gcloud compute firewall-rules update <rule> --source-ranges=0.0.0.0/0');
