// The rider's transcript (4 Nov 2026): every message the bot sends, word for word, from the one wrapper all
// outgoing calls pass through; every message and tap the rider sends; every step in a form. Never a sign-in code.
//
//   node --test test/whatsapp-transcript.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { describeOutbound, describeInbound, describeFormStep } = require('../apps/api-gateway/dist/whatsapp/transcript.js');
const { meterOutboundCalls } = require('../apps/api-gateway/dist/usage/service-usage.js');

const msg = (extra) => JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: '+2348012345678', ...extra });

test('what the bot sent, as the rider saw it', () => {
  assert.deepEqual(describeOutbound(msg({ type: 'text', text: { body: 'Hi Ada' } })), { to: '2348012345678', content: 'Hi Ada', kind: 'text' });
  assert.deepEqual(describeOutbound(msg({ type: 'interactive', interactive: { type: 'button', body: { text: 'Accept ₦3,300?' }, action: { buttons: [{ type: 'reply', reply: { id: 'a', title: 'Accept' } }, { type: 'reply', reply: { id: 'b', title: 'Change price' } }] } } })).content, 'Accept ₦3,300?\n[Accept] [Change price]');
  assert.deepEqual(describeOutbound(msg({ type: 'interactive', interactive: { type: 'flow', body: { text: '*Welcome to Wheelers*' }, action: { name: 'flow', parameters: { flow_cta: 'Get started' } } } })), { to: '2348012345678', content: '*Welcome to Wheelers*\n[Get started]', kind: 'form' });
  assert.equal(describeOutbound(msg({ type: 'interactive', interactive: { type: 'cta_url', header: { type: 'image', image: { link: 'x' } }, body: { text: 'Ade is here.' }, action: { name: 'cta_url', parameters: { display_text: 'Chat or call', url: 'u' } } } })).content, '[Photo]\nAde is here.\n[Chat or call]');
  assert.equal(describeOutbound(msg({ type: 'interactive', interactive: { type: 'list', body: { text: 'Pick one' }, action: { button: 'Quick Actions', sections: [] } } })).kind, 'list');
  assert.deepEqual(describeOutbound(msg({ type: 'reaction', reaction: { message_id: 'w', emoji: '🚗' } })), { to: '2348012345678', content: '🚗', kind: 'reaction' });
  assert.equal(describeOutbound(msg({ type: 'image', image: { link: 'x', caption: 'Your car' } })).content, '[Photo] Your car');
});

test('never kept: read receipts, typing, a template\'s values (a sign-in code); bad input is ignored', () => {
  assert.equal(describeOutbound(JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: 'w', typing_indicator: { type: 'text' } })), null);
  const otp = describeOutbound(msg({ type: 'template', template: { name: 'login_code', components: [{ type: 'body', parameters: [{ type: 'text', text: '482913' }] }] } }));
  assert.equal(otp.content, '[Template: login_code]');
  assert.ok(!otp.content.includes('482913'));
  assert.equal(describeOutbound('not json'), null);
  assert.equal(describeOutbound(JSON.stringify({ to: '1', type: 'text', text: { body: 'x' } })), null, 'not a WhatsApp message');
});

test('what the rider sent: words, a tap, a place, a photo, a finished form', () => {
  assert.deepEqual(describeInbound({ messageBody: 'from Yaba to Ikeja', isLocation: false }), { content: 'from Yaba to Ikeja', kind: 'text' });
  assert.deepEqual(describeInbound({ messageBody: 'Accept', isLocation: false, replyId: 'offer:3300:k' }), { content: 'Accept', kind: 'tap' });
  assert.deepEqual(describeInbound({ messageBody: '', isLocation: true, locationLat: 6.5, locationLng: 3.37 }), { content: '[Location] 6.50000, 3.37000', kind: 'location' });
  assert.deepEqual(describeInbound({ messageBody: '', isLocation: false, isImage: true }), { content: '[Photo]', kind: 'image' });
  assert.deepEqual(describeInbound({ messageBody: '', isLocation: false, flowCompleted: { flow: 'welcome', rearm: false } }), { content: '[Finished the welcome form]', kind: 'form' });
  assert.equal(describeInbound({ messageBody: '  ', isLocation: false }), null);
});

test('a step in a form: which form, which screen, what was chosen; tokens never shown', () => {
  assert.equal(describeFormStep('menu', { action: 'INIT' }), '[Quick Actions form] opened');
  assert.equal(describeFormStep('welcome', { action: 'data_exchange', screen: 'EMAIL', data: { action: 'welcome_email', email: 'ada@x.co', marketing: true, flow_token: 'secret' } }), '[Welcome form] EMAIL · welcome_email (email: ada@x.co, marketing: true)');
  assert.equal(describeFormStep('bids', { action: 'BACK', screen: 'OFFERS' }), '[Offers form] OFFERS · back');
  assert.equal(describeFormStep('menu', { action: 'ping' }), null);
});

test('the wrapper hands every WhatsApp message Meta took to the transcript, and nothing else', async () => {
  const realFetch = globalThis.fetch;
  try {
    const seen = [];
    let ok = true;
    globalThis.fetch = async () => ({ ok, status: ok ? 200 : 400 });
    const redis = { send: async () => null };
    meterOutboundCalls(redis, { onWhatsappSent: (body) => seen.push(body) });
    const body = msg({ type: 'text', text: { body: 'Hi' } });
    await fetch('https://graph.facebook.com/v21.0/123/messages', { method: 'POST', body });
    await fetch('https://graph.facebook.com/v21.0/123?fields=display_phone_number');
    await fetch('https://graph.facebook.com/v21.0/123/media', { method: 'POST', body: 'x' });
    ok = false;
    await fetch('https://graph.facebook.com/v21.0/123/messages', { method: 'POST', body });
    await fetch('https://api.paystack.co/transfer', { method: 'POST', body });
    assert.deepEqual(seen, [body], 'only the one Meta took');
  } finally {
    globalThis.fetch = realFetch.__wheelersOriginal ?? realFetch;
  }
});
