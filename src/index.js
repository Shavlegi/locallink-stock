/* locallink-stock — stock backend + admin panel for the locallink shop.
 *
 * Cloudflare Worker + D1. Auth/session patterns follow Mini Link
 * (~/workspace/url-shortener/src/index.js): PBKDF2-SHA256 password
 * verification, DB-backed sessions with a peppered token hash, IP-hash
 * rate limiting. Raw IPs are never stored.
 *
 * Secrets ONLY via env: ADMIN_PASSWORD_HASH, SESSION_SECRET.
 * Never hardcode, never log.
 *
 * The admin UI is ONE self-contained HTML page embedded below — no static
 * files, no external assets, so there is no static-file allowlist to keep
 * in sync.
 *
 * Stock semantics: a missing row, or a NULL value, means "unset" — the
 * shop shows no stock line for that product. stock = 0 means "out of
 * stock". incoming > 0 means "coming soon: N more".
 */

const SLUGS = [
  { slug: 'sticker-black', name: 'NFC სტიკერი — შავი' },
  { slug: 'sticker-white', name: 'NFC სტიკერი — თეთრი' },
  { slug: 'nfc-card', name: 'ორფხრივი NFC ბარათი' },
  { slug: 'nfc-stand', name: 'NFC სტენდი' },
  { slug: 'photo-stand', name: 'სტენდი ჩასასმელი ფოტოთი' },
];
const SLUG_SET = new Set(SLUGS.map((p) => p.slug));

const CONFIG = {
  sessionDays: 7,
  pbkdf2Iterations: 100000,
  stockLimitPerMin: 120,
  loginLimitPerMin: 5,
  maxQty: 99999,
};

const ALLOWED_ORIGINS = [
  'https://locallink.store',
  'http://locallink.store',
  'https://shavlegi.github.io',
];

const SESSION_COOKIE = 'stock_session';

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'",
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

function error(message, status = 400, extraHeaders = {}) {
  return json({ error: message }, status, extraHeaders);
}

function textEncoder() {
  return new TextEncoder();
}

function bytesToBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time string comparison (avoids leaking match position via timing).
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomTokenHex(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  const m = header.match(new RegExp('(?:^|;\\s*)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]+)'));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

function sessionCookie(token, expiresAt, secure) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.floor((expiresAt - Date.now()) / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookie(secure) {
  const parts = [
    `${SESSION_COOKIE}=`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=0',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function isHttps(request) {
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}

// Mutating API calls from a browser must come from this site (SameSite=Lax
// already blocks cross-site cookies; this is a second layer).
function originAllowed(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true; // non-browser client (curl, etc.)
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Schema (lazy, idempotent — same pattern as Mini Link's ensureV*)    */
/* ------------------------------------------------------------------ */

let schemaChecked = false;

async function ensureSchema(env) {
  if (schemaChecked) return;
  let v1done = false;
  try {
    const flag = await env.STOCK_DB.prepare(
      "SELECT value FROM schema_meta WHERE key = 'v1_stock'",
    ).first();
    v1done = !!(flag && flag.value === '1');
  } catch (e) {
    // schema_meta (or the flag) does not exist yet — migrate below.
  }
  if (!v1done) {
    await env.STOCK_DB.batch([
      env.STOCK_DB.prepare(
        'CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      ),
      env.STOCK_DB.prepare(
        'CREATE TABLE IF NOT EXISTS stock (' +
        'slug TEXT PRIMARY KEY, ' +
        'stock INTEGER, ' +
        'incoming INTEGER, ' +
        'updated_at INTEGER NOT NULL)',
      ),
      env.STOCK_DB.prepare(
        'CREATE TABLE IF NOT EXISTS sessions (' +
        'token_hash TEXT PRIMARY KEY, ' +
        'created_at INTEGER NOT NULL, ' +
        'expires_at INTEGER NOT NULL)',
      ),
      env.STOCK_DB.prepare(
        'CREATE TABLE IF NOT EXISTS rate_limits (' +
        'key TEXT PRIMARY KEY, ' +
        'count INTEGER NOT NULL, ' +
        'window_start INTEGER NOT NULL)',
      ),
      env.STOCK_DB.prepare(
        "INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('v1_stock', '1')",
      ),
    ]);
  }
  // v2: security_events — failed logins / login rate-limit hits, IP hash only.
  try {
    const flag2 = await env.STOCK_DB.prepare(
      "SELECT value FROM schema_meta WHERE key = 'v2_security_events'",
    ).first();
    if (!flag2 || flag2.value !== '1') {
      await env.STOCK_DB.batch([
        env.STOCK_DB.prepare(
          'CREATE TABLE IF NOT EXISTS security_events (' +
          'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
          'event TEXT NOT NULL, ' +
          'ip_hash TEXT NOT NULL, ' +
          'created_at INTEGER NOT NULL)',
        ),
        env.STOCK_DB.prepare(
          "INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('v2_security_events', '1')",
        ),
      ]);
    }
  } catch (e) {
    // Logging is best-effort: a failed v2 migration must never break requests.
    console.error('ensureSchema v2 error:', e && e.message ? e.message : e);
  }
  schemaChecked = true;
}

/* ------------------------------------------------------------------ */
/* Password + sessions (PBKDF2-SHA256 via WebCrypto)                   */
/* ------------------------------------------------------------------ */

// Stored format: pbkdf2$<iterations>$<salt base64>$<hash base64>
// (generated with ~/workspace/url-shortener/scripts/make-hash.html)
async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations < 1000 || iterations > 1000000) return false;
  let salt;
  try {
    salt = base64ToBytes(parts[2]);
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey('raw', textEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return constantTimeEqual(bytesToBase64(new Uint8Array(bits)), parts[3]);
}

async function createSession(env) {
  const token = randomTokenHex(32);
  const tokenHash = await sha256Hex((env.SESSION_SECRET || '') + ':' + token);
  const now = Date.now();
  const expiresAt = now + CONFIG.sessionDays * 24 * 60 * 60 * 1000;
  await env.STOCK_DB.prepare(
    'INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)',
  ).bind(tokenHash, now, expiresAt).run();
  return { token, expiresAt };
}

async function getSession(env, request) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token || token.length < 32) return null;
  const tokenHash = await sha256Hex((env.SESSION_SECRET || '') + ':' + token);
  const row = await env.STOCK_DB.prepare(
    'SELECT expires_at FROM sessions WHERE token_hash = ?',
  ).bind(tokenHash).first();
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await env.STOCK_DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run().catch(() => {});
    return null;
  }
  return row;
}

async function destroySession(env, request) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return;
  const tokenHash = await sha256Hex((env.SESSION_SECRET || '') + ':' + token);
  await env.STOCK_DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run().catch(() => {});
}

async function requireSession(env, request) {
  return getSession(env, request);
}

/* ------------------------------------------------------------------ */
/* Rate limiting (IP hash only — raw IPs are never stored)             */
/* ------------------------------------------------------------------ */

async function ipHash(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const day = new Date().toISOString().slice(0, 10); // salt rotates daily
  return sha256Hex(ip + '|' + day + '|' + (env.RATE_LIMIT_SALT || 'locallink-stock-default-salt'));
}

async function rateLimit(env, key, limit, windowSec) {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / windowSec) * windowSec;
  const dbKey = `${key}:${windowStart}`;
  try {
    // Drop counters older than a day so the table does not grow forever.
    await env.STOCK_DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(now - 86400).run();
    await env.STOCK_DB.prepare(
      'INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET count = count + 1',
    ).bind(dbKey, windowStart).run();
    const row = await env.STOCK_DB.prepare('SELECT count FROM rate_limits WHERE key = ?').bind(dbKey).first();
    return (row ? row.count : 1) <= limit;
  } catch (e) {
    // If rate limiting itself breaks, fail OPEN for availability but log it.
    console.error('rateLimit error:', e && e.message ? e.message : e);
    return true;
  }
}

async function checkRateLimit(request, env, scope, limit, windowSec) {
  const hash = await ipHash(request, env);
  return rateLimit(env, `${scope}:${hash}`, limit, windowSec);
}

/* ------------------------------------------------------------------ */
/* Security-event logging (IP hash only — raw IPs are never stored)    */
/* Best-effort: a logging failure must never break login.              */
/* ------------------------------------------------------------------ */

async function logSecurityEvent(env, event, request) {
  try {
    const hash = await ipHash(request, env);
    await env.STOCK_DB.prepare(
      'INSERT INTO security_events (event, ip_hash, created_at) VALUES (?, ?, ?)',
    ).bind(event, hash, Date.now()).run();
    // Keep 90 days of history so the table does not grow forever.
    await env.STOCK_DB.prepare(
      'DELETE FROM security_events WHERE created_at < ?',
    ).bind(Date.now() - 90 * 24 * 60 * 60 * 1000).run();
  } catch (e) {
    console.error('logSecurityEvent error:', e && e.message ? e.message : e);
  }
}

/* ------------------------------------------------------------------ */
/* CORS (public stock API only)                                        */
/* ------------------------------------------------------------------ */

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  const headers = { 'Vary': 'Origin' };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

async function handlePublicStock(env, request) {
  const allowed = await checkRateLimit(request, env, 'stock', CONFIG.stockLimitPerMin, 60);
  if (!allowed) return error('ძალიან ბევრი მოთხოვნა — ცოტა ხანში სცადეთ.', 429, corsHeaders(request));
  const out = {};
  for (const p of SLUGS) out[p.slug] = { stock: null, incoming: null };
  const { results } = await env.STOCK_DB.prepare('SELECT slug, stock, incoming FROM stock').all();
  for (const row of results || []) {
    if (SLUG_SET.has(row.slug)) {
      out[row.slug] = {
        stock: row.stock === null || row.stock === undefined ? null : row.stock,
        incoming: row.incoming === null || row.incoming === undefined ? null : row.incoming,
      };
    }
  }
  return json(out, 200, corsHeaders(request));
}

async function handleLogin(env, request) {
  if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
  const allowed = await checkRateLimit(request, env, 'login', CONFIG.loginLimitPerMin, 60);
  if (!allowed) {
    await logSecurityEvent(env, 'login_rate_limited', request);
    return error('ძალიან ბევრი მცდელობა — ცოტა ხანში სცადეთ.', 429);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return error('არასწორი მონაცემები.', 400);
  }
  const password = body && typeof body.password === 'string' ? body.password : '';
  // Unset hash → the SAME generic 401 as a wrong password: the response
  // must not reveal whether the admin password is configured.
  const ok = env.ADMIN_PASSWORD_HASH
    ? await verifyPassword(password, env.ADMIN_PASSWORD_HASH)
    : false;
  if (!ok) {
    await logSecurityEvent(env, 'login_failed', request);
    return error('არასწორი პაროლი.', 401);
  }
  const { token, expiresAt } = await createSession(env);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token, expiresAt, isHttps(request)) });
}

async function handleLogout(env, request) {
  if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
  await destroySession(env, request);
  return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(isHttps(request)) });
}

async function handleSession(env, request) {
  const session = await requireSession(env, request);
  if (!session) return error('შესვლა საჭიროა.', 401);
  return json({ ok: true });
}

async function handleAdminStockGet(env, request) {
  const session = await requireSession(env, request);
  if (!session) return error('შესვლა საჭიროა.', 401);
  const out = {};
  for (const p of SLUGS) out[p.slug] = { stock: null, incoming: null, updated_at: null };
  const { results } = await env.STOCK_DB.prepare('SELECT slug, stock, incoming, updated_at FROM stock').all();
  for (const row of results || []) {
    if (SLUG_SET.has(row.slug)) {
      out[row.slug] = {
        stock: row.stock === null || row.stock === undefined ? null : row.stock,
        incoming: row.incoming === null || row.incoming === undefined ? null : row.incoming,
        updated_at: row.updated_at,
      };
    }
  }
  return json(out);
}

function parseQty(v) {
  if (v === null || v === undefined || v === '') return { ok: true, value: null };
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > CONFIG.maxQty) return { ok: false };
  return { ok: true, value: v };
}

async function handleAdminStockPost(env, request) {
  if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
  const session = await requireSession(env, request);
  if (!session) return error('შესვლა საჭიროა.', 401);
  let body;
  try {
    body = await request.json();
  } catch {
    return error('არასწორი მონაცემები.', 400);
  }
  const slug = body && body.slug;
  if (typeof slug !== 'string' || !SLUG_SET.has(slug)) return error('არასწორი პროდუქტი.', 400);
  const stock = parseQty(body.stock);
  const incoming = parseQty(body.incoming);
  if (!stock.ok || !incoming.ok) return error('რაოდენობა უნდა იყოს მთელი რიცხვი 0–99999 ან ცარიელი.', 400);
  await env.STOCK_DB.prepare(
    'INSERT INTO stock (slug, stock, incoming, updated_at) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(slug) DO UPDATE SET stock = excluded.stock, incoming = excluded.incoming, updated_at = excluded.updated_at',
  ).bind(slug, stock.value, incoming.value, Date.now()).run();
  return json({ ok: true, slug, stock: stock.value, incoming: incoming.value });
}

async function handleSecurityEvents(env, request) {
  const session = await requireSession(env, request);
  if (!session) return error('შესვლა საჭიროა.', 401);
  const { results } = await env.STOCK_DB.prepare(
    'SELECT event, ip_hash, created_at FROM security_events ORDER BY id DESC LIMIT 50',
  ).all();
  // Only a truncated hash leaves the server — enough to correlate, nothing more.
  return json({
    events: (results || []).map((r) => ({
      event: r.event,
      ip: String(r.ip_hash).slice(0, 12),
      created_at: r.created_at,
    })),
  });
}

/* ------------------------------------------------------------------ */
/* Admin page (one self-contained page, no external assets)            */
/* NOTE: the inline <script> below must not contain backticks or ${ } */
/* sequences — it lives inside a JS template literal.                  */
/* ------------------------------------------------------------------ */

function adminRowsHtml() {
  return SLUGS.map((p) =>
    '<div class="card" data-row="' + p.slug + '">' +
      '<h2>' + p.name + '</h2>' +
      '<div class="row"><label>მარაგშია (ცალი)</label>' +
        '<span class="stepper"><button type="button" data-step="-1" aria-label="−">−</button>' +
        '<input class="stock-input" type="number" inputmode="numeric" min="0" max="99999" placeholder="—">' +
        '<button type="button" data-step="1" aria-label="+">+</button></span>' +
      '</div>' +
      '<div class="row"><label>მალე დაემატება (ცალი)</label>' +
        '<input class="num incoming-input" type="number" inputmode="numeric" min="0" max="99999" placeholder="—">' +
      '</div>' +
      '<button class="btn" type="button" data-save>შენახვა</button>' +
      '<span class="saved" hidden>შენახულია ✓</span>' +
    '</div>',
  ).join('');
}

function adminPage() {
  const html = `<!DOCTYPE html>
<html lang="ka">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>მარაგი — locallink</title>
<style>
:root{--bg:#0A0D14;--surface:#17243B;--surface2:#1C2C48;--accent:#3978FF;--text:#F2F5FA;--muted:#9AA9C2;--border:rgba(255,255,255,.09)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;font-size:16px;line-height:1.5}
.container{max-width:560px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:24px;margin:0}
.sub{color:var(--muted);font-size:14px;margin:6px 0 24px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:18px;margin-bottom:14px}
.card h2{font-size:17px;margin:0 0 12px}
.row{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;margin-bottom:12px}
.row label{font-size:14px;color:var(--muted)}
.row .num{max-width:150px;justify-self:end}
.stepper{display:inline-flex;align-items:center;border:1px solid var(--border);border-radius:999px;overflow:hidden}
.stepper button{width:40px;height:40px;border:0;background:var(--surface2);color:var(--text);font-size:20px;cursor:pointer}
.stepper input{width:64px;text-align:center;background:var(--bg);border:0;color:var(--text);padding:10px 4px;font-size:16px;font-weight:700;-moz-appearance:textfield}
.stepper input::-webkit-outer-spin-button,.stepper input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.num{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:10px;color:var(--text);padding:11px 13px}
.btn{display:inline-flex;align-items:center;justify-content:center;background:var(--accent);color:#fff;border:1px solid var(--accent);border-radius:10px;padding:11px 20px;font-weight:700;font-size:15px;cursor:pointer}
.btn:disabled{opacity:.6;cursor:wait}
.btn-outline{background:transparent;border-color:rgba(255,255,255,.25);color:var(--text)}
.btn-block{width:100%}
.saved{color:#7ddb8a;font-size:13px;font-weight:600;margin-left:10px}
.saved[hidden]{display:none}
.err{background:rgba(255,107,107,.12);border:1px solid rgba(255,107,107,.5);border-radius:10px;padding:11px 13px;font-size:14px;font-weight:600;margin-bottom:14px}
.err[hidden]{display:none}
.topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
input[type=password]{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:10px;color:var(--text);padding:11px 13px;margin-bottom:12px}
label.fl{display:block;font-weight:600;font-size:14px;margin-bottom:6px}
.evt{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid var(--border);font-size:14px}
.evt:first-child{border-top:0}
.evt code{color:var(--muted);font-size:12px;word-break:break-all}
.evt .etime{color:var(--muted);font-size:12px;white-space:nowrap}
</style>
</head>
<body>
<div class="container">
  <div id="login-view">
    <h1>მარაგის მართვა</h1>
    <p class="sub">locallink მაღაზიის მარაგი</p>
    <div class="card">
      <form id="login-form">
        <label class="fl" for="pw">ადმინ პაროლი</label>
        <input type="password" id="pw" autocomplete="current-password" required>
        <div class="err" id="login-err" hidden></div>
        <button class="btn btn-block" type="submit">შესვლა</button>
      </form>
    </div>
  </div>
  <div id="panel-view" hidden>
    <div class="topbar"><h1>მარაგი</h1><button class="btn btn-outline" id="logout-btn" type="button">გასვლა</button></div>
    <p class="sub">ცარიელი ველი = რაოდენობა არ ჩანს მაღაზიაში.</p>
    <div id="rows">${adminRowsHtml()}</div>
    <div class="card">
      <h2>უსაფრთხოების მოვლენები</h2>
      <div id="sec-events"><p class="sub">იტვირთება…</p></div>
    </div>
  </div>
</div>
<script>
(function () {
  var loginView = document.getElementById('login-view');
  var panelView = document.getElementById('panel-view');
  var loginForm = document.getElementById('login-form');
  var loginErr = document.getElementById('login-err');
  var pwInput = document.getElementById('pw');

  function showPanel() { loginView.hidden = true; panelView.hidden = false; }
  function showLogin() { panelView.hidden = true; loginView.hidden = false; pwInput.value = ''; }

  function loadStock() {
    return fetch('/api/admin/stock').then(function (res) {
      if (!res.ok) throw new Error('auth');
      return res.json();
    }).then(function (data) {
      var rows = document.querySelectorAll('[data-row]');
      for (var i = 0; i < rows.length; i++) {
        var slug = rows[i].getAttribute('data-row');
        var e = data[slug] || {};
        var s = rows[i].querySelector('.stock-input');
        var inc = rows[i].querySelector('.incoming-input');
        s.value = (e.stock === null || e.stock === undefined) ? '' : String(e.stock);
        inc.value = (e.incoming === null || e.incoming === undefined) ? '' : String(e.incoming);
      }
    });
  }

  function checkSession() {
    fetch('/api/admin/session').then(function (res) {
      if (res.ok) { showPanel(); loadSecEvents(); return loadStock(); }
      showLogin();
    }).catch(function () { showLogin(); });
  }

  function loadSecEvents() {
    fetch('/api/admin/security-events').then(function (res) {
      if (!res.ok) throw new Error('sec');
      return res.json();
    }).then(function (data) {
      var box = document.getElementById('sec-events');
      var evts = (data && data.events) || [];
      if (!evts.length) { box.innerHTML = '<p class="sub">მოვლენები არ არის.</p>'; return; }
      var labels = { login_failed: 'წარუმატებელი შესვლა', login_rate_limited: 'შესვლის ლიმიტი ამოიწურა' };
      var out = '';
      for (var i = 0; i < evts.length; i++) {
        var e = evts[i];
        var when = new Date(e.created_at).toLocaleString('ka-GE');
        out += '<div class="evt"><span>' + (labels[e.event] || 'უცნობი მოვლენა') + ' <code>' + e.ip + '</code></span><span class="etime">' + when + '</span></div>';
      }
      box.innerHTML = out;
    }).catch(function () {
      document.getElementById('sec-events').innerHTML = '<p class="sub">ვერ ჩაიტვირთა.</p>';
    });
  }

  loginForm.addEventListener('submit', function (e) {
    e.preventDefault();
    loginErr.hidden = true;
    fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwInput.value })
    }).then(function (res) {
      if (!res.ok) throw new Error('login');
      showPanel();
      loadSecEvents();
      return loadStock();
    }).catch(function () {
      loginErr.textContent = 'არასწორი პაროლი. სცადეთ თავიდან.';
      loginErr.hidden = false;
    });
  });

  document.getElementById('logout-btn').addEventListener('click', function () {
    fetch('/api/admin/logout', { method: 'POST' }).then(function () { showLogin(); }).catch(function () { showLogin(); });
  });

  document.addEventListener('click', function (e) {
    var stepBtn = e.target.closest ? e.target.closest('[data-step]') : null;
    if (stepBtn) {
      var row = stepBtn.closest('[data-row]');
      var input = row.querySelector('.stock-input');
      var cur = parseInt(input.value, 10);
      if (isNaN(cur)) cur = 0;
      cur += parseInt(stepBtn.getAttribute('data-step'), 10);
      if (cur < 0) cur = 0;
      if (cur > 99999) cur = 99999;
      input.value = String(cur);
      return;
    }
    var saveBtn = e.target.closest ? e.target.closest('[data-save]') : null;
    if (saveBtn) {
      var row2 = saveBtn.closest('[data-row]');
      var slug = row2.getAttribute('data-row');
      var sVal = row2.querySelector('.stock-input').value.trim();
      var iVal = row2.querySelector('.incoming-input').value.trim();
      var stock = sVal === '' ? null : parseInt(sVal, 10);
      var incoming = iVal === '' ? null : parseInt(iVal, 10);
      if ((stock !== null && (isNaN(stock) || stock < 0 || stock > 99999)) ||
          (incoming !== null && (isNaN(incoming) || incoming < 0 || incoming > 99999))) {
        return;
      }
      saveBtn.disabled = true;
      fetch('/api/admin/stock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: slug, stock: stock, incoming: incoming })
      }).then(function (res) {
        saveBtn.disabled = false;
        if (!res.ok) throw new Error('save');
        var saved = row2.querySelector('.saved');
        saved.hidden = false;
        setTimeout(function () { saved.hidden = true; }, 2000);
      }).catch(function () {
        saveBtn.disabled = false;
      });
    }
  });

  checkSession();
})();
</script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'",
      ...SECURITY_HEADERS,
    },
  });
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Force HTTPS in production; localhost is exempt so local dev and
    // the offline harness keep working over plain http.
    if (url.protocol === 'http:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') {
      return Response.redirect('https://' + url.host + url.pathname + url.search, 301);
    }

    try {
      await ensureSchema(env);
    } catch (e) {
      return error('მონაცემთა ბაზის შეცდომა.', 500);
    }

    if (path === '/' && request.method === 'GET') {
      return json({ ok: true, service: 'locallink-stock' });
    }

    if (path === '/admin' && request.method === 'GET') {
      return adminPage();
    }

    if (path === '/api/stock' && request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(request),
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
          ...SECURITY_HEADERS,
        },
      });
    }
    if (path === '/api/stock' && request.method === 'GET') {
      return handlePublicStock(env, request);
    }

    if (path === '/api/admin/login' && request.method === 'POST') {
      return handleLogin(env, request);
    }
    if (path === '/api/admin/logout' && request.method === 'POST') {
      return handleLogout(env, request);
    }
    if (path === '/api/admin/session' && request.method === 'GET') {
      return handleSession(env, request);
    }
    if (path === '/api/admin/stock' && request.method === 'GET') {
      return handleAdminStockGet(env, request);
    }
    if (path === '/api/admin/stock' && request.method === 'POST') {
      return handleAdminStockPost(env, request);
    }
    if (path === '/api/admin/security-events' && request.method === 'GET') {
      return handleSecurityEvents(env, request);
    }

    return error('ვერ მოიძებნა.', 404);
  },
};
