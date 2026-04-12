// VocabApp Worker — single-file backend
// Handles: auth (JWT + PBKDF2), translation proxy (xAI Grok), book sync (D1 + R2)
//
// R2 structure per book:
//   {userId}/{bookId}/meta.json
//   {userId}/{bookId}/{chapterUUID}/metadata.json
//   {userId}/{bookId}/{chapterUUID}/{lang}.json

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

// ─── R2 KEY HELPERS ──────────────────────────────────────────────────────────

const metaKey      = (u, b)          => `${u}/${b}/meta.json`;
const chapterKeyV2 = (u, b, chId)    => `${u}/${b}/${chId}/metadata.json`;
const polyKeyV2    = (u, b, chId, l) => `${u}/${b}/${chId}/${l}.json`;
const bookPrefix   = (u, b)          => `${u}/${b}/`;

async function r2PutJson(env, key, data) {
  await env.reader_books.put(key, JSON.stringify(data), {
    httpMetadata: { contentType: 'application/json' },
  });
}

async function r2GetJson(env, key) {
  const obj = await env.reader_books.get(key);
  if (!obj) return null;
  return obj.json();
}

/** List all R2 keys under a prefix (handles pagination). */
async function r2ListKeys(env, prefix) {
  const keys = [];
  let cursor;
  do {
    const result = await env.reader_books.list({ prefix, cursor });
    for (const obj of result.objects) keys.push(obj.key);
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);
  return keys;
}

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
    'SELECT book_id, title, author, chapter_count, created_at, deleted_at FROM book_manifest WHERE user_id = ?',
  ).bind(userId).all();
  return json(results);
}

// ─── BOOK META ────────────────────────────────────────────────────────────────

/** POST /books/{bookId} — store metadata (without chapters) */
async function handleUpsertMeta(request, env, userId, bookId) {
  let meta;
  try {
    meta = await request.json();
  } catch {
    return err('nieprawidłowy JSON');
  }

  // Strip chapters if accidentally included
  const { chapters: _ch, ...cleanMeta } = meta;

  await r2PutJson(env, metaKey(userId, bookId), cleanMeta);

  await env.DB.prepare(
    `INSERT INTO book_manifest (user_id, book_id, title, author, chapter_count, created_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, book_id) DO UPDATE SET
       title = excluded.title, author = excluded.author,
       chapter_count = excluded.chapter_count, deleted_at = excluded.deleted_at`,
  ).bind(
    userId, bookId,
    cleanMeta.title || 'Bez tytułu',
    cleanMeta.author || '',
    cleanMeta.chapterCount || 0,
    cleanMeta.createdAt || Date.now(),
    cleanMeta.deletedAt || null,
  ).run();

  return json({ ok: true });
}

/** GET /books/{bookId} — fetch metadata only */
async function handleGetMeta(env, userId, bookId) {
  const data = await r2GetJson(env, metaKey(userId, bookId));
  if (!data) return err('nie znaleziono', 404);
  return json(data);
}

// ─── CHAPTERS ─────────────────────────────────────────────────────────────────

/** POST /books/{bookId}/chapters/{chapterId} */
async function handleUpsertChapterV2(request, env, userId, bookId, chapterId) {
  let chapter;
  try { chapter = await request.json(); } catch { return err('nieprawidłowy JSON'); }
  await r2PutJson(env, chapterKeyV2(userId, bookId, chapterId), chapter);
  return json({ ok: true });
}

/** GET /books/{bookId}/chapters/{chapterId} */
async function handleGetChapterV2(env, userId, bookId, chapterId) {
  const data = await r2GetJson(env, chapterKeyV2(userId, bookId, chapterId));
  if (!data) return err('nie znaleziono', 404);
  return json(data);
}

/**
 * GET /books/{bookId}/chapters — list chapter UUIDs for a book.
 * Scans R2 for keys ending in /metadata.json to find UUID folders.
 */
async function handleListChapters(env, userId, bookId) {
  const prefix = bookPrefix(userId, bookId);
  const keys = await r2ListKeys(env, prefix);
  const uuids = [...new Set(
    keys
      .filter(k => k.endsWith('/metadata.json'))
      .map(k => {
        const rel = k.slice(prefix.length); // "{chUUID}/metadata.json"
        return rel.split('/')[0];
      }),
  )];
  return json(uuids);
}

/** POST /books/{bookId}/chapters/{chapterId}/translations/{lang} */
async function handleUpsertPolyV2(request, env, userId, bookId, chapterId, lang) {
  let poly;
  try { poly = await request.json(); } catch { return err('nieprawidłowy JSON'); }
  await r2PutJson(env, polyKeyV2(userId, bookId, chapterId, lang), poly);
  return json({ ok: true });
}

/** GET /books/{bookId}/chapters/{chapterId}/translations/{lang} */
async function handleGetPolyV2(env, userId, bookId, chapterId, lang) {
  const data = await r2GetJson(env, polyKeyV2(userId, bookId, chapterId, lang));
  if (!data) return err('nie znaleziono', 404);
  return json(data);
}

/**
 * GET /books/{bookId}/polys — list all translations for a book.
 * Returns [{chapterId, lang}] by scanning UUID folder keys.
 */
async function handleListPolysV2(env, userId, bookId) {
  const prefix = bookPrefix(userId, bookId);
  const keys = await r2ListKeys(env, prefix);
  const polys = [];
  for (const k of keys) {
    const rel = k.slice(prefix.length); // "{chUUID}/{file}.json"
    const parts = rel.split('/');
    if (parts.length !== 2) continue;
    const [chapterId, langFile] = parts;
    const name = langFile.replace(/\.json$/, '');
    if (name === 'metadata') continue; // skip chapter metadata files
    polys.push({ chapterId, lang: name });
  }
  return json(polys);
}

// ─── DELETE BOOK ──────────────────────────────────────────────────────────────

async function handleDeleteBook(request, env, userId, bookId) {
  const { deletedAt } = await request.json().catch(() => ({ deletedAt: Date.now() }));

  // Soft delete in D1
  await env.DB.prepare(
    'UPDATE book_manifest SET deleted_at = ? WHERE user_id = ? AND book_id = ?',
  ).bind(deletedAt || Date.now(), userId, bookId).run();

  await env.DB.prepare(
    'DELETE FROM reading_positions WHERE user_id = ? AND book_id = ?',
  ).bind(userId, bookId).run();

  // Hard delete all R2 objects under this book prefix
  const keys = await r2ListKeys(env, bookPrefix(userId, bookId));
  await Promise.all(keys.map(k => env.reader_books.delete(k)));

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
       rp.updated_at as updatedAt
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

  return json({ ok: true });
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
    if (method === 'POST' && path === '/auth/register') return handleRegister(request, env);
    if (method === 'POST' && path === '/auth/login')    return handleLogin(request, env);

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
