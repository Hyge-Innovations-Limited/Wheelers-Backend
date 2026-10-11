#!/usr/bin/env node
// Is the Twilio account in .env one that can send codes? Read-only: it asks
// Twilio about the account and sends nothing. No secret is printed.
//
//   node scripts/run-with-env.cjs node scripts/check-twilio.mjs
//
// It answers: is this a trial or a paid account, is it active, what is the
// balance, does the "from" number belong to it and can it send SMS, and how
// did the last messages to Nigeria go.
const sid = (process.env.TWILIO_ACCOUNT_SID ?? '').trim();
const token = (process.env.TWILIO_AUTH_TOKEN ?? '').trim();
const from = (process.env.TWILIO_FROM_NUMBER ?? '').trim();
const whatsapp = (process.env.TWILIO_WHATSAPP_NUMBER ?? '').trim();

if (!sid || !token) {
  console.log('TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN is not set in .env: Twilio is not configured here.');
  process.exit(0);
}

const base = `https://api.twilio.com/2010-04-01/Accounts/${sid}`;
const auth = { authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` };
async function ask(path) {
  const res = await fetch(`${base}${path}`, { headers: auth });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

const account = await ask('.json');
if (!account.ok) {
  console.log(account.status === 401
    ? 'Twilio refused these keys (401). The account SID and auth token in .env do not match, or the token was rotated.'
    : `Twilio answered ${account.status}: ${account.body.message ?? 'no reason given'}`);
  process.exit(0);
}

const a = account.body;
console.log(`Account:  ${a.friendly_name}`);
console.log(`Type:     ${a.type}${a.type === 'Trial' ? '   <- a TRIAL account: it only sends to numbers verified in the Twilio console, with a "Sent from your Twilio trial account" prefix' : '   (paid)'}`);
console.log(`Status:   ${a.status}${a.status === 'active' ? '' : '   <- not active: nothing will send'}`);

const balance = await ask('/Balance.json');
if (balance.ok) {
  const amount = Number(balance.body.balance);
  console.log(`Balance:  ${amount.toFixed(2)} ${balance.body.currency}${amount <= 0 ? '   <- empty: top up before relying on it' : amount < 5 ? '   <- low' : ''}`);
} else {
  console.log(`Balance:  could not be read (${balance.status})`);
}

for (const [label, number] of [['SMS from', from], ['WhatsApp from', whatsapp.replace(/^whatsapp:/, '')]]) {
  if (!number) { console.log(`${label}: not set`); continue; }
  const owned = await ask(`/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`);
  const row = owned.ok ? owned.body.incoming_phone_numbers?.[0] : null;
  const shown = `${number.slice(0, 5)}…${number.slice(-2)}`;
  if (!row) console.log(`${label}: ${shown}   <- NOT a number on this account${label.startsWith('WhatsApp') ? ' (normal for the shared WhatsApp sandbox number)' : ': SMS from it will be refused'}`);
  else console.log(`${label}: ${shown}   on this account, SMS ${row.capabilities?.sms ? 'yes' : 'NO'}, voice ${row.capabilities?.voice ? 'yes' : 'no'}`);
}

// How the last messages went, and to Nigeria in particular.
const recent = await ask('/Messages.json?PageSize=100');
if (recent.ok) {
  const messages = recent.body.messages ?? [];
  const toNigeria = messages.filter((m) => String(m.to).replace('whatsapp:', '').startsWith('+234'));
  const tally = (list) => list.reduce((t, m) => ({ ...t, [m.status]: (t[m.status] ?? 0) + 1 }), {});
  console.log(`\nLast ${messages.length} messages: ${JSON.stringify(tally(messages))}`);
  console.log(`To Nigeria (+234): ${toNigeria.length}  ${JSON.stringify(tally(toNigeria))}`);
  const sms = toNigeria.filter((m) => !String(m.to).startsWith('whatsapp:'));
  const wa = toNigeria.filter((m) => String(m.to).startsWith('whatsapp:'));
  console.log(`  by SMS: ${sms.length} ${JSON.stringify(tally(sms))}   by WhatsApp: ${wa.length} ${JSON.stringify(tally(wa))}`);
  const errors = {};
  for (const m of messages) if (m.error_code) errors[m.error_code] = (errors[m.error_code] ?? 0) + 1;
  const meaning = { 21408: 'sending to that country is switched off for this account', 21608: 'trial account: the number is not verified', 21610: 'the person replied STOP', 21211: 'not a valid phone number', 30003: 'phone unreachable', 30004: 'message blocked', 30005: 'unknown number', 30006: 'landline or unreachable carrier', 30007: 'filtered by the carrier', 30008: 'unknown delivery error', 63016: 'WhatsApp: outside the 24-hour window and no template', 63007: 'WhatsApp sender not set up for this account' };
  if (Object.keys(errors).length) {
    console.log('Errors among them:');
    for (const [code, n] of Object.entries(errors)) console.log(`  ${code} x${n}  ${meaning[code] ?? ''}`);
  }
  const last = messages[0];
  if (last) console.log(`Most recent: ${new Date(last.date_created).toISOString().slice(0, 16).replace('T', ' ')} UTC, ${last.status}${last.price ? `, cost ${Math.abs(Number(last.price))} ${last.price_unit}` : ''}`);
  const priced = sms.filter((m) => m.price);
  if (priced.length) console.log(`An SMS to Nigeria has cost about ${(priced.reduce((s, m) => s + Math.abs(Number(m.price)), 0) / priced.length).toFixed(4)} ${priced[0].price_unit} each.`);
} else {
  console.log(`\nRecent messages could not be read (${recent.status}).`);
}
