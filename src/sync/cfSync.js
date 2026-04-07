// Cloudflare sync — replaces syncManager.js
// Uses D1 (metadata + positions) and R2 (full book blobs) via the Worker API.

import { db, saveReadingPosition, getBookWithChapters, restoreBook } from '../db';
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
    polyMode:     local.polyMode   ?? false,
    sentenceIdx:  local.sentenceIdx ?? -1,
    updatedAt:    local.updatedAt  ?? Date.now(),
  };
}

async function applyRemote(remote) {
  await saveReadingPosition(
    remote.bookId,
    remote.chapterIndex,
    remote.scrollTop   ?? 0,
    remote.polyMode    ?? false,
    remote.sentenceIdx ?? -1,
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

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
 * Upload a new book to Cloudflare — call after adding a book locally.
 * No-op if not logged in.
 */
export async function uploadBook(bookId) {
  if (!getToken()) return;
  try {
    const bookData = await getBookWithChapters(bookId);
    if (!bookData) return;
    await apiFetch(`/books/${bookId}`, { method: 'POST', body: JSON.stringify(bookData) });
  } catch (err) {
    console.warn('[CF sync] uploadBook failed:', err.message);
  }
}

/**
 * Full bidirectional sync:
 *   1. Sync all reading positions (both directions)
 *   2. Apply deletedAt changes from remote manifest → local
 *   3. Download books missing locally
 *   4. Upload new local books
 *
 * onProgress(done, total) called after each item.
 */
export async function syncAll(onProgress) {
  if (!getToken()) return { synced: 0, error: 'Brak autoryzacji' };

  const stats = { sent: 0, received: 0 };

  try {
    const [remoteManifest, remotePositions, localPositions, allLocalBooks] = await Promise.all([
      apiFetch('/books', {}, stats),
      apiFetch('/progress', {}, stats),
      db.readingPositions.toArray(),
      db.books.toArray(), // includes soft-deleted
    ]);

    const localPosMap      = Object.fromEntries(localPositions.map(p => [p.bookId, p]));
    const localBookMap     = Object.fromEntries(allLocalBooks.map(b => [b.id, b]));
    const remotePosMap     = Object.fromEntries(remotePositions.map(p => [p.bookId, p]));
    const remoteManifestMap = Object.fromEntries(remoteManifest.map(e => [e.book_id, e]));

    const localOnlyPositions = localPositions.filter(l => !remotePosMap[l.bookId]);
    const booksToDownload    = remoteManifest.filter(e => !localBookMap[e.book_id] && !e.deleted_at);
    const booksToUpload      = allLocalBooks.filter(b => !remoteManifestMap[b.id]);

    const total =
      remotePositions.length +
      localOnlyPositions.length +
      booksToDownload.length +
      booksToUpload.length;

    let synced = 0;
    onProgress?.(0, total);

    // Positions: remote → local (last-write-wins)
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

    // Positions: local-only → push to remote
    for (const local of localOnlyPositions) {
      await apiFetch(`/progress/${local.bookId}`, { method: 'POST', body: JSON.stringify(toRemoteData(local)) }, stats);
      synced++;
      onProgress?.(synced, total);
    }

    // Apply deletedAt from remote manifest → local DB
    for (const entry of remoteManifest) {
      const local = localBookMap[entry.book_id];
      if (!local) continue;
      if (entry.deleted_at && !local.deletedAt) {
        await db.books.update(entry.book_id, { deletedAt: entry.deleted_at });
      } else if (!entry.deleted_at && local.deletedAt) {
        // Local was deleted but remote isn't — push deletion to remote
        await apiFetch(`/books/${entry.book_id}`, {
          method: 'DELETE',
          body: JSON.stringify({ deletedAt: local.deletedAt }),
        }, stats);
      }
    }

    // Download books missing locally
    for (const entry of booksToDownload) {
      const bookData = await apiFetch(`/books/${entry.book_id}`, {}, stats);
      await restoreBook(bookData);
      synced++;
      onProgress?.(synced, total);
    }

    // Upload new local books
    for (const book of booksToUpload) {
      const bookData = await getBookWithChapters(book.id);
      if (bookData) {
        await apiFetch(`/books/${book.id}`, { method: 'POST', body: JSON.stringify(bookData) }, stats);
      }
      synced++;
      onProgress?.(synced, total);
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
