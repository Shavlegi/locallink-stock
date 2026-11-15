// Harness tests for the locallink-stock Worker (plain node, no deploy).
// D1Mock over node:sqlite; the Worker module is imported directly.
// Run: node test/stock-harness.mjs
// All secrets here are TEST-ONLY dummies — never use them in production.
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';

const BASE = 'https://locallink-stock.shao42ia.workers.dev';
const TEST_PASSWORD = 'harness-test-password-do-not-use-in-production';
const SESSION_SECRET = 'harness-test-secret-do-not-use-in-production';
const SLUGS = ['sticker-black', 'sticker-white', 'nfc-card', 'nfc-stand', 'photo-stand'];

class D1Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.params = []; }
  bind(...params) { this.params = params; return this; }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
  }
  async first() {
    const row = this.db.prepare(this.sql).get(...this.params);
    return row === undefined ? null : row;
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.params) };
  }
}

class D1Mock {
  constructor(db) { this.db = db; }
  prepare(sql) { return new D1Statement(this.db, sql); }
  async batch(statements) {
    const out = [];
    for (const s of statements) out.push(await s.run());
    return out;
  }
}

async function makeHash(password) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  const b64 = (bytes) => Buffer.from(bytes).toString('base64');
  return 'pbkdf2$100000$' + b64(salt) + '$' + b64(new Uint8Array(bits));
}

const db = new DatabaseSync(':memory:');
const env = {
  STOCK_DB: new D1Mock(db),
  SESSION_SECRET,
  RATE_LIMIT_SALT: 'harness-salt',
  ADMIN_PASSWORD_HASH: await makeHash(TEST_PASSWORD),
};

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; failures.push(name); console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

async function req(method, path, { headers = {}, body = null, ip = '10.0.0.1' } = {}) {
  const init = { method, headers: { 'CF-Connecting-IP': ip, ...headers } };
  if (body !== null) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return worker.fetch(new Request(BASE + path, init), env);
}

// Same as req() but with an explicit full URL (for http/https redirect tests).
async function reqFull(method, url, { headers = {}, body = null, ip = '10.0.0.1' } = {}) {
  const init = { method, headers: { 'CF-Connecting-IP': ip, ...headers } };
  if (body !== null) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return worker.fetch(new Request(url, init), env);
}

function cookieFrom(res) {
  const setCookie = res.headers.get('set-cookie') || '';
  const m = setCookie.match(/stock_session=[^;]+/);
  return m ? m[0] : null;
}

// ---------- https redirect ----------
{
  const r1 = await reqFull('GET', 'http://locallink-stock.shao42ia.workers.dev/');
  check('http root redirects 301 to https', r1.status === 301 && r1.headers.get('location') === 'https://locallink-stock.shao42ia.workers.dev/', 'status=' + r1.status);
  const r2 = await reqFull('GET', 'http://locallink-stock.shao42ia.workers.dev/api/stock?x=1&y=2');
  check('http redirect preserves path+query', r2.status === 301 && r2.headers.get('location') === 'https://locallink-stock.shao42ia.workers.dev/api/stock?x=1&y=2', r2.headers.get('location'));
  const r3 = await reqFull('GET', 'https://locallink-stock.shao42ia.workers.dev/');
  check('https passes through (no redirect)', r3.status === 200, 'status=' + r3.status);
  const r4 = await reqFull('GET', 'http://localhost:8787/');
  check('http localhost exempt from redirect', r4.status === 200, 'status=' + r4.status);
  const r5 = await reqFull('GET', 'http://127.0.0.1:8787/api/stock');
  check('http 127.0.0.1 exempt from redirect', r5.status === 200, 'status=' + r5.status);
}

// ---------- public status + admin page ----------
{
  const res = await req('GET', '/');
  const data = await res.json();
  check('GET / returns ok status', res.status === 200 && data.ok === true && data.service === 'locallink-stock');
  const page = await req('GET', '/admin');
  const html = await page.text();
  check('GET /admin returns HTML page', page.status === 200 && (page.headers.get('content-type') || '').includes('text/html'));
  check('admin page contains all 5 slugs', SLUGS.every((s) => html.includes('data-row="' + s + '"')));
  check('admin page is Georgian', html.includes('მარაგის მართვა') && html.includes('შენახვა'));
  const nf = await req('GET', '/nope');
  check('unknown route 404', nf.status === 404);
}

// ---------- public stock API ----------
{
  const res = await req('GET', '/api/stock', { ip: '10.0.0.2' });
  const data = await res.json();
  check('GET /api/stock 200', res.status === 200);
  check('GET /api/stock has all 5 slugs', SLUGS.every((s) => data[s] && 'stock' in data[s] && 'incoming' in data[s]));
  check('fresh DB: all values null', SLUGS.every((s) => data[s].stock === null && data[s].incoming === null));
  check('no-store cache header', (res.headers.get('cache-control') || '') === 'no-store');

  const cors = await req('GET', '/api/stock', { ip: '10.0.0.3', headers: { Origin: 'https://locallink.store' } });
  check('CORS allows locallink.store', cors.headers.get('access-control-allow-origin') === 'https://locallink.store');
  const corsHttp = await req('GET', '/api/stock', { ip: '10.0.0.3', headers: { Origin: 'http://locallink.store' } });
  check('CORS allows http locallink.store', corsHttp.headers.get('access-control-allow-origin') === 'http://locallink.store');
  const corsGh = await req('GET', '/api/stock', { ip: '10.0.0.3', headers: { Origin: 'https://shavlegi.github.io' } });
  check('CORS allows github.io', corsGh.headers.get('access-control-allow-origin') === 'https://shavlegi.github.io');
  const corsEvil = await req('GET', '/api/stock', { ip: '10.0.0.3', headers: { Origin: 'https://evil.example' } });
  check('CORS denies other origins', corsEvil.headers.get('access-control-allow-origin') === null);
  const pre = await req('OPTIONS', '/api/stock', { ip: '10.0.0.3', headers: { Origin: 'https://locallink.store' } });
  check('OPTIONS preflight 204 with methods', pre.status === 204 && (pre.headers.get('access-control-allow-methods') || '').includes('GET'));
}

// ---------- auth: login / session / logout ----------
let cookie = null;
{
  const bad = await req('POST', '/api/admin/login', { ip: '10.0.0.4', headers: { 'Content-Type': 'application/json' }, body: { password: 'wrong-password' } });
  check('login rejects wrong password', bad.status === 401);
  const empty = await req('POST', '/api/admin/login', { ip: '10.0.0.4', headers: { 'Content-Type': 'application/json' }, body: {} });
  check('login rejects missing password', empty.status === 401);

  const noAuthGet = await req('GET', '/api/admin/stock', { ip: '10.0.0.5' });
  check('admin stock GET rejects unauthenticated', noAuthGet.status === 401);
  const noAuthPost = await req('POST', '/api/admin/stock', { ip: '10.0.0.5', headers: { 'Content-Type': 'application/json' }, body: { slug: 'nfc-stand', stock: 5, incoming: null } });
  check('admin stock POST rejects unauthenticated', noAuthPost.status === 401);
  const noAuthSession = await req('GET', '/api/admin/session', { ip: '10.0.0.5' });
  check('session check rejects unauthenticated', noAuthSession.status === 401);

  const good = await req('POST', '/api/admin/login', { ip: '10.0.0.6', headers: { 'Content-Type': 'application/json' }, body: { password: TEST_PASSWORD } });
  cookie = cookieFrom(good);
  check('login accepts correct password', good.status === 200 && cookie !== null);
  check('session cookie is HttpOnly + Secure + SameSite=Lax', /HttpOnly/.test(good.headers.get('set-cookie') || '') && /Secure/.test(good.headers.get('set-cookie') || '') && /SameSite=Lax/.test(good.headers.get('set-cookie') || ''));

  const sess = await req('GET', '/api/admin/session', { ip: '10.0.0.6', headers: { Cookie: cookie } });
  check('session check accepts valid cookie', sess.status === 200);
  const badCookie = await req('GET', '/api/admin/session', { ip: '10.0.0.6', headers: { Cookie: 'stock_session=' + '0'.repeat(64) } });
  check('session check rejects forged cookie', badCookie.status === 401);
}

// ---------- login with unset hash: same generic 401, no config leak ----------
{
  const envNoHash = { ...env };
  delete envNoHash.ADMIN_PASSWORD_HASH;
  const res = await worker.fetch(new Request(BASE + '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.20' },
    body: JSON.stringify({ password: 'anything' }),
  }), envNoHash);
  const data = await res.json();
  check('unset hash login returns 401 (not 503)', res.status === 401, 'status=' + res.status);
  check('unset hash error is the generic message', data.error === 'არასწორი პაროლი.', JSON.stringify(data));
}

// ---------- admin upsert + validation ----------
{
  const auth = { Cookie: cookie };
  const up = await req('POST', '/api/admin/stock', { ip: '10.0.0.7', headers: { 'Content-Type': 'application/json', ...auth }, body: { slug: 'nfc-stand', stock: 10, incoming: 20 } });
  const upData = await up.json();
  check('upsert valid values', up.status === 200 && upData.stock === 10 && upData.incoming === 20);

  const pub = await req('GET', '/api/stock', { ip: '10.0.0.8' });
  const pubData = await pub.json();
  check('public API reflects upsert', pubData['nfc-stand'].stock === 10 && pubData['nfc-stand'].incoming === 20);
  check('other slugs still null', pubData['nfc-card'].stock === null && pubData['photo-stand'].incoming === null);

  const zero = await req('POST', '/api/admin/stock', { ip: '10.0.0.7', headers: { 'Content-Type': 'application/json', ...auth }, body: { slug: 'nfc-card', stock: 0, incoming: null } });
  check('upsert stock 0 allowed', zero.status === 200);
  const clear = await req('POST', '/api/admin/stock', { ip: '10.0.0.7', headers: { 'Content-Type': 'application/json', ...auth }, body: { slug: 'nfc-stand', stock: null, incoming: null } });
  check('upsert null clears values', clear.status === 200);
  const pub2 = await req('GET', '/api/stock', { ip: '10.0.0.8' });
  const pubData2 = await pub2.json();
  check('public API shows nulls after clear', pubData2['nfc-stand'].stock === null && pubData2['nfc-stand'].incoming === null);

  const badSlug = await req('POST', '/api/admin/stock', { ip: '10.0.0.7', headers: { 'Content-Type': 'application/json', ...auth }, body: { slug: 'nope', stock: 1, incoming: null } });
  check('upsert rejects unknown slug', badSlug.status === 400);
  const neg = await req('POST', '/api/admin/stock', { ip: '10.0.0.7', headers: { 'Content-Type': 'application/json', ...auth }, body: { slug: 'nfc-stand', stock: -1, incoming: null } });
  check('upsert rejects negative stock', neg.status === 400);
  const big = await req('POST', '/api/admin/stock', { ip: '10.0.0.7', headers: { 'Content-Type': 'application/json', ...auth }, body: { slug: 'nfc-stand', stock: 100000, incoming: null } });
  check('upsert rejects stock > 99999', big.status === 400);
  const frac = await req('POST', '/api/admin/stock', { ip: '10.0.0.7', headers: { 'Content-Type': 'application/json', ...auth }, body: { slug: 'nfc-stand', stock: 1.5, incoming: null } });
  check('upsert rejects fractional stock', frac.status === 400);
  const str = await req('POST', '/api/admin/stock', { ip: '10.0.0.7', headers: { 'Content-Type': 'application/json', ...auth }, body: { slug: 'nfc-stand', stock: '5', incoming: null } });
  check('upsert rejects string stock', str.status === 400);
  const badInc = await req('POST', '/api/admin/stock', { ip: '10.0.0.7', headers: { 'Content-Type': 'application/json', ...auth }, body: { slug: 'nfc-stand', stock: 5, incoming: -3 } });
  check('upsert rejects negative incoming', badInc.status === 400);
  const badJson = await req('POST', '/api/admin/stock', { ip: '10.0.0.7', headers: { 'Content-Type': 'application/json', ...auth }, body: '{not json' });
  check('upsert rejects malformed JSON', badJson.status === 400);

  const adminGet = await req('GET', '/api/admin/stock', { ip: '10.0.0.7', headers: auth });
  const adminData = await adminGet.json();
  check('admin GET returns all slugs', adminGet.status === 200 && SLUGS.every((s) => s in adminData));
  check('admin GET shows stock 0 row', adminData['nfc-card'].stock === 0);
}

// ---------- origin check on mutating calls ----------
{
  const cross = await req('POST', '/api/admin/login', { ip: '10.0.0.9', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: { password: TEST_PASSWORD } });
  check('login rejects cross-site Origin', cross.status === 403);
}

// ---------- rate limits ----------
{
  // Login: 5/min per IP hash.
  let statuses = [];
  for (let i = 0; i < 6; i++) {
    const r = await req('POST', '/api/admin/login', { ip: '10.0.0.10', headers: { 'Content-Type': 'application/json' }, body: { password: 'wrong' } });
    statuses.push(r.status);
  }
  check('login rate limit: 5 attempts then 429', statuses.slice(0, 5).every((s) => s === 401) && statuses[5] === 429, statuses.join(','));

  // Public stock: 120/min per IP hash.
  let last = 0;
  for (let i = 0; i < 121; i++) {
    const r = await req('GET', '/api/stock', { ip: '10.0.0.11' });
    last = r.status;
  }
  check('public stock rate limit: 121st request 429', last === 429, 'last=' + last);
  const otherIp = await req('GET', '/api/stock', { ip: '10.0.0.12' });
  check('rate limit is per-IP (other IP still 200)', otherIp.status === 200);
}

// ---------- security events ----------
{
  const countEvents = (type) => db.prepare('SELECT COUNT(*) AS n FROM security_events WHERE event = ?').get(type).n;

  const beforeFailed = countEvents('login_failed');
  await req('POST', '/api/admin/login', { ip: '10.0.0.21', headers: { 'Content-Type': 'application/json' }, body: { password: 'wrong' } });
  check('failed login writes login_failed event', countEvents('login_failed') === beforeFailed + 1);

  const beforeLimited = countEvents('login_rate_limited');
  let statuses = [];
  for (let i = 0; i < 6; i++) {
    const r = await req('POST', '/api/admin/login', { ip: '10.0.0.22', headers: { 'Content-Type': 'application/json' }, body: { password: 'wrong' } });
    statuses.push(r.status);
  }
  check('rate-limited login writes login_rate_limited event', statuses[5] === 429 && countEvents('login_rate_limited') === beforeLimited + 1, statuses.join(','));

  const rows = db.prepare('SELECT ip_hash FROM security_events').all();
  check('security events store hashes only (no raw IP)', rows.length > 0 && rows.every((r) => /^[0-9a-f]{64}$/.test(r.ip_hash)), 'rows=' + rows.length);

  const list = await req('GET', '/api/admin/security-events', { ip: '10.0.0.7', headers: { Cookie: cookie } });
  const listData = await list.json();
  check('admin security-events endpoint 200 with cookie', list.status === 200 && Array.isArray(listData.events), 'status=' + list.status);
  check('admin events show truncated hash only', listData.events.length > 0 && listData.events.every((e) => typeof e.ip === 'string' && /^[0-9a-f]{12}$/.test(e.ip)), 'events=' + listData.events.length);
  const listNoAuth = await req('GET', '/api/admin/security-events', { ip: '10.0.0.23' });
  check('admin security-events rejects unauthenticated', listNoAuth.status === 401);

  const page = await req('GET', '/admin');
  const html = await page.text();
  check('admin page shows security events section', html.includes('უსაფრთხოების მოვლენები') && html.includes('/api/admin/security-events'));
}

// ---------- logout ----------
{
  const out = await req('POST', '/api/admin/logout', { ip: '10.0.0.6', headers: { Cookie: cookie } });
  check('logout 200', out.status === 200);
  const after = await req('GET', '/api/admin/session', { ip: '10.0.0.6', headers: { Cookie: cookie } });
  check('session invalid after logout', after.status === 401);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed.');
if (failed > 0) {
  console.log('Failures: ' + failures.join(', '));
  process.exit(1);
}
