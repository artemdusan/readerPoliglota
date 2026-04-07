// VocabApp Worker — single-file backend
// Handles: auth (JWT + PBKDF2), translation proxy (DeepSeek), book sync (D1 + R2)

// ─── CORS ────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
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

// ─── ROUTE HANDLERS ──────────────────────────────────────────────────────────

async function handleRegister(request, env) {
  const { email, password } = await request.json().catch(() => ({}));
  if (!email || !password) return err('email i hasło są wymagane');
  if (password.length < 8) return err('hasło musi mieć co najmniej 8 znaków');

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) return err('email już zarejestrowany', 409);

  const hash = await hashPassword(password);
  const result = await env.DB.prepare(
    'INSERT INTO users (email, hash, created_at) VALUES (?, ?, ?) RETURNING id',
  ).bind(email, hash, Date.now()).first();

  const token = await jwtSign(
    { sub: result.id, exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600 },
    env.JWT_SECRET,
  );
  return json({ token });
}

async function handleLogin(request, env) {
  const { email, password } = await request.json().catch(() => ({}));
  if (!email || !password) return err('email i hasło są wymagane');

  const user = await env.DB.prepare('SELECT id, hash FROM users WHERE email = ?').bind(email).first();
  if (!user) return err('nieprawidłowy email lub hasło', 401);

  const ok = await verifyPassword(password, user.hash);
  if (!ok) return err('nieprawidłowy email lub hasło', 401);

  const token = await jwtSign(
    { sub: user.id, exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600 },
    env.JWT_SECRET,
  );
  return json({ token });
}

async function handleTranslate(request, env) {
  const { model, messages } = await request.json().catch(() => ({}));
  if (!model || !Array.isArray(messages)) return err('model i messages są wymagane');

  const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 4096 }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.status);
    return err(`DeepSeek error ${resp.status}: ${text}`, 502);
  }

  const data = await resp.json();
  return json({
    content: data.choices[0].message.content,
    usage: data.usage,
  });
}

async function handleGetBooks(env, userId) {
  const { results } = await env.DB.prepare(
    'SELECT book_id, title, author, created_at, deleted_at FROM book_manifest WHERE user_id = ?',
  ).bind(userId).all();
  return json(results);
}

async function handleUpsertBook(request, env, userId, bookId) {
  const body = await request.text();
  let meta;
  try {
    meta = JSON.parse(body);
  } catch {
    return err('nieprawidłowy JSON');
  }

  await env.vocabapp_books.put(`${userId}/${bookId}.json`, body, {
    httpMetadata: { contentType: 'application/json' },
  });

  await env.DB.prepare(
    `INSERT INTO book_manifest (user_id, book_id, title, author, created_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, book_id) DO UPDATE SET
       title = excluded.title, author = excluded.author, deleted_at = excluded.deleted_at`,
  ).bind(
    userId, bookId,
    meta.title || 'Bez tytułu',
    meta.author || '',
    meta.createdAt || Date.now(),
    meta.deletedAt || null,
  ).run();

  return json({ ok: true });
}

async function handleGetBook(env, userId, bookId) {
  const obj = await env.vocabapp_books.get(`${userId}/${bookId}.json`);
  if (!obj) return err('nie znaleziono', 404);
  const text = await obj.text();
  return new Response(text, {
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function handleDeleteBook(request, env, userId, bookId) {
  const { deletedAt } = await request.json().catch(() => ({ deletedAt: Date.now() }));
  await env.DB.prepare(
    'UPDATE book_manifest SET deleted_at = ? WHERE user_id = ? AND book_id = ?',
  ).bind(deletedAt || Date.now(), userId, bookId).run();
  return json({ ok: true });
}

async function handleGetProgress(env, userId) {
  const { results } = await env.DB.prepare(
    `SELECT book_id as bookId, chapter_idx as chapterIndex, scroll_top as scrollTop,
            poly_mode as polyMode, sentence_idx as sentenceIdx, updated_at as updatedAt
     FROM reading_positions WHERE user_id = ?`,
  ).bind(userId).all();
  return json(results);
}

async function handleUpsertProgress(request, env, userId, bookId) {
  const { chapterIndex = 0, scrollTop = 0, polyMode = false, sentenceIdx = -1, updatedAt } =
    await request.json().catch(() => ({}));

  await env.DB.prepare(
    `INSERT INTO reading_positions (user_id, book_id, chapter_idx, scroll_top, poly_mode, sentence_idx, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, book_id) DO UPDATE SET
       chapter_idx = excluded.chapter_idx, scroll_top = excluded.scroll_top,
       poly_mode = excluded.poly_mode, sentence_idx = excluded.sentence_idx,
       updated_at = excluded.updated_at`,
  ).bind(
    userId, bookId,
    chapterIndex, scrollTop, polyMode ? 1 : 0, sentenceIdx,
    updatedAt || Date.now(),
  ).run();

  return json({ ok: true });
}

// ─── ROUTER ──────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Public auth routes
    if (method === 'POST' && path === '/auth/register') return handleRegister(request, env);
    if (method === 'POST' && path === '/auth/login')    return handleLogin(request, env);

    // All remaining routes require JWT
    const userId = await requireAuth(request, env);
    if (!userId) return err('Unauthorized', 401);

    if (method === 'POST' && path === '/translate') return handleTranslate(request, env);

    if (method === 'GET'  && path === '/books')          return handleGetBooks(env, userId);
    if (method === 'GET'  && path === '/progress')       return handleGetProgress(env, userId);

    // /books/:id
    const bookMatch = path.match(/^\/books\/([^/]+)$/);
    if (bookMatch) {
      const bookId = bookMatch[1];
      if (method === 'POST')   return handleUpsertBook(request, env, userId, bookId);
      if (method === 'GET')    return handleGetBook(env, userId, bookId);
      if (method === 'DELETE') return handleDeleteBook(request, env, userId, bookId);
    }

    // /progress/:bookId
    const progressMatch = path.match(/^\/progress\/([^/]+)$/);
    if (progressMatch && method === 'POST') {
      return handleUpsertProgress(request, env, userId, progressMatch[1]);
    }

    return err('Not found', 404);
  },
};
