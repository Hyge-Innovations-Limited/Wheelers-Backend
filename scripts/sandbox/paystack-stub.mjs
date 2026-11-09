/**
 * Stand-in for the Paystack API. Answers the handful of endpoints the backend
 * uses with Paystack-shaped bodies, moves no money, and logs every call so a
 * test run shows exactly which money operations were attempted.
 */
import http from 'node:http';

const accounts = new Map(); // customer → account number
const transfers = new Map(); // reference → transfer

const ok = (data, message = 'ok') => ({ status: true, message, data });

function route(method, url, body) {
  const path = url.split('?')[0];

  if (method === 'POST' && path === '/customer') {
    return ok({ customer_code: `CUS_${Buffer.from(body.email).toString('hex').slice(0, 14)}`, email: body.email, first_name: body.first_name, last_name: body.last_name, phone: body.phone ?? null });
  }
  if (method === 'PUT' && path.startsWith('/customer/')) {
    return ok({ customer_code: decodeURIComponent(path.split('/')[2]), email: '', ...body });
  }
  if (method === 'GET' && path.startsWith('/customer/')) {
    const id = decodeURIComponent(path.split('/')[2]);
    const number = accounts.get(id);
    return ok({
      customer_code: id.startsWith('CUS_') ? id : `CUS_${Buffer.from(id).toString('hex').slice(0, 14)}`,
      email: id.includes('@') ? id : '',
      dedicated_account: number ? { id: number, account_number: number, account_name: 'WHEELERS SANDBOX', bank: { name: 'Sandbox Bank', slug: 'test-bank' }, currency: 'NGN', active: true } : null,
    });
  }
  if (method === 'POST' && path === '/dedicated_account') {
    const number = accounts.get(body.customer) ?? String(9_000_000_000 + accounts.size);
    accounts.set(body.customer, number);
    return ok({ id: number, account_number: number, account_name: 'WHEELERS SANDBOX', bank: { name: 'Sandbox Bank', slug: 'test-bank' }, currency: 'NGN', active: true, assigned: true });
  }
  if (method === 'GET' && path === '/bank') {
    return ok([
      { name: 'Sandbox Bank', code: '999', active: true, supports_transfer: true },
      { name: 'Guaranty Trust Bank', code: '058', active: true, supports_transfer: true },
      { name: 'OPay Digital Services Limited (OPay)', code: '999992', active: true, supports_transfer: true },
    ]);
  }
  if (method === 'GET' && path === '/bank/resolve') {
    const q = new URLSearchParams(url.split('?')[1] ?? '');
    return ok({ account_number: q.get('account_number'), account_name: 'SANDBOX ACCOUNT HOLDER' });
  }
  if (method === 'GET' && path === '/balance') {
    return ok([{ currency: 'NGN', balance: 100_000_000 }]);
  }
  if (method === 'POST' && path === '/transferrecipient') {
    return ok({ recipient_code: `RCP_${body.bank_code}_${body.account_number}` });
  }
  if (method === 'POST' && path === '/transfer') {
    if (transfers.has(body.reference)) {
      return { status: false, message: 'Reference already exists on a transfer', code: 'duplicate_transfer_reference', http: 400 };
    }
    const transfer = { transfer_code: `TRF_${transfers.size + 1}`, reference: body.reference, amount: body.amount, status: 'success', fee_charged: 1000 };
    transfers.set(body.reference, transfer);
    return ok(transfer);
  }
  if (method === 'GET' && path.startsWith('/transfer/verify/')) {
    const transfer = transfers.get(decodeURIComponent(path.split('/')[3]));
    return transfer ? ok(transfer) : { status: false, message: 'Transfer not found', code: 'not_found', http: 404 };
  }
  if (method === 'GET' && path.startsWith('/transaction/verify/')) {
    return { status: false, message: 'Transaction reference not found', code: 'transaction_not_found', http: 404 };
  }
  return { status: false, message: `paystack-stub: no handler for ${method} ${path}`, http: 404 };
}

export function startPaystackStub(port) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      console.log(`[paystack-stub] ${req.method} ${req.url}${raw ? ` ${raw.slice(0, 200)}` : ''}`);
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { /* keep {} */ }
      const { http: status = 200, ...payload } = route(req.method ?? 'GET', req.url ?? '/', body);
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    console.log(`[paystack-stub] listening on 127.0.0.1:${port}`);
    resolve(server);
  }));
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly) {
  const { SANDBOX } = await import('./sandbox-env.mjs');
  await startPaystackStub(SANDBOX.paystackStubPort);
}
