// Cloudflare sync — delta sync with UUID-based R2 paths
// R2 structure: {userId}/{bookId}/meta.json
//               {userId}/{bookId}/{chapterUUID}/metadata.json
//               {userId}/{bookId}/{chapterUUID}/{lang}.json

import { db, saveReadingPosition, getBookWithChapters, restoreBook, restoreChapter, restorePolyglotCache, getPendingChapters, clearChapterPending, clearPolyPending } from '../db';
import { getToken } from './cfAuth';

const WORKER_URL = import.meta.env.VITE_WORKER_URL ?? '';

// ─── Internal fetch wrapper ───────────────────────────────────────────────────

async function apiFetch(path, opts = {}, stats = null) {
  const token = getToken();
  if (!token) throw Object.assign(new Error('Brak autoryzacji'), { code: 'not_logged_in' });

  if (stats && opts.body) stats.sent += new TextEncoder().encode(opts.body).length;

  const resp = await fetch(`${WORKER_URL}${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => String(resp.status));
    throw new Error(`Worker ${resp.status}: ${text}`);
  }

  const text = await resp.text();
  if (stats) stats.received += new TextEncoder().encode(text).length;
  return JSON.parse(text);
}

// ─── Reading position helpers ─────────────────────────────────────────────────

function toRemoteData(local) {
  return {
    bookId:       local.bookId,
    chapterIndex: local.chapterIndex,
    scrollTop:    local.scrollTop  ?? 0,
    activeLang:   local.activeLang ?? null,
    sentenceIdx:  local.sentenceIdx ?? -1,
    updatedAt:    local.updatedAt  ?? Date.now(),
  };
}

async function applyRemote(remote) {
  await saveReadingPosition(
    remote.bookId,
    remote.chapterIndex,
    remote.scrollTop   ?? 0,
    remote.activeLang  ?? null,
    remote.sentenceIdx ?? -1,
  );
}

// ─── Poly sync helpers ────────────────────────────────────────────────────────

/**
 * Sync polyglot cache for one book (both directions).
 * remotePolys: [{chapterId, lang}] from server (/polys)
 * chapters: local chapter records for this book
 */
async function syncPolys(bookId, remotePolys, chapters, stats) {
  const chapterById = Object.fromEntries(chapters.map(c => [c.id, c]));

  const chapterIds = chapters.map(c => c.id);
  const localPolys = chapterIds.length
    ? await db.polyglotCache.where('chapterId').anyOf(chapterIds).toArray()
    : [];

  const localPolySet  = new Set(localPolys.map(p => `${p.chapterId}:${p.targetLang}`));
  const remotePolySet = new Set(remotePolys.map(p => `${p.chapterId}:${p.lang}`));

  // Download polys missing locally
  for (const { chapterId, lang } of remotePolys) {
    if (localPolySet.has(`${chapterId}:${lang}`)) continue;
    if (!chapterById[chapterId]) continue;
    try {
      const poly = await apiFetch(`/books/${bookId}/chapters/${chapterId}/translations/${lang}`, {}, stats);
      await restorePolyglotCache(chapterId, lang, poly.rawText);
    } catch {
      // poly missing on server — skip
    }
  }

  // Upload polys missing on server
  for (const poly of localPolys) {
    if (remotePolySet.has(`${poly.chapterId}:${poly.targetLang}`)) continue;
    await apiFetch(
      `/books/${bookId}/chapters/${poly.chapterId}/translations/${poly.targetLang}`,
      { method: 'POST', body: JSON.stringify({ rawText: poly.rawText }) },
      stats,
    );
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Upload only what has changed since last sync (pendingSyncFlag=1).
 * No-op if not logged in.
 */
export async function syncPending() {
  if (!getToken()) return { uploaded: 0, error: 'Brak autoryzacji' };

  const stats = { sent: 0, received: 0 };
  let uploaded = 0;

  try {
    const pendingChapters = await getPendingChapters();

    for (const ch of pendingChapters) {
      const pending = ch.pendingSync;
      if (!pending) continue;

      if (pending.meta) {
        await apiFetch(`/books/${ch.bookId}/chapters/${ch.id}`, {
          method: 'POST',
          body: JSON.stringify({
            id: ch.id,
            bookId: ch.bookId,
            chapterIndex: ch.chapterIndex,
            href: ch.href,
            title: ch.title,
            html: ch.html,
            text: ch.text,
          }),
        }, stats);
      }

      for (const lang of (pending.langs ?? [])) {
        const poly = await db.polyglotCache
          .where('[chapterId+targetLang]').equals([ch.id, lang]).first();
        if (!poly) continue;
        await apiFetch(
          `/books/${ch.bookId}/chapters/${ch.id}/translations/${lang}`,
          { method: 'POST', body: JSON.stringify({ rawText: poly.rawText }) },
          stats,
        );
      }

      await clearChapterPending(ch.id);
      uploaded++;
    }

    return { uploaded, error: null };
  } catch (err) {
    console.warn('[CF sync] syncPending failed:', err.message);
    return { uploaded, error: err.message };
  }
}

/**
 * Sync a single book's reading position — call after saving local position.
 * No-op if not logged in.
 */
export async function syncBook(bookId) {
  if (!getToken()) return;
  try {
    const [local, remotePositions] = await Promise.all([
      db.readingPositions.get(bookId),
      apiFetch('/progress'),
    ]);
    const remote = remotePositions.find(p => p.bookId === bookId);

    if (!remote) {
      if (local) await apiFetch(`/progress/${bookId}`, { method: 'POST', body: JSON.stringify(toRemoteData(local)) });
      return;
    }

    if (!local || remote.updatedAt > (local.updatedAt ?? 0)) {
      await applyRemote(remote);
    } else if ((local.updatedAt ?? 0) > remote.updatedAt) {
      await apiFetch(`/progress/${bookId}`, { method: 'POST', body: JSON.stringify(toRemoteData(local)) });
    }
  } catch (err) {
    console.warn('[CF sync] syncBook failed:', err.message);
  }
}

/**
 * Upload a new book (meta + all chapters + existing polys).
 * Called after importing a book locally. No-op if not logged in.
 */
export async function uploadBook(bookId) {
  if (!getToken()) return;
  try {
    const bookData = await getBookWithChapters(bookId);
    if (!bookData) return;

    const { chapters = [], ...meta } = bookData;

    // 1. Upload meta
    await apiFetch(`/books/${bookId}`, { method: 'POST', body: JSON.stringify(meta) });

    // 2. Upload chapters via UUID-based paths
    for (const ch of chapters) {
      await apiFetch(`/books/${bookId}/chapters/${ch.id}`, {
        method: 'POST',
        body: JSON.stringify(ch),
      });
    }

    // 3. Upload any existing local polys (usually none right after import)
    const chapterIds = chapters.map(c => c.id);
    if (chapterIds.length) {
      const localPolys = await db.polyglotCache.where('chapterId').anyOf(chapterIds).toArray();
      for (const poly of localPolys) {
        await apiFetch(`/books/${bookId}/chapters/${poly.chapterId}/translations/${poly.targetLang}`, {
          method: 'POST',
          body: JSON.stringify({ rawText: poly.rawText }),
        });
      }
    }

    // Mark all chapters as synced after successful upload
    for (const ch of chapters) {
      await clearChapterPending(ch.id);
    }
  } catch (err) {
    console.warn('[CF sync] uploadBook failed:', err.message);
  }
}

/**
 * Upload a single polyglot result right after generation.
 * chapterId is the chapter UUID (not chapterIndex).
 * No-op if not logged in. On failure, pending flag already set — syncPending() will retry.
 */
export async function uploadPolyglot(bookId, chapterId, targetLang, rawText) {
  if (!getToken()) return;
  try {
    await apiFetch(`/books/${bookId}/chapters/${chapterId}/translations/${targetLang}`, {
      method: 'POST',
      body: JSON.stringify({ rawText }),
    });
    // Uploaded successfully — clear just this lang from pending
    await clearPolyPending(chapterId, targetLang);
  } catch (err) {
    console.warn('[CF sync] uploadPolyglot failed (will retry via syncPending):', err.message);
    // pendingSync flag already set by savePolyglotCache — no action needed
  }
}

/**
 * Full bidirectional sync:
 *   0. Flush local pending changes (delta upload)
 *   1. Sync all reading positions (both directions)
 *   2. Apply deletedAt changes from remote manifest → local
 *   3. Download books missing locally (meta + chapters + polys)
 *   4. Upload new local books (meta + chapters + polys)
 *   5. Sync polys for books present on both sides
 *
 * onProgress(done, total) called after each book-level item.
 */
export async function syncAll(onProgress) {
  if (!getToken()) return { synced: 0, error: 'Brak autoryzacji' };

  const stats = { sent: 0, received: 0 };

  try {
    // ── 0. Flush pending changes first ──
    await syncPending();

    const [remoteManifest, remotePositions, localPositions, allLocalBooks] = await Promise.all([
      apiFetch('/books', {}, stats),
      apiFetch('/progress', {}, stats),
      db.readingPositions.toArray(),
      db.books.toArray(),
    ]);

    const localPosMap       = Object.fromEntries(localPositions.map(p => [p.bookId, p]));
    const localBookMap      = Object.fromEntries(allLocalBooks.map(b => [b.id, b]));
    const remotePosMap      = Object.fromEntries(remotePositions.map(p => [p.bookId, p]));
    const remoteManifestMap = Object.fromEntries(remoteManifest.map(e => [e.book_id, e]));

    const localOnlyPositions = localPositions.filter(l => !remotePosMap[l.bookId]);
    const booksToDownload    = remoteManifest.filter(e => !localBookMap[e.book_id] && !e.deleted_at);
    const booksToUpload      = allLocalBooks.filter(b => !remoteManifestMap[b.id]);
    // Books present on both sides (not deleted) — sync polys only
    const booksToPolySync    = allLocalBooks.filter(b => remoteManifestMap[b.id] && !b.deletedAt && !remoteManifestMap[b.id].deleted_at);

    const total =
      remotePositions.length +
      localOnlyPositions.length +
      booksToDownload.length +
      booksToUpload.length;

    let synced = 0;
    onProgress?.(0, total);

    // ── Positions: remote → local (last-write-wins) ──
    for (const remote of remotePositions) {
      const local = localPosMap[remote.bookId];
      if (!local || remote.updatedAt > (local.updatedAt ?? 0)) {
        await applyRemote(remote);
      } else if ((local.updatedAt ?? 0) > remote.updatedAt) {
        await apiFetch(`/progress/${remote.bookId}`, { method: 'POST', body: JSON.stringify(toRemoteData(local)) }, stats);
      }
      synced++;
      onProgress?.(synced, total);
    }

    // ── Positions: local-only → push to remote ──
    for (const local of localOnlyPositions) {
      await apiFetch(`/progress/${local.bookId}`, { method: 'POST', body: JSON.stringify(toRemoteData(local)) }, stats);
      synced++;
      onProgress?.(synced, total);
    }

    // ── Apply deletedAt from remote manifest → local DB ──
    for (const entry of remoteManifest) {
      const local = localBookMap[entry.book_id];
      if (!local) continue;
      if (entry.deleted_at && !local.deletedAt) {
        await db.books.update(entry.book_id, { deletedAt: entry.deleted_at });
      } else if (!entry.deleted_at && local.deletedAt) {
        await apiFetch(`/books/${entry.book_id}`, {
          method: 'DELETE',
          body: JSON.stringify({ deletedAt: local.deletedAt }),
        }, stats);
      }
    }

    // ── Download books missing locally ──
    for (const entry of booksToDownload) {
      const bookId = entry.book_id;

      // meta
      const meta = await apiFetch(`/books/${bookId}`, {}, stats);
      await restoreBook(meta);

      // chapters — fetch UUID list then each chapter
      const chapterUUIDs = await apiFetch(`/books/${bookId}/chapters`, {}, stats);
      for (const chUUID of chapterUUIDs) {
        try {
          const ch = await apiFetch(`/books/${bookId}/chapters/${chUUID}`, {}, stats);
          await restoreChapter(ch);
        } catch {
          // chapter missing — skip
        }
      }

      // polys — fetch [{chapterId, lang}] then each translation
      const remotePolys = await apiFetch(`/books/${bookId}/polys`, {}, stats);
      for (const { chapterId, lang } of remotePolys) {
        try {
          const poly = await apiFetch(`/books/${bookId}/chapters/${chapterId}/translations/${lang}`, {}, stats);
          await restorePolyglotCache(chapterId, lang, poly.rawText);
        } catch {
          // poly missing — skip
        }
      }

      synced++;
      onProgress?.(synced, total);
    }

    // ── Upload new local books ──
    for (const book of booksToUpload) {
      const bookData = await getBookWithChapters(book.id);
      if (!bookData) continue;

      const { chapters = [], ...meta } = bookData;

      await apiFetch(`/books/${book.id}`, { method: 'POST', body: JSON.stringify(meta) }, stats);

      for (const ch of chapters) {
        await apiFetch(`/books/${book.id}/chapters/${ch.id}`, {
          method: 'POST',
          body: JSON.stringify(ch),
        }, stats);
      }

      // polys
      if (chapters.length) {
        const localPolys = await db.polyglotCache.where('chapterId').anyOf(chapters.map(c => c.id)).toArray();
        for (const poly of localPolys) {
          await apiFetch(`/books/${book.id}/chapters/${poly.chapterId}/translations/${poly.targetLang}`, {
            method: 'POST',
            body: JSON.stringify({ rawText: poly.rawText }),
          }, stats);
        }
      }

      // Mark as synced
      for (const ch of chapters) {
        await clearChapterPending(ch.id);
      }

      synced++;
      onProgress?.(synced, total);
    }

    // ── Sync polys for books on both sides ──
    for (const book of booksToPolySync) {
      try {
        const remotePolys = await apiFetch(`/books/${book.id}/polys`, {}, stats);
        const chapters = await db.chapters.where('bookId').equals(book.id).toArray();
        await syncPolys(book.id, remotePolys, chapters, stats);
      } catch {
        // non-fatal — skip this book's poly sync
      }
    }

    const now = Date.now();
    localStorage.setItem('vocabapp:lastSync', now);

    window.dispatchEvent(new CustomEvent('vocabapp:synced'));
    return {
      synced,
      error: null,
      sentMB:     +(stats.sent     / 1_048_576).toFixed(2),
      receivedMB: +(stats.received / 1_048_576).toFixed(2),
      lastSync:   now,
    };
  } catch (err) {
    console.warn('[CF sync] syncAll failed:', err.message);
    return { synced: 0, error: err.message };
  }
}
