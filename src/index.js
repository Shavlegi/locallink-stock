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
 * in sync. It has three tabs: stock management, the quote calculator
 * (client cards with chosen services/products and totals), and service
 * price editing (overrides + optional sale prices that the shop picks up
 * via GET /api/prices; the discount % is computed from the two prices).
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

// Calculator catalog — the single source of truth for the admin quote
// builder. Prices MUST match ~/workspace/your_files/localboost-services-prices.md
// and the shop's services section. `editable` = "from" price: the admin
// types the agreed amount. `monthly` = recurring price, totaled separately.
const CATALOG = [
  { id: 'gbp-create', group: 'Google Business პროფილი', name: 'პროფილის შექმნა', price: 10, monthly: false, editable: false },
  { id: 'gbp-fill', group: 'Google Business პროფილი', name: 'სრულად შევსება', price: 20, monthly: false, editable: false },
  { id: 'gbp-verify', group: 'Google Business პროფილი', name: 'ვერიფიკაციის მოთხოვნის გამზადება', price: 30, monthly: false, editable: false },
  { id: 'gbp-all', group: 'Google Business პროფილი', name: 'სამივე ერთად', price: 50, monthly: false, editable: false },
  { id: 'fb-page', group: 'სოციალური ქსელები', name: 'Facebook გვერდი (+ 1 პოსტი საჩუქრად)', price: 10, monthly: false, editable: false },
  { id: 'ig-page', group: 'სოციალური ქსელები', name: 'Instagram გვერდი (+ 1 პოსტი საჩუქრად)', price: 10, monthly: false, editable: false },
  { id: 'site-build', group: 'ვებსაიტები', name: 'ვებსაიტის აწყობა', price: 50, monthly: false, editable: true },
  { id: 'domain', group: 'ვებსაიტები', name: 'დომენი (ცალკე)', price: 5, monthly: false, editable: true },
  { id: 'menu-site', group: 'ვებსაიტები', name: 'მენიუს საიტი (QR უფასოდ)', price: 50, monthly: false, editable: true },
  { id: 'site-update', group: 'ვებსაიტები', name: 'ერთჯერადი განახლება (1 ცვლილება)', price: 15, monthly: false, editable: false },
  { id: 'site-page', group: 'ვებსაიტები', name: 'ახალი გვერდი/სექცია', price: 20, monthly: false, editable: true },
  { id: 'site-redesign', group: 'ვებსაიტები', name: 'დიზაინის სრული შეცვლა', price: 50, monthly: false, editable: true },
  { id: 'logo', group: 'დიზაინი და ფოტო', name: 'ბიზნესის ლოგო', price: 10, monthly: false, editable: false },
  { id: 'banner', group: 'დიზაინი და ფოტო', name: 'ბანერი', price: 5, monthly: false, editable: true },
  { id: 'photo-edit', group: 'დიზაინი და ფოტო', name: 'ფოტოს დამუშავება (1 ფოტო)', price: 3, monthly: false, editable: true },
  { id: 'qr-wifi', group: 'QR კოდები', name: 'Wi-Fi QR სტიკერი', price: 5, monthly: false, editable: false },
  { id: 'qr-vcard', group: 'QR კოდები', name: 'ვიზიტკის QR', price: 5, monthly: false, editable: false },
  { id: 'wa-setup', group: 'WhatsApp და Google პოსტები', name: 'WhatsApp Business-ის დაყენება', price: 30, monthly: false, editable: false },
  { id: 'gpost-one', group: 'WhatsApp და Google პოსტები', name: 'Google პოსტი (1 ცალი)', price: 10, monthly: false, editable: false },
  { id: 'm-reviews', group: 'ყოველთვიური მომსახურება', name: 'შეფასებებზე პასუხები', price: 30, monthly: true, editable: false },
  { id: 'm-posts', group: 'ყოველთვიური მომსახურება', name: 'Google პოსტები (4 ცალი)', price: 25, monthly: true, editable: false },
  { id: 'm-care', group: 'ყოველთვიური მომსახურება', name: 'საიტის მოვლა', price: 25, monthly: true, editable: false },
  { id: 'call-day', group: 'სასწრაფო გამოძახება', name: 'გამოძახება 10:00–18:00', price: 20, monthly: false, editable: false },
  { id: 'call-247', group: 'სასწრაფო გამოძახება', name: 'გამოძახება 24/7', price: 30, monthly: false, editable: false },
  { id: 'vip1', group: 'VIP მომსახურება', name: 'VIP 1 — 10 ვიზიტამდე', price: 99, monthly: true, editable: false },
  { id: 'vip2', group: 'VIP მომსახურება', name: 'VIP 2 — 20 ვიზიტამდე', price: 149, monthly: true, editable: false },
  { id: 'prod-sticker-black', group: 'NFC პროდუქტები', name: 'NFC სტიკერი — შავი', price: 15, monthly: false, editable: false },
  { id: 'prod-sticker-white', group: 'NFC პროდუქტები', name: 'NFC სტიკერი — თეთრი', price: 15, monthly: false, editable: false },
  { id: 'prod-nfc-card', group: 'NFC პროდუქტები', name: 'ორფხრივი NFC ბარათი', price: 40, monthly: false, editable: false },
  { id: 'prod-nfc-stand', group: 'NFC პროდუქტები', name: 'NFC სტენდი', price: 50, monthly: false, editable: false },
  { id: 'prod-photo-stand', group: 'NFC პროდუქტები', name: 'სტენდი ჩასასმელი ფოტოთი', price: 60, monthly: false, editable: false },
];
const CATALOG_MAP = new Map(CATALOG.map((c) => [c.id, c]));

// Price overrides apply to SERVICES ONLY — never to NFC products
// (prod-* ids keep their fixed catalog prices).
const SERVICE_CATALOG = CATALOG.filter((c) => !c.id.startsWith('prod-'));
const SERVICE_ID_SET = new Set(SERVICE_CATALOG.map((c) => c.id));

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
  // v3: quotes — saved calculator cards (client + chosen items + totals).
  try {
    const flag3 = await env.STOCK_DB.prepare(
      "SELECT value FROM schema_meta WHERE key = 'v3_quotes'",
    ).first();
    if (!flag3 || flag3.value !== '1') {
      await env.STOCK_DB.batch([
        env.STOCK_DB.prepare(
          'CREATE TABLE IF NOT EXISTS quotes (' +
          'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
          'first_name TEXT NOT NULL, ' +
          "last_name TEXT NOT NULL DEFAULT '', " +
          "phone TEXT NOT NULL DEFAULT '', " +
          "note TEXT NOT NULL DEFAULT '', " +
          'items TEXT NOT NULL, ' +
          'total_once INTEGER NOT NULL, ' +
          'total_monthly INTEGER NOT NULL, ' +
          'created_at INTEGER NOT NULL)',
        ),
        env.STOCK_DB.prepare(
          "INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('v3_quotes', '1')",
        ),
      ]);
    }
  } catch (e) {
    console.error('ensureSchema v3 error:', e && e.message ? e.message : e);
  }
  // v4: price_overrides — admin-edited service prices. CATALOG holds the
  // defaults; a row here wins. The shop fetches GET /api/prices.
  try {
    const flag4 = await env.STOCK_DB.prepare(
      "SELECT value FROM schema_meta WHERE key = 'v4_price_overrides'",
    ).first();
    if (!flag4 || flag4.value !== '1') {
      await env.STOCK_DB.batch([
        env.STOCK_DB.prepare(
          'CREATE TABLE IF NOT EXISTS price_overrides (' +
          'id TEXT PRIMARY KEY, ' +
          'price INTEGER NOT NULL, ' +
          'updated_at INTEGER NOT NULL)',
        ),
        env.STOCK_DB.prepare(
          "INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('v4_price_overrides', '1')",
        ),
      ]);
    }
  } catch (e) {
    console.error('ensureSchema v4 error:', e && e.message ? e.message : e);
  }
  // v5: discounts — optional per-service sale prices. The discount % is
  // computed from the effective base price and the sale price, never
  // stored. Services only, like price overrides.
  try {
    const flag5 = await env.STOCK_DB.prepare(
      "SELECT value FROM schema_meta WHERE key = 'v5_discounts'",
    ).first();
    if (!flag5 || flag5.value !== '1') {
      await env.STOCK_DB.batch([
        env.STOCK_DB.prepare(
          'CREATE TABLE IF NOT EXISTS discounts (' +
          'id TEXT PRIMARY KEY, ' +
          'sale_price INTEGER NOT NULL, ' +
          'updated_at INTEGER NOT NULL)',
        ),
        env.STOCK_DB.prepare(
          "INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('v5_discounts', '1')",
        ),
      ]);
    }
  } catch (e) {
    console.error('ensureSchema v5 error:', e && e.message ? e.message : e);
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
/* CORS (public stock + prices APIs)                                   */
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
/* Calculator (quotes)                                                 */
/* ------------------------------------------------------------------ */

async function handleCatalog(env, request) {
  const session = await requireSession(env, request);
  if (!session) return error('შესვლა საჭიროა.', 401);
  const items = await effectiveCatalog(env);
  return json({
    items: items.map((c) => ({
      id: c.id,
      group: c.group,
      name: c.name,
      price: c.price,
      monthly: c.monthly,
      editable: c.editable,
      salePrice: c.salePrice,
      discountPct: c.discountPct,
    })),
  });
}

function cleanText(v, maxLen) {
  if (typeof v !== 'string') return '';
  const t = v.trim().replace(/\s+/g, ' ');
  return t.slice(0, maxLen);
}

// Validates a quote body and returns the snapshot items + totals, or null.
// catalogMap maps ids to catalog entries with EFFECTIVE prices.
function buildQuoteItems(bodyItems, catalogMap) {
  if (!Array.isArray(bodyItems) || bodyItems.length < 1 || bodyItems.length > 50) return null;
  const seen = new Set();
  const items = [];
  let totalOnce = 0;
  let totalMonthly = 0;
  for (const raw of bodyItems) {
    if (!raw || typeof raw !== 'object') return null;
    const entry = catalogMap.get(raw.id);
    if (!entry || seen.has(raw.id)) return null;
    seen.add(raw.id);
    const qty = raw.qty;
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1 || qty > 99) return null;
    // Always the EFFECTIVE catalog price — client-sent prices are ignored
    // completely. Price editing lives ONLY in the Prices tab. When the
    // service is discounted, the sale price is what the client pays.
    const price = (entry.salePrice === null || entry.salePrice === undefined)
      ? entry.price
      : entry.salePrice;
    items.push({ id: entry.id, name: entry.name, qty, price, monthly: entry.monthly });
    if (entry.monthly) totalMonthly += price * qty;
    else totalOnce += price * qty;
  }
  // The bundle and its parts are mutually exclusive — never count both.
  if (seen.has('gbp-all') && (seen.has('gbp-create') || seen.has('gbp-fill') || seen.has('gbp-verify'))) return null;
  return { items, totalOnce, totalMonthly };
}

async function handleQuotesGet(env, request) {
  const session = await requireSession(env, request);
  if (!session) return error('შესვლა საჭიროა.', 401);
  const { results } = await env.STOCK_DB.prepare(
    'SELECT id, first_name, last_name, phone, note, items, total_once, total_monthly, created_at FROM quotes ORDER BY id DESC LIMIT 200',
  ).all();
  return json({
    quotes: (results || []).map((r) => {
      let items = [];
      try {
        items = JSON.parse(r.items);
        if (!Array.isArray(items)) items = [];
      } catch {
        items = [];
      }
      return {
        id: r.id,
        first_name: r.first_name,
        last_name: r.last_name,
        phone: r.phone,
        note: r.note,
        items,
        total_once: r.total_once,
        total_monthly: r.total_monthly,
        created_at: r.created_at,
      };
    }),
  });
}

async function handleQuotesPost(env, request) {
  if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
  const session = await requireSession(env, request);
  if (!session) return error('შესვლა საჭიროა.', 401);
  let body;
  try {
    body = await request.json();
  } catch {
    return error('არასწორი მონაცემები.', 400);
  }
  const firstName = cleanText(body && body.first_name, 100);
  if (!firstName) return error('სახელი აუცილებელია.', 400);
  const lastName = cleanText(body && body.last_name, 100);
  const phone = cleanText(body && body.phone, 50);
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : '';
  const effective = await effectiveCatalog(env);
  const effMap = new Map(effective.map((c) => [c.id, c]));
  const built = buildQuoteItems(body && body.items, effMap);
  if (!built) return error('აირჩიეთ მინიმუმ ერთი პუნქტი სწორი რაოდენობითა და ფასით.', 400);
  const res = await env.STOCK_DB.prepare(
    'INSERT INTO quotes (first_name, last_name, phone, note, items, total_once, total_monthly, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(firstName, lastName, phone, note, JSON.stringify(built.items), built.totalOnce, built.totalMonthly, Date.now()).run();
  const id = res && res.meta ? res.meta.last_row_id : null;
  return json({ ok: true, id, total_once: built.totalOnce, total_monthly: built.totalMonthly });
}

async function handleQuoteDelete(env, request, id) {
  if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
  const session = await requireSession(env, request);
  if (!session) return error('შესვლა საჭიროა.', 401);
  const res = await env.STOCK_DB.prepare('DELETE FROM quotes WHERE id = ?').bind(id).run();
  const changes = res && res.meta ? res.meta.changes : 0;
  if (!changes) return error('ბარათი ვერ მოიძებნა.', 404);
  return json({ ok: true, id });
}

/* ------------------------------------------------------------------ */
/* Price overrides (admin-editable service prices)                     */
/* CATALOG holds the defaults; an override row wins. The shop fetches  */
/* GET /api/prices and merges overrides over its built-in prices.      */
/* ------------------------------------------------------------------ */

async function loadOverrides(env) {
  const { results } = await env.STOCK_DB.prepare('SELECT id, price FROM price_overrides').all();
  const map = new Map();
  for (const row of results || []) {
    if (SERVICE_ID_SET.has(row.id) && Number.isInteger(row.price)) map.set(row.id, row.price);
  }
  return map;
}

async function loadDiscounts(env) {
  const { results } = await env.STOCK_DB.prepare('SELECT id, sale_price FROM discounts').all();
  const map = new Map();
  for (const row of results || []) {
    if (SERVICE_ID_SET.has(row.id) && Number.isInteger(row.sale_price)) map.set(row.id, row.sale_price);
  }
  return map;
}

// Discount % is COMPUTED from the base price and the sale price (whole
// percent, rounded). No % is ever stored or accepted as input. A zero
// base price cannot have a discount.
function discountPctFor(base, sale) {
  if (!Number.isInteger(base) || !Number.isInteger(sale)) return null;
  if (base <= 0 || sale < 0 || sale >= base) return null;
  return Math.round(((base - sale) / base) * 100);
}

async function effectiveCatalog(env) {
  const overrides = await loadOverrides(env);
  const discounts = await loadDiscounts(env);
  return CATALOG.map((c) => {
    const price = overrides.has(c.id) ? overrides.get(c.id) : c.price;
    const salePrice = discounts.has(c.id) ? discounts.get(c.id) : null;
    return {
      id: c.id,
      group: c.group,
      name: c.name,
      price,
      monthly: c.monthly,
      editable: c.editable,
      salePrice,
      discountPct: salePrice === null ? null : discountPctFor(price, salePrice),
    };
  });
}

async function handlePublicPrices(env, request) {
  const allowed = await checkRateLimit(request, env, 'prices', CONFIG.stockLimitPerMin, 60);
  if (!allowed) return error('ძალიან ბევრი მოთხოვნა — ცოტა ხანში სცადეთ.', 429, corsHeaders(request));
  const overrides = await loadOverrides(env);
  const out = {};
  for (const [id, price] of overrides) out[id] = price;
  const discounts = await loadDiscounts(env);
  const disc = {};
  for (const [id, salePrice] of discounts) disc[id] = salePrice;
  return json({ prices: out, discounts: disc }, 200, corsHeaders(request));
}

async function handleAdminPricesGet(env, request) {
  const session = await requireSession(env, request);
  if (!session) return error('შესვლა საჭიროა.', 401);
  const overrides = await loadOverrides(env);
  const discounts = await loadDiscounts(env);
  return json({
    items: SERVICE_CATALOG.map((c) => {
      const price = overrides.has(c.id) ? overrides.get(c.id) : c.price;
      const salePrice = discounts.has(c.id) ? discounts.get(c.id) : null;
      return {
        id: c.id,
        group: c.group,
        name: c.name,
        price,
        defaultPrice: c.price,
        monthly: c.monthly,
        editable: c.editable,
        overridden: overrides.has(c.id),
        salePrice,
        discountPct: salePrice === null ? null : discountPctFor(price, salePrice),
      };
    }),
  });
}

async function handleAdminPricesPost(env, request) {
  if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
  const session = await requireSession(env, request);
  if (!session) return error('შესვლა საჭიროა.', 401);
  let body;
  try {
    body = await request.json();
  } catch {
    return error('არასწორი მონაცემები.', 400);
  }
  const id = body && body.id;
  if (typeof id !== 'string' || !SERVICE_ID_SET.has(id)) return error('არასწორი სერვისი.', 400);
  const price = body && body.price;
  if (typeof price !== 'number' || !Number.isInteger(price) || price < 0 || price > CONFIG.maxQty) {
    return error('ფასი უნდა იყოს მთელი რიცხვი 0–99999.', 400);
  }
  // Sale price: null or omitted clears the discount. Otherwise it must be
  // a whole number strictly below the price being saved, and the price
  // must be above zero (a 0₾ service cannot be discounted).
  const saleRaw = body ? body.sale_price : undefined;
  let salePrice = null;
  if (saleRaw !== null && saleRaw !== undefined) {
    if (typeof saleRaw !== 'number' || !Number.isInteger(saleRaw) || saleRaw < 0 || saleRaw > CONFIG.maxQty) {
      return error('ფასდაკლების ფასი უნდა იყოს მთელი რიცხვი 0–99999.', 400);
    }
    if (price <= 0 || saleRaw >= price) {
      return error('ფასდაკლების ფასი ფასზე ნაკლები უნდა იყოს.', 400);
    }
    salePrice = saleRaw;
  }
  const entry = CATALOG_MAP.get(id);
  let overridden;
  if (price === entry.price) {
    // Saving the default removes the override.
    await env.STOCK_DB.prepare('DELETE FROM price_overrides WHERE id = ?').bind(id).run();
    overridden = false;
  } else {
    await env.STOCK_DB.prepare(
      'INSERT INTO price_overrides (id, price, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET price = excluded.price, updated_at = excluded.updated_at',
    ).bind(id, price, Date.now()).run();
    overridden = true;
  }
  if (salePrice === null) {
    await env.STOCK_DB.prepare('DELETE FROM discounts WHERE id = ?').bind(id).run();
  } else {
    await env.STOCK_DB.prepare(
      'INSERT INTO discounts (id, sale_price, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET sale_price = excluded.sale_price, updated_at = excluded.updated_at',
    ).bind(id, salePrice, Date.now()).run();
  }
  return json({
    ok: true,
    id,
    price,
    overridden,
    salePrice,
    discountPct: salePrice === null ? null : discountPctFor(price, salePrice),
  });
}

async function handlePriceDelete(env, request, id) {
  if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
  const session = await requireSession(env, request);
  if (!session) return error('შესვლა საჭიროა.', 401);
  await env.STOCK_DB.prepare('DELETE FROM price_overrides WHERE id = ?').bind(id).run();
  await env.STOCK_DB.prepare('DELETE FROM discounts WHERE id = ?').bind(id).run();
  return json({ ok: true, id, price: CATALOG_MAP.get(id).price, salePrice: null, discountPct: null });
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
.tabs{display:flex;gap:8px;margin-bottom:18px}
.tab{flex:1;background:var(--surface);border:1px solid var(--border);border-radius:999px;color:var(--muted);padding:11px;font-weight:700;font-size:15px;cursor:pointer}
.tab.active{background:var(--accent);border-color:var(--accent);color:#fff}
.field{margin-bottom:12px}
.field label{display:block;font-weight:600;font-size:14px;margin-bottom:6px}
.field input,.field textarea{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:10px;color:var(--text);padding:11px 13px;font-size:16px;font-family:inherit}
.field textarea{resize:vertical;min-height:64px}
.calc-group{margin-bottom:18px}
.calc-group h3{font-size:13px;margin:0 0 4px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.calc-item{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;padding:9px 0;border-top:1px solid var(--border);cursor:pointer}
.calc-item:first-of-type{border-top:0}
.calc-item input[type=checkbox]{width:20px;height:20px;accent-color:var(--accent);cursor:pointer}
.calc-item .nm{font-size:15px}
.calc-ctl{display:flex;gap:6px;align-items:center}
.calc-ctl .qty-input{display:none}
.calc-item.on .calc-ctl .qty-input{display:block}
.calc-ctl input[type=number]{width:62px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:8px 6px;font-size:15px;text-align:center;-moz-appearance:textfield}
.calc-ctl input[type=number]::-webkit-outer-spin-button,.calc-ctl input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.calc-ctl .pr{font-weight:700;white-space:nowrap;font-size:15px;min-width:52px;text-align:right}
.calc-ctl .pr s{color:var(--muted);font-weight:400}
.calc-ctl .disc{color:#f5c86b;font-weight:700}
.totals{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:16px 0}
.total-box{background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:12px;text-align:center}
.total-box span{display:block;font-size:12px;color:var(--muted)}
.total-box strong{font-size:20px}
.quote-head{display:flex;justify-content:space-between;gap:10px;align-items:baseline}
.quote-head h2{margin:0}
.quote-meta{color:var(--muted);font-size:14px;margin:4px 0 10px}
.quote-meta a{color:var(--text);font-weight:600}
.quote-note{font-size:14px;color:var(--muted);margin:0 0 10px;white-space:pre-wrap;word-break:break-word}
.quote-items{margin:0 0 10px;padding:0;list-style:none;font-size:14px}
.quote-items li{display:flex;justify-content:space-between;gap:10px;padding:5px 0;border-top:1px solid var(--border)}
.quote-items li:first-child{border-top:0}
.quote-total{font-weight:700;font-size:15px;margin-bottom:12px}
.quote-date{color:var(--muted);font-size:12px;white-space:nowrap}
.btn-danger{background:#E5484D;border-color:#E5484D;color:#fff}
.price-group{margin-bottom:18px}
.price-group h3{font-size:13px;margin:0 0 4px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.price-row{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;padding:9px 0;border-top:1px solid var(--border)}
.price-row:first-of-type{border-top:0}
.price-row .nm{font-size:15px}
.price-row .nm small{display:block;color:var(--muted);font-size:12px}
.price-row .changed{color:#f5c86b;font-weight:600}
.price-ctl{display:flex;flex-direction:column;gap:6px;align-items:flex-end}
.price-ctl-row{display:flex;gap:6px;align-items:center}
.price-ctl input[type=number]{width:72px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:8px 6px;font-size:15px;text-align:center;-moz-appearance:textfield}
.sale-label{font-size:12px;color:var(--muted);white-space:nowrap}
.sale-pct{color:#f5c86b;font-weight:700;white-space:nowrap;font-size:14px;min-width:46px;text-align:right}
.sale-pct[hidden]{display:none}
.price-ctl input[type=number]::-webkit-outer-spin-button,.price-ctl input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.btn-sm{padding:8px 14px;font-size:14px}
.btn-reset{background:transparent;border-color:rgba(255,255,255,.25);color:var(--muted)}
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
    <div class="topbar"><h1>ადმინ პანელი</h1><button class="btn btn-outline" id="logout-btn" type="button">გასვლა</button></div>
    <div class="tabs">
      <button class="tab active" id="tab-btn-stock" type="button">მარაგი</button>
      <button class="tab" id="tab-btn-calc" type="button">კალკულატორი</button>
      <button class="tab" id="tab-btn-prices" type="button">ფასები</button>
    </div>
    <div id="tab-stock">
      <p class="sub">ცარიელი ველი = რაოდენობა არ ჩანს მაღაზიაში.</p>
      <div id="rows">${adminRowsHtml()}</div>
      <div class="card">
        <h2>უსაფრთხოების მოვლენები</h2>
        <div id="sec-events"><p class="sub">იტვირთება…</p></div>
      </div>
    </div>
    <div id="tab-calc" hidden>
      <div class="card">
        <h2>ახალი ბარათი</h2>
        <div class="field"><label for="q-first">სახელი *</label><input id="q-first" type="text" autocomplete="off"></div>
        <div class="field"><label for="q-last">გვარი</label><input id="q-last" type="text" autocomplete="off"></div>
        <div class="field"><label for="q-phone">ტელეფონის ნომერი</label><input id="q-phone" type="tel" autocomplete="off"></div>
        <div class="field"><label for="q-note">შენიშვნა</label><textarea id="q-note"></textarea></div>
        <div id="calc-items"><p class="sub">იტვირთება…</p></div>
        <div class="totals">
          <div class="total-box"><span>ერთჯერადი ჯამი</span><strong id="total-once">0₾</strong></div>
          <div class="total-box"><span>ყოველთვიური ჯამი</span><strong id="total-monthly">0₾/თვე</strong></div>
        </div>
        <div class="err" id="calc-err" hidden></div>
        <button class="btn btn-block" id="calc-save" type="button">ბარათის შენახვა</button>
      </div>
      <div id="quote-list"></div>
    </div>
    <div id="tab-prices" hidden>
      <p class="sub">ფასის და ფასდაკლების შეცვლა მაშინვე აისახება საიტზე და კალკულატორში.</p>
      <div class="err" id="prices-err" hidden></div>
      <div id="price-rows"><p class="sub">იტვირთება…</p></div>
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

  /* Calculator tabs, form and quote cards. */

  var catalog = null;
  var catalogLoaded = false;
  var quotesLoaded = false;

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function switchTab(which) {
    var btns = {
      stock: document.getElementById('tab-btn-stock'),
      calc: document.getElementById('tab-btn-calc'),
      prices: document.getElementById('tab-btn-prices')
    };
    var tabs = {
      stock: document.getElementById('tab-stock'),
      calc: document.getElementById('tab-calc'),
      prices: document.getElementById('tab-prices')
    };
    var keys = ['stock', 'calc', 'prices'];
    for (var i = 0; i < keys.length; i++) {
      var on = keys[i] === which;
      if (on) btns[keys[i]].classList.add('active'); else btns[keys[i]].classList.remove('active');
      tabs[keys[i]].hidden = !on;
    }
    if (which === 'calc') { loadCatalog(); loadQuotes(); }
    if (which === 'prices') { loadPrices(); }
  }

  function loadCatalog() {
    if (catalogLoaded) return;
    fetch('/api/admin/catalog').then(function (res) {
      if (!res.ok) throw new Error('catalog');
      return res.json();
    }).then(function (data) {
      catalog = data.items || [];
      catalogLoaded = true;
      renderCalcItems();
    }).catch(function () {
      document.getElementById('calc-items').innerHTML = '<p class="sub">ვერ ჩაიტვირთა.</p>';
    });
  }

  function renderCalcItems() {
    var box = document.getElementById('calc-items');
    var groups = [];
    var byGroup = {};
    for (var i = 0; i < catalog.length; i++) {
      var it = catalog[i];
      if (!byGroup[it.group]) { byGroup[it.group] = []; groups.push(it.group); }
      byGroup[it.group].push(it);
    }
    var out = '';
    for (var gi = 0; gi < groups.length; gi++) {
      out += '<div class="calc-group"><h3>' + escHtml(groups[gi]) + '</h3>';
      var items = byGroup[groups[gi]];
      for (var ii = 0; ii < items.length; ii++) {
        var item = items[ii];
        // Static price text only — price editing lives in the Prices tab.
        // A discounted service shows the struck-through base price, the
        // sale price, and the computed % label.
        var suffix = item.monthly ? '/თვე' : (item.editable ? '-დან' : '');
        var hasDisc = item.salePrice !== null && item.salePrice !== undefined && item.price > 0 && item.salePrice < item.price;
        var priceHtml;
        if (hasDisc) {
          var pct = item.discountPct;
          if (pct === null || pct === undefined) pct = Math.round((item.price - item.salePrice) / item.price * 100);
          priceHtml = '<span class="pr"><s>' + item.price + '₾' + suffix + '</s> ' + item.salePrice + '₾' + suffix + ' <span class="disc">−' + pct + '%</span></span>';
        } else {
          priceHtml = '<span class="pr">' + item.price + '₾' + suffix + '</span>';
        }
        out += '<div class="calc-item" data-item="' + item.id + '">' +
          '<input type="checkbox" data-check="' + item.id + '" aria-label="' + escHtml(item.name) + '">' +
          '<span class="nm">' + escHtml(item.name) + '</span>' +
          '<span class="calc-ctl"><input class="qty-input" type="number" inputmode="numeric" min="1" max="99" value="1" data-qty-for="' + item.id + '" aria-label="რაოდენობა">' + priceHtml + '</span>' +
        '</div>';
      }
      out += '</div>';
    }
    box.innerHTML = out;
    updateTotals();
  }

  function selectedItems() {
    var out = [];
    if (!catalog) return out;
    for (var i = 0; i < catalog.length; i++) {
      var item = catalog[i];
      var cb = document.querySelector('[data-check="' + item.id + '"]');
      if (!cb || !cb.checked) continue;
      var qtyEl = document.querySelector('[data-qty-for="' + item.id + '"]');
      var qty = parseInt(qtyEl ? qtyEl.value : '1', 10);
      if (isNaN(qty) || qty < 1) qty = 1;
      if (qty > 99) qty = 99;
      out.push({ id: item.id, qty: qty });
    }
    return out;
  }

  function updateTotals() {
    var sel = selectedItems();
    var once = 0, monthly = 0;
    var map = {};
    for (var i = 0; i < (catalog || []).length; i++) map[catalog[i].id] = catalog[i];
    for (var j = 0; j < sel.length; j++) {
      var entry = map[sel[j].id];
      if (!entry) continue;
      var charge = (entry.salePrice === null || entry.salePrice === undefined) ? entry.price : entry.salePrice;
      if (entry.monthly) monthly += charge * sel[j].qty;
      else once += charge * sel[j].qty;
    }
    document.getElementById('total-once').textContent = once + '₾';
    document.getElementById('total-monthly').textContent = monthly + '₾/თვე';
  }

  /* The "all three together" bundle and its three parts are mutually
     exclusive: checking one side unchecks the other, so the bundle is
     never counted together with a component. */
  var GBP_PARTS = ['gbp-create', 'gbp-fill', 'gbp-verify'];
  function enforceBundle(changedId) {
    var boxes = {};
    var all = document.querySelectorAll('[data-check]');
    for (var i = 0; i < all.length; i++) boxes[all[i].getAttribute('data-check')] = all[i];
    function uncheck(id) {
      var cb = boxes[id];
      if (cb && cb.checked) {
        cb.checked = false;
        var r = cb.closest('.calc-item');
        if (r) r.classList.remove('on');
      }
    }
    if (changedId === 'gbp-all') {
      if (boxes['gbp-all'] && boxes['gbp-all'].checked) {
        uncheck('gbp-create'); uncheck('gbp-fill'); uncheck('gbp-verify');
      }
    } else if (GBP_PARTS.indexOf(changedId) !== -1) {
      if (boxes[changedId] && boxes[changedId].checked) uncheck('gbp-all');
    }
  }

  function loadQuotes() {
    if (quotesLoaded) return;
    fetch('/api/admin/quotes').then(function (res) {
      if (!res.ok) throw new Error('quotes');
      return res.json();
    }).then(function (data) {
      quotesLoaded = true;
      renderQuotes((data && data.quotes) || []);
    }).catch(function () {
      document.getElementById('quote-list').innerHTML = '<p class="sub">ვერ ჩაიტვირთა.</p>';
    });
  }

  function renderQuotes(quotes) {
    var box = document.getElementById('quote-list');
    if (!quotes.length) { box.innerHTML = '<p class="sub">შენახული ბარათები არ არის.</p>'; return; }
    var out = '';
    for (var i = 0; i < quotes.length; i++) {
      var q = quotes[i];
      var fullName = q.first_name + (q.last_name ? ' ' + q.last_name : '');
      var when = new Date(q.created_at).toLocaleString('ka-GE');
      out += '<div class="card"><div class="quote-head"><h2>' + escHtml(fullName) + '</h2><span class="quote-date">' + when + '</span></div>';
      if (q.phone) out += '<p class="quote-meta"><a href="tel:' + escHtml(q.phone.replace(/[^+0-9]/g, '')) + '">' + escHtml(q.phone) + '</a></p>';
      if (q.note) out += '<p class="quote-note">' + escHtml(q.note) + '</p>';
      out += '<ul class="quote-items">';
      for (var j = 0; j < q.items.length; j++) {
        var it = q.items[j];
        out += '<li><span>' + escHtml(it.name) + ' × ' + it.qty + '</span><span>' + (it.price * it.qty) + '₾' + (it.monthly ? '/თვე' : '') + '</span></li>';
      }
      out += '</ul>';
      var totals = [];
      if (q.total_once > 0) totals.push('ერთჯერადი: ' + q.total_once + '₾');
      if (q.total_monthly > 0) totals.push('ყოველთვიური: ' + q.total_monthly + '₾/თვე');
      out += '<p class="quote-total">' + totals.join(' · ') + '</p>';
      out += '<button class="btn btn-danger" type="button" data-del-quote="' + q.id + '">წაშლა</button></div>';
    }
    box.innerHTML = out;
  }

  document.getElementById('tab-btn-stock').addEventListener('click', function () { switchTab('stock'); });
  document.getElementById('tab-btn-calc').addEventListener('click', function () { switchTab('calc'); });

  document.getElementById('calc-items').addEventListener('click', function (e) {
    if (e.target.tagName === 'INPUT') return;
    var row = e.target.closest ? e.target.closest('.calc-item') : null;
    if (!row) return;
    var cb = row.querySelector('[data-check]');
    if (!cb) return;
    cb.checked = !cb.checked;
    if (cb.checked) row.classList.add('on'); else row.classList.remove('on');
    enforceBundle(cb.getAttribute('data-check'));
    updateTotals();
  });

  document.getElementById('calc-items').addEventListener('change', function (e) {
    var cb = e.target.closest ? e.target.closest('[data-check]') : null;
    if (cb) {
      var row = cb.closest('.calc-item');
      if (cb.checked) row.classList.add('on'); else row.classList.remove('on');
      enforceBundle(cb.getAttribute('data-check'));
    }
    updateTotals();
  });

  document.getElementById('calc-items').addEventListener('input', function () { updateTotals(); });

  document.getElementById('calc-save').addEventListener('click', function () {
    var errBox = document.getElementById('calc-err');
    errBox.hidden = true;
    var first = document.getElementById('q-first').value.trim();
    var items = selectedItems();
    if (!first) { errBox.textContent = 'სახელი აუცილებელია.'; errBox.hidden = false; return; }
    if (!items.length) { errBox.textContent = 'აირჩიეთ მინიმუმ ერთი პუნქტი.'; errBox.hidden = false; return; }
    var btn = document.getElementById('calc-save');
    btn.disabled = true;
    fetch('/api/admin/quotes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        first_name: first,
        last_name: document.getElementById('q-last').value.trim(),
        phone: document.getElementById('q-phone').value.trim(),
        note: document.getElementById('q-note').value.trim(),
        items: items
      })
    }).then(function (res) {
      btn.disabled = false;
      if (!res.ok) throw new Error('save');
      document.getElementById('q-first').value = '';
      document.getElementById('q-last').value = '';
      document.getElementById('q-phone').value = '';
      document.getElementById('q-note').value = '';
      var cbs = document.querySelectorAll('[data-check]');
      for (var i = 0; i < cbs.length; i++) {
        cbs[i].checked = false;
        var r = cbs[i].closest('.calc-item');
        if (r) r.classList.remove('on');
      }
      updateTotals();
      quotesLoaded = false;
      loadQuotes();
    }).catch(function () {
      btn.disabled = false;
      errBox.textContent = 'ვერ შეინახა. სცადეთ თავიდან.';
      errBox.hidden = false;
    });
  });

  document.getElementById('quote-list').addEventListener('click', function (e) {
    var del = e.target.closest ? e.target.closest('[data-del-quote]') : null;
    if (!del) return;
    if (!window.confirm('ბარათი წაიშალოს?')) return;
    var id = del.getAttribute('data-del-quote');
    fetch('/api/admin/quotes/' + id, { method: 'DELETE' }).then(function (res) {
      if (!res.ok) throw new Error('del');
      quotesLoaded = false;
      loadQuotes();
    }).catch(function () {});
  });

  /* Prices tab: edit service prices; the shop picks them up via /api/prices. */

  var pricesLoaded = false;

  function loadPrices() {
    if (pricesLoaded) return;
    fetch('/api/admin/prices').then(function (res) {
      if (!res.ok) throw new Error('prices');
      return res.json();
    }).then(function (data) {
      pricesLoaded = true;
      renderPrices((data && data.items) || []);
    }).catch(function () {
      document.getElementById('price-rows').innerHTML = '<p class="sub">ვერ ჩაიტვირთა.</p>';
    });
  }

  function priceRowHint(row) {
    if (row.getAttribute('data-monthly') === '1') return '₾/თვე';
    if (row.getAttribute('data-editable') === '1') return '₾-დან';
    return '₾';
  }

  function refreshPriceRow(row, overridden, hasDiscount) {
    var def = row.getAttribute('data-default');
    var small = row.querySelector('.nm small');
    small.innerHTML = priceRowHint(row) + (overridden ? ' · <span class="changed">შეცვლილი (ნაგულისხმევი: ' + def + '₾)</span>' : '');
    // The reset button clears BOTH the override and the discount, so it
    // shows whenever either one is set.
    row.querySelector('[data-price-reset]').hidden = !(overridden || hasDiscount);
  }

  // Live discount % from the row's current price and sale-price fields.
  // Hidden when the sale field is empty, invalid, or not below the price.
  function refreshSalePct(row) {
    var priceVal = row.querySelector('[data-price-input]').value.trim();
    var saleVal = row.querySelector('[data-sale-input]').value.trim();
    var pctEl = row.querySelector('[data-sale-pct]');
    var price = priceVal === '' ? NaN : parseInt(priceVal, 10);
    var sale = saleVal === '' ? NaN : parseInt(saleVal, 10);
    if (isNaN(price) || isNaN(sale) || price <= 0 || sale < 0 || sale >= price) {
      pctEl.hidden = true;
      pctEl.textContent = '';
      return;
    }
    pctEl.textContent = '−' + Math.round((price - sale) / price * 100) + '%';
    pctEl.hidden = false;
  }

  function renderPrices(items) {
    var box = document.getElementById('price-rows');
    var groups = [];
    var byGroup = {};
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!byGroup[it.group]) { byGroup[it.group] = []; groups.push(it.group); }
      byGroup[it.group].push(it);
    }
    var out = '';
    for (var gi = 0; gi < groups.length; gi++) {
      out += '<div class="price-group"><h3>' + escHtml(groups[gi]) + '</h3>';
      var rows = byGroup[groups[gi]];
      for (var ri = 0; ri < rows.length; ri++) {
        var item = rows[ri];
        var hint = item.monthly ? '₾/თვე' : (item.editable ? '₾-დან' : '₾');
        var hasDisc = item.salePrice !== null && item.salePrice !== undefined;
        var pctHtml = (hasDisc && item.discountPct !== null && item.discountPct !== undefined)
          ? '−' + item.discountPct + '%'
          : '';
        out += '<div class="price-row" data-price-row="' + item.id + '" data-default="' + item.defaultPrice + '" data-monthly="' + (item.monthly ? '1' : '0') + '" data-editable="' + (item.editable ? '1' : '0') + '">' +
          '<span class="nm">' + escHtml(item.name) +
            '<small>' + hint + (item.overridden ? ' · <span class="changed">შეცვლილი (ნაგულისხმევი: ' + item.defaultPrice + '₾)</span>' : '') + '</small></span>' +
          '<span class="price-ctl">' +
            '<span class="price-ctl-row">' +
              '<input type="number" inputmode="numeric" min="0" max="99999" value="' + item.price + '" data-price-input aria-label="ფასი">' +
              '<button class="btn btn-sm" type="button" data-price-save>შენახვა</button>' +
              '<button class="btn btn-sm btn-reset" type="button" data-price-reset aria-label="ნაგულისხმევზე დაბრუნება"' + ((item.overridden || hasDisc) ? '' : ' hidden') + '>↺</button>' +
              '<span class="saved" hidden>შენახულია ✓</span>' +
            '</span>' +
            '<span class="price-ctl-row">' +
              '<span class="sale-label">ფასდაკლება ₾</span>' +
              '<input type="number" inputmode="numeric" min="0" max="99999" placeholder="—" value="' + (hasDisc ? item.salePrice : '') + '" data-sale-input aria-label="ფასდაკლების ფასი">' +
              '<span class="sale-pct" data-sale-pct' + (pctHtml ? '' : ' hidden') + '>' + pctHtml + '</span>' +
            '</span>' +
          '</span>' +
        '</div>';
      }
      out += '</div>';
    }
    box.innerHTML = out;
  }

  document.getElementById('tab-btn-prices').addEventListener('click', function () { switchTab('prices'); });

  document.getElementById('price-rows').addEventListener('input', function (e) {
    var row = e.target.closest ? e.target.closest('[data-price-row]') : null;
    if (!row) return;
    if (e.target.hasAttribute('data-price-input') || e.target.hasAttribute('data-sale-input')) refreshSalePct(row);
  });

  document.getElementById('price-rows').addEventListener('click', function (e) {
    var saveBtn = e.target.closest ? e.target.closest('[data-price-save]') : null;
    var resetBtn = e.target.closest ? e.target.closest('[data-price-reset]') : null;
    if (!saveBtn && !resetBtn) return;
    var row = (saveBtn || resetBtn).closest('[data-price-row]');
    var id = row.getAttribute('data-price-row');
    var errBox = document.getElementById('prices-err');
    errBox.hidden = true;
    if (saveBtn) {
      var val = row.querySelector('[data-price-input]').value.trim();
      var price = val === '' ? NaN : parseInt(val, 10);
      if (isNaN(price) || price < 0 || price > 99999) {
        errBox.textContent = 'ფასი უნდა იყოს მთელი რიცხვი 0–99999.';
        errBox.hidden = false;
        return;
      }
      var saleVal = row.querySelector('[data-sale-input]').value.trim();
      var salePrice = null;
      if (saleVal !== '') {
        salePrice = parseInt(saleVal, 10);
        if (isNaN(salePrice) || salePrice < 0 || salePrice > 99999 || price <= 0 || salePrice >= price) {
          errBox.textContent = 'ფასდაკლების ფასი ფასზე ნაკლები მთელი რიცხვი უნდა იყოს.';
          errBox.hidden = false;
          return;
        }
      }
      saveBtn.disabled = true;
      fetch('/api/admin/prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, price: price, sale_price: salePrice })
      }).then(function (res) {
        saveBtn.disabled = false;
        if (!res.ok) throw new Error('save');
        return res.json();
      }).then(function (data) {
        refreshPriceRow(row, !!(data && data.overridden), !!(data && data.salePrice !== null && data.salePrice !== undefined));
        refreshSalePct(row);
        catalogLoaded = false;
        var saved = row.querySelector('.saved');
        saved.hidden = false;
        setTimeout(function () { saved.hidden = true; }, 2000);
      }).catch(function () {
        saveBtn.disabled = false;
        errBox.textContent = 'ვერ შეინახა. სცადეთ თავიდან.';
        errBox.hidden = false;
      });
    } else {
      resetBtn.disabled = true;
      fetch('/api/admin/prices/' + id, { method: 'DELETE' }).then(function (res) {
        resetBtn.disabled = false;
        if (!res.ok) throw new Error('reset');
        return res.json();
      }).then(function (data) {
        row.querySelector('[data-price-input]').value = String(data.price);
        row.querySelector('[data-sale-input]').value = '';
        refreshPriceRow(row, false, false);
        refreshSalePct(row);
        catalogLoaded = false;
      }).catch(function () {
        resetBtn.disabled = false;
        errBox.textContent = 'ვერ დაბრუნდა ნაგულისხმევზე. სცადეთ თავიდან.';
        errBox.hidden = false;
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

    if (path === '/api/prices' && request.method === 'OPTIONS') {
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
    if (path === '/api/prices' && request.method === 'GET') {
      return handlePublicPrices(env, request);
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
    if (path === '/api/admin/catalog' && request.method === 'GET') {
      return handleCatalog(env, request);
    }
    if (path === '/api/admin/quotes' && request.method === 'GET') {
      return handleQuotesGet(env, request);
    }
    if (path === '/api/admin/quotes' && request.method === 'POST') {
      return handleQuotesPost(env, request);
    }
    if (path.startsWith('/api/admin/quotes/') && request.method === 'DELETE') {
      const id = parseInt(path.slice('/api/admin/quotes/'.length), 10);
      if (!Number.isInteger(id) || id < 1 || String(id) !== path.slice('/api/admin/quotes/'.length)) {
        return error('არასწორი ბარათი.', 400);
      }
      return handleQuoteDelete(env, request, id);
    }
    if (path === '/api/admin/prices' && request.method === 'GET') {
      return handleAdminPricesGet(env, request);
    }
    if (path === '/api/admin/prices' && request.method === 'POST') {
      return handleAdminPricesPost(env, request);
    }
    if (path.startsWith('/api/admin/prices/') && request.method === 'DELETE') {
      const id = path.slice('/api/admin/prices/'.length);
      if (!SERVICE_ID_SET.has(id)) {
        return error('არასწორი სერვისი.', 400);
      }
      return handlePriceDelete(env, request, id);
    }

    return error('ვერ მოიძებნა.', 404);
  },
};
