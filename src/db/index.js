import Dexie from 'dexie';

export const db = new Dexie('VocabAppDB');

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
  const { v4: uuid } = await import('uuid');
  await db.polyglotCache.put({
    id: uuid(),
    chapterId,
    targetLang,
    rawText,
    createdAt: Date.now(),
  });
}

export async function getReadingPosition(bookId) {
  return db.readingPositions.get(bookId);
}

export async function saveReadingPosition(bookId, chapterIndex, scrollTop = 0, activeLang = null, sentenceIdx = -1) {
  await db.readingPositions.put({ bookId, chapterIndex, scrollTop, activeLang, sentenceIdx, updatedAt: Date.now() });
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
  await db.chapters.add(chapterData);
}

export async function restorePolyglotCache(chapterId, targetLang, rawText) {
  const exists = await db.polyglotCache
    .where('[chapterId+targetLang]').equals([chapterId, targetLang]).first();
  if (exists) return;
  const { v4: uuid } = await import('uuid');
  await db.polyglotCache.put({ id: uuid(), chapterId, targetLang, rawText, createdAt: Date.now() });
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
