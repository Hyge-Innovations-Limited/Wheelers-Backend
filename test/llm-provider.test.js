// Which model answers the bot, and what happens when it cannot. No network:
// fetch is stubbed, so this is about OUR behaviour, not the providers'.
//
//   npm -w @wheleers/api-gateway run build && node --test test/llm-provider.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { GeminiClient, toGeminiRequest } = require('../apps/api-gateway/dist/LLM/gemini.client.js');
const { createLlm, describeLlm } = require('../apps/api-gateway/dist/LLM/llm.js');
const { WHATSAPP_SYSTEM_PROMPT } = require('../apps/api-gateway/dist/LLM/whatsapp-system-prompt.js');

const realFetch = global.fetch;
const realWarn = console.warn;
const cfg = { groqApiKey: 'groq-key', groqModel: 'openai/gpt-oss-120b', timeoutMs: 2000 };

const geminiSays = (text) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) });
const groqSays = (text) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }] }) });
const geminiFails = (status, retryDelay) => ({ ok: false, status, json: async () => ({ error: { message: 'nope', details: retryDelay ? [{ retryDelay }] : [] } }) });

function world(handlers) {
  const calls = [];
  global.fetch = async (url, init) => {
    const provider = String(url).includes('generativelanguage') ? 'gemini' : 'groq';
    calls.push({ provider, url: String(url), init });
    return handlers[provider](calls.filter((c) => c.provider === provider).length);
  };
  return calls;
}

test.beforeEach(() => { console.warn = () => {}; });
test.afterEach(() => { global.fetch = realFetch; console.warn = realWarn; delete process.env.GEMINI_API_KEY; });

test('a chat history becomes what Gemini expects: one instruction, "model" turns, neighbours merged', () => {
  const { system, contents } = toGeminiRequest([
    { role: 'system', content: 'You are Wheelers.' },
    { role: 'system', content: 'What we know about this rider: home is Yaba.' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'Hi Timi!' },
    { role: 'user', content: 'take me home' },
    { role: 'user', content: 'now please' },
    { role: 'assistant', content: '   ' },
  ]);
  assert.equal(system, 'You are Wheelers.\n\nWhat we know about this rider: home is Yaba.');
  assert.deepEqual(contents.map((c) => [c.role, c.parts.map((p) => p.text)]), [
    ['user', ['hi']], ['model', ['Hi Timi!']], ['user', ['take me home', 'now please']],
  ]);
});

test('the key travels in a header, never in the URL', async () => {
  const calls = world({ gemini: () => geminiSays('{"intent":"cancel"}') });
  const gemini = new GeminiClient({ apiKey: 'secret-key', model: 'gemini-3.5-flash-lite', timeoutMs: 2000 });
  assert.deepEqual(await gemini.completeJson([{ role: 'user', content: 'cancel' }]), { intent: 'cancel' });
  assert.equal(calls[0].url.includes('secret-key'), false);
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'secret-key');
  assert.equal(JSON.parse(calls[0].init.body).generationConfig.responseMimeType, 'application/json');
});

test('without GEMINI_API_KEY nothing changes: Groq answers, Gemini is never called', async () => {
  const calls = world({ groq: () => groqSays('{"intent":"deposit"}') });
  const llm = createLlm(cfg, 'intent');
  assert.deepEqual(await llm.completeJson([{ role: 'user', content: 'top up' }]), { intent: 'deposit' });
  assert.deepEqual(calls.map((c) => c.provider), ['groq']);
  assert.match(describeLlm(cfg), /^Groq only/);
});

test('with the key, Gemini answers and Groq is left alone — small model for intent, larger for the rest', async () => {
  process.env.GEMINI_API_KEY = 'g-key';
  const calls = world({ gemini: () => geminiSays('{"intent":"cancel"}') });
  await createLlm(cfg, 'intent').completeJson([{ role: 'user', content: 'x' }]);
  await createLlm(cfg, 'main').completeJson([{ role: 'user', content: 'x' }]);
  assert.deepEqual(calls.map((c) => c.provider), ['gemini', 'gemini']);
  assert.match(calls[0].url, /gemini-3\.5-flash-lite:generateContent$/);
  assert.match(calls[1].url, /gemini-3\.8-flash:generateContent$/);
  assert.match(describeLlm(cfg), /^Gemini .*Groq backup/);
  assert.equal(describeLlm(cfg).includes('g-key'), false, 'the boot log never carries a key');
});

test('Gemini down, refused, or silent → Groq answers the same question', async () => {
  process.env.GEMINI_API_KEY = 'g-key';
  for (const failure of [() => geminiFails(503), () => geminiFails(429, '30s'), () => geminiSays(''), () => { throw new Error('network'); }]) {
    const calls = world({ gemini: failure, groq: () => groqSays('{"intent":"withdraw"}') });
    assert.deepEqual(await createLlm(cfg, 'intent').completeJson([{ role: 'user', content: 'cash out' }]), { intent: 'withdraw' });
    assert.equal(calls.at(-1).provider, 'groq');
  }
});

test('a short rate-limit wait is simply waited out; Groq is not bothered', async () => {
  process.env.GEMINI_API_KEY = 'g-key';
  const calls = world({ gemini: (n) => (n === 1 ? geminiFails(429, '0.05s') : geminiSays('{"intent":"cancel"}')), groq: () => groqSays('{}') });
  assert.deepEqual(await createLlm(cfg, 'intent').completeJson([{ role: 'user', content: 'x' }]), { intent: 'cancel' });
  assert.deepEqual(calls.map((c) => c.provider), ['gemini', 'gemini']);
});

test('with no backup configured, a Gemini failure surfaces so the caller\'s own fallback runs', async () => {
  process.env.GEMINI_API_KEY = 'g-key';
  world({ gemini: () => geminiFails(500) });
  await assert.rejects(createLlm({ ...cfg, groqApiKey: undefined }, 'intent').completeJson([{ role: 'user', content: 'x' }]), /nope/);
});

test('photos go to Gemini inline — no separate vision model', async () => {
  process.env.GEMINI_API_KEY = 'g-key';
  const calls = world({ gemini: () => geminiSays('{"isRealPerson":true}') });
  const verdict = await createLlm(cfg, 'main').completeVisionJson('Is this a selfie?', Buffer.from('jpegbytes'), 'image/jpeg');
  assert.deepEqual(verdict, { isRealPerson: true });
  const parts = JSON.parse(calls[0].init.body).contents[0].parts;
  assert.deepEqual(parts[1].inlineData, { mimeType: 'image/jpeg', data: Buffer.from('jpegbytes').toString('base64') });
});

test('the bot knows who it is, whoever is answering', () => {
  assert.match(WHATSAPP_SYSTEM_PROMPT, /Your name is \*Wheelers\*/);
  assert.match(WHATSAPP_SYSTEM_PROMPT, /created by \*Hyge Innovations\*/);
  assert.match(WHATSAPP_SYSTEM_PROMPT, /Never say you are Gemini, Google, ChatGPT/);
  assert.doesNotMatch(WHATSAPP_SYSTEM_PROMPT, /Wheelers Bot/);
});
