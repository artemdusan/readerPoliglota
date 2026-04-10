// Cloudflare sync — delta sync with UUID-based R2 paths
// R2 structure: {userId}/{bookId}/meta.json
//               {userId}/{bookId}/{chapterUUID}/metadata.json
//               {userId}/{bookId}/{chapterUUID}/{lang}.json

import { db, saveReadingPosition, getBookWithChapters, restoreBook, restoreChapter, restorePolyglotCache, getPendingChapters, clearChapterPending, clearPolyPending } from '../db';
import { getToken } from './cfAuth';
import { getWorkerUrl } from '../config/workerUrl';

const WORKER_URL = getWorkerUrl();

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
    scrollTop:    local.progress   ?? 0,
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

// ─── Download missing polys (download-only — upload handled by syncPending) ──

async function downloadMissingPolys(bookId, remotePolys, chapters, stats) {
  const chapterById = Object.fromEntries(chapters.map(c => [c.id, c]));
  const chapterIds  = chapters.map(c => c.id);
  const localPolys  = chapterIds.length
    ? await db.polyglotCache.where('chapterId').anyOf(chapterIds).toArray()
    : [];
  const localPolySet = new Set(localPolys.map(p => `${p.chapterId}:${p.targetLang}`));

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
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Upload only what has changed since last sync (pendingSyncFlag=1).
 * Per-chapter error isolation — one failure doesn't abort others.
 * No-op if not logged in.
 */
export async function syncPending() {
  if (!getToken()) return { uploaded: 0, error: 'Brak autoryzacji' };

  const stats = { sent: 0, received: 0 };
  let uploaded = 0;
  let lastError = null;

  try {
    const pendingChapters = await getPendingChapters();

    for (const ch of pendingChapters) {
      try {
        const pending = ch.pendingSync;
        if (!pending) { await clearChapterPending(ch.id); continue; }

        if (pending.meta) {
          await apiFetch(`/books/${ch.bookId}/chapters/${ch.id}`, {
            method: 'POST',
            body: JSON.stringify({
              id:           ch.id,
              bookId:       ch.bookId,
              chapterIndex: ch.chapterIndex,
              href:         ch.href,
              title:        ch.title,
              html:         ch.html,
              text:         ch.text,
            }),
          }, stats);
        }

        for (const lang of (pending.langs ?? [])) {
          const poly = await db.polyglotCache
            .where('[chapterId+targetLang]').equals([ch.id, lang]).first();
          if (!poly) { await clearPolyPending(ch.id, lang); continue; }
          await apiFetch(
            `/books/${ch.bookId}/chapters/${ch.id}/translations/${lang}`,
            { method: 'POST', body: JSON.stringify({ rawText: poly.rawText }) },
            stats,
          );
        }

        await clearChapterPending(ch.id);
        uploaded++;
      } catch (err) {
        // Leave pendingSyncFlag=1 so it retries on next sync
        lastError = err.message;
        console.warn(`[CF sync] chapter ${ch.id} upload failed (will retry):`, err.message);
      }
    }

    return { uploaded, error: lastError };
  } catch (err) {
    console.warn('[CF sync] syncPending failed:', err.message);
    return { uploaded, error: err.message };
  }
}

/**
 * Fire-and-forget wrapper around syncPending.
 * Call after any local write (savePolyglotCache, saveBook) to push to server.
 */
export function triggerSync() {
  if (!getToken()) return;
  syncPending().catch(err => console.warn('[CF sync] background sync failed:', err.message));
}

/**
 * Upload book metadata to server so it appears in the manifest.
 * Chapter data and polys are handled by triggerSync() via pending flags.
 * No-op if not logged in.
 */
export async function uploadBook(bookId) {
  if (!getToken()) return;
  try {
    const book = await db.books.get(bookId);
    if (!book) return;
    await apiFetch(`/books/${bookId}`, { method: 'POST', body: JSON.stringify(book) });
    // Now upload chapters + polys via pending flags
    triggerSync();
  } catch (err) {
    console.warn('[CF sync] uploadBook failed:', err.message);
    // pendingSyncFlag is already set on chapters — syncAll will retry
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
 * Full bidirectional sync:
 *   0. Flush local pending changes (chapter data + polys)
 *   1. Sync all reading positions (both directions)
 *   2. Apply deletedAt changes from remote manifest → local
 *   3. Download books missing locally (meta + chapters + polys)
 *   4. Upload book META for local-only books (chapters already handled by step 0)
 *   5. Download missing polys for books present on both sides
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
    // Books local-only and NOT on server (uploadBook may have failed)
    const booksMetaToUpload  = allLocalBooks.filter(b => !b.deletedAt && !remoteManifestMap[b.id]);
    // Books present on both sides (not deleted) — download missing polys
    const booksToPolySync    = allLocalBooks.filter(b =>
      remoteManifestMap[b.id] && !b.deletedAt && !remoteManifestMap[b.id].deleted_at
    );

    const total =
      remotePositions.length +
      localOnlyPositions.length +
      booksToDownload.length +
      booksMetaToUpload.length;

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
      try {
        const meta = await apiFetch(`/books/${bookId}`, {}, stats);
        await restoreBook(meta);

        const chapterUUIDs = await apiFetch(`/books/${bookId}/chapters`, {}, stats);
        for (const chUUID of chapterUUIDs) {
          try {
            const ch = await apiFetch(`/books/${bookId}/chapters/${chUUID}`, {}, stats);
            await restoreChapter(ch);
          } catch {
            // chapter missing — skip
          }
        }

        const remotePolys = await apiFetch(`/books/${bookId}/polys`, {}, stats);
        for (const { chapterId, lang } of remotePolys) {
          try {
            const poly = await apiFetch(`/books/${bookId}/chapters/${chapterId}/translations/${lang}`, {}, stats);
            await restorePolyglotCache(chapterId, lang, poly.rawText);
          } catch {
            // poly missing — skip
          }
        }
      } catch {
        // book missing or broken — skip
      }

      synced++;
      onProgress?.(synced, total);
    }

    // ── Upload book META for local-only books (chapters already uploaded by syncPending in step 0) ──
    for (const book of booksMetaToUpload) {
      try {
        await apiFetch(`/books/${book.id}`, { method: 'POST', body: JSON.stringify(book) }, stats);
      } catch (err) {
        console.warn(`[CF sync] book meta upload failed for ${book.id}:`, err.message);
      }
      synced++;
      onProgress?.(synced, total);
    }

    // ── Download missing polys for books on both sides ──
    for (const book of booksToPolySync) {
      try {
        const remotePolys = await apiFetch(`/books/${book.id}/polys`, {}, stats);
        const chapters    = await db.chapters.where('bookId').equals(book.id).toArray();
        await downloadMissingPolys(book.id, remotePolys, chapters, stats);
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
