// Withdraw: every Nigerian bank is listed (Paystack, page by page), the popular ones first and then
// every bank A–Z under its letter, each with its logo or its initials.
//
//   node --test test/bank-list.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PaymentsClient } = require('../packages/payments/dist/index.js');

test('Paystack: every page of banks, each bank once', async () => {
  const pages = {
    '': { status: true, data: [{ name: 'Access Bank', code: '044' }, { name: 'Zenith Bank', code: '057' }], meta: { next: 'cursor2' } },
    cursor2: { status: true, data: [{ name: 'Moniepoint MFB', code: '50515' }, { name: 'Zenith Bank', code: '057' }, { name: 'Closed MFB', code: '999', active: false }], meta: { next: null } },
  };
  const asked = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const u = new URL(url);
    asked.push(u.searchParams.toString());
    const body = pages[u.searchParams.get('next') ?? ''];
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  try {
    const client = new PaymentsClient({ secretKey: 'sk_test_x', maxRetries: 0 });
    const banks = await client.listBanks();
    assert.deepEqual(banks.map((b) => b.code), ['044', '057', '50515']);
    assert.equal(asked.length, 2);
    assert.match(asked[0], /use_cursor=true/);
    assert.match(asked[1], /next=cursor2/);
  } finally {
    global.fetch = realFetch;
  }
});

const widget = path.join(__dirname, '..', 'apps', 'api-gateway', 'widget');
function loadBanks() {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(widget, 'shared', 'banks.js'), 'utf8'), { window });
  // Plain copies of what the page's code returns (its arrays belong to another context).
  const plain = (fn) => (...args) => JSON.parse(JSON.stringify(fn(...args)));
  const B = window.WheelersBanks;
  return { ...B, sections: plain(B.sections), search: plain(B.search) };
}
const list = [
  { code: '058', name: 'Guaranty Trust Bank' }, { code: '044', name: 'Access Bank' }, { code: '999992', name: 'OPay Digital Services Limited (OPay)' },
  { code: '50515', name: 'Moniepoint MFB' }, { code: '090', name: '9 Payment Service Bank' }, { code: '232', name: 'Sterling Bank' },
  { code: '12345', name: 'access microfinance' },
];

test('withdraw bank list: popular first, then A–Z under letters, digits under #', () => {
  const B = loadBanks();
  const sections = B.sections(list);
  assert.deepEqual(sections.map((s) => s.title), ['Popular', '#', 'A', 'G', 'M', 'O', 'S']);
  assert.deepEqual(sections[0].banks.map((b) => b.code), ['999992', '50515', '058', '044']);
  assert.deepEqual(sections[2].banks.map((b) => b.name), ['Access Bank', 'access microfinance']);
  // Every bank is in the A–Z part, popular ones included.
  assert.equal(sections.slice(1).reduce((n, s) => n + s.banks.length, 0), list.length);
});

test('search: every match, names starting with it first', () => {
  const B = loadBanks();
  assert.deepEqual(B.search(list, 'acc').map((b) => b.code), ['044', '12345']);
  assert.deepEqual(B.search(list, 'bank').map((b) => b.code), ['090', '044', '058', '232']);
  assert.deepEqual(B.search(list, 'zzz'), []);
});

test('logos: a file for every code it names; initials for the rest', () => {
  const B = loadBanks();
  assert.equal(B.logoUrl('058'), '../shared/banks/058.png');
  assert.ok(fs.existsSync(path.join(widget, 'shared', 'banks', '058.png')));
  assert.equal(B.logoUrl('999992'), null);
  assert.equal(B.initials('OPay Digital Services Limited (OPay)'), 'OD');
  assert.equal(B.initials('Guaranty Trust Bank'), 'GT');
  assert.equal(B.initials('Kuda Bank'), 'KU');
  const files = fs.readdirSync(path.join(widget, 'shared', 'banks')).filter((f) => f.endsWith('.png'));
  for (const f of files) assert.ok(B.logoUrl(f.replace(/\.png$/, '')), `${f} is listed`);
});
