import { db, saveReadingPosition } from '../db';
import { getAccessToken } from './googleAuth';
import { listAllProgressFiles, downloadFile, upsertProgressFile, findProgressFile } from './driveApi';

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

// Full sync — merge all remote progress files with local Dexie state
export async function syncAll() {
  let token;
  try { token = await getAccessToken(); } catch { return; }

  _lastSyncAt = Date.now();

  try {
    const [remoteFiles, localPositions] = await Promise.all([
      listAllProgressFiles(token),
      db.readingPositions.toArray(),
    ]);

    const localMap = Object.fromEntries(localPositions.map(p => [p.bookId, p]));

    for (const rf of remoteFiles) {
      const bookId = rf.name.replace(/^progress_/, '').replace(/\.json$/, '');
      const remote = await downloadFile(rf.id, token);
      const local = localMap[bookId];

      if (!local || remote.updatedAt > (local.updatedAt ?? 0)) {
        await applyRemote(remote);
      } else if ((local.updatedAt ?? 0) > remote.updatedAt) {
        await upsertProgressFile(bookId, toRemoteData(local), token);
      }

      delete localMap[bookId];
    }

    // Upload local positions that have no remote file yet
    for (const local of Object.values(localMap)) {
      await upsertProgressFile(local.bookId, toRemoteData(local), token);
    }
  } catch (err) {
    console.warn('[Drive sync] syncAll failed:', err.message);
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
