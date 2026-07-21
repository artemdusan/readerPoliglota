import { useState, useEffect, useRef, useCallback } from "react";
import { Loader, Menu, Progress } from "@mantine/core";
import "./library.css";
import {
  BsGear,
  BsArrowRepeat,
  BsPlus,
  BsStars,
  BsDownload,
  BsPencil,
  BsArchive,
  BsArrowCounterclockwise,
  BsTrash,
} from "react-icons/bs";
import { EpubParser } from "../lib/epubParser";
import { formatTransfer, formatLastSync, formatRelativeSync, getLastSyncTs } from "../utils/formatUtils";
import {
  getActiveBooks,
  saveBook,
  updateBookMetadata,
  softDeleteBook,
  purgeBookData,
  getReadingPosition,
  setBookStatus,
} from "../db";
import BatchGenModal from "./BatchGenModal";
import EpubExportDialog from "./EpubExportDialog";
import BookMetadataDialog from "./BookMetadataDialog";
import ImportDialog from "./ImportDialog";
import { version } from "../../package.json";
import { getUsername, isLoggedIn, onAuthChange } from "../sync/cfAuth";
import { syncAll, uploadBook, deleteRemoteBook, syncBookStatus } from "../sync/cfSync";
import { getSyncActivity, subscribeSyncActivity } from "../sync/syncActivity";

function getDroppedFiles(dataTransfer) {
  if (!dataTransfer) return [];
  if (dataTransfer.files?.length) return Array.from(dataTransfer.files);

  return Array.from(dataTransfer.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(Boolean);
}

function hasDraggedFiles(event) {
  const types = event.dataTransfer?.types;
  return Array.isArray(types)
    ? types.includes("Files")
    : Array.from(types || []).includes("Files");
}

function getSyncCardTone(cfConnected, phase) {
  if (!cfConnected) return "is-offline";
  if (phase === "syncing") return "is-syncing";
  if (phase === "error") return "is-error";
  return "is-idle";
}

function getSyncCardTitle(cfConnected, phase) {
  if (!cfConnected) return "Konto niepołączone";
  if (phase === "syncing") return "Synchronizowanie...";
  if (phase === "error") return "Błąd synchronizacji";
  return "Zalogowany";
}

export default function Library({
  onOpenBook,
  onOpenSettings,
  onUpdateSetting,
  settings,
}) {
  const [books, setBooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [positions, setPositions] = useState({});
  const [batchBook, setBatchBook] = useState(null);
  const [epubBook, setEpubBook] = useState(null);
  const [importDraft, setImportDraft] = useState(null);
  const [editingBook, setEditingBook] = useState(null);
  const [ctxBookId, setCtxBookId] = useState(null);
  const [cfConnected, setCfConnected] = useState(() => isLoggedIn());
  const [accountName, setAccountName] = useState(() => getUsername());
  const [syncActivity, setSyncActivity] = useState(() => getSyncActivity());
  const [syncNow, setSyncNow] = useState(() => Date.now());
  const [lastSync, setLastSync] = useState(getLastSyncTs);
  const [showFeedback, setShowFeedback] = useState(false);
  const [activeTab, setActiveTab] = useState('active');
  const [search, setSearch] = useState('');
  const fileInputRef = useRef(null);

  useEffect(
    () =>
      onAuthChange((loggedIn, nextUsername) => {
        setCfConnected(loggedIn);
        setAccountName(nextUsername);
      }),
    [],
  );

  useEffect(() => {
    const timer = window.setInterval(() => setSyncNow(Date.now()), 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => subscribeSyncActivity(setSyncActivity), []);

  useEffect(() => {
    if (!syncActivity.result) return;
    setShowFeedback(true);
    const t = setTimeout(() => setShowFeedback(false), 4000);
    return () => clearTimeout(t);
  }, [syncActivity.result]);

  // Drag & Drop dla całego okna
  useEffect(() => {
    let dragDepth = 0;

    function handleWindowDragEnter(event) {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      dragDepth += 1;
      setDragging(true);
    }

    function handleWindowDragOver(event) {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      setDragging(true);
    }

    function handleWindowDragLeave(event) {
      if (!hasDraggedFiles(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDragging(false);
    }

    function handleWindowDrop(event) {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      dragDepth = 0;
      setDragging(false);
      const file = getDroppedFiles(event.dataTransfer)[0];
      if (file) handleFile(file);
    }

    window.addEventListener("dragenter", handleWindowDragEnter);
    window.addEventListener("dragover", handleWindowDragOver);
    window.addEventListener("dragleave", handleWindowDragLeave);
    window.addEventListener("drop", handleWindowDrop);

    return () => {
      window.removeEventListener("dragenter", handleWindowDragEnter);
      window.removeEventListener("dragover", handleWindowDragOver);
      window.removeEventListener("dragleave", handleWindowDragLeave);
      window.removeEventListener("drop", handleWindowDrop);
    };
  }, []);

  const loadBooks = useCallback(async () => {
    const list = await getActiveBooks();
    const nextPositions = {};
    for (const book of list) {
      const position = await getReadingPosition(book.id);
      if (position) nextPositions[book.id] = position;
    }

    const sorted = [...list].sort((a, b) => {
      const aTs = nextPositions[a.id]?.updatedAt ?? a.createdAt ?? 0;
      const bTs = nextPositions[b.id]?.updatedAt ?? b.createdAt ?? 0;
      return bTs - aTs;
    });

    setBooks(sorted);
    setPositions(nextPositions);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadBooks();
  }, [loadBooks]);

  useEffect(() => {
    function handleSynced() {
      setLastSync(getLastSyncTs() ?? Date.now());
      loadBooks();
    }

    window.addEventListener("vocabapp:synced", handleSynced);
    return () => window.removeEventListener("vocabapp:synced", handleSynced);
  }, [loadBooks]);

  const handleManualSync = useCallback(
    async ({ silent = false } = {}) => {
      if (!cfConnected) {
        if (!silent) onOpenSettings();
        return;
      }

      if (syncActivity.phase === "syncing") return;
      const result = await syncAll();
      if (result.lastSync) setLastSync(result.lastSync);
    },
    [cfConnected, onOpenSettings, syncActivity.phase],
  );

  useEffect(() => {
    if (!cfConnected) return;

    function handleOnline() {
      handleManualSync({ silent: true });
    }

    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [cfConnected, handleManualSync]);

  async function handleSyncButton() {
    if (!cfConnected) {
      onOpenSettings();
      return;
    }

    handleManualSync();
  }

  async function handleFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".epub")) {
      setAddError("Wybierz plik z rozszerzeniem .epub");
      return;
    }

    setAdding(true);
    setAddError("");

    try {
      const parsed = await EpubParser.parse(file);
      if (!parsed.chapters.length) {
        throw new Error("EPUB nie zawiera żadnych rozdziałów.");
      }
      setImportDraft(parsed);
    } catch (err) {
      setAddError(err.message || "Nie udało się otworzyć pliku EPUB.");
    } finally {
      setAdding(false);
    }
  }

  async function handleImportConfirm(draft) {
    setImportDraft(null);
    setAdding(true);

    try {
      const bookId = await saveBook(draft, draft.chapters);
      uploadBook(bookId);
      await loadBooks();
    } catch (err) {
      setAddError(err.message || "Nie udało się zapisać książki.");
    } finally {
      setAdding(false);
    }
  }

  async function handleMetadataSave(updatedBook) {
    setEditingBook(null);
    setAdding(true);
    setAddError("");

    try {
      const savedBook = await updateBookMetadata(updatedBook.id, updatedBook);
      await uploadBook(savedBook.id);
      await loadBooks();
    } catch (err) {
      setAddError(err.message || "Nie udało się zapisać metadanych książki.");
    } finally {
      setAdding(false);
    }
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragging(false);
    const file = getDroppedFiles(e.dataTransfer)[0];
    if (file) handleFile(file);
  }

  async function handleDelete(e, bookId) {
    e.stopPropagation();
    if (!confirm("Usunąć tę książkę z biblioteki?")) return;
    const deletedAt = await softDeleteBook(bookId);
    await purgeBookData(bookId, { keepBookRecord: true });
    setBooks((prev) => prev.filter((book) => book.id !== bookId));
    setPositions((prev) => {
      const next = { ...prev };
      delete next[bookId];
      return next;
    });

    if (cfConnected) {
      await deleteRemoteBook(bookId, deletedAt);
    }
  }

  async function handleStatusChange(e, bookId, status) {
    e.stopPropagation();
    await setBookStatus(bookId, status);
    setBooks(prev => prev.map(b => b.id === bookId ? { ...b, status } : b));
    setCtxBookId(null);
    syncBookStatus(bookId, status);
  }

  function progressLabel(bookId, chapterCount) {
    const pos = positions[bookId];
    if (!pos || !chapterCount) return "Nieotwarta";
    return `Rozdział ${pos.chapterIndex + 1} z ${chapterCount}`;
  }

  function progressPercent(bookId, chapterCount) {
    const pos = positions[bookId];
    if (!pos || !chapterCount) return 0;
    return Math.max(
      0,
      Math.min(100, Math.round(((pos.chapterIndex + 1) / chapterCount) * 100)),
    );
  }

  const activeBooks   = books.filter(b => b.status !== 'archived');
  const archivedBooks = books.filter(b => b.status === 'archived');

  const q = search.trim().toLowerCase();
  const allFiltered = q
    ? books.filter(b => b.title.toLowerCase().includes(q) || b.author?.toLowerCase().includes(q))
    : null;

  const baseTabBooks = allFiltered
    ? allFiltered
    : activeTab === 'archived' ? archivedBooks : activeBooks;

  const tabBooks = (!allFiltered && activeTab === 'active')
    ? [...baseTabBooks].sort((a, b) => {
        const aTs = positions[a.id]?.updatedAt ?? 0;
        const bTs = positions[b.id]?.updatedAt ?? 0;
        if (bTs !== aTs) return bTs - aTs;
        return (b.createdAt ?? 0) - (a.createdAt ?? 0);
      })
    : baseTabBooks;

  const syncTone = getSyncCardTone(cfConnected, syncActivity.phase);
  const syncTitle = getSyncCardTitle(cfConnected, syncActivity.phase);
  const isSyncing = cfConnected && syncActivity.phase === "syncing";
  const syncProgress = syncActivity.progress;
  const syncResult = syncActivity.result;
  const startedBooksCount = books.filter((book) =>
    Boolean(positions[book.id]),
  ).length;
  const syncMetaText = !cfConnected
    ? "Zaloguj się, aby synchronizować bibliotekę, postęp i tłumaczenia."
    : syncActivity.phase === "error"
      ? "Ostatnia próba się nie powiodła. Możesz spróbować ponownie ręcznie."
      : lastSync
        ? `Ostatni sync: ${formatLastSync(lastSync)} (${formatRelativeSync(lastSync, syncNow)})`
        : "Jeszcze nie wykonano pierwszej synchronizacji.";

  return (
    <div className="lib-layout">
      <div className="lib-content">
        <header className="lib-header">
          <div className={`lib-account ${syncTone}`} title={`${syncTitle}. ${syncMetaText}`}>
            <span className="lib-account-dot" aria-hidden="true" />
            <span className="lib-account-name">
              {cfConnected && accountName ? accountName : "Offline"}
            </span>
            {cfConnected && lastSync && (
              <span className="lib-account-sync">
                {formatRelativeSync(lastSync, syncNow)}
              </span>
            )}
          </div>

          <div className="lib-header-actions">
            <button
              type="button"
              className="lib-icon-btn"
              onClick={onOpenSettings}
              title="Ustawienia"
            >
              <BsGear />
            </button>
            <button
              type="button"
              className="lib-icon-btn"
              onClick={handleSyncButton}
              disabled={isSyncing}
              title={cfConnected ? "Synchronizuj" : "Połącz konto"}
            >
              <BsArrowRepeat />
            </button>
          </div>
        </header>

        {isSyncing && syncProgress && (
          <Progress
            size="xs"
            value={syncProgress.total > 0 ? (syncProgress.done / syncProgress.total) * 100 : 10}
            animated
          />
        )}

        {cfConnected && syncResult && !isSyncing && showFeedback && (
          <div className="lib-alert">
            {syncResult.error
              ? `⚠ Błąd: ${syncResult.error}`
              : `Zsynchronizowano ↑ ${formatTransfer(syncResult.sentBytes)} · ↓ ${formatTransfer(syncResult.receivedBytes)}`}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept=".epub"
          hidden
          onChange={(e) => {
            handleFile(e.target.files[0]);
            e.target.value = "";
          }}
        />

        <div className="lib-actions">
          <input
            type="search"
            className="lib-search"
            placeholder="Szukaj książki…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            type="button"
            className="lib-chip is-active"
            onClick={() => fileInputRef.current?.click()}
            disabled={adding}
            title="Dodaj książkę EPUB"
          >
            <BsPlus size={18} /> {adding ? "Dodawanie…" : "Dodaj EPUB"}
          </button>
        </div>

        <div className="lib-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "active"}
            className={`lib-chip${activeTab === "active" ? " is-active" : ""}`}
            onClick={() => setActiveTab("active")}
          >
            Biblioteka{activeBooks.length > 0 ? ` · ${activeBooks.length}` : ""}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "archived"}
            className={`lib-chip${activeTab === "archived" ? " is-active" : ""}`}
            onClick={() => setActiveTab("archived")}
          >
            Archiwum{archivedBooks.length > 0 ? ` · ${archivedBooks.length}` : ""}
          </button>
        </div>

        {addError && <div className="lib-alert">⚠ {addError}</div>}

        {loading ? (
          <div className="lib-muted"><Loader /></div>
        ) : tabBooks.length === 0 ? (
          activeTab === 'active' ? (
            <div
              className={`lib-empty${dragging ? " is-dragging" : ""}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
            >
              <span className="lib-empty-icon">📚</span>
              <span className="lib-empty-title">Twoja biblioteka jest pusta</span>
              <span className="lib-empty-hint">
                Przeciągnij plik <strong>.epub</strong> tutaj lub kliknij, aby go dodać.
              </span>
            </div>
          ) : (
            <div className="lib-muted">Archiwum jest puste.</div>
          )
        ) : (
          <div
            className="lib-grid"
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
          >
            {tabBooks.map((book) => {
              const isStarted = Boolean(positions[book.id]);
              const percent = progressPercent(book.id, book.chapterCount);

              return (
                <div
                  key={book.id}
                  className="lib-card"
                  onClick={() => onOpenBook(book.id)}
                >
                  <div className="lib-cover">
                    {book.cover
                      ? <img src={book.cover} alt="okładka" />
                      : '📖'}
                  </div>

                  <Menu
                    position="bottom-end"
                    opened={ctxBookId === book.id}
                    onChange={(opened) => setCtxBookId(opened ? book.id : null)}
                    withinPortal
                  >
                    <Menu.Target>
                      <button
                        type="button"
                        className="lib-card-menu"
                        title="Menu książki"
                        onClick={(e) => e.stopPropagation()}
                      >
                        ⋮
                      </button>
                    </Menu.Target>
                    <Menu.Dropdown onClick={(e) => e.stopPropagation()}>
                      {settings && (
                        <Menu.Item
                          leftSection={<BsStars />}
                          onClick={() => { setBatchBook(book); setCtxBookId(null); }}
                        >
                          Tłumaczenia
                        </Menu.Item>
                      )}
                      <Menu.Item
                        leftSection={<BsDownload />}
                        onClick={() => { setEpubBook(book); setCtxBookId(null); }}
                      >
                        Eksportuj EPUB
                      </Menu.Item>
                      <Menu.Item
                        leftSection={<BsPencil />}
                        onClick={() => { setEditingBook(book); setCtxBookId(null); }}
                      >
                        Edytuj
                      </Menu.Item>
                      {book.status === 'archived' ? (
                        <Menu.Item
                          leftSection={<BsArrowCounterclockwise />}
                          onClick={(e) => handleStatusChange(e, book.id, 'active')}
                        >
                          Przywróć do biblioteki
                        </Menu.Item>
                      ) : (
                        <Menu.Item
                          leftSection={<BsArchive />}
                          onClick={(e) => handleStatusChange(e, book.id, 'archived')}
                        >
                          Archiwizuj
                        </Menu.Item>
                      )}
                      <Menu.Divider />
                      <Menu.Item
                        color="red"
                        leftSection={<BsTrash />}
                        onClick={(e) => { handleDelete(e, book.id); setCtxBookId(null); }}
                      >
                        Usuń
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>

                  {book.status === 'archived' && (
                    <span className="lib-badge">Archiwum</span>
                  )}
                  <div className="lib-card-title">{book.title}</div>
                  {book.author && (
                    <div className="lib-card-author">{book.author}</div>
                  )}
                  <div className="lib-card-meta">
                    <span>{progressLabel(book.id, book.chapterCount)}</span>
                    <span className="lib-card-percent">
                      {isStarted ? `${percent}%` : "Start"}
                    </span>
                  </div>
                  <div className="lib-progress" aria-hidden="true">
                    <div
                      className="lib-progress-fill"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {importDraft && (
        <ImportDialog
          parsed={importDraft}
          onConfirm={handleImportConfirm}
          onCancel={() => setImportDraft(null)}
        />
      )}

      {editingBook && (
        <BookMetadataDialog
          book={editingBook}
          onConfirm={handleMetadataSave}
          onCancel={() => setEditingBook(null)}
        />
      )}

      {batchBook && settings && (
        <BatchGenModal
          bookId={batchBook.id}
          book={batchBook}
          settings={settings}
          onClose={() => setBatchBook(null)}
        />
      )}

      {epubBook && (
        <EpubExportDialog
          bookId={epubBook.id}
          book={epubBook}
          onClose={() => setEpubBook(null)}
        />
      )}

      <div className="lib-version">v{version}</div>
    </div>
  );
}
