import { db, saveReadingPosition, getBookWithChapters, restoreBook } from '../db';
import { getAccessToken } from './googleAuth';
import {
  listAllProgressFiles, listAllBookFiles,
  downloadFile, upsertProgressFile, findProgressFile,
  upsertFile,
} from './driveApi';

let _lastSyncAt = 0;
let _bookSyncTimers = {};
let _autoSyncInitialized = false;

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

// Sync a single book — upload if local is newer, apply remote if remote is newer
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

// Upload a book (metadata + chapters) to Drive — call after adding a new book locally
export async function uploadBook(bookId) {
  let token;
  try { token = await getAccessToken(); } catch { return; }

  try {
    const bookData = await getBookWithChapters(bookId);
    if (!bookData) return;
    await upsertFile(`book_${bookId}.json`, bookData, token);
  } catch (err) {
    console.warn('[Drive sync] uploadBook failed:', err.message);
  }
}

// Full sync — merge all remote progress files + download missing books
// onProgress(done, total) called after each item
export async function syncAll(onProgress) {
  let token;
  try { token = await getAccessToken(); } catch { return { synced: 0, error: 'Brak autoryzacji' }; }

  _lastSyncAt = Date.now();

  try {
    const [remoteProgressFiles, remoteBookFiles, localPositions, localBooks] = await Promise.all([
      listAllProgressFiles(token),
      listAllBookFiles(token),
      db.readingPositions.toArray(),
      db.books.toArray(),
    ]);

    const localPosMap = Object.fromEntries(localPositions.map(p => [p.bookId, p]));
    const localBookIds = new Set(localBooks.map(b => b.id));

    // Find remote books missing locally
    const missingBooks = remoteBookFiles.filter(rf => {
      const bookId = rf.name.replace(/^book_/, '').replace(/\.json$/, '');
      return !localBookIds.has(bookId);
    });

    // Find local positions with no remote file
    const localOnlyPositions = localPositions.filter(l => !remoteProgressFiles.find(
      rf => rf.name === `progress_${l.bookId}.json`
    ));

    const total = remoteProgressFiles.length + localOnlyPositions.length + missingBooks.length;
    let synced = 0;
    onProgress?.(0, total);

    // Sync reading positions
    for (const rf of remoteProgressFiles) {
      const bookId = rf.name.replace(/^progress_/, '').replace(/\.json$/, '');
      const remote = await downloadFile(rf.id, token);
      const local = localPosMap[bookId];

      if (!local || remote.updatedAt > (local.updatedAt ?? 0)) {
        await applyRemote(remote);
      } else if ((local.updatedAt ?? 0) > remote.updatedAt) {
        await upsertProgressFile(bookId, toRemoteData(local), token);
      }

      delete localPosMap[bookId];
      synced++;
      onProgress?.(synced, total);
    }

    // Upload local positions that have no remote file yet
    for (const local of localOnlyPositions) {
      await upsertProgressFile(local.bookId, toRemoteData(local), token);
      synced++;
      onProgress?.(synced, total);
    }

    // Download books that exist remotely but not locally
    for (const rf of missingBooks) {
      const bookData = await downloadFile(rf.id, token);
      await restoreBook(bookData);
      synced++;
      onProgress?.(synced, total);
    }

    return { synced, error: null };
  } catch (err) {
    console.warn('[Drive sync] syncAll failed:', err.message);
    return { synced: 0, error: err.message };
  }
}

// Debounced single-book sync — call after saving local position
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
