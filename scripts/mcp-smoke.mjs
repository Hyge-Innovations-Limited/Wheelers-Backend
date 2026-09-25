#!/usr/bin/env node
// Verifies a deployed Wheelers MCP server from the outside — no login needed.
//   node scripts/mcp-smoke.mjs https://mcp.wheelersng.com
// Checks: health, OAuth discovery, protected-resource metadata, the 401
// challenge Claude relies on, and dynamic client registration.

const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!base) {
  console.error('usage: node scripts/mcp-smoke.mjs <public-url>');
  process.exit(2);
}

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function getJson(path) {
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { res, json, text };
}

const health = await getJson('/health').catch((e) => ({ res: null, text: e.message }));
check('GET /health', health.res?.ok === true && health.json?.status === 'ok', health.res ? `HTTP ${health.res.status}` : health.text);

const as = await getJson('/.well-known/oauth-authorization-server');
check('OAuth AS metadata', as.res?.status === 200 && !!as.json?.token_endpoint, as.json?.issuer ? `issuer ${as.json.issuer}` : `HTTP ${as.res?.status}`);
check('  issuer matches public URL', as.json?.issuer === `${base}/`, as.json?.issuer);
check('  PKCE S256 advertised', as.json?.code_challenge_methods_supported?.includes('S256'));
check('  dynamic registration advertised', !!as.json?.registration_endpoint, as.json?.registration_endpoint);

const prm = await getJson('/.well-known/oauth-protected-resource/mcp');
check('Protected resource metadata (/mcp)', prm.res?.status === 200 && prm.json?.resource === `${base}/mcp`, prm.json?.resource ?? `HTTP ${prm.res?.status}`);
const prmRoot = await getJson('/.well-known/oauth-protected-resource');
check('Protected resource metadata (root alias)', prmRoot.res?.status === 200 && prmRoot.json?.resource === `${base}/mcp`);

const unauth = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
const www = unauth.headers.get('www-authenticate') ?? '';
check('POST /mcp without token → 401', unauth.status === 401, `HTTP ${unauth.status}`);
check('  WWW-Authenticate carries resource_metadata (proxy must not strip it)', /resource_metadata=/.test(www), www || '(header missing)');

if (as.json?.registration_endpoint) {
  const reg = await fetch(as.json.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'mcp-smoke', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  });
  const body = await reg.json().catch(() => null);
  check('Dynamic client registration', reg.status === 201 && !!body?.client_id, reg.status === 201 ? `client_id ${body.client_id}` : `HTTP ${reg.status}`);
  if (body?.client_id) {
    const authz = new URL(as.json.authorization_endpoint);
    authz.search = new URLSearchParams({ response_type: 'code', client_id: body.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256', state: 'smoke' }).toString();
    const a = await fetch(authz, { redirect: 'manual' });
    check('GET /authorize → login page redirect', a.status === 302 && /\/oauth\/login\?sid=/.test(a.headers.get('location') ?? ''), `HTTP ${a.status} → ${a.headers.get('location') ?? ''}`);
    const page = await fetch(`${base}${a.headers.get('location')}`);
    const html = await page.text();
    check('Login page renders (phone first)', page.status === 200 && /name="phone"/.test(html));
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
