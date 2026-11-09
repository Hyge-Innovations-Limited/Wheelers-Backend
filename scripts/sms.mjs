#!/usr/bin/env node
// SMS from the server, in a word or two. It reads and edits only .env.
//
//   npm run sms                      which provider sends SMS, and whether each is ready
//   npm run sms use termii           put Termii first (Twilio stays behind it as the fallback)
//   npm run sms use twilio           put Twilio first
//   npm run sms twilio-number        point Twilio at an SMS number this account owns
//   npm run sms test 08031234567     send one real test code to that number (this costs one SMS)
//
// After "use" or "twilio-number", restart for it to take hold: npm run pm2:restart
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const [command = 'status', arg] = process.argv.slice(2);
const env = (name) => (process.env[name] ?? '').trim();

/** Set NAME=value in .env: the line is replaced where it is, or added at the end. Nothing else is touched. */
function setEnv(name, value) {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  const at = lines.findIndex((line) => new RegExp(`^\\s*${name}\\s*=`).test(line));
  if (at >= 0) lines[at] = `${name}=${value}`;
  else lines.push(`${name}=${value}`);
  writeFileSync(envPath, lines.join('\n'));
}

const twilioAuth = () => ({ authorization: `Basic ${Buffer.from(`${env('TWILIO_ACCOUNT_SID')}:${env('TWILIO_AUTH_TOKEN')}`).toString('base64')}` });
async function twilioNumbers() {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env('TWILIO_ACCOUNT_SID')}/IncomingPhoneNumbers.json?PageSize=50`, { headers: twilioAuth(), signal: AbortSignal.timeout(25_000) });
  if (!res.ok) throw new Error(res.status === 401 ? 'Twilio refused the keys in .env.' : `Twilio answered ${res.status}.`);
  return ((await res.json()).incoming_phone_numbers ?? []).filter((n) => n.capabilities?.sms).map((n) => n.phone_number);
}

async function status() {
  const first = env('SMS_PROVIDER') === 'termii' ? 'termii' : 'twilio';
  const termiiReady = Boolean(env('TERMII_API_KEY') && env('TERMII_SENDER_ID'));
  let twilioReady = false; let twilioNote = 'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set';
  if (env('TWILIO_ACCOUNT_SID') && env('TWILIO_AUTH_TOKEN')) {
    try {
      const owned = await twilioNumbers();
      const from = env('TWILIO_FROM_NUMBER');
      twilioReady = owned.includes(from);
      twilioNote = twilioReady ? `sends from ${from}`
        : owned.length ? `TWILIO_FROM_NUMBER is not an SMS number on this account. Fix: npm run sms twilio-number`
          : 'this account owns no number that can send SMS';
    } catch (error) { twilioNote = `could not ask Twilio (${error.message})`; }
  }
  console.log(`SMS goes first through: ${first.toUpperCase()}   (SMS_PROVIDER in .env${env('SMS_PROVIDER') ? '' : ', not set: twilio'})`);
  console.log(`  Twilio: ${twilioReady ? 'ready' : 'NOT ready'}   ${twilioNote}`);
  // What Termii itself says of the key: the wallet, and whether the sender name is approved.
  let termiiNote = '';
  if (termiiReady) {
    const base = (env('TERMII_BASE_URL') || 'https://v3.api.termii.com').replace(/\/+$/, '');
    const ask = async (path) => (await fetch(`${base}${path}?api_key=${encodeURIComponent(env('TERMII_API_KEY'))}`, { signal: AbortSignal.timeout(20_000) })).json();
    try {
      const wallet = await ask('/api/get-balance');
      const senders = await ask('/api/sender-id').catch(() => null);
      const list = Array.isArray(senders?.data) ? senders.data : Array.isArray(senders?.content) ? senders.content : [];
      const mine = list.find((row) => row.sender_id === env('TERMII_SENDER_ID'));
      const balance = Number(wallet.balance);
      termiiNote = Number.isFinite(balance)
        ? `   wallet ${wallet.currency ?? 'NGN'} ${balance.toLocaleString('en-NG')}${balance < 500 ? '  <- LOW: add money in the Termii dashboard or texts stop' : ''}`
        : `   Termii refused the key (${wallet.message ?? 'no reason given'}). Check TERMII_API_KEY and TERMII_BASE_URL.`;
      if (list.length && !mine) termiiNote += `\n          "${env('TERMII_SENDER_ID')}" is not a sender name on this account. Approved: ${list.filter((row) => row.status === 'active').map((row) => `"${row.sender_id}"`).join(', ') || 'none'}`;
      else if (mine && mine.status !== 'active') termiiNote += `\n          "${mine.sender_id}" is ${mine.status}, not approved yet: Termii will refuse to send as it.`;
    } catch (error) { termiiNote = `   could not ask Termii (${error.message})`; }
  }
  console.log(`  Termii: ${termiiReady ? `ready   sends as "${env('TERMII_SENDER_ID')}"` : `NOT ready   ${env('TERMII_API_KEY') ? 'TERMII_SENDER_ID is not set (the sender name Termii approved)' : 'TERMII_API_KEY is not set'}`}${termiiNote}`);
  const order = (first === 'termii' ? [['Termii', termiiReady], ['Twilio', twilioReady]] : [['Twilio', twilioReady], ['Termii', termiiReady]]).filter(([, ready]) => ready).map(([name]) => name);
  console.log(order.length ? `Every code goes by SMS (${order.join(', then ')}) and on WhatsApp from our own number, at once.` : 'No SMS provider is ready: codes go on WhatsApp only.');
  if (first === 'termii' && !termiiReady) console.log('Termii is chosen but not ready, so Twilio is carrying SMS for now.');
}

async function use() {
  if (arg !== 'termii' && arg !== 'twilio') throw new Error('Say which: npm run sms use termii   or   npm run sms use twilio');
  if (arg === 'termii' && !(env('TERMII_API_KEY') && env('TERMII_SENDER_ID'))) {
    console.log('Termii is not ready yet: put TERMII_API_KEY and TERMII_SENDER_ID (the approved sender name) in .env first.');
    console.log('I have set SMS_PROVIDER=termii anyway; until those two are there, Twilio keeps sending.');
  }
  setEnv('SMS_PROVIDER', arg);
  console.log(`SMS_PROVIDER=${arg} written to .env. Restart for it to take hold: npm run pm2:restart`);
}

async function twilioNumber() {
  const owned = await twilioNumbers();
  if (owned.length === 0) { console.log('This Twilio account owns no number that can send SMS.'); return; }
  const pick = arg && owned.includes(arg) ? arg : owned[0];
  if (arg && !owned.includes(arg)) console.log(`${arg} is not an SMS number on this account. Using ${pick}.`);
  if (owned.length > 1) console.log(`SMS numbers on this account: ${owned.join(', ')}   (to pick one: npm run sms twilio-number ${owned[1]})`);
  if (env('TWILIO_FROM_NUMBER') === pick) { console.log(`TWILIO_FROM_NUMBER is already ${pick}.`); return; }
  setEnv('TWILIO_FROM_NUMBER', pick);
  console.log(`TWILIO_FROM_NUMBER=${pick} written to .env. Restart for it to take hold: npm run pm2:restart`);
}

async function sendTest() {
  const require = createRequire(import.meta.url);
  const { deliverOtp, smsChannels } = require('../apps/api-gateway/dist/otp/channels.js');
  const { nigerianMobile } = require('../apps/api-gateway/dist/http/driver-phone.route.js');
  const phone = nigerianMobile(arg ?? '');
  if (!phone) throw new Error('Give a Nigerian mobile number: npm run sms test 08031234567');
  const config = {
    twilioAccountSid: env('TWILIO_ACCOUNT_SID'), twilioAuthToken: env('TWILIO_AUTH_TOKEN'), twilioFromNumber: env('TWILIO_FROM_NUMBER'),
    termiiApiKey: env('TERMII_API_KEY') || undefined, termiiSenderId: env('TERMII_SENDER_ID') || undefined,
    termiiBaseUrl: env('TERMII_BASE_URL') || undefined, termiiChannel: env('TERMII_CHANNEL') || undefined,
    smsProvider: env('SMS_PROVIDER') === 'termii' ? 'termii' : 'twilio',
  };
  const code = String(Math.floor(100000 + Math.random() * 900000));
  try {
    const sent = await deliverOtp(config, {
      phone, code, order: smsChannels(config),
      body: `Your Wheelers verification code is ${code}. This code expires in 30 minutes. Do not share with anyone.`,
      log: (message, meta) => console.log(' ', message, meta?.error ?? ''),
    });
    console.log(`Sent to ${phone} through ${sent.channel}. The code in it is ${code}. Check the phone: "sent" is the provider taking it, not the phone receiving it.`);
  } catch (error) {
    console.log(`Not sent. ${error.message}`);
  }
}

const run = { status, use, 'twilio-number': twilioNumber, test: sendTest }[command];
if (!run) console.log('Use: npm run sms [status | use termii|twilio | twilio-number [NUMBER] | test PHONE]');
else await run().catch((error) => { console.error(error.message); process.exitCode = 1; });
