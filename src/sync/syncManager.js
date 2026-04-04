import { db, saveReadingPosition, getBookWithChapters, restoreBook } from '../db';
import { getAccessToken } from './googleAuth';
import {
  listAllProgressFiles, downloadFile,
  upsertProgressFile, findProgressFile,
  findFile, upsertFile,
} from './driveApi';

let _lastSyncAt = 0;
let _bookSyncTimers = {};
let _autoSyncInitialized = false;

const MANIFEST_NAME = 'books_manifest.json';

// --- Reading position helpers ---

function toRemoteData(local) {
  return {
    bookId: local.bookId,
    chapterIndex: local.chapterIndex,
    scrollTop: local.scrollTop ?? 0,
    polyMode: local.polyMode ?? false,
    sentenceIdx: local.sentenceIdx ?? -1,
    updatedAt: local.updatedAt ?? Date.now(),
  };
}

async function applyRemote(remote) {
  await saveReadingPosition(
    remote.bookId,
    remote.chapterIndex,
    remote.scrollTop ?? 0,
    remote.polyMode ?? false,
    remote.sentenceIdx ?? -1,
  );
}

// --- Manifest helpers ---

async function fetchManifest(token) {
  const file = await findFile(MANIFEST_NAME, token);
  if (!file) return [];
  return downloadFile(file.id, token);
}

async function pushManifest(entries, token) {
  await upsertFile(MANIFEST_NAME, entries, token);
}

// --- Public API ---

// Sync a single book's reading position — call after saving local position
export async function syncBook(bookId) {
  let token;
  try { token = await getAccessToken(); } catch { return; }

  try {
    const [local, remoteFile] = await Promise.all([
      db.readingPositions.get(bookId),
      findProgressFile(bookId, token),
    ]);

    if (!remoteFile) {
      if (local) await upsertProgressFile(bookId, toRemoteData(local), token);
      return;
    }

    const remote = await downloadFile(remoteFile.id, token);

    if (!local || remote.updatedAt > (local.updatedAt ?? 0)) {
      await applyRemote(remote);
    } else if ((local.updatedAt ?? 0) > remote.updatedAt) {
      await upsertProgressFile(bookId, toRemoteData(local), token);
    }
  } catch (err) {
    console.warn('[Drive sync] syncBook failed:', err.message);
  }
}

// Upload a book to Drive and add it to the manifest — call after adding a new book locally
export async function uploadBook(bookId) {
  let token;
  try { token = await getAccessToken(); } catch { return; }

  try {
    const bookData = await getBookWithChapters(bookId);
    if (!bookData) return;

    // Upload full book file
    await upsertFile(`book_${bookId}.json`, bookData, token);

    // Add to manifest
    const manifest = await fetchManifest(token);
    const alreadyInManifest = manifest.some(e => e.id === bookId);
    if (!alreadyInManifest) {
      manifest.push({ id: bookId, title: bookData.title, author: bookData.author, deletedAt: bookData.deletedAt ?? null });
      await pushManifest(manifest, token);
    }
  } catch (err) {
    console.warn('[Drive sync] uploadBook failed:', err.message);
  }
}

// Full sync:
//   1. Sync reading positions (both directions)
//   2. Download manifest — apply deletedAt changes, download missing books
//   3. Upload new local books + update manifest
// onProgress(done, total) called after each item
export async function syncAll(onProgress) {
  let token;
  try { token = await getAccessToken(); } catch { return { synced: 0, error: 'Brak autoryzacji' }; }

  _lastSyncAt = Date.now();

  try {
    const [remoteProgressFiles, remoteManifest, localPositions, allLocalBooks] = await Promise.all([
      listAllProgressFiles(token),
      fetchManifest(token),
      db.readingPositions.toArray(),
      db.books.toArray(), // includes soft-deleted
    ]);

    const localPosMap = Object.fromEntries(localPositions.map(p => [p.bookId, p]));
    const localBookMap = Object.fromEntries(allLocalBooks.map(b => [b.id, b]));
    const remoteManifestMap = Object.fromEntries(remoteManifest.map(e => [e.id, e]));

    // Local positions with no remote file
    const localOnlyPositions = localPositions.filter(
      l => !remoteProgressFiles.find(rf => rf.name === `progress_${l.bookId}.json`)
    );
    // Books missing locally (in manifest but not in local DB)
    const booksToDownload = remoteManifest.filter(e => !localBookMap[e.id]);
    // Local books missing from manifest
    const booksToUpload = allLocalBooks.filter(b => !remoteManifestMap[b.id]);
    // Books where deletedAt differs between local and manifest
    const deletedAtChanges = allLocalBooks.filter(b => {
      const remote = remoteManifestMap[b.id];
      return remote && remote.deletedAt !== (b.deletedAt ?? null);
    });

    const total =
      remoteProgressFiles.length +
      localOnlyPositions.length +
      booksToDownload.length +
      booksToUpload.length;

    let synced = 0;
    onProgress?.(0, total);

    // Sync reading positions — remote → local
    for (const rf of remoteProgressFiles) {
      const bookId = rf.name.replace(/^progress_/, '').replace(/\.json$/, '');
      const remote = await downloadFile(rf.id, token);
      const local = localPosMap[bookId];

      if (!local || remote.updatedAt > (local.updatedAt ?? 0)) {
        await applyRemote(remote);
      } else if ((local.updatedAt ?? 0) > remote.updatedAt) {
        await upsertProgressFile(bookId, toRemoteData(local), token);
      }

      synced++;
      onProgress?.(synced, total);
    }

    // Sync reading positions — local only → remote
    for (const local of localOnlyPositions) {
      await upsertProgressFile(local.bookId, toRemoteData(local), token);
      synced++;
      onProgress?.(synced, total);
    }

    // Apply deletedAt changes from manifest → local
    for (const entry of remoteManifest) {
      const local = localBookMap[entry.id];
      if (!local) continue;
      if (entry.deletedAt && !local.deletedAt) {
        await db.books.update(entry.id, { deletedAt: entry.deletedAt });
      } else if (!entry.deletedAt && local.deletedAt) {
        // Local deleted, remote not — update manifest to reflect deletion
        entry.deletedAt = local.deletedAt;
      }
    }

    // Download books missing locally (manifest-first: no re-downloading existing books)
    for (const entry of booksToDownload) {
      const file = await findFile(`book_${entry.id}.json`, token);
      if (file) {
        const bookData = await downloadFile(file.id, token);
        await restoreBook(bookData);
      }
      synced++;
      onProgress?.(synced, total);
    }

    // Upload new local books + extend manifest
    let manifestChanged = deletedAtChanges.length > 0;
    for (const book of booksToUpload) {
      const bookData = await getBookWithChapters(book.id);
      if (bookData) await upsertFile(`book_${book.id}.json`, bookData, token);
      remoteManifest.push({ id: book.id, title: book.title, author: book.author, deletedAt: book.deletedAt ?? null });
      manifestChanged = true;
      synced++;
      onProgress?.(synced, total);
    }

    if (manifestChanged) await pushManifest(remoteManifest, token);

    window.dispatchEvent(new CustomEvent('vocabapp:synced'));
    return { synced, error: null };
  } catch (err) {
    console.warn('[Drive sync] syncAll failed:', err.message);
    return { synced: 0, error: err.message };
  }
}

// Debounced single-book position sync — call after saving local position
export function scheduleBookSync(bookId) {
  clearTimeout(_bookSyncTimers[bookId]);
  _bookSyncTimers[bookId] = setTimeout(() => {
    delete _bookSyncTimers[bookId];
    syncBook(bookId);
  }, 5000);
}

// Register window focus + interval triggers — call once on app init
export function initAutoSync() {
  if (_autoSyncInitialized) return;
  _autoSyncInitialized = true;

  syncAll();

  window.addEventListener('focus', () => {
    if (Date.now() - _lastSyncAt > 30_000) syncAll();
  });

  setInterval(syncAll, 5 * 60 * 1000);
}
