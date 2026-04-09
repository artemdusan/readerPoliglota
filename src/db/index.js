import Dexie from 'dexie';

export const db = new Dexie('ReaderDB');

db.version(1).stores({
  // books: metadata + TOC; cover is base64 data URL stored here
  books: 'id, title, createdAt, deletedAt',
  // chapters: parsed HTML/text content per chapter
  chapters: 'id, bookId, chapterIndex, [bookId+chapterIndex]',
  // polyglotCache: LLM output cached per chapter + target language
  polyglotCache: 'id, chapterId, targetLang, [chapterId+targetLang]',
  // readingPositions: one record per book, bookId is primary key
  readingPositions: 'bookId',
  // settings: key-value store for app settings
  settings: 'key',
});

// v2: add pendingSyncFlag index to chapters for delta sync tracking
db.version(2).stores({
  books:            'id, title, createdAt, deletedAt',
  chapters:         'id, bookId, chapterIndex, [bookId+chapterIndex], pendingSyncFlag',
  polyglotCache:    'id, chapterId, targetLang, [chapterId+targetLang]',
  readingPositions: 'bookId',
  settings:         'key',
}).upgrade(async tx => {
  // Mark all existing chapters as pending (meta + all cached langs) so they
  // get re-uploaded to the new UUID-based R2 structure on next syncAll.
  const allChapters = await tx.table('chapters').toArray();
  const allPolys    = await tx.table('polyglotCache').toArray();
  const polysByChapter = {};
  for (const p of allPolys) (polysByChapter[p.chapterId] ??= []).push(p.targetLang);
  for (const ch of allChapters) {
    const langs = polysByChapter[ch.id] ?? [];
    await tx.table('chapters').update(ch.id, {
      pendingSync:     { meta: true, langs },
      pendingSyncFlag: 1,
    });
  }
});

// v3: add audioCache for Polly TTS (marks stored locally, audio streamed from R2)
db.version(3).stores({
  books:            'id, title, createdAt, deletedAt',
  chapters:         'id, bookId, chapterIndex, [bookId+chapterIndex], pendingSyncFlag',
  polyglotCache:    'id, chapterId, targetLang, [chapterId+targetLang]',
  readingPositions: 'bookId',
  settings:         'key',
  audioCache:       '[chapterId+voiceId], chapterId',
});

// ─── Pending sync helpers ─────────────────────────────────────────────────────

export async function markChapterMetaPending(chapterId) {
  const ch = await db.chapters.get(chapterId);
  if (!ch) return;
  const pending = ch.pendingSync ?? { meta: false, langs: [] };
  await db.chapters.update(chapterId, {
    pendingSync:     { ...pending, meta: true },
    pendingSyncFlag: 1,
  });
}

export async function markPolyPending(chapterId, lang) {
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
  await db.books.update(bookId, { deletedAt: Date.now() });
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
  return db.polyglotCache
    .where('[chapterId+targetLang]')
    .equals([chapterId, targetLang])
    .first();
}

export async function getChapterCachedLangs(chapterId) {
  const all = await db.polyglotCache.where('chapterId').equals(chapterId).toArray();
  return [...new Set(all.map(c => c.targetLang))];
}

export async function savePolyglotCache(chapterId, targetLang, rawText) {
  const existing = await db.polyglotCache
    .where('[chapterId+targetLang]').equals([chapterId, targetLang]).first();
  const { v4: uuid } = await import('uuid');
  await db.polyglotCache.put({
    id: existing?.id ?? uuid(),
    chapterId,
    targetLang,
    rawText,
    createdAt: Date.now(),
  });
  await markPolyPending(chapterId, targetLang);
}

export async function getReadingPosition(bookId) {
  return db.readingPositions.get(bookId);
}

export async function saveReadingPosition(bookId, chapterIndex, progress = 0, activeLang = null) {
  await db.readingPositions.put({ bookId, chapterIndex, progress, activeLang, updatedAt: Date.now() });
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

export async function restorePolyglotCache(chapterId, targetLang, rawText) {
  const exists = await db.polyglotCache
    .where('[chapterId+targetLang]').equals([chapterId, targetLang]).first();
  if (exists) return;
  const { v4: uuid } = await import('uuid');
  await db.polyglotCache.put({ id: uuid(), chapterId, targetLang, rawText, createdAt: Date.now() });
}

// ─── Audio cache ──────────────────────────────────────────────────────────────

export async function getAudioCache(chapterId, voiceId) {
  return db.audioCache.get([chapterId, voiceId]);
}

export async function saveAudioCache(chapterId, voiceId, marks, chunkCount = 1) {
  await db.audioCache.put({ chapterId, voiceId, marks, chunkCount, createdAt: Date.now() });
}

/** Returns chapters sorted by index, each with hasPoly flag for given targetLang. */
export async function getBookChaptersWithCacheStatus(bookId, targetLang) {
  const chapters = await db.chapters
    .where('bookId').equals(bookId)
    .sortBy('chapterIndex');
  return Promise.all(chapters.map(async ch => {
    const cached = await db.polyglotCache
      .where('[chapterId+targetLang]').equals([ch.id, targetLang]).first();
    return { ...ch, hasPoly: !!cached };
  }));
}
