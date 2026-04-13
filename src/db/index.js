import Dexie from 'dexie';

export const db = new Dexie('ReaderDB');

db.version(6).stores({
  books:            'id, title, createdAt, deletedAt',
  chapters:         'id, bookId, chapterIndex, [bookId+chapterIndex], pendingSyncFlag',
  polyglotCache:    'id, chapterId, targetLang, [chapterId+targetLang]',
  readingPositions: 'bookId',
  settings:         'key',
});

// ─── Pending sync helpers ─────────────────────────────────────────────────────

async function markChapterMetaPending(chapterId) {
  const ch = await db.chapters.get(chapterId);
  if (!ch) return;
  const pending = ch.pendingSync ?? { meta: false, langs: [] };
  await db.chapters.update(chapterId, {
    pendingSync:     { ...pending, meta: true },
    pendingSyncFlag: 1,
  });
}

async function markPolyPending(chapterId, lang) {
  const ch = await db.chapters.get(chapterId);
  if (!ch) return;
  const pending = ch.pendingSync ?? { meta: false, langs: [] };
  const langs = [...new Set([...(pending.langs ?? []), lang])];
  await db.chapters.update(chapterId, {
    pendingSync:     { ...pending, langs },
    pendingSyncFlag: 1,
  });
}

export async function clearChapterPending(chapterId) {
  await db.chapters.update(chapterId, {
    pendingSync:     null,
    pendingSyncFlag: 0,
  });
}

export async function clearPolyPending(chapterId, lang) {
  const ch = await db.chapters.get(chapterId);
  if (!ch?.pendingSync) return;
  const langs = (ch.pendingSync.langs ?? []).filter(l => l !== lang);
  const meta = ch.pendingSync.meta ?? false;
  const nothingLeft = !meta && langs.length === 0;
  await db.chapters.update(chapterId, {
    pendingSync:     nothingLeft ? null : { meta, langs },
    pendingSyncFlag: nothingLeft ? 0 : 1,
  });
}

export async function getPendingChapters() {
  return db.chapters.where('pendingSyncFlag').equals(1).toArray();
}

// ─── Settings ────────────────────────────────────────────────────────────────

export async function getSetting(key, defaultValue = null) {
  const row = await db.settings.get(key);
  return row !== undefined ? row.value : defaultValue;
}

export async function setSetting(key, value) {
  await db.settings.put({ key, value });
}

export async function getAllSettings() {
  const rows = await db.settings.toArray();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// ─── Books ───────────────────────────────────────────────────────────────────

export async function saveBook(bookData, chaptersData) {
  const { v4: uuid } = await import('uuid');
  const bookId = uuid();
  const now = Date.now();

  const book = {
    id: bookId,
    title: bookData.title || 'Bez tytułu',
    author: bookData.author || '',
    lang: bookData.lang || '',
    cover: bookData.cover || null,
    tocJson: JSON.stringify(bookData.toc || []),
    chapterCount: chaptersData.length,
    createdAt: now,
    deletedAt: null,
  };

  const chapters = chaptersData.map((ch, idx) => ({
    id: uuid(),
    bookId,
    chapterIndex: idx,
    href: ch.href || '',
    title: ch.title || '',
    html: ch.html || '',
    text: ch.text || '',
    pendingSync:     { meta: true, langs: [] },
    pendingSyncFlag: 1,
  }));

  await db.transaction('rw', db.books, db.chapters, async () => {
    await db.books.add(book);
    await db.chapters.bulkAdd(chapters);
  });

  return bookId;
}

export async function softDeleteBook(bookId) {
  const deletedAt = Date.now();
  await db.books.update(bookId, { deletedAt });
  return deletedAt;
}

export async function updateBookMetadata(bookId, updates) {
  const existing = await db.books.get(bookId);
  if (!existing) {
    throw new Error('Nie znaleziono książki do aktualizacji.');
  }

  const nextBook = {
    ...existing,
    title: updates.title?.trim() || 'Bez tytułu',
    author: updates.author?.trim() || '',
    lang: updates.lang || '',
  };

  await db.books.put(nextBook);
  return nextBook;
}

export async function purgeBookData(bookId, { keepBookRecord = true } = {}) {
  const chapters = await db.chapters.where('bookId').equals(bookId).toArray();
  const chapterIds = chapters.map(ch => ch.id);

  await db.transaction('rw', db.books, db.chapters, db.polyglotCache, db.readingPositions, async () => {
    if (chapterIds.length) {
      await db.polyglotCache.where('chapterId').anyOf(chapterIds).delete();
    }
    await db.chapters.where('bookId').equals(bookId).delete();
    await db.readingPositions.delete(bookId);
    if (!keepBookRecord) {
      await db.books.delete(bookId);
    }
  });
}

export async function getActiveBooks() {
  const all = await db.books.orderBy('createdAt').toArray();
  return all.filter(b => !b.deletedAt);
}

export async function getBook(bookId) {
  return db.books.get(bookId);
}

export async function getChapter(bookId, chapterIndex) {
  return db.chapters.where('[bookId+chapterIndex]').equals([bookId, chapterIndex]).first();
}

export async function getPolyglotCache(chapterId, targetLang) {
  const entry = await db.polyglotCache
    .where('[chapterId+targetLang]')
    .equals([chapterId, targetLang])
    .first();
  return isSupportedPolyglotValue(entry) ? entry : null;
}

export async function getChapterCachedLangs(chapterId) {
  const all = await db.polyglotCache.where('chapterId').equals(chapterId).toArray();
  return [...new Set(all.filter(isSupportedPolyglotValue).map(c => c.targetLang))];
}

function isSupportedPolyglotValue(value) {
  return !!(
    value &&
    typeof value === 'object' &&
    value.format === 'sentence-word-select-v2' &&
    value.payload?.version === 2 &&
    Array.isArray(value.payload?.changes)
  );
}

function normalizePolyglotValue(value) {
  if (!isSupportedPolyglotValue(value)) return null;
  return {
    format: 'sentence-word-select-v2',
    rawText: null,
    payload: {
      version: 2,
      changes: value.payload.changes,
    },
  };
}

export async function savePolyglotCache(chapterId, targetLang, value) {
  const normalized = normalizePolyglotValue(value);
  if (!normalized) throw new Error('Obslugiwany jest juz tylko nowy format tlumaczen.');
  const existing = await db.polyglotCache
    .where('[chapterId+targetLang]').equals([chapterId, targetLang]).first();
  const { v4: uuid } = await import('uuid');
  await db.polyglotCache.put({
    id: existing?.id ?? uuid(),
    chapterId,
    targetLang,
    ...normalized,
    createdAt: Date.now(),
  });
  await markPolyPending(chapterId, targetLang);
}

async function deletePolyglotCache(chapterId, targetLang) {
  const existing = await db.polyglotCache
    .where('[chapterId+targetLang]').equals([chapterId, targetLang]).first();
  if (!existing) return false;
  await db.polyglotCache.delete(existing.id);
  await clearPolyPending(chapterId, targetLang);
  return true;
}

export async function getReadingPosition(bookId) {
  const row = await db.readingPositions.get(bookId);
  return normalizeReadingPosition(row);
}

function clampProgress(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(1, num));
}

function normalizeBookmark(bookmark) {
  if (!bookmark || typeof bookmark !== 'object') return null;

  const id = typeof bookmark.id === 'string' ? bookmark.id.trim() : '';
  if (!id) return null;

  const chapterIndex = Number(bookmark.chapterIndex);
  if (!Number.isFinite(chapterIndex)) return null;

  const createdAt = Number(bookmark.createdAt) || Date.now();
  const updatedAt = Number(bookmark.updatedAt) || createdAt;
  const deletedAt =
    bookmark.deletedAt === null || bookmark.deletedAt === undefined
      ? null
      : Number(bookmark.deletedAt) || updatedAt;

  return {
    id,
    chapterIndex: Math.max(0, Math.floor(chapterIndex)),
    progress: clampProgress(bookmark.progress ?? 0),
    chapterTitle: typeof bookmark.chapterTitle === 'string' ? bookmark.chapterTitle : '',
    preview: typeof bookmark.preview === 'string' ? bookmark.preview : '',
    page: Number.isFinite(Number(bookmark.page)) ? Math.max(0, Math.floor(Number(bookmark.page))) : null,
    totalPages: Number.isFinite(Number(bookmark.totalPages))
      ? Math.max(1, Math.floor(Number(bookmark.totalPages)))
      : null,
    createdAt,
    updatedAt,
    deletedAt,
  };
}

function normalizeBookmarks(value) {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = [];
    }
  }

  if (!Array.isArray(raw)) return [];

  return raw
    .map(normalizeBookmark)
    .filter(Boolean)
    .sort((a, b) => {
      if (a.chapterIndex !== b.chapterIndex) return a.chapterIndex - b.chapterIndex;
      if (a.progress !== b.progress) return a.progress - b.progress;
      return (a.createdAt ?? 0) - (b.createdAt ?? 0);
    });
}

function normalizeReadingPosition(row) {
  if (!row) return null;
  return {
    ...row,
    progress: clampProgress(row.progress ?? 0),
    activeLang: typeof row.activeLang === 'string' && row.activeLang ? row.activeLang : null,
    bookmarks: normalizeBookmarks(row.bookmarks),
  };
}

export async function saveReadingPosition(
  bookId,
  chapterIndex,
  progress = 0,
  activeLang = null,
  extras = {},
) {
  const existing = normalizeReadingPosition(await db.readingPositions.get(bookId));
  await db.readingPositions.put({
    ...(existing || { bookId }),
    chapterIndex,
    progress: clampProgress(progress),
    activeLang:
      typeof activeLang === 'string' && activeLang.trim() ? activeLang : null,
    bookmarks: normalizeBookmarks(
      Object.prototype.hasOwnProperty.call(extras, 'bookmarks')
        ? extras.bookmarks
        : existing?.bookmarks,
    ),
    updatedAt: Number(extras.updatedAt) || Date.now(),
  });
}

export async function getBookWithChapters(bookId) {
  const book = await db.books.get(bookId);
  if (!book) return null;
  const chapters = await db.chapters.where('bookId').equals(bookId).sortBy('chapterIndex');
  return { ...book, chapters };
}

// Restore a book from cloud (uses original IDs, skips if already exists)
export async function restoreBook(bookData) {
  const { chapters = [], ...book } = bookData;
  const exists = await db.books.get(book.id);
  if (exists) return;
  await db.transaction('rw', db.books, db.chapters, async () => {
    await db.books.add(book);
    if (chapters.length) await db.chapters.bulkAdd(chapters);
  });
}

export async function restoreChapter(chapterData) {
  const exists = await db.chapters.get(chapterData.id);
  if (exists) return;
  // Restored chapters are already on server — not pending
  await db.chapters.add({ ...chapterData, pendingSync: null, pendingSyncFlag: 0 });
}

export async function restorePolyglotCache(chapterId, targetLang, value) {
  const normalized = normalizePolyglotValue(value);
  if (!normalized) return false;
  const exists = await db.polyglotCache
    .where('[chapterId+targetLang]').equals([chapterId, targetLang]).first();
  if (exists) return;
  const { v4: uuid } = await import('uuid');
  await db.polyglotCache.put({
    id: uuid(),
    chapterId,
    targetLang,
    ...normalized,
    createdAt: Date.now(),
  });
  return true;
}

// ─── Audio cache ──────────────────────────────────────────────────────────────

// ─── Chapter language memory ──────────────────────────────────────────────────

/** Persist the language chosen for a specific chapter. langCode=null clears it. */
export async function saveChapterLang(bookId, chapterIndex, langCode) {
  const pos = await db.readingPositions.get(bookId);
  const map = JSON.parse(pos?.chapterLang || '{}');
  if (langCode) map[String(chapterIndex)] = langCode;
  else delete map[String(chapterIndex)];
  await db.readingPositions.put({ ...(pos || { bookId }), chapterLang: JSON.stringify(map) });
}

/** Get the saved language for a specific chapter, or null. */
async function getChapterLang(bookId, chapterIndex) {
  const pos = await db.readingPositions.get(bookId);
  if (!pos?.chapterLang) return null;
  const map = JSON.parse(pos.chapterLang);
  return map[String(chapterIndex)] ?? null;
}

/** Returns { chapterIndex: { hasTranslation, translationLangs, chapterId } } for all chapters. */
export async function getChapterStatusMap(bookId) {
  const chapters = await db.chapters.where('bookId').equals(bookId).sortBy('chapterIndex');
  const chapterIds = chapters.map(c => c.id);
  if (!chapterIds.length) return {};

  const polyEntries = await db.polyglotCache.where('chapterId').anyOf(chapterIds).toArray();
  const langsByChapterId = new Map();
  for (const entry of polyEntries) {
    if (!isSupportedPolyglotValue(entry)) continue;
    if (!langsByChapterId.has(entry.chapterId)) {
      langsByChapterId.set(entry.chapterId, new Set());
    }
    langsByChapterId.get(entry.chapterId).add(entry.targetLang);
  }

  const map = {};
  for (const ch of chapters) {
    const translationLangs = [...(langsByChapterId.get(ch.id) ?? [])];
    map[ch.chapterIndex] = {
      hasTranslation: translationLangs.length > 0,
      translationLangs,
      chapterId: ch.id,
    };
  }
  return map;
}

/** Returns chapters sorted by index, each with hasPoly flag for given targetLang. */
export async function getBookChaptersWithCacheStatus(bookId, targetLang) {
  const chapters = await db.chapters
    .where('bookId').equals(bookId)
    .sortBy('chapterIndex');
  return Promise.all(chapters.map(async ch => {
    const cached = await db.polyglotCache
      .where('[chapterId+targetLang]').equals([ch.id, targetLang]).first();
    return { ...ch, hasPoly: isSupportedPolyglotValue(cached) };
  }));
}
