// VocabApp Worker — single-file backend
// Handles: auth (JWT + PBKDF2), translation proxy (xAI Grok), book sync (D1 only)

// ─── CORS ────────────────────────────────────────────────────────────────────

const DEFAULT_ALLOWED_ORIGINS = [
  'https://reader.stanley2025.uk',
  'https://reader-worker.artemdusan.workers.dev',
];

function getAllowedOrigins(env) {
  const raw = env.CORS_ALLOWED_ORIGINS?.trim();
  if (!raw) return DEFAULT_ALLOWED_ORIGINS;

  return raw
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
}

function isAllowedOrigin(origin, env) {
  if (!origin) return false;
  if (getAllowedOrigins(env).includes(origin)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const headers = {
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Vary': 'Origin',
  };

  if (isAllowedOrigin(origin, env)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  return headers;
}

function withCors(response, request, env) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request, env))) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

function parseBookmarksJson(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeAuthIdentifier(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getAiConfig(env) {
  const apiKey = env.XAI_API_KEY || env.GROK_API_KEY || '';
  const baseUrl = (env.XAI_API_BASE_URL || 'https://api.x.ai/v1').replace(/\/+$/, '');

  return {
    apiKey,
    baseUrl,
    model: 'grok-4-1-fast-non-reasoning',
    label: 'xAI Grok',
  };
}

function extractAssistantContent(messageContent) {
  if (typeof messageContent === 'string') return messageContent;
  if (!Array.isArray(messageContent)) return '';

  return messageContent
    .map(part => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      return '';
    })
    .join('')
    .trim();
}

// ─── JWT (HMAC-SHA256, stateless) ────────────────────────────────────────────

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

async function jwtSign(payload, secret) {
  const enc = new TextEncoder();
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body   = btoa(JSON.stringify(payload));
  const data   = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return `${data}.${b64url(sig)}`;
}

async function jwtVerify(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [h, b, s] = parts;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
  );
  const valid = await crypto.subtle.verify('HMAC', key, b64urlDecode(s), enc.encode(`${h}.${b}`));
  if (!valid) throw new Error('invalid signature');
  const payload = JSON.parse(atob(b));
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error('token expired');
  return payload;
}

// ─── PASSWORDS (PBKDF2-SHA256) ───────────────────────────────────────────────

const PBKDF2_ITERS = 100_000;

function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERS, hash: 'SHA-256' }, key, 256,
  );
  return `${toHex(salt)}:${PBKDF2_ITERS}:${toHex(bits)}`;
}

async function verifyPassword(password, stored) {
  const [saltHex, iters, hashHex] = stored.split(':');
  const salt = Uint8Array.from(saltHex.match(/.{2}/g), b => parseInt(b, 16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: Number(iters), hash: 'SHA-256' }, key, 256,
  );
  return toHex(bits) === hashHex;
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────

async function requireAuth(request, env) {
  const auth = request.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return null;
  try {
    const payload = await jwtVerify(auth.slice(7), env.JWT_SECRET);
    return payload.sub; // userId integer
  } catch {
    return null;
  }
}

// ─── ADMIN HTML ──────────────────────────────────────────────────────────────

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="pl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VocabApp Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui;background:#0f0f0f;color:#e0e0e0;padding:24px;max-width:680px;margin:0 auto}
h1{font-size:1.2rem;margin-bottom:20px;color:#fff}
h2{font-size:.9rem;margin-bottom:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em}
section{background:#1c1c1c;border-radius:8px;padding:18px;margin-bottom:14px}
input{background:#2a2a2a;border:1px solid #3a3a3a;color:#e0e0e0;padding:8px 10px;border-radius:6px;width:100%;margin-bottom:8px;font-size:14px}
button{background:#2563eb;color:#fff;border:none;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:14px}
button:hover{background:#1d4ed8}
button.danger{background:#dc2626}button.danger:hover{background:#b91c1c}
button.ghost{background:#374151}button.ghost:hover{background:#4b5563}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:7px 8px;text-align:left;border-bottom:1px solid #2a2a2a}
th{color:#6b7280;font-weight:500}
.msg{padding:7px 10px;border-radius:6px;margin-bottom:10px;font-size:13px;display:none}
.msg.ok{background:#14532d;color:#86efac;display:block}
.msg.err{background:#450a0a;color:#fca5a5;display:block}
#login-wrap{max-width:340px;margin:80px auto}
</style>
</head>
<body>
<div id="login-wrap">
  <h1>VocabApp Admin</h1>
  <div id="login-msg" class="msg"></div>
  <input type="password" id="admin-key" placeholder="Admin key" />
  <button onclick="doLogin()">Zaloguj</button>
</div>
<div id="main" style="display:none">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
    <h1>VocabApp Admin</h1>
    <button class="ghost" onclick="doLogout()">Wyloguj</button>
  </div>

  <section>
    <h2>Użytkownicy</h2>
    <div id="users-msg" class="msg"></div>
    <table><thead><tr><th>ID</th><th>Email</th><th>Utworzony</th><th></th></tr></thead>
    <tbody id="users-tbody"></tbody></table>
  </section>

  <section>
    <h2>Nowy użytkownik</h2>
    <div id="create-msg" class="msg"></div>
    <input type="text" id="new-email" placeholder="Nazwa użytkownika" autocomplete="off" />
    <input type="password" id="new-pass" placeholder="Hasło (min. 8 znaków)" />
    <button onclick="createUser()">Utwórz</button>
  </section>

  <section>
    <h2>Zmień hasło</h2>
    <div id="pw-msg" class="msg"></div>
    <input type="number" id="pw-id" placeholder="ID użytkownika" />
    <input type="password" id="pw-val" placeholder="Nowe hasło (min. 8 znaków)" />
    <button onclick="changePassword()">Zmień hasło</button>
  </section>

  <section>
    <h2>Manifest — oczyszczanie</h2>
    <p style="font-size:13px;color:#6b7280;margin-bottom:10px">Usuwa wpisy z book_manifest gdzie brak meta_json. Po oczyszczeniu uruchom re-sync na urządzeniu z danymi.</p>
    <div id="prune-msg" class="msg"></div>
    <button class="danger" onclick="pruneManifest()">Usuń nieważne wpisy</button>
  </section>
</div>
<script>
let KEY='';
function api(path,opts={}){
  return fetch(path,{...opts,headers:{'Authorization':'Bearer '+KEY,'Content-Type':'application/json',...(opts.headers||{})}})
    .then(r=>r.json().then(d=>({ok:r.ok,data:d})));
}
function setMsg(id,text,ok){
  const el=document.getElementById(id);
  el.textContent=text;el.className='msg '+(ok?'ok':'err');
}
async function doLogin(){
  KEY=document.getElementById('admin-key').value.trim();
  const {ok}=await api('/admin/users');
  if(ok){
    document.getElementById('login-wrap').style.display='none';
    document.getElementById('main').style.display='block';
    loadUsers();
  }else{setMsg('login-msg','Nieprawidłowy klucz',false);KEY='';}
}
function doLogout(){
  KEY='';
  document.getElementById('login-wrap').style.display='block';
  document.getElementById('main').style.display='none';
  document.getElementById('admin-key').value='';
}
async function loadUsers(){
  const {ok,data}=await api('/admin/users');
  if(!ok){setMsg('users-msg',data.error,false);return;}
  document.getElementById('users-tbody').innerHTML=data.map(u=>
    '<tr><td>'+u.id+'</td><td>'+u.email+'</td><td>'+new Date(u.created_at).toLocaleDateString('pl')+'</td><td></td></tr>'
  ).join('');
}
async function createUser(){
  const email=document.getElementById('new-email').value.trim();
  const password=document.getElementById('new-pass').value;
  const {ok,data}=await api('/admin/users',{method:'POST',body:JSON.stringify({email,password})});
  setMsg('create-msg',ok?'Użytkownik utworzony':data.error,ok);
  if(ok){document.getElementById('new-email').value='';document.getElementById('new-pass').value='';loadUsers();}
}
async function changePassword(){
  const id=document.getElementById('pw-id').value;
  const password=document.getElementById('pw-val').value;
  const {ok,data}=await api('/admin/users/'+id+'/password',{method:'POST',body:JSON.stringify({password})});
  setMsg('pw-msg',ok?'Hasło zmienione':data.error,ok);
  if(ok)document.getElementById('pw-val').value='';
}
async function pruneManifest(){
  const {ok,data}=await api('/admin/manifest/prune',{method:'POST'});
  setMsg('prune-msg',ok?'Usunięto '+data.deleted+' wpisów':data.error,ok);
}
document.getElementById('admin-key').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin();});
</script>
</body></html>`;

// ─── ROUTE HANDLERS ──────────────────────────────────────────────────────────

async function handleRegister(request, env) {
  const body = await request.json().catch(() => ({}));
  const username = normalizeAuthIdentifier(body.username ?? body.email);
  const password = typeof body.password === 'string' ? body.password : '';

  if (!username || !password) return err('nazwa użytkownika i hasło są wymagane');
  if (password.length < 8) return err('hasło musi mieć co najmniej 8 znaków');

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(username).first();
  if (existing) return err('nazwa użytkownika jest już zajęta', 409);

  const hash = await hashPassword(password);
  const result = await env.DB.prepare(
    'INSERT INTO users (email, hash, created_at) VALUES (?, ?, ?) RETURNING id',
  ).bind(username, hash, Date.now()).first();

  const token = await jwtSign(
    { sub: result.id, exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600 },
    env.JWT_SECRET,
  );
  return json({ token });
}

async function handleLogin(request, env) {
  const body = await request.json().catch(() => ({}));
  const username = normalizeAuthIdentifier(body.username ?? body.email);
  const password = typeof body.password === 'string' ? body.password : '';

  if (!username || !password) return err('nazwa użytkownika i hasło są wymagane');

  const user = await env.DB.prepare('SELECT id, hash FROM users WHERE email = ?').bind(username).first();
  if (!user) return err('nieprawidłowa nazwa użytkownika lub hasło', 401);

  const ok = await verifyPassword(password, user.hash);
  if (!ok) return err('nieprawidłowa nazwa użytkownika lub hasło', 401);

  const token = await jwtSign(
    { sub: user.id, exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600 },
    env.JWT_SECRET,
  );
  return json({ token });
}

async function handleAuthMe(env, userId) {
  const user = await env.DB.prepare(
    'SELECT email FROM users WHERE id = ?',
  ).bind(userId).first();

  if (!user?.email) return err('Nie znaleziono użytkownika', 404);
  return json({ username: user.email });
}

async function handleTranslate(request, env) {
  const payload = await request.clone().json().catch(() => ({}));
  const messages = payload?.messages;
  const maxTokens = payload?.max_tokens;
  if (!Array.isArray(messages)) return err('messages sa wymagane');

  const ai = getAiConfig(env);
  if (!ai.apiKey) return err('XAI_API_KEY nie jest ustawiony', 500);

  const timeoutMs = 20_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let resp;
  try {
    resp = await fetch(`${ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ai.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ai.model,
        messages,
        temperature: 0.1,
        max_tokens: Number(maxTokens) > 0 ? Math.min(4096, Number(maxTokens)) : 4096,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    const secs = Math.round(timeoutMs / 1000);
    const msg = e.name === 'AbortError'
      ? `${ai.label} nie odpowiedzial w czasie (${secs}s) - sproboj ponownie`
      : `Nie mozna polaczyc z API: ${e.message}`;
    return err(msg, 502);
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) {
    const body = await resp.json().catch(() => null);
    const msg = body?.error?.message || body?.error || `HTTP ${resp.status}`;
    return err(`Blad API (${resp.status}): ${msg}`, 502);
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return err('Nieprawidlowa odpowiedz z API (nie JSON)', 502);
  }

  const content = extractAssistantContent(data?.choices?.[0]?.message?.content);
  if (!content) return err('API zwrocilo pusta odpowiedz', 502);

  return json({ content, usage: data.usage });
}

// ─── BOOK MANIFEST ────────────────────────────────────────────────────────────

async function handleGetBooks(env, userId) {
  const { results } = await env.DB.prepare(
    'SELECT book_id, title, author, chapter_count, created_at, deleted_at, status FROM book_manifest WHERE user_id = ?',
  ).bind(userId).all();
  return json(results);
}

// ─── BOOK META ────────────────────────────────────────────────────────────────

/** POST /books/{bookId} — store full metadata in book_manifest.meta_json */
async function handleUpsertMeta(request, env, userId, bookId) {
  let meta;
  try {
    meta = await request.json();
  } catch {
    return err('nieprawidłowy JSON');
  }

  const { chapters: _ch, ...cleanMeta } = meta;

  await env.DB.prepare(
    `INSERT INTO book_manifest (user_id, book_id, title, author, chapter_count, created_at, deleted_at, status, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, book_id) DO UPDATE SET
       title = excluded.title, author = excluded.author,
       chapter_count = excluded.chapter_count, deleted_at = excluded.deleted_at,
       status = excluded.status, meta_json = excluded.meta_json`,
  ).bind(
    userId, bookId,
    cleanMeta.title || 'Bez tytułu',
    cleanMeta.author || '',
    cleanMeta.chapterCount || 0,
    cleanMeta.createdAt || Date.now(),
    cleanMeta.deletedAt || null,
    cleanMeta.status || 'active',
    JSON.stringify(cleanMeta),
  ).run();

  return json({ ok: true });
}

/** GET /books/{bookId} — fetch full metadata from book_manifest.meta_json */
async function handleGetMeta(env, userId, bookId) {
  const row = await env.DB.prepare(
    'SELECT meta_json FROM book_manifest WHERE user_id = ? AND book_id = ?',
  ).bind(userId, bookId).first();
  if (!row?.meta_json) return err('nie znaleziono', 404);
  return new Response(row.meta_json, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// ─── CHAPTERS ─────────────────────────────────────────────────────────────────

/** POST /books/{bookId}/chapters/{chapterId} */
async function handleUpsertChapterV2(request, env, userId, bookId, chapterId) {
  let ch;
  try { ch = await request.json(); } catch { return err('nieprawidłowy JSON'); }

  await env.DB.prepare(
    `INSERT INTO book_chapters (user_id, book_id, chapter_id, chapter_index, href, title, html)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, book_id, chapter_id) DO UPDATE SET
       chapter_index = excluded.chapter_index, href = excluded.href,
       title = excluded.title, html = excluded.html`,
  ).bind(
    userId, bookId, chapterId,
    ch.chapterIndex ?? 0, ch.href ?? '', ch.title ?? '',
    ch.html ?? '',
  ).run();

  return json({ ok: true });
}

/** GET /books/{bookId}/chapters/{chapterId} */
async function handleGetChapterV2(env, userId, bookId, chapterId) {
  const row = await env.DB.prepare(
    `SELECT chapter_id as id, book_id as bookId, chapter_index as chapterIndex,
            href, title, html
     FROM book_chapters WHERE user_id = ? AND book_id = ? AND chapter_id = ?`,
  ).bind(userId, bookId, chapterId).first();
  if (!row) return err('nie znaleziono', 404);
  return json(row);
}

/** GET /books/{bookId}/chapters — list chapter UUIDs ordered by chapter_index */
async function handleListChapters(env, userId, bookId) {
  const { results } = await env.DB.prepare(
    'SELECT chapter_id FROM book_chapters WHERE user_id = ? AND book_id = ? ORDER BY chapter_index',
  ).bind(userId, bookId).all();
  return json(results.map(r => r.chapter_id));
}

/** POST /books/{bookId}/chapters/{chapterId}/translations/{lang} */
async function handleUpsertPolyV2(request, env, userId, bookId, chapterId, lang) {
  let poly;
  try { poly = await request.json(); } catch { return err('nieprawidłowy JSON'); }

  await env.DB.prepare(
    `INSERT INTO book_translations (user_id, book_id, chapter_id, lang, format, raw_text, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, book_id, chapter_id, lang) DO UPDATE SET
       format = excluded.format, raw_text = excluded.raw_text,
       payload = excluded.payload, created_at = excluded.created_at`,
  ).bind(
    userId, bookId, chapterId, lang,
    poly.format ?? null,
    poly.rawText ?? null,
    poly.payload ?? null,
    poly.createdAt || Date.now(),
  ).run();

  return json({ ok: true });
}

/** GET /books/{bookId}/chapters/{chapterId}/translations/{lang} */
async function handleGetPolyV2(env, userId, bookId, chapterId, lang) {
  const row = await env.DB.prepare(
    `SELECT format, raw_text as rawText, payload, created_at as createdAt
     FROM book_translations WHERE user_id = ? AND book_id = ? AND chapter_id = ? AND lang = ?`,
  ).bind(userId, bookId, chapterId, lang).first();
  if (!row) return err('nie znaleziono', 404);
  return json(row);
}

/** GET /books/{bookId}/polys — list all translations with createdAt for sync */
async function handleListPolysV2(env, userId, bookId) {
  const { results } = await env.DB.prepare(
    `SELECT chapter_id as chapterId, lang, created_at as createdAt
     FROM book_translations WHERE user_id = ? AND book_id = ?`,
  ).bind(userId, bookId).all();
  return json(results);
}

// ─── DELETE BOOK ──────────────────────────────────────────────────────────────

async function handleDeleteBook(request, env, userId, bookId) {
  const { deletedAt } = await request.json().catch(() => ({ deletedAt: Date.now() }));

  await env.DB.prepare(
    'UPDATE book_manifest SET deleted_at = ? WHERE user_id = ? AND book_id = ?',
  ).bind(deletedAt || Date.now(), userId, bookId).run();

  await env.DB.prepare(
    'DELETE FROM reading_positions WHERE user_id = ? AND book_id = ?',
  ).bind(userId, bookId).run();

  await env.DB.prepare(
    'DELETE FROM book_chapters WHERE user_id = ? AND book_id = ?',
  ).bind(userId, bookId).run();

  await env.DB.prepare(
    'DELETE FROM book_translations WHERE user_id = ? AND book_id = ?',
  ).bind(userId, bookId).run();

  return json({ ok: true });
}

// ─── PROGRESS ─────────────────────────────────────────────────────────────────

async function handleGetProgress(env, userId) {
  const { results } = await env.DB.prepare(
    `SELECT
       rp.book_id as bookId,
       rp.chapter_idx as chapterIndex,
       rp.scroll_top as scrollTop,
       rp.active_lang as activeLang,
       rp.bookmarks_json as bookmarksJson,
       rp.poly_mode as polyMode,
       rp.sentence_idx as sentenceIdx,
       rp.updated_at as updatedAt,
       bm.status as bookStatus
     FROM reading_positions rp
     LEFT JOIN book_manifest bm
       ON bm.user_id = rp.user_id
      AND bm.book_id = rp.book_id
     WHERE rp.user_id = ?
       AND (bm.book_id IS NULL OR bm.deleted_at IS NULL)`,
  ).bind(userId).all();
  return json(results.map(row => {
    const { bookmarksJson, ...rest } = row;
    return {
      ...rest,
      activeLang: typeof row.activeLang === 'string' && row.activeLang ? row.activeLang : null,
      bookmarks: parseBookmarksJson(bookmarksJson),
    };
  }));
}

async function handleUpsertProgress(request, env, userId, bookId) {
  const body = await request.json().catch(() => ({}));
  const {
    chapterIndex = 0,
    scrollTop = 0,
    polyMode = false,
    sentenceIdx = -1,
    updatedAt,
  } = body;
  const activeLang =
    typeof body.activeLang === 'string' && body.activeLang.trim()
      ? body.activeLang.trim()
      : null;
  const bookmarks = Array.isArray(body.bookmarks) ? body.bookmarks : [];
  const columns = [
    'user_id',
    'book_id',
    'chapter_idx',
    'scroll_top',
    'active_lang',
    'bookmarks_json',
    'poly_mode',
    'sentence_idx',
    'updated_at',
  ];
  const values = [
    userId,
    bookId,
    chapterIndex,
    scrollTop,
    activeLang,
    JSON.stringify(bookmarks),
    polyMode ? 1 : 0,
    sentenceIdx,
    updatedAt || Date.now(),
  ];

  const updateColumns = columns.filter(
    (column) => column !== 'user_id' && column !== 'book_id',
  );
  const placeholders = columns.map(() => '?').join(', ');
  const updateClause = updateColumns
    .map((column) => `${column} = excluded.${column}`)
    .join(', ');

  await env.DB.prepare(
    `INSERT INTO reading_positions (${columns.join(', ')})
     VALUES (${placeholders})
     ON CONFLICT (user_id, book_id) DO UPDATE SET ${updateClause}`,
  ).bind(...values).run();

  const status = body.status;
  if (status && ['active', 'read', 'archived'].includes(status)) {
    await env.DB.prepare(
      'UPDATE book_manifest SET status = ? WHERE user_id = ? AND book_id = ?',
    ).bind(status, userId, bookId).run();
  }

  return json({ ok: true });
}

// ─── ADMIN ───────────────────────────────────────────────────────────────────

function requireAdmin(request, env) {
  if (!env.ADMIN_KEY) return false;
  const auth = request.headers.get('Authorization') ?? '';
  return auth === `Bearer ${env.ADMIN_KEY}`;
}

function handleAdminPage() {
  return new Response(ADMIN_HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function handleAdminListUsers(env) {
  const { results } = await env.DB.prepare(
    'SELECT id, email, created_at FROM users ORDER BY id',
  ).all();
  return json(results);
}

async function handleAdminCreateUser(request, env) {
  const body = await request.json().catch(() => ({}));
  const username = normalizeAuthIdentifier(body.email ?? body.username);
  const password = typeof body.password === 'string' ? body.password : '';

  if (!username || !password) return err('email i hasło są wymagane');
  if (password.length < 8) return err('hasło musi mieć co najmniej 8 znaków');

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(username).first();
  if (existing) return err('użytkownik już istnieje', 409);

  const hash = await hashPassword(password);
  const result = await env.DB.prepare(
    'INSERT INTO users (email, hash, created_at) VALUES (?, ?, ?) RETURNING id',
  ).bind(username, hash, Date.now()).first();

  return json({ ok: true, id: result.id });
}

async function handleAdminChangePassword(request, env, userId) {
  const body = await request.json().catch(() => ({}));
  const password = typeof body.password === 'string' ? body.password : '';

  if (!password || password.length < 8) return err('hasło musi mieć co najmniej 8 znaków');

  const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
  if (!user) return err('użytkownik nie istnieje', 404);

  const hash = await hashPassword(password);
  await env.DB.prepare('UPDATE users SET hash = ? WHERE id = ?').bind(hash, userId).run();

  return json({ ok: true });
}

async function handleAdminPruneManifest(env) {
  const result = await env.DB.prepare(
    'DELETE FROM book_manifest WHERE meta_json IS NULL',
  ).run();
  return json({ ok: true, deleted: result.meta.changes });
}

// ─── HEALTH CHECK ────────────────────────────────────────────────────────────

async function handleHealth(env) {
  const ai = getAiConfig(env);
  if (!ai.apiKey) return err('XAI_API_KEY nie jest ustawiony', 500);

  let resp;
  try {
    resp = await fetch(`${ai.baseUrl}/models`, {
      headers: { 'Authorization': `Bearer ${ai.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return err(`Nie mozna polaczyc z ${ai.label}: ${e.message}`, 502);
  }

  if (!resp.ok) {
    const body = await resp.json().catch(() => null);
    const msg = body?.error?.message || `HTTP ${resp.status}`;
    return err(`Blad ${ai.label} API (${resp.status}): ${msg}`, 502);
  }

  return json({ ok: true, provider: ai.label, status: resp.status });
}

// ─── ROUTER ──────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    try {
      const response = await handleRequest(request, env);
      return withCors(response, request, env);
    } catch (e) {
      return withCors(err(`Nieoczekiwany błąd: ${e.message}`, 500), request, env);
    }
  },
};

async function handleRequest(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204 });
    }

    // Public routes
    if (method === 'GET'  && path === '/health')        return handleHealth(env);
    if (method === 'POST' && path === '/auth/login')    return handleLogin(request, env);

    // Admin routes (ADMIN_KEY auth, not JWT)
    if (method === 'GET' && path === '/admin') return handleAdminPage();
    if (path.startsWith('/admin/')) {
      if (!requireAdmin(request, env)) return err('Unauthorized', 401);
      if (method === 'GET'  && path === '/admin/users')             return handleAdminListUsers(env);
      if (method === 'POST' && path === '/admin/users')             return handleAdminCreateUser(request, env);
      if (method === 'POST' && path === '/admin/manifest/prune')    return handleAdminPruneManifest(env);
      const pwMatch = path.match(/^\/admin\/users\/(\d+)\/password$/);
      if (pwMatch && method === 'POST') return handleAdminChangePassword(request, env, Number(pwMatch[1]));
    }

    // All remaining routes require JWT
    const userId = await requireAuth(request, env);
    if (!userId) return err('Unauthorized', 401);

    if (method === 'GET' && path === '/auth/me') return handleAuthMe(env, userId);
    if (method === 'POST' && path === '/translate') return handleTranslate(request, env);

    if (method === 'GET' && path === '/books')    return handleGetBooks(env, userId);
    if (method === 'GET' && path === '/progress') return handleGetProgress(env, userId);

    // /books/{bookId}
    const bookMatch = path.match(/^\/books\/([^/]+)$/);
    if (bookMatch) {
      const bookId = bookMatch[1];
      if (method === 'POST')   return handleUpsertMeta(request, env, userId, bookId);
      if (method === 'GET')    return handleGetMeta(env, userId, bookId);
      if (method === 'DELETE') return handleDeleteBook(request, env, userId, bookId);
    }

    // /books/{bookId}/polys
    const polysMatch = path.match(/^\/books\/([^/]+)\/polys$/);
    if (polysMatch && method === 'GET') {
      return handleListPolysV2(env, userId, polysMatch[1]);
    }

    // /books/{bookId}/chapters  (list UUIDs)
    const chListMatch = path.match(/^\/books\/([^/]+)\/chapters$/);
    if (chListMatch && method === 'GET') {
      return handleListChapters(env, userId, chListMatch[1]);
    }

    // /books/{bookId}/chapters/{chapterId}/translations/{lang}
    const trV2Match = path.match(/^\/books\/([^/]+)\/chapters\/([^/]+)\/translations\/([^/]+)$/);
    if (trV2Match) {
      const [, bookId, chapterId, lang] = trV2Match;
      if (method === 'POST') return handleUpsertPolyV2(request, env, userId, bookId, chapterId, lang);
      if (method === 'GET')  return handleGetPolyV2(env, userId, bookId, chapterId, lang);
    }

    // /books/{bookId}/chapters/{chapterId}
    const chV2Match = path.match(/^\/books\/([^/]+)\/chapters\/([^/]+)$/);
    if (chV2Match) {
      const [, bookId, chapterId] = chV2Match;
      if (method === 'POST') return handleUpsertChapterV2(request, env, userId, bookId, chapterId);
      if (method === 'GET')  return handleGetChapterV2(env, userId, bookId, chapterId);
    }

    // /progress/{bookId}
    const progressMatch = path.match(/^\/progress\/([^/]+)$/);
    if (progressMatch && method === 'POST') {
      return handleUpsertProgress(request, env, userId, progressMatch[1]);
    }

    return err('Not found', 404);
}
