// VocabApp Worker — single-file backend
// Handles: auth (JWT + PBKDF2), translation proxy (DeepSeek), book sync (D1 + R2), TTS (Polly)
//
// R2 structure per book:
//   {userId}/{bookId}/meta.json
//   {userId}/{bookId}/{chapterUUID}/metadata.json
//   {userId}/{bookId}/{chapterUUID}/{lang}.json
//   {userId}/{bookId}/{chapterUUID}/audio_{voiceId}.ogg
//   {userId}/{bookId}/{chapterUUID}/marks_{voiceId}.json

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

// ─── AWS SIGV4 (for Amazon Polly) ────────────────────────────────────────────

async function hmacSha256(key, data) {
  const k = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data)));
}

async function sha256hex(data) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return toHex(buf);
}

async function sigV4Sign(method, url, body, service, env) {
  const region = env.AWS_REGION || 'eu-central-1';
  const accessKey = env.AWS_ACCESS_KEY_ID;
  const secretKey = env.AWS_SECRET_ACCESS_KEY;

  const parsed = new URL(url);
  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const amzDate  = now.toISOString().replace(/[:-]/g, '').replace(/\.\d+/, '');

  const bodyHash = await sha256hex(body);

  const headers = {
    'content-type': 'application/json',
    'host': parsed.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': bodyHash,
  };

  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map(k => `${k}:${headers[k]}\n`).join('');
  const canonicalRequest = [method, parsed.pathname, parsed.search.slice(1), canonicalHeaders, signedHeaders, bodyHash].join('\n');

  const credScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const strToSign = ['AWS4-HMAC-SHA256', amzDate, credScope, await sha256hex(canonicalRequest)].join('\n');

  let sigKey = await hmacSha256(`AWS4${secretKey}`, dateStamp);
  sigKey = await hmacSha256(sigKey, region);
  sigKey = await hmacSha256(sigKey, service);
  sigKey = await hmacSha256(sigKey, 'aws4_request');

  const sig = toHex((await hmacSha256(sigKey, strToSign)).buffer);
  const auth = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;

  return { ...headers, 'authorization': auth };
}

// ─── POLLY HELPERS ────────────────────────────────────────────────────────────

const POLLY_VOICES = { pl: 'Ola', en: 'Joanna', es: 'Lupe' };
const POLLY_LANGS  = { pl: 'pl-PL', en: 'en-US', es: 'es-US' };
const POLLY_CHUNK  = 5500; // chars per request (Polly neural limit: 6000)
// Approximate ms per char for timing offset between chunks (neural voices ~150 wpm)
const MS_PER_CHAR  = 75;

function pollyVoiceForLang(lang) {
  const code = (lang || '').toLowerCase().slice(0, 2);
  return POLLY_VOICES[code] || 'Joanna';
}

function pollyLangCode(lang) {
  const code = (lang || '').toLowerCase().slice(0, 2);
  return POLLY_LANGS[code] || 'en-US';
}

/** Split text at sentence boundaries, max maxLen chars per chunk. */
function splitChunks(text, maxLen = POLLY_CHUNK) {
  const chunks = [];
  let rem = text.trim();
  while (rem.length > 0) {
    if (rem.length <= maxLen) { chunks.push(rem); break; }
    // Find last sentence end (.!?) before maxLen
    const slice = rem.slice(0, maxLen);
    const lastEnd = Math.max(
      slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '),
      slice.lastIndexOf('.\n'), slice.lastIndexOf('!\n'), slice.lastIndexOf('?\n'),
    );
    const cut = lastEnd > 0 ? lastEnd + 1 : maxLen;
    chunks.push(rem.slice(0, cut));
    rem = rem.slice(cut).replace(/^\s+/, '');
  }
  return chunks;
}

async function callPolly(body, env) {
  const region = env.AWS_REGION || 'eu-central-1';
  const url = `https://polly.${region}.amazonaws.com/v1/speech`;
  const bodyStr = JSON.stringify(body);
  const headers = await sigV4Sign('POST', url, bodyStr, 'polly', env);
  return fetch(url, { method: 'POST', headers, body: bodyStr, signal: AbortSignal.timeout(30_000) });
}

async function pollyMarks(text, voiceId, langCode, env) {
  const resp = await callPolly({
    Text: text, OutputFormat: 'json', SpeechMarkTypes: ['sentence'],
    VoiceId: voiceId, LanguageCode: langCode, Engine: 'neural',
  }, env);
  if (!resp.ok) throw new Error(`Polly marks HTTP ${resp.status}: ${await resp.text()}`);
  const lines = (await resp.text()).trim().split('\n');
  return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

async function pollyAudio(text, voiceId, langCode, env) {
  const resp = await callPolly({
    Text: text, OutputFormat: 'ogg_vorbis',
    VoiceId: voiceId, LanguageCode: langCode, Engine: 'neural',
  }, env);
  if (!resp.ok) throw new Error(`Polly audio HTTP ${resp.status}: ${await resp.text()}`);
  return resp.arrayBuffer();
}

const audioChunkKey = (u, b, chId, vId, ci) => `${u}/${b}/${chId}/audio_${vId}_${ci}.ogg`;
const marksKey      = (u, b, chId, vId)      => `${u}/${b}/${chId}/marks_${vId}.json`;

/** POST /books/:bookId/chapters/:chapterId/audio  { text, lang } */
async function handleGenerateAudio(request, env, userId, bookId, chapterId) {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY)
    return err('AWS credentials nie są ustawione', 500);

  const { text, lang } = await request.json().catch(() => ({}));
  if (!text) return err('text jest wymagany');

  const voiceId  = pollyVoiceForLang(lang);
  const langCode = pollyLangCode(lang);

  // Return cached if exists
  const cachedMarksObj = await env.reader_books.get(marksKey(userId, bookId, chapterId, voiceId));
  if (cachedMarksObj) {
    const marks = await cachedMarksObj.json();
    return json({ ok: true, voiceId, marks, chunkCount: marks._chunkCount ?? 1, cached: true });
  }

  const chunks = splitChunks(text);
  const allMarks = [];
  let timeOffset = 0;
  let charOffset = 0;

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];

    // Get marks and audio in parallel for this chunk
    const [chunkMarks, audioBytes] = await Promise.all([
      pollyMarks(chunk, voiceId, langCode, env),
      pollyAudio(chunk, voiceId, langCode, env),
    ]);

    // Store audio chunk in R2
    await env.reader_books.put(audioChunkKey(userId, bookId, chapterId, voiceId, ci), audioBytes, {
      httpMetadata: { contentType: 'audio/ogg' },
    });

    // Adjust mark times and char offsets for global position
    for (const m of chunkMarks) {
      allMarks.push({
        sid:        allMarks.length,           // global sentence index
        localTime:  m.time,                    // ms from start of THIS chunk's audio
        time:       m.time + timeOffset,       // estimated absolute ms (for reference)
        start:      m.start + charOffset,      // char offset in full chapter text
        end:        m.end   + charOffset,
        value:      m.value,
        chunkIndex: ci,
      });
    }

    charOffset += chunk.length + 1; // +1 for the space/newline between chunks

    // Estimate chunk duration for next chunk's time offset
    const lastMark = chunkMarks[chunkMarks.length - 1];
    const charsAfterLast = chunk.length - (lastMark?.start ?? chunk.length);
    timeOffset += (lastMark?.time ?? 0) + charsAfterLast * MS_PER_CHAR;
  }

  // Store combined marks (with chunk count metadata)
  allMarks._chunkCount = chunks.length;
  await r2PutJson(env, marksKey(userId, bookId, chapterId, voiceId), allMarks);

  return json({ ok: true, voiceId, marks: allMarks, chunkCount: chunks.length, cached: false });
}

/** GET /books/:bookId/chapters/:chapterId/audio?voiceId=Ola&chunk=0 */
async function handleGetAudio(request, env, userId, bookId, chapterId) {
  const url     = new URL(request.url);
  const voiceId = url.searchParams.get('voiceId') || 'Ola';
  const chunk   = parseInt(url.searchParams.get('chunk') || '0', 10);
  const obj = await env.reader_books.get(audioChunkKey(userId, bookId, chapterId, voiceId, chunk));
  if (!obj) return err('nie znaleziono', 404);
  return new Response(obj.body, {
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'audio/ogg',
      'Cache-Control': 'public, max-age=86400',
    },
  });
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

  // deepseek-reasoner needs more time for chain-of-thought; use 60s for all models
  const timeoutMs = model === 'deepseek-reasoner' ? 90_000 : 60_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let resp;
  try {
    resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 4096 }),
      signal: controller.signal,
    });
  } catch (e) {
    const secs = Math.round(timeoutMs / 1000);
    const msg = e.name === 'AbortError'
      ? `DeepSeek nie odpowiedział w czasie (${secs}s) — spróbuj ponownie lub zmień model`
      : `Nie można połączyć z API: ${e.message}`;
    return err(msg, 502);
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) {
    const body = await resp.json().catch(() => null);
    const msg = body?.error?.message || body?.error || `HTTP ${resp.status}`;
    return err(`Błąd API (${resp.status}): ${msg}`, 502);
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return err('Nieprawidłowa odpowiedź z API (nie JSON)', 502);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) return err('API zwróciło pustą odpowiedź', 502);

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

  // Hard delete all R2 objects under this book prefix
  const keys = await r2ListKeys(env, bookPrefix(userId, bookId));
  await Promise.all(keys.map(k => env.reader_books.delete(k)));

  return json({ ok: true });
}

// ─── PROGRESS ─────────────────────────────────────────────────────────────────

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

// ─── HEALTH CHECK ────────────────────────────────────────────────────────────

async function handleHealth(env) {
  if (!env.DEEPSEEK_API_KEY) return err('DEEPSEEK_API_KEY nie jest ustawiony', 500);

  let resp;
  try {
    resp = await fetch('https://api.deepseek.com/v1/models', {
      headers: { 'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return err(`Nie można połączyć z DeepSeek: ${e.message}`, 502);
  }

  if (!resp.ok) {
    const body = await resp.json().catch(() => null);
    const msg = body?.error?.message || `HTTP ${resp.status}`;
    return err(`Błąd DeepSeek API (${resp.status}): ${msg}`, 502);
  }

  return json({ ok: true, status: resp.status });
}

// ─── ROUTER ──────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (e) {
      return err(`Nieoczekiwany błąd: ${e.message}`, 500);
    }
  },
};

async function handleRequest(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Public routes
    if (method === 'GET'  && path === '/health')        return handleHealth(env);
    if (method === 'POST' && path === '/auth/register') return handleRegister(request, env);
    if (method === 'POST' && path === '/auth/login')    return handleLogin(request, env);

    // All remaining routes require JWT
    const userId = await requireAuth(request, env);
    if (!userId) return err('Unauthorized', 401);

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

    // /books/{bookId}/chapters/{chapterId}/audio
    const audioMatch = path.match(/^\/books\/([^/]+)\/chapters\/([^/]+)\/audio$/);
    if (audioMatch) {
      const [, bookId, chapterId] = audioMatch;
      if (method === 'POST') return handleGenerateAudio(request, env, userId, bookId, chapterId);
      if (method === 'GET')  return handleGetAudio(request, env, userId, bookId, chapterId);
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
