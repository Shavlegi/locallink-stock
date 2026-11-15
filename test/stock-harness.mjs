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

// ---------- calculator: catalog + quotes ----------
{
  const auth = { Cookie: cookie };
  const noAuthCat = await req('GET', '/api/admin/catalog', { ip: '10.0.0.30' });
  check('catalog rejects unauthenticated', noAuthCat.status === 401);
  const noAuthQ = await req('GET', '/api/admin/quotes', { ip: '10.0.0.30' });
  check('quotes GET rejects unauthenticated', noAuthQ.status === 401);
  const noAuthQP = await req('POST', '/api/admin/quotes', { ip: '10.0.0.30', headers: { 'Content-Type': 'application/json' }, body: { first_name: 'X', items: [{ id: 'logo', qty: 1 }] } });
  check('quotes POST rejects unauthenticated', noAuthQP.status === 401);

  const cat = await req('GET', '/api/admin/catalog', { ip: '10.0.0.31', headers: auth });
  const catData = await cat.json();
  check('catalog 200 with cookie', cat.status === 200 && Array.isArray(catData.items), 'status=' + cat.status);
  check('catalog has 31 items', catData.items.length === 31, 'n=' + catData.items.length);
  const byId = {};
  for (const it of catData.items) byId[it.id] = it;
  check('catalog prices match price list', byId['gbp-create'].price === 10 && byId['gbp-all'].price === 50 && byId['vip2'].price === 149 && byId['prod-photo-stand'].price === 60);
  check('catalog editable flags', byId['site-build'].editable === true && byId['banner'].editable === true && byId['gbp-create'].editable === false && byId['logo'].editable === false);
  check('catalog monthly flags', byId['m-reviews'].monthly === true && byId['vip1'].monthly === true && byId['logo'].monthly === false && byId['call-day'].monthly === false);
  check('catalog has all 10 groups', new Set(catData.items.map((i) => i.group)).size === 10);

  const emptyList = await req('GET', '/api/admin/quotes', { ip: '10.0.0.31', headers: auth });
  const emptyData = await emptyList.json();
  check('quotes list starts empty', emptyList.status === 200 && Array.isArray(emptyData.quotes) && emptyData.quotes.length === 0);

  const noName = await req('POST', '/api/admin/quotes', { ip: '10.0.0.31', headers: { 'Content-Type': 'application/json', ...auth }, body: { first_name: '  ', items: [{ id: 'logo', qty: 1 }] } });
  check('quote rejects empty first name', noName.status === 400);
  const noItems = await req('POST', '/api/admin/quotes', { ip: '10.0.0.31', headers: { 'Content-Type': 'application/json', ...auth }, body: { first_name: 'Nika', items: [] } });
  check('quote rejects empty items', noItems.status === 400);
  const badId = await req('POST', '/api/admin/quotes', { ip: '10.0.0.31', headers: { 'Content-Type': 'application/json', ...auth }, body: { first_name: 'Nika', items: [{ id: 'nope', qty: 1 }] } });
  check('quote rejects unknown item id', badId.status === 400);
  const dup = await req('POST', '/api/admin/quotes', { ip: '10.0.0.31', headers: { 'Content-Type': 'application/json', ...auth }, body: { first_name: 'Nika', items: [{ id: 'logo', qty: 1 }, { id: 'logo', qty: 1 }] } });
  check('quote rejects duplicate item id', dup.status === 400);
  const qty0 = await req('POST', '/api/admin/quotes', { ip: '10.0.0.31', headers: { 'Content-Type': 'application/json', ...auth }, body: { first_name: 'Nika', items: [{ id: 'logo', qty: 0 }] } });
  check('quote rejects qty 0', qty0.status === 400);
  const qty100 = await req('POST', '/api/admin/quotes', { ip: '10.0.0.31', headers: { 'Content-Type': 'application/json', ...auth }, body: { first_name: 'Nika', items: [{ id: 'logo', qty: 100 }] } });
  check('quote rejects qty 100', qty100.status === 400);
  // Client-sent prices are ignored entirely (see end of this block);
  // the two old editable-price rejection tests moved there.
  const crossQ = await req('POST', '/api/admin/quotes', { ip: '10.0.0.31', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', ...auth }, body: { first_name: 'Nika', items: [{ id: 'logo', qty: 1 }] } });
  check('quotes POST rejects cross-site Origin', crossQ.status === 403);

  // Client-sent prices ignored; totals split once/monthly.
  const q1 = await req('POST', '/api/admin/quotes', { ip: '10.0.0.31', headers: { 'Content-Type': 'application/json', ...auth }, body: { first_name: 'Nika', last_name: 'Test', phone: '597 111 222', note: 'test note', items: [{ id: 'logo', qty: 2, price: 999 }, { id: 'site-build', qty: 1, price: 999 }, { id: 'm-care', qty: 1 }, { id: 'prod-nfc-stand', qty: 3 }] } });
  const q1Data = await q1.json();
  check('quote create 200 with totals', q1.status === 200 && q1Data.total_once === 220 && q1Data.total_monthly === 25, JSON.stringify(q1Data));
  const q1id = q1Data.id;
  check('quote create returns numeric id', Number.isInteger(q1id) && q1id > 0, 'id=' + q1id);

  const list1 = await req('GET', '/api/admin/quotes', { ip: '10.0.0.31', headers: auth });
  const list1Data = await list1.json();
  check('quotes list has the saved card', list1Data.quotes.length === 1 && list1Data.quotes[0].id === q1id);
  const card = list1Data.quotes[0];
  check('card keeps client fields', card.first_name === 'Nika' && card.last_name === 'Test' && card.phone === '597 111 222' && card.note === 'test note');
  check('card items snapshot has names + enforced prices', card.items.length === 4 && card.items.find((i) => i.id === 'logo').price === 10 && card.items.find((i) => i.id === 'site-build').price === 50 && card.items.find((i) => i.id === 'prod-nfc-stand').qty === 3);
  check('card monthly flag on snapshot', card.items.find((i) => i.id === 'm-care').monthly === true && card.items.find((i) => i.id === 'logo').monthly === false);

  const q2 = await req('POST', '/api/admin/quotes', { ip: '10.0.0.31', headers: { 'Content-Type': 'application/json', ...auth }, body: { first_name: 'Gio', items: [{ id: 'gbp-all', qty: 1 }] } });
  check('second quote create 200', q2.status === 200);
  const list2 = await req('GET', '/api/admin/quotes', { ip: '10.0.0.31', headers: auth });
  const list2Data = await list2.json();
  check('quotes list newest first', list2Data.quotes.length === 2 && list2Data.quotes[0].first_name === 'Gio' && list2Data.quotes[1].first_name === 'Nika');

  const delNoAuth = await req('DELETE', '/api/admin/quotes/' + q1id, { ip: '10.0.0.32' });
  check('quote DELETE rejects unauthenticated', delNoAuth.status === 401);
  const delCross = await req('DELETE', '/api/admin/quotes/' + q1id, { ip: '10.0.0.31', headers: { Origin: 'https://evil.example', ...auth } });
  check('quote DELETE rejects cross-site Origin', delCross.status === 403);
  const delBad = await req('DELETE', '/api/admin/quotes/abc', { ip: '10.0.0.31', headers: auth });
  check('quote DELETE rejects non-numeric id', delBad.status === 400);
  const delMissing = await req('DELETE', '/api/admin/quotes/99999', { ip: '10.0.0.31', headers: auth });
  check('quote DELETE missing id 404', delMissing.status === 404);
  const del = await req('DELETE', '/api/admin/quotes/' + q1id, { ip: '10.0.0.31', headers: auth });
  check('quote DELETE 200', del.status === 200);
  const list3 = await req('GET', '/api/admin/quotes', { ip: '10.0.0.31', headers: auth });
  const list3Data = await list3.json();
  check('deleted card gone from list', list3Data.quotes.length === 1 && list3Data.quotes[0].first_name === 'Gio');

  const page = await req('GET', '/admin');
  const html = await page.text();
  check('admin page has calculator tab + endpoints', html.includes('კალკულატორი') && html.includes('/api/admin/quotes') && html.includes('/api/admin/catalog') && html.includes('tab-btn-calc'));
  check('admin page enforces bundle exclusivity in UI', html.includes('enforceBundle') && html.includes('gbp-all') && html.includes('gbp-verify'));
  check('admin page shows prices before checking (qty hidden until checked)', html.includes('.calc-ctl .qty-input{display:none}') && html.includes('.calc-item.on .calc-ctl .qty-input{display:block}'));

  // Bundle + component in one quote must be rejected server-side.
  const bundleMix = await req('POST', '/api/admin/quotes', { ip: '10.0.0.31', headers: { 'Content-Type': 'application/json', ...auth }, body: { first_name: 'Nika', items: [{ id: 'gbp-all', qty: 1 }, { id: 'gbp-create', qty: 1 }] } });
  check('quote rejects bundle + component together', bundleMix.status === 400);
  const bundleMix2 = await req('POST', '/api/admin/quotes', { ip: '10.0.0.31', headers: { 'Content-Type': 'application/json', ...auth }, body: { first_name: 'Nika', items: [{ id: 'gbp-verify', qty: 1 }, { id: 'gbp-all', qty: 1 }, { id: 'logo', qty: 1 }] } });
  check('quote rejects bundle + component among others', bundleMix2.status === 400);
  const bundleOnly = await req('POST', '/api/admin/quotes', { ip: '10.0.0.31', headers: { 'Content-Type': 'application/json', ...auth }, body: { first_name: 'Nika', items: [{ id: 'gbp-all', qty: 1 }] } });
  check('quote accepts bundle alone', bundleOnly.status === 200);
  const partsOnly = await req('POST', '/api/admin/quotes', { ip: '10.0.0.31', headers: { 'Content-Type': 'application/json', ...auth }, body: { first_name: 'Nika', items: [{ id: 'gbp-create', qty: 1 }, { id: 'gbp-fill', qty: 1 }, { id: 'gbp-verify', qty: 1 }] } });
  const partsOnlyData = await partsOnly.json();
  check('quote accepts all three parts (60 total)', partsOnly.status === 200 && partsOnlyData.total_once === 60, JSON.stringify(partsOnlyData));

  // Client-sent prices are IGNORED — quotes always use effective catalog prices.
  const negPrice = await req('POST', '/api/admin/quotes', { ip: '10.0.0.31', headers: { 'Content-Type': 'application/json', ...auth }, body: { first_name: 'Nika', items: [{ id: 'site-build', qty: 1, price: -5 }] } });
  const negPriceData = await negPrice.json();
  check('quote ignores negative client-sent price (200 at effective price)', negPrice.status === 200 && negPriceData.total_once === 50, JSON.stringify(negPriceData));
  const fracPrice = await req('POST', '/api/admin/quotes', { ip: '10.0.0.31', headers: { 'Content-Type': 'application/json', ...auth }, body: { first_name: 'Nika', items: [{ id: 'site-build', qty: 1, price: 50.5 }] } });
  const fracPriceData = await fracPrice.json();
  check('quote ignores fractional client-sent price (200 at effective price)', fracPrice.status === 200 && fracPriceData.total_once === 50, JSON.stringify(fracPriceData));
  const sent999 = await req('POST', '/api/admin/quotes', { ip: '10.0.0.31', headers: { 'Content-Type': 'application/json', ...auth }, body: { first_name: 'Nika', items: [{ id: 'site-build', qty: 1, price: 999 }] } });
  const sent999Data = await sent999.json();
  check('quote ignores client-sent 999 (200 at effective price)', sent999.status === 200 && sent999Data.total_once === 50, JSON.stringify(sent999Data));
  const list4 = await req('GET', '/api/admin/quotes', { ip: '10.0.0.31', headers: auth });
  const list4Data = await list4.json();
  check('stored snapshot keeps effective price, not sent price', list4Data.quotes[0].items[0].id === 'site-build' && list4Data.quotes[0].items[0].price === 50);
}

// ---------- prices: overrides + public API ----------
{
  const auth = { Cookie: cookie };
  const jsonHeaders = { 'Content-Type': 'application/json', ...auth };

  const pub0 = await req('GET', '/api/prices', { ip: '10.0.0.40' });
  const pub0Data = await pub0.json();
  check('GET /api/prices 200 with empty overrides', pub0.status === 200 && pub0Data.prices && Object.keys(pub0Data.prices).length === 0, JSON.stringify(pub0Data));
  check('GET /api/prices no-store', (pub0.headers.get('cache-control') || '') === 'no-store');
  const corsP = await req('GET', '/api/prices', { ip: '10.0.0.41', headers: { Origin: 'https://locallink.store' } });
  check('prices CORS allows locallink.store', corsP.headers.get('access-control-allow-origin') === 'https://locallink.store');
  const corsPE = await req('GET', '/api/prices', { ip: '10.0.0.41', headers: { Origin: 'https://evil.example' } });
  check('prices CORS denies other origins', corsPE.headers.get('access-control-allow-origin') === null);
  const preP = await req('OPTIONS', '/api/prices', { ip: '10.0.0.41', headers: { Origin: 'https://locallink.store' } });
  check('prices OPTIONS preflight 204', preP.status === 204 && (preP.headers.get('access-control-allow-methods') || '').includes('GET'));

  const noAuthGet = await req('GET', '/api/admin/prices', { ip: '10.0.0.42' });
  check('admin prices GET rejects unauthenticated', noAuthGet.status === 401);
  const noAuthPost = await req('POST', '/api/admin/prices', { ip: '10.0.0.42', headers: { 'Content-Type': 'application/json' }, body: { id: 'logo', price: 15 } });
  check('admin prices POST rejects unauthenticated', noAuthPost.status === 401);
  const noAuthDel = await req('DELETE', '/api/admin/prices/logo', { ip: '10.0.0.42' });
  check('admin prices DELETE rejects unauthenticated', noAuthDel.status === 401);

  const list = await req('GET', '/api/admin/prices', { ip: '10.0.0.43', headers: auth });
  const listData = await list.json();
  check('admin prices GET 200 with 26 services', list.status === 200 && Array.isArray(listData.items) && listData.items.length === 26, 'n=' + (listData.items && listData.items.length));
  check('admin prices excludes products', listData.items.every((i) => !i.id.startsWith('prod-')));
  check('admin prices defaults + flags', listData.items.every((i) => i.price === i.defaultPrice && i.overridden === false && 'monthly' in i && 'editable' in i && 'group' in i));

  const badId = await req('POST', '/api/admin/prices', { ip: '10.0.0.43', headers: jsonHeaders, body: { id: 'nope', price: 15 } });
  check('prices POST rejects unknown id', badId.status === 400);
  const prodId = await req('POST', '/api/admin/prices', { ip: '10.0.0.43', headers: jsonHeaders, body: { id: 'prod-nfc-stand', price: 55 } });
  check('prices POST rejects product id', prodId.status === 400);
  const neg = await req('POST', '/api/admin/prices', { ip: '10.0.0.43', headers: jsonHeaders, body: { id: 'logo', price: -1 } });
  check('prices POST rejects negative price', neg.status === 400);
  const frac = await req('POST', '/api/admin/prices', { ip: '10.0.0.43', headers: jsonHeaders, body: { id: 'logo', price: 15.5 } });
  check('prices POST rejects fractional price', frac.status === 400);
  const str = await req('POST', '/api/admin/prices', { ip: '10.0.0.43', headers: jsonHeaders, body: { id: 'logo', price: '15' } });
  check('prices POST rejects string price', str.status === 400);
  const big = await req('POST', '/api/admin/prices', { ip: '10.0.0.43', headers: jsonHeaders, body: { id: 'logo', price: 100000 } });
  check('prices POST rejects price > 99999', big.status === 400);
  const missing = await req('POST', '/api/admin/prices', { ip: '10.0.0.43', headers: jsonHeaders, body: { id: 'logo' } });
  check('prices POST rejects missing price', missing.status === 400);
  const cross = await req('POST', '/api/admin/prices', { ip: '10.0.0.43', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', ...auth }, body: { id: 'logo', price: 15 } });
  check('prices POST rejects cross-site Origin', cross.status === 403);

  const ov = await req('POST', '/api/admin/prices', { ip: '10.0.0.43', headers: jsonHeaders, body: { id: 'logo', price: 15 } });
  const ovData = await ov.json();
  check('prices POST override 200', ov.status === 200 && ovData.overridden === true && ovData.price === 15, JSON.stringify(ovData));
  const pub1 = await req('GET', '/api/prices', { ip: '10.0.0.40' });
  const pub1Data = await pub1.json();
  check('public prices shows override only', pub1Data.prices.logo === 15 && Object.keys(pub1Data.prices).length === 1, JSON.stringify(pub1Data));
  const cat1 = await req('GET', '/api/admin/catalog', { ip: '10.0.0.43', headers: auth });
  const cat1Data = await cat1.json();
  check('catalog uses effective price', cat1Data.items.find((i) => i.id === 'logo').price === 15);
  const qEff = await req('POST', '/api/admin/quotes', { ip: '10.0.0.43', headers: jsonHeaders, body: { first_name: 'T', items: [{ id: 'logo', qty: 2, price: 999 }] } });
  const qEffData = await qEff.json();
  check('quote charges effective fixed price', qEff.status === 200 && qEffData.total_once === 30, JSON.stringify(qEffData));

  await req('POST', '/api/admin/prices', { ip: '10.0.0.43', headers: jsonHeaders, body: { id: 'site-build', price: 80 } });
  const qEdit = await req('POST', '/api/admin/quotes', { ip: '10.0.0.43', headers: jsonHeaders, body: { first_name: 'T', items: [{ id: 'site-build', qty: 1 }] } });
  const qEditData = await qEdit.json();
  check('quote uses effective price for from-item', qEdit.status === 200 && qEditData.total_once === 80, JSON.stringify(qEditData));
  const qEditSent = await req('POST', '/api/admin/quotes', { ip: '10.0.0.43', headers: jsonHeaders, body: { first_name: 'T', items: [{ id: 'site-build', qty: 1, price: 999 }] } });
  const qEditSentData = await qEditSent.json();
  check('quote ignores sent price on overridden from-item', qEditSent.status === 200 && qEditSentData.total_once === 80, JSON.stringify(qEditSentData));

  const saveDef = await req('POST', '/api/admin/prices', { ip: '10.0.0.43', headers: jsonHeaders, body: { id: 'logo', price: 10 } });
  const saveDefData = await saveDef.json();
  check('saving default removes override', saveDef.status === 200 && saveDefData.overridden === false, JSON.stringify(saveDefData));
  const pub2 = await req('GET', '/api/prices', { ip: '10.0.0.40' });
  const pub2Data = await pub2.json();
  check('public prices drops removed override', !('logo' in pub2Data.prices) && pub2Data.prices['site-build'] === 80, JSON.stringify(pub2Data));

  await req('POST', '/api/admin/prices', { ip: '10.0.0.43', headers: jsonHeaders, body: { id: 'logo', price: 20 } });
  const del = await req('DELETE', '/api/admin/prices/logo', { ip: '10.0.0.43', headers: auth });
  const delData = await del.json();
  check('prices DELETE resets to default', del.status === 200 && delData.price === 10, JSON.stringify(delData));
  const delAgain = await req('DELETE', '/api/admin/prices/logo', { ip: '10.0.0.43', headers: auth });
  check('prices DELETE without override still 200', delAgain.status === 200);
  const delBad = await req('DELETE', '/api/admin/prices/nope', { ip: '10.0.0.43', headers: auth });
  check('prices DELETE rejects unknown id', delBad.status === 400);
  const delProd = await req('DELETE', '/api/admin/prices/prod-nfc-stand', { ip: '10.0.0.43', headers: auth });
  check('prices DELETE rejects product id', delProd.status === 400);
  const delCross = await req('DELETE', '/api/admin/prices/logo', { ip: '10.0.0.43', headers: { Origin: 'https://evil.example', ...auth } });
  check('prices DELETE rejects cross-site Origin', delCross.status === 403);

  await req('POST', '/api/admin/prices', { ip: '10.0.0.43', headers: jsonHeaders, body: { id: 'gbp-all', price: 55 } });
  const bMix = await req('POST', '/api/admin/quotes', { ip: '10.0.0.43', headers: jsonHeaders, body: { first_name: 'T', items: [{ id: 'gbp-all', qty: 1 }, { id: 'gbp-create', qty: 1 }] } });
  check('bundle rule still enforced with effective prices', bMix.status === 400);
  const bOnly = await req('POST', '/api/admin/quotes', { ip: '10.0.0.43', headers: jsonHeaders, body: { first_name: 'T', items: [{ id: 'gbp-all', qty: 1 }] } });
  const bOnlyData = await bOnly.json();
  check('bundle alone charges effective price', bOnly.status === 200 && bOnlyData.total_once === 55, JSON.stringify(bOnlyData));
  await req('DELETE', '/api/admin/prices/gbp-all', { ip: '10.0.0.43', headers: auth });
  await req('DELETE', '/api/admin/prices/site-build', { ip: '10.0.0.43', headers: auth });
  const pubFinal = await req('GET', '/api/prices', { ip: '10.0.0.40' });
  const pubFinalData = await pubFinal.json();
  check('public prices empty after cleanup', Object.keys(pubFinalData.prices).length === 0, JSON.stringify(pubFinalData));

  let last = 0;
  for (let i = 0; i < 121; i++) {
    const r = await req('GET', '/api/prices', { ip: '10.0.0.44' });
    last = r.status;
  }
  check('public prices rate limit: 121st request 429', last === 429, 'last=' + last);

  const page = await req('GET', '/admin');
  const html = await page.text();
  check('admin page has prices tab', html.includes('tab-btn-prices') && html.includes('ფასები') && html.includes('/api/admin/prices') && html.includes('price-rows'));
  check('admin page delete button is solid red', html.includes('.btn-danger{background:#E5484D'));
  check('calculator has no price inputs', !html.includes('data-price-for'));
}

// ---------- discounts: sale prices + computed % ----------
{
  const auth = { Cookie: cookie };
  const jsonHeaders = { 'Content-Type': 'application/json', ...auth };

  const eqSale = await req('POST', '/api/admin/prices', { ip: '10.0.0.50', headers: jsonHeaders, body: { id: 'logo', price: 10, sale_price: 10 } });
  check('discount rejects sale == price', eqSale.status === 400);
  const gtSale = await req('POST', '/api/admin/prices', { ip: '10.0.0.50', headers: jsonHeaders, body: { id: 'logo', price: 10, sale_price: 11 } });
  check('discount rejects sale > price', gtSale.status === 400);
  const zeroBase = await req('POST', '/api/admin/prices', { ip: '10.0.0.50', headers: jsonHeaders, body: { id: 'logo', price: 0, sale_price: 0 } });
  check('discount rejects sale on price 0', zeroBase.status === 400);
  const negSale = await req('POST', '/api/admin/prices', { ip: '10.0.0.50', headers: jsonHeaders, body: { id: 'logo', price: 10, sale_price: -1 } });
  check('discount rejects negative sale price', negSale.status === 400);
  const fracSale = await req('POST', '/api/admin/prices', { ip: '10.0.0.50', headers: jsonHeaders, body: { id: 'logo', price: 10, sale_price: 7.5 } });
  check('discount rejects fractional sale price', fracSale.status === 400);
  const strSale = await req('POST', '/api/admin/prices', { ip: '10.0.0.50', headers: jsonHeaders, body: { id: 'logo', price: 10, sale_price: '7' } });
  check('discount rejects string sale price', strSale.status === 400);
  const bigSale = await req('POST', '/api/admin/prices', { ip: '10.0.0.50', headers: jsonHeaders, body: { id: 'logo', price: 10, sale_price: 100000 } });
  check('discount rejects sale price > 99999', bigSale.status === 400);
  const unknownSale = await req('POST', '/api/admin/prices', { ip: '10.0.0.50', headers: jsonHeaders, body: { id: 'nope', price: 10, sale_price: 7 } });
  check('discount rejects unknown id', unknownSale.status === 400);
  const prodSale = await req('POST', '/api/admin/prices', { ip: '10.0.0.50', headers: jsonHeaders, body: { id: 'prod-nfc-stand', price: 50, sale_price: 40 } });
  check('discount rejects product id', prodSale.status === 400);
  const noAuthSale = await req('POST', '/api/admin/prices', { ip: '10.0.0.50', headers: { 'Content-Type': 'application/json' }, body: { id: 'logo', price: 10, sale_price: 7 } });
  check('discount POST rejects unauthenticated', noAuthSale.status === 401);
  const crossSale = await req('POST', '/api/admin/prices', { ip: '10.0.0.50', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', ...auth }, body: { id: 'logo', price: 10, sale_price: 7 } });
  check('discount POST rejects cross-site Origin', crossSale.status === 403);

  // % is computed from base + sale (whole percent, rounded).
  const d1 = await req('POST', '/api/admin/prices', { ip: '10.0.0.50', headers: jsonHeaders, body: { id: 'site-build', price: 50, sale_price: 36 } });
  const d1Data = await d1.json();
  check('50→36 computes 28%', d1.status === 200 && d1Data.salePrice === 36 && d1Data.discountPct === 28 && d1Data.overridden === false, JSON.stringify(d1Data));
  const d2 = await req('POST', '/api/admin/prices', { ip: '10.0.0.50', headers: jsonHeaders, body: { id: 'logo', price: 30, sale_price: 25 } });
  const d2Data = await d2.json();
  check('30→25 computes 17%', d2.status === 200 && d2Data.salePrice === 25 && d2Data.discountPct === 17 && d2Data.overridden === true, JSON.stringify(d2Data));
  const d3 = await req('POST', '/api/admin/prices', { ip: '10.0.0.50', headers: jsonHeaders, body: { id: 'gbp-all', price: 50, sale_price: 25 } });
  const d3Data = await d3.json();
  check('50→25 computes 50%', d3.status === 200 && d3Data.salePrice === 25 && d3Data.discountPct === 50, JSON.stringify(d3Data));

  const list = await req('GET', '/api/admin/prices', { ip: '10.0.0.50', headers: auth });
  const listData = await list.json();
  const byIdP = {};
  for (const it of listData.items) byIdP[it.id] = it;
  check('admin prices list carries sale fields', byIdP['site-build'].salePrice === 36 && byIdP['site-build'].discountPct === 28 && byIdP['logo'].salePrice === 25 && byIdP['logo'].discountPct === 17);
  check('undiscounted item has null sale fields', byIdP['banner'].salePrice === null && byIdP['banner'].discountPct === null);

  const cat = await req('GET', '/api/admin/catalog', { ip: '10.0.0.50', headers: auth });
  const catData = await cat.json();
  const byIdC = {};
  for (const it of catData.items) byIdC[it.id] = it;
  check('catalog carries sale fields', byIdC['site-build'].price === 50 && byIdC['site-build'].salePrice === 36 && byIdC['site-build'].discountPct === 28 && byIdC['logo'].price === 30 && byIdC['logo'].salePrice === 25);

  const pub = await req('GET', '/api/prices', { ip: '10.0.0.51' });
  const pubData = await pub.json();
  check('public prices returns discounts map', pubData.discounts && pubData.discounts['site-build'] === 36 && pubData.discounts['logo'] === 25 && pubData.discounts['gbp-all'] === 25, JSON.stringify(pubData));
  check('public prices map keeps overrides only', pubData.prices.logo === 30 && !('site-build' in pubData.prices) && !('gbp-all' in pubData.prices), JSON.stringify(pubData.prices));
  const corsD = await req('GET', '/api/prices', { ip: '10.0.0.51', headers: { Origin: 'https://locallink.store' } });
  check('prices CORS still allows store with discounts', corsD.headers.get('access-control-allow-origin') === 'https://locallink.store');

  const q = await req('POST', '/api/admin/quotes', { ip: '10.0.0.50', headers: jsonHeaders, body: { first_name: 'T', items: [{ id: 'logo', qty: 2 }] } });
  const qData = await q.json();
  check('quote charges sale price', q.status === 200 && qData.total_once === 50, JSON.stringify(qData));
  const q2 = await req('POST', '/api/admin/quotes', { ip: '10.0.0.50', headers: jsonHeaders, body: { first_name: 'T', items: [{ id: 'site-build', qty: 1 }] } });
  const q2Data = await q2.json();
  check('quote charges sale price on from-item', q2.status === 200 && q2Data.total_once === 36, JSON.stringify(q2Data));
  const qList = await req('GET', '/api/admin/quotes', { ip: '10.0.0.50', headers: auth });
  const qListData = await qList.json();
  check('quote snapshot keeps sale price', qListData.quotes[0].items[0].id === 'site-build' && qListData.quotes[0].items[0].price === 36);

  const bMix = await req('POST', '/api/admin/quotes', { ip: '10.0.0.50', headers: jsonHeaders, body: { first_name: 'T', items: [{ id: 'gbp-all', qty: 1 }, { id: 'gbp-create', qty: 1 }] } });
  check('bundle rule still enforced with discount', bMix.status === 400);
  const bOnly = await req('POST', '/api/admin/quotes', { ip: '10.0.0.50', headers: jsonHeaders, body: { first_name: 'T', items: [{ id: 'gbp-all', qty: 1 }] } });
  const bOnlyData = await bOnly.json();
  check('discounted bundle alone charges sale price', bOnly.status === 200 && bOnlyData.total_once === 25, JSON.stringify(bOnlyData));

  const clr = await req('POST', '/api/admin/prices', { ip: '10.0.0.50', headers: jsonHeaders, body: { id: 'logo', price: 30, sale_price: null } });
  const clrData = await clr.json();
  check('null sale_price clears discount, keeps override', clr.status === 200 && clrData.salePrice === null && clrData.discountPct === null && clrData.overridden === true, JSON.stringify(clrData));
  const pubClr = await req('GET', '/api/prices', { ip: '10.0.0.51' });
  const pubClrData = await pubClr.json();
  check('public maps after clear: override stays, discount gone', pubClrData.prices.logo === 30 && !('logo' in pubClrData.discounts), JSON.stringify(pubClrData));
  await req('POST', '/api/admin/prices', { ip: '10.0.0.50', headers: jsonHeaders, body: { id: 'logo', price: 30, sale_price: 20 } });
  const omit = await req('POST', '/api/admin/prices', { ip: '10.0.0.50', headers: jsonHeaders, body: { id: 'logo', price: 30 } });
  const omitData = await omit.json();
  check('omitted sale_price clears discount', omit.status === 200 && omitData.salePrice === null && omitData.discountPct === null, JSON.stringify(omitData));

  await req('POST', '/api/admin/prices', { ip: '10.0.0.50', headers: jsonHeaders, body: { id: 'logo', price: 30, sale_price: 25 } });
  const del = await req('DELETE', '/api/admin/prices/logo', { ip: '10.0.0.50', headers: auth });
  const delData = await del.json();
  check('DELETE resets override + discount', del.status === 200 && delData.price === 10 && delData.salePrice === null && delData.discountPct === null, JSON.stringify(delData));
  const pubDel = await req('GET', '/api/prices', { ip: '10.0.0.51' });
  const pubDelData = await pubDel.json();
  check('public maps drop reset service', !('logo' in pubDelData.prices) && !('logo' in pubDelData.discounts), JSON.stringify(pubDelData));
  const catDel = await req('GET', '/api/admin/catalog', { ip: '10.0.0.50', headers: auth });
  const catDelData = await catDel.json();
  const logoAfter = catDelData.items.find((i) => i.id === 'logo');
  check('catalog back to default after DELETE', logoAfter.price === 10 && logoAfter.salePrice === null && logoAfter.discountPct === null);

  await req('DELETE', '/api/admin/prices/site-build', { ip: '10.0.0.50', headers: auth });
  await req('DELETE', '/api/admin/prices/gbp-all', { ip: '10.0.0.50', headers: auth });
  const pubFinal = await req('GET', '/api/prices', { ip: '10.0.0.51' });
  const pubFinalData = await pubFinal.json();
  check('public prices + discounts empty after cleanup', Object.keys(pubFinalData.prices).length === 0 && Object.keys(pubFinalData.discounts).length === 0, JSON.stringify(pubFinalData));

  const page = await req('GET', '/admin');
  const html = await page.text();
  check('admin page has sale price inputs + live pct labels', html.includes('data-sale-input') && html.includes('data-sale-pct') && html.includes('refreshSalePct'));
  check('calculator shows struck base + colored discount label', html.includes('class="disc ') && html.includes('discClassFor(pct)') && html.includes('<s>'));
}

// ---------- discount badge colors (red <=20%, yellow 21-50%, green >50%) ----------
{
  const page = await req('GET', '/admin');
  const html = await page.text();
  // Execute the real mapping from the served page (no DOM deps).
  const fnSrc = (html.match(/function discClassFor\(pct\) \{[\s\S]*?\n  \}/) || [])[0];
  check('admin page defines discClassFor', typeof fnSrc === 'string', fnSrc ? '' : 'not found');
  const discClassFor = new Function(fnSrc + '\nreturn discClassFor;')();
  const bands = [[1, 'disc-red'], [20, 'disc-red'], [21, 'disc-yellow'], [33, 'disc-yellow'], [40, 'disc-yellow'], [50, 'disc-yellow'], [51, 'disc-green'], [75, 'disc-green'], [100, 'disc-green']];
  for (const [pct, cls] of bands) {
    check('discClassFor(' + pct + '%) = ' + cls, discClassFor(pct) === cls, discClassFor(pct));
  }
  check('admin CSS: red pill #E5484D + white text', html.includes('.sale-pct.disc-red{background:#E5484D;color:#fff}'));
  check('admin CSS: yellow pill #F5C518 + dark text', html.includes('.sale-pct.disc-yellow{background:#F5C518;color:#1A1A1A}'));
  check('admin CSS: green pill #22C55E + white text', html.includes('.sale-pct.disc-green{background:#22C55E;color:#fff}'));
  check('admin CSS: color classes cover calculator labels too', html.includes('.calc-ctl .disc.disc-red') && html.includes('.calc-ctl .disc.disc-yellow') && html.includes('.calc-ctl .disc.disc-green'));
  check('refreshSalePct assigns color class live', html.includes("pctEl.className = 'sale-pct ' + discClassFor(pct)"));
  check('refreshSalePct clears color class when hidden', html.includes("pctEl.className = 'sale-pct';"));
  check('Prices tab initial label carries color class', html.includes("pctCls") && html.includes("' ' + discClassFor(item.discountPct)"));
  check('calculator discount label uses discClassFor', html.includes("class=\"disc ' + discClassFor(pct) + '\""));
  // The inline <script> lives inside a JS template literal: no backticks/${}.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const scriptStart = src.indexOf('\n<script>\n');
  const scriptEnd = src.indexOf('</script>', scriptStart);
  const inline = src.slice(scriptStart, scriptEnd);
  check('inline script has no backticks', !inline.includes('`'));
  check('inline script has no ${} interpolations', !inline.includes('${'));
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
